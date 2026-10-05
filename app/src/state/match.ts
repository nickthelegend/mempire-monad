import { create } from 'zustand';
import { play, startMusic, stopMusic } from '../lib/audio';
import { COINS } from '../lib/coins';
import { recordMatch } from '../lib/persist';
import { signAction } from '../lib/identity';
import {
  pvpCancel, pvpClose, pvpConnect, pvpQueue, pvpSendEnded, pvpSendHash, pvpSendInput,
  pvpSendTick,
  type MatchedPayload,
} from '../lib/pvp';
import { traitForMint } from '../sim/traits';
import { archetypeForMint } from '../sim/archetypes';
import { decideBot, type BotDifficulty } from '../sim/bot';
import { ARENA_H, ARENA_W, createMatch, hashState, stepSim } from '../sim/engine';
import {
  FORMATS, HASH_EVERY_TICKS, INPUT_DELAY_TICKS,
  type InputEvent, type MatchCard, type SimState,
} from '../sim/types';
import bs58 from 'bs58';
import { useClan } from './clan';
import { useLadder } from './ladder';
import { useCollection, FEES } from './collection';
import { useEconomy, type ChestTier } from './economy';
import { warmBattleChunk, warmMatchArt } from '../lib/warm';
import { useDeck, TIERS } from './deck';
import { canSign } from '../chain/provider';
import { useChain } from './chain';
import { useEscrow } from './escrow';
import { useErMatch } from './erMatch';
import {
  claimChestEr, ensureChestRail, readChestRail, requestChestEr,
} from '../chain/erActions';
import { readMatch } from '../chain/actions';
import { signer, useWallet } from './wallet';

export type MatchStatus = 'idle' | 'queuing' | 'found' | 'battle' | 'settled';

/**
 * How a match is entered.
 *
 * `ranked` and `practice` are mutually exclusive by construction: practice has
 * no stake so it must not move trophies, and ranked must never be answered by a
 * bot. `rush` selects the 30-second format.
 */
export interface MatchOpts {
  practice?: boolean;
  ranked?: boolean;
  rush?: boolean;
}

export interface MatchResult {
  won: boolean;
  draw: boolean;
  potSol: number;
  payoutSol: number; // what the player received (0 on loss)
  rakeSol: number;
  hashes: number; // checkpoints committed
  crowns: [number, number]; // towers felled, [you, them]
  chest: ChestTier | null; // won a chest, unless all four slots were full
  /**
   * Whether a lamport actually moved for this match.
   *
   * `potSol` is what the tier *says* a pot is worth and is filled in whether or
   * not escrow opened, so it cannot answer this. Without the distinction the
   * leaderboard's net-SOL column accumulates winnings from matches that
   * escrowed nothing — a running total of money that never existed.
   */
  escrowed: boolean;
  /**
   * The on-chain match this result settles, when one exists. The relay only
   * counts money for a result that names its match — it reads the pot and
   * the winner off the settled account rather than off this object.
   */
  matchId?: number | null;
  /** Ranked only. Absent on practice and casual matches. */
  trophyDelta?: number;
  trophiesAfter?: number;
  promoted?: boolean;
  demoted?: boolean;
  leagueAfter?: string;
  /**
   * The sims diverged and the match was annulled: stakes returned, no rake,
   * nothing recorded. Divergence is detected by the hash checkpoints and
   * neutralised — never silently ignored, never paid out.
   */
  voided?: boolean;
}

/** Transient presentation signal — never read by the sim. */
export interface Shock {
  id: number;
  kind: 'tower' | 'deploy';
  forPlayer: 0 | 1;
}

interface MatchStore {
  status: MatchStatus;
  version: number; // bumped per sim tick — HUD subscribes to this
  sim: SimState | null;
  playerDeck: MatchCard[];
  botDeck: MatchCard[];
  stakeSol: number;
  result: MatchResult | null;
  history: MatchResult[];
  opponentName: string;
  crowns: [number, number]; // live tower count, [you, them]
  shock: Shock | null;
  /** No stake, no rake, no chest — a place to learn the controls. */
  practice: boolean;
  /**
   * Trophies are at stake, and the opponent is guaranteed human.
   *
   * Ranked never falls back to a bot. That is the whole promise — a ladder that
   * can be climbed against a bot is not a ladder, and "no bots" has to be true
   * where it is claimed or it is just copy.
   */
  ranked: boolean;
  /** 30-second format. */
  rush: boolean;
  /** Set while a ranked queue is waiting on a human, for honest queue copy. */
  waitingForHuman: boolean;
  /**
   * This match is against the AI because the queue was empty.
   *
   * Distinct from `mode: 'bot'`, which is also true of Practice and of a casual
   * match that fell back. This one specifically means "we looked for a person
   * and there was not one", which is the only case the result screen has to
   * explain and the ladder has to ignore.
   */
  soloVsBot: boolean;
  /** 'human' when a real opponent is relaying inputs; 'bot' otherwise. */
  mode: 'bot' | 'human';
  /**
   * Which sim seat is *this* client. Both clients run one shared timeline where
   * seat 0 is the same physical player on both machines — determinism demands
   * it — so the UI renders from this seat's point of view instead of assuming
   * it is player 0.
   */
  perspective: 0 | 1;
  startQueue: (opts?: MatchOpts) => string | null; // error string or null
  cancelQueue: () => void;
  playCard: (deckIndex: number, xFp: number, yFp: number) => void;
  forfeit: () => void;
  dismiss: () => void;
}

let loop: ReturnType<typeof setInterval> | null = null;
let queueTimers: ReturnType<typeof setTimeout>[] = [];
let pending = new Map<number, InputEvent[]>();
let hashes: number[] = [];
/**
 * Puts the newest chest through the VRF oracle and reconciles its tier.
 *
 * Fire-and-forget by design. The request is accepted in one transaction and
 * fulfilled by the oracle in another, so this polls; the result screen is
 * already on screen and must never block on it. A session that cannot sign
 * keeps its local roll, honestly labelled.
 */
async function rollChestOnchain(chestId: string): Promise<void> {
  const adapter = signer();
  if (!canSign(adapter) || useChain.getState().mode !== 'onchain') return;
  try {
    await ensureChestRail(adapter);

    /*
     * Wait for the entitlement this win earned before asking to spend it.
     *
     * `end_log` grants it on the rollup, and it is fired unawaited a few lines
     * above this — a rollup transaction plus a commit, which is seconds. This
     * ran immediately, so `earned` was still 0, `request_chest` was refused
     * with `NoChestEarned`, the bare catch below swallowed it and the local
     * roll stood. Every chest in the game took that path; the rail read
     * `earned = 0` after a dozen wins even once the grant was wired up.
     *
     * Bounded, because a session that genuinely cannot be granted one must
     * still end up with its honestly-labelled local chest rather than hanging.
     */
    /*
     * Wait for an entitlement, not for a comparison that stops being true.
     *
     * The gate was `earned <= opened`, which reads like "have I been granted
     * more than I have opened" but is comparing two different kinds of
     * number. The program's own field docs say so: `opened` is "lifetime
     * chests filled — purely for display and reconciliation" and only ever
     * grows, while `earned` is "unspent chest entitlements", a balance that
     * `end_log` adds one to and `request_chest` takes one from, capped at
     * MAX_UNSPENT_CHESTS.
     *
     * So once lifetime opens pass that small cap, `earned > opened` can never
     * be true again, and every subsequent win returned here silently. The
     * oracle was never asked, the entitlement was never spent, and the chest
     * the player got was the one their own client rolled — which is precisely
     * the thing the entitlement was added to stop being a suggestion.
     *
     * The question this actually wants to ask is whether there is an unspent
     * entitlement at all.
     */
    let rail = await readChestRail(adapter);
    for (let i = 0; i < 20 && rail && rail.earned === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      rail = await readChestRail(adapter);
    }
    if (!rail || rail.earned === 0) return;

    const slot = rail.slots.findIndex((s) => s.state === 0);
    if (slot < 0 || rail.pendingSlot !== 255) return; // rail full or busy

    await requestChestEr(adapter, slot, Math.floor(Math.random() * 256));

    // Acceptance is not an outcome — wait for the separate callback.
    for (let i = 0; i < 30; i += 1) {
      await new Promise((r) => setTimeout(r, 1200));
      const now = await readChestRail(adapter);
      const filled = now?.slots[slot];
      if (filled?.state === 2) {
        const hex = Array.from(filled.randomness)
          .map((b) => b.toString(16).padStart(2, '0')).join('');
        useEconomy.getState().reconcileChest(chestId, filled.tier, hex);
        void claimChestEr(adapter, slot).catch(() => { /* slot frees next run */ });
        return;
      }
    }
    // The oracle never answered. Release the chest on the roll it already has,
    // labelled `local`, rather than leaving it forever un-startable.
    useEconomy.getState().settleLocalChest(chestId);
  } catch {
    // The local roll stands, labelled as local — but it has to become
    // actionable again, or a failed roll silently freezes the chest.
    useEconomy.getState().settleLocalChest(chestId);
  }
}

