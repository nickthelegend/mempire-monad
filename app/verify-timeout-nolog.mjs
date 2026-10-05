/**
 * F3: a timeout on a match that never had a log must not pay the first caller.
 *
 * Before: `claims == None` (no log ever created) fell through to "genuine
 * abandonment, either may claim", with no check on who called — so a losing
 * seat only had to never create the log and win the race to the deadline.
 * After: absence of evidence is a dispute — refund both, rake nothing.
 */
import fs from 'node:fs';
import anchor from '@coral-xyz/anchor';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';

const MEMPIRE = new PublicKey('BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP');
const ID = Number(process.argv[2] ?? 92);
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const demo = JSON.parse(fs.readFileSync('.demo-wallets.json', 'utf8'));
const kp = (d) => Keypair.fromSecretKey(Uint8Array.from(d.secretKey ?? d.secret ?? d));
const A = kp(demo[0]); const B = kp(demo[1]);
const idl = JSON.parse(fs.readFileSync('src/chain/mempire.idl.json', 'utf8'));
const pg = (k) => new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(k), { commitment: 'confirmed' }));

const idLe = new anchor.BN(ID).toArrayLike(Buffer, 'le', 8);
const [matchPda] = PublicKey.findProgramAddressSync([Buffer.from('match'), idLe], MEMPIRE);
const [logPda] = PublicKey.findProgramAddressSync([Buffer.from('log'), idLe], MEMPIRE);
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], MEMPIRE);
const cfg = await pg(A).account.config.fetch(config);
const treasury = cfg.treasury;

const m = await pg(A).account.matchAccount.fetch(matchPda);
const wait = Number(m.deadline) - Math.floor(Date.now() / 1000);
console.log(`  match #${ID} state ${m.state}, pot ${2 * Number(m.stakeLamports) / 1e9} SOL`);
console.log(`  log account: ${(await conn.getAccountInfo(logPda)) ? 'exists' : 'never created'}`);
if (wait > 0) { console.log(`  waiting ${wait + 5}s for the deadline…`); await new Promise((r) => setTimeout(r, (wait + 5) * 1000)); }

const bal = async () => ({
  A: await conn.getBalance(A.publicKey), B: await conn.getBalance(B.publicKey),
  T: await conn.getBalance(treasury),
});
const before = await bal();

/* B calls, naming B as the winner — B is the seat that would be stealing. */
console.log('\n  seat B calls claim_timeout, naming itself the winner…');
const sig = await pg(B).methods.claimTimeout()
  .accounts({
    config, matchAccount: matchPda, claimer: B.publicKey, winnerAccount: B.publicKey,
    treasury, playerA: A.publicKey, playerB: B.publicKey, matchLog: logPda,
  })
  .remainingAccounts([]).rpc();
console.log(`    ${sig.slice(0, 24)}…`);

const after = await bal();
const d = (k) => (after[k] - before[k]) / 1e9;
const m2 = await pg(A).account.matchAccount.fetch(matchPda);
console.log(`\n    player A  ${d('A') >= 0 ? '+' : ''}${d('A').toFixed(6)} SOL`);
console.log(`    player B  ${d('B') >= 0 ? '+' : ''}${d('B').toFixed(6)} SOL  (caller, pays the fee)`);
console.log(`    treasury  ${d('T') >= 0 ? '+' : ''}${d('T').toFixed(6)} SOL`);
console.log(`    match winner field: ${m2.winner} (2 = void), state ${m2.state}`);

const stake = Number(m.stakeLamports) / 1e9;
const refunded = Math.abs(d('A') - stake) < 0.001 && d('B') > stake - 0.001 && d('B') < stake + 0.001;
const stolen = d('B') > stake * 1.5;
console.log(stolen
  ? `\n  FAIL — B took ${d('B').toFixed(4)} SOL, more than the stake it put in. The pot was stealable.`
  : refunded
    ? '\n  PASS — both stakes refunded, treasury took no rake, nobody profited from the stall'
    : `\n  CHECK — A ${d('A').toFixed(6)}, B ${d('B').toFixed(6)}: not the expected even refund`);
