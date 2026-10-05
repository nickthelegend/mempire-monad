/**
 * A second real client: real deck, real escrow, real seat, for a whole match.
 *
 * `spar.mjs` holds a queue slot with an invented deck and no chain presence.
 * `spar-escrow.mjs` joins the escrow for real but hangs up after 150s, which is
 * shorter than a standard match plus overtime — so the browser seat lost its
 * opponent partway through and the match never settled from a full log.
 *
 * This is both halves at once, and it stays for the duration:
 *
 *   - queues with wallet B's actual on-chain cards, one per coin, unlocked
 *   - joins the opponent's open match with the same `join_match` the client
 *     sends, committing the same deck hash and locking the same eight cards
 *   - holds the socket open past regulation and overtime so the relay never
 *     reports `opponent_left`
 *
 * It plays no cards. That is not a stub standing in for an opponent — making
 * no move is a legal thing for a player to do, and it is the whole point here:
 * the browser seat needs an opponent it can actually beat so that felling a
 * tower, earning crowns, and winning a chest can be observed end to end
 * instead of inferred. The escrow, the deck lock, the seat and the settlement
 * are all real; only the tactics are bad.
 */
import WebSocket from 'ws';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { createMatch, stepSim, hashState, FORMATS } from './sim-node.mjs';
import anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { readFileSync } from 'node:fs';

process.on('unhandledRejection', (e) => {
  console.log('spar-full: unhandled rejection (staying up) —', String(e).slice(0, 110));
});

const WS = process.env.WS ?? 'wss://mempire-relay-production.up.railway.app/ws';
const RPC = 'https://api.devnet.solana.com';
const PROGRAM = new PublicKey('BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP');
const HOLD_MS = Number(process.env.HOLD_MS ?? 420000);

const idl = JSON.parse(readFileSync(new URL('./src/chain/mempire.idl.json', import.meta.url)));
const demo = JSON.parse(readFileSync(new URL('./.demo-wallets.json', import.meta.url)));
const kp = Keypair.fromSecretKey(Uint8Array.from(demo['1']));

const conn = new Connection(RPC, 'confirmed');
const wallet = {
  publicKey: kp.publicKey,
  signTransaction: async (t) => { t.partialSign(kp); return t; },
  signAllTransactions: async (ts) => ts.map((t) => { t.partialSign(kp); return t; }),
};
const program = new anchor.Program(idl, new anchor.AnchorProvider(conn, wallet, { commitment: 'confirmed' }));

const le = (n) => new anchor.BN(n).toArrayLike(Buffer, 'le', 8);
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM)[0];
const configPda = () => pda(Buffer.from('config'));
const matchPda = (id) => pda(Buffer.from('match'), le(id));
const cardPda = (id) => pda(Buffer.from('card'), le(id));

/*
 * The `deck_hash` argument, which the program ignores.
 *
 * `create_match` and `join_match` take it as `_deck_hash` and derive the real
 * commitment themselves in `validate_and_lock_deck`, from the cards actually
 * locked. This used to claim to be "byte-identical to the client", which was
 * true of a client that was also computing the wrong thing. Send zeroes and
 * let the chain speak for itself.
 */
const IGNORED_DECK_HASH = new Uint8Array(32);

const DEFAULT = PublicKey.default.toBase58();