/**
 * Prepare the rollup match log, once the escrow's own log is delegated.
 *
 * This is what grants a VRF chest, and nothing was calling it. `useErMatch`
 * has its own escrow-and-delegate action that ends in `begin`, but `match.ts`
 * settles through `useEscrow` instead, so `begin` never ran, `phase` stayed
 * 'off', and `play`/`mark`/`finish` all returned at their first line. The
 * visible symptom was three steps away: `end_log` never credited an
 * entitlement, `request_chest` was refused with `NoChestEarned`, and every
 * chest quietly fell back to a local roll. Read straight off the rail:
 * `earned = 0` after a dozen wins.
 *
 * Deliberately non-fatal and not awaited. The pot settles through the base
 * log whatever happens here, and a rollup that will not take the log must
 * cost a chest, never a stake.
 */

/**
 * Hold the relayed deck against the on-chain commitment.
 *
 * `join_match` locks eight cards and commits a hash of the deck's mints in
 * play order; the relay, meanwhile, tells each client what the opponent is
 * playing — and nothing ever compared the two. A modified client could relay
 * one deck and commit another: the sim then runs on cards the chain never
 * locked, in a match with a real pot. The hash is already on chain and the
 * deck is already in hand, so the check is one read. A mismatch voids the
 * match the same way a desync does — both stakes go home, nobody adjudicates.
 */
async function verifyOpponentCommitment(matchId: number): Promise<void> {
  const claimed = relayedOpponent;
  if (!claimed) return;
  try {
    const m = await readMatch(matchId);
    if (!m || m.state !== 1) return; // not both-committed yet; nothing to hold it against
    const seat = m.players.indexOf(claimed.address);
    if (seat === -1) return; // escrow opened against someone else entirely — other checks own this
    const committed = m.deckHashes[seat];
    const relayed = await deckCommitment(claimed.deck);
    // A deck we cannot hash the program's way proves nothing either direction.
    // Voiding on it would punish the honest player for our own blind spot.
    if (!relayed) return;
    const same = committed.length === relayed.length
      && committed.every((b: number, i: number) => b === relayed[i]);
    if (!same) {
      settleVoid('the opponent\u2019s deck does not match what they committed on chain');
    }
  } catch { /* an RPC miss must not void a healthy match */ }
}

function beginRollupLog(matchId: number): void {
  const players = useEscrow.getState().players;
  if (!players) return;
  void useErMatch.getState().begin(signer(), matchId, players);
}

/** Human matches step against the wall clock so two clients stay in lockstep. */
let humanStartAt = 0;

/**
 * Seat 1's half of the escrow handshake, parked until seat 0 relays the id.
 *
 * Seat 1 cannot derive the on-chain match id — it is `config.next_match_id` at
 * the moment seat 0's transaction landed — so the join has to wait for the
 * relay. Held here rather than in the store because it is a one-shot; the
 * store carries the outcome.
 */
/**
 * The lockstep input delay this match agreed on, in ticks.
 *
 * Set from the `matched` payload so both clients use the identical value. The
 * constant below is only the fallback for a matchmaker that does not send one.
 */
let humanInputDelayTicks = 0;

/**
 * The furthest tick the opponent has told us they have reached.
 *
 * Lockstep survives only while neither sim runs more than the input delay
 * ahead of the other. Left to a wall clock alone they drift — a GC pause, a
 * slow frame, a browser throttling a tab — and once one is far enough ahead,
 * inputs stamped by the slower client arrive for ticks the faster one has
 * already simulated, and the match voids. Padding the delay only moves the
 * threshold; refusing to outrun the opponent removes the cause.
 */
/**
 * How long an opponent may say nothing before the match resolves without them.
 *
 * Comfortably longer than any hiccup the gate is meant to absorb — a stutter
 * is milliseconds, a dropped frame is one tick — and short enough that nobody
 * sits staring at a frozen arena wondering whether to forfeit.
 */
const OPPONENT_STALL_MS = 12_000;

let opponentTick = 0;
/**
 * When the opponent's tick last moved.
 *
 * Lockstep holds this client to `opponentTick + delay`, so an opponent who
 * stops announcing freezes the match outright — the comment on that gate says
 * as much. `opponent_left` covers a *disconnect*, but a client that stays
 * connected and goes silent (a suspended laptop, a wedged tab, a modified
 * client that simply stops) hit nothing at all: the clock stuck, the hand
 * stopped responding, and forfeiting was the only way out of a game that had
 * not been lost. Observed frozen at 3:00 indefinitely against a real seat.
 */
let lastOpponentAdvanceAt = 0;

/** The last tick we told the opponent about, so we announce at a fixed rate. */
let lastAnnouncedTick = 0;

let pendingJoin: {
  stakeSol: number; opponent: string; deck: number[]; hash: Uint8Array;
} | null = null;

/**
 * How far this machine's wall clock is behind the matchmaker's, in ms.
 *
 * Both clients step the sim against `tick = (now - startAt) / 50ms`, where
 * `startAt` is an instant on the *server's* clock. Comparing that to a local
 * `Date.now()` means a machine thirty seconds out targets a tick six hundred
 * ahead of its opponent; the state hashes diverge on the first checkpoint and
 * a staked match voids over nothing but an unsynchronised clock — which is
 * ordinary on a laptop that has been asleep.
 *
 * Measured once from the matched message, then applied everywhere the match
 * asks what time it is.
 */
let clockSkew = 0;

/** The shared clock both clients agree on: local time, corrected. */
function sharedNow(): number {
  return Date.now() + clockSkew;
}
/**
 * SOL escrowed for a human match that has not settled yet. Every abnormal exit
 * between escrow and settlement — opponent vanishing before the start, the sim
 * failing to build, a desync — must pass through here exactly once, or the
 * stake either leaks (player loses money to a bug) or duplicates (free money).
 */
let humanEscrowSol = 0;
const TICK_MS = 50;
/** Opponent rating for the ranked match in flight, so settle can score it. */
let opponentTrophies = 0;
/**
 * The relay's token for this pairing, which a ranked result must cite.
 *
 * Held alongside the rating because they arrive together and are used
 * together: the rating is what the score is computed from, and this is the
 * evidence that there was a match to score at all.
 */
let pairKey: string | null = null;
/** What the relay said the opponent is playing — held for the chain check. */
let relayedOpponent: { address: string; deck: MatchCard[] } | null = null;
/**
 * Own inputs schedule this far ahead in a human match — 400ms of slack for the
 * relay round-trip. The bot keeps the tight 2-tick delay; a bot has no latency.
 */
/**
 * How far ahead of the current tick a human match stamps an input.
 *
 * This is the entire budget for a card to travel client → relay → opponent.
 * If it arrives after its stamped tick the opponent cannot apply it without
 * rewriting history, so the match voids — correctly, but the player just
 * watched a match evaporate for no visible reason.
 *
 * It was 8 ticks: 400ms. A round trip to the relay from a player on the far
 * side of the world is comfortably more than that, so *every* card either
 * player played voided the match, and a live PvP game could not be finished at
 * all. The socket logs told the story plainly — connections lasting seventeen
 * seconds, closed by the void, not by the network.
 *
 * A full second is generous enough to survive an intercontinental round trip
 * with the relay under load, and is deliberately a shared constant rather than
 * something either client measures: both sims must agree on the tick an input
 * lands, so a locally-tuned delay would be a desync generator.
 */
const HUMAN_INPUT_DELAY_TICKS = 16;

