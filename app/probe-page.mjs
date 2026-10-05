/**
 * What the page actually looks like to Playwright, with the wallet planted.
 *
 * The recorder timed out waiting for a "Connect Wallet" button that plainly
 * exists when the same URL is opened by hand. Something about this context
 * differs — the viewport is 960×1080 rather than a normal desktop shape, a
 * provider is present before the first script runs, and one request 401s. This
 * prints the state rather than guessing which of those it is.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Keypair } from '@solana/web3.js';
import { installInjectedWallet } from './injected-wallet.mjs';

const GAME = process.env.GAME_URL ?? 'https://play.mempire.fun';
const OUT = fileURLToPath(new URL('./.demo-recording/', import.meta.url));
const WITH_WALLET = !process.argv.includes('--no-wallet');
const W = Number(process.env.W ?? 960);
const H = Number(process.env.H ?? 1080);

mkdirSync(OUT, { recursive: true });

const [a] = JSON.parse(readFileSync(new URL('./.demo-wallets.json', import.meta.url), 'utf8'))
  .map((s) => Keypair.fromSecretKey(Uint8Array.from(s)));

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: W, height: H } });
if (WITH_WALLET) await installInjectedWallet(ctx, a);

const page = await ctx.newPage();
const failures = [];
page.on('response', (r) => {
  if (r.status() >= 400) failures.push(`${r.status()} ${r.url().slice(0, 110)}`);
});
page.on('pageerror', (e) => console.log(`  pageerror: ${String(e).slice(0, 160)}`));

await page.goto(GAME, { waitUntil: 'load' });
await page.waitForTimeout(8000);

console.log(`\nviewport ${W}×${H}  wallet=${WITH_WALLET}`);
console.log('\nprovider seen by the page:');
console.log(' ', JSON.stringify(await page.evaluate(() => ({
  phantom: !!window.phantom?.solana,
  isPhantom: !!window.phantom?.solana?.isPhantom,
  flag: !!window.isPhantomInstalled,
  connected: !!window.phantom?.solana?.isConnected,
}))));

console.log('\nbuttons:');
for (const b of await page.getByRole('button').all()) {
  const t = (await b.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const vis = await b.isVisible().catch(() => false);
  if (t) console.log(`  ${vis ? 'visible' : 'hidden '}  "${t.slice(0, 60)}"`);
}

console.log('\nbody text (first 400):');
console.log('  ' + (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ').slice(0, 400));

if (failures.length) {
  console.log('\nfailed requests:');
  for (const f of [...new Set(failures)]) console.log(`  ${f}`);
}

await page.screenshot({ path: `${OUT}probe-${W}x${H}${WITH_WALLET ? '' : '-nowallet'}.png`, fullPage: false });
console.log(`\nshot: ${OUT}probe-${W}x${H}${WITH_WALLET ? '' : '-nowallet'}.png`);

await ctx.close();
await browser.close();
