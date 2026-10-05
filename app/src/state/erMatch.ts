import { create } from 'zustand';
import { PublicKey } from '@solana/web3.js';
import type { Adapter } from '@solana/wallet-adapter-base';
import {
  checkpointEr, closeLogTx, closeSessionEr, delegateLogTx, endLogEr, fetchLog,
  initLogTx, openSessionEr, sealLogEr, unsealLogEr,
  matchLogPda, playCardEr, readableChainError,
} from '../chain/erActions';
import { createMatchTx } from '../chain/actions';
import { ensureChestRail } from '../chain/erActions';
import { IS_LOCALNET, resolveEr } from '../chain/magicblock';
import { canSign, getProvider } from '../chain/provider';
import { useChain } from './chain';
import { signer } from './wallet';

/**
 * The rollup side of a match.
 *
 * Wraps the ER lifecycle in a store so the battle screen can show what layer it
 * is on and the match store can fire plays without knowing about routers.
 *
 * Two properties matter more than throughput here:
 *
 * 1. **A rollup failure never blocks play.** Every ER write is fire-and-forget
 *    against the local simulation, which stays authoritative for what the player
 *    sees. The log is the onchain record; if a write fails the match continues
 *    and `pendingWrites` reports the gap honestly rather than freezing a battle
 *    over a network hiccup.
 * 2. **Nothing here moves money.** Settlement is a separate base-layer call that
 *    reads the committed log, so a stalled rollup degrades to `claim_timeout`.
 */

export type ErPhase =
  | 'off' // no wallet that can sign, or ER disabled
  | 'preparing' // creating + delegating the log
  | 'live' // delegated; plays are landing on the rollup
  | 'committing' // sealing and undelegating
  | 'committed' // log is home on base layer
  | 'degraded'; // rollup unreachable — sim continues, log is incomplete

interface ErMatchState {
  phase: ErPhase;
  matchId: number | null;
  logAddress: string | null;
  fqdn: string | null;
  /** Plays accepted by the rollup this match. */
  writes: number;
  /** Plays the rollup refused or dropped. Surfaced, never hidden. */
  /** Card plays that never reached the rollup. The serious one. */
  playsLost: number;
  /** State-hash checkpoints that did not land. Thins the audit trail; does
   *  not affect settlement, which reads the final hash. */
  marksLost: number;
  /**
   * True when the log is behind an ephemeral permission (PER).
   *
   * Reported rather than assumed: a match whose seal failed still plays, and
   * the badge must not claim a privacy property the match does not have.
   */
  sealed: boolean;
  /** True when a session key is signing rollup writes instead of the wallet. */
  sessioned: boolean;
  lastError: string | null;
  lastSignature: string | null;
  commitSignature: string | null;
  /** The two seats, kept so settlement can name the winner's chest rail. */
  seats: [string, string] | null;

  /** Base layer: create + delegate. Safe to call once per match. */
  begin: (
    adapter: Adapter | null, matchId: number, players: [string, string],
  ) => Promise<void>;
  /**
   * The whole onchain opening: escrow the stake in a real match, then put its
   * log on a rollup. Returns the onchain match id, or null when this session
   * cannot go onchain (guest wallet, program unreachable, deck not minted).
   */
  openOnchainMatch: (
    tier: number, stakeSol: number, deckCardIds: number[], deckHash: Uint8Array,
    opponent?: string,
  ) => Promise<number | null>;
  /** ER: record one play. Never throws — a battle must not stall on a rollup. */
  play: (
    adapter: Adapter | null, tick: number, deckIndex: number, x: number, y: number,
  ) => Promise<void>;
  /** ER: record a state-hash checkpoint. Never throws. */
  mark: (adapter: Adapter | null, tick: number, hash: bigint) => Promise<void>;
  /** ER: seal and undelegate, then report whether the log made it home. */
  finish: (adapter: Adapter | null, winner: number, finalHash: bigint) => Promise<boolean>;
  /**
   * Base layer: reads the committed log back off Solana.
   *
   * Settlement itself stays in the `mempire` program — the rollup program owns no
   * lamports and has no transfer path, which is exactly why a delegated log can
   * never strand a pot. This is the record settlement is verified against.
   */
  readCommitted: (matchId: number) => Promise<Awaited<ReturnType<typeof fetchLog>>>;
  /** Base layer: reclaim the log's rent once sealed. Never blocks the UI. */
  cleanup: (adapter: Adapter | null) => Promise<void>;
  reset: () => void;
}

