/**
 * The centrepiece shot: two funded wallets, one staked match, both recorded.
 *
 * # Why this is its own script
 *
 * Everything else in the demo is one client doing one thing and can be retried
 * in isolation. This is the only beat that needs both clients alive at the same
 * wall-clock moment, it is the only one that moves real SOL, and it is the only
 * one that can fail for reasons outside this process — matchmaking, the relay
 * socket, the rollup. Keeping it separate means a flaky take here costs one
 * re-run instead of the whole shoot.
 *
 * # How a card gets played
 *
 * `Battle.tsx` treats a pointer-down-up without movement as a tap: the card
 * arms, and the next tap on your half of the arena deploys it there. Two
 * clicks, both visible on camera, and far more robust to drive than a drag
 * whose drop target is a projected 3D position.
 *
 * Hand cards are `button[aria-label="Deploy <name>, <n> elixir"]` and are
 * `disabled` when you cannot afford them, so affordability needs no guessing —
 * the DOM already says.
 *
 * # Seat B queues first
 *
 * The matchmaker falls back to a bot after `SOLO_WAIT_MS` (20s). Whoever
 * queues second must arrive inside that window or they get paired with the
 * computer, which is a fine feature and a terrible thing to film when the whole
 * point of the shot is that two humans are running one simulation.
 *
 * Usage:
 *   node record-pvp.mjs --dry     # no stake: practice tier, checks the plumbing
 *   node record-pvp.mjs           # the real staked take
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Keypair } from '@solana/web3.js';
import { installInjectedWallet } from './injected-wallet.mjs';

const GAME = process.env.GAME_URL ?? 'https://play.mempire.fun';
const OUT = fileURLToPath(new URL('./.demo-recording/pvp/', import.meta.url));
const DRY = process.argv.includes('--dry');
const VIEWPORT = { width: 430, height: 932 };

/** How long to keep fighting once both clients are in the arena. */
const FIGHT_MS = Number(process.env.FIGHT_MS ?? 70_000);

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const log = (...a) => console.log(' ', ...a);

const wallets = () => JSON.parse(readFileSync(new URL('./.demo-wallets.json', import.meta.url), 'utf8'))
  .map((s) => Keypair.fromSecretKey(Uint8Array.from(s)));

async function client(browser, keypair, label) {
  /**
   * `deviceScaleFactor: 1`, deliberately.
   *
   * It was 2, which made each page render into an 860×1864 backing store while
   * `recordVideo.size` captured 430×932 — four times the GPU memory for a file
   * that was never any sharper. With two clients running a WebGL arena at once
   * on a machine already down to ~76 MB free, that is what lost the context:
   * the recording came back with the arena replaced by a flat brown gradient
   * while the HUD kept ticking, so the take looked plausible in a duration log
   * and was unusable on screen.
   *
   * The final frame scales this column 430→498 wide, a 1.16× upscale. Slight
   * softness is a far better trade than an arena that does not draw.
   */
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    recordVideo: { dir: `${OUT}${label}/`, size: VIEWPORT },
  });
  await installInjectedWallet(ctx, keypair);
  const page = await ctx.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !/401|Failed to load resource/.test(t)) log(`[${label}] ${t.slice(0, 120)}`);
  });
  await page.goto(GAME, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.phantom?.solana?.isConnected, undefined, { timeout: 30_000 });
  // The four-card first-run tutorial sits over the arena on a fresh profile.
  const skip = page.getByRole('button', { name: /^skip$/i }).first();
  if (await skip.isVisible().catch(() => false)) await skip.click();

  /**
   * Do not proceed until the client can actually see its own money.
   *
   * The balance comes from the public devnet RPC, which rate-limits hard when
   * two clients boot at once. A 429'd read leaves the app showing `◎ 0`, and a
   * wallet with no *apparent* SOL is refused at the queue with "need 0.05 SOL
   * to enter" — so one seat silently never queued, the other waited out its
   * 20-second solo timer and was paired with the bot. The take looked like a
   * matchmaking failure and was actually a failed balance read on a wallet
   * holding 1.5 SOL.
   *
   * Reloading is the fix that works, because the retry lands after the burst.
   */
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const sol = await page.evaluate(() => {
      const m = document.body.innerText.match(/◎\s*([\d.]+)/);
      return m ? Number(m[1]) : null;
    });
    if (sol && sol > 0) { log(`${label} ready — sees ${sol} SOL`); return { ctx, page, label }; }
    log(`${label} reads no balance (attempt ${attempt + 1}) — reloading`);
    await sleep(6000);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.phantom?.solana?.isConnected, undefined, { timeout: 30_000 });
  }
  log(`${label} never saw a balance — the RPC is not cooperating`);
  return { ctx, page, label };
}

