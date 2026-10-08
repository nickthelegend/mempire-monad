import { decodeEventLog, toHex, type Address, type Log } from 'viem';
import { ARENA_ABI, CARDS_ABI } from '../chain/read';
import { DEPLOYMENT, publicClient } from '../chain/provider';
import { IS_MONAD_NETWORK } from '../chain/landing';
import { COINS } from './coins';
import { apiFetch } from './api';
import { modifiersAt, withMeta } from '../state/match';
import type { Checkpoint, ReplayInput } from '../sim/replay';
import type { InputEvent, MatchCard } from '../sim/types';

/*
 * Everything a replay needs, gathered from the chain — plus the two fields the
 * chain does not hold (the matchmaker's seed and the decks as the sims got
 * them), fetched from the relay and then *checked* against the chain:
 *  - each deck's card ids must equal the ids the arena locked for that seat,
 *    card for card, and each card's coin and archetype must match;
 *  - each deck's levels must sum to the power the arena recorded at join.
 * Plays and checkpoints come straight from the arena's `Played` and
 * `Checkpoint` events. The replay is then verified by the sim (sim/replay.ts).
 */

export interface ReplayBundle extends ReplayInput {
  matchId: number;
  checkpoints: Checkpoint[];
  seats: [Address, Address];
  metaEpoch: number;
  chainWinner: number;
  settled: boolean;
  checks: { deckIds: boolean; archetypes: boolean; power: boolean; detail: string[] };
  blocks: [number, number];
  /** Wall-clock ms both seats counted down to (tick 0), for live spectating. */
  startAt: number | null;
}

interface MatchView {
  p0: Address; p1: Address; state: number; winner: number; metaEpoch: bigint; createdAt: bigint; deadline: bigint;
}

