/**
 * Team-seeded demo activity on Monad testnet (13 Oct): real staked matches
 * played through the hosted game client by fresh guest wallets, which the
 * relayer onboards as it would any player. Every match is a real game (the
 * client's sim, real card plays, both seats' claims), so replays work.
 *
 * PAIRS pairs of guests (two at a time) each play MATCHES staked MON Rush
 * matches. Guest keys go to keys/seed-13oct.json (gitignored) for the clan
 * and gasless steps; the match evidence goes to docs/evidence/seed-matches.json.
 *
 *   PAIRS=4 MATCHES=2 node app/e2e/seed-matches.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createPublicClient, http, parseAbiItem } from 'viem';

const APP = 'https://mempire-monad.vercel.app';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PAIRS = Number(process.env.PAIRS ?? 4);
const MATCHES = Number(process.env.MATCHES ?? 2);
const ARENA = '0xec897071929657b898C18513EF85EC8A8f898Ea3';
const chain = createPublicClient({ transport: http('https://monad-testnet.drpc.org') });
const nextMatchId = () => chain.readContract({ address: ARENA, abi: [parseAbiItem('function nextMatchId() view returns (uint64)')], functionName: 'nextMatchId' });
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const KEYS = `${ROOT}keys/seed-13oct.json`;
const keys = existsSync(KEYS) ? JSON.parse(readFileSync(KEYS, 'utf8')) : [];
const evidence = [];

async function page(b, vp) {
  const p = await (await b.newContext({ viewport: vp })).newPage();
  p.on('request', (r) => { if (r.url().endsWith('/api/onboard') && r.method() === 'POST') { try { p.addr = JSON.parse(r.postData() ?? '{}').address; } catch { /* */ } } });
  return p;
}
async function guest(p) {
  await p.goto(APP);
  await p.getByRole('button', { name: 'Play now' }).click();
  await p.getByRole('button', { name: /Play as Guest/ }).click();
  const banner = p.getByText(/Your deck is on chain/i);
  for (let i = 0; i < 60 && !(await banner.isVisible().catch(() => false)); i += 1) {
    const tour = p.getByRole('button', { name: 'Skip' });
    if (await tour.isVisible().catch(() => false)) await tour.click().catch(() => {});
    await sleep(2000);
  }
  const key = await p.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith('mempire_guest_evm_sk'))?.[1] ?? null);
  return { address: p.addr, key };
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
async function match(A, B, label) {
  for (const p of [A, B]) {
    await p.goto(APP);
    await sleep(3000);
    const tour = p.getByRole('button', { name: 'Skip' });
    if (await tour.isVisible().catch(() => false)) await tour.click().catch(() => {});
    await p.getByRole('radiogroup', { name: 'Stake currency' }).getByText('MON', { exact: true }).click();
    await sleep(800);
  }
  await A.getByRole('button', { name: /Rush · 30s/i }).click({ force: true });
  await sleep(1500);
  await B.getByRole('button', { name: /Rush · 30s/i }).click({ force: true });
  await A.waitForURL(/#\/battle/, { timeout: 180_000 });
  let result = null;
  for (let i = 0; i < 100 && !result; i += 1) {
    result = (await A.locator('body').innerText().catch(() => '')).match(/Pot Secured|Rekt|Split|Voided/i)?.[0] ?? null;
    // Both seats play: real games, not a walkover.
    if (!result) { await drop(A, 0.32); await drop(B, 0.68); await sleep(1800); }
  }
  await sleep(15_000); // both claims land
  const escrowed = !/Nothing was escrowed/i.test(await A.locator('body').innerText().catch(() => ''));
  console.log(`${label}: ${result} · escrowed ${escrowed}`);
  return { label, result, escrowed };
}

const b = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const idStart = Number(await nextMatchId());
  for (let wave = 0; wave < PAIRS; wave += 2) {
    const pairs = [];
    for (let k = wave; k < Math.min(wave + 2, PAIRS); k += 1) {
      const A = await page(b, { width: 1280, height: 800 });
      const B = await page(b, { width: 390, height: 844 });
      pairs.push({ k, A, B });
    }
    // Onboard one at a time (the relay's per-IP onboarding limit), then play the pairs in parallel.
    for (const pr of pairs) {
      for (const [seat, p] of [['A', pr.A], ['B', pr.B]]) {
        const g = await guest(p);
        console.log(`pair ${pr.k} ${seat}: ${g.address} key ${g.key ? 'saved' : 'MISSING'}`);
        keys.push({ pair: pr.k, seat, ...g });
        mkdirSync(`${ROOT}keys`, { recursive: true });
        writeFileSync(KEYS, JSON.stringify(keys, null, 2), { mode: 0o600 });
        await sleep(5000);
      }
    }
    await sleep(8000); // the MON drip must be visible to consensus before the stake
    await Promise.all(pairs.map(async (pr) => {
      for (let m = 0; m < MATCHES; m += 1) {
        try { evidence.push({ pair: pr.k, ...(await match(pr.A, pr.B, `pair ${pr.k} match ${m + 1}`)) }); } catch (e) { console.log(`pair ${pr.k} match ${m + 1} FAILED: ${String(e).slice(0, 160)}`); }
      }
    }));
    for (const pr of pairs) { await pr.A.context().close(); await pr.B.context().close(); }
  }
  const idEnd = Number(await nextMatchId());
  console.log(`arena matches ${idStart} → ${idEnd - 1} (${idEnd - idStart} new)`);
  mkdirSync(`${ROOT}docs/evidence`, { recursive: true });
  writeFileSync(`${ROOT}docs/evidence/seed-matches.json`, `${JSON.stringify({ at: new Date().toISOString(), arenaMatchIds: [idStart, idEnd - 1], players: keys.map(({ key, ...k }) => k), matches: evidence }, null, 2)}\n`);
} finally { await b.close(); }
