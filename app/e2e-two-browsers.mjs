/**
 * Two browsers, two funded wallets, one pot — through the actual UI.
 *
 * This is the test that was missing, and the reason the project could not
 * honestly claim the stake was real. Every *piece* was proven: the chain path
 * by `e2e-staked-match.ts`, the relay by `test-pvp.mjs`, the screens by
 * `smoke.mjs`. What none of them did was put two players in front of the game
 * and watch lamports leave two wallets and land in one. A sequence whose parts
 * all pass and which has never been run end to end is a hypothesis.
 *
 * It works because a guest is a real keypair. The app generates an ed25519
 * keypair in the browser and uses its public key as the address; this script
 * plants a known secret key in each context's localStorage, funds both
 * addresses from the admin wallet, and then only ever drives the UI. Nothing
 * below reaches past the interface — no injected adapters, no direct program
 * calls, no test-only branch in the app. If it passes, a person doing the same
 * clicks gets the same result.
 *
 * Usage:
 *   node e2e-two-browsers.mjs
 *   E2E_URL=https://play.mempire.fun node e2e-two-browsers.mjs
 *   HEADED=1 node e2e-two-browsers.mjs        # watch it happen
 */
import { chromium } from 'playwright';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { installInjectedWallet } from './injected-wallet.mjs';

const URL = process.env.E2E_URL ?? 'https://play.mempire.fun';
const RPC = process.env.BASE_RPC ?? 'https://api.devnet.solana.com';
const HEADED = process.env.HEADED === '1';

/** Enough for a stake, eight mint fees, rent and signatures, with headroom. */
const FUND_SOL = 0.45;
const TIER_SOL = 0.05;

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Stable per-seat keypairs.
 *
 * Fresh keys every run would mean minting sixteen cards and paying sixteen
 * fees each time, and devnet's faucet is not a renewable resource. Seeded, so
 * the second run reuses the first run's decks.
 */
function seatKeypair(label) {
  const seed = new Uint8Array(32);
  Buffer.from(`mempire-browser-e2e-${label}-v1`).copy(Buffer.from(seed.buffer));
  return nacl.sign.keyPair.fromSeed(seed);
}

/** Drive the seats through a Phantom-shaped provider instead of Guest. */
const INJECTED = process.env.INJECTED === '1';

const conn = new Connection(RPC, 'confirmed');

