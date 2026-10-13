/**
 * Records the live demo on Monad testnet for the Metropolis video: two windows
 * (A desktop, B phone) on the hosted app, driven like a player would, with an
 * injected cursor that glides and ripples on click. Writes
 * captures/A.webm, captures/B.webm and captures/markers.json (seconds from
 * each window's recording start) for the edit.
 *
 *   node video/capture.mjs
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '../app/node_modules/playwright/index.mjs';

const APP = 'https://mempire-monad.vercel.app';
const OUT = fileURLToPath(new URL('./captures/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const markers = { A: [], B: [] };

// A soft gold cursor with a click ripple, drawn in the page so it is in the recording.
const CURSOR = `(() => {
  const add = () => {
    if (document.getElementById('demo-cursor')) return;
    const c = document.createElement('div');
    c.id = 'demo-cursor';
    c.style.cssText = 'position:fixed;left:0;top:0;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;background:rgba(255,206,64,.55);border:3px solid #fff;box-shadow:0 0 0 2px #1b1030,0 4px 14px rgba(0,0,0,.45);z-index:2147483647;pointer-events:none;transition:transform 120ms ease;transform:translate(-100px,-100px)';
    document.documentElement.appendChild(c);
    let x = -100, y = -100;
    addEventListener('mousemove', (e) => { x = e.clientX; y = e.clientY; c.style.transform = 'translate(' + x + 'px,' + y + 'px)'; }, true);
    addEventListener('mousedown', () => {
      c.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(.75)';
      const r = document.createElement('div');
      r.style.cssText = 'position:fixed;left:' + x + 'px;top:' + y + 'px;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:3px solid #ffd54a;z-index:2147483646;pointer-events:none;transition:all 450ms ease-out;opacity:1';
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => { r.style.transform = 'scale(4)'; r.style.opacity = '0'; });
      setTimeout(() => r.remove(), 500);
    }, true);
    addEventListener('mouseup', () => { c.style.transform = 'translate(' + x + 'px,' + y + 'px)'; }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
})();`;

async function win(b, label, vp) {
  const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 1, recordVideo: { dir: OUT, size: vp } });
  await ctx.addInitScript(CURSOR);
  const p = await ctx.newPage();
  p.t0 = Date.now();
  p.label = label;
  p.cur = { x: vp.width / 2, y: vp.height / 2 };
  p.on('console', (m) => { if (/\[escrow\]|\[match\]|voided/i.test(m.text())) console.log(`${label} console: ${m.text().slice(0, 200)}`); });
  p.on('request', (r) => { if (r.url().endsWith('/api/onboard') && r.method() === 'POST') { try { p.addr = JSON.parse(r.postData() ?? '{}').address; } catch { /* */ } } });
  return p;
}
const mark = (p, name) => { const t = (Date.now() - p.t0) / 1000; markers[p.label].push({ name, t }); console.log(`${p.label} ${t.toFixed(1)}s ${name}`); };
async function glide(p, x, y, ms = 700) {
  const steps = Math.max(8, Math.round(ms / 16));
  await p.mouse.move(x, y, { steps });
  p.cur = { x, y };
}
async function clickOn(p, locator, opts = {}) {
  const box = await locator.boundingBox({ timeout: opts.timeout ?? 30_000 });
  if (!box) throw new Error('no box');
  await glide(p, box.x + box.width / 2, box.y + box.height / 2, opts.ms ?? 650);
  await sleep(180);
  await p.mouse.down(); await sleep(90); await p.mouse.up();
}
async function hover(p, locator, ms = 700) {
  const box = await locator.boundingBox({ timeout: 10_000 }).catch(() => null);
  if (box) await glide(p, box.x + box.width / 2, box.y + Math.min(box.height / 2, 40), ms);
}
async function skipTour(p) {
  const s = p.getByRole('button', { name: 'Skip' });
  if (await s.isVisible().catch(() => false)) await clickOn(p, s, { ms: 400 });
}
async function onboard(p) {
  await clickOn(p, p.getByRole('button', { name: 'Play now' }));
  await sleep(900);
  await clickOn(p, p.getByRole('button', { name: /Play as Guest/ }));
  mark(p, 'guest');
  const banner = p.getByText(/Your deck is on chain/i);
  for (let i = 0; i < 60 && !(await banner.isVisible().catch(() => false)); i += 1) {
    await skipTour(p);
    await sleep(1000);
  }
  mark(p, 'deck');
}
async function drop(p, fx) {
  const card = p.getByRole('button', { name: /^Deploy / }).first();
  const cb = await card.boundingBox({ timeout: 2000 }).catch(() => null);
  const cv = await p.locator('canvas').first().boundingBox({ timeout: 2000 }).catch(() => null);
  if (!cb || !cv) return;
  await glide(p, cb.x + cb.width / 2, cb.y + cb.height / 2, 350);
  await p.mouse.down();
  await glide(p, cv.x + cv.width * fx, cv.y + cv.height * 0.62, 450);
  await p.mouse.up();
}

