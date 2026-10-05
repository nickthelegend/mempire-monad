/**
 * Remove every fabricated clan member from the database.
 *
 * `seed-clans.mjs` populated each roster with `fakeAddress()` — base58-shaped
 * strings derived from a hash, not from any keypair. Nobody can sign for them,
 * so they can never leave, never play, and never do anything a member does.
 * The Clan tab was therefore a list of real, joinable clans with invented
 * populations: "14/50 members" where the true number was zero.
 *
 * That is the one kind of dishonesty a leaderboard cannot survive. A new player
 * looking for people to play with was being shown a crowd that did not exist.
 *
 * This strips them and leaves the clans themselves standing — the names,
 * crests, tags and join rules are real records that real players can join. A
 * clan with nobody in it is an accurate empty room; a clan with fourteen ghosts
 * is a lie.
 *
 *   node purge-fake-clans.mjs           # report
 *   node purge-fake-clans.mjs --apply   # act
 */
import { MongoClient } from 'mongodb';

const URI = process.env.MONGODB_URI;
const DB = process.env.MONGODB_DB ?? 'mempire';
if (!URI) {
  console.error('MONGODB_URI missing — source server/.env first');
  process.exit(1);
}

/**
 * The exact generator `seed-clans.mjs` used, so this recognises precisely what
 * that script wrote and nothing else. Matching on a shape ("looks fake") would
 * risk deleting a real wallet; matching on the generator cannot.
 */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function fakeAddress(seed) {
  let h = 0x811c9dc5;
  const out = [];
  for (let i = 0; i < 44; i += 1) {
    h ^= seed.charCodeAt(i % seed.length) + i;
    h = Math.imul(h, 0x01000193) >>> 0;
    out.push(B58[h % B58.length]);
  }
  return out.join('');
}

/**
 * Every clan name the seeder used. The generator is seeded on the name, so
 * regenerating from this list reproduces exactly the addresses it wrote —
 * which is why this matches on identity rather than on "looks fabricated".
 */
const SPECS = [
  'Bonk Battalion', 'Tower Tacticians', 'Degen Dynasty', 'Moon Mandate',
  'Rug Survivors', 'Liquidity Lords', 'Diamond Paws', 'Test Thunder',
];

async function main() {
  const apply = process.argv.includes('--apply');
  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db(DB);
  const clans = db.collection('clans');

  // Every address that generator could ever have produced.
  const fakes = new Set();
  for (const name of SPECS) {
    fakes.add(fakeAddress(`${name}:leader`));
    for (let i = 1; i < 60; i += 1) fakes.add(fakeAddress(`${name}:${i}`));
  }

  const all = await clans.find({}).toArray();
  let touched = 0;
  let removed = 0;

  for (const c of all) {
    const members = c.members ?? [];
    const real = members.filter((m) => !fakes.has(m.address));
    const requests = (c.requests ?? []).filter((r) => !fakes.has(r.address));
    if (real.length === members.length && requests.length === (c.requests ?? []).length) continue;

    touched += 1;
    removed += members.length - real.length;
    console.log(
      `${c.name} (#${c.tag}): ${members.length} → ${real.length} members`
      + `${real.length === 0 ? '  [now empty — joinable]' : ''}`,
    );

    if (!apply) continue;

    // Crowns were accumulated by the ghosts, so they go with them. A clan's
    // standing has to be something its actual members earned.
    await clans.updateOne({ _id: c._id }, {
      $set: {
        members: real,
        requests,
        memberCount: real.length,
        crowns: real.reduce((n, m) => n + (m.crowns ?? 0), 0),
        weeklyLent: 0,
      },
    });
  }

  console.log(
    `\n${touched} clans carried fabricated members; ${removed} removed`
    + `${apply ? '' : '\nrun with --apply to act'}`,
  );
  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