/** Whatever the app currently thinks the match is. Read, never written. */
const matchState = (page) => page.evaluate(() => {
  const s = window.__mempire?.match ?? null;
  if (s) return s;
  const text = document.body.innerText;
  return {
    inArena: /elixir|deploy|drag a card/i.test(text),
    text: text.slice(0, 200),
  };
});

/**
 * Deploy one card, if anything is affordable.
 *
 * `x` and `y` are fractions of the viewport so the caller can talk in terms of
 * "middle of my half" rather than pixels.
 */
async function playOne(page, { x, y }) {
  const hand = page.getByRole('button', { name: /^Deploy /i });
  const n = await hand.count();
  for (let i = 0; i < n; i += 1) {
    const card = hand.nth(i);
    if (await card.isDisabled().catch(() => true)) continue;
    await card.click({ timeout: 3000 }).catch(() => {});
    await sleep(120);
    await page.mouse.click(VIEWPORT.width * x, VIEWPORT.height * y);
    return true;
  }
  return false;
}

/**
 * Is the arena still actually drawing?
 *
 * A lost WebGL context does not throw and does not stop the game: the
 * simulation keeps running, the timer keeps counting and the HUD keeps
 * updating, while the canvas renders a flat fallback. Every log said the take
 * succeeded. Only watching it showed three minutes of brown gradient.
 *
 * `webglcontextlost` is the authoritative signal, so the page reports it
 * directly rather than having it inferred from pixels.
 */
async function watchForContextLoss(page, label, state) {
  await page.addInitScript(() => {
    window.__glLost = false;
    document.addEventListener('webglcontextlost', () => { window.__glLost = true; }, true);
  });
  const poll = setInterval(async () => {
    const lost = await page.evaluate(() => window.__glLost === true).catch(() => false);
    if (lost && !state.lost) {
      state.lost = true;
      log(`${label} LOST ITS WEBGL CONTEXT — this take is unusable`);
    }
  }, 4000);
  return () => clearInterval(poll);
}

/**
 * Has the match finished?
 *
 * The result screen offers "Return to Arena"; the arena screen does not. A
 * scoreline alone is not enough — 1–1 is a live overtime, not an ending.
 */
const isOver = (page) => page.evaluate(
  () => /return to arena|victory|defeat|you won|you lost/i.test(document.body.innerText),
).catch(() => false);

/** Elixir, read off the counter the HUD already renders. */
const elixirNow = (page) => page.evaluate(() => {
  const m = document.body.innerText.match(/\n\s*(\d{1,2})\s*\n/g) ?? [];
  const nums = m.map((s) => Number(s.trim())).filter((n) => n >= 0 && n <= 10);
  return nums.length ? Math.max(...nums) : null;
});

/**
 * Push a lane.
 *
 * y 0.55–0.65 of the viewport is between the river and the near towers, which
 * is where a deployment actually threatens something rather than idling in the
 * backfield.
 *
 * # The two seats deliberately play differently
 *
 * The first version had both seats running the identical pattern, and the
 * result was a 0–0 stalemate that ran into overtime: symmetric play means every
 * push meets an equal counter-push in midfield and no tower ever falls. Worse,
 * it got *less* decisive as it got busier — an earlier, sloppier take with 18
 * deployments broke a tower, while 31 apiece produced nothing.
 *
 * So `style` splits them. The aggressor commits everything to one lane, which
 * is how a real push overwhelms a tower; the spreader answers across both and
 * eventually loses the lane it under-defends. That asymmetry is what produces a
 * winner, and the narration needs a tower to fall and a pot to pay out.
 */