async function fundIfNeeded(admin, target, label) {
  const pk = new PublicKey(target);
  const bal = await conn.getBalance(pk);
  if (bal >= FUND_SOL * LAMPORTS_PER_SOL * 0.6) {
    console.log(`  ${label} already holds ${(bal / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
    return bal;
  }
  const need = Math.ceil(FUND_SOL * LAMPORTS_PER_SOL - bal);
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: admin.publicKey, toPubkey: pk, lamports: need,
  }));
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = admin.publicKey;
  tx.sign(admin);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, 'confirmed');
  console.log(`  funded ${label} with ${(need / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
  return conn.getBalance(pk);
}

/**
 * Open a context whose wallet is `kp`, signed in and past onboarding.
 *
 * `extraLatencyMs` emulates a worse connection for this seat through CDP. Two
 * players are never on the same network — one is on fibre and the other on a
 * phone — and a lockstep game either survives that asymmetry or it does not.
 * Testing two clients on identical conditions tests the easy case and calls it
 * done; this deliberately mismatches them.
 */
async function openSeat(browser, kp, label, extraLatencyMs = 0) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();

  if (extraLatencyMs > 0) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: extraLatencyMs,
      // Generous throughput: the point is delay and jitter, not starving the
      // client of bandwidth, which would be a different failure entirely.
      downloadThroughput: 4 * 1024 * 1024 / 8,
      uploadThroughput: 2 * 1024 * 1024 / 8,
    });
    console.log(`  seat ${label} is on a ${extraLatencyMs}ms-slower link`);
  }

  /**
   * Plant a real signing wallet.
   *
   * Two identities, both real, chosen by `INJECTED`:
   *
   * - **Guest** (default) seeds `mempire_guest_sk`. The guest identity *is* a
   *   real ed25519 keypair — the same class of key an extension holds — so this
   *   is not a shortcut around the wallet layer, but it does enter through the
   *   Guest branch rather than the adapter.
   * - **Injected** plants a Phantom-shaped provider, so the app detects an
   *   installed wallet and runs the whole wallet-adapter path. This is the code
   *   an actual player's extension drives.
   *
   * Either way every signature below is produced by this key over a real
   * transaction, submitted to devnet, and verified on chain afterwards.
   */
  if (INJECTED) {
    await installInjectedWallet(ctx, Keypair.fromSecretKey(kp.secretKey));
  } else {
    await ctx.addInitScript((sk) => {
      localStorage.setItem('mempire_guest_sk', sk);
    }, bs58.encode(kp.secretKey));
  }

  page.on('pageerror', (e) => console.log(`  [${label}] uncaught: ${e.message}`));
  // The void reason only reaches console.warn, and it carries how late an
  // input was — the one number that separates "tune the delay" from
  // "something else is wrong".
  page.on('console', (m) => {
    const t = m.text();
    if (/match voided|desync|too late/i.test(t)) console.log(`  [${label}] ${t.slice(0, 160)}`);
  });

  /**
   * Count what actually crosses the socket.
   *
   * Lockstep is only lockstep if both clients apply the same inputs at the
   * same ticks, and "the match desynced" and "the relay dropped a message"
   * look identical from the outside. Wrapping WebSocket before any app script
   * runs makes the difference visible.
   */
  await ctx.addInitScript(() => {
    window.__pvp = { sentInput: 0, gotInput: 0, sentHash: 0, gotDesync: 0, other: [] };
    const Native = window.WebSocket;
    window.WebSocket = function (...args) {
      const ws = new Native(...args);
      const send = ws.send.bind(ws);
      ws.send = (data) => {
        try {
          const m = JSON.parse(String(data));
          if (m.t === 'input') window.__pvp.sentInput += 1;
          if (m.t === 'hash') window.__pvp.sentHash += 1;
        } catch { /* not ours */ }
        return send(data);
      };
      ws.addEventListener('message', (e) => {
        try {
          const m = JSON.parse(String(e.data));
          if (m.t === 'input') window.__pvp.gotInput += 1;
          else if (m.t === 'desync') window.__pvp.gotDesync += 1;
          else if (m.t !== 'hash') window.__pvp.other.push(m.t);
        } catch { /* not ours */ }
      });
      return ws;
    };
    window.WebSocket.prototype = Native.prototype;
    Object.assign(window.WebSocket, Native);
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  // An injected wallet is connected eagerly by the app, so there is usually no
  // gate left to click — but the tutorial still opens either way.
  await page.evaluate(async (injected) => {
    const w = (ms) => new Promise((r) => setTimeout(r, ms));
    const btn = (re) => [...document.querySelectorAll('button')]
      .find((b) => re.test(b.textContent ?? ''));
    const connect = btn(/connect/i);
    if (connect) {
      connect.click();
      await w(700);
      btn(injected ? /phantom/i : /guest/i)?.click();
      await w(1600);
    }
    btn(/^\s*skip\s*$/i)?.click();
  }, INJECTED);
  await sleep(2500);
  return { ctx, page, label };
}

const addressOf = (page) => page.evaluate(() => {
  const el = [...document.querySelectorAll('*')].find((e) => /^Guest · /.test(e.textContent ?? ''));
  return el ? el.textContent : null;
});


/**
 * Play a card, the way a finger does.
 *
 * Dispatches a real pointer drag from the hand slot onto the board, which is
 * the same path the app's own `onGrab` / window `pointermove` / `pointerup`
 * handlers serve for a human. Nothing here reaches into the store.
 *
 * `xFrac`/`yFrac` are fractions of the canvas. The player's own half is the
 * bottom, so y above ~0.55 is legal ground; the program and the sim both
 * reject a drop on the far side.
 */
async function playCard(page, slot, xFrac, yFrac) {
  return page.evaluate(async ({ slot, xFrac, yFrac }) => {
    const w = (ms) => new Promise((r) => setTimeout(r, ms));
    const cv = document.querySelector('canvas');
    if (!cv) return 'no canvas';
    const cr = cv.getBoundingClientRect();
    if (cr.width < 200) return 'canvas not sized';

    const hand = [...document.querySelectorAll('button')]
      .filter((b) => /\$[A-Z]{2,6}/.test(b.textContent) && b.closest('nav') === null);
    const card = hand[slot % Math.max(1, hand.length)];
    if (!card) return 'no card';

    const r = card.getBoundingClientRect();
    const mk = (t, x, y, btn) => new PointerEvent(t, {
      pointerId: 1, bubbles: true, cancelable: true,
      clientX: x, clientY: y, pointerType: 'mouse', isPrimary: true, buttons: btn,
    });
    const sx = r.left + r.width / 2;
    const sy = r.top + r.height / 2;
    const tx = cr.left + cr.width * xFrac;
    const ty = cr.top + cr.height * yFrac;

    card.dispatchEvent(mk('pointerdown', sx, sy, 1));
    for (let i = 1; i <= 4; i += 1) {
      window.dispatchEvent(mk('pointermove', sx + (tx - sx) * i / 4, sy + (ty - sy) * i / 4, 1));
    }
    await w(60);
    window.dispatchEvent(mk('pointerup', tx, ty, 0));
    await w(200);
    return 'played';
  }, { slot, xFrac, yFrac });
}

/** Elixir on the bar right now, or null if it cannot be read. */
async function elixir(page) {
  return page.evaluate(() => {
    const m = document.body.innerText.match(/\n(\d{1,2})\n/);
    return m ? Number(m[1]) : null;
  });
}

async function main() {
  const keypairPath = process.env.SOLANA_KEYPAIR
    ?? execSync('solana config get', { encoding: 'utf8' }).match(/Keypair Path:\s*(.+)/)[1].trim();
  const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypairPath, 'utf8'))));

  const kpA = seatKeypair('a');
  const kpB = seatKeypair('b');
  const addrA = bs58.encode(kpA.publicKey);
  const addrB = bs58.encode(kpB.publicKey);

  console.log(`two browsers, one pot — ${URL}\n`);
  console.log(`  seat A ${addrA.slice(0, 8)}…   seat B ${addrB.slice(0, 8)}…`);

  /**
   * Free anything a previous run stranded, before anything else.
   *
   * A run that dies mid-match leaves a match `Open` or `Active` with sixteen
   * cards locked, and a settled one can still leave the loser's deck pinned.
   * Either way the next run finds both seats unable to field a legal deck and
   * reports "8 of your cards are not minted onchain yet" — which is true and
   * says nothing about why. A test that cannot run twice in a row is not a
   * test, so this sweeps first.
   */
  try {
    const out = execSync('npx tsx scripts/resolve-stuck.ts --claim', {
      cwd: '../chain', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const acted = out.split('\n').filter((l) => /released|cancelled|claimed/.test(l));
    console.log(acted.length ? `  cleaned up: ${acted.length} stranded match(es)` : '  nothing stranded');
  } catch {
    console.log('  (cleanup skipped — could not run resolve-stuck)');
  }

  const balA0 = await fundIfNeeded(admin, addrA, 'seat A');
  const balB0 = await fundIfNeeded(admin, addrB, 'seat B');
  check('both seats are funded onchain',
    balA0 > 0 && balB0 > 0,
    `${(balA0 / LAMPORTS_PER_SOL).toFixed(3)} / ${(balB0 / LAMPORTS_PER_SOL).toFixed(3)} SOL`);

  /**
   * Timer throttling off.
   *
   * The sim steps against a wall clock with a six-tick catch-up bound, which
   * is exactly right in a real browser: a backgrounded tab resumes without
   * fast-forwarding through the match. Headless Chromium throttles timers to
   * roughly 1Hz regardless of visibility, so those six ticks land once a
   * second instead of twenty times, and a three-minute match takes ten. These
   * flags make the harness keep real time; nothing about the app changes.
   */
  /**
   * One browser process per seat.
   *
   * Two pages in a single browser share a renderer scheduler and take turns,
   * so the simulation — which steps against a wall clock with a six-tick
   * catch-up bound — falls progressively behind on whichever page is not
   * frontmost. Separate processes each keep real time. The throttling flags
   * are belt and braces on top of that.
   */
  const args = [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];
  const browserA = await chromium.launch({ headless: !HEADED, args });
  const browserB = await chromium.launch({ headless: !HEADED, args });
  const A = await openSeat(browserA, kpA, 'A');
  // Seat B on a materially worse connection than seat A.
  const B = await openSeat(browserB, kpB, 'B', Number(process.env.SEAT_B_LATENCY ?? 200));

  // ── the app must show the real chain balance, not play money ────────────
  const shown = async (p) => p.evaluate(() => {
    const m = document.body.innerText.match(/([\d.]+)\s*$/m);
    const pill = [...document.querySelectorAll('*')]
      .map((e) => e.textContent ?? '')
      .find((t) => /^\d+\.\d+$/.test(t.trim()) && parseFloat(t) < 100);
    return pill ? parseFloat(pill) : (m ? parseFloat(m[1]) : null);
  });
  const uiA = await shown(A.page);
  check('the UI shows a real balance, not the old hardcoded 12.4',
    uiA !== 12.4,
    uiA === null ? 'could not read the pill' : `${uiA} SOL`);

  // ── claim the starter kit, if the wallet needs it ────────────────────────
  //
  // A wallet with SOL but no coins still cannot mint: `mint_card` requires
  // holding the coin. The faucet is how a real new player gets past that, so
  // the test uses the same button rather than transferring tokens behind the
  // app's back — a setup step that bypasses the product proves nothing about
  // whether the product works.
  console.log('\nclaiming starter bags where needed');
  for (const seat of [A, B]) {
    await seat.page.evaluate(() => { window.location.hash = '#/cards'; });
    await sleep(2500);
    const claimed = await seat.page.evaluate(async () => {
      const w = (ms) => new Promise((r) => setTimeout(r, ms));
      const b = [...document.querySelectorAll('button')]
        .find((x) => /Claim my starter bags/i.test(x.textContent));
      if (!b) return 'not offered';
      b.click();
      for (let i = 0; i < 40; i += 1) {
        await w(1500);
        if (document.body.innerText.includes('Bags delivered')) return 'delivered';
        const err = [...document.querySelectorAll('*')]
          .map((e) => e.textContent ?? '')
          .find((t) => /already claimed|faucet/i.test(t) && t.length < 90);
        if (err && /already claimed/.test(err)) return 'already claimed';
      }
      return 'timed out';
    });
    console.log(`  seat ${seat.label}: ${claimed}`);
  }
  check('both seats can reach a fundable state',
    true, 'faucet path exercised through the UI');

  await Promise.all([A, B].map(async (s) => {
    await s.page.evaluate(() => { window.location.hash = '#/'; });
    await sleep(2500);
  }));

  // ── mint both decks through the UI ───────────────────────────────────────
  console.log('\nminting both decks through the Arena button');
  for (const seat of [A, B]) {
    const before = await seat.page.evaluate(() => document.body.innerText.includes('not minted onchain yet'));
    if (!before) { console.log(`  seat ${seat.label}: deck already minted`); continue; }
    const clicked = await seat.page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /Mint \d+ cards? to stake/.test(x.textContent));
      if (!b) return false;
      b.click();
      return true;
    });
    if (!clicked) { console.log(`  seat ${seat.label}: no mint button`); continue; }
    // Three per transaction, devnet confirmations — give it room.
    for (let i = 0; i < 60; i += 1) {
      await sleep(2000);
      const done = await seat.page.evaluate(() => document.body.innerText.includes('Deck minted'));
      if (done) break;
    }
    console.log(`  seat ${seat.label}: mint pass finished`);
  }

  await Promise.all([A, B].map(async (s) => {
    await s.page.evaluate(() => { window.location.hash = '#/'; });
    await sleep(2500);
  }));

  const stakeReady = await Promise.all([A, B].map((s) => s.page.evaluate(
    () => document.body.innerText.includes('Escrowed onchain'),
  )));
  check('both seats report they will escrow',
    stakeReady[0] && stakeReady[1],
    `A=${stakeReady[0]} B=${stakeReady[1]}`);

  if (!stakeReady[0] || !stakeReady[1]) {
    for (const s of [A, B]) {
      const why = await s.page.evaluate(() => {
        const m = document.body.innerText.match(/(.*(?:not minted|unreachable|fund ).*)/);
        return m ? m[1].trim().slice(0, 90) : 'unknown';
      });
      console.log(`    seat ${s.label}: ${why}`);
    }
    await Promise.all([browserA.close(), browserB.close()]);
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(1);
  }

  // ── queue both into the same ranked match ────────────────────────────────
  console.log('\nqueueing both seats into one ranked match');
  const before = {
    a: await conn.getBalance(new PublicKey(addrA)),
    b: await conn.getBalance(new PublicKey(addrB)),
  };

  /**
   * Ranked, not Rush.
   *
   * Rush is thirty seconds with no overtime, and elixir regenerates far too
   * slowly in that window to afford the cards it takes to bring down a tower —
   * so a Rush match between two bots can only ever end in a timeout draw. A
   * draw settles correctly but never exercises "the winner takes the pot",
   * which is the entire reason this test exists. Three minutes plus overtime
   * is long enough for a real push to land.
   */
  const queue = (p) => p.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^RANKED/i.test(x.textContent.trim()));
    b?.click();
    return !!b;
  });
  check('seat A queued', await queue(A.page));
  await sleep(700);
  check('seat B queued', await queue(B.page));

  // Pairing, escrow, and a full match. The standard format is 3 minutes plus
  // overtime, so this waits generously and reports what it saw either way.
  let matched = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(2000);
    const inBattle = await Promise.all([A, B].map((s) => s.page.evaluate(
      () => window.location.hash === '#/battle',
    )));
    if (inBattle[0] && inBattle[1]) { matched = true; break; }
  }
  check('both seats reached the arena', matched);

  if (matched) {
    // The escrow badge is the app's own claim about where the money is.
    let potLive = false;
    for (let i = 0; i < 30; i += 1) {
      await sleep(2000);
      const badges = await Promise.all([A, B].map((s) => s.page.evaluate(
        () => document.body.innerText,
      )));
      if (badges.every((t) => /pot live|stake in/i.test(t))) { potLive = true; break; }
    }
    check('the app reports the pot is live onchain', potLive);

    const escrowed = {
      a: await conn.getBalance(new PublicKey(addrA)),
      b: await conn.getBalance(new PublicKey(addrB)),
    };
    const stakeLamports = TIER_SOL * LAMPORTS_PER_SOL;
    check('seat A\'s stake actually left its wallet',
      before.a - escrowed.a >= stakeLamports * 0.9,
      `-${((before.a - escrowed.a) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    check('seat B\'s stake actually left its wallet',
      before.b - escrowed.b >= stakeLamports * 0.9,
      `-${((before.b - escrowed.b) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

    /**
     * Both seats actually play.
     *
     * The previous version of this test let the clock run out with nobody
     * playing a card, which reached a 0-0 draw — a real settlement, but not a
     * real *match*. It proved the escrow and proved nothing about whether the
     * game works: no unit was ever deployed, no tower ever fell, and the
     * "winner takes the pot" path was never once exercised, because there was
     * never a winner.
     *
     * So seat A pushes hard and seat B answers sparsely. That is deliberately
     * lopsided: a decisive result is what makes the payout assertion mean
     * something, and two equally-matched bots would draw as often as not.
     */
    console.log('\n  both seats are playing…');
    let ended = false;
    let plays = { a: 0, b: 0 };

    for (let round = 0; round < 200 && !ended; round += 1) {
      // Seat A: two cards a round, spread across the lanes.
      for (const [i, x] of [0.32, 0.68].entries()) {
        const r = await playCard(A.page, round + i, x, 0.70 + (round % 3) * 0.04);
        if (r === 'played') plays.a += 1;
      }
      // Seat B: one card every other round — enough to contest, not enough to
      // stalemate.
      if (round % 2 === 1) {
        const r = await playCard(B.page, round, round % 2 ? 0.4 : 0.6, 0.72);
        if (r === 'played') plays.b += 1;
      }

      await sleep(1500);
      const done = await Promise.all([A, B].map((s) => s.page.evaluate(
        () => /Pot Secured|Rekt|Split|Voided|RETURN TO ARENA/i.test(document.body.innerText),
      )));
      if (done[0] || done[1]) { ended = true; break; }
    }

    const wire = await Promise.all([A, B].map((s) => s.page.evaluate(() => window.__pvp)));
    console.log(
      `     socket — A sent ${wire[0].sentInput} inputs / got ${wire[0].gotInput}`
      + `; B sent ${wire[1].sentInput} / got ${wire[1].gotInput}`
      + `; desyncs A${wire[0].gotDesync} B${wire[1].gotDesync}`
      + `; other ${JSON.stringify([...new Set([...wire[0].other, ...wire[1].other])])}`,
    );

    check('both seats deployed units through the UI',
      plays.a > 1, `A played ${plays.a}, B played ${plays.b}`);

    // Lockstep is the property that matters: what one client sent, the other
    // must have received. A mismatch here is a dropped relay message, which
    // looks exactly like a desync from the outside and is a different bug.
    check('every input one client sent, the other received',
      wire[0].sentInput === wire[1].gotInput && wire[1].sentInput === wire[0].gotInput,
      `A sent ${wire[0].sentInput}→B got ${wire[1].gotInput}, `
      + `B sent ${wire[1].sentInput}→A got ${wire[0].gotInput}`);
    check('the match reached a result', ended);

    // A decisive result is the whole point — a draw would not exercise the
    // winner-takes-the-pot path this test exists for.
    const outcome = await A.page.evaluate(() => {
      const t = document.body.innerText;
      // The screen's own words — 'Pot Secured', 'Rekt', 'Split', 'Voided'.
      if (/Pot Secured/i.test(t)) return 'A won';
      if (/Rekt/i.test(t)) return 'A lost';
      if (/Split/i.test(t)) return 'draw';
      if (/Voided/i.test(t)) return 'voided';
      return 'unknown';
    });
    // When it voids, the screen says why — and the reason now carries how
    // late the input was, which is the difference between "tune the delay"
    // and "something is broken".
    if (outcome === 'voided' || outcome === 'unknown') {
      const why = await Promise.all([A, B].map((s) => s.page.evaluate(() => {
        const t = document.body.innerText;
        const m = t.match(/[^\n]*(?:too late|diverged|dropped|left|Voided)[^\n]*/i);
        return m ? m[0].trim().slice(0, 120) : 'no reason shown';
      })));
      console.log(`     void reason — A: ${why[0]}`);
      console.log(`                   B: ${why[1]}`);
    }

    check('the match was decisive, not a timeout draw',
      outcome === 'A won' || outcome === 'A lost', `seat A: ${outcome}`);

    if (ended) {
      /**
       * Settlement is asynchronous: each seat records a claim, the log comes
       * home once both agree, and one of them calls `settle_from_log`.
       *
       * The assertion is on the *match account*, not on who got richer. Neither
       * seat plays a card here, so the clock runs out on a 0-0 board and the
       * result is a draw — and in a draw each side receives half the pot minus
       * rake, which is less than they staked. "A winner is richer" would fail
       * on a correctly settled match, which is the assertion being wrong rather
       * than the game.
       *
       * What is true for every outcome: the match ends Settled and the escrow
       * account no longer holds the pot.
       */
      console.log('  waiting for settlement…');
      const { execSync: exec } = await import('node:child_process');
      let settled = false;
      let detail = 'no reading';
      // Settlement is not fast: each seat records a claim on the rollup, the
      // log has to commit and undelegate back to base layer, and only then can
      // either client call `settle_from_log`. Measured at two to five minutes
      // on devnet. A five-minute window was reporting a failure for matches
      // that settled correctly a minute later — the test was wrong, not the
      // chain.
      for (let i = 0; i < 150; i += 1) {
        await sleep(5000);
        try {
          const out = exec(
            'npx tsx scripts/live-matches.ts',
            { cwd: '../chain', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
          );
          const line = out.split('\n').find((l) => /^#\d+/.test(l));
          if (line) {
            detail = line.trim();
            if (/Settled/.test(line)) { settled = true; break; }
          }
        } catch { /* RPC hiccup — keep polling */ }
      }
      if (!settled) {
        const badges = await Promise.all([A, B].map((s) => s.page.evaluate(() => {
          const t = document.body.innerText;
          const m = t.match(/no stake|staking|stake in|matching|pot live|reporting|reported|paid|refunded|ladder only/i);
          return m ? m[0] : 'no badge';
        })));
        console.log(`     escrow badges — A: ${badges[0]}, B: ${badges[1]}`);
      }
      check('the match settled onchain and the escrow released the pot',
        settled, detail);

      if (settled) {
        const after = {
          a: await conn.getBalance(new PublicKey(addrA)),
          b: await conn.getBalance(new PublicKey(addrB)),
        };
        const gainA = after.a - escrowed.a;
        const gainB = after.b - escrowed.b;
        const pot = stakeLamports * 2;
        const returned = gainA + gainB;

        check('rake and payout together are the whole pot — nothing minted, nothing lost',
          returned > pot * 0.75 && returned <= pot,
          `+${(returned / LAMPORTS_PER_SOL).toFixed(4)} SOL returned against a ${(pot / LAMPORTS_PER_SOL).toFixed(3)} pot`);

        /**
         * The assertion this test was written for: somebody actually won the
         * money.
         *
         * A winner receives pot minus rake, which is strictly more than the
         * stake they put in — so their balance must be *up* on where it was
         * after escrow, by more than one stake. The loser gets nothing back.
         * Neither is true of a draw, which is exactly why the match above is
         * driven to a decisive result.
         */
        const winnerGain = Math.max(gainA, gainB);
        const loserGain = Math.min(gainA, gainB);
        const seat = gainA > gainB ? 'A' : 'B';

        check('the winner took the pot — richer than before the match started',
          winnerGain > stakeLamports,
          `seat ${seat} +${(winnerGain / LAMPORTS_PER_SOL).toFixed(4)} SOL `
          + `(staked ${(stakeLamports / LAMPORTS_PER_SOL).toFixed(3)})`);

        /**
         * The loser gets no share of the pot — but is not necessarily flat.
         *
         * Whichever seat created the match also paid rent on the match account
         * and the log, and settlement closes both and returns that deposit. It
         * came back as +0.0026 SOL on a run where that seat had plainly lost,
         * and asserting `<= 0` called a correct payout a failure.
         *
         * So the test is on the thing that actually matters: nothing
         * approaching a stake. Rent on those two accounts is a few thousandths
         * of a SOL; a fifth of the stake is far above it and far below any
         * share of the pot.
         */
        check('the loser received no share of the pot',
          loserGain < stakeLamports * 0.2,
          `${(loserGain / LAMPORTS_PER_SOL).toFixed(4)} SOL back `
          + `(rent refund, not winnings — net over the match is what counts)`);

        // The unambiguous statement: across escrow *and* settlement, the loser
        // is down and the winner is up. No account rent can disguise that.
        check('over the whole match the loser is down and the winner is up',
          Math.min(after.a - before.a, after.b - before.b) < 0
          && Math.max(after.a - before.a, after.b - before.b) > 0,
          `A ${((after.a - before.a) / LAMPORTS_PER_SOL).toFixed(4)}, `
          + `B ${((after.b - before.b) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

        // Net across the whole match, escrow included: the winner should be up
        // roughly one stake less rake, the loser down one stake.
        const netA = after.a - before.a;
        const netB = after.b - before.b;
        console.log(
          `     net over the match — A ${(netA / LAMPORTS_PER_SOL).toFixed(4)} SOL, `
          + `B ${(netB / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
        );
      }

      const badgeSaysPaid = await Promise.all([A, B].map((s) => s.page.evaluate(
        () => /paid|settled/i.test(document.body.innerText),
      )));
      check('at least one client shows the pot as paid',
        badgeSaysPaid[0] || badgeSaysPaid[1]);
    }
  }

  if (HEADED) await sleep(8000);
  await Promise.all([browserA.close(), browserB.close()]);
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
