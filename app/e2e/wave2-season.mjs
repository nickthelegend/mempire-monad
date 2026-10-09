/**
 * The season pass in real Chrome against the local fork stack: a guest buys
 * the pass with $MEMPIRE, wins a staked match, and claims the first tier's
 * golden chest — progress read from the arena, the chest minted on chain.
 *
 *   ./scripts/local-up.sh && node app/e2e/wave2-season.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const APP = 'http://localhost:5181';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = `${ROOT}docs/screens/wave2/`;
const dep = JSON.parse(readFileSync(`${ROOT}shared/deployments/31337.json`, 'utf8'));
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // anvil #0, local fork only
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const noise = [];
let ok = true;
const assert = (l, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${d ? ` — ${d}` : ''}`); ok &&= c; };
async function page(b, vp, label) {
  const p = await (await b.newContext({ viewport: vp })).newPage();
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
async function drop(p, fx) {
  const card = p.getByRole('button', { name: /^Deploy / }).first();
  const cb = await card.boundingBox({ timeout: 2000 }).catch(() => null);
  const cv = await p.locator('canvas').first().boundingBox({ timeout: 2000 }).catch(() => null);
  if (!cb || !cv) return;
  await p.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await p.mouse.down();
  await p.mouse.move(cv.x + cv.width * fx, cv.y + cv.height * 0.62, { steps: 6 });
  await p.mouse.up();
}
const b = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const A = await page(b, { width: 390, height: 844 }, 'A');
  const B = await page(b, { width: 390, height: 844 }, 'B');
  await guest(A); await guest(B);
  execFileSync('cast', ['send', dep.token, 'transfer(address,uint256)', A.addr, '300000000000000000000', '--private-key', DEPLOYER, '--rpc-url', 'http://127.0.0.1:8612'], { stdio: 'ignore' });

  // Buy the pass.
  await A.goto(`${APP}/#/cards`);
  await A.reload();
  const panel = A.locator('section[aria-label="Season pass"]');
  await panel.waitFor({ timeout: 30_000 });
  await panel.getByRole('button', { name: /Buy pass/ }).waitFor({ timeout: 30_000 });
  await panel.scrollIntoViewIfNeeded();
  await A.screenshot({ path: `${OUT}season-before-mobile.png` });
  await panel.getByRole('button', { name: /Buy pass/ }).click();
  await panel.getByText(/staked wins? since you bought the pass/).waitFor({ timeout: 60_000 });
  console.log('pass bought:', (await panel.innerText()).replace(/\n/g, ' | ').slice(0, 160));

  // Win a staked match: A attacks, B does not.
  for (const p of [A, B]) {
    await p.goto(APP);
    await sleep(2500);
    await p.getByRole('radiogroup', { name: 'Stake currency' }).getByText('MON', { exact: true }).click();
    await sleep(600);
  }
  await A.getByRole('button', { name: 'Ranked' }).click({ force: true });
  await B.getByRole('button', { name: 'Ranked' }).click({ force: true });
  await A.waitForURL(/#\/battle/, { timeout: 90_000 });
  const t0 = Date.now();
  while (Date.now() - t0 < 5 * 60_000) {
    if (/Pot Secured|Rekt|Split|Voided/i.test(await A.locator('main').innerText().catch(() => ''))) break;
    await drop(A, 0.32); await sleep(1500); await drop(A, 0.68); await sleep(1500);
  }
  const body = await A.locator('body').innerText().catch(() => '');
  const result = body.match(/Pot Secured|Rekt|Split|Voided/i)?.[0];
  if (!result) {
    console.log('no result after the match loop; at', A.url(), '—', body.replace(/\n/g, ' | ').slice(0, 300));
    await A.screenshot({ path: `${OUT}_debug-season.png` });
  }
  console.log('result:', result);
  // Wait for settlement on chain, then claim.
  await A.getByText(/Chest granted on chain|PAID/i).first().waitFor({ timeout: 120_000 }).catch(() => {});
  await A.goto(`${APP}/#/cards`);
  await A.reload();
  await panel.waitFor({ timeout: 30_000 });
  await panel.getByRole('button', { name: 'Claim chest' }).first().waitFor({ timeout: 60_000 });
  await panel.scrollIntoViewIfNeeded();
  await A.screenshot({ path: `${OUT}season-progress-mobile.png` });
  assert('one staked win since buying unlocks tier 1', /Pot Secured/i.test(result ?? '') && /1 staked win since you bought/.test(await panel.innerText()), result);
  await panel.getByRole('button', { name: 'Claim chest' }).first().click();
  await panel.getByText('✓ claimed').first().waitFor({ timeout: 60_000 });
  await sleep(2500);
  await A.evaluate(() => window.scrollTo(0, 0));
  const chests = (await A.locator('section[aria-label="Chests"]').innerText()).replace(/\n/g, ' | ');
  await A.screenshot({ path: `${OUT}season-claimed-mobile.png` });
  // The chain decides: the tier-1 bit of this player's claimed mask is set.
  const cast = (...a) => execFileSync('cast', ['call', dep.seasonPass, ...a, '--rpc-url', 'http://127.0.0.1:8612'], { encoding: 'utf8' }).trim().split(' ')[0];
  const season = cast('seasonCount()(uint256)');
  const mask = Number(cast('claimedMask(uint256,address)(uint256)', season, A.addr));
  assert('the claim minted a golden chest on chain', /✓ claimed/i.test(await panel.innerText()) && (mask & 1) === 1 && /OPEN|⛓/.test(chests), `claimedMask ${mask}; ${chests.slice(0, 80)}`);
} catch (e) { ok = false; console.log('FAIL', String(e?.stack ?? e).slice(0, 400)); } finally { await b.close(); }
if (noise.length) { ok = false; console.log(`noise:\n${noise.slice(0, 10).join('\n')}`); }
console.log(ok ? 'SEASON PASS' : 'SEASON FAIL');
process.exit(ok ? 0 : 1);
