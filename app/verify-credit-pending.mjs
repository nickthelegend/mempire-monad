/**
 * The money credit must survive being reported before settlement lands.
 *
 * Two matches: #94, which really is settled and really was won by wallet A,
 * and #9999, which does not exist. The first post of each counts W/L; only the
 * settled one may move netSol, and the unsettled one must stay claimable.
 */
import fs from 'node:fs';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { MongoClient } from 'mongodb';
import { Keypair } from '@solana/web3.js';

const API = 'http://localhost:8787';
const demo = JSON.parse(fs.readFileSync('.demo-wallets.json', 'utf8'));
const kp = Keypair.fromSecretKey(Uint8Array.from(demo[0].secretKey ?? demo[0].secret ?? demo[0]));
const address = kp.publicKey.toBase58();

const uri = fs.readFileSync('../server/.env', 'utf8').match(/MONGODB_URI=(\S+)/)[1];
const cli = new MongoClient(uri); await cli.connect();
const db = cli.db('mempire');
const netSol = async () => (await db.collection('leaderboard').findOne({ _id: address }))?.netSol ?? 0;

const post = async (matchId) => {
  const ts = Date.now();
  const msg = `Mempire\naction: match.post\nwallet: ${address}\nts: ${ts}`;
  const res = await fetch(`${API}/api/match/${address}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ts, signature: bs58.encode(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey)),
      won: true, draw: false, crowns: [1, 0], escrowed: true, matchId,
    }),
  });
  return res.json();
};

for (const [label, id] of [['#94 (settled, A won)', 94], ['#9999 (does not exist)', 9999]]) {
  await db.collection('match_credits').deleteOne({ _id: `${id}:${address}` });
  const before = await netSol();
  const first = await post(id);
  const mid = await netSol();
  const second = await post(id);
  const after = await netSol();
  console.log(`\n  ${label}`);
  console.log(`    post 1 -> ${JSON.stringify(first)}`);
  console.log(`             netSol ${before} -> ${mid}  (${(mid - before).toFixed(4)})`);
  console.log(`    post 2 -> ${JSON.stringify(second)}`);
  console.log(`             netSol ${mid} -> ${after}  (${(after - mid).toFixed(4)})`);
  const row = await db.collection('match_credits').findOne({ _id: `${id}:${address}` });
  console.log(`    credit row moneyCredited=${row?.moneyCredited}`);
}

// Leave the board as we found it.
for (const id of [94, 9999]) await db.collection('match_credits').deleteOne({ _id: `${id}:${address}` });
await cli.close();
