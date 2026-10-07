/**
 * Monad-native evidence in real Chrome: Empire's "Monad network" panel reads
 * native staking live from Monad testnet (0x…1000 via Multicall3) and has a
 * passkey signature verified by Monad's P256 precompile (0x…0100) — with a
 * tampered copy refused. Runs a CDP virtual authenticator (ES256).
 *
 *   ./scripts/local-up.sh && node app/e2e/wave-monad.mjs
 */
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const APP = 'http://localhost:5181';
const OUT = fileURLToPath(new URL('../../docs/screens/wave/', import.meta.url));
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const noise = [];
let ok = true;
const assert = (l, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${d ? ` — ${d}` : ''}`); ok &&= c; };
const b = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const [size, vp] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const ctx = await b.newContext({ viewport: vp });
    const p = await ctx.newPage();
    p.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/THREE\.Clock/.test(m.text())) noise.push(`${size} ${m.text().slice(0, 160)}`); });
    p.on('pageerror', (e) => noise.push(`${size} pageerror ${String(e).slice(0, 160)}`));
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
    await p.goto(APP);
    await p.getByRole('button', { name: 'Play now' }).click();
    await p.getByRole('button', { name: /Play as Guest/ }).click();
    await p.getByText(/Your deck is on chain/i).waitFor({ timeout: 60_000 });
    await p.goto(`${APP}/#/empire`);
    const panel = p.locator('section[aria-label="Monad network"]');
    await panel.waitFor({ timeout: 20_000 });
    await panel.getByText(/Epoch \d+/).waitFor({ timeout: 30_000 });
    const stake = (await panel.locator('[aria-label="Native staking"]').innerText()).replace(/\n/g, ' ');
    assert(`${size}: live staking read`, /Epoch \d+ .*validator #\d+/.test(stake), stake.slice(0, 120));
    await panel.getByRole('button', { name: /Verify a passkey on Monad/ }).click();
    await panel.getByText(/verified by Monad’s P256 precompile|rejected/).waitFor({ timeout: 30_000 });
    const res = (await panel.locator('[aria-label="Passkey verified by Monad"]').innerText()).replace(/\n/g, ' ');
    assert(`${size}: passkey verified by 0x0100, tampered copy refused`, /verified by Monad’s P256 precompile.*tampered copy was refused/i.test(res), res.slice(0, 160));
    await panel.scrollIntoViewIfNeeded();
    await sleep(500);
    await p.screenshot({ path: `${OUT}m-network-panel-${size}.png` });
    await ctx.close();
  }
} catch (e) { ok = false; console.log('FAIL', String(e?.stack ?? e).slice(0, 400)); } finally { await b.close(); }
if (noise.length) { ok = false; console.log(`noise:\n${noise.join('\n')}`); }
console.log(ok ? 'MONAD PANEL PASS' : 'MONAD PANEL FAIL');
process.exit(ok ? 0 : 1);