/**
 * How long a solo player waits before the machine steps in.
 *
 * Long enough that a real opponent queuing at the same moment is still found
 * first — the matchmaker pairs within a second once two people are there — and
 * short enough that nobody concludes the game is broken. Twenty seconds is
 * about the limit of a search that still feels like searching.
 */
const SOLO_WAIT_MS = 20_000;

function clearTimers(): void {
  queueTimers.forEach(clearTimeout);
  queueTimers = [];
  if (loop) { clearInterval(loop); loop = null; }
}

/**
 * Names for the AI opponents, one per tier.
 *
 * Each carries a suffix saying what it is. They read like handles because the
 * fiction wants them to, and a handle that reads like a person sitting at
 * another keyboard is a claim about who you are playing — the one thing a game
 * with real stakes in it should never be vague about. The tag costs four
 * characters and removes the question.
 */
const BOT_NAMES = [
  'xX_RugLord_Xx (AI)',
  'ser_liquidator (AI)',
  'wagmi_warlord (AI)',
  'chad.sol (AI)',
];

/**
 * How long the queue waits for a human before the bot steps in.
 *
 * Overridable via sessionStorage because demoing PvP with two tabs on one
 * machine fights background-tab timer throttling — the hidden tab's clicks and
 * timers land seconds late, and an 8s window loses that race through no fault
 * of the player. `sessionStorage.setItem('pvpWaitMs','60000')` in both tabs
 * makes the pairing calm; real players on two devices never need it.
 */
function pvpWaitMs(): number {
  try {
    const v = Number(sessionStorage.getItem('pvpWaitMs'));
    if (Number.isFinite(v) && v >= 1000) return v;
  } catch { /* private mode */ }
  return 8000;
}

/**
 * Returns null when the deck references cards or coins that no longer exist —
 * stale ids after a migration, a coin retired from the registry. The old `!`
 * assertions here crashed the Battle button for exactly the returning players
 * a migration touches; a null is turned into a sentence by startQueue instead.
 */
function buildDecks(): { player: MatchCard[]; bot: MatchCard[] } | null {
  const { cards } = useCollection.getState();
  const { active } = useDeck.getState();
  const chainCards = useChain.getState().cards;
  const player: MatchCard[] = [];
  for (const id of active) {
    const c = cards.find((x) => x.id === id);
    const coin = c && COINS.find((k) => k.mint === c.mint);
    if (!c || !coin) return null;
    /*
     * Play the level you actually own.
     *
     * `useCollection` is a local mirror that starts every card at level 1 and
     * is never refreshed from chain, while levels are only created by
     * `upgrade_card` — an onchain instruction. So the level a card was staked
     * and committed at and the level it fought at were two unrelated numbers.
     * Merging duplicates bought a level the sim never granted, and the deck
     * commitment the program derives from `(coin_mint, level)` could not agree
     * with the deck the relay carried even between two honest clients.
     *
     * The chain card is the authority whenever there is one; the local level
     * survives only for play that never touches chain, where it is the only
     * level there is.
     */
    const onchain = chainCards.find((k) => k.mint === c.mint && !k.inMatch);
    player.push({
      coinId: c.mint, name: coin.ticker, archetype: c.archetype,
      trait: traitForMint(c.mint), level: onchain ? onchain.level : c.level,
    });
  }
  if (player.length !== 8) return null;
  // bot mirrors the player's power so brackets feel honest
  const levels = player.map((p) => p.level);
  const bot = COINS.slice(0, 10).filter((c) => c.liquidityUsd >= 25000).slice(0, 8).map((c, i) => ({
    coinId: c.mint,
    name: c.ticker,
    archetype: archetypeForMint(c.mint),
    trait: traitForMint(c.mint),
    level: levels[(i * 3) % levels.length],
  }));
  return { player, bot };
}

/**
 * The deck's on-chain card ids, in deck order, or null if it is not fully
 * minted.
 *
 * `create_match` locks these eight accounts and `deckHash` commits to their
 * order, so the order here has to be the order the player actually plays. A
 * deck with even one un-minted card cannot be staked at all — the program has
 * nothing to lock — which is the honest reason a match falls back to unstaked.
 */
function onchainDeckIds(): number[] | null {
  const { cards } = useCollection.getState();
  const { active } = useDeck.getState();
  const chainCards = useChain.getState().cards;
  const ids: number[] = [];
  for (const id of active) {
    const c = cards.find((x) => x.id === id);
    if (!c) return null;
    const onchain = chainCards.find((k) => k.mint === c.mint && !k.inMatch);
    if (!onchain) return null;
    ids.push(onchain.id);
  }
  return ids.length === 8 ? ids : null;
}

/**
 * The deck commitment the program actually stores, recomputed locally.
 *
 * This has to be byte-identical to `validate_and_lock_deck`, which hashes
 * `(coin_mint, level)` for each card in the order the cards were passed:
 * thirty-two mint bytes then one level byte, eight times, SHA-256 over the
 * whole preimage.
 *
 * It was FNV-1a-32 over a comma-joined list of `coinId` strings, widened to
 * thirty-two bytes with zeroes. That is a different function of different
 * input, so it could never equal what the chain holds — and the one caller
 * that compares the two voids the match when they differ. Every staked human
 * match therefore voided, and the deck-swap attack the commitment exists to
 * catch went unchecked the whole time, because the check never got as far as
 * comparing decks.
 *
 * Returns null when the deck cannot be hashed the way the program hashes it —
 * a `coinId` that is not a real mint, which is the devnet seeded-id case. The
 * caller must treat that as "cannot tell", never as "does not match".
 */
async function deckCommitment(deck: MatchCard[]): Promise<Uint8Array | null> {
  if (deck.length !== 8) return null;
  const preimage = new Uint8Array(8 * 33);
  for (let i = 0; i < 8; i += 1) {
    let mint: Uint8Array;
    try {
      mint = bs58.decode(deck[i].coinId);
    } catch {
      return null;
    }
    if (mint.length !== 32) return null;
    preimage.set(mint, i * 33);
    preimage[i * 33 + 32] = deck[i].level & 0xff;
  }
  const digest = await crypto.subtle.digest('SHA-256', preimage);
  return new Uint8Array(digest);
}

