/**
 * Everything the demo shows that only needs one client.
 *
 * Collection, minting, a card's detail, the deck, the shop, buying a chest with
 * $MEMPIRE, opening it against MagicBlock VRF, clans and the ladder.
 *
 * # Why separate from the match
 *
 * `record-pvp.mjs` needs two clients alive at the same moment and moves real
 * SOL; it can fail on matchmaking or the relay socket. These beats cannot. Each
 * one here is recorded as its own clip, so a beat that misbehaves is re-shot on
 * its own instead of forcing a re-run of a five-minute sequence.
 *
 * Every clip is named for the `shot` field in `script.json`, which is what the
 * assembly step matches narration against.
 *
 * Usage:
 *   node record-features.mjs                 # all beats
 *   node record-features.mjs collection deck # only these
 */
import { mkdirSync, readFileSync, renameSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Keypair } from '@solana/web3.js';
import { installInjectedWallet } from './injected-wallet.mjs';

const GAME = process.env.GAME_URL ?? 'https://play.mempire.fun';
const OUT = fileURLToPath(new URL('./.demo-recording/features/', import.meta.url));
const VIEWPORT = { width: 430, height: 932 };

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const log = (...a) => console.log(' ', ...a);

const wallets = () => JSON.parse(readFileSync(new URL('./.demo-wallets.json', import.meta.url), 'utf8'))
  .map((s) => Keypair.fromSecretKey(Uint8Array.from(s)));

/** Tap a bottom-tab by its label. */
const tab = async (page, name) => {
  await page.getByRole('link', { name: new RegExp(`^${name}$`, 'i') }).first().click();
  await sleep(1200);
};

/**
 * Scroll smoothly, in the page, on an easing curve.
 *
 * `mouse.wheel` in a loop is a series of instant jumps with dead air between
 * them: the content teleports 260px, sits still for half a second, teleports
 * again. On video that reads as a stutter, not a scroll.
 *
 * This animates `scrollTop` frame by frame with an ease-in-out, so the list
 * accelerates, travels and settles the way a real flick does. It runs inside
 * the page against whichever element actually scrolls — the app column is a
 * scroll container, not the document, so scrolling `window` moves nothing.
 */
async function browse(page, distance = 900, ms = 2600) {
  await page.evaluate(async ({ distance, ms }) => {
    const scroller = [...document.querySelectorAll('*')]
      .filter((el) => el.scrollHeight > el.clientHeight + 40
        && /auto|scroll/.test(getComputedStyle(el).overflowY))
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
      ?? document.scrollingElement;
    const from = scroller.scrollTop;
    const max = scroller.scrollHeight - scroller.clientHeight;
    const to = Math.min(from + distance, max);
    if (to <= from) return;
    const t0 = performance.now();
    // cubic ease-in-out: slow out of the gate, quick through the middle, soft
    // into the stop. The stop matters most — a linear scroll that just halts
    // is the part that looks robotic.
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    await new Promise((done) => {
      const step = (now) => {
        const t = Math.min((now - t0) / ms, 1);
        scroller.scrollTop = from + (to - from) * ease(t);
        if (t < 1) requestAnimationFrame(step); else done();
      };
      requestAnimationFrame(step);
    });
  }, { distance, ms });
  await sleep(500);
}

