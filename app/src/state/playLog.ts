import { create } from 'zustand';
import type { Hash } from 'viem';
import { checkpointTx, playTx, readableChainError } from '../chain/actions';
import { publicClient } from '../chain/provider';
import { CLAIM_RESERVE_WEI, sessionFor } from '../chain/session';
import { IS_MONAD_NETWORK, txpoolStatus, waitFinal } from '../chain/landing';

/*
 * The match, written to Monad while it is played.
 *
 * Every card drop is a transaction from the seat's session key to
 * `MempireArena.play`, sent the moment the card leaves the player's hand and
 * never awaited by the battle. Monad's 300 ms blocks mean it is usually in a
 * block before the unit has crossed the bridge; the badge shows how long that
 * actually took, measured from send to receipt, because "fast" is a claim and a
 * number is evidence. On Monad it shows a second number, send → Finalized.
 *
 * State-hash checkpoints go on chain every 20 seconds of play. They state the
 * past and never move the play cursor, so a slow checkpoint can never make a
 * later card look out of order.
 *
 * Gas comes from the float the stake transaction forwarded to the session key,
 * priced at the chain's own gas price when the match begins. Logging stops
 * short of the claim reserve, so the seat can always afford to record its
 * result, and checkpoints stop well before plays do: a play is the record of
 * the match, a checkpoint only bounds a divergence the relay also watches.
 * Plays that still don't fit are counted as unlogged, never hidden.
 */

export type LogPhase = 'off' | 'live' | 'done';

/**
 * One card play's journey to the chain. `final` exists only on Monad itself:
 * on the local fork every block is final when mined, so a play there stops at
 * `executed` and the UI says so.
 */
export interface PlayRecord {
  id: number;
  tick: number;
  deckIndex: number;
  state: 'sent' | 'executed' | 'final' | 'failed';
  hash?: Hash;
  /** Monad `txpool_statusByHash` before inclusion, when available. */
  pool?: string;
  executedMs?: number;
  finalMs?: number;
}

/** A typical play's gas limit (estimate × 1.15). */
const PLAY_GAS = 45_000n;
/** If the gas price can't be read, assume a little over testnet's 100 gwei floor. */
const FALLBACK_GAS_PRICE = 110_000_000_000n;
/** Checkpoints stop while this many plays' worth of budget is left. */
const PLAYS_KEPT_FOR = 8n;

interface PlayLogState {
  phase: LogPhase;
  matchId: number | null;
  sent: number;
  confirmed: number;
  playsLost: number;
  marksLost: number;
  lastHash: Hash | null;
  /** Send → receipt, in ms, for the most recent confirmed play. */
  lastLatencyMs: number | null;
  avgLatencyMs: number | null;
  /** Send → Finalized, Monad networks only. */
  lastFinalMs: number | null;
  avgFinalMs: number | null;
  /** The match's plays, newest last (capped). */
  plays: PlayRecord[];
  budgetWei: bigint;
  /** One logged transaction's cost at this match's gas price. */
  costWei: bigint;

  begin: (matchId: number) => Promise<void>;
  play: (tick: number, deckIndex: number, x: number, y: number) => void;
  mark: (tick: number, stateHash: bigint) => void;
  end: () => void;
  reset: () => void;
}

/** Coordinates are fixed-point in the sim; the log stores them as int16. */
const clamp16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)));

let nextPlayId = 1;