/** devnet refuses often enough that one attempt is not a load. */
async function withRetry(what, fn, tries = 6) {
  for (let i = 0; i < tries; i += 1) {
    try { return await fn(); } catch (e) {
      console.log(`spar-full: ${what} attempt ${i + 1} failed —`, e.message?.slice(0, 60));
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw new Error(`${what} failed after ${tries} attempts`);
}

const owned = await withRetry('deck load', () => program.account.card.all([
  { memcmp: { offset: 16, bytes: kp.publicKey.toBase58() } },
]));
const byCoin = new Map();
for (const c of owned) {
  if (c.account.lockedBy.toBase58() !== DEFAULT) continue;
  const mint = c.account.coinMint.toBase58();
  if (!byCoin.has(mint)) byCoin.set(mint, { id: c.account.id.toNumber(), level: c.account.level });
}
const picked = [...byCoin.entries()].slice(0, 8);
const deckIds = picked.map(([, v]) => v.id);
if (deckIds.length < 8) {
  console.log(`spar-full: only ${deckIds.length} free distinct coins — need 8`);
  process.exit(1);
}
console.log('spar-full: deck', picked.map(([, v]) => `${v.id}(L${v.level})`).join(','));

/*
 * Relay the deck we actually staked — levels included.
 *
 * `level: 1` was hardcoded here while `create_match` commits to
 * `(coin_mint, level)` for the cards it locks. A card of any other level made
 * the relayed deck disagree with the onchain commitment, and the opposing
 * client is supposed to void a match when those disagree. So this stub was
 * itself the deck-swap the commitment exists to catch — it just happened to be
 * swapping *down*. A real client relays what it staked; so does this one.
 */
const relayDeck = picked.map(([m, v], i) => ({
  coinId: m, name: `S${i}`, archetype: i % 6, level: v.level,
}));

let joined = false;
/*
 * The onchain match id, discovered after the sim has already started.
 *
 * The relay pairs and the clock starts before either seat's `create_match`
 * has confirmed, so the simulation has to begin without it. Reporting happens
 * three minutes later, by which time the join loop has filled this in.
 */
let onchainMatchId = null;

/*
 * Queue second, on a trigger.
 *
 * The relay gives role 0 to whoever is already waiting and role 1 to whoever
 * arrives — and only role 0 creates the match this client is meant to join. So
 * the browser has to be in the queue first. But the chain reads above take
 * longer than the browser's bot-fallback window, so queueing on connect raced
 * the browser and won, leaving it to bail as role 0 while the browser played a
 * bot. Loading first and queueing on a file touch puts the order beyond doubt.
 */
const TRIGGER = process.env.QUEUE_TRIGGER;
async function waitForTrigger() {
  if (!TRIGGER) return;
  const { existsSync } = await import('node:fs');
  console.log('spar-full: loaded, waiting for the browser to queue first…');
  while (!existsSync(TRIGGER)) await new Promise((r) => setTimeout(r, 250));
}

const ws = new WebSocket(WS);
ws.on('open', async () => {
  await waitForTrigger();
  /*
   * Signed, because ranked now requires a proven address — an unsigned queue
   * is demoted to casual and pairs with nobody who queued ranked. Same
   * message format as every other write: `Mempire\naction: queue\n…`.
   */
  const address = kp.publicKey.toBase58();
  const ts = Date.now();
  const msg = `Mempire\naction: queue\nwallet: ${address}\nts: ${ts}`;
  const signature = bs58.encode(
    nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey),
  );
  console.log('spar-full: queueing tier 0 ranked (signed)');
  ws.send(JSON.stringify({
    t: 'queue', tier: 0, address, ts, signature, deck: relayDeck,
    format: 'standard', ranked: true, trophies: 60, name: 'Sparring Partner',
  }));
});

/*
 * Announce our tick, the same way the browser does.
 *
 * Lockstep holds each seat to `opponentTick + delay`, so a seat that never
 * says where it is freezes the other one outright — the first run of this
 * client left the browser stuck at 3:00 until it was forfeited. This is not a
 * stand-in for a simulation: the tick a real client announces is derived from
 * the shared start instant and the wall clock, exactly as computed here, and
 * announcing it is the whole of that side of the protocol. What this client
 * genuinely does not do is play cards, which is a legal way to play.
 */
const TICK_MS = 50;
const HASH_EVERY_TICKS = 40;
const ER_RPC = 'https://devnet.magicblock.app';
const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
const MAGIC_CONTEXT = new PublicKey('MagicContext1111111111111111111111111111111');

/**
 * The log both seats write into.
 *
 * Note the *base* program id, not the rollup one. There are two programs here
 * with a `log` PDA under the same seeds, and only this one is the match log
 * that `init_match_log` creates, that gets delegated, and that
 * `settle_from_log` later reads. Deriving it under the rollup program pointed
 * at an account that has never existed, and the report failed with "expected
 * this account to be already initialized".
 */
const baseLogPda = (id) => PublicKey.findProgramAddressSync(
  [Buffer.from('log'), le(id)], PROGRAM,
)[0];

/**
 * This seat's own claim on the result.
 *
 * `settle_from_log` reads `log.claims[0]` and `log.claims[1]`, refuses to pay
 * while either is 3 ("has not spoken"), and voids the match when they
 * disagree. So the pot cannot pay out on the happy path unless both seats run
 * the simulation and independently reach the same winner. Announcing ticks let
 * the browser play; this is what lets it get paid.
 *
 * Runs against the rollup, because that is where the log is delegated, using
 * the base program's own `end_match_log` — the same instruction the browser
 * sends from the other seat.
 */
const ROLLUP_PROGRAM = new PublicKey('3G4GidvjQd3yQK4bqZfem8Kkmcboygze42RcjrXg5g6N');
const rollupIdl = JSON.parse(readFileSync(new URL('./src/chain/mempire_rollup.idl.json', import.meta.url)));
const rollupLogPda = (id) => PublicKey.findProgramAddressSync(
  [Buffer.from('log'), le(id)], ROLLUP_PROGRAM,
)[0];
const chestsPda = (owner) => PublicKey.findProgramAddressSync(
  [Buffer.from('chests'), owner.toBytes()], ROLLUP_PROGRAM,
)[0];

/**
 * The rollup log's claim — the chest side of the report.
 *
 * `end_log` now settles like the pot does: each seat records a claim and the
 * log seals when the second one lands, agreement granting the winner's chest.
 * So a seat that never claims holds the chest hostage. The rail passed is the
 * *claimed winner's* — the completing call's rail is what gets credited, and
 * both honest seats name the same winner, so it works in either order.
 */
async function reportRollupClaim(matchId, winner, finalHash, seats) {
  const erConn = new Connection(ER_RPC, 'confirmed');
  const log = rollupLogPda(matchId);
  const exists = await erConn.getAccountInfo(log);
  if (!exists) { console.log('spar-full: no rollup log for this match — skipping claim'); return; }
  const prog = new anchor.Program(
    rollupIdl,
    new anchor.AnchorProvider(erConn, wallet, { commitment: 'confirmed' }),
  );
  const winnerChests = winner < 2 ? chestsPda(new PublicKey(seats[winner])) : null;
  const sig = await prog.methods
    .endLog(winner, new anchor.BN(finalHash.toString()))
    .accounts({
      payer: kp.publicKey,
      log,
      winnerChests,
      magicProgram: MAGIC_PROGRAM,
      magicContext: MAGIC_CONTEXT,
    })
    .rpc();
  console.log(`spar-full: ROLLUP CLAIM winner=${winner} — ${sig.slice(0, 20)}…`);
}

async function reportResult(matchId, winner, finalHash) {
  const erConn = new Connection(ER_RPC, 'confirmed');
  const erProgram = new anchor.Program(
    idl,
    new anchor.AnchorProvider(erConn, wallet, { commitment: 'confirmed' }),
  );
  const log = baseLogPda(matchId);
  const sig = await erProgram.methods
    .endMatchLog(winner, new anchor.BN(finalHash.toString()))
    .accounts({
      payer: kp.publicKey,
      matchLog: log,
      magicContext: MAGIC_CONTEXT,
      magicProgram: MAGIC_PROGRAM,
    })
    .rpc();
  console.log(`spar-full: REPORTED winner=${winner} hash=${finalHash} — ${sig.slice(0, 20)}…`);
  return sig;
}

function announceTicks(startAt, offset) {
  const timer = setInterval(() => {
    const tick = Math.floor((Date.now() + offset - startAt) / TICK_MS);
    if (tick < 0) return;
    try { ws.send(JSON.stringify({ t: 'tick', tick })); } catch { clearInterval(timer); }
  }, 200);
  return timer;
}

/**
 * Run this seat's own simulation, in lockstep, to its own conclusion.
 *
 * Seat 0's deck is seat 0's deck on both machines, so the arrays go in in
 * match order regardless of which seat we are. The opponent's plays arrive as
 * `input` frames keyed by the tick they land on, exactly as the browser queues
 * them, and this seat plays nothing — so what comes out is the result of their
 * match, computed here rather than taken on trust.
 */
function runSim({ seed, startAt, offset, format, seat0Deck, seat1Deck, seats }) {
  const sim = createMatch(seed, [seat0Deck, seat1Deck], FORMATS[format] ?? FORMATS.standard);
  const pending = new Map();
  let reported = false;

  const onInput = (ev) => {
    if (!ev || !Number.isInteger(ev.tick)) return;
    const list = pending.get(ev.tick) ?? [];
    list.push(ev);
    pending.set(ev.tick, list);
  };

  const loop = setInterval(async () => {
    const wall = Math.floor((Date.now() + offset - startAt) / TICK_MS);
    let steps = 0;
    while (sim.tick < wall && sim.phase !== 'ended' && steps < 12) {
      stepSim(sim, pending.get(sim.tick) ?? []);
      pending.delete(sim.tick - 1);
      if (sim.tick % HASH_EVERY_TICKS === 0) {
        try { ws.send(JSON.stringify({ t: 'hash', tick: sim.tick, hash: hashState(sim) })); } catch { /* closed */ }
      }
      steps += 1;
    }
    if (sim.phase !== 'ended' || reported) return;

    reported = true;
    clearInterval(loop);
    const winner = sim.winner === -2 ? 2 : sim.winner;
    const finalHash = BigInt(hashState(sim) >>> 0);
    console.log(`spar-full: sim ended tick ${sim.tick} winner ${winner} hash ${finalHash}`);
    try { ws.send(JSON.stringify({ t: 'ended' })); } catch { /* closed */ }
    if (onchainMatchId === null) {
      console.log('spar-full: no onchain match to report to (nothing was escrowed)');
      return;
    }
    try {
      await reportResult(onchainMatchId, winner, finalHash);
    } catch (e) {
      console.log('spar-full: report failed —', (e.message || String(e)).slice(0, 180));
    }
    try {
      await reportRollupClaim(onchainMatchId, winner, finalHash, seats);
    } catch (e) {
      console.log('spar-full: rollup claim failed —', (e.message || String(e)).slice(0, 180));
    }
  }, TICK_MS / 2);

  return onInput;
}

let feedInput = null;

ws.on('message', async (raw) => {
  let m; try { m = JSON.parse(String(raw)); } catch { return; }
  if (m.t === 'input') { feedInput?.(m.input); return; }
  if (m.t !== 'matched') {
    if (m.t !== 'tick') console.log('spar-full: <-', m.t);
    return;
  }
  console.log('spar-full: matched, role', m.role, 'opponent', m.opponent?.address);
  // `serverNow` is the relay's clock at send time; the difference is the skew
  // both seats correct for so they agree on which tick it is.
  const offset = typeof m.serverNow === 'number' ? m.serverNow - Date.now() : 0;
  announceTicks(m.startAt, offset);
  console.log('spar-full: announcing ticks (offset', offset, 'ms)');
  if (joined) return;

  /*
   * Start our own simulation now, from the same seed and the same two decks.
   *
   * We are seat 1, so the opponent's relayed deck is seat 0's. Their deck
   * arrives in sim-ready form and `createMatch` derives each card's trait from
   * its mint, which is why neither side has to send one for the two states to
   * agree.
   */
  /*
   * Seat 0 or seat 1, because the browser has to be able to be either.
   *
   * This bailed on role 0 outright, so every run put the browser in seat 0 and
   * seat 1 was never exercised by a real client. That is not a neutral gap:
   * seat 1 turned out never to start the rollup at all, and nothing could have
   * caught it while only seat 0 was ever played. Taking role 0 here means
   * queueing this client *first* puts the browser in seat 1.
   */
  const iAmSeat0 = m.role === 0;
  const seats = iAmSeat0
    ? [kp.publicKey.toBase58(), m.opponent.address]
    : [m.opponent.address, kp.publicKey.toBase58()];
  feedInput = runSim({
    seed: m.seed,
    startAt: m.startAt,
    offset,
    format: m.format,
    seat0Deck: iAmSeat0 ? relayDeck : m.opponent.deck,
    seat1Deck: iAmSeat0 ? m.opponent.deck : relayDeck,
    seats,
  });

  if (iAmSeat0) {
    // Seat 0 opens the escrow and tells the other seat which match to join —
    // the same `stage: 'opened'` the browser client relays.
    try {
      const cfg = await program.account.config.fetch(configPda());
      const id = cfg.nextMatchId.toNumber();
      const sig = await program.methods
        .createMatch(0, new anchor.BN(50_000_000), Array.from(IGNORED_DECK_HASH))
        .accounts({
          config: configPda(),
          matchAccount: matchPda(id),
          player: kp.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(deckIds.map((cid) => ({ pubkey: cardPda(cid), isWritable: true, isSigner: false })))
        .rpc();
      joined = true;
      onchainMatchId = id;
      console.log(`spar-full: CREATED match #${id} — ${sig}`);
      ws.send(JSON.stringify({ t: 'chain', stage: 'opened', onchainMatchId: id }));
    } catch (e) {
      console.log('spar-full: create failed —', e.message?.slice(0, 160));
      ws.send(JSON.stringify({ t: 'chain', stage: 'failed', reason: String(e.message).slice(0, 80) }));
    }
    return;
  }

  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    let all;
    try {
      all = await program.account.matchAccount.all();
    } catch (e) {
      // devnet times out often enough that letting it throw here killed the
      // process — and the seat with it, freezing the browser mid-match.
      console.log('spar-full: rpc poll failed, retrying —', e.message?.slice(0, 70));
      continue;
    }
    const open = all
      .map((x) => ({
        id: x.account.id.toNumber(),
        state: x.account.state,
        players: x.account.players.map((p) => p.toBase58()),
      }))
      .filter((x) => x.state === 0 && x.players[0] === m.opponent.address)
      .sort((a, b) => b.id - a.id)[0];
    if (!open) { console.log('spar-full: waiting for their CreateMatch…'); continue; }
    try {
      const sig = await program.methods
        .joinMatch(Array.from(IGNORED_DECK_HASH))
        .accounts({
          config: configPda(),
          matchAccount: matchPda(open.id),
          player: kp.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(deckIds.map((id) => ({ pubkey: cardPda(id), isWritable: true, isSigner: false })))
        .rpc();
      joined = true;
      onchainMatchId = open.id;
      console.log(`spar-full: JOINED match #${open.id} — ${sig}`);
    } catch (e) {
      console.log('spar-full: join failed —', e.message?.slice(0, 160));
    }
    return;
  }
});

ws.on('close', () => console.log('spar-full: socket closed'));
ws.on('error', (e) => console.log('spar-full: ws error', e.message));

// Outlast regulation plus overtime so the browser never sees `opponent_left`.
setTimeout(() => { console.log('spar-full: holding done'); process.exit(0); }, HOLD_MS);
