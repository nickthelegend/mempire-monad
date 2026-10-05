import { FP } from './fixed';
import { Archetype, TICKS_PER_SEC } from './types';

export interface ArchetypeDef {
  hp: number; // level-1 hit points
  damage: number; // per hit (spell: total)
  hitTicks: number; // ticks between hits
  rangeFP: number; // attack range, fp tiles
  aggroFP: number; // sight range for unit targets
  speedFP: number; // fp tiles per tick
  elixir: number; // cost, whole elixir
  count: number; // units spawned per play
  splashFP: number; // splash radius (0 = single target)
  spellDelayTicks: number; // spell only
  auraFP: number; // support only: attack-speed aura radius
}

const tilesPerSec = (t: number) => Math.floor((t * FP) / TICKS_PER_SEC);

export const ARCHETYPES: Record<Archetype, ArchetypeDef> = {
  [Archetype.Tank]: {
    hp: 1400, damage: 150, hitTicks: 30, rangeFP: Math.floor(1.2 * FP),
    aggroFP: Math.floor(5.5 * FP), speedFP: tilesPerSec(0.9), elixir: 4,
    count: 1, splashFP: 0, spellDelayTicks: 0, auraFP: 0,
  },
  [Archetype.Swarm]: {
    hp: 190, damage: 45, hitTicks: 22, rangeFP: Math.floor(0.9 * FP),
    aggroFP: Math.floor(5.5 * FP), speedFP: tilesPerSec(1.8), elixir: 3,
    count: 4, splashFP: 0, spellDelayTicks: 0, auraFP: 0,
  },
  [Archetype.Ranged]: {
    hp: 320, damage: 110, hitTicks: 28, rangeFP: Math.floor(5.0 * FP),
    aggroFP: Math.floor(6.0 * FP), speedFP: tilesPerSec(1.2), elixir: 3,
    count: 1, splashFP: 0, spellDelayTicks: 0, auraFP: 0,
  },
  [Archetype.Splash]: {
    hp: 520, damage: 140, hitTicks: 36, rangeFP: Math.floor(3.2 * FP),
    aggroFP: Math.floor(5.5 * FP), speedFP: tilesPerSec(1.0), elixir: 4,
    count: 1, splashFP: Math.floor(1.6 * FP), spellDelayTicks: 0, auraFP: 0,
  },
  [Archetype.Support]: {
    hp: 450, damage: 55, hitTicks: 26, rangeFP: Math.floor(1.4 * FP),
    aggroFP: Math.floor(5.0 * FP), speedFP: tilesPerSec(1.1), elixir: 3,
    count: 1, splashFP: 0, spellDelayTicks: 0, auraFP: Math.floor(3.0 * FP),
  },
  [Archetype.Spell]: {
    hp: 0, damage: 320, hitTicks: 0, rangeFP: 0,
    aggroFP: 0, speedFP: 0, elixir: 4,
    count: 0, splashFP: Math.floor(2.5 * FP), spellDelayTicks: TICKS_PER_SEC, auraFP: 0,
  },
};

// Support aura: allies in radius attack 15% faster (cooldown * 100/115).
export const AURA_SPEED_NUM = 100;
export const AURA_SPEED_DEN = 115;

// Level multiplier 1 + 0.6·√((lvl−1)/9), precomputed per-mille so the sim never
// touches sqrt/floats. Index 0 unused (levels are 1-based).
export const LEVEL_MULT_PM = [0, 1000, 1200, 1283, 1346, 1400, 1447, 1490, 1529, 1566, 1600];

export const scaleByLevel = (base: number, level: number): number =>
  Math.floor((base * LEVEL_MULT_PM[level]) / 1000);

/** Deterministic coin → archetype. Must match the onchain program byte-for-byte. */
export function archetypeForMint(mint: string): Archetype {
  let h = 0x811c9dc5;
  for (let i = 0; i < mint.length; i++) {
    h ^= mint.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 6) as Archetype;
}