/** Each beat records its own context, so each is its own file. */
async function beat(browser, keypair, name, body) {
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  /**
   * `recordVideo.size` must match the viewport.
   *
   * It sets the size of the video canvas; it does not scale the page into it.
   * Asking for 860x1864 around a 430x932 viewport put the app in the top-left
   * quarter of every frame with dead grey filling the rest — which is exactly
   * what shipped, and it ruined every single-client shot in the cut.
   *
   * `deviceScaleFactor: 2` still renders the page at 2x internally, so the
   * captured 430x932 is sharper than a 1x capture would be.
   */
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    recordVideo: { dir, size: VIEWPORT },
  });
  await installInjectedWallet(ctx, keypair);
  const page = await ctx.newPage();
  await page.goto(GAME, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.phantom?.solana?.isConnected, undefined, { timeout: 30_000 });

  /**
   * Dismiss the first-run tutorial, and keep checking.
   *
   * A single attempt right after connect is a race the tutorial usually wins:
   * it mounts once the collection has loaded, which is a round-trip later. When
   * it wins, it sits over the whole screen as a modal and every subsequent
   * click in the beat hits the overlay instead of the app — which is exactly
   * how two chest beats ran to completion, reported "ok", and recorded nothing
   * but a tutorial card over a Cards tab.
   */
  for (let i = 0; i < 6; i += 1) {
    const skip = page.getByRole('button', { name: /^skip$/i }).first();
    if (await skip.isVisible().catch(() => false)) {
      await skip.click({ force: true }).catch(() => {});
      await sleep(500);
    }
    if (!(await page.getByText(/your bags are your army/i).first().isVisible().catch(() => false))) break;
    await sleep(700);
  }
  await sleep(900);

  try {
    await body(page);
    log(`${name} ok`);
  } catch (e) {
    log(`${name} FAILED — ${String(e).split('\n')[0].slice(0, 110)}`);
    await page.screenshot({ path: join(dir, 'fail.png') }).catch(() => {});
  }
  await ctx.close();

  // Playwright names videos by a hash; rename so the assembly can find them.
  const vid = readdirSync(dir).find((f) => f.endsWith('.webm'));
  if (vid) renameSync(join(dir, vid), join(OUT, `${name}.webm`));
}

