// Records the CRE bounty clips: sponsor card, terminal replay, live proof page, live arena boards.
import { renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../app/node_modules/playwright/index.mjs';
const HERE = fileURLToPath(new URL('./', import.meta.url));
const TX = '0x1f05618103c9b7c1ebc6afe32bf3f88255b9a9c69ee79078695bb480bbb1317a';
const jobs = [
  ['card-cre', `file://${HERE}card-cre.html`, 3.8, { width: 1920, height: 1080 }],
  ['card-mera-ux', `file://${HERE}card-mera-ux.html`, 3.8, { width: 1920, height: 1080 }],
  ['cre-term', `file://${HERE}cre-term.html`, 26, { width: 1920, height: 1080 }],
  ['cre-proof', `https://mempire-monad.vercel.app/proof.html?tx=${encodeURIComponent('Chainlink CRE · MetaPosted epoch 2986556')}~${TX}`, 14, { width: 1920, height: 1080 }],
  ['cre-app', 'https://mempire-monad.vercel.app/', 16, { width: 1920, height: 1080 }],
];
const b = await chromium.launch({ channel: 'chrome', headless: true });
for (const [name, url, secs, vp] of jobs) {
  const ctx = await b.newContext({ viewport: vp, recordVideo: { dir: HERE, size: vp } });
  const p = await ctx.newPage(); await p.goto(url); await p.waitForTimeout(secs * 1000);
  const v = p.video(); await ctx.close(); renameSync(await v.path(), `${HERE}${name}.webm`); console.log(name);
}
await b.close();
