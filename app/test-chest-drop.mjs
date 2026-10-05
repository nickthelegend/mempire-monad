/**
 * Chest drops: the claim is that they are derivable, so this checks they are.
 *
 * Two properties matter, and neither is visible by playing:
 *
 *  1. **The TS tier rule matches the Rust one exactly.** A locally-seeded chest
 *     must have the published odds, and the client must be able to verify the
 *     oracle's answer against its own bytes. Those both fail silently if the two
 *     implementations of `random_u8_with_range` ever diverge, so this runs the
 *     real Rust through `cargo` and compares outputs on shared vectors.
 *  2. **The drop is a pure function of (seed, eligible, owned).** Same inputs,
 *     same cards, always — otherwise "check it yourself" is not true.
 *
 * Run: npx tsx test-chest-drop.mjs
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The module uses crypto.getRandomValues; Node has it on globalThis.crypto.
const {
  bytesToHex, deriveDrops, hexToBytes, localSeed, randomU8WithRange,
  tierForRoll, tierFromSeed,
} = await import('./src/lib/chestDrop.ts');

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

/** Deterministic pseudo-seeds, so a failure is reproducible. */
function seedFrom(n) {
  const b = new Uint8Array(32);
  let x = (n * 2654435761) >>> 0;
  for (let i = 0; i < 32; i += 1) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    b[i] = x & 0xff;
  }
  return b;
}

const POOL = Array.from({ length: 64 }, (_, i) => ({
  mint: `mint${String(i).padStart(2, '0')}`, ticker: `T${i}`,
}));

console.log('\nthe tier rule matches the program');

check('weights partition 1..=100 exactly as the Rust table does', () => {
  const counts = [0, 0, 0, 0];
  for (let roll = 1; roll <= 100; roll += 1) counts[tierForRoll(roll)] += 1;
  assert.deepEqual(counts, [62, 26, 9, 3]);
});

check('randomU8WithRange agrees with the Rust SDK on 256 vectors', () => {
  // Build the same vectors on both sides and compare. This is the check that
  // catches a divergence between the client's odds and the chain's.
  const seeds = Array.from({ length: 256 }, (_, i) => seedFrom(i));
  const ours = seeds.map((s) => randomU8WithRange(s, 1, 100));

  const dir = mkdtempSync(join(tmpdir(), 'chest-vec-'));
  const hexes = seeds.map(bytesToHex);
  writeFileSync(join(dir, 'seeds.txt'), hexes.join('\n'));

  // A tiny Rust harness that links the *real* SDK, so this compares against the
  // function the program actually calls rather than a copy of it.
  const manifest = `[package]
name = "chestvec"
version = "0.0.0"
edition = "2021"
[dependencies]
ephemeral-rollups-sdk = { version = "0.16.2", features = ["anchor-compat", "vrf"] }
[[bin]]
name = "chestvec"
path = "main.rs"
`;
  const main = `use ephemeral_rollups_sdk::vrf::rnd::random_u8_with_range;
fn main() {
    let text = std::fs::read_to_string(std::env::args().nth(1).unwrap()).unwrap();
    for line in text.lines() {
        let mut b = [0u8; 32];
        for i in 0..32 {
            b[i] = u8::from_str_radix(&line[i * 2..i * 2 + 2], 16).unwrap();
        }
        println!("{}", random_u8_with_range(&b, 1, 100));
    }
}
`;
  writeFileSync(join(dir, 'Cargo.toml'), manifest);
  writeFileSync(join(dir, 'main.rs'), main);

  let theirs;
  try {
    const out = execSync(
      `cargo run --quiet --release --manifest-path ${join(dir, 'Cargo.toml')} -- ${join(dir, 'seeds.txt')}`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 },
    );
    theirs = out.trim().split('\n').map(Number);
  } catch (e) {
    // A machine without the crate cached should say so rather than pass quietly.
    throw new Error(`could not run the Rust reference: ${String(e.message).slice(0, 200)}`);
  }

  assert.equal(theirs.length, ours.length, 'vector count mismatch');
  const diffs = ours
    .map((v, i) => (v === theirs[i] ? null : `#${i}: ts=${v} rust=${theirs[i]}`))
    .filter(Boolean);
  assert.equal(diffs.length, 0, `TS and Rust disagree:\n       ${diffs.slice(0, 5).join('\n       ')}`);
  console.log(`       (256/256 vectors identical to the on-chain implementation)`);
});

