/**
 * F5: the WebSocket server must not buffer an unbounded frame from an
 *     unauthenticated socket (it took `ws`'s 100 MiB default).
 * F6: the match seed must not be a pure function of inputs the players choose.
 */
import fs from 'node:fs';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import WebSocket from 'ws';
import { Keypair } from '@solana/web3.js';

const WS = 'wss://mempire-relay-production.up.railway.app/ws';
const demo = JSON.parse(fs.readFileSync('.demo-wallets.json', 'utf8'));
const kp = (d) => Keypair.fromSecretKey(Uint8Array.from(d.secretKey ?? d.secret ?? d));

// ── F5 ──────────────────────────────────────────────────────────────────────
console.log('  F5  oversized frame from an anonymous socket');
const big = await new Promise((resolve) => {
  const ws = new WebSocket(WS);
  const t = setTimeout(() => { ws.terminate(); resolve('no response in 15s — still buffering?'); }, 15000);
  ws.on('open', () => ws.send(JSON.stringify({ t: 'queue', pad: 'x'.repeat(2 * 1024 * 1024) })));
  ws.on('close', (code) => { clearTimeout(t); resolve(`closed, code ${code}${code === 1009 ? ' (message too big)' : ''}`); });
  ws.on('error', () => {});
});
console.log(`      2 MiB frame -> ${big}`);
console.log(`      ${big.includes('1009') ? 'PASS — refused at the frame limit, never buffered' : 'CHECK'}`);

// ── F6 ──────────────────────────────────────────────────────────────────────
console.log('\n  F6  same players, same deckHash, twice — the seed must differ');
const queue = (k, ws, deckHash) => {
  const address = k.publicKey.toBase58();
  const ts = Date.now();
  const msg = `Mempire\naction: queue\nwallet: ${address}\nts: ${ts}`;
  ws.send(JSON.stringify({
    t: 'queue', tier: 3, address, ts,
    signature: bs58.encode(nacl.sign.detached(new TextEncoder().encode(msg), k.secretKey)),
    deck: Array.from({ length: 8 }, (_, i) => ({ coinId: `c${i}`, name: `C${i}`, archetype: 0, trait: 0, level: 1 })),
    deckHash, format: 'standard', ranked: false, trophies: 60, name: 'seed-probe',
  }));
};

const once = async (deckHash) => new Promise((resolve) => {
  const a = new WebSocket(WS); const b = new WebSocket(WS);
  let seed = null;
  const done = () => { try { a.close(); b.close(); } catch {} resolve(seed); };
  const t = setTimeout(done, 20000);
  const onMsg = (raw) => {
    const m = JSON.parse(String(raw));
    if (m.t === 'matched' || m.stage === 'matched' || m.seed !== undefined) {
      if (m.seed !== undefined && seed === null) { seed = m.seed; clearTimeout(t); setTimeout(done, 300); }
    }
  };
  a.on('message', onMsg); b.on('message', onMsg);
  a.on('open', () => { queue(kp(demo[0]), a, deckHash); setTimeout(() => queue(kp(demo[1]), b, deckHash), 700); });
  b.on('error', () => {}); a.on('error', () => {});
});

const seeds = [];
for (let i = 0; i < 3; i += 1) seeds.push(await once('FIXED-DECK-HASH'));
console.log(`      seeds: ${seeds.map((s) => (s === null ? 'no pairing' : s)).join(', ')}`);
const got = seeds.filter((s) => s !== null);
if (got.length < 2) console.log('      CHECK — could not pair enough times to compare');
else console.log(new Set(got).size === got.length
  ? '      PASS — identical player-chosen input, different seed each time'
  : '      FAIL — seed is reproducible from inputs the player controls');
