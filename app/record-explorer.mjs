/**
 * Record Solana Explorer showing the on-chain life of the match in the video.
 *
 * # Why these transactions and not examples
 *
 * These are the transactions of match #61 — the match the viewer just watched.
 * "Here is the match you saw, on chain" is a different claim from "here is a
 * delegation we did once", and it is the one a judge can actually follow: the
 * pot they watched move has a signature.
 *
 * The order is the MagicBlock lifecycle itself: the log is created on Solana,
 * delegated to an ephemeral rollup, played on, committed back, and the pot is
 * settled from it.
 *
 * Recorded at desktop width because that is what the explorer is built for —
 * the mobile layout hides the instruction breakdown, which is the only part
 * worth filming.
 *
 * Run: node record-explorer.mjs
 */
import { mkdirSync, renameSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chromium } from 'playwright';

const OUT = fileURLToPath(new URL('./.demo-recording/explorer/', import.meta.url));
const VIEWPORT = { width: 1280, height: 900 };
const CLUSTER = 'devnet';

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const log = (...a) => console.log(' ', ...a);

/** Match #61, in the order the program touched it. */
const SHOTS = [
  {
    name: 'delegate',
    sig: '5A7moXg7XC6yxg9e6YDz1G47wzb71kWdh4oAPDBT9vAmbd5n2DNrdCvUDH4NjvwWDmqEvRcoggAnNHAsvA82G5T5',
    note: 'DelegateMatchLog — the match log handed to a MagicBlock ephemeral rollup',
  },
  {
    name: 'undelegate',
    sig: '5QGmgGeVCxwtG23NLRTMoahKNBs5KJmSciES9vjaNJAXTi3eQ9hAGk3pkTuB8FJDoSf3jFAf3jbp1CeoqZG9vV5E',
    note: 'ProcessUndelegation — the rollup commits the final state back to Solana',
  },
  {
    name: 'settle',
    sig: '3WEMNgSN36H42vZEXFtcpVnQ4f9A3smwZh44BzsGBHNXVmgYCeJ3ApJJpFSdYwT3BujtgjRtaLMfP7pQACsiCWYX',
    note: 'SettleFromLog — the program pays the winner from the committed log',
  },
  {
    name: 'chests',
    sig: '46gctQi5VbMA6Tgr9EgxZfUkVJtYeMZbnJxTqqrooNvVvrCWwdgyncXBUCjXJ2XZKAQHz5xT6puBTRpiaSN6uDJg',
    note: 'delegate_chests — the chest rail handed to MagicBlock, so rolls happen on the rollup',
  },
  {
    name: 'spend',
    sig: '5m7yuV7stt59DuLGH6DwGnK92NbaaqHzJtXSAzVuqqK4kgm6EjSVKVTmVWLhbX6T4yFpgruL9aDatWvdksXP18JM',
    note: 'the 25 $MEMPIRE skip — Token Balances shows 2000 -> 1975 and the treasury 1825 -> 1850',
  },
];

async function shot(browser, { name, sig, note }) {
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1.5,
    colorScheme: 'dark',
    recordVideo: { dir, size: VIEWPORT },
  });
  const page = await ctx.newPage();
  try {
    await page.goto(`https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}`, {
      waitUntil: 'domcontentloaded', timeout: 60_000,
    });
    // The explorer resolves the transaction after load; the status badge is the
    // signal that there is something worth filming on screen.
    await page.waitForFunction(
      () => /success|finalized|confirmed/i.test(document.body.innerText),
      undefined,
      { timeout: 45_000 },
    ).catch(() => {});
    await sleep(4000);

    /**
     * Walk down the page the way someone reading it would.
     *
     * Smoothly, and long enough to outlast the narration that sits over it —
     * these shots were 15s against an 18s hold, which left the assembler
     * clamping the start to zero and the shot opening on a half-loaded page.
     * Wheel-stepping also stuttered; this eases `scrollY` frame by frame.
     */
    const glide = (px, ms) => page.evaluate(async ({ px, ms }) => {
      const from = window.scrollY;
      const to = Math.min(from + px, document.body.scrollHeight - innerHeight);
      const t0 = performance.now();
      const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
      await new Promise((done) => {
        const step = (now) => {
          const t = Math.min((now - t0) / ms, 1);
          window.scrollTo(0, from + (to - from) * ease(t));
          if (t < 1) requestAnimationFrame(step); else done();
        };
        requestAnimationFrame(step);
      });
    }, { px, ms });

    await sleep(1500);
    await glide(700, 4000);
    await sleep(2500);
    await glide(650, 3500);
    await sleep(4000);

    const seen = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
    const ok = seen.includes(sig.slice(0, 20));
    log(`${name.padEnd(11)} ${ok ? 'shows the signature' : 'SIGNATURE NOT ON PAGE'} — ${note}`);
    await page.screenshot({ path: join(dir, 'frame.png'), fullPage: false });
  } catch (e) {
    log(`${name} FAILED — ${String(e).split('\n')[0].slice(0, 90)}`);
  }
  await ctx.close();
  const vid = readdirSync(dir).find((f) => f.endsWith('.webm'));
  if (vid) renameSync(join(dir, vid), join(OUT, `${name}.webm`));
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-dev-shm-usage'],
  });
  try {
    for (const s of SHOTS) await shot(browser, s);
  } finally {
    await browser.close().catch(() => {});
  }
  log(`\n  clips: ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
