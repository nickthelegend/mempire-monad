/**
 * Spectator mode in real Chrome against the local fork stack: two guests play
 * a MON-staked match; a third player finds it under "Live now" and watches it
 * from the chain, with on-chain checkpoints verified as they arrive.
 *
 *   ./scripts/local-up.sh && node app/e2e/wave2-spectate.mjs
 */
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const APP = 'http://localhost:5181';
const OUT = fileURLToPath(new URL('../../docs/screens/wave2/', import.meta.url));
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const noise = [];
let ok = true;
const assert = (l, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${d ? ` — ${d}` : ''}`); ok &&= c; };
async function page(b, vp, label) {
  const p = await (await b.newContext({ viewport: vp })).newPage();
  p.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/THREE\.Clock/.test(m.text())) noise.push(`${label} ${m.text().slice(0, 160)}`); });
  p.on('pageerror', (e) => noise.push(`${label} pageerror ${String(e).slice(0, 160)}`));
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
  for (const p of [A, B]) { await p.getByRole('radiogroup', { name: 'Stake currency' }).getByText('MON', { exact: true }).click(); await sleep(600); }
  await A.getByRole('button', { name: 'Ranked' }).click({ force: true });
  await B.getByRole('button', { name: 'Ranked' }).click({ force: true });
  await A.waitForURL(/#\/battle/, { timeout: 90_000 });
  console.log('match started');
  const keepPlaying = (async () => { for (let i = 0; i < 40; i += 1) { await drop(A, 0.32); await drop(B, 0.68); await sleep(1800); } })();

  const S = await page(b, { width: 1440, height: 900 }, 'S');
  await guest(S);
  const watch = S.getByRole('button', { name: /Watch match #\d+ live/ }).first();
  await watch.waitFor({ timeout: 30_000 });
  assert('the match is listed under Live now', true, await watch.getAttribute('aria-label'));
  await watch.click();
  const status = S.locator('section[aria-label="Spectator status"]');
  await status.waitFor({ timeout: 60_000 });
  await S.getByText(/[1-9]\d* on-chain checkpoints? matched so far/).waitFor({ timeout: 60_000 });
  await sleep(2000);
  const st = (await status.innerText()).replace(/\n/g, ' | ');
  console.log('status:', st);
  assert('watching live, checkpoints verified as they land', /Live/i.test(st) && /[1-9]\d* on-chain checkpoints? matched so far/.test(st) && !/diverges/.test(st), st.slice(0, 140));
  await S.screenshot({ path: `${OUT}spectate-live-desktop.png` });
  await S.setViewportSize({ width: 390, height: 844 });
  await sleep(1500);
  await S.screenshot({ path: `${OUT}spectate-live-mobile.png` });
  await keepPlaying.catch(() => {});
} catch (e) { ok = false; console.log('FAIL', String(e?.stack ?? e).slice(0, 400)); } finally { await b.close(); }
if (noise.length) { ok = false; console.log(`noise:\n${noise.slice(0, 10).join('\n')}`); }
console.log(ok ? 'SPECTATE PASS' : 'SPECTATE FAIL');
process.exit(ok ? 0 : 1);