export const useMatch = create<MatchStore>((set, get) => ({
  status: 'idle',
  version: 0,
  sim: null,
  playerDeck: [],
  botDeck: [],
  stakeSol: 0,
  result: null,
  history: [],
  opponentName: '',
  crowns: [0, 0],
  shock: null,
  practice: false,
  ranked: false,
  rush: false,
  waitingForHuman: false,
  soloVsBot: false,
  mode: 'bot',
  perspective: 0,

  startQueue: (opts) => {
    const practice = opts?.practice ?? false;
    const ranked = !practice && (opts?.ranked ?? false);
    const rush = opts?.rush ?? false;
    // A second tap while a match is forming would tear down a formed human
    // match — escrow and all — and start over. One match at a time.
    const current = get().status;
    if (current === 'queuing' || current === 'found' || current === 'battle') {
      return null; // already on the way to the arena; the tap is a no-op
    }
    const deck = useDeck.getState();
    const wallet = useWallet.getState();
    if (!wallet.connected) return 'connect your wallet first';
    if (!deck.isComplete()) return 'deck needs 8 cards';
    const tier = TIERS[deck.tier];
    if (!practice && wallet.sol < tier.stakeSol) return `need ${tier.stakeSol} SOL to enter`;

    const decks = buildDecks();
    if (!decks) return 'your deck has retired cards — rebuild it on the Deck tab';
    const { player, bot } = decks;
    clearTimers();
    pvpClose();
    useErMatch.getState().reset();

    /**
     * Put the match on Solana and its log on a MagicBlock rollup.
     *
     * Not awaited, and never blocking: a wallet that cannot sign, an
     * undeployed program, or a rollup that will not come up all leave the
     * simulated match running exactly as before. The rollup badge reports which
     * of those happened rather than the UI implying an onchain match that isn't.
     *
     * Practice is excluded on purpose — it stakes nothing, so there is nothing
     * to escrow and no reason to spend a commit quota on it.
     */
    /*
     * The base-layer escrow is not opened *here*, at queue time.
     *
     * It once was, and that was the bug: `openOnchainMatch` escrowed real
     * lamports the moment a player queued, into a settlement path that did not
     * exist yet. That did not lose a fraction of a stake — it stranded the
     * whole thing every time and locked the player's eight cards with it.
     *
     * Since then `joinMatchTx`, `settleTx` and `claimTimeoutTx` have all been
     * wired (`state/escrow.ts`), and the stake is real: escrowed when a human
     * opponent is found, settled from the rollup log, released on timeout. A
     * two-browser run against production confirms the pot moves and the winner
     * is paid. AUDIT.md records A2 as closed.
     *
     * What stays true is the ordering. Escrow opens once there is an opponent
     * to escrow against, not on a speculative queue — which is why the call
     * lives in the matched path rather than in this one.
     */
    set({
      status: 'queuing',
      playerDeck: player,
      botDeck: bot,
      stakeSol: practice ? 0 : tier.stakeSol,
      practice,
      ranked,
      rush,
      waitingForHuman: ranked,
      soloVsBot: false,
      mode: 'bot',
      perspective: 0,
      result: null,
      opponentName: practice ? 'Training Dummy' : 'searching…',
    });

    // Queueing is dead time; spend it on the fetch the arena was going to do
    // anyway. Both decks, because the opponent's fighters render on the same
    // first frame as yours.
    warmMatchArt([...player, ...bot].map((c) => c.coinId));
    warmBattleChunk();

    // Practice goes straight to the bot — its whole point is a private arena.
    if (practice) {
      beginBotFlow(true, deck.tier, player, bot);
      return null;
    }

    // Real stakes try a human first. The matchmaker pairs same-tier players;
    // if nobody shows inside the window (or the service is down), the bot
    // steps in — a solo judge still gets a battle every time.
    let fellBack = false;
    const fallBack = () => {
      if (fellBack || get().status === 'battle' || get().status === 'settled') return;
      fellBack = true;
      pvpClose();
      if (get().status === 'idle') return; // player cancelled while waiting
      /*
       * `soloVsBot` is set here, not only on the wait-timeout path.
       *
       * `onUnavailable` routes here too — an unreachable relay falls back to
       * the machine exactly like an empty queue does — and it used to leave the
       * flag false. The match was then a bot match that did not know it was
       * one: the result screen skipped "nobody else was queuing, so this was
       * against the AI", and it read as a real opponent. It also misled this
       * project's own testing into reporting a PvP escrow failure that was
       * really a bot match all along.
       */
      set({
        soloVsBot: true,
        opponentName: BOT_NAMES[deck.tier],
        mode: 'bot',
        perspective: 0,
      });
      beginBotFlow(false, deck.tier, player, bot);
    };

    /*
     * Nobody is queuing? Play the machine.
     *
     * `onUnavailable` only fires when the relay is unreachable — a healthy
     * relay with an empty queue never calls it, so a solo player waited on the
     * search screen forever. That is the single most likely thing to happen to
     * whoever opens this first, and it made the game look broken when it was
     * merely empty.
     *
     * Ranked falls back too, which it did not before. The reason it did not is
     * still true — a trophy has to mean you beat a person — so the fallback
     * marks the match and the ladder simply does not count it. Waiting forever
     * protected the ladder by making the game unplayable alone, which is the
     * wrong trade.
     */
    queueTimers.push(setTimeout(() => {
      if (get().status === 'queuing' && !fellBack) fallBack();
    }, SOLO_WAIT_MS));

    pvpConnect({
      onMatched: (m) => {
        if (fellBack) return;
        opponentTrophies = Number(m.opponent.trophies) || 0;
        pairKey = typeof m.pairKey === 'string' ? m.pairKey : null;
        relayedOpponent = { address: String(m.opponent.address), deck: m.opponent.deck as MatchCard[] };
        set({ waitingForHuman: false });
        beginHumanBattle(m, player, tier.stakeSol, deck.tier, rush);
      },
      onUnavailable: fallBack,
      onTick: (t) => {
        // Monotonic: an out-of-order relay must never drag the gate backwards.
        if (t > opponentTick) { opponentTick = t; lastOpponentAdvanceAt = Date.now(); }
      },
      onChain: (msg) => {
        if (msg.stage === 'failed') {
          // The opponent could not stake. Nothing of ours is committed yet at
          // this point, so the match simply plays unstaked — and says so.
          pendingJoin = null;
          useEscrow.setState({
            phase: 'failed',
            lastError: `opponent could not stake${msg.reason ? `: ${msg.reason}` : ''}`,
          });
          return;
        }
        if (msg.stage === 'opened' && msg.onchainMatchId !== null && pendingJoin) {
          const p = pendingJoin;
          pendingJoin = null;
          void useEscrow.getState().join(
            signer(), msg.onchainMatchId, p.stakeSol, p.opponent, p.deck, p.hash,
          ).then((ok) => {
            // Seat 1 needs the rollup too.
            //
            // Only the `joined` branch below started it, and that branch is
            // seat 0's. So seat 1 never left `phase: 'off'`, `play` returns
            // early unless the phase is live, and not one of seat 1's cards
            // was ever written to the on-chain log — half of every human
            // match, missing from the record that is supposed to be the
            // whole point of keeping one.
            if (ok) beginRollupLog(msg.onchainMatchId!);
          }).then(() => verifyOpponentCommitment(msg.onchainMatchId!));
        }
        if (msg.stage === 'joined' && msg.onchainMatchId !== null) {
          // Seat 0 learns its stake was matched, and only now spends a
          // transaction on the log.
          void useEscrow.getState().prepareLog(signer(), msg.onchainMatchId)
            .then((ok) => { if (ok) beginRollupLog(msg.onchainMatchId!); })
            .then(() => verifyOpponentCommitment(msg.onchainMatchId!));
        }
      },
      onInput: (ev) => queueRemoteInput(ev),
      onDesync: () => settleVoid('the two sims diverged'),
      onOpponentLeft: () => {
        const s = get();
        if (s.status === 'battle' && s.sim && s.sim.phase !== 'ended') {
          clearTimers();

          /**
           * Finish the game rather than claiming a forfeit.
           *
           * Lockstep means this client holds every input the opponent ever
           * sent, so it can run the remaining ticks alone and arrive at the
           * same result they did. Declaring "they left, therefore I win" is
           * what produced the worst failure in the whole money path: the
           * player who genuinely won closed their socket on the way out, and
           * the loser — a few ticks behind — read that as a forfeit and
           * reported *itself* the winner. Two seats each claiming victory is a
           * dispute, and `settle_from_log` correctly refuses to pay a disputed
           * match, so a perfectly good game stranded its own pot.
           *
           * Bounded: if the sim genuinely cannot reach an end — the opponent
           * left early and there are not enough inputs to resolve it — the
           * forfeit stands, which is the right answer for an abandoned match.
           */
          finishAloneAndSettle(s.sim, s.perspective);
        } else if (s.status !== 'settled') {
          // Vanished between matched and the start: the stake was already
          // escrowed at matched, and the bot flow escrows again — refund
          // first or the fallback double-charges.
          refundEscrow();
          fallBack();
        }
      },
      onSocketLost: () => {
        // My own connection died mid-match.
        //
        // This used to settle a loss, on the reasoning that the server had
        // already given the opponent a forfeit win. That holds when one
        // client drops. It does not hold when the *relay* drops — then both
        // clients get this callback, both settle themselves the loser, and
        // nobody is paid at all.
        //
        // This client cannot tell the two cases apart from here, and the
        // asymmetric guess is the one that can lose the whole pot. Void
        // instead: the design already treats an unresolvable match that way,
        // and an opponent who is genuinely still connected settles normally
        // through their own forfeit path.
        const s = get();
        if (s.status === 'battle' && s.sim && s.sim.phase !== 'ended') {
          clearTimers();
          settleVoid('the connection dropped mid-match');
        } else if (s.status === 'queuing' || s.status === 'found') {
          refundEscrow();
          fallBack();
        }
      },
    });
    /*
     * The queue names an address, so the queue proves the address.
     *
     * The relay relays `msg.address` to the opponent as who they are playing,
     * and an unsigned queue let anyone claim anyone. Signing was enforced
     * server-side once before and taken down again because the client never
     * sent it — this is the client sending it. A guest signs locally with no
     * prompt; a wallet signs one message per queue. If the wallet refuses,
     * the queue goes out unsigned and the relay treats it as casual — an
     * unproven identity can still play, it just cannot rank.
     */
    void (async () => {
      const signed = await signAction(wallet.address, 'queue', useWallet.getState().signMessage);
      pvpQueue({
        address: signed?.address ?? wallet.address,
        ...(signed ? { ts: signed.ts, signature: signed.signature } : {}),
        name: wallet.walletName || 'anon',
        tier: deck.tier,
        power: deck.power(),
        deck: player,
        deckHash: player.map((c) => c.coinId).join(','),
        // The matchmaker pairs on rating within a widening band, and only pairs
        // players who asked for the same format — a 30-second Rush cannot be
        // seated against a 3-minute standard match.
        trophies: useLadder.getState().trophies,
        ranked,
        format: rush ? 'rush' : 'standard',
      });
    })();
    // Ranked has no bot timer at all: there is nothing to fall back to.
    if (!ranked) queueTimers.push(setTimeout(fallBack, pvpWaitMs()));
    return null;
  },

  cancelQueue: () => {
    const { status, mode } = get();
    if (status !== 'queuing' && status !== 'found') return;
    // Once a human match has formed the die is cast: the stake is escrowed and
    // a real opponent is committed. Backing out here is a forfeit, not a
    // cancel, and the UI stops offering Cancel at 'found' for the same reason.
    if (status === 'found' && mode === 'human') return;
    clearTimers();
    pvpCancel();
    pvpClose();
    set({ status: 'idle', sim: null, version: 0 });
  },

  playCard: (deckIndex, xFp, yFp) => {
    const { sim, status, mode, perspective } = get();
    if (!sim || status !== 'battle' || sim.phase === 'ended') return;
    const delay = mode === 'human'
      ? (humanInputDelayTicks || HUMAN_INPUT_DELAY_TICKS)
      : INPUT_DELAY_TICKS;
    const ev: InputEvent = {
      tick: sim.tick + delay, player: perspective, deckIndex, x: xFp, y: yFp,
    };
    const list = pending.get(ev.tick) ?? [];
    list.push(ev);
    pending.set(ev.tick, list);
    // The opponent applies the identical event at the identical tick — that,
    // and nothing else, is what keeps the two sims one game.
    if (mode === 'human') pvpSendInput(ev);
    // Write the play to the ephemeral rollup. Deliberately not awaited: the
    // local sim is authoritative for what the player sees, and a battle must
    // never stall on a network round trip. The store counts failures instead of
    // hiding them.
    void useErMatch.getState().play(signer(), ev.tick, deckIndex, xFp, yFp);
  },

  forfeit: () => {
    if (get().status !== 'battle') return; // already settled or never started
    const { sim, mode, perspective } = get();
    clearTimers();
    // Closing the socket is the forfeit: the server tells the opponent, who
    // wins by opponent_left. No second message type to disagree with it.
    if (mode === 'human') pvpClose();
    if (sim && sim.phase !== 'ended') {
      sim.phase = 'ended';
      sim.winner = (1 - perspective) as 0 | 1;
    }
    settle();
  },

  dismiss: () => {
    clearTimers();
    pvpClose();
    stopMusic();
    set({
      status: 'idle', sim: null, result: null, version: 0, crowns: [0, 0],
      shock: null, practice: false, mode: 'bot', perspective: 0,
    });
  },
}));