export const useErMatch = create<ErMatchState>((set, get) => ({
  phase: 'off',
  matchId: null,
  logAddress: null,
  fqdn: null,
  writes: 0,
  playsLost: 0,
  marksLost: 0,
  sealed: false,
  sessioned: false,
  lastError: null,
  lastSignature: null,
  commitSignature: null,
  seats: null,

  begin: async (adapter, matchId, players) => {
    if (!canSign(adapter)) { set({ phase: 'off' }); return; }
    set({
      phase: 'preparing', matchId, writes: 0, playsLost: 0, marksLost: 0, sealed: false, sessioned: false,
      lastError: null, commitSignature: null, seats: players,
      logAddress: matchLogPda(matchId).toBase58(),
    });
    try {
      /*
       * Either seat may arrive here, and only one of them can create the log.
       *
       * This ran `initLogTx` then `delegateLogTx` unconditionally, which is
       * correct for exactly one caller — so only seat 0 was ever wired to call
       * it, and seat 1 never reached `phase: 'live'`. `play` returns early
       * unless the phase is live, so every card seat 1 dropped was silently
       * absent from the on-chain log. The log that exists to make the match
       * "genuinely onchain rather than relayed by a server we happen to
       * operate" held one side of every human match.
       *
       * Both seats call this now, so the work has to be idempotent. The state
       * is the authority, not the error string: if the log is already on a
       * rollup there is nothing to create, and losing the race to create it is
       * the outcome we wanted anyway.
       */
      let placed = await resolveEr(matchLogPda(matchId)).catch(() => null);
      if (!placed) {
        try {
          await initLogTx(adapter, matchId, players);
        } catch (e) {
          // Someone else created it in the meantime, or it already existed.
          // Anything else is a real failure and belongs in the catch below.
          const exists = await fetchLog(matchId).catch(() => null);
          if (!exists) throw e;
        }
        try {
          await delegateLogTx(adapter, matchId, IS_LOCALNET);
        } catch (e) {
          placed = await resolveEr(matchLogPda(matchId)).catch(() => null);
          if (!placed) throw e;
        }
      }

      // Create and delegate this wallet's chest rail now rather than after the
      // win. `end_log` credits the entitlement on the rollup, where it can see
      // both the log and the rail in one transaction, and that is only true
      // while the match is still delegated — a rail created afterwards has
      // missed its moment. Non-fatal: settlement does not depend on it.
      void ensureChestRail(adapter).catch(() => { /* chest is granted next win */ });
      // Placement is the router's call — confirm it before claiming 'live'.
      const er = placed ?? await resolveEr(matchLogPda(matchId));
      if (!er) throw new Error('router did not place the log on a rollup');

      // Seal the log to its two seats (PER) before the first card can be
      // played. Non-fatal on purpose: a rollup that will not take the
      // permission still runs a perfectly good match, and refusing to start
      // over privacy would trade a working game for a property nobody asked
      // for mid-match. `sealed` is reported so the badge can say which it is
      // rather than claiming privacy the match does not have.
      let sealed = false;
      try {
        await sealLogEr(adapter, matchId);
        sealed = true;
      } catch (e) {
        set({ lastError: readableChainError(e) });
      }
      // Authorise a session key before the first card can be played. One
      // popup here replaces one per card drop and per checkpoint for the rest
      // of the match. Non-fatal: a match without a session still plays, it just
      // prompts — losing the match over a UX optimisation is the wrong trade.
      const sessioned = await openSessionEr(adapter, matchId);
      set({ phase: 'live', fqdn: er.fqdn, sealed, sessioned });
    } catch (e) {
      // The match is already playable; the rollup is the optional half.
      //
      // Say why, though. `playsLost` and `marksLost` both warn when a single
      // write fails, but the rollup failing to start at all — which loses
      // every write — only set a state field the badge does not render. A
      // player and a developer both saw "ROLLUP DOWN" and no reason anywhere.
      console.warn('[rollup] could not start:', e);
      set({ phase: 'degraded', lastError: readableChainError(e) });
    }
  },

  /**
   * Escrow onchain, then delegate the log.
   *
   * Ordered deliberately: the stake must be committed on base layer *before* the
   * rollup is involved, so a rollup that never comes up leaves a normal onchain
   * match that `claim_timeout` can resolve — never a delegated log guarding a
   * pot nobody can reach.
   */
  openOnchainMatch: async (tier, stakeSol, deckCardIds, deckHash, opponent) => {
    const adapter = signer();
    // Guest has an address but no keypair; simulated play is the honest fallback.
    if (!canSign(adapter) || useChain.getState().mode !== 'onchain') { set({ phase: 'off' }); return null; }
    if (deckCardIds.length !== 8) { set({ phase: 'off' }); return null; }

    try {
      const { matchId } = await createMatchTx(adapter, tier, stakeSol, deckCardIds, deckHash);
      // Both seats are captured on base layer so the rollup can enforce them.
      // Seat 1 is filled when the opponent joins; until then both are this player,
      // which the program rejects — so the second seat is the opponent's address
      // when known and this player's otherwise (solo/bot play stays local).
      // A guest signs with no adapter, so its key comes from the provider —
      // the same place the signature does.
      const me = (adapter?.publicKey ?? getProvider(adapter).wallet.publicKey)!.toBase58();
      await get().begin(adapter, matchId, [me, opponent ?? me]);
      void useChain.getState().refresh();
      return matchId;
    } catch (e) {
      // Escrow failed, so there is nothing onchain to clean up. Play locally.
      set({ phase: 'off', lastError: readableChainError(e) });
      return null;
    }
  },

  play: async (adapter, tick, deckIndex, x, y) => {
    const { phase, matchId } = get();
    if (phase !== 'live' || matchId === null || !canSign(adapter)) return;
    try {
      const { signature } = await playCardEr(adapter, matchId, tick, deckIndex, x, y);
      set((s) => ({ writes: s.writes + 1, lastSignature: signature }));
    } catch (e) {
      /*
       * Say why, out loud.
       *
       * The badge counts lost plays and the store kept the reason — and nothing
       * ever read it, so a play that failed to reach the rollup was a number
       * with no explanation anywhere. That is the whole reason this went
       * un-diagnosed: the information existed and had no way out.
       */
      const why = readableChainError(e);
      console.warn(`[er] play lost at tick ${tick}: ${why}`);
      set((s) => ({ playsLost: s.playsLost + 1, lastError: why }));
    }
  },

  mark: async (adapter, tick, hash) => {
    const { phase, matchId } = get();
    if (phase !== 'live' || matchId === null || !canSign(adapter)) return;
    try {
      const { signature } = await checkpointEr(adapter, matchId, tick, hash);
      set({ lastSignature: signature });
    } catch (e) {
      const why = readableChainError(e);
      console.warn(`[er] checkpoint lost at tick ${tick}: ${why}`);
      set((s) => ({ marksLost: s.marksLost + 1, lastError: why }));
    }
  },

  finish: async (adapter, winner, finalHash) => {
    const { phase, matchId } = get();
    if (phase !== 'live' || matchId === null || !canSign(adapter)) return false;
    set({ phase: 'committing' });
    try {
      // Close the seal first — it is ER-local, so once the log leaves the
      // rollup nothing can reach it. Swallowed deliberately: settlement must
      // never fail because a permission would not close.
      // Revoke the session before the log leaves the rollup. Expiry would
      // handle it, but a finished match should not leave a usable key behind
      // for a quarter of an hour.
      if (get().sessioned) {
        await closeSessionEr(adapter, matchId);
        set({ sessioned: false });
      }
      if (get().sealed) {
        try { await unsealLogEr(adapter, matchId); } catch { /* rent stays behind */ }
        set({ sealed: false });
      }
      // The winner's chest rail, so the win actually pays out an entitlement.
      // `end_log` treats it as optional and skips the grant when it is absent,
      // so a wallet whose rail does not exist yet still settles normally.
      const seats = get().seats;
      const winnerAddress =
        winner < 2 && seats ? new PublicKey(seats[winner]) : undefined;
      const r = await endLogEr(adapter, matchId, winner, finalHash, winnerAddress);
      // 'committed' means the log is readable on base layer — the only state in
      // which settle_from_log can succeed.
      set({
        phase: r.undelegated ? 'committed' : 'degraded',
        commitSignature: r.commitSignature,
        lastSignature: r.signature,
      });
      return r.undelegated;
    } catch (e) {
      set({ phase: 'degraded', lastError: readableChainError(e) });
      return false;
    }
  },

  readCommitted: async (matchId) => fetchLog(matchId),

  cleanup: async (adapter) => {
    const { phase, matchId } = get();
    if (phase !== 'committed' || matchId === null || !canSign(adapter)) return;
    try {
      /*
       * Only the seat that paid can reclaim it, so only that seat should ask.
       *
       * `close_log` refunds the account's whole balance to its funder now
       * rather than to whoever calls first. Both seats reach `committed` and
       * both run this, so without the check the non-funder sends a
       * transaction that is certain to be refused and pays the fee for it.
       */
      const log = await fetchLog(matchId);
      const me = (adapter?.publicKey ?? getProvider(adapter).wallet.publicKey)?.toBase58();
      if (log?.funder && me && log.funder !== me) return;
      await closeLogTx(adapter, matchId);
    } catch {
      // Rent recovery is best-effort; the log is harmless if it lingers.
    }
  },

  reset: () => set({
    phase: 'off', matchId: null, logAddress: null, fqdn: null,
    writes: 0, playsLost: 0, marksLost: 0, lastError: null, lastSignature: null, commitSignature: null,
  }),
}));