check('a seed produces the same tier on both sides of the wire', () => {
  // tierFromSeed is what reconcile uses to verify the oracle, so it has to be
  // the composition of the two rules above and nothing else.
  for (let i = 0; i < 64; i += 1) {
    const s = seedFrom(i);
    assert.equal(tierFromSeed(s), tierForRoll(randomU8WithRange(s, 1, 100)));
  }
});

console.log('\nthe drop is derivable');

check('same seed, same inputs, same cards — every time', () => {
  const seed = seedFrom(7);
  const owned = new Set(['mint00', 'mint01']);
  const a = deriveDrops(seed, POOL, owned, 4).map((c) => c.ticker);
  const b = deriveDrops(seed, POOL, owned, 4).map((c) => c.ticker);
  assert.deepEqual(a, b, 'the same seed gave different cards');
});

check('a different seed gives a different draw', () => {
  const owned = new Set();
  const a = deriveDrops(seedFrom(1), POOL, owned, 4).map((c) => c.ticker).join();
  const b = deriveDrops(seedFrom(2), POOL, owned, 4).map((c) => c.ticker).join();
  assert.notEqual(a, b);
});

check('it never mutates the caller\'s pool', () => {
  const before = POOL.map((c) => c.mint).join();
  deriveDrops(seedFrom(3), POOL, new Set(), 4);
  assert.equal(POOL.map((c) => c.mint).join(), before);
});

check('unowned coins are drawn first, and without replacement', () => {
  const owned = new Set(POOL.slice(2).map((c) => c.mint)); // only 2 unowned
  const got = deriveDrops(seedFrom(9), POOL, owned, 2).map((c) => c.mint);
  assert.equal(new Set(got).size, 2, 'a fresh draw repeated a card');
  assert.ok(got.every((m) => m === 'mint00' || m === 'mint01'),
    `expected the two unowned, got ${got.join()}`);
});

check('once the fresh pool is empty, duplicates become possible again', () => {
  const owned = new Set(POOL.map((c) => c.mint)); // owns everything
  const got = deriveDrops(seedFrom(11), POOL, owned, 4);
  assert.equal(got.length, 4, 'a full collection stopped producing drops');
});

check('a player who owns nothing still gets four distinct cards', () => {
  const got = deriveDrops(seedFrom(13), POOL, new Set(), 4).map((c) => c.mint);
  assert.equal(new Set(got).size, 4);
});

check('index selection is unbiased across the pool', () => {
  // Rejection sampling should spread first picks over the whole pool rather
  // than favouring low indices, which is what a naive modulo would do.
  const seen = new Set();
  for (let i = 0; i < 400; i += 1) {
    seen.add(deriveDrops(seedFrom(1000 + i), POOL, new Set(), 1)[0].mint);
  }
  assert.ok(seen.size > 45, `only ${seen.size}/64 coins ever came up first`);
  console.log(`       (${seen.size}/64 distinct coins across 400 first-draws)`);
});

check('hex round-trips, and a malformed seed is refused', () => {
  const s = localSeed();
  assert.equal(s.length, 32);
  assert.deepEqual(hexToBytes(bytesToHex(s)), s);
  assert.throws(() => hexToBytes('abcd'), /32 bytes/);
});

check('an all-zero seed does not collapse the generator', () => {
  const zero = new Uint8Array(32);
  const got = deriveDrops(zero, POOL, new Set(), 4).map((c) => c.mint);
  assert.equal(new Set(got).size, 4, 'a zero seed produced a degenerate draw');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