/** One bot-match tick: the bot decides, then the sim advances. */
function tickOnce(difficulty: BotDifficulty): void {
  const sim = useMatch.getState().sim;
  if (!sim) return;

  const botEv = decideBot(sim, 1, difficulty);
  if (botEv) {
    const list = pending.get(botEv.tick) ?? [];
    list.push(botEv);
    pending.set(botEv.tick, list);
  }
  stepOne(sim);
}

/**
 * Bot matches pace against the wall clock exactly like human ones. A plain
 * per-interval step froze the whole match when the tab was hidden — browsers
 * throttle background timers — so switching apps mid-battle left a stake
 * suspended in a stopped clock forever. Now the match continues at real time
 * and a returning player fast-forwards to the present, same as PvP.
 */
let botStartAt = 0;

function tickBot(difficulty: BotDifficulty): void {
  const sim = useMatch.getState().sim;
  if (!sim || sim.phase === 'ended') return;
  const target = Math.floor((Date.now() - botStartAt) / TICK_MS);
  let steps = 0;
  while (sim.tick < target && steps < 6) {
    tickOnce(difficulty);
    steps += 1;
    if ((sim.phase as SimState['phase']) === 'ended') break;
  }
}

/**
 * One sim tick plus its presentation side-effects. Shared by the bot loop and
 * the human loop — the step itself must be byte-identical in both.
 */
function stepOne(sim: SimState): void {
  const { mode, perspective } = useMatch.getState();

  // presentation-only snapshots taken around the step
  const towersBefore = sim.towers.map((t) => t.hp > 0);
  const unitsBefore = sim.units.length;

  stepSim(sim, pending.get(sim.tick) ?? []);
  pending.delete(sim.tick - 1);
  if (sim.tick % HASH_EVERY_TICKS === 0) {
    const h = hashState(sim);
    hashes.push(h);
    // The server compares this against the opponent's hash for the same tick.
    // A mismatch voids the match.
    if (mode === 'human') pvpSendHash(sim.tick, h);
    // And the rollup keeps the checkpoint onchain, which is what makes the
    // anti-cheat story verifiable by anyone rather than by our own relay.
    // Every fourth checkpoint: the sponsored commit quota is finite, and one
    // hash per 8 seconds of play is enough to bound a divergence.
    if (sim.tick % (HASH_EVERY_TICKS * 4) === 0) {
      void useErMatch.getState().mark(signer(), sim.tick, BigInt(h >>> 0));
    }
  }

  // a tower fell this tick → crown, sound, screen shock
  let felled: 0 | 1 | null = null;
  for (let i = 0; i < sim.towers.length; i++) {
    if (towersBefore[i] && sim.towers[i].hp <= 0) felled = sim.towers[i].owner;
  }
  if (felled !== null) play('tower');
  if (sim.units.length > unitsBefore) play('deploy');

  useMatch.setState((s) => {
    const next: Partial<MatchStore> = { version: s.version + 1 };
    if (felled !== null) {
      // derived, never accumulated — two towers can fall on the same tick
      next.crowns = countCrowns(sim, perspective);
      next.shock = { id: s.version + 1, kind: 'tower', forPlayer: felled };
    }
    return next;
  });

  if (sim.phase === 'ended') {
    clearTimers();
    if (mode === 'human') pvpSendEnded();
    settle();
  }
}

/**
 * Human matches step against the shared wall clock, not a free-running
 * interval: both clients target tick = (now − startAt) / 50ms, so they stay
 * within a tick of each other without any "are you ready" chatter. The catch-up
 * bound keeps a tab that was throttled in the background from spiralling.
 */
/**
 * Run out a match whose opponent has stopped participating, then settle.
 *
 * Shared by the two ways that happens — a closed socket and a socket that
 * stays open while going silent — because the correct response to both is the
 * same, and it is not "I win". Lockstep means this client holds every input
 * the opponent ever sent, so it can step the remaining ticks alone and reach
 * the result they would have reached. Only when the match genuinely cannot be
 * resolved does the player still present take it.
 */
function finishAloneAndSettle(sim: SimState, perspective: 0 | 1): void {
  const target = Math.floor((sharedNow() - humanStartAt) / TICK_MS);
  const limit = sim.format.regulationTicks + sim.format.overtimeTicks;
  let guard = 0;
  while (
    (sim.phase as SimState['phase']) !== 'ended'
    && sim.tick < Math.max(target, limit)
    && guard < limit + 100
  ) {
    stepOne(sim);
    guard += 1;
  }
  if ((sim.phase as SimState['phase']) !== 'ended') {
    // Genuinely abandoned: not enough of the match happened to resolve it, so
    // the player still here takes it.
    sim.phase = 'ended';
    sim.winner = perspective;
  }
  settle();
}

