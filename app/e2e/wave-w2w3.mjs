/**
 * W2 + W3 evidence in real Chrome against the local fork stack:
 *  - W2: during a staked Rush match, each card drop appears in the HUD as a
 *    pill that reaches its receipt ("N ms · fork" on the local fork);
 *  - W3: after settlement, "Replay from the chain" re-runs the match from the
 *    arena's logs and reports it verified against the on-chain checkpoints.
 * Fails on console errors/warnings, page errors and failed requests (one
 * documented third-party three.js deprecation aside).
 *
 *   ./scripts/local-up.sh && node app/e2e/wave-w2w3.mjs
 */
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const APP = 'http://localhost:5181';
const OUT = fileURLToPath(new URL('../../docs/screens/wave/', import.meta.url));
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const noise = [];
const KNOWN = (t) => /THREE\.Clock: This module has been deprecated/.test(t);

async function page(browser, vp, label) {
  const ctx = await browser.newContext({ viewport: vp });
  const p = await ctx.newPage();
  p.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !KNOWN(m.text())) noise.push(`${label} ${m.type()}: ${m.text().slice(0, 160)}`); });
  p.on('pageerror', (e) => noise.push(`${label} pageerror: ${String(e).slice(0, 160)}`));
  p.on('response', (r) => { if (r.status() >= 400) noise.push(`${label} ${r.status()} ${r.url()}`); });
  return p;
}
async function guest(p) {
  await p.goto(APP);
  await p.getByRole('button', { name: 'Play now' }).click();
  await p.getByRole('button', { name: /Play as Guest/ }).click();
  await p.getByText(/Your deck is on chain/i).waitFor({ timeout: 60_000 });
  const skip = p.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await p.getByRole('radiogroup', { name: 'Stake currency' }).getByText('MON', { exact: true }).click();
  await sleep(1500);
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

const browser = await chromium.launch({ channel: 'chrome', headless: true });
let ok = true;
try {
  const A = await page(browser, { width: 1440, height: 900 }, 'A');
  const B = await page(browser, { width: 390, height: 844 }, 'B');
  await guest(A);
  await guest(B);
  await A.getByRole('button', { name: /Rush · 30s/i }).click({ force: true });
  await B.getByRole('button', { name: /Rush · 30s/i }).click({ force: true });
  await A.waitForURL(/#\/battle/, { timeout: 90_000 });
  await sleep(3500);

  // W2: drop cards and wait for their pills to reach a receipt.
  for (let i = 0; i < 3; i += 1) { await drop(A, 0.32); await drop(B, 0.68); await sleep(2200); }
  const ticker = A.getByRole('log', { name: 'Your card plays landing on chain' });
  await ticker.getByText(/ms · fork|final/).first().waitFor({ timeout: 20_000 });
  const pills = await ticker.innerText();
  console.log('W2 ticker (A):', pills.replace(/\n/g, ' '));
  await A.screenshot({ path: `${OUT}w2-ticker-desktop.png` });
  const bTicker = await B.getByRole('log', { name: 'Your card plays landing on chain' }).innerText().catch(() => '');
  console.log('W2 ticker (B):', bTicker.replace(/\n/g, ' '));
  await B.screenshot({ path: `${OUT}w2-ticker-mobile.png` });
  ok &&= /ms · fork/i.test(pills);

  // Play out the Rush, then wait for settlement on chain.
  for (let i = 0; i < 40; i += 1) {
    if (/Pot Secured|Rekt|Split|Voided/i.test(await A.locator('main').innerText())) break;
    await drop(A, 0.32);
    await sleep(2000);
  }
  const replayBtn = A.getByRole('button', { name: /Replay from the chain/ });
  await replayBtn.waitFor({ timeout: 120_000 });
  await A.screenshot({ path: `${OUT}w3-result-replay-button-desktop.png` });

  // W3: open the replay; it must verify against the chain.
  await replayBtn.click();
  const verdict = A.locator('section[aria-label="Replay verification"]');
  try {
    await verdict.waitFor({ timeout: 90_000 });
  } catch (e) {
    console.log('replay page at', A.url(), '→', (await A.locator('body').innerText()).slice(0, 600).replace(/\n/g, ' | '));
    await A.screenshot({ path: `${OUT}_debug-replay.png` });
    throw e;
  }
  const v = await verdict.innerText();
  console.log('W3 verdict:', v.replace(/\n/g, ' | '));
  ok &&= /Verified against \d+ on-chain checkpoint/i.test(v);
  await sleep(6000);
  await A.screenshot({ path: `${OUT}w3-replay-desktop.png` });
  const url = A.url();
  // The same replay at 390px, from a fresh page (any visitor can open it).
  const C = await page(browser, { width: 390, height: 844 }, 'C');
  await C.goto(url);
  await C.locator('section[aria-label="Replay verification"]').waitFor({ timeout: 90_000 });
  await sleep(6000);
  await C.screenshot({ path: `${OUT}w3-replay-mobile.png` });
  console.log('W3 replay url:', url);
} catch (e) {
  ok = false;
  console.log('FAIL', String(e?.stack ?? e).slice(0, 500));
} finally {
  await browser.close();
}
if (noise.length) { ok = false; console.log(`noise:\n${noise.slice(0, 12).join('\n')}`); }
console.log(ok ? 'W2+W3 PASS' : 'W2+W3 FAIL');
process.exit(ok ? 0 : 1);