const BEATS = {
  /** The wallet as a roster: real cards, minted from coins actually held. */
  collection: async (page) => {
    await tab(page, 'Cards');
    await sleep(2500);
    await browse(page, 1400, 5000);
    await sleep(2500);
    await browse(page, 1000, 4500);
    await sleep(3000);
  },

  /** A single fighter: its coin, its level, what staking does. */
  'card-detail': async (page) => {
    await tab(page, 'Cards');
    await sleep(1200);
    await page.locator('button, [role="button"]').filter({ hasText: /^\$/ }).first()
      .click({ timeout: 8000 }).catch(() => {});
    await sleep(3500);
    await browse(page, 700, 2600);
  },

  /** Minting a ninth card — a real transaction, signed by the injected wallet. */
  mint: async (page) => {
    await tab(page, 'Cards');
    await sleep(1200);
    const mintBtn = page.getByRole('button', { name: /mint/i }).first();
    await mintBtn.click({ timeout: 10_000 });
    await sleep(1500);
    // Confirm, if the flow asks.
    const confirm = page.getByRole('button', { name: /confirm|mint/i }).last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click().catch(() => {});
    await sleep(12_000);
  },

  /** Eight cards, eight coins, one deck. */
  deck: async (page) => {
    await tab(page, 'Deck');
    await sleep(3000);
    await browse(page, 800, 3200);
    await sleep(3500);
  },

  /**
   * A chest bought with $MEMPIRE rather than SOL.
   *
   * Chests live in a `section[aria-label="Chests"]` on the **Cards** tab, not
   * on Empire — Empire is the profile and ladder. The first version of this
   * beat opened Empire, found no chest, swallowed the miss because the click
   * was wrapped in `.catch()`, and reported "chest-buy ok" over 28 seconds of
   * a stats screen. Only looking at the frames caught it.
   *
   * The empty slot is labelled with its own price, so the control says out loud
   * what the narration claims: "buy a golden chest for 100 $MEMPIRE".
   */
  'chest-buy': async (page) => {
    await tab(page, 'Cards');
    await sleep(1200);
    await page.locator('section[aria-label="Chests"]').first()
      .scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});
    await sleep(1800);
    await page.getByRole('button', { name: /buy a golden chest/i }).first()
      .click({ force: true, timeout: 8000 });
    await sleep(2500);
    // The spend confirmation states the price and the balance before signing.
    await page.getByRole('button', { name: /confirm|buy|spend|unlock/i }).last()
      .click({ force: true, timeout: 8000 }).catch(() => {});
    await sleep(9000);
  },

  /**
   * The drop, rolled by MagicBlock VRF on the rollup rather than on device.
   *
   * The badge reading "Rolled by MagicBlock VRF — provably fair" is the single
   * most useful frame in the whole video for a MagicBlock judge, so this beat
   * exists to put it on screen and hold it.
   */
  'chest-open': async (page) => {
    await tab(page, 'Cards');
    await sleep(1200);
    await page.locator('section[aria-label="Chests"]').first()
      .scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});
    await sleep(1500);
    // Skip the timer if one is running — a chest counting down is not a shot.
    const skip = page.getByRole('button', { name: /^skip .*\$MEMPIRE/i }).first();
    if (await skip.isVisible().catch(() => false)) {
      await skip.click({ force: true }).catch(() => {});
      await sleep(1800);
      await page.getByRole('button', { name: /confirm|spend|skip/i }).last()
        .click({ force: true, timeout: 6000 }).catch(() => {});
      await sleep(8000);
    }
    await page.getByRole('button', { name: /open/i }).first()
      .click({ force: true, timeout: 8000 }).catch(() => {});
    await sleep(10_000);
    // Hold on the VRF badge — the reason this beat is in the video at all.
    await page.getByLabel(/rolled by magicblock vrf/i).first()
      .scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await sleep(5000);
  },

  /**
   * The card the chest actually gave you.
   *
   * The open ceremony shows the chest bursting and a small "$MSFT" pill, then
   * sits on "tap to continue" — so the reward reads as *a chest*, not as the
   * Microsoft card you just won. The card itself only shows up once the
   * ceremony is dismissed and you look at the collection, which the match
   * recording never reached because it ended on the ceremony.
   */
  'msft-card': async (page) => {
    await tab(page, 'Cards');
    await sleep(1500);
    await browse(page, 1300, 3800);
    await sleep(1200);
    const card = page.locator('button, [role="button"]').filter({ hasText: /\$MSFT/i }).first();
    if (await card.isVisible().catch(() => false)) {
      await card.click({ force: true }).catch(() => {});
      await sleep(5500);
      log('opened the $MSFT card');
    } else {
      log('$MSFT not visible — scrolling further');
      await browse(page, 900, 2600);
      await sleep(3000);
    }
    await sleep(2500);
  },


  /**
   * The AMM: $MEMPIRE priced against real USDC, quoted from the pool.
   *
   * Long enough to carry the closing line. The first cut of this clip was 8.5s
   * against an 8.95s outro, so the assembler had nowhere to start but zero and
   * the video ended on a loading screen.
   */
  swap: async (page) => {
    await page.goto(`${GAME}/#/swap`, { waitUntil: 'domcontentloaded' });
    await sleep(5000);
    await browse(page, 900, 3200);
    // Type an amount so the pool quote updates on camera rather than sitting at 0.
    await page.locator('input').first().fill('5').catch(() => {});
    await sleep(4000);
    await browse(page, 500, 2200);
    await sleep(4000);
  },

  /** The home screen, held long enough to open on. */
  'cold-open': async (page) => {
    // Long enough to carry both the queue and the escrow beats — together they
    // read 25s of this clip, and a source shorter than its hold makes the
    // assembler clamp the start to zero, which is the app still loading.
    // (The old `browse(page, 2, 180)` was also the pre-smooth-scroll signature:
    // 2px over 180ms, i.e. no visible movement at all.)
    await sleep(7000);
    await browse(page, 420, 3000);
    await sleep(4500);
    await browse(page, 380, 2600);
    await sleep(5000);
  },

  /** Clans and the ladder — the reasons to come back. */
  clan: async (page) => {
    await tab(page, 'Clan');
    await sleep(2500);
    await browse(page, 900, 3000);
    await tab(page, 'Empire');
    await sleep(2000);
    await browse(page, 900, 3000);
  },

};

async function main() {
  mkdirSync(OUT, { recursive: true });
  const want = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const names = want.length ? want : Object.keys(BEATS);
  const [ka] = wallets();
  const browser = await chromium.launch({
    headless: false,
    args: ['--enable-gpu', '--disable-dev-shm-usage', '--disable-renderer-backgrounding'],
  });

  try {
    for (const name of names) {
      if (!BEATS[name]) { log(`unknown beat: ${name}`); continue; }
      await beat(browser, ka, name, BEATS[name]);
    }
  } finally {
    // Always, even on a throw — a leaked headed Chromium keeps its GPU memory
    // and makes the next run more likely to lose a context, not less.
    await browser.close().catch(() => {});
  }
  log(`\n  clips: ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
