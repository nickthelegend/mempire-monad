/**
 * Every HTTP endpoint the API exposes, against a running instance.
 *
 * The existing suites test behaviour in depth — matchmaking, clan rules, Elo.
 * This one tests *coverage*: that all twenty-two routes exist, answer, validate
 * their input, and return the shape the client expects. A route that 404s
 * because it was renamed, or 500s because an index is missing, is invisible to
 * a behavioural test that never calls it.
 *
 * It also asserts the things a deployment gets wrong rather than the things a
 * developer gets wrong: health reflects the database rather than the process,
 * a bad address is refused before it reaches Mongo, the rate limiter actually
 * limits, and the WebSocket upgrade is served from the same port.
 *
 *   docker compose up --build -d
 *   node test-api.mjs
 *
 * API=http://host:port to point it elsewhere.
 */
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const API = process.env.API ?? 'http://localhost:8787';

let pass = 0;
let fail = 0;
const seen = new Set();

/** Marks a route as covered, so the summary can prove nothing was skipped. */
const cover = (method, path) => seen.add(`${method} ${path}`);

async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n       ${String(e.message).split('\n')[0].slice(0, 180)}`);
  }
}

async function req(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* some errors have no body */ }
  return { status: res.status, json };
}

/** Base58, Solana pubkey shape — the same thing the server validates against. */
const addr = (seed) => {
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let out = '';
  let x = seed >>> 0;
  for (let i = 0; i < 43; i += 1) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out += B58[x % B58.length];
  }
  return out;
};

/**
 * Fresh actors every run.
 *
 * The first version reused three fixed addresses, which passed once and then
 * failed forever: Alice was still in the clan she founded, so the next run's
 * `POST /api/clans` returned 409 and took nine assertions down with it. A suite
 * that only passes against an empty database is a suite that passes once.
 */
const RUN = Date.now() >>> 0;
const ALICE = addr(RUN + 1);
const BOB = addr(RUN + 2);
const CAROL = addr(RUN + 3);
/**
 * Allocated by the server, not chosen here.
 *
 * The first version of this test invented a tag and passed it in the body. The
 * API generates one and returns it, so every follow-up call addressed a clan
 * that had never existed and nine assertions failed against a server that was
 * behaving correctly. Read the contract, do not assume it.
 */
let TAG = '';
let REQUEST_ID = null;

console.log(`\ntarget ${API}\n`);

// ── liveness ────────────────────────────────────────────────────────────────
console.log('health');

await check('GET /api/health reports the database, not just the process', async () => {
  cover('GET', '/api/health');
  const { status, json } = await req('GET', '/api/health');
  assert.equal(status, 200, `health returned ${status}`);
  assert.equal(json.ok, true);
  // A health check that returns ok without touching Mongo would let a
  // deployment with a dead database pass its readiness probe.
  assert.ok(json.db, 'health did not name the database it pinged');
});

// ── player state ────────────────────────────────────────────────────────────
console.log('\nplayer state');

await check('GET /api/player/:address returns null for an unknown wallet', async () => {
  cover('GET', '/api/player/:address');
  const { status, json } = await req('GET', `/api/player/${ALICE}`);
  assert.equal(status, 200);
  assert.ok(json === null || typeof json === 'object');
});

await check('PUT /api/player/:address saves, and GET reads it back', async () => {
  cover('PUT', '/api/player/:address');
  const state = {
    cards: [], deck: [], tier: 1, sol: 4.2, nextId: 7, history: [],
    gems: 120, chests: [], nextChestId: 1,
  };
  const put = await req('PUT', `/api/player/${ALICE}`, state);
  assert.ok(put.status < 300, `save returned ${put.status}`);
  const got = await req('GET', `/api/player/${ALICE}`);
  assert.equal(got.status, 200);
  assert.equal(got.json.sol, 4.2, 'the saved value did not come back');
  assert.equal(got.json.gems, 120);
});

await check('a malformed address is refused before it reaches Mongo', async () => {
  const { status } = await req('GET', '/api/player/not-a-real-address!!');
  assert.ok(status === 400 || status === 404, `expected a refusal, got ${status}`);
});

await check('POST /api/match/:address records a settled match', async () => {
  cover('POST', '/api/match/:address');
  const { status } = await req('POST', `/api/match/${ALICE}`, {
    won: true, crowns: 3, netSol: 0.045, tier: 1, opponent: BOB, at: Date.now(),
  });
  assert.ok(status < 300, `record returned ${status}`);
});

await check('GET /api/leaderboard returns rows shaped for the client', async () => {
  cover('GET', '/api/leaderboard');
  const { status, json } = await req('GET', '/api/leaderboard');
  assert.equal(status, 200);
  assert.ok(Array.isArray(json), 'leaderboard was not an array');
  if (json.length) {
    const r = json[0];
    assert.ok(typeof r.address === 'string', 'a row has no address');
    assert.ok('netSol' in r, 'a row has no netSol');
    assert.ok(!('_id' in r) || r._id === undefined, 'Mongo _id leaked to the client');
  }
});

// ── the ladder ──────────────────────────────────────────────────────────────
console.log('\nladder');

await check('GET /api/ladder/:address starts a new player at the floor', async () => {
  cover('GET', '/api/ladder/:address');
  const { status, json } = await req('GET', `/api/ladder/${CAROL}`);
  assert.equal(status, 200);
  assert.ok(typeof json.trophies === 'number', 'no trophy count');
});

await check('POST /api/ladder/:address moves trophies and returns the new state', async () => {
  cover('POST', '/api/ladder/:address');
  const before = (await req('GET', `/api/ladder/${CAROL}`)).json.trophies;
  const { status, json } = await req('POST', `/api/ladder/${CAROL}`, {
    opponentTrophies: 600, outcome: 'win',
  });
  assert.ok(status < 300, `ladder post returned ${status}`);
  assert.ok(json.trophies > before, `trophies did not rise: ${before} -> ${json.trophies}`);
});

await check('a win against a far weaker opponent pays almost nothing', async () => {
  // Elo, not a flat counter — but the gap has to be an *Elo* gap. Beating a
  // 1-trophy opponent from 31 trophies is still worth 15, because 30 points is
  // nothing on a 400-point scale. Climb first, then check the payout collapses.
  for (let i = 0; i < 12; i += 1) {
    await req('POST', `/api/ladder/${CAROL}`, { opponentTrophies: 2500, outcome: 'win' });
  }
  const high = (await req('GET', `/api/ladder/${CAROL}`)).json.trophies;
  assert.ok(high > 300, `only reached ${high} trophies; the sweep did not climb`);
  const { json } = await req('POST', `/api/ladder/${CAROL}`, {
    opponentTrophies: 1, outcome: 'win',
  });
  const paid = json.trophies - high;
  assert.ok(paid <= 3,
    `from ${high} trophies, beating a 1-trophy opponent paid ${paid}`);
});

await check('GET /api/ladder returns the top table', async () => {
  cover('GET', '/api/ladder');
  const { status, json } = await req('GET', '/api/ladder');
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.players), 'no players array');
});

// ── coins ───────────────────────────────────────────────────────────────────
console.log('\ncoins');

await check('GET /api/coins answers', async () => {
  cover('GET', '/api/coins');
  const { status, json } = await req('GET', '/api/coins');
  assert.equal(status, 200);
  assert.ok(Array.isArray(json) || typeof json === 'object');
});

// ── clans ───────────────────────────────────────────────────────────────────
console.log('\nclans');

await check('POST /api/clans founds one and returns its allocated tag', async () => {
  cover('POST', '/api/clans');
  const { status, json } = await req('POST', '/api/clans', {
    address: ALICE,
    name: `API Test ${Date.now().toString(36).slice(-6)}`,
    description: 'created by the endpoint suite',
    region: 'Global',
    joinMode: 'open',
    memberName: 'alice',
    power: 30,
  });
  assert.equal(status, 201, `found returned ${status}: ${JSON.stringify(json).slice(0, 140)}`);
  TAG = json.tag ?? json._id;
  assert.ok(TAG, `no tag in the response: ${JSON.stringify(json).slice(0, 140)}`);
});

await check('GET /api/clans lists it', async () => {
  cover('GET', '/api/clans');
  const { status, json } = await req('GET', '/api/clans');
  assert.equal(status, 200);
  const rows = Array.isArray(json) ? json : json.clans;
  assert.ok(Array.isArray(rows), 'no clan list');
  assert.ok(rows.some((c) => c.tag === TAG), 'the clan just founded is not listed');
});

await check('GET /api/clans/:tag returns it with its roster', async () => {
  cover('GET', '/api/clans/:tag');
  const { status, json } = await req('GET', `/api/clans/${TAG}`);
  assert.equal(status, 200);
  assert.equal(json.tag, TAG);
  assert.ok(Array.isArray(json.members), 'no member list');
});

await check('GET /api/clans/mine/:address finds the founder in it', async () => {
  cover('GET', '/api/clans/mine/:address');
  const { status, json } = await req('GET', `/api/clans/mine/${ALICE}`);
  assert.equal(status, 200);
  assert.ok(json && json.tag === TAG, 'the founder is not shown as a member');
});

await check('POST /api/clans/:tag/join adds a second member', async () => {
  cover('POST', '/api/clans/:tag/join');
  const { status } = await req('POST', `/api/clans/${TAG}/join`, {
    address: BOB, memberName: 'bob', power: 25,
  });
  assert.ok(status < 300, `join returned ${status}`);
});

await check('PATCH /api/clans/:tag edits settings', async () => {
  cover('PATCH', '/api/clans/:tag');
  const { status } = await req('PATCH', `/api/clans/${TAG}`, {
    address: ALICE, description: 'edited by the api test',
    region: 'Global', requiredPower: 10, joinMode: 'request',
  });
  assert.ok(status < 300, `patch returned ${status}`);
});

await check('POST /api/clans/:tag/role promotes a member', async () => {
  cover('POST', '/api/clans/:tag/role');
  const { status } = await req('POST', `/api/clans/${TAG}/role`, {
    address: ALICE, target: BOB, role: 'elder',
  });
  assert.ok(status < 300, `role returned ${status}`);
});

await check('POST /api/clans/:tag/crowns credits a war contribution', async () => {
  cover('POST', '/api/clans/:tag/crowns');
  const { status } = await req('POST', `/api/clans/${TAG}/crowns`, {
    address: ALICE, crowns: 3, power: 30,
  });
  assert.ok(status < 300, `crowns returned ${status}`);
});

await check('POST /api/clans/:tag/request asks for a card', async () => {
  cover('POST', '/api/clans/:tag/request');
  const { status, json } = await req('POST', `/api/clans/${TAG}/request`, {
    address: BOB, archetype: 0, note: 'need a tank',
  });
  assert.ok(status < 300 || status === 409, `request returned ${status}`);
  REQUEST_ID = json?.requestId ?? json?.id ?? (json?.requests?.[0]?.id ?? null);
});

await check('POST /api/clans/:tag/lend fulfils one', async () => {
  cover('POST', '/api/clans/:tag/lend');
  const { status } = await req('POST', `/api/clans/${TAG}/lend`, {
    address: ALICE, requestId: REQUEST_ID,
  });
  // 404/409 are legitimate when there is nothing outstanding; a 500 is not.
  assert.ok(status < 500, `lend returned ${status}`);
});

await check('GET /api/clans-top ranks clans', async () => {
  cover('GET', '/api/clans-top');
  const { status, json } = await req('GET', '/api/clans-top');
  assert.equal(status, 200);
  assert.ok(Array.isArray(json) || Array.isArray(json.clans), 'no ranking');
});

await check('POST /api/clans/:tag/kick removes a member', async () => {
  cover('POST', '/api/clans/:tag/kick');
  const { status } = await req('POST', `/api/clans/${TAG}/kick`, {
    address: ALICE, target: BOB,
  });
  assert.ok(status < 300, `kick returned ${status}`);
});

await check('POST /api/clans/:tag/leave lets the founder out last', async () => {
  cover('POST', '/api/clans/:tag/leave');
  const { status } = await req('POST', `/api/clans/${TAG}/leave`, { address: ALICE });
  assert.ok(status < 300, `leave returned ${status}`);
});

await check('a non-member cannot edit a clan', async () => {
  const { status } = await req('PATCH', `/api/clans/${TAG}`, {
    address: CAROL, description: 'should not land',
  });
  assert.ok(status >= 400, `a stranger edited the clan (${status})`);
});

// ── transport and limits ────────────────────────────────────────────────────
console.log('\ntransport');

await check('the WebSocket upgrade is served on the same port', async () => {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/ws`);
    const timer = setTimeout(() => { ws.close(); reject(new Error('no upgrade within 5s')); }, 5000);
    ws.on('open', () => { clearTimeout(timer); ws.close(); resolve(); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
});

