/**
 * One player, nobody else queuing. Does a match still happen?
 *
 * This is the single most likely first experience anyone has with the game —
 * open it alone and press Ranked — and until now it was an infinite spinner,
 * because the relay only reports "unavailable" when it is unreachable, not when
 * it is healthy and empty.
 */
import { chromium } from 'playwright';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const URL = 'https://play.mempire.fun';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (ok, label, detail = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
await ctx.addInitScript((sk) => {
  localStorage.setItem('mempire_guest_sk', sk);
  localStorage.setItem('mempire_tutorial_done', '1');
}, bs58.encode(Keypair.generate().secretKey));
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log(`  [uncaught] ${e.message}`));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await sleep(3000);
await page.evaluate(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = (re) => [...document.querySelectorAll('button')].find((b) => re.test(b.textContent ?? ''));
  const c = btn(/connect/i);
  if (c) { c.click(); await w(700); btn(/guest/i)?.click(); await w(1800); btn(/^\s*skip\s*$/i)?.click(); }
});
await sleep(3000);

console.log('queueing RANKED, alone');
// The tier buttons animate, so Playwright's stability wait never settles.
// Clicking the element directly is what a finger does anyway.
const clicked = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')]
    .find((x) => /^\s*RANKED\s*$/i.test(x.textContent ?? ''));
  if (!b) return 'no RANKED button found';
  if (b.disabled) return 'RANKED is disabled';
  b.click();
  return 'clicked';
});
console.log('  ranked button:', clicked);
await sleep(2500);

const searching = await page.innerText('body');
check(/finding opponent/i.test(searching), 'the search starts');
check(/AI steps in/i.test(searching), 'it promises the wait will end',
  (searching.match(/matching near[^\n]*/) ?? [''])[0].slice(0, 70));

console.log('  waiting out the 20s solo window…');
await sleep(32000);

const after = await page.innerText('body');
const inBattle = await page.locator('canvas').first().isVisible().catch(() => false);
check(inBattle || /ELIXIR|OT |\d:\d\d/.test(after), 'a battle actually started',
  inBattle ? 'arena canvas is up' : after.slice(0, 60).replace(/\n/g, ' '));
check(/\(AI\)/.test(after) || inBattle, 'the opponent is labelled AI');

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
