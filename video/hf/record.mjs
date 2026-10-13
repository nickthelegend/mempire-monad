// Records hf/intro.html and hf/outro.html at 1920×1080 as webm.
import { renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../app/node_modules/playwright/index.mjs';
const HERE = fileURLToPath(new URL('./', import.meta.url));
const b = await chromium.launch({ channel: 'chrome', headless: true });
for (const [name, secs] of [['intro', 31.5], ['outro', 7.4]]) {
  const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: HERE, size: { width: 1920, height: 1080 } } });
  const p = await ctx.newPage();
  await p.goto(`file://${HERE}${name}.html`);
  await p.waitForTimeout(secs * 1000);
  const v = p.video(); await ctx.close();
  renameSync(await v.path(), `${HERE}${name}.webm`);
  console.log(name, 'recorded');
}
await b.close();