function tickHuman(): void {
  const sim = useMatch.getState().sim;
  if (!sim || sim.phase === 'ended') return;
  const wallTarget = Math.floor((sharedNow() - humanStartAt) / TICK_MS);
  /**
   * Never more than one input-delay ahead of the opponent.
   *
   * An input they stamp lands at `theirTick + delay`, so as long as we are no
   * further ahead than that, it can always still be applied. Waiting here is a
   * brief stutter; running ahead is a voided match.
   */
  const delay = humanInputDelayTicks || HUMAN_INPUT_DELAY_TICKS;
  /**
   * `- 2`, and the two are load-bearing.
   *
   * An input the opponent stamps while at tick T lands at `T + delay`, and the
   * receiver rejects anything at or *before* its own current tick. Gating at
   * exactly `T + delay` therefore leaves a one-tick hole: both sides sit on the
   * same number, the input arrives for a tick already reached, and the match
   * voids by fifty milliseconds. Observed exactly that way — "an input arrived
   * 1 tick (50ms) too late".
   *
   * One would close the hole; two leaves a tick of slack for `opponentTick`
   * having advanced between the gate being computed and the input being
   * stamped. The cost is 100ms of extra buffer, which nobody can feel.
   */
  const target = Math.min(wallTarget, opponentTick + delay - 2);

  /*
   * A silent opponent must not hold the match open forever.
   *
   * The gate above is what makes lockstep correct, and it is also what makes a
   * stall total: `opponentTick` stops moving, `target` stops moving, and the
   * clock sits still until someone forfeits a game they had not lost. Only a
   * *disconnect* was handled, and staying connected while saying nothing is
   * the cheaper thing to do, deliberately or not.
   *
   * The test is "we are being held back, and they have not moved for a while"
   * — never the wall clock alone, or a match that is merely waiting out its
   * own input delay would end itself. Resolution is the same as a disconnect:
   * run the remaining ticks and take the real result, not a claimed win.
   */
  if (target < wallTarget && Date.now() - lastOpponentAdvanceAt > OPPONENT_STALL_MS) {
    clearTimers();
    console.warn('opponent stopped announcing ticks — finishing the match alone');
    finishAloneAndSettle(sim, useMatch.getState().perspective);
    return;
  }

  let steps = 0;
  while (sim.tick < target && steps < 6) {
    stepOne(sim);
    steps += 1;
    // stepOne mutates phase, which TS's narrowing can't see through
    if ((sim.phase as SimState['phase']) === 'ended') break;
  }

  /**
   * Tell the opponent where we are, four times a second.
   *
   * The gate above is only half of it: if neither client announces its tick,
   * both sit at `0 + delay` and the match freezes almost immediately. The rate
   * has to be well inside the delay window or the gate binds on every step and
   * the game stutters — every four ticks is five messages a second, which is
   * nothing against a relay already carrying a state hash every two seconds.
   */
  // Announced far more often than the delay is wide, or the gate binds on
  // every step and the match stutters instead of running.
  if (sim.tick - lastAnnouncedTick >= 4) {
    lastAnnouncedTick = sim.tick;
    pvpSendTick(sim.tick);
  }
}

function beginBotFlow(
  practice: boolean, tierIdx: number, player: MatchCard[], bot: MatchCard[],
): void {
  const tier = TIERS[tierIdx];
  // practice skips the search theatre — the point is to get to the arena
  const queueMs = practice ? 400 : 1200 + Math.random() * 1300;
  queueTimers.push(setTimeout(() => {
    if (useMatch.getState().status !== 'queuing') return;
    useMatch.setState({ status: 'found' });
    queueTimers.push(setTimeout(() => {
      if (useMatch.getState().status !== 'found') return;
      // Escrow happens here, not at queue time: a cancelled or abandoned
      // search must never cost the player anything. Practice never escrows.
      if (!practice) {
        if (!useWallet.getState().spend(tier.stakeSol)) {
          clearTimers();
          useMatch.setState({ status: 'idle' });
          return;
        }
        play('coin');
      }
      const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
      const sim = createMatch(seed, [player, bot], FORMATS[useMatch.getState().rush ? 'rush' : 'standard']);
      pending = new Map();
      hashes = [];
      useMatch.setState({ status: 'battle', sim, version: 0, crowns: [0, 0], shock: null });
      startMusic();
      const difficulty: BotDifficulty = tierIdx <= 0 ? 'easy' : tierIdx === 1 ? 'normal' : 'hard';
      botStartAt = Date.now();
      loop = setInterval(() => tickBot(difficulty), TICK_MS / 2);
    }, 900));
  }, queueMs));
}

/** Refund a tracked human-match escrow exactly once. */
/**
 * Give back whatever this match took, on both layers.
 *
 * The local half is play money for Guests. The on-chain half matters far more:
 * seat 0 escrows the moment it is paired, and if the opponent never joins, the
 * stake sits in an `Open` match with eight cards locked behind it until
 * somebody calls `cancel_match`. Nobody else will. Any path that abandons a
 * match has to come through here.
 */
/**
 * Give up on this opponent without giving up the stake.
 *
 * Both ways an opponent's deck can be unusable — it fails `sanitiseDeck`, or
 * it survives that and `createMatch` throws on it — have to end the same way:
 * the money comes back, the socket closes, and the player gets a match against
 * the bot instead of a dead screen. Written once because the two call sites
 * drifted, and the one that drifted was the one that silently kept the stake.
 */
function bailToBot(tierIdx: number): void {
  refundEscrow();
  pvpClose();
  useMatch.setState({ mode: 'bot', perspective: 0, opponentName: BOT_NAMES[tierIdx] });
  const bot = buildDecks();
  if (bot) beginBotFlow(false, tierIdx, bot.player, bot.bot);
  else useMatch.setState({ status: 'idle' });
}

function refundEscrow(): void {
  if (humanEscrowSol > 0) {
    useWallet.getState().receive(humanEscrowSol);
    humanEscrowSol = 0;
  }
  pendingJoin = null;
  const escrow = useEscrow.getState();
  if (escrow.phase === 'waiting' || escrow.phase === 'opening') {
    void escrow.withdraw(signer());
  }
}

/**
 * A real opponent. Seat 0's deck is seat 0's deck on both machines — the sim
 * is one shared timeline and `perspective` only changes who the camera loves.
 */
/**
 * A deck relayed by the opponent, checked before it can touch the simulation.
 *
 * `createMatch` only ever validated the length. Everything else came straight
 * from JSON on a relay the opponent controls, and the sim indexes tables with
 * it: an `archetype` of 6 makes `ARCHETYPES[6]` undefined, so the elixir cost
 * is NaN, `elixir < NaN` is false, and `elixir -= NaN` poisons that seat's
 * balance for the rest of the match — every card free, forever.
 *
 * The reason that is worse than it sounds: it happens identically on both
 * clients, and `Fnv1a.int(NaN)` hashes to the same value on both, so the state
 * hash agrees and no desync is ever detected. A corrupted match settles as if
 * it were honest.
 *
 * Rejecting here means the match voids and both stakes come home, which is the
 * same thing that happens for any other unplayable state.
 */
function sanitiseDeck(deck: unknown): MatchCard[] | null {
  if (!Array.isArray(deck) || deck.length !== 8) return null;
  const out: MatchCard[] = [];
  for (const c of deck) {
    if (!c || typeof c !== 'object') return null;
    const { coinId, name, archetype, level, trait } = c as Record<string, unknown>;
    if (typeof coinId !== 'string' || !coinId) return null;
    if (typeof name !== 'string') return null;
    if (!Number.isInteger(archetype) || (archetype as number) < 0 || (archetype as number) > 5) return null;
    if (!Number.isInteger(level) || (level as number) < 1 || (level as number) > 10) return null;
    // A missing trait is fine — createMatch derives it from the mint. An
    // out-of-range one is not: TRAITS[trait] is dereferenced every tick.
    if (trait !== undefined && (!Number.isInteger(trait) || (trait as number) < 0 || (trait as number) > 5)) return null;
    out.push({
      coinId, name: name.slice(0, 24),
      archetype: archetype as MatchCard['archetype'],
      level: level as number,
      trait: trait as MatchCard['trait'],
    });
  }
  return out;
}

