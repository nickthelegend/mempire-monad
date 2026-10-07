/**
 * Verifiable replay: a match re-run from its recorded inputs must reproduce
 * every checkpoint the seats would have posted on chain — and must say where a
 * tampered record stops matching.
 *
 *   npx tsx scripts/replay-test.ts
 */
import { createMatch, hashState, stepSim } from '../src/sim/engine';
import { archetypeForMint } from '../src/sim/archetypes';
import { decideBot } from '../src/sim/bot';
import { traitForMint } from '../src/sim/traits';
import { CHECKPOINT_EVERY, verifyReplay, type Checkpoint } from '../src/sim/replay';
import { FORMATS, type InputEvent, type MatchCard } from '../src/sim/types';
import roster from '../../shared/roster.json';

let fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const COINS: string[] = roster.coins.map((c: { feedId: string }) => c.feedId.toLowerCase());
const deck = (offset: number, levels: number[]): MatchCard[] => Array.from({ length: 8 }, (_, i) => {
  const mint = COINS[(i + offset) % COINS.length];
  return { coinId: mint, name: mint.slice(2, 8).toUpperCase(), archetype: archetypeForMint(mint), trait: traitForMint(mint), level: levels[i % levels.length], metaBps: (i % 3) * 400 - 400 };
});
/** What `MempireArena.play` stores: int16 coordinates (the play log clamps to them). */
const onChain = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)));

function record(seed: number, format: 'standard' | 'rush') {
  const decks: [MatchCard[], MatchCard[]] = [deck(0, [3, 5, 2, 8]), deck(4, [4, 4, 6, 3])];
  const state = createMatch(seed, decks, FORMATS[format]);
  const pending = new Map<number, InputEvent[]>();
  const inputs: InputEvent[] = [];
  const checkpoints: Checkpoint[] = [];
  while (state.phase !== 'ended' && state.tick < 20 * 60 * 10) {
    for (const player of [0, 1] as const) {
      const ev = decideBot(state, player, player === 0 ? 'normal' : 'hard');
      if (!ev) continue;
      // The live sim applies the client's own event; the chain keeps the int16 copy.
      const list = pending.get(ev.tick) ?? [];
      list.push(ev);
      pending.set(ev.tick, list);
      inputs.push({ ...ev, x: onChain(ev.x), y: onChain(ev.y) });
    }
    stepSim(state, pending.get(state.tick) ?? []);
    pending.delete(state.tick - 1);
    if (state.tick % CHECKPOINT_EVERY === 0) {
      const h = BigInt(hashState(state) >>> 0);
      checkpoints.push({ tick: state.tick, seat: 0, hash: h }, { tick: state.tick, seat: 1, hash: h });
    }
  }
  return { decks, inputs, checkpoints, winner: state.winner, ticks: state.tick };
}

for (const [seed, format] of [[1234567, 'standard'], [987654321, 'rush']] as const) {
  console.log(`\n${format} match, seed ${seed}`);
  const rec = record(seed, format);
  const v = verifyReplay({ seed, format, decks: rec.decks, inputs: rec.inputs }, rec.checkpoints);
  check(`recorded ${rec.inputs.length} plays and ${rec.checkpoints.length / 2} checkpoints`, rec.inputs.length > 5 && rec.checkpoints.length > 0);
  check('the replay matches every on-chain checkpoint', v.compared > 0 && v.matched === v.compared && v.divergedAt === null, `${v.matched}/${v.compared}`);
  check('it ends on the same tick with the same winner', v.finalTick === rec.ticks && v.winner === rec.winner, `tick ${v.finalTick}, winner ${v.winner}`);
  check('both seats agreed', v.seatsDisagreeAt === null);

  // One play moved two tiles: the record no longer matches the chain.
  const mid = Math.floor(rec.inputs.length / 2);
  const tampered = rec.inputs.map((e, i) => (i === mid ? { ...e, x: e.x + 2048 } : e));
  const t = verifyReplay({ seed, format, decks: rec.decks, inputs: tampered }, rec.checkpoints);
  check('a tampered play is caught at the first checkpoint after it', t.divergedAt !== null && t.divergedAt >= rec.inputs[mid].tick, `diverged at tick ${t.divergedAt}, play at ${rec.inputs[mid].tick}`);

  const wrongSeed = verifyReplay({ seed: seed + 1, format, decks: rec.decks, inputs: rec.inputs }, rec.checkpoints);
  check('the wrong seed does not verify', wrongSeed.divergedAt !== null);

  const forked = [...rec.checkpoints];
  forked[1] = { ...forked[1], hash: forked[1].hash ^ 1n };
  check('seats posting different hashes for one tick is reported', verifyReplay({ seed, format, decks: rec.decks, inputs: rec.inputs }, forked).seatsDisagreeAt === forked[1].tick);
}

console.log(fail ? `\n${fail} failed` : '\nREPLAY OK');
process.exit(fail ? 1 : 0);