async function fight(page, label, untilMs, style) {
  const AGGRO_LANE = 0.30;
  const lanes = [0.30, 0.70];
  let i = 0;
  let played = 0;
  while (Date.now() < untilMs && !(await isOver(page))) {
    const aggro = style === 'aggressor';
    // The aggressor stacks one lane with a little scatter so the units do not
    // pile onto a single point; the spreader alternates.
    const x = aggro ? AGGRO_LANE + ((i % 3) - 1) * 0.05 : lanes[i % 2] + (i % 3 === 0 ? 0.05 : -0.04);
    const y = (aggro ? 0.58 : 0.55) + (i % 4) * 0.025;
    if (await playOne(page, { x, y })) {
      played += 1;
      // A capped bar is wasted elixir. Spend twice — the aggressor doubles down
      // on its lane, the spreader opens the other one.
      if ((await elixirNow(page)) >= 8) {
        await sleep(380);
        const x2 = aggro ? AGGRO_LANE + 0.04 : lanes[(i + 1) % 2] + 0.02;
        if (await playOne(page, { x: x2, y: y + 0.04 })) played += 1;
      }
    }
    i += 1;
    await sleep(900 + (i % 3) * 300);
  }
  log(`${label} deployed ${played} (${style})`);
  return played;
}

/**
 * Free any deck still locked by a previous take.
 *
 * A take that ends before its match does leaves the match `Active`, and an
 * active match holds all sixteen cards. The next run then cannot assemble eight
 * *unlocked* cards, so `onchainDeckIds` returns null and the app quietly drops
 * to "ladder only" — a badge that reads like a stake and means nothing was
 * escrowed. That cost a whole take, and it is invisible unless you go and look
 * at the balances afterwards.
 *
 * Doing it here rather than remembering to do it by hand is the difference
 * between a repeatable shoot and one that silently degrades every run.
 */
