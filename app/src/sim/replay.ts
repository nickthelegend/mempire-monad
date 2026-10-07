import { createMatch, hashState, stepSim } from './engine';
import { FORMATS, HASH_EVERY_TICKS, type Format, type InputEvent, type MatchCard, type SimState } from './types';

/*
 * Re-running a match from what the chain recorded, and proving it.
 *
 * The sim is deterministic integer lockstep: the same seed, decks and inputs
 * give the same state, tick for tick. During a staked match each seat posts a
 * state hash on chain every fourth hash tick (`MempireArena.checkpoint`). A
 * replay that recomputes those hashes and finds them equal is not a
 * reconstruction someone vouches for — it is the match, checked against the
 * chain by anyone. The first tick where they differ is reported, not hidden.
 *
 * This file is pure (no network, no DOM) so the same code runs in the app and
 * in the tests.
 */

export const CHECKPOINT_EVERY = HASH_EVERY_TICKS * 4;

export interface Checkpoint { tick: number; seat: number; hash: bigint }

export interface ReplayInput {
  seed: number;
  format: Format['id'];
  decks: [MatchCard[], MatchCard[]];
  inputs: InputEvent[];
}

export interface Verification {
  /** Distinct checkpoint ticks the recomputed state matched. */
  matched: number;
  /** Distinct checkpoint ticks on chain that the replay reached. */
  compared: number;
  /** First tick whose on-chain hash disagreed with the replay, or null. */
  divergedAt: number | null;
  /** The two seats posted different hashes for one tick (a void, on chain). */
  seatsDisagreeAt: number | null;
  finalTick: number;
  /** 0 or 1, -2 a draw, -1 undecided (ran out of recorded match). */
  winner: number;
}

/** Inputs grouped by the tick they apply at, as the live loop keeps them. */
export function inputsByTick(inputs: InputEvent[]): Map<number, InputEvent[]> {
  const m = new Map<number, InputEvent[]>();
  for (const ev of inputs) {
    const list = m.get(ev.tick) ?? [];
    list.push(ev);
    m.set(ev.tick, list);
  }
  return m;
}

export function newReplaySim(r: ReplayInput): SimState {
  return createMatch(r.seed >>> 0, r.decks, FORMATS[r.format] ?? FORMATS.standard);
}

/**
 * One tick, exactly as the live loop steps it (`stepOne` in state/match.ts):
 * the inputs keyed by the current tick, then the hash at checkpoint ticks.
 * Returns the state hash when this tick is a checkpoint tick.
 */
export function replayStep(sim: SimState, byTick: Map<number, InputEvent[]>): number | null {
  stepSim(sim, byTick.get(sim.tick) ?? []);
  return sim.tick % CHECKPOINT_EVERY === 0 ? hashState(sim) >>> 0 : null;
}

const MAX_TICKS = 20 * 60 * 10; // ten minutes — far beyond regulation plus overtime

/** Run the whole match headless and compare every on-chain checkpoint it reaches. */
export function verifyReplay(r: ReplayInput, checkpoints: Checkpoint[]): Verification {
  const byTick = inputsByTick(r.inputs);
  const expected = new Map<number, bigint>();
  let seatsDisagreeAt: number | null = null;
  for (const c of checkpoints) {
    const prior = expected.get(c.tick);
    if (prior !== undefined && prior !== c.hash && seatsDisagreeAt === null) seatsDisagreeAt = c.tick;
    if (prior === undefined) expected.set(c.tick, c.hash);
  }
  const sim = newReplaySim(r);
  let matched = 0;
  let compared = 0;
  let divergedAt: number | null = null;
  while (sim.phase !== 'ended' && sim.tick < MAX_TICKS) {
    const h = replayStep(sim, byTick);
    if (h === null) continue;
    const want = expected.get(sim.tick);
    if (want === undefined) continue;
    compared += 1;
    if (BigInt(h) === want) matched += 1;
    else if (divergedAt === null) divergedAt = sim.tick;
  }
  return {
    matched, compared, divergedAt, seatsDisagreeAt,
    finalTick: sim.tick,
    winner: sim.winner,
  };
}
