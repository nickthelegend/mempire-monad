/**
 * Endpoint sweep for TESTPLAN section B.
 *
 * Hits every relay route and reports status + a shape assertion. Unsigned
 * writes are expected to 401 — that is the auth guard working, so a 401 there
 * is a PASS and a 200 would be the failure.
 */
const BASE = process.env.API ?? 'https://mempire-relay-production.up.railway.app';
const ADDR = 'FxQMRBcXDQbG1CnwfYiVCu7UMnbHeRcFZs2zrczEbfsb';

let pass = 0; let fail = 0;
const results = [];

async function check(id, method, path, expect, assert) {
  const url = `${BASE}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({ probe: true }),
    });
    const want = Array.isArray(expect) ? expect : [expect];
    const statusOk = want.includes(res.status);
    let body = null;
    try { body = await res.json(); } catch { /* not json */ }
    const shapeOk = statusOk && assert ? assert(body) : statusOk;
    const ok = statusOk && shapeOk !== false;
    results.push(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(6)} ${method} ${path} -> ${res.status} (want ${want.join('/')})`
      + (ok ? '' : `  body=${JSON.stringify(body).slice(0, 120)}`));
    ok ? pass++ : fail++;
  } catch (e) {
    results.push(`FAIL  ${id.padEnd(6)} ${method} ${path} -> threw ${e.message}`);
    fail++;
  }
}

await check('B1', 'GET', '/api/health', 200);
// Live DexScreener discovery, not the devnet game registry (which is bundled
// client-side). Correct = every entry has a clean, trimmed ticker and name.
await check('B2', 'GET', '/api/coins', 200, (b) => {
  const c = b?.coins ?? b;
  if (!Array.isArray(c) || !c.length) return false;
  return c.every((x) => x.ticker === x.ticker.trim() && x.name === x.name.trim());
});
await check('B3', 'GET', '/api/faucet', 200, (b) => b.dripMempire === 2000 && b.dripSol === 0.35);
await check('B4a', 'POST', '/api/faucet', [400, 401]);
await check('B5', 'GET', `/api/player/${ADDR}`, 200);
await check('B5b', 'GET', '/api/player/NotARealAddress11111111111111', [200, 400, 404]);
await check('B6', 'PUT', `/api/player/${ADDR}`, [400, 401]);
await check('B7', 'GET', '/api/leaderboard', 200, (b) => Array.isArray(b?.rows ?? b));
await check('B8a', 'GET', '/api/ladder', 200);
await check('B8b', 'GET', `/api/ladder/${ADDR}`, 200);
await check('B9a', 'GET', '/api/clans', 200);
await check('B9b', 'GET', '/api/clans-top', 200);
// Tags are six chars from the Crockford-ish alphabet. Malformed is a 400,
// well-formed but absent is a 404 — the two must stay distinguishable.
await check('B9c', 'GET', '/api/clans/ABCDEF', 404);
await check('B9c2', 'GET', '/api/clans/NOPE', 400);
await check('B9d', 'GET', `/api/clans/mine/${ADDR}`, 200);
await check('B10a', 'POST', '/api/clans', [400, 401]);
await check('B10b', 'POST', '/api/clans/NOPE/join', [400, 401, 404]);
await check('B10c', 'POST', '/api/clans/NOPE/leave', [400, 401, 404]);
await check('B10d', 'POST', '/api/clans/NOPE/lend', [400, 401, 404]);
await check('B10e', 'POST', '/api/clans/NOPE/crowns', [400, 401, 404]);
// Telemetry is signed like every other write; an unsigned post must be refused.
await check('B11', 'POST', '/api/events', 401);
await check('B12a', 'GET', '/api/analytics/summary', 200);
await check('B12b', 'GET', '/api/analytics/tvl', 200);
await check('B12c', 'GET', '/api/analytics/ops', 200);
await check('B12d', 'GET', '/api/analytics/insights', 200);
await check('B13a', 'POST', `/api/match/${ADDR}`, [400, 401]);
await check('B13b', 'POST', '/api/player/match', [400, 401]);

console.log(results.join('\n'));
console.log(`\n${pass} pass, ${fail} fail`);
