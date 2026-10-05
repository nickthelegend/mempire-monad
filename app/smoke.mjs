/**
 * Boot every screen and fail if any of them crashes.
 *
 * This exists because a hooks-order mistake shipped to production and the
 * whole app rendered "SOMETHING BROKE". The type checker was clean, the build
 * was clean, and `oxlint`'s `react/rules-of-hooks` — configured as an error —
 * did not flag a hook placed after an early `return`. Three green gates and a
 * dead app.
 *
 * So this gate does the only thing that could actually have caught it: it runs
 * the app. It walks each route as a guest, and fails on a React error boundary,
 * an uncaught exception, or a console error. It is deliberately dumb — no
 * assertions about content, because content changes and "did it render at all"
 * does not.
 *
 * Usage:
 *   node smoke.mjs                       # against a local `vite preview`
 *   SMOKE_URL=https://play.mempire.fun node smoke.mjs
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4173';
const ROUTES = ['#/', '#/cards', '#/deck', '#/clan', '#/empire', '#/swap'];

let failures = 0;
const fail = (msg) => { failures += 1; console.log(`  FAIL  ${msg}`); };
const pass = (msg) => console.log(`  PASS  ${msg}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

/** Console errors and uncaught exceptions, collected per route. */
let errors = [];
page.on('pageerror', (e) => errors.push(`uncaught: ${e.message}`));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  // Network noise from a devnet RPC is not an app crash. Anything React says
  // about hooks, rendering or the error boundary is.
  if (/Failed to load resource|net::ERR|429|403/.test(t)) return;
  errors.push(`console: ${t.slice(0, 200)}`);
});

console.log(`smoke: ${URL}\n`);

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await sleep(2500);

// Sign in as a guest so the routes render their real content rather than the
// connect wall — the connect wall would have passed this test happily.
await page.evaluate(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  const connect = [...document.querySelectorAll('button')]
    .find((b) => /connect/i.test(b.textContent));
  if (connect) {
    connect.click();
    await w(600);
    const guest = [...document.querySelectorAll('button')].find((b) => /guest/i.test(b.textContent));
    guest?.click();
    await w(1400);
    const skip = [...document.querySelectorAll('button')]
      .find((b) => /^skip$/i.test(b.textContent.trim()));
    skip?.click();
  }
});
await sleep(1500);

for (const route of ROUTES) {
  errors = [];
  await page.evaluate((r) => { window.location.hash = r; }, route);
  await sleep(1800);

  const text = await page.evaluate(() => document.body.innerText);
  const broke = /SOMETHING BROKE|The arena crashed/i.test(text);
  const empty = text.trim().length < 20;

  if (broke) fail(`${route} — the error boundary caught a crash`);
  else if (empty) fail(`${route} — rendered nothing`);
  else if (errors.length) fail(`${route} — ${errors[0]}`);
  else pass(`${route} — ${text.trim().split('\n')[0].slice(0, 40)}`);
}

// The two overlays that live behind a button rather than a route, and so are
// never reached by walking the hash alone. The AMM sheet is the one that
// shipped broken twice.
errors = [];
await page.evaluate((r) => { window.location.hash = r; }, '#/cards');
await sleep(1500);
const sheetOk = await page.evaluate(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  const pill = [...document.querySelectorAll('button')]
    .find((b) => /\+/.test(b.textContent) && b.textContent.length < 12);
  if (!pill) return 'no crowns pill';
  pill.click();
  await w(900);
  const tab = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '$MEMPIRE');
  if (!tab) return 'no $MEMPIRE tab';
  tab.click();
  await w(1200);
  const host = [...document.querySelectorAll('div')]
    .find((d) => getComputedStyle(d).zIndex === '55');
  if (!host) return 'sheet did not open';
  const over = [...host.querySelectorAll('*')]
    .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).length;
  return over > 0 ? `${over} elements overflow the column` : 'ok';
});
if (sheetOk === 'ok' && !errors.length) pass('crowns + AMM sheet');
else fail(`crowns + AMM sheet — ${sheetOk}${errors.length ? ` · ${errors[0]}` : ''}`);

await browser.close();
console.log(`\n${ROUTES.length + 1 - failures} passed, ${failures} failed\n`);
process.exit(failures ? 1 : 0);