function beginHumanBattle(
  m: MatchedPayload, myDeck: MatchCard[], stakeSol: number, tierIdx: number,
  rush = false,
): void {
  clearTimers(); // the bot fallback timer must not fire mid-handshake
  const store = useMatch.getState();
  if (store.status !== 'queuing' && store.status !== 'found') return;

  if (!useWallet.getState().spend(stakeSol)) {
    pvpClose();
    useMatch.setState({ status: 'idle' });
    return;
  }
  humanEscrowSol = stakeSol;
  play('coin');

  /**
   * The real escrow.
   *
   * Runs only for a ranked, staked match with a wallet that can sign and a
   * fully-minted deck; anything else plays for the ladder alone and the Arena
   * says so. Not awaited: a create/join round trip is seconds of wallet
   * prompts and confirmations, and the match must start on the shared clock
   * both clients already agreed on. The escrow store carries the outcome, and
   * settlement checks it before claiming anything was paid.
   *
   * Seat 0 opens and relays the id; seat 1 waits for that relay, verifies the
   * match account itself, and matches the stake. Neither can be made to stake
   * by the other: the id is a hint, the chain is the authority.
   */
  const escrow = useEscrow.getState();
  escrow.reset();
  // `canSign`, not `signer() !== null`. A guest has no adapter and still
  // signs, through a browser-held keypair — testing for an adapter meant every
  // guest silently played unstaked while the Arena said "Escrowed onchain".
  const canStake = stakeSol > 0
    && useChain.getState().mode === 'onchain'
    && canSign(signer());
  const chainDeck = canStake ? onchainDeckIds() : null;
  // Money path: say out loud what was decided and why. A stake that silently
  // does not happen is the worst failure this app has, and it left no trace.
  console.info('[escrow] role', m.role, 'stakeSol', stakeSol,
    'mode', useChain.getState().mode, 'canSign', canSign(signer()),
    'canStake', canStake, 'chainDeck', chainDeck ? chainDeck.length : null);
  if (canStake && chainDeck) {
    // The program derives the commitment itself inside `validate_and_lock_deck`
    // and ignores this argument — it is `_deck_hash` there. Passing a locally
    // computed hash invited exactly the bug above, where two different
    // functions both claimed to be "the commitment". Send nothing meaningful.
    const hash = new Uint8Array(32);
    if (m.role === 0) {
      void escrow.open(signer(), tierIdx, stakeSol, chainDeck, hash)
        .then(async (id) => {
          if (id === null) return;
          if (await escrow.prepareLog(signer(), id)) beginRollupLog(id);
        });
    } else {
      pendingJoin = {
        stakeSol, opponent: m.opponent.address, deck: chainDeck, hash,
      };
    }
  } else if (stakeSol > 0) {
    // Say which of the three reasons it was, rather than silently playing an
    // unstaked match that the UI labelled with a stake.
    useEscrow.setState({
      phase: 'failed',
      lastError: !canStake
        ? 'this session cannot sign — playing for the ladder only'
        : 'your deck is not fully minted onchain — playing for the ladder only',
    });
  }

  const oppDeck = sanitiseDeck(m.opponent.deck);
  if (!oppDeck) {
    /*
     * Not a desync and not our fault — refuse to start rather than run a
     * simulation whose rules the opponent chose.
     *
     * This called `settleVoid`, which does nothing here: its first line is
     * `if (status !== 'battle' || !sim) return`, and the sim is not built
     * until a few lines below. So the stake stayed escrowed, the socket
     * stayed open, and the player sat at 'found' with their money gone until
     * the deadline let somebody call `claim_timeout` — for a match that never
     * started. The identical failure fifteen lines down, where `createMatch`
     * throws, was already handled properly; this one just never reached it.
     */
    bailToBot(tierIdx);
    return;
  }

  const decks: [MatchCard[], MatchCard[]] = m.role === 0
    ? [myDeck, oppDeck]
    : [oppDeck, myDeck];

  let sim: SimState;
  try {
    sim = createMatch(m.seed, decks, rush ? FORMATS.rush : FORMATS.standard);
  } catch {
    // A malformed opponent deck must not strand this player at 'found' with
    // their stake gone. Refund, drop the socket, and let the bot step in.
    bailToBot(tierIdx);
    return;
  }
  pending = new Map();
  hashes = [];
  humanStartAt = m.startAt;

  // The message spent one network leg in flight, so the server's clock has
  // moved on by roughly that much since it was stamped. Half the round trip is
  // the standard estimate and it is not measurable from one message, so this
  // uses the conservative floor: assume the message was instant, which makes
  // the correction err small rather than overshoot. Anything left is far below
  // the tick that matters, and vastly below the clock drift this exists for.
  clockSkew = typeof m.serverNow === 'number' ? m.serverNow - Date.now() : 0;
  opponentTick = 0;
  lastAnnouncedTick = 0;
  lastOpponentAdvanceAt = Date.now();
  // Sized by the server to the worse of the two connections; both clients get
  // the same number in the same message.
  humanInputDelayTicks = typeof m.inputDelayTicks === 'number'
    && m.inputDelayTicks >= 8 && m.inputDelayTicks <= 160
    ? m.inputDelayTicks
    : 0;

  useMatch.setState({
    status: 'found',
    mode: 'human',
    perspective: m.role,
    opponentName: m.opponent.name ?? `${m.opponent.address.slice(0, 4)}…${m.opponent.address.slice(-4)}`,
  });

  // Both clients hold on 'found' until the shared start instant, then step
  // against the same clock. The interval runs at half a tick so a late timer
  // callback still lands inside the right tick window.
  const untilStart = Math.max(0, m.startAt - sharedNow());
  queueTimers.push(setTimeout(() => {
    if (useMatch.getState().status !== 'found') return;
    useMatch.setState({ status: 'battle', sim, version: 0, crowns: [0, 0], shock: null });
    startMusic();
    loop = setInterval(tickHuman, TICK_MS / 2);
  }, untilStart));
}

/** Remote inputs join the same queue local ones do — the sim cannot tell. */
/**
 * Is this something the simulation can actually be fed?
 *
 * The opponent's *deck* has been sanitised since the start; their inputs never
 * were, and an input reaches `applyInput` far more directly. A non-integer
 * `deckIndex` walks straight past every bounds check in the engine — `1.5 < 0`
 * is false, `1.5 >= 8` is false, `cycle.indexOf(1.5)` is -1 — and then
 * `p.deck[1.5]` is undefined and reading `.archetype` throws. That throw
 * happens before `state.tick++`, so the tick never advances, the interval
 * re-runs it forever, and the victim is frozen mid-battle with their stake
 * escrowed and no way out. A single crafted frame from a modified client.
 *
 * Malformed frames are *dropped*, not voided. Voiding on anything unparseable
 * would hand the same client a one-message refund button — which is the other
 * half of what this closes.
 */
function inputIsWellFormed(ev: unknown, perspective: 0 | 1): ev is InputEvent {
  if (!ev || typeof ev !== 'object') return false;
  const { tick, player, deckIndex, x, y } = ev as Record<string, unknown>;
  if (![tick, player, deckIndex, x, y].every((n) => Number.isInteger(n))) return false;
  // Only ever the other seat. `!== perspective` would accept a third value.
  if (player !== 1 - perspective) return false;
  if ((deckIndex as number) < 0 || (deckIndex as number) >= 8) return false;
  // The engine clamps coordinates, but only after indexing the deck, and a
  // wild value here is a signal the sender is not the client we think it is.
  if (Math.abs(x as number) > ARENA_W * 4 || Math.abs(y as number) > ARENA_H * 4) return false;
  return (tick as number) > 0;
}

function queueRemoteInput(ev: InputEvent): void {
  const { sim, perspective, mode } = useMatch.getState();
  if (!sim || mode !== 'human') return;
  if (ev.player === perspective) return; // never accept our own seat from outside
  if (!inputIsWellFormed(ev, perspective)) return;
  if (ev.tick <= sim.tick) {
    // Too late to apply at its stamped tick: the sender already applied it, so
    // the timelines have split. Voiding is the only honest response — but say
    // by how much, because "the connection is slower than the input delay" and
    // "something is broken" produce the same symptom and need opposite fixes.
    const lateTicks = sim.tick - ev.tick + 1;
    settleVoid(
      `an input arrived ${lateTicks} tick${lateTicks === 1 ? '' : 's'} `
      + `(${lateTicks * 50}ms) too late to stay in lockstep`,
    );
    return;
  }
  const list = pending.get(ev.tick) ?? [];
  list.push(ev);
  pending.set(ev.tick, list);
}

/**
 * Annul the match: stakes come back, nothing is raked, nothing is recorded.
 * This is the designed response to divergence — the one unacceptable outcome
 * is two players seeing two different games and one of them paying for it.
 */
