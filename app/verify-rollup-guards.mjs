/**
 * F2: the rollup's `play_card` must refuse a nonsense tick and must not let one
 * seat spend the whole log.
 *
 * Both guards were written for `mempire::play_card` and never copied to the
 * rollup — the copy that actually runs while a match is delegated. Tested on
 * base layer, before delegation, where the same handler runs.
 */
import fs from 'node:fs';
import anchor from '@coral-xyz/anchor';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';

const MEMPIRE = new PublicKey('BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP');
const ROLLUP = new PublicKey('3G4GidvjQd3yQK4bqZfem8Kkmcboygze42RcjrXg5g6N');
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const demo = JSON.parse(fs.readFileSync('.demo-wallets.json', 'utf8'));
const kp = (d) => Keypair.fromSecretKey(Uint8Array.from(d.secretKey ?? d.secret ?? d));
const A = kp(demo[0]); const B = kp(demo[1]);

const prov = (k) => new anchor.AnchorProvider(conn, new anchor.Wallet(k), { commitment: 'confirmed' });
const mem = (k) => new anchor.Program(JSON.parse(fs.readFileSync('src/chain/mempire.idl.json','utf8')), prov(k));
const rol = (k) => new anchor.Program(JSON.parse(fs.readFileSync('src/chain/mempire_rollup.idl.json','utf8')), prov(k));

const freeDeck = async (owner) => {
  const cards = (await mem(A).account.card.all())
    .filter((c) => c.account.owner.equals(owner.publicKey)
      && c.account.lockedBy.toBase58() === '11111111111111111111111111111111');
  const seen = new Set(); const deck = [];
  for (const c of cards) { const m = c.account.coinMint.toBase58(); if (seen.has(m)) continue; seen.add(m); deck.push(c); if (deck.length===8) break; }
  return deck;
};
const ra = (deck) => deck.map((c) => ({ pubkey: c.publicKey, isSigner: false, isWritable: true }));

const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], MEMPIRE);
const cfg = await mem(A).account.config.fetch(config);
const id = Number(cfg.nextMatchId);
const idLe = new anchor.BN(id).toArrayLike(Buffer, 'le', 8);
const [matchPda] = PublicKey.findProgramAddressSync([Buffer.from('match'), idLe], MEMPIRE);
const [logPda] = PublicKey.findProgramAddressSync([Buffer.from('log'), idLe], ROLLUP);

const deckA = await freeDeck(A); const deckB = await freeDeck(B);
console.log(`  match #${id}: A stakes 0.05, B joins 0.05`);
await mem(A).methods.createMatch(0, new anchor.BN(50_000_000), Array(32).fill(0))
  .accounts({ config, matchAccount: matchPda, player: A.publicKey }).remainingAccounts(ra(deckA)).rpc();
await mem(B).methods.joinMatch(Array(32).fill(0))
  .accounts({ config, matchAccount: matchPda, player: B.publicKey }).remainingAccounts(ra(deckB)).rpc();

console.log('  init_log on the rollup program (base layer, pre-delegation)…');
await rol(A).methods.initLog(new anchor.BN(id), [A.publicKey, B.publicKey])
  .accounts({ matchAccount: matchPda, log: logPda, payer: A.publicKey }).rpc();

const play = (who, tick, idx = 0) => rol(who).methods
  .playCard(tick, idx, 0, 0).accounts({ log: logPda, player: who.publicKey }).rpc();

console.log('\n  T1  a sane tick is accepted');
await play(A, 10); console.log('      tick 10 -> accepted');

console.log('\n  T2  the freeze: one play at u32::MAX');
try {
  await play(A, 4294967295);
  console.log('      FAIL — tick u32::MAX accepted; the log is now frozen for both seats');
} catch (e) {
  const m = String(e).match(/StaleTick|custom program error: 0x[0-9a-f]+/i);
  console.log(`      REFUSED (${m ? m[0] : 'error'}) — cursor cannot be pinned`);
}
console.log('      and a normal play still works after the refusal:');
await play(A, 20); console.log('      tick 20 -> accepted');

console.log('\n  T3  the per-seat budget: seat A tries to spend the whole log');
let n = 2; // two plays already
let refusedAt = null;
outer: for (let batch = 0; batch < 8; batch += 1) {
  const ixs = [];
  for (let i = 0; i < 10 && n + i < 70; i += 1) {
    ixs.push(await rol(A).methods.playCard(100 + n + i, 0, 0, 0)
      .accounts({ log: logPda, player: A.publicKey }).instruction());
  }
  if (!ixs.length) break;
  try {
    const tx = new anchor.web3.Transaction().add(...ixs);
    await anchor.web3.sendAndConfirmTransaction(conn, tx, [A], { commitment: 'confirmed' });
    n += ixs.length;
  } catch (e) {
    // Narrow down to the exact play that was refused.
    for (let i = 0; i < ixs.length; i += 1) {
      try { await play(A, 100 + n); n += 1; } catch { refusedAt = n; break outer; }
    }
    break outer;
  }
}
const log = await rol(A).account.matchLog.fetch(logPda);
const mine = log.plays.filter((p) => p.player === 0).length;
console.log(`      seat A recorded ${mine} plays, then refused${refusedAt !== null ? '' : ' (loop end)'}`);
console.log(`      cap is MAX_PLAYS/2 = 64 -> ${mine === 64 ? 'PASS' : `FAIL (expected 64, got ${mine})`}`);

console.log('\n  T4  seat B still has its own half');
await play(B, 300); 
const log2 = await rol(A).account.matchLog.fetch(logPda);
console.log(`      B recorded ${log2.plays.filter((p) => p.player === 1).length} play(s) after A was capped -> PASS`);

console.log(`\n  match #${id} left open for cleanup`);
