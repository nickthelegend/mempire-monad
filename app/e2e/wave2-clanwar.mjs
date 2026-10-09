/**
 * Clan war in real Chrome against the local fork stack (the local relay runs a
 * 2-clan bracket): two guests each found a clan and enter the war, then fight
 * one staked MON Rush match. The winner's clan must score 3 — and only once the
 * relay has verified the settlement on chain.
 *
 *   ./scripts/local-up.sh && node app/e2e/wave2-clanwar.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const APP = 'http://localhost:5181';
const API = 'http://localhost:8799';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = `${ROOT}docs/screens/wave2/`;
const dep = JSON.parse(readFileSync(`${ROOT}shared/deployments/31337.json`, 'utf8'));
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // anvil #0, local fork only
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const noise = [];
let ok = true;
const assert = (l, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${d ? ` — ${d}` : ''}`); ok &&= c; };

async function page(b, label) {
  const p = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  p.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/THREE\.Clock/.test(m.text())) noise.push(`${label} ${m.text().slice(0, 160)}`); });
  p.on('pageerror', (e) => noise.push(`${label} pageerror ${String(e).slice(0, 160)}`));
  p.on('request', (r) => { if (r.url().endsWith('/api/onboard') && r.method() === 'POST') { try { p.addr = JSON.parse(r.postData() ?? '{}').address; } catch { /* */ } } });
  return p;
}
async function guest(p) {
  await p.goto(APP);
  await p.getByRole('button', { name: 'Play now' }).click();
  await p.getByRole('button', { name: /Play as Guest/ }).click();
  await p.getByText(/Your deck is on chain/i).waitFor({ timeout: 60_000 });
  const skip = p.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}
async function foundAndEnter(p, name) {
  execFileSync('cast', ['send', dep.token, 'transfer(address,uint256)', p.addr, '300000000000000000000',
    '--private-key', DEPLOYER, '--rpc-url', 'http://127.0.0.1:8612'], { stdio: 'ignore' });
  await p.goto(`${APP}/#/clan`);
  await sleep(2500);
  await p.getByRole('button', { name: /Create a clan|Create new/ }).first().click();
  await p.getByPlaceholder('Degen Dynasty').fill(name);
  await p.getByRole('button', { name: /Found clan/ }).click();
  const war = p.locator('section[aria-label="Clan war"]');
  await war.getByRole('button', { name: 'Enter clan war' }).click({ timeout: 60_000 });
  await war.getByRole('button', { name: 'Enter clan war' }).waitFor({ state: 'detached', timeout: 30_000 });
  return war;
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
  const A = await page(b, 'A');
  const B = await page(b, 'B');
  await guest(A); await guest(B);
  const n = Date.now() % 10000;
  const warA = await foundAndEnter(A, `Bulls ${n}`);
  await foundAndEnter(B, `Bears ${n}`);
  await A.reload();
  await warA.waitFor();
  await warA.getByText(/^0 – 0$/).waitFor({ timeout: 20_000 });
  await warA.scrollIntoViewIfNeeded();
  await A.screenshot({ path: `${OUT}clanwar-before-mobile.png` });
  assert('two clans entered: the bracket started at 0 – 0', true);

  // One staked match: A attacks, B does not.
  for (const p of [A, B]) {
    await p.goto(APP);
    await sleep(2500);
    await p.getByRole('radiogroup', { name: 'Stake currency' }).getByText('MON', { exact: true }).click();
    await sleep(600);
  }
  await A.getByRole('button', { name: /Rush · 30s/i }).click({ force: true });
  await B.getByRole('button', { name: /Rush · 30s/i }).click({ force: true });
  await A.waitForURL(/#\/battle/, { timeout: 90_000 });
  let result = null;
  for (let i = 0; i < 60 && !result; i += 1) {
    result = (await A.locator('body').innerText().catch(() => '')).match(/Pot Secured|Rekt|Split|Voided/i)?.[0] ?? null;
    if (!result) { await drop(A); await sleep(2000); }
  }
  console.log('result:', result);

  // The relay scores the war only once the chain shows the settlement.
  const tagA = (await (await fetch(`${API}/api/clans/mine/${A.addr.toLowerCase()}`)).json())?.tag;
  let pts = null;
  for (let i = 0; i < 24; i += 1) {
    const { war } = await (await fetch(`${API}/api/clan-wars/current?tag=${tagA}`)).json();
    const round = war?.rounds?.at(-1);
    pts = round ? Object.values(round.scores).map((s) => s.points).sort((x, y) => y - x) : null;
    if (pts?.[0] === 3) break;
    await sleep(5000);
  }
  assert('the staked win scored 3 for the winning clan, 0 for the other', /Pot Secured/i.test(result ?? '') && pts?.[0] === 3 && pts?.[1] === 0, `${result} · ${JSON.stringify(pts)}`);

  await A.goto(`${APP}/#/clan`);
  await A.reload();
  await warA.getByText(/^3 – 0$/).waitFor({ timeout: 30_000 });
  await warA.scrollIntoViewIfNeeded();
  await A.screenshot({ path: `${OUT}clanwar-scored-mobile.png` });
  assert('the Clan screen shows the war score 3 – 0', true);
} catch (e) {
  ok = false; console.log('FAIL', String(e?.stack ?? e).slice(0, 500));
  for (const [i, pg] of b.contexts().entries()) await pg.pages()[0]?.screenshot({ path: `${OUT}_debug-clanwar-${i}.png` }).catch(() => {});
} finally { await b.close(); }
if (noise.length) { ok = false; console.log(`noise:\n${noise.slice(0, 10).join('\n')}`); }
console.log(ok ? 'CLANWAR PASS' : 'CLANWAR FAIL');
process.exit(ok ? 0 : 1);
