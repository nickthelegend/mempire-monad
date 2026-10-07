/**
 * W4 + W5 evidence in real Chrome against the local fork stack:
 *  - W4: a fresh player's first Practice is coached; the steps advance on the
 *    player's real actions (deploys, crossing the river, tower damage);
 *  - W5: Empire's leaderboards — Trophies, Net $, Net MON, Clans — show real
 *    rows after a staked Rush match and a founded clan.
 * Fails on console errors/warnings, page errors and failed requests (one
 * documented third-party three.js deprecation aside).
 *
 *   ./scripts/local-up.sh && node app/e2e/wave-w4w5.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const APP = 'http://localhost:5181';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = `${ROOT}docs/screens/wave/`;
const dep = JSON.parse(readFileSync(`${ROOT}shared/deployments/31337.json`, 'utf8'));
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // anvil #0, local fork only
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const noise = [];
const KNOWN = (t) => /THREE\.Clock: This module has been deprecated/.test(t);
let ok = true;
const assert = (label, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`); ok &&= cond; };

async function page(browser, vp, label) {
  const p = await (await browser.newContext({ viewport: vp })).newPage();
  p.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !KNOWN(m.text())) noise.push(`${label} ${m.type()}: ${m.text().slice(0, 160)}`); });
  p.on('pageerror', (e) => noise.push(`${label} pageerror: ${String(e).slice(0, 160)}`));
  p.on('response', (r) => { if (r.status() >= 400) noise.push(`${label} ${r.status()} ${r.url()}`); });
  p.on('request', (r) => {
    if (r.url().endsWith('/api/onboard') && r.method() === 'POST') {
      try { p.addr = JSON.parse(r.postData() ?? '{}').address; } catch { /* not json */ }
    }
  });
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
  const cb = await card.boundingBox().catch(() => null);
  const cv = await p.locator('canvas').first().boundingBox().catch(() => null);
  if (!cb || !cv) return;
  await p.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await p.mouse.down();
  await p.mouse.move(cv.x + cv.width * fx, cv.y + cv.height * 0.62, { steps: 8 });
  await p.mouse.up();
}
const coachStep = async (p) => (await p.locator('section[aria-label="Coach"]').innerText().catch(() => '')).replace(/\n/g, ' | ');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  // ── W4: coached first practice ─────────────────────────────────────────
  const A = await page(browser, { width: 390, height: 844 }, 'A');
  await guest(A);
  await A.getByRole('button', { name: /Practice/i }).click({ force: true });
  await A.waitForURL(/#\/battle/, { timeout: 60_000 });
  await A.locator('section[aria-label="Coach"]').waitFor({ timeout: 20_000 });
  await sleep(1500);
  const s1 = await coachStep(A);
  await A.screenshot({ path: `${OUT}w4-coach-step1-mobile.png` });
  assert('coach opens on the first practice at step 1', /1\/4/.test(s1), s1);
  await drop(A, 0.32);
  await sleep(2500);
  const s2 = await coachStep(A);
  assert('a real deploy advances it to step 2', /2\/4/.test(s2), s2);
  let reached = s2;
  for (let i = 0; i < 30 && !/done/i.test(reached); i += 1) {
    await drop(A, 0.32);
    await sleep(2500);
    reached = await coachStep(A);
    if (/3\/4/.test(reached) && i < 30) await A.screenshot({ path: `${OUT}w4-coach-step3-mobile.png` });
  }
  await A.screenshot({ path: `${OUT}w4-coach-done-mobile.png` });
  assert('playing on walks it to the end (river, then tower damage)', /done/i.test(reached), reached);
  if (/done/i.test(reached)) await A.getByRole('button', { name: 'Finish' }).click();
  assert('finishing closes it', !(await A.locator('section[aria-label="Coach"]').isVisible().catch(() => false)));

  // ── W5: data for the boards — a staked ranked Rush and a clan ──────────
  const B = await page(browser, { width: 1440, height: 900 }, 'B');
  const C = await page(browser, { width: 390, height: 844 }, 'C');
  await guest(B);
  await guest(C);
  for (const p of [B, C]) {
    await p.getByRole('radiogroup', { name: 'Stake currency' }).getByText('MON', { exact: true }).click();
    await sleep(800);
  }
  await B.getByRole('button', { name: /Rush · 30s/i }).click({ force: true });
  await C.getByRole('button', { name: /Rush · 30s/i }).click({ force: true });
  await B.waitForURL(/#\/battle/, { timeout: 90_000 });
  for (let i = 0; i < 40; i += 1) {
    if (/Pot Secured|Rekt|Split|Voided/i.test(await B.locator('main').innerText())) break;
    await drop(B, 0.32);
    await sleep(2000);
  }
  // The relay credits money from the chain on the client's `pending` retry.
  for (let i = 0; i < 24; i += 1) {
    const rows = await (await fetch('http://localhost:8799/api/leaderboard?currency=MON')).json();
    if (rows.some((r) => r.netMon)) break;
    await sleep(5000);
  }
  execFileSync('cast', ['send', dep.token, 'transfer(address,uint256)', B.addr, '300000000000000000000',
    '--private-key', DEPLOYER, '--rpc-url', 'http://127.0.0.1:8612'], { stdio: 'ignore' });
  await B.goto(`${APP}/#/clan`);
  await sleep(2500);
  await B.getByRole('button', { name: /Create a clan|Create new/ }).first().click();
  await B.getByPlaceholder('Degen Dynasty').fill(`Judges ${Date.now() % 10000}`);
  await B.getByRole('button', { name: /Found clan/ }).click();
  await sleep(8000);

  // ── W5: the boards ─────────────────────────────────────────────────────
  for (const [p, size] of [[B, 'desktop'], [C, 'mobile']]) {
    await p.goto(`${APP}/#/empire`);
    const boards = p.locator('section[aria-label="Leaderboards"]');
    await boards.waitFor({ timeout: 20_000 });
    for (const tab of ['Trophies', 'Net $', 'Net MON', 'Clans']) {
      await boards.getByRole('tab', { name: tab }).click();
      await sleep(1500);
      const text = (await boards.getByRole('tabpanel').innerText()).replace(/\n/g, ' | ');
      if (size === 'desktop') console.log(`  ${tab}: ${text.slice(0, 140)}`);
      if (tab === 'Net $') assert(`${size}: Net $ lists only dollar movement (none yet: an honest empty state)`, /No dollar pots/.test(text), text.slice(0, 80));
      else assert(`${size}: ${tab} board has real rows`, !/loading|No /.test(text) && text.length > 10, text.slice(0, 80));
      await boards.scrollIntoViewIfNeeded();
      await p.screenshot({ path: `${OUT}w5-board-${tab === 'Net $' ? 'net-usd' : tab.toLowerCase().replace(/\s+/g, '-')}-${size}.png` });
    }
  }
} catch (e) {
  ok = false;
  console.log('FAIL', String(e?.stack ?? e).slice(0, 500));
} finally {
  await browser.close();
}
if (noise.length) { ok = false; console.log(`noise:\n${noise.slice(0, 12).join('\n')}`); }
console.log(ok ? 'W4+W5 PASS' : 'W4+W5 FAIL');
process.exit(ok ? 0 : 1);