const b = await chromium.launch({ channel: 'chrome', headless: true });
const A = await win(b, 'A', { width: 1360, height: 1016 });
const B = await win(b, 'B', { width: 390, height: 844 });
try {
  // 1 · the landing, Monad's heartbeat live
  await Promise.all([A.goto(APP), B.goto(APP)]);
  await sleep(4000);
  mark(A, 'landing');
  await hover(A, A.locator('[aria-label="Monad testnet block pipeline"]'), 900);
  await sleep(6000);
  // 2 · one tap to a funded account (A on camera; B a few seconds later)
  await onboard(A);
  await sleep(3000);
  await skipTour(A);
  mark(A, 'arena');
  await onboard(B);
  await skipTour(B);
  await hover(A, A.locator('[aria-label="Fighters buffed by today’s market"]').first(), 900).catch(() => {});
  await sleep(2500);
  // 3 · stake 0.01 MON, both queue Rush
  for (const p of [A, B]) {
    await clickOn(p, p.getByRole('radiogroup', { name: 'Stake currency' }).getByText('MON', { exact: true }), { ms: 500 });
    await sleep(700);
  }
  await sleep(6000); // the drip settles for consensus before the stake
  mark(A, 'queue');
  await clickOn(A, A.getByRole('button', { name: 'Ranked' }));
  await sleep(1200);
  await clickOn(B, B.getByRole('button', { name: 'Ranked' }));
  await A.waitForURL(/#\/battle/, { timeout: 180_000 });
  mark(A, 'battle'); mark(B, 'battle');
  // 4 · the match: every card is a Monad transaction
  let result = null; let pills = false;
  for (let i = 0; i < 160 && !result; i += 1) {
    const text = await A.locator('body').innerText().catch(() => '');
    if (!pills && /exec \d+ · final \d+ ms/i.test(text)) { mark(A, 'pills'); pills = true; }
    if (!markers.A.some((m) => m.name === 'tower') && /you [1-3]/i.test((await A.locator('[aria-label^="Crowns:"]').first().getAttribute('aria-label', { timeout: 1000 }).catch(() => '')) ?? '')) mark(A, 'tower');
    result = text.match(/Pot Secured|Rekt|Split|Voided/i)?.[0] ?? null;
    if (!result) { await drop(A, i % 2 ? 0.68 : 0.32); await sleep(1500); }
  }
  mark(A, `result:${result}`);
  await hover(A, A.getByText(/You take|House rake/i).first(), 900).catch(() => {});
  // 5 · settlement lands on chain (the chest line flips to "granted on chain")
  for (let i = 0; i < 30; i += 1) {
    if (/Chest granted on chain|Returned|refunded/i.test(await A.locator('body').innerText().catch(() => ''))) break;
    await sleep(1500);
  }
  mark(A, 'settled');
  await sleep(4000);
  // 5b · replay from the chain, if offered
  const replay = A.getByRole('button', { name: /Replay from the chain/i });
  if (await replay.isVisible().catch(() => false)) {
    await clickOn(A, replay);
    mark(A, 'replay');
    for (let i = 0; i < 50; i += 1) {
      const t = await A.locator('body').innerText().catch(() => '');
      if (/Verified against \d+ on-chain checkpoint/i.test(t)) { mark(A, 'verified'); break; }
      if (/Diverges|posted different states|Can.t rebuild/i.test(t)) { mark(A, 'replay-failed'); break; }
      await sleep(1000);
    }
    await sleep(6000);
  }
  // 6 · Empire: Monad's staking precompile, read live
  await clickOn(A, A.getByRole('link', { name: /Empire/i }).first());
  await sleep(5000);
  mark(A, 'empire');
  await hover(A, A.locator('[aria-label="Monad network"]'), 900).catch(() => {});
  await sleep(5000);
  // 7 · Clans (seeded by the team for the demo)
  await clickOn(A, A.getByRole('link', { name: /Clan/i }).first());
  await sleep(5000);
  mark(A, 'clans');
  await hover(A, A.locator('[aria-label="Clan search results"]'), 900).catch(() => {});
  await sleep(5000);
  mark(A, 'end');
} catch (e) {
  console.log('CAPTURE ERROR', String(e).slice(0, 300));
  mark(A, 'error');
} finally {
  const va = await A.video(); const vb = await B.video();
  await A.context().close(); await B.context().close();
  await b.close();
  renameSync(await va.path(), `${OUT}A.webm`);
  renameSync(await vb.path(), `${OUT}B.webm`);
  writeFileSync(`${OUT}markers.json`, JSON.stringify({ addrA: A.addr, addrB: B.addr, ...markers }, null, 2));
}
