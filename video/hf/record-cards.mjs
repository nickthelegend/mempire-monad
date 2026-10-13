// Records hf/pitch.html?card=N for each card at 1920×1080.
import { renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../app/node_modules/playwright/index.mjs';
const HERE = fileURLToPath(new URL('./', import.meta.url));
const b = await chromium.launch({ channel: 'chrome', headless: true });
for (const [n, secs] of [[1, 11], [3, 12], [4, 15], [5, 10]]) {
  const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: HERE, size: { width: 1920, height: 1080 } } });
  const p = await ctx.newPage(); await p.goto(`file://${HERE}pitch.html?card=${n}`); await p.waitForTimeout(secs * 1000);
  const v = p.video(); await ctx.close(); renameSync(await v.path(), `${HERE}card${n}.webm`); console.log('card', n);
}
await b.close();
