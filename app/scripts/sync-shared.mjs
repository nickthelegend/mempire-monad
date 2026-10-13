// Copies the contract ABIs, the roster and the deployments from ../shared into
// src/shared, so the app builds from its own directory (Vercel deploys `app/`
// alone and cannot reach ../shared).
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, '..', '..', 'shared');
const to = join(here, '..', 'src', 'shared');
// Deploying app/ alone (Vercel) there is no ../shared: build from the copy
// committed in src/shared rather than wiping it.
if (!existsSync(join(from, 'roster.json'))) {
  console.log('sync-shared: no ../shared here; using the committed src/shared');
  process.exit(0);
}
rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
for (const item of ['roster.json', 'abi', 'deployments']) {
  cpSync(join(from, item), join(to, item), { recursive: true });
}
console.log(`synced shared/ → ${to}`);
