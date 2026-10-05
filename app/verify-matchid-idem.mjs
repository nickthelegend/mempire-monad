/**
 * F4: the credit idempotency key must name one match however the id is spelled.
 *
 * Posts the same settled match six ways. Exactly one must be credited; the
 * other five must come back `duplicate`.
 */
import fs from 'node:fs';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { Keypair } from '@solana/web3.js';

const API = 'https://mempire-relay-production.up.railway.app';
const demo = JSON.parse(fs.readFileSync('.demo-wallets.json', 'utf8'));
const kp = Keypair.fromSecretKey(Uint8Array.from(demo[0].secretKey ?? demo[0].secret ?? demo[0]));
const address = kp.publicKey.toBase58();

const MATCH = Number(process.argv[2] ?? 90);
const spellings = [MATCH, String(MATCH), ` ${MATCH}`, `${MATCH}.0`, `${MATCH}e0`, `0x${MATCH.toString(16)}`];

const sign = (action) => {
  const ts = Date.now();
  const msg = `Mempire\naction: ${action}\nwallet: ${address}\nts: ${ts}`;
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey));
  return { ts, signature };
};

let credited = 0, dupes = 0;
for (const spelling of spellings) {
  const res = await fetch(`${API}/api/match/${address}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...sign('match.post'),
      won: true, draw: false, crowns: [3, 0],
      escrowed: true, matchId: spelling,
    }),
  });
  const body = await res.json().catch(() => ({}));
  const dup = body.duplicate === true;
  if (dup) dupes += 1; else credited += 1;
  console.log(`  ${JSON.stringify(spelling).padEnd(10)} -> ${res.status} ${dup ? 'duplicate' : JSON.stringify(body).slice(0, 70)}`);
}
console.log(`\n  credited ${credited}, duplicate ${dupes}`);
console.log(credited === 1 ? '  PASS — one spelling counted, the rest refused' : `  FAIL — ${credited} spellings each counted`);
