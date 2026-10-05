/**
 * Drive two real clients through the demo and record both.
 *
 * # Why not a screen recording
 *
 * The obvious approach — position two browsers side by side and capture the
 * desktop — needs macOS Screen Recording permission, which this process does
 * not have: `ffmpeg -f avfoundation` blocks forever rather than failing, so it
 * is not something a run can recover from. Playwright records the page itself
 * through CDP and needs no OS permission at all.
 *
 * It also produces a *better* master: two clean 960×1080 streams with no
 * desktop chrome, window borders or cursor artefacts, composited side by side
 * afterwards. That composite is honest — both halves are the same wall-clock
 * session, recorded simultaneously, and the tick counters in the two halves
 * line up frame for frame precisely because they were.
 *
 * # Headed, not headless
 *
 * The arena is WebGL. Headless Chromium falls back to SwiftShader, which
 * renders it correctly but far too slowly to look like a game. Headed uses the
 * real GPU. Video capture works in both.
 *
 * # The wallets
 *
 * `installInjectedWallet` plants a Phantom-shaped provider holding a real
 * keypair, so the app runs its ordinary adapter path and every signature that
 * reaches devnet is genuine. What is skipped is the extension's approval UI,
 * which cannot be driven and is not what the demo is showing.
 *
 * Usage:
 *   node record-demo.mjs --probe      # 20s smoke test, one client, checks the arena renders
 *   node record-demo.mjs              # the full two-client take
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Keypair } from '@solana/web3.js';
import { installInjectedWallet } from './injected-wallet.mjs';

const GAME = process.env.GAME_URL ?? 'https://play.mempire.fun';
// fileURLToPath, not `.pathname` — this project lives under "Extreme SSD" and
// a URL keeps that space percent-encoded, so mkdir would create a literal
// "Extreme%20SSD" directory (or fail trying).
const OUT = fileURLToPath(new URL('./.demo-recording/', import.meta.url));
const PROBE = process.argv.includes('--probe');

/**
 * The app's own column, not half a desktop.
 *
 * Mempire is a mobile-first ~430px column. Recorded at 960 wide it renders that
 * column floating in dead space flanked by the two "ADVERTISE HERE" rails,
 * which only appear at desktop widths and read as unsold inventory rather than
 * a business model. At 430 the rails are not rendered at all and the frame is
 * nothing but game. Two of these composite onto a designed 1920×1080 back-
 * ground, which also matches what the thing actually is: a phone game.
 */
const VIEWPORT = {
  width: Number(process.env.W ?? 430),
  height: Number(process.env.H ?? 932),
};

const wallets = () => JSON.parse(readFileSync(new URL('./.demo-wallets.json', import.meta.url), 'utf8'))
  .map((s) => Keypair.fromSecretKey(Uint8Array.from(s)));

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** A context with a funded wallet already planted, recording to disk. */
async function client(browser, keypair, label) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    recordVideo: { dir: `${OUT}${label}/`, size: VIEWPORT },
  });
  await installInjectedWallet(ctx, keypair);
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [${label}] ${m.text().slice(0, 140)}`);
  });
  await page.goto(GAME, { waitUntil: 'domcontentloaded' });
  return { ctx, page };
}

/** Click the first control whose text matches, without depending on markup. */
async function tap(page, rx, timeout = 15_000) {
  const el = page.getByRole('button', { name: rx }).first();
  await el.waitFor({ state: 'visible', timeout });
  await el.click();
}

/**
 * Wait for the wallet to be live, connecting only if it is not already.
 *
 * The adapter eagerly connects to a provider that is present before the first
 * script runs, which an injected wallet always is — so by the time the page
 * settles there is no "Connect Wallet" button left to click. Waiting for one
 * is what timed the first version out. The connected *state* is the thing
 * worth waiting for; how it got there is incidental.
 */
async function connect(page, label) {
  const live = () => page.evaluate(() => !!window.phantom?.solana?.isConnected);
  if (!(await live())) {
    await tap(page, /connect/i);
    const phantom = page.getByRole('button', { name: /phantom/i }).first();
    if (await phantom.isVisible().catch(() => false)) await phantom.click();
  }
  await page.waitForFunction(() => !!window.phantom?.solana?.isConnected, undefined, { timeout: 20_000 });
  await page.waitForFunction(
    () => !/connect wallet/i.test(document.body.innerText),
    undefined,
    { timeout: 20_000 },
  );
  console.log(`  ${label} connected`);
}

/**
 * Dismiss the first-run tutorial.
 *
 * Four modal cards over the arena on every fresh profile. Worth showing once
 * deliberately, never worth having appear over a match shot.
 */
async function skipTutorial(page) {
  const skip = page.getByRole('button', { name: /^skip$/i }).first();
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

/**
 * Is the arena actually drawing?
 *
 * A canvas that exists proves nothing — a WebGL context that failed to
 * initialise leaves an element of the right size drawing nothing at all.
 *
 * `gl.readPixels` is the obvious check and it is wrong here: the context is
 * created without `preserveDrawingBuffer`, so reading from outside the render
 * loop returns an already-cleared buffer. It reported one single colour over an
 * arena that was in fact fully drawn — a false negative that would have sent me
 * chasing a rendering bug that did not exist.
 *
 * Screenshot byte size is crude and actually discriminating. PNG compresses a
 * flat colour to almost nothing; a stadium, a crowd, a checkerboard field and
 * six towers do not compress. The gap between the two cases is orders of
 * magnitude, not percentage points.
 */
const BLANK_CANVAS_CEILING = 40_000;

async function arenaIsLive(page) {
  const shape = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return { canvas: false };
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    return { canvas: true, gl: !!gl, size: `${c.width}×${c.height}` };
  });
  if (!shape.canvas || !shape.gl) return { ...shape, drawn: false };

  const shot = await page.locator('canvas').first().screenshot();
  return { ...shape, bytes: shot.length, drawn: shot.length > BLANK_CANVAS_CEILING };
}

async function probe() {
  mkdirSync(OUT, { recursive: true });
  const [a] = wallets();
  const browser = await chromium.launch({ headless: false, args: ['--use-gl=angle', '--enable-gpu'] });
  const { ctx, page } = await client(browser, a, 'probe');

  console.log(`  ${GAME}`);
  await connect(page, 'probe');
  await skipTutorial(page);
  await sleep(2000);

  // Practice needs no opponent and no stake — the cheapest way to get the
  // arena on screen and confirm it renders before committing to a full take.
  await tap(page, /practice/i).catch(() => tap(page, /ranked/i));
  await sleep(15_000);

  const live = await arenaIsLive(page);
  console.log('  arena:', JSON.stringify(live));
  await page.screenshot({ path: `${OUT}probe.png` });

  await ctx.close();
  await browser.close();
  console.log(live.drawn
    ? '\n  PASS  the arena renders and is being recorded'
    : '\n  FAIL  arena did not draw');
  process.exitCode = live.drawn ? 0 : 1;
}

async function main() {
  if (PROBE) return probe();
  console.log('full take not wired yet — run --probe first');
}

main().catch((e) => { console.error(e); process.exit(1); });
