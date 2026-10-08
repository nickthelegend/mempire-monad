/**
 * Wave 2 evidence in real Chrome against the local fork stack:
 *  - game feel: damage numbers over hits, and the tower-fall slow-motion with a
 *    camera punch-in, in a real practice match;
 *  - the merge screen (missing from the first contact sheet): golden chests
 *    bought with $MEMPIRE until one duplicates a card, then the merge.
 * Fails on console errors/warnings and page errors (one documented three.js
 * deprecation aside).
 *
 *   ./scripts/local-up.sh && node app/e2e/wave2-feel.mjs
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

const b = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  p.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/THREE\.Clock/.test(m.text())) noise.push(m.text().slice(0, 160)); });
  p.on('pageerror', (e) => noise.push(`pageerror ${String(e).slice(0, 160)}`));
  let addr = null;
  p.on('request', (r) => { if (r.url().endsWith('/api/onboard') && r.method() === 'POST') { try { addr = JSON.parse(r.postData() ?? '{}').address; } catch { /* */ } } });
  await p.goto(APP);
  await p.getByRole('button', { name: 'Play now' }).click();
  await p.getByRole('button', { name: /Play as Guest/ }).click();
  await p.getByText(/Your deck is on chain/i).waitFor({ timeout: 60_000 });
  const skip = p.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();

  console.log('signed in as', addr);
  // ── merge: golden chests until a duplicate, then merge it ──────────────
  execFileSync('cast', ['send', dep.token, 'transfer(address,uint256)', addr, '1000000000000000000000', '--private-key', DEPLOYER, '--rpc-url', 'http://127.0.0.1:8612'], { stdio: 'ignore' });
  await p.goto(`${APP}/#/cards`);
  await p.reload();
  // Wait for the page to read the $MEMPIRE the transfer just sent.
  await p.getByText(/1,000|1000/).first().waitFor({ timeout: 30_000 }).catch(() => {});
  await sleep(1500);
  const merge = p.getByRole('button', { name: /Merge a duplicate into/ }).first();
  for (let i = 0; i < 6 && !(await merge.isVisible().catch(() => false)); i += 1) {
    console.log('chest round', i + 1);
    // Each round from a fresh page: no reveal overlay or stale balance left over.
    await p.reload();
    await sleep(3500);
    const tour = p.getByRole('button', { name: 'Skip' });
    if (await tour.isVisible().catch(() => false)) await tour.click();
    if (await merge.isVisible().catch(() => false)) break;
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.getByRole('button', { name: /Empty chest slot/ }).first().click({ force: true });
    const pay = p.getByRole('button', { name: /Pay 100 \$MEMPIRE/i });
    if (!(await pay.isVisible({ timeout: 10_000 }).catch(() => false))) {
      console.log('no purchase sheet; page says:', (await p.locator('main').innerText()).slice(0, 400).replace(/\n/g, ' | '));
      await p.screenshot({ path: `${OUT}_debug-chest.png` });
      break;
    }
    await pay.click({ force: true });
    await sleep(5000);
    for (let k = 0; k < 8; k += 1) {
      if (await p.getByText(/minted to your collection/i).isVisible().catch(() => false)) break;
      const btn = p.locator('section[aria-label="Chests"]').getByRole('button', { name: /^(OPEN|Open|START|Start|REVEAL|Reveal)$|that chest|too early|wait a moment/ }).first();
      if (await btn.isVisible().catch(() => false)) await btn.click({ force: true });
      await sleep(3500);
    }
    const cont = p.getByText(/tap to continue/i);
    if (await cont.isVisible().catch(() => false)) await cont.click({ force: true });
    await sleep(1500);
  }
  const canMerge = await merge.isVisible().catch(() => false);
  assert('golden chests produced a duplicate to merge', canMerge);
  if (canMerge) {
    await merge.scrollIntoViewIfNeeded();
    const row = await merge.locator('xpath=ancestor::div[1]').innerText().catch(() => '');
    await p.screenshot({ path: `${OUT}merge-before-mobile.png` });
    await merge.click({ force: true });
    // Merging spends $MEMPIRE: the same confirm sheet as a chest purchase.
    const payMerge = p.getByRole('button', { name: /Pay \d+ \$MEMPIRE/i });
    if (await payMerge.isVisible({ timeout: 5000 }).catch(() => false)) await payMerge.click({ force: true });
    await sleep(7000);
    // The chain decides: does this player now hold a level-2 card?
    const out = execFileSync('node', ['-e', `
      import('viem').then(async ({ createPublicClient, http }) => {
        const c = createPublicClient({ transport: http('http://127.0.0.1:8612') });
        const abi = JSON.parse(require('fs').readFileSync('${ROOT}shared/abi/MempireCards.json', 'utf8'));
        const [, d] = await c.readContract({ address: '${dep.cards}', abi, functionName: 'cardsOf', args: ['${addr}'] });
        console.log(Math.max(...d.map((x) => Number(x.level))));
      })`], { cwd: `${ROOT}server`, encoding: 'utf8' }).trim();
    const lv2 = Number(out) >= 2;
    await p.screenshot({ path: `${OUT}merge-after-mobile.png` });
    assert('the merge lands on chain: a card is now level 2', lv2, `max level on chain ${out}; row: ${row.replace(/\n/g, ' ').slice(0, 60)}`);
  }

  console.log('merge part done');
  if (process.env.ONLY_MERGE) { console.log('ONLY_MERGE: skipping the practice part'); throw Object.assign(new Error('only-merge'), { skip: true }); }
  // ── feel: practice until a tower falls ─────────────────────────────────
  await p.setViewportSize({ width: 1440, height: 900 });
  await p.goto(APP);
  await sleep(2500);
  await p.getByRole('button', { name: /Practice/i }).click({ force: true });
  await p.waitForURL(/#\/battle/, { timeout: 60_000 });
  const coach = p.getByRole('button', { name: /Skip coaching/ });
  if (await coach.isVisible({ timeout: 4000 }).catch(() => false)) await coach.click();
  const crowns = p.locator('[aria-label^="Crowns:"]').first();
  const drop = async () => {
    const card = p.getByRole('button', { name: /^Deploy / }).first();
    const cb = await card.boundingBox({ timeout: 2000 }).catch(() => null);
    const cv = await p.locator('canvas').first().boundingBox({ timeout: 2000 }).catch(() => null);
    if (!cb || !cv) return;
    await p.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await p.mouse.down();
    await p.mouse.move(cv.x + cv.width * 0.3, cv.y + cv.height * 0.6, { steps: 6 });
    await p.mouse.up();
  };
  let shotDamage = false;
  let felled = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 4 * 60_000) {
    await drop();
    await sleep(1200);
    if (!shotDamage && Date.now() - t0 > 20_000) { await p.screenshot({ path: `${OUT}feel-damage-numbers-desktop.png` }); shotDamage = true; }
    const label = (await crowns.getAttribute('aria-label', { timeout: 2000 }).catch(() => '')) ?? '';
    console.log('t', Math.round((Date.now() - t0) / 1000), label);
    if (/you [1-3]/.test(label)) {
      await sleep(250); // inside the 1.5 s slow-mo window
      await p.screenshot({ path: `${OUT}feel-tower-fall-slowmo-desktop.png` });
      await p.setViewportSize({ width: 390, height: 844 });
      await sleep(300);
      await p.screenshot({ path: `${OUT}feel-tower-fall-slowmo-mobile.png` });
      felled = true;
      break;
    }
    if (/Pot Secured|Rekt|Split|Practice over|Victory|Defeat/i.test(await p.locator('main').innerText().catch(() => ''))) break;
  }
  assert('a tower fell in the practice (slow-mo frame captured)', felled);
  assert('damage numbers frame captured mid-fight', shotDamage);
} catch (e) { if (!e?.skip) { ok = false; console.log('FAIL', String(e?.stack ?? e).slice(0, 500)); } } finally { await b.close(); }
if (noise.length) { ok = false; console.log(`noise:\n${noise.join('\n')}`); }
console.log(ok ? 'WAVE2 FEEL PASS' : 'WAVE2 FEEL FAIL');
process.exit(ok ? 0 : 1);