async function blockAtOrAfter(ts: number, lo: number, hi: number): Promise<number> {
  const client = publicClient();
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await client.getBlock({ blockNumber: BigInt(mid) });
    if (Number(b.timestamp) < ts) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Every arena log for one match id, in block order, scanning in RPC-sized windows. */
type ArenaLog = Log & { eventName: string; args: Record<string, unknown> };
const toInput = (l: ArenaLog): InputEvent => ({
  tick: Number(l.args.tick), player: Number(l.args.seat) as 0 | 1, deckIndex: Number(l.args.cardIndex),
  x: Number(l.args.x), y: Number(l.args.y),
});
const toCheckpoint = (l: ArenaLog): Checkpoint => ({ tick: Number(l.args.tick), seat: Number(l.args.seat), hash: BigInt(l.args.stateHash as bigint) });

async function matchLogs(matchId: number, from: number, until: (logs: { eventName: string }[]) => boolean): Promise<{ logs: (Log & { eventName: string; args: Record<string, unknown> })[]; to: number }> {
  const client = publicClient();
  const latest = Number(await client.getBlockNumber());
  // Monad's public RPC caps eth_getLogs at 100 blocks; the local fork does not.
  const step = IS_MONAD_NETWORK ? 100 : 5000;
  const topic = toHex(BigInt(matchId), { size: 32 });
  const out: (Log & { eventName: string; args: Record<string, unknown> })[] = [];
  let at = from;
  while (at <= latest) {
    const to = Math.min(latest, at + step - 1);
    const raw = await client.getLogs({
      address: DEPLOYMENT!.arena, fromBlock: BigInt(at), toBlock: BigInt(to),
      // topic 1 is the indexed matchId on every arena event this needs
      ...({ topics: [null, topic] } as object),
    } as Parameters<typeof client.getLogs>[0]);
    for (const l of raw) {
      try {
        const d = decodeEventLog({ abi: ARENA_ABI, data: l.data, topics: l.topics });
        out.push({ ...l, eventName: String(d.eventName), args: d.args as unknown as Record<string, unknown> });
      } catch { /* an event this replay does not read */ }
    }
    at = to + 1;
    if (until(out)) return { logs: out, to };
  }
  return { logs: out, to: latest };
}

export async function loadReplay(matchId: number): Promise<ReplayBundle> {
  if (!DEPLOYMENT) throw new Error('no deployment for this chain');
  const client = publicClient();

  const res = await apiFetch(`/api/replay/${matchId}`);
  if (!res?.ok) throw new Error(res?.status === 404 ? 'the relay has no replay record for this match (it predates replays, or was not a relayed staked match)' : 'the relay is unreachable');
  const rec = await res.json() as { seed: number; format: 'standard' | 'rush'; startAt: number | null; decks: [MatchCard[] | null, MatchCard[] | null] };
  if (!rec.decks?.[0] || !rec.decks?.[1]) throw new Error('the replay record is missing a deck');

  const m = await client.readContract({ address: DEPLOYMENT.arena, abi: ARENA_ABI, functionName: 'getMatch', args: [BigInt(matchId)] }) as unknown as MatchView;
  if (Number(m.state) === 0) throw new Error(`match #${matchId} does not exist on this chain`);

  const latest = Number(await client.getBlockNumber());
  const start = await blockAtOrAfter(Number(m.createdAt), DEPLOYMENT.startBlock ?? 0, latest);
  const { logs, to } = await matchLogs(matchId, Math.max(DEPLOYMENT.startBlock ?? 0, start - 2), (ls) => ls.some((l) => l.eventName === 'MatchSettled' || l.eventName === 'MatchVoided'));

  const created = logs.find((l) => l.eventName === 'MatchCreated');
  const joined = logs.find((l) => l.eventName === 'MatchJoined');
  if (!created || !joined) throw new Error('the match was never joined, so there is nothing to replay');
  const ids = [created.args.cardIds as bigint[], joined.args.cardIds as bigint[]] as const;
  const powers = [Number(created.args.power), Number(joined.args.power)];

  // Check the relay's decks against the chain.
  const detail: string[] = [];
  let deckIds = true; let archetypes = true; let power = true;
  for (const seat of [0, 1] as const) {
    const deck = rec.decks[seat]!;
    const onchain = await Promise.all(ids[seat].map((id) => client.readContract({ address: DEPLOYMENT!.cards, abi: CARDS_ABI, functionName: 'card', args: [id] }) as Promise<{ coinId: number; archetype: number }>));
    onchain.forEach((c, i) => {
      const coin = COINS.find((k) => k.coinId === Number(c.coinId));
      if (!coin || deck[i]?.coinId?.toLowerCase() !== coin.mint) { deckIds = false; detail.push(`seat ${seat} card ${i + 1}: relay ${deck[i]?.name ?? '—'} vs chain ${coin?.ticker ?? c.coinId}`); }
      if (Number(deck[i]?.archetype) !== Number(c.archetype)) { archetypes = false; detail.push(`seat ${seat} card ${i + 1}: archetype differs`); }
    });
    const sum = deck.reduce((a, c) => a + Number(c.level), 0);
    if (sum !== powers[seat]) { power = false; detail.push(`seat ${seat}: levels sum ${sum}, arena recorded ${powers[seat]}`); }
  }

  const epoch = Number(m.metaEpoch);
  const bps = await modifiersAt(epoch).catch(() => new Map<number, number>());
  const decks: [MatchCard[], MatchCard[]] = [withMeta(rec.decks[0]!, bps), withMeta(rec.decks[1]!, bps)];

  const inputs: InputEvent[] = logs.filter((l) => l.eventName === 'Played').map(toInput);
  const checkpoints: Checkpoint[] = logs.filter((l) => l.eventName === 'Checkpoint').map(toCheckpoint);

  return {
    matchId, seed: rec.seed, format: rec.format, decks, inputs, checkpoints,
    seats: [m.p0, m.p1], metaEpoch: epoch, chainWinner: Number(m.winner), settled: Number(m.state) === 3,
    checks: { deckIds, archetypes, power, detail },
    blocks: [start, to],
    startAt: rec.startAt ?? null,
  };
}

/**
 * For a match still being played: the plays and checkpoints that have landed
 * since `bundle` was read, from the block after the last one scanned.
 */
export async function pollReplay(bundle: ReplayBundle): Promise<{ inputs: InputEvent[]; checkpoints: Checkpoint[]; settled: boolean; to: number }> {
  const { logs, to } = await matchLogs(bundle.matchId, bundle.blocks[1] + 1, () => false);
  return {
    inputs: logs.filter((l) => l.eventName === 'Played').map(toInput),
    checkpoints: logs.filter((l) => l.eventName === 'Checkpoint').map(toCheckpoint),
    settled: logs.some((l) => l.eventName === 'MatchSettled' || l.eventName === 'MatchVoided'),
    to,
  };
}
