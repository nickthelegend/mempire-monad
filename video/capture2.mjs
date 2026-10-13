/**
 * Records the live demo on Monad testnet for the Metropolis video: two windows
 * (A desktop, B phone) on the hosted app, driven like a player would, with an
 * injected cursor that glides and ripples on click. Writes
 * captures2/A.webm, captures2/B.webm and captures2/markers.json (seconds from
 * each window's recording start) for the edit.
 *
 *   node video/capture.mjs
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '../app/node_modules/playwright/index.mjs';

const APP = 'https://mempire-monad.vercel.app';
const OUT = fileURLToPath(new URL('./captures2/', import.meta.url));
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


const PROOF = 'https://mempire-monad.vercel.app/proof.html?tx='
  + ['Chainlink CRE writes the market meta~0x26b6bc97009aa299dc52590803d7d15a62e9ae4a5278857e255c89bb444bb219',
     'Pyth-priced mint (BTC card)~0x313623fdcef0eb2423ce822aa34812f59efe0df0a06671425f84551a1968886a',
     'Gasless chest: EIP-7702 + our paymaster~0xb0cec249b2b13f0b878abb3c181d8e541070f55a6f6cabb5e45aac818572cc59']
    .map((x) => { const [l, h] = x.split('~'); return `${encodeURIComponent(l)}~${h}`; }).join(',');
async function passkeyAuth(ctx, page) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true,
  } });
}
const b = await chromium.launch({ channel: 'chrome', headless: true });
const A = await win(b, 'A', { width: 1100, height: 1016 });
const B = await win(b, 'B', { width: 390, height: 844 });
await passkeyAuth(A.context(), A);
try {
  await Promise.all([A.goto(APP), B.goto(APP)]);
  await sleep(3500);
  mark(A, 'landing');
  await hover(A, A.locator('[aria-label="Monad testnet block pipeline"]'), 800);
  await sleep(4500);
  // 1 · Mera: a passkey account in one prompt
  await clickOn(A, A.getByRole('button', { name: 'Play now' }));
  await sleep(800);
  const nameBox = A.getByPlaceholder('Player name');
  if (await nameBox.isVisible().catch(() => false)) { await clickOn(A, nameBox, { ms: 400 }); await A.keyboard.type('monad_judge', { delay: 60 }); }
  await clickOn(A, A.getByRole('button', { name: /Create with passkey/ }));
  mark(A, 'passkey');
  const banner = A.getByText(/Your deck is on chain/i);
  for (let i = 0; i < 60 && !(await banner.isVisible().catch(() => false)); i += 1) { await skipTour(A); await sleep(1000); }
  mark(A, 'deck');
  await sleep(2500);
  await skipTour(A);
  // the opponent, a guest on a phone
  await onboard(B); await skipTour(B);
  // 2 · Pyth: mint a fighter at its live price
  await clickOn(A, A.getByRole('link', { name: /Cards/i }).first());
  await sleep(4000); await skipTour(A);
  mark(A, 'cards');
  const mint = A.getByRole('button', { name: /^Mint · 0\.01 MON/ }).first();
  await mint.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(1200);
  await hover(A, mint, 700);
  await sleep(800);
  await clickOn(A, mint, { ms: 300 });
  mark(A, 'mint');
  for (let i = 0; i < 25; i += 1) { if (!/Minting/.test(await A.locator('main').innerText().catch(() => ''))) break; await sleep(1000); }
  await sleep(3000);
  mark(A, 'minted');
  // 3 · a staked match
  await clickOn(A, A.getByRole('link', { name: /Arena/i }).first());
  await sleep(3000); await skipTour(A);
  await B.goto(APP); await sleep(2500); await skipTour(B);
  for (const p of [A, B]) {
    await clickOn(p, p.getByRole('radiogroup', { name: 'Stake currency' }).getByText('MON', { exact: true }), { ms: 450 });
    await sleep(600);
  }
  mark(A, 'stake');
  await hover(A, A.locator('[aria-label="Fighters buffed by today’s market"]').first(), 700).catch(() => {});
  await sleep(2500);
  await clickOn(A, A.getByRole('button', { name: 'Ranked' }));
  await sleep(1200);
  await clickOn(B, B.getByRole('button', { name: 'Ranked' }));
  await A.waitForURL(/#\/battle/, { timeout: 180_000 });
  mark(A, 'battle'); mark(B, 'battle');
  let result = null; let pills = false;
  for (let i = 0; i < 170 && !result; i += 1) {
    const text = await A.locator('body').innerText().catch(() => '');
    if (!pills && /exec \d+ · final \d+ ms/i.test(text)) { mark(A, 'pills'); pills = true; }
    if (!markers.A.some((m) => m.name === 'tower') && /you [1-3]/i.test((await A.locator('[aria-label^="Crowns:"]').first().getAttribute('aria-label', { timeout: 1000 }).catch(() => '')) ?? '')) mark(A, 'tower');
    result = text.match(/Pot Secured|Rekt|Split|Voided/i)?.[0] ?? null;
    if (!result) { await drop(A, i % 2 ? 0.68 : 0.32); await sleep(1400); }
  }
  mark(A, `result:${result}`);
  await hover(A, A.getByText(/You take|House rake/i).first(), 800).catch(() => {});
  for (let i = 0; i < 30; i += 1) { if (/Chest granted on chain/i.test(await A.locator('body').innerText().catch(() => ''))) break; await sleep(1500); }
  mark(A, 'settled');
  await sleep(3500);
  // 4 · clans: join one, see the clan war
  await clickOn(A, A.getByRole('button', { name: /Return to arena/i })).catch(() => {});
  await sleep(2000);
  await clickOn(A, A.getByRole('link', { name: /Clan/i }).first());
  await sleep(4000);
  mark(A, 'clans');
  await clickOn(A, A.getByText('Diamond Hands').first());
  await sleep(2500);
  await clickOn(A, A.getByRole('button', { name: /^Join$/ })).catch(() => {});
  await sleep(6000);
  mark(A, 'joined');
  await hover(A, A.locator('[aria-label="Clan war"]'), 800).catch(() => {});
  await sleep(5000);
  // 5 · Empire: leaderboard, Monad panel, P256 passkey check
  await clickOn(A, A.getByRole('link', { name: /Empire/i }).first());
  await sleep(4500);
  mark(A, 'empire');
  const verify = A.getByRole('button', { name: /Verify a passkey on Monad/ });
  await verify.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(1500);
  await clickOn(A, verify);
  await A.getByText(/verified by Monad/i).first().waitFor({ timeout: 30_000 }).catch(() => {});
  mark(A, 'p256');
  await sleep(4000);
  await hover(A, A.getByText(/Leaderboards/i).first(), 700).catch(() => {});
  await A.getByText(/Leaderboards/i).first().scrollIntoViewIfNeeded().catch(() => {});
  await sleep(4000);
  mark(A, 'leaderboard');
  // 6 · chain proof, read live from the RPC
  await A.goto(PROOF);
  await sleep(6000);
  mark(A, 'proof');
  await A.mouse.wheel(0, 500);
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
