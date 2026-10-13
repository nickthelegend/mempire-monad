// Records hf/pitch2.html?card=kN at 1920×1080 for the pitch.
import { renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../app/node_modules/playwright/index.mjs';
const HERE = fileURLToPath(new URL('./', import.meta.url));
const b = await chromium.launch({ channel: 'chrome', headless: true });
for (const [k, secs] of [['k1', 3.2], ['k2', 10], ['k3', 13.5], ['k4', 11], ['k5', 10], ['k6', 16.5], ['k7', 10.5], ['k8', 7.5]]) {
  const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: HERE, size: { width: 1920, height: 1080 } } });
  const p = await ctx.newPage(); await p.goto(`file://${HERE}pitch2.html?card=${k}`); await p.waitForTimeout(secs * 1000 + 300);
  const v = p.video(); await ctx.close(); renameSync(await v.path(), `${HERE}pitch_${k}.webm`); console.log(k);
}
await b.close();
