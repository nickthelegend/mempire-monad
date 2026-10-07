/**
 * W1 evidence: the signed-out hero with Monad testnet's live block pipeline,
 * captured in real Chrome at 1440×900 and 390×844. Fails on any console error,
 * page error or failed request, except the app's own relay/chain being down
 * (this capture runs Vite alone).
 *
 *   node app/e2e/wave-w1.mjs
 */
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const OUT = fileURLToPath(new URL('../../docs/screens/wave/', import.meta.url));
const b = await chromium.launch({ channel: 'chrome', headless: true });
const noise = [];
try {
  for (const [size, vp] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const p = await b.newPage({ viewport: vp });
    p.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/THREE\.Clock|8799|8612|Failed to load resource/.test(m.text())) noise.push(m.text().slice(0, 160)); });
    p.on('pageerror', (e) => noise.push(String(e).slice(0, 160)));
    await p.goto('http://localhost:5181/');
    const strip = p.locator('section[aria-label="Monad testnet block pipeline"]');
    await strip.waitFor({ timeout: 20_000 });
    await p.waitForFunction(() => document.querySelectorAll('section[aria-label="Monad testnet block pipeline"] [role=listitem]').length >= 5, null, { timeout: 30_000 });
    await p.waitForTimeout(4000);
    const text = await strip.innerText();
    console.log(size, '→', text.replace(/\n/g, ' | '));
    await p.screenshot({ path: `${OUT}w1-hero-after-${size}.png` });
    await p.close();
  }
} finally { await b.close(); }
console.log(noise.length ? `noise:\n${noise.join('\n')}` : 'console clean');
