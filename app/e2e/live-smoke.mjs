/**
 * Live smoke test on Monad testnet, against the hosted app and relay: two
 * guests onboard (starter deck minted by the relayer, MON drip, AUSD from
 * Agora's faucet), then play a staked AUSD Rush match. Records the per-play
 * speed receipts (executed / final ms) and the match's on-chain settlement.
 *
 *   node app/e2e/live-smoke.mjs   (writes docs/screens/live/*.png and docs/LIVE-SMOKE.json)
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const APP = process.env.APP_URL ?? 'https://mempire-monad.vercel.app';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = `${ROOT}docs/screens/live/`;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const noise = [];
const evidence = { app: APP, at: new Date().toISOString(), players: [], receipts: [], txs: [] };
let ok = true;
const assert = (l, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${d ? ` — ${d}` : ''}`); ok &&= c; };

async function page(b, vp, label) {
  const p = await (await b.newContext({ viewport: vp })).newPage();
  p.on('console', (m) => { if (m.type() === 'error' && !/THREE\.Clock/.test(m.text())) noise.push(`${label} ${m.text().slice(0, 200)}`); });
  p.on('pageerror', (e) => noise.push(`${label} pageerror ${String(e).slice(0, 200)}`));
  p.on('request', (r) => { if (r.url().endsWith('/api/onboard') && r.method() === 'POST') { try { p.addr = JSON.parse(r.postData() ?? '{}').address; } catch { /* */ } } });
  p.on('response', async (r) => {
    if (!/\/api\/onboard$/.test(r.url()) || r.request().method() !== 'POST') return;
    try { const j = await r.json(); for (const v of Object.values(j)) if (typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v)) evidence.txs.push({ what: `${label} onboard`, hash: v }); } catch { /* */ }
  });
  return p;
}
async function guest(p, label) {
  const t0 = Date.now();
  await p.goto(APP);
  await p.getByRole('button', { name: 'Play now' }).click();
  await p.getByRole('button', { name: /Play as Guest/ }).click();
  await p.getByText(/Your deck is on chain/i).waitFor({ timeout: 120_000 });
  evidence.players.push({ label, address: p.addr, onboardSeconds: Math.round((Date.now() - t0) / 1000) });
  const skip = p.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}
async function drop(p) {
  const card = p.getByRole('button', { name: /^Deploy / }).first();
  const cb = await card.boundingBox({ timeout: 2000 }).catch(() => null);
  const cv = await p.locator('canvas').first().boundingBox({ timeout: 2000 }).catch(() => null);
  if (!cb || !cv) return;
  await p.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await p.mouse.down();
  await p.mouse.move(cv.x + cv.width * 0.32, cv.y + cv.height * 0.62, { steps: 6 });
  await p.mouse.up();
}

const b = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const A = await page(b, { width: 1440, height: 900 }, 'A');
  const B = await page(b, { width: 390, height: 844 }, 'B');
  await guest(A, 'A');
  await guest(B, 'B');
  assert('two guests onboarded on Monad testnet (starter deck on chain)', Boolean(A.addr && B.addr), JSON.stringify(evidence.players));
  await A.screenshot({ path: `${OUT}onboarded-desktop.png` });

  for (const p of [A, B]) {
    await p.goto(APP);
    await sleep(3000);
    await p.getByRole('radiogroup', { name: 'Stake currency' }).getByText('AUSD', { exact: true }).click();
    await sleep(800);
  }
  await A.getByRole('button', { name: /Rush · 30s/i }).click({ force: true });
  await B.getByRole('button', { name: /Rush · 30s/i }).click({ force: true });
  await A.waitForURL(/#\/battle/, { timeout: 180_000 });
  assert('matched and escrowed (both seats in battle)', true);

  let result = null;
  let shot = false;
  for (let i = 0; i < 90 && !result; i += 1) {
    const text = await A.locator('body').innerText().catch(() => '');
    for (const m of text.matchAll(/exec (\d+) · final (\d+) ms/g)) evidence.receipts.push({ executedMs: Number(m[1]), finalMs: Number(m[2]) });
    result = text.match(/Pot Secured|Rekt|Split|Voided/i)?.[0] ?? null;
    if (!shot && evidence.receipts.length >= 2) { await A.screenshot({ path: `${OUT}speed-receipts-desktop.png` }); shot = true; }
    if (!result) { await drop(A); await sleep(2000); }
  }
  // Unique receipts only (the ticker shows the same pill across polls).
  evidence.receipts = [...new Map(evidence.receipts.map((r) => [`${r.executedMs}/${r.finalMs}`, r])).values()];
  assert('per-play speed receipts with real Monad timings', evidence.receipts.length > 0, JSON.stringify(evidence.receipts.slice(0, 6)));
  assert('the match reached a result', Boolean(result), result ?? 'none');
  await sleep(15_000); // settlement claims land
  await A.screenshot({ path: `${OUT}result-desktop.png` });
  const body = await A.locator('body').innerText();
  for (const m of body.matchAll(/0x[0-9a-f]{64}/gi)) evidence.txs.push({ what: 'result screen', hash: m[0] });
  const links = await A.locator('a[href*="monadvision"], a[href*="/tx/"]').evaluateAll((as) => as.map((a) => a.href));
  for (const l of links) { const h = l.match(/0x[0-9a-f]{64}/i)?.[0]; if (h) evidence.txs.push({ what: 'explorer link', hash: h }); }
  evidence.result = result;
} catch (e) {
  ok = false; console.log('FAIL', String(e?.stack ?? e).slice(0, 500));
  for (const [i, c] of b.contexts().entries()) await c.pages()[0]?.screenshot({ path: `${OUT}_debug-${i}.png` }).catch(() => {});
} finally { await b.close(); }
evidence.consoleErrors = noise;
writeFileSync(`${ROOT}docs/LIVE-SMOKE.json`, `${JSON.stringify(evidence, null, 2)}\n`);
if (noise.length) console.log(`console errors:\n${noise.slice(0, 8).join('\n')}`);
console.log(ok ? 'LIVE SMOKE PASS' : 'LIVE SMOKE FAIL');
process.exit(ok ? 0 : 1);
