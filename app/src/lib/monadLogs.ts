import { decodeEventLog, toHex, type Address, type Hex } from 'viem';
import { ARENA_ABI } from '../chain/read';
import type { CommitState } from './monadHeads';

/*
 * One match's arena events, live, from Monad's `monadLogs` subscription.
 *
 * Unlike standard `logs`, `monadLogs` fires as soon as a block is Proposed and
 * again as it moves through consensus, each message tagged with its
 * `commitState` and `blockId`. A spectator therefore sees a play the moment it
 * is speculatively executed and can mark it final ~2 slots later.
 *
 * Monad networks only (anvil has no `monadLogs`); the local fork polls instead.
 */

export interface MonadLog {
  key: string; // txHash:logIndex
  eventName: string;
  args: Record<string, unknown>;
  commitState: CommitState;
  blockNumber: number;
}

export function subscribeMatchLogs(
  wsUrl: string, arena: Address, matchId: number,
  onLog: (l: MonadLog) => void, onStatus: (s: 'live' | 'closed') => void,
): () => void {
  const ws = new WebSocket(wsUrl);
  const topic = toHex(BigInt(matchId), { size: 32 });
  ws.onopen = () => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['monadLogs', { address: arena, topics: [null, topic] }] }));
    onStatus('live');
  };
  ws.onmessage = (e) => {
    let m: { params?: { result?: Record<string, unknown> } };
    try { m = JSON.parse(String(e.data)); } catch { return; }
    const r = m.params?.result;
    if (!r || !Array.isArray(r.topics)) return;
    try {
      const d = decodeEventLog({ abi: ARENA_ABI, data: r.data as Hex, topics: r.topics as [Hex, ...Hex[]] });
      onLog({
        key: `${r.transactionHash}:${r.logIndex}`,
        eventName: String(d.eventName),
        args: d.args as unknown as Record<string, unknown>,
        commitState: (r.commitState as CommitState) ?? 'Proposed',
        blockNumber: Number.parseInt(String(r.blockNumber ?? '0x0'), 16),
      });
    } catch { /* an event a spectator does not read */ }
  };
  ws.onclose = () => onStatus('closed');
  return () => { ws.onclose = null; ws.close(); };
}