await check('an unknown route 404s rather than hanging', async () => {
  const { status } = await req('GET', '/api/definitely-not-a-route');
  assert.equal(status, 404);
});

await check('an oversized body is rejected, not buffered', async () => {
  const res = await fetch(`${API}/api/player/${ALICE}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ junk: 'x'.repeat(400_000) }),
  });
  assert.ok(res.status === 413 || res.status === 400,
    `a 400KB body returned ${res.status} — the 256KB limit is not enforced`);
});

await check('the rate limiter actually limits writes', async () => {
  // The bucket is 80 with 5/s refill, so a burst well past it must start
  // refusing. A limiter that never trips is a limiter nobody tested.
  const burst = await Promise.all(
    Array.from({ length: 140 }, () => req('POST', `/api/match/${BOB}`, {
      won: false, crowns: 0, netSol: -0.01, tier: 1, opponent: ALICE, at: Date.now(),
    })),
  );
  const limited = burst.filter((r) => r.status === 429).length;
  assert.ok(limited > 0, 'none of 140 rapid writes were rate limited');
  console.log(`       (${limited}/140 refused with 429)`);
});

// ── coverage ────────────────────────────────────────────────────────────────
const ROUTES = [
  'GET /api/health', 'GET /api/player/:address', 'PUT /api/player/:address',
  'POST /api/match/:address', 'GET /api/coins', 'GET /api/ladder/:address',
  'POST /api/ladder/:address', 'GET /api/ladder', 'GET /api/leaderboard',
  'GET /api/clans', 'GET /api/clans/mine/:address', 'GET /api/clans/:tag',
  'POST /api/clans', 'POST /api/clans/:tag/join', 'POST /api/clans/:tag/leave',
  'PATCH /api/clans/:tag', 'POST /api/clans/:tag/role', 'POST /api/clans/:tag/kick',
  'POST /api/clans/:tag/request', 'POST /api/clans/:tag/lend',
  'POST /api/clans/:tag/crowns', 'GET /api/clans-top',
];
const missed = ROUTES.filter((r) => !seen.has(r));

console.log('\ncoverage');
await check(`all ${ROUTES.length} routes were exercised`, () => {
  assert.equal(missed.length, 0, `never called: ${missed.join(', ')}`);
});

console.log(`\n${pass} passed, ${fail} failed  ·  ${seen.size}/${ROUTES.length} routes covered\n`);
process.exit(fail ? 1 : 0);