export const usePlayLog = create<PlayLogState>((set, get) => {
  const patch = (id: number, p: Partial<PlayRecord>) =>
    set((s) => ({ plays: s.plays.map((r) => (r.id === id ? { ...r, ...p } : r)) }));

  const watch = (hash: Hash, startedAt: number, perfStart: number, id: number) => {
    void publicClient().waitForTransactionReceipt({ hash, pollingInterval: 100, timeout: 30_000 })
      .then((r) => {
        if (r.status !== 'success') {
          set((s) => ({ playsLost: s.playsLost + 1 }));
          patch(id, { state: 'failed' });
          return;
        }
        const ms = Date.now() - startedAt;
        patch(id, { state: 'executed', executedMs: ms });
        set((s) => {
          const n = s.confirmed + 1;
          return {
            confirmed: n,
            lastHash: hash,
            lastLatencyMs: ms,
            avgLatencyMs: s.avgLatencyMs === null ? ms : Math.round((s.avgLatencyMs * (n - 1) + ms) / n),
          };
        });
        // The second timer: Monad finality, checked against the finalized block.
        if (IS_MONAD_NETWORK) {
          void waitFinal(r.blockNumber, r.blockHash, perfStart).then((fin) => {
            if (fin === null) return;
            patch(id, { state: 'final', finalMs: fin });
            set((s) => {
              const finals = s.plays.filter((x) => typeof x.finalMs === 'number').map((x) => x.finalMs!);
              return { lastFinalMs: fin, avgFinalMs: Math.round(finals.reduce((a, b) => a + b, 0) / Math.max(1, finals.length)) };
            });
          });
        }
      })
      .catch(() => {
        set((s) => ({ playsLost: s.playsLost + 1 }));
        patch(id, { state: 'failed' });
      });
  };

  return {
    phase: 'off',
    matchId: null,
    sent: 0,
    confirmed: 0,
    playsLost: 0,
    marksLost: 0,
    lastHash: null,
    lastLatencyMs: null,
    avgLatencyMs: null,
    lastFinalMs: null,
    avgFinalMs: null,
    plays: [],
    budgetWei: 0n,
    costWei: PLAY_GAS * FALLBACK_GAS_PRICE,

    begin: async (matchId) => {
      const session = sessionFor(matchId);
      if (!session) { set({ phase: 'off' }); return; }
      // A Privy session signer's calls are sponsored: there is no float to ration.
      const [balance, gasPrice] = await Promise.all([
        session.kind === 'privy'
          ? Promise.resolve(10n ** 24n)
          : publicClient().getBalance({ address: session.address }).catch(() => 0n),
        publicClient().getGasPrice().catch(() => FALLBACK_GAS_PRICE),
      ]);
      // 10% over the quoted price, as the sender pads it.
      const costWei = PLAY_GAS * ((gasPrice * 11n) / 10n);
      set({
        phase: 'live', matchId, sent: 0, confirmed: 0, playsLost: 0, marksLost: 0,
        lastHash: null, lastLatencyMs: null, avgLatencyMs: null, lastFinalMs: null, avgFinalMs: null, plays: [], costWei,
        budgetWei: balance > CLAIM_RESERVE_WEI ? balance - CLAIM_RESERVE_WEI : 0n,
      });
    },

    play: (tick, deckIndex, x, y) => {
      const { phase, matchId, budgetWei, costWei } = get();
      if (phase !== 'live' || matchId === null) return;
      const session = sessionFor(matchId);
      if (!session || budgetWei < costWei) {
        set((s) => ({ playsLost: s.playsLost + 1 }));
        return;
      }
      const id = nextPlayId++;
      set((s) => ({
        sent: s.sent + 1,
        budgetWei: s.budgetWei - costWei,
        plays: [...s.plays, { id, tick, deckIndex, state: 'sent' as const }].slice(-40),
      }));
      const startedAt = Date.now();
      const perfStart = performance.now();
      playTx(session, matchId, tick, deckIndex, clamp16(x), clamp16(y))
        .then((hash) => {
          patch(id, { hash });
          void txpoolStatus(hash).then((pool) => { if (pool) patch(id, { pool }); });
          watch(hash, startedAt, perfStart, id);
        })
        .catch((e) => {
          console.warn(`[log] play at tick ${tick} not sent: ${readableChainError(e)}`);
          set((s) => ({ playsLost: s.playsLost + 1 }));
          patch(id, { state: 'failed' });
        });
    },

    mark: (tick, stateHash) => {
      const { phase, matchId, budgetWei, costWei } = get();
      if (phase !== 'live' || matchId === null) return;
      const session = sessionFor(matchId);
      // Never spend what the remaining plays need on a checkpoint.
      if (!session || budgetWei < costWei * (PLAYS_KEPT_FOR + 1n)) return;
      set((s) => ({ budgetWei: s.budgetWei - costWei }));
      checkpointTx(session, matchId, tick, stateHash)
        .catch(() => set((s) => ({ marksLost: s.marksLost + 1 })));
    },

    end: () => { if (get().phase === 'live') set({ phase: 'done' }); },

    reset: () => set({
      phase: 'off', matchId: null, sent: 0, confirmed: 0, playsLost: 0, marksLost: 0,
      lastHash: null, lastLatencyMs: null, avgLatencyMs: null, budgetWei: 0n,
      lastFinalMs: null, avgFinalMs: null, plays: [],
      costWei: PLAY_GAS * FALLBACK_GAS_PRICE,
    }),
  };
});
