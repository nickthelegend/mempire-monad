/**
 * Turning a chest's 32 bytes of randomness into the cards it contains.
 *
 * The tier a chest rolls is decided by the MagicBlock VRF oracle and the bytes
 * that produced it are stored on the chest. This module is the other half of
 * that promise: the *contents* are a pure function of those same bytes, so a
 * player — or anyone auditing a drop afterwards — can re-derive exactly which
 * cards a chest gave and check the game did not quietly pick for them.
 *
 * Putting the card list on-chain instead would need the whole eligible registry
 * in the callback, which is both a much larger account and a much slower
 * callback, and would buy nothing this does not.
 *
 * # What makes it verifiable
 *
 * The derivation depends on exactly three things, all of them reconstructible:
 *
 *  1. the chest's 32 bytes — on-chain, and emitted in `ChestClaimed`
 *  2. the ordered eligible coin list — the registry, filtered by the published
 *     gate (≥$25k liquidity, ≥48h old), in registry order
 *  3. which of those the player already owned — their card PDAs
 *
 * Same three inputs, same cards, every time, in any language. That is the whole
 * claim, and it is why the expansion below is a named algorithm with a spec
 * rather than whatever the platform's `Math.random` happens to be.
 */

/** 2^64, as the modulus for the 64-bit arithmetic below. */
const M64 = 1n << 64n;
const MASK64 = M64 - 1n;

/**
 * xoshiro256** — a small, fast, well-specified PRNG.
 *
 * Chosen because its state is exactly 256 bits, which is exactly the size of
 * the oracle's output. Every one of the 32 bytes goes into the state directly,
 * so the drop is a function of the whole randomness rather than of a 64-bit
 * fold of it. It is also short enough to reimplement from this file alone,
 * which is the point of publishing a derivation at all.
 *
 * Not a cryptographic generator, and it does not need to be: the seed is
 * revealed only *after* the oracle has committed to it, so there is nothing
 * left to predict.
 */
class Xoshiro256 {
  private s: [bigint, bigint, bigint, bigint];

  constructor(seed: Uint8Array) {
    if (seed.length !== 32) throw new Error('chest seed must be 32 bytes');
    const view = new DataView(seed.buffer, seed.byteOffset, seed.byteLength);
    // Little-endian, matching how the bytes sit in the account.
    this.s = [
      view.getBigUint64(0, true),
      view.getBigUint64(8, true),
      view.getBigUint64(16, true),
      view.getBigUint64(24, true),
    ];
    // An all-zero state is a fixed point that only ever emits zero. Vanishingly
    // unlikely from a real oracle, but a derivation that silently degenerates is
    // not one worth publishing.
    if (this.s.every((w) => w === 0n)) this.s[0] = 0x9e3779b97f4a7c15n;
  }

  private static rotl(x: bigint, k: bigint): bigint {
    return ((x << k) | (x >> (64n - k))) & MASK64;
  }

  next(): bigint {
    const [s0, s1, s2, s3] = this.s;
    const result = (Xoshiro256.rotl((s1 * 5n) & MASK64, 7n) * 9n) & MASK64;
    const t = (s1 << 17n) & MASK64;
    let n2 = s2 ^ s0;
    const n3 = s3 ^ s1;
    const n1 = s1 ^ n2;
    const n0 = s0 ^ n3;
    n2 ^= t;
    this.s = [n0, n1, n2, Xoshiro256.rotl(n3, 45n)];
    return result;
  }

  /**
   * A uniform integer in `[0, bound)`, by rejection sampling.
   *
   * `next() % bound` is the obvious version and is biased whenever `bound` does
   * not divide 2^64 — with a 64-coin pool that bias is tiny, but "tiny" is not
   * a word that belongs anywhere near a fairness claim. Discarding the short
   * tail costs one extra draw in the worst case and removes the argument.
   */
  below(bound: number): number {
    if (bound <= 0) throw new Error('bound must be positive');
    const b = BigInt(bound);
    const limit = M64 - (M64 % b);
    let r = this.next();
    while (r >= limit) r = this.next();
    return Number(r % b);
  }
}

