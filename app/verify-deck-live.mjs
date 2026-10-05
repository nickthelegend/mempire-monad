/**
 * F1, end to end: create a real staked match, then check that the commitment
 * the client computes equals the one the program derived and stored.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import anchor from '@coral-xyz/anchor';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';

const idl = JSON.parse(fs.readFileSync('src/chain/mempire.idl.json', 'utf8'));
const PROGRAM = new PublicKey('BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP');
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const demo = JSON.parse(fs.readFileSync('.demo-wallets.json', 'utf8'));
const me = Keypair.fromSecretKey(Uint8Array.from(demo[0].secretKey ?? demo[0].secret ?? demo[0]));
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(me), { commitment: 'confirmed' });
const program = new anchor.Program(idl, provider);

const cards = (await program.account.card.all())
  .filter((c) => c.account.owner.equals(me.publicKey)
    && c.account.lockedBy.toBase58() === '11111111111111111111111111111111');
const seen = new Set();
const deck = [];
for (const c of cards) {
  const m = c.account.coinMint.toBase58();
  if (seen.has(m)) continue;
  seen.add(m); deck.push(c);
  if (deck.length === 8) break;
}
if (deck.length < 8) { console.log(`  only ${deck.length} free distinct-coin cards — cannot stake`); process.exit(1); }

console.log('  deck (in the order it will be passed):');
for (const c of deck) console.log(`    id ${String(c.account.id).padStart(3)}  level ${c.account.level}  ${c.account.coinMint.toBase58().slice(0, 12)}…`);

/* This is exactly what `deckCommitment` in app/src/state/match.ts now does. */
const preimage = Buffer.concat(deck.map((c) => Buffer.concat([
  c.account.coinMint.toBuffer(), Buffer.from([c.account.level]),
])));
const expected = createHash('sha256').update(preimage).digest('hex');

/* And this is the old one, for the record. */
let h = 0x811c9dc5;
const text = deck.map((c) => c.account.coinMint.toBase58()).join(',');
for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
const oldBytes = Buffer.alloc(32); oldBytes.writeUInt32LE(h >>> 0, 0);

const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM);
const cfg = await program.account.config.fetch(config);
const matchId = Number(cfg.nextMatchId);
const [matchPda] = PublicKey.findProgramAddressSync(
  [Buffer.from('match'), new anchor.BN(matchId).toArrayLike(Buffer, 'le', 8)], PROGRAM);

console.log(`\n  creating match #${matchId} at tier 0 (0.05 SOL)…`);
const sig = await program.methods
  .createMatch(0, new anchor.BN(50_000_000), Array(32).fill(0))
  .accounts({ config, matchAccount: matchPda, player: me.publicKey })
  .remainingAccounts(deck.map((c) => ({ pubkey: c.publicKey, isSigner: false, isWritable: true })))
  .rpc();
console.log(`    ${sig.slice(0, 24)}…`);

const m = await program.account.matchAccount.fetch(matchPda);
const stored = Buffer.from(m.deckHash[0]).toString('hex');
console.log(`\n    program stored   ${stored}`);
console.log(`    client (new)     ${expected}`);
console.log(`    client (old FNV) ${oldBytes.toString('hex')}`);
console.log(`\n    new  == stored ?  ${expected === stored ? 'YES — commitment verified' : 'NO'}`);
console.log(`    old  == stored ?  ${oldBytes.toString('hex') === stored ? 'yes' : 'NO — this is why every staked match voided'}`);

console.log('\n  cancelling to release the stake and the decks…');
const c2 = await program.methods.cancelMatch()
  .accounts({ matchAccount: matchPda, player: me.publicKey })
  .remainingAccounts(deck.map((c) => ({ pubkey: c.publicKey, isSigner: false, isWritable: true })))
  .rpc();
console.log(`    ${c2.slice(0, 24)}…  refunded`);