function unlockDecks() {
  try {
    const out = execFileSync('npx', ['tsx', 'scripts/resolve-stuck.ts', '--claim'], {
      cwd: fileURLToPath(new URL('../chain/', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const acted = out.split('\n').filter((l) => /claimed|held/.test(l));
    if (acted.length) acted.forEach((l) => log(l.trim()));
    else log('no stranded matches');
  } catch {
    // A claim can legitimately fail — a deadline that has not passed yet. The
    // run continues and the stake badge will say whether it mattered.
    log('could not clear stranded matches (deadline may not have passed)');
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  if (!DRY) unlockDecks();
  const [ka, kb] = wallets();
  // Memory flags, because two WebGL contexts on a loaded machine is exactly the
  // situation that loses one. /dev/shm is small and Chromium falls back to disk
  // rather than dying when told to.
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--enable-gpu',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
  });
  const gl = { A: { lost: false }, B: { lost: false } };

  // Staggered, not simultaneous. Two clients booting together each fire a
  // burst of account reads at the same public RPC, and the second one loses.
  const A = await client(browser, ka, 'A');
  await sleep(8000);
  const B = await client(browser, kb, 'B');

  const stopWatch = [
    await watchForContextLoss(A.page, 'A', gl.A),
    await watchForContextLoss(B.page, 'B', gl.B),
  ];

  /**
   * Stake tier.
   *
   * Matched on text, not accessible name: each tier button renders its crowns
   * and its number, so the name is "♛♛ 0.25" and an anchored /^0\.25$/ never
   * matched. It silently selected nothing and the run staked at the default
   * 0.05 while the log cheerfully claimed Knight — the log is now derived from
   * what actually happened rather than from what was attempted.
   */
  if (!DRY) {
    const want = process.env.TIER ?? '0.25';
    for (const c of [A, B]) {
      const tier = c.page.locator('button').filter({ hasText: new RegExp(`\\b${want}\\b`) }).first();
      c.tierSet = await tier.click({ force: true, timeout: 5000 }).then(() => true).catch(() => false);
    }
    const both = A.tierSet && B.tierSet;
    log(both ? `tier: ${want} SOL each` : `tier: could not select ${want}, staking at the default`);
  }

  /**
   * `MODE=rush` for the ending.
   *
   * Rush is the same staked match on a 30-second clock, and a short match is a
   * *decisive* match: three attempts at the standard format all reached full
   * time level and went to an overtime that then had to be played out, and one
   * of them spent its last minute as an empty field with a capped elixir bar
   * because the fight loop had stopped. Thirty seconds cannot stall like that.
   *
   * The long-format takes are still the better fighting footage — busier field,
   * more units trading. This is for the beat the narration actually needs: a
   * result, and a pot moving to a winner.
   */
  const RUSH = (process.env.MODE ?? '') === 'rush';
  const mode = DRY ? /practice/i : RUSH ? /rush/i : /^ranked$/i;
  if (RUSH) log('format: rush (30s) — staked, and it will actually finish');

  /**
   * `force`, because the buttons breathe.
   *
   * The primary actions run an idle animation, so Playwright's stability check
   * — which waits for two consecutive frames at the same position — never
   * settles and the click times out after 30s having done nothing. It hit A
   * while B, clicking the identical selector a moment earlier, went through:
   * the kind of intermittency that would have been blamed on matchmaking.
   *
   * Skipping the check is right here rather than a shortcut. The button is
   * visible and enabled; only its pixels are moving.
   */
  const queue = (c) => c.page.getByRole('button', { name: mode }).first()
    .click({ force: true, timeout: 15_000 });

  // B first: the matchmaker falls back to a bot 20s after a lone queue, and
  // the entire point of this shot is that the opponent is a person.
  await queue(B);
  log('B queued');
  await sleep(2500);
  await queue(A);
  log('A queued');

  /**
   * Both sign their stake; escrow is two transactions and devnet is not fast.
   *
   * The `undefined` is load-bearing. `waitForFunction(fn, arg, options)` takes
   * the *third* parameter as options, so passing `{ timeout }` second made it
   * an argument to the predicate and left the timeout at its 30s default —
   * every wait in this file was silently a 30s wait, and a take died against a
   * slow-but-succeeding escrow that would have landed at 40.
   */
  const arena = (p) => p.waitForFunction(
    () => /elixir|drag a card|tap your half/i.test(document.body.innerText),
    undefined,
    { timeout: 120_000 },
  );
  // Screenshot whatever is on screen if the arena never arrives — a bare
  // "Timeout 120000ms exceeded" says nothing about whether the match failed to
  // form, the escrow failed to sign, or the page simply sat in a queue.
  try {
    await Promise.all([arena(A.page), arena(B.page)]);
  } catch (e) {
    for (const c of [A, B]) {
      await c.page.screenshot({ path: `${OUT}${c.label}-stuck.png` }).catch(() => {});
      const t = (await c.page.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, ' ');
      log(`${c.label} stuck on: ${t.slice(0, 160)}`);
    }
    throw e;
  }
  log('both in the arena');

  /**
   * Say out loud whether money actually escrowed.
   *
   * When a deck cannot be locked on chain the app falls back to an unstaked
   * match and labels it "LADDER ONLY" — next to the pot size, so the badge
   * reads as `0.5 SOL LADDER ONLY` and looks like a stake at a glance. One take
   * was recorded and reported as staked on exactly that misreading; only the
   * wallet balances gave it away.
   *
   * A shot whose narration is "both players put SOL into escrow" cannot be cut
   * from footage where nobody did, so this is checked while there is still time
   * to abandon the take rather than after the edit.
   */
  const badge = await A.page.evaluate(() => {
    const t = document.body.innerText;
    return /ladder only|no stake/i.test(t) ? 'ladder only' : /pot/i.test(t) ? 'staked' : 'unknown';
  });
  if (badge === 'staked') log('escrow: staked — the pot is real');
  else log(`escrow: ${badge.toUpperCase()} — nothing was escrowed, this take cannot carry the escrow line`);

  const until = Date.now() + FIGHT_MS;
  await Promise.all([
    fight(A.page, 'A', until, 'aggressor'),
    fight(B.page, 'B', until, 'spreader'),
  ]);

  /**
   * Wait for the match to actually end.
   *
   * `fight` now runs until the result screen appears rather than for a fixed
   * span, because stopping early is what broke the last two takes in different
   * ways: one closed the browser with 56s still on the clock, the other reached
   * a 1–1 overtime and then stood still — an overtime with nobody deploying
   * cannot resolve, so it simply ran out its own clock while the recorder
   * waited for an ending it had stopped causing.
   */
  const ended = (p) => p.waitForFunction(
    () => /return to arena|victory|defeat|you won|you lost/i.test(document.body.innerText),
    undefined,
    { timeout: 120_000 },
  );
  log('fighting stopped — waiting for the result screen');
  await Promise.all([ended(A.page), ended(B.page)]).catch(() => log('  (no result screen appeared)'));

  // Settlement is a transaction; give it time to land and be reflected.
  await sleep(15_000);
  for (const c of [A, B]) {
    log(`${c.label} end: ${(await c.page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 150)}`);
  }

  stopWatch.forEach((stop) => stop());

  /**
   * Follow the winner to their chest, in the same session.
   *
   * Winning a match awards a chest, and the result screen says so: "GOLDEN
   * CHEST EARNED — open it on the Cards tab". But that chest lives in the
   * session's store, and every separately-recorded beat opens a fresh browser
   * context with an empty one — which is why the chest rack read "0/4 · WIN TO
   * EARN" in every take shot after the fact, however the click was driven.
   *
   * Recording it here is the only honest way to show a chest that was actually
   * earned, and it happens to be the real player experience: win, collect,
   * open. The assembler takes this stretch from seat A's recording.
   */
  const winner = A;
  try {
    /**
     * The VRF chest, filmed properly.
     *
     * Buying a chest cannot demonstrate VRF — `buyChest` deliberately marks a
     * purchased chest `source: 'local'`, because the provably-fair badge would
     * be claiming something untrue of a tier that was bought rather than
     * rolled. Only a chest *won* in a match goes through the oracle.
     *
     * `rollChestOnchain` requests randomness on the rollup and then polls for
     * the callback for up to 36 seconds. Until it answers, the chest carries
     * its local roll and no badge. Every previous attempt closed the browser
     * inside that window, which is why the rack always read "0/4" and the 🎲
     * never appeared — the chest existed, the oracle simply had not spoken yet.
     */
    const back = winner.page.getByRole('button', { name: /return to arena/i }).first();
    if (await back.isVisible().catch(() => false)) await back.click({ force: true });
    await sleep(2500);
    await winner.page.getByRole('link', { name: /^cards$/i }).first().click({ force: true });
    await sleep(3000);
    await winner.page.locator('section[aria-label="Chests"]').first()
      .scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});

    // Wait for the oracle. The badge is the signal, not a timer.
    const badge = winner.page.getByLabel(/rolled by magicblock vrf/i).first();
    let vrf = false;
    for (let i = 0; i < 20; i += 1) {
      if (await badge.isVisible().catch(() => false)) { vrf = true; break; }
      await sleep(3000);
    }
    log(vrf
      ? 'VRF badge is on the chest — the oracle answered'
      : 'no VRF badge after 60s — chest kept its local roll');

    const rack = await winner.page.evaluate(() => {
      const s = document.querySelector('section[aria-label="Chests"]');
      return s ? s.innerText.replace(/\s+/g, ' ').slice(0, 110) : 'no chest section';
    });
    log(`chest rack: ${rack}`);
    await sleep(4000); // hold on the badge

    /**
     * The button that begins the unlock says START, not UNLOCK.
     *
     * `/^unlock$/i` matched nothing, so the chest sat in the rack untouched and
     * the sequence then reported "no OPEN button — the chest was not ready",
     * which was true and completely misleading about why.
     */
    const start = winner.page.getByRole('button', { name: /^(start|unlock)$/i }).first();
    if (await start.isVisible().catch(() => false)) {
      await start.click({ force: true });
      log('started the chest unlock');
      await sleep(3500);
    } else {
      log('no START button on the chest');
    }

    const skip = winner.page.getByRole('button', { name: /skip .*\$MEMPIRE/i }).first();
    if (await skip.isVisible().catch(() => false)) {
      await skip.click({ force: true });
      await sleep(2500);
      /**
       * Wait for the spend button to become enabled before pressing it.
       *
       * `ConfirmSpend` reads the $MEMPIRE balance over RPC and keeps its button
       * disabled while `checking`, and disabled forever if the read comes back
       * `short`. Clicking the instant the dialog appears therefore did nothing
       * at all — which is precisely how a chest purchase "succeeded" in the log
       * and never happened on screen.
       */
      const pay = winner.page.getByRole('button', { name: /pay|confirm|spend/i }).last();
      for (let i = 0; i < 20; i += 1) {
        if (!(await pay.isDisabled().catch(() => true))) break;
        await sleep(1000);
      }
      if (!(await pay.isDisabled().catch(() => true))) {
        await pay.click({ force: true });
        log('skipped the chest timer with $MEMPIRE');
        await sleep(9000);
      } else {
        log('the spend button never enabled — balance read failed');
      }
    }

    const open = winner.page.getByRole('button', { name: /^open$/i }).first();
    if (await open.isVisible().catch(() => false)) {
      await open.click({ force: true });
      await sleep(6000);
      // The ceremony prints "🎲 VRF seed <hex>" for an oracle-rolled chest.
      const seedLine = await winner.page.evaluate(
        () => (document.body.innerText.match(/(🎲 )?(VRF|local) seed [0-9a-f]+/i) ?? [''])[0],
      );
      log(`ceremony: ${seedLine || '(no seed line found)'}`);
      await sleep(9000);
    } else {
      log('no OPEN button — the chest was not ready');
    }
    await sleep(3000);
    log('chest sequence recorded on seat A');
  } catch (e) {
    log(`chest sequence failed — ${String(e).split('\n')[0].slice(0, 90)}`);
  }

  for (const c of [A, B]) {
    await c.page.screenshot({ path: `${OUT}${c.label}-end.png` });
    await c.ctx.close();
  }
  await browser.close();

  /**
   * A lost context invalidates the take, loudly.
   *
   * The whole reason this run exists is that a previous one recorded three
   * minutes of flat brown gradient while every log line said it had succeeded.
   * A non-zero exit is what stops the assembler from being pointed at it.
   */
  if (gl.A.lost || gl.B.lost) {
    log('\n  FAILED — a WebGL context was lost. Re-run; do not assemble this take.');
    process.exitCode = 1;
    return;
  }
  log(`\n  video: ${OUT}`);
}

/**
 * Always close the browser.
 *
 * Every failed take so far threw past `browser.close()` and left a headed
 * Chromium alive holding its GPU memory, so each retry started with less than
 * the last — which is a fair description of how a machine gets to 76 MB free
 * and starts dropping WebGL contexts.
 */
main().catch(async (e) => {
  console.error(e);
  try {
    const { execSync } = await import('node:child_process');
    execSync('pkill -f "Chrome for Testing" || pkill -f Chromium || true', { stdio: 'ignore' });
  } catch { /* nothing left to kill */ }
  process.exit(1);
});