/** Hex → bytes. The chest stores its randomness hex-encoded. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  if (clean.length !== 64) throw new Error('chest randomness must be 32 bytes of hex');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A 32-byte seed for a chest this session rolled itself.
 *
 * Guest play cannot reach the oracle, so its chests are seeded locally — but
 * they are seeded and *stored* the same way, which means the contents are still
 * a published function of a recorded seed rather than of an unrecorded
 * `Math.random()`. The chest records which provenance it had; only an oracle
 * seed earns the fairness claim, and the UI marks the difference.
 */
export function localSeed(): Uint8Array {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b;
}

export interface DropCandidate {
  /** Stable identity — the mint address. */
  mint: string;
  ticker: string;
}

/**
 * The cards a chest contains, derived from its seed.
 *
 * `owned` shapes the outcome and is part of the published rule, not a thumb on
 * the scale: a drop that teaches a new card beats a duplicate, so unowned coins
 * are drawn first and without replacement. Once they run out — or if the player
 * already holds everything — draws fall back to the full eligible list, where
 * duplicates are allowed.
 *
 * `eligible` must be in registry order. Sorting it differently produces a
 * different, equally valid stream and breaks reproducibility for anyone
 * checking the result, so callers pass the registry's own order and this
 * function never reorders it.
 */
export function deriveDrops(
  seed: Uint8Array,
  eligible: DropCandidate[],
  owned: ReadonlySet<string>,
  count: number,
): DropCandidate[] {
  if (!eligible.length || count <= 0) return [];
  const rng = new Xoshiro256(seed);
  // Copied so the caller's array is never mutated — the splice below is how
  // "without replacement" is implemented.
  const fresh = eligible.filter((c) => !owned.has(c.mint));
  const out: DropCandidate[] = [];

  for (let i = 0; i < count; i += 1) {
    if (fresh.length) {
      out.push(fresh.splice(rng.below(fresh.length), 1)[0]);
    } else {
      out.push(eligible[rng.below(eligible.length)]);
    }
  }
  return out;
}

/* ── The tier, mirrored from the program ──────────────────────────────────── */

/**
 * `ephemeral_rollups_sdk::vrf::rnd::random_u8_with_range`, reimplemented.
 *
 * Byte-for-byte the same algorithm the on-chain callback runs, including its
 * reverse scan and its fallback. Two reasons it is duplicated here rather than
 * approximated:
 *
 *  1. A Guest chest is seeded locally and must be rolled by the *same* rule as
 *     an oracle one, or "local" would quietly mean "different odds".
 *  2. It lets the client **check** the oracle. Given the bytes the chest stores,
 *     `tierFromSeed` must reproduce the tier the program wrote. If it ever does
 *     not, something between the oracle and the account is wrong, and that is
 *     worth knowing rather than trusting.
 *
 * The reverse scan is the SDK's own bias avoidance: it walks bytes from the end
 * looking for one below the largest multiple of `range` that fits in a byte, so
 * the modulo is exact.
 */
export function randomU8WithRange(bytes: Uint8Array, min: number, max: number): number {
  const range = max - min + 1;
  const threshold = Math.floor(256 / range) * range;
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    if (bytes[i] < threshold) return min + (bytes[i] % range);
  }
  return min + (bytes[31] % range);
}

/**
 * Chest tier weights, mirroring `TIER_WEIGHTS` in `chests.rs`.
 * Silver 62, golden 26, magic 9, legendary 3 — a 1..=100 partition.
 */
export const TIER_WEIGHTS: [number, number][] = [[0, 62], [1, 26], [2, 9], [3, 3]];

/** Weighted tier from a 1..=100 roll. Mirrors `tier_for_roll`. */
export function tierForRoll(roll: number): number {
  let acc = 0;
  for (const [tier, weight] of TIER_WEIGHTS) {
    acc += weight;
    if (roll <= acc) return tier;
  }
  return TIER_WEIGHTS[0][0];
}

/** The tier a seed produces. Mirrors `tier_from_randomness`. */
export function tierFromSeed(seed: Uint8Array): number {
  return tierForRoll(randomU8WithRange(seed, 1, 100));
}
