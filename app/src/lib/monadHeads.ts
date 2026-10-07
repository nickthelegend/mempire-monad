import { create } from 'zustand';

/*
 * Monad's block pipeline, live, from Monad testnet's own WebSocket.
 *
 * `eth_subscribe monadNewHeads` sends the same block more than once as it
 * moves through consensus: Proposed (speculatively executed), Voted (one slot
 * later), Finalized (two slots, irreversible) and Verified (state root agreed,
 * three blocks after that). Each message carries a `blockId` naming one
 * proposal, since two proposals can share a height, and a `commitState`.
 *
 * This is a read-only subscription to the public network, so it is real
 * whatever chain the game itself is pointed at — and it is labelled as the
 * network's heartbeat, never as this app's transactions. The milliseconds are
 * measured here, from the first message for a block, not quoted from docs.
 *
 * Rules from the spec the reducer codes against:
 *  - a block can skip Voted and go straight from Proposed to Finalized;
 *  - there is no abandonment message: once height N finalizes, every other
 *    `blockId` seen at N is dead and is dropped here;
 *  - states only move forward.
 */

export type CommitState = 'Proposed' | 'Voted' | 'Finalized' | 'Verified';
const RANK: Record<CommitState, number> = { Proposed: 0, Voted: 1, Finalized: 2, Verified: 3 };

export interface HeadMsg {
  blockId: string;
  number: number;
  hash: string;
  commitState: CommitState;
}

export interface BlockChip {
  blockId: string;
  number: number;
  hash: string;
  state: CommitState;
  /** When this client first heard of the block. */
  seenAt: number;
  /** False when the first message we saw was already past Proposed (joined mid-flight): no honest timing. */
  timed: boolean;
  votedMs?: number;
  finalizedMs?: number;
  verifiedMs?: number;
}

/** Pure: fold one subscription message into the chip list (newest first, at most `keep`). */
export function reduceHead(chips: BlockChip[], msg: HeadMsg, now: number, keep = 8): BlockChip[] {
  if (!(msg.commitState in RANK)) return chips;
  let next = chips.slice();
  const i = next.findIndex((c) => c.blockId === msg.blockId);
  if (i === -1) {
    // A competing proposal at a height that already finalized is dead on arrival.
    if (next.some((c) => c.number === msg.number && RANK[c.state] >= RANK.Finalized)) return chips;
    next.push({
      blockId: msg.blockId, number: msg.number, hash: msg.hash, state: msg.commitState,
      seenAt: now, timed: msg.commitState === 'Proposed',
    });
  } else {
    const c = { ...next[i] };
    if (RANK[msg.commitState] <= RANK[c.state]) return chips; // stale or repeated
    const ms = Math.round(now - c.seenAt);
    c.state = msg.commitState;
    c.hash = msg.hash || c.hash;
    if (c.timed) {
      // A skipped Voted is left unset rather than invented.
      if (msg.commitState === 'Voted') c.votedMs = ms;
      if (msg.commitState === 'Finalized') c.finalizedMs = ms;
      if (msg.commitState === 'Verified') c.verifiedMs = ms;
    }
    next[i] = c;
  }
  if (msg.commitState === 'Finalized' || msg.commitState === 'Verified') {
    next = next.filter((c) => c.number !== msg.number || c.blockId === msg.blockId);
  }
  next.sort((a, b) => b.number - a.number || a.seenAt - b.seenAt);
  return next.slice(0, keep);
}

/** Median of the measured delays across the chips that have one. */
export function medianMs(chips: BlockChip[], key: 'votedMs' | 'finalizedMs' | 'verifiedMs'): number | null {
  const v = chips.map((c) => c[key]).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return Math.round(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2);
}

/** Parse one `eth_subscription` frame; null for anything that is not a head. */
export function parseHeadFrame(raw: string): HeadMsg | null {
  let m: { params?: { result?: Record<string, unknown> } };
  try { m = JSON.parse(raw); } catch { return null; }
  const r = m.params?.result;
  if (!r || typeof r.blockId !== 'string' || typeof r.commitState !== 'string' || typeof r.number !== 'string') return null;
  return { blockId: r.blockId, number: Number.parseInt(r.number, 16), hash: String(r.hash ?? ''), commitState: r.commitState as CommitState };
}

// ── the live store ────────────────────────────────────────────────────────

export const MONAD_WS = (import.meta.env?.VITE_MONAD_WS as string | undefined) ?? 'wss://testnet-rpc.monad.xyz';
type Status = 'idle' | 'connecting' | 'live' | 'unavailable';

interface HeadsState {
  chips: BlockChip[];
  status: Status;
  /** Longer history for the medians than the strip shows. */
  history: BlockChip[];
  retain: () => () => void;
}

let ws: WebSocket | null = null;
let users = 0;
let retryMs = 1000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

export const useMonadHeads = create<HeadsState>((set, get) => {
  const open = () => {
    if (typeof WebSocket === 'undefined') { set({ status: 'unavailable' }); return; }
    set({ status: 'connecting' });
    const sock = new WebSocket(MONAD_WS);
    ws = sock;
    sock.onopen = () => {
      sock.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['monadNewHeads'] }));
    };
    sock.onmessage = (e) => {
      const h = parseHeadFrame(String(e.data));
      if (!h) return;
      // Timestamped on arrival: the ms are measured, never estimated.
      const now = performance.now();
      const { chips, history } = get();
      set({
        chips: reduceHead(chips, h, now, 8),
        history: reduceHead(history, h, now, 40),
        ...(get().status !== 'live' ? { status: 'live' as const } : {}),
      });
      retryMs = 1000;
    };
    sock.onerror = () => { /* onclose follows */ };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      if (users === 0) { set({ status: 'idle' }); return; }
      set({ status: 'unavailable' });
      retryTimer = setTimeout(() => { retryTimer = null; if (users > 0) open(); }, retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    };
  };

  return {
    chips: [],
    history: [],
    status: 'idle',
    /** Reference-counted: the socket lives while any component shows the strip. */
    retain: () => {
      users += 1;
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
      if (users === 1 && !ws && !retryTimer) open();
      return () => {
        users -= 1;
        if (users > 0) return;
        // A short grace period: a remount (route change, React's dev double
        // mount) reuses the socket instead of tearing it down mid-handshake.
        closeTimer = setTimeout(() => {
          closeTimer = null;
          if (users > 0) return;
          if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
          const sock = ws; ws = null;
          if (sock?.readyState === WebSocket.CONNECTING) sock.onopen = () => sock.close();
          else sock?.close();
          set({ status: 'idle' });
        }, 3000);
      };
    },
  };
});