function settleVoid(reason: string): void {
  const { status, stakeSol, sim } = useMatch.getState();
  if (status !== 'battle' || !sim) return;
  clearTimers();
  pvpClose();
  stopMusic();
  useWallet.getState().receive(stakeSol); // the escrowed stake, returned whole
  humanEscrowSol = 0; // consumed by the refund above — never refund twice

  /**
   * A void has to reach the chain too.
   *
   * This used to refund the local number and stop. If the stake was actually
   * escrowed, the pot then sat in the match account with neither seat having
   * said anything — settlement needs two claims and got none — until the
   * deadline let somebody call `claim_timeout`. Both players had been told
   * their stake was returned, and on chain it had not moved.
   *
   * Claiming a draw is the honest report: nobody won, so `settle_from_log`
   * splits the pot back. Both seats reach here on a void, so both claim the
   * same thing and the agreement the program requires is satisfied.
   */
  if (useEscrow.getState().matchId !== null) {
    const h = hashes.length ? hashes[hashes.length - 1] : 0;
    void useEscrow.getState().finish(signer(), 2, BigInt(h >>> 0));
  }
  const result: MatchResult = {
    won: false,
    draw: true,
    voided: true,
    // A void reaches here from both seats, escrowed or not — `matchId !== null`
    // above is what decides whether there is anything to claim against.
    escrowed: useEscrow.getState().matchId !== null,
    matchId: useEscrow.getState().matchId,
    potSol: stakeSol * 2,
    payoutSol: stakeSol,
    rakeSol: 0,
    hashes: hashes.length,
    crowns: countCrowns(sim, useMatch.getState().perspective),
    chest: null,
  };
  console.warn(`match voided: ${reason}`);
  useMatch.setState({ status: 'settled', result });
}

/** Crowns = enemy towers felled, seen from `me`. Derived, so it cannot drift. */
function countCrowns(sim: SimState, me: 0 | 1): [number, number] {
  let mine = 0;
  let theirs = 0;
  for (const t of sim.towers) {
    if (t.hp > 0) continue;
    if (t.owner === me) theirs += 1;
    else mine += 1;
  }
  return [mine, theirs];
}

function settle(): void {
  const { sim, stakeSol, status, practice, perspective, mode, ranked } = useMatch.getState();
  if (!sim || status === 'settled') return; // idempotent: never pay twice
  if (mode === 'human') pvpClose();
  humanEscrowSol = 0; // consumed by the payout rules below
  const crowns = countCrowns(sim, perspective);

  // Seal the rollup log and bring it home. Not awaited: the result screen must
  // appear immediately, and the commit is observable through the rollup badge.
  // The final hash is the last checkpoint, which is what settlement records.
  if (sim.phase === 'ended') {
    const finalHash = hashes.length ? hashes[hashes.length - 1] : 0;
    // 0 = seat 0 won, 1 = seat 1 won, 2 = draw. This read `sim.winner === null`,
    // but `winner` is never null — it is -1 while the match runs and -2 for a
    // draw. So a draw fell through to the ternary, compared -2 against the
    // perspective, and committed "seat 1 won". Both clients then wrote
    // contradictory winners for the same drawn match, which under the new
    // 2-of-2 settlement is a dispute that voids rather than splits.
    /**
     * The winner as an absolute seat, which is what the program stores.
     *
     * This used to report it *relative to the reporter* — 0 for "I won", 1 for
     * "I lost" — while `end_match_log` writes it straight into
     * `claims[seat]` and `settle_from_log` pays `players[winner]`. So a
     * decisive match produced claims of `[1, 0]`: each seat naming the other,
     * which the program reads as a dispute and correctly refuses to pay.
     *
     * Every decisive staked match therefore failed to settle, and only draws
     * ever paid out — because 2 means "draw" from either side and was the one
     * value the conversion left alone. `sim.winner` is already a seat index
     * (the engine sets 0 or 1 by which king tower fell), so the conversion was
     * only ever destroying that information.
     */
    const winner = sim.winner === -2 ? 2 : sim.winner;
    void useErMatch.getState().finish(signer(), winner, BigInt(finalHash >>> 0));

    // The money. Each seat records its own result; whichever of them finds the
    // log home with both claims in it triggers the payout. Not awaited — the
    // result screen shows immediately and the escrow badge reports where the
    // pot got to.
    if (useEscrow.getState().matchId !== null) {
      void useEscrow.getState().finish(signer(), winner, BigInt(finalHash >>> 0));
    }
  }
  stopMusic();
  const wallet = useWallet.getState();
  const pot = stakeSol * 2;
  const draw = sim.winner === -2;
  const won = sim.winner === perspective;
  const rakePct = draw ? FEES.tieRakePct : FEES.rakePct;
  const rakeSol = +(pot * (rakePct / 100)).toFixed(4);
  /**
   * Credit locally only when nothing was actually escrowed.
   *
   * When the stake IS on chain, the program pays the winner and the wallet
   * balance is re-read from `getBalance` — crediting here as well would show
   * the pot twice, once real and once invented, and the invented half would
   * vanish on the next refresh. The payout figure is still computed either way
   * because the result screen states it.
   */
  const onchainStake = useEscrow.getState().matchId !== null;
  let payoutSol = 0;
  if (draw) {
    payoutSol = +((pot - rakeSol) / 2).toFixed(4);
    if (!onchainStake) wallet.receive(payoutSol);
  } else if (won) {
    payoutSol = +(pot - rakeSol).toFixed(4);
    if (!onchainStake) wallet.receive(payoutSol);
  }
  // Whatever happened, re-read the balance rather than trusting arithmetic.
  if (onchainStake) void useChain.getState().refresh();
  play(won || draw ? 'victory' : 'defeat');
  // A win earns a chest. Full slots deliberately award nothing — that pressure
  // is what makes the skip-timer purchase land. Practice earns nothing at all,
  // so it cannot be farmed for chests.
  // A chest tier is the one outcome the house picks, so it goes through the
  // MagicBlock VRF oracle whenever this session can sign. `Math.random()` here
  // is the Guest path only, and the chest records which it was — a UI that
  // showed the same badge either way would be lying about exactly the mechanic
  // players are right to distrust.
  //
  // Awarded optimistically with a local roll and reconciled when the oracle
  // answers: the result screen must not wait on an async callback, and a chest
  // that silently changes tier a second later is worse than one that arrives
  // already labelled as unverified.
  const awarded = won && !practice ? useEconomy.getState().awardChest() : null;
  const chest = awarded?.tier ?? null;
  if (awarded) void rollChestOnchain(awarded.id);
  /**
   * Trophies move only on ranked matches, and only against a real opponent's
   * rating. Practice and casual are excluded by construction — a ladder that
   * can be climbed against a bot is not a ladder.
   */
  // A ranked match against the AI fallback moves no trophies. The opponent
  // being real is the whole content of a ladder position.
  const trophyChange = ranked && !practice && mode === 'human'
    ? useLadder.getState().record(
      wallet.address,
      opponentTrophies,
      draw ? 'draw' : won ? 'win' : 'loss',
      pairKey ?? undefined,
    )
    : null;

  const result: MatchResult = {
    won, draw, potSol: pot, payoutSol, rakeSol, hashes: hashes.length, crowns, chest,
    escrowed: ['waiting', 'live', 'claiming', 'claimed', 'settled', 'refunded']
      .includes(useEscrow.getState().phase),
    matchId: useEscrow.getState().matchId,
    trophyDelta: trophyChange?.delta,
    trophiesAfter: trophyChange?.after,
    promoted: trophyChange?.promoted,
    demoted: trophyChange?.demoted,
    leagueAfter: trophyChange?.leagueAfter.name,
  };
  useMatch.setState((s) => ({
    status: 'settled',
    result,
    // practice never enters the record — a padded W/L is worse than none
    history: practice ? s.history : [result, ...s.history],
  }));

  // Standing rolls up after settlement, fire-and-forget by design: the result
  // screen must never wait on, or fail because of, a service. Practice stays
  // out of all of it for the same reason it stays out of history — it cannot
  // be farmed.
  if (!practice) {
    recordMatch(wallet.address, result);
    if (crowns[0] > 0) {
      useClan.getState().reportCrowns(wallet.address, crowns[0], useDeck.getState().power());
    }
  }
}
