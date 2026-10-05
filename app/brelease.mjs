/** Free wallet B's deck from stranded Active match #67. */
import anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
const conn=new Connection('https://api.devnet.solana.com','confirmed');
const kp=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('.demo-wallets.json'))['1']));
const PROGRAM=new PublicKey('BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP');
const idl=JSON.parse(readFileSync('src/chain/mempire.idl.json'));
const w={publicKey:kp.publicKey,signTransaction:async t=>{t.partialSign(kp);return t;},signAllTransactions:async ts=>ts.map(t=>{t.partialSign(kp);return t;})};
const program=new anchor.Program(idl,new anchor.AnchorProvider(conn,w,{commitment:'confirmed'}));
const le=n=>new anchor.BN(n).toArrayLike(Buffer,'le',8);
const pda=(...s)=>PublicKey.findProgramAddressSync(s,PROGRAM)[0];
const DEF=PublicKey.default.toBase58();
const ID=67, MATCH=pda(Buffer.from('match'),le(ID));
const acct=await program.account.matchAccount.fetch(MATCH);
const players=acct.players.map(p=>p.toBase58());
console.log('match #'+ID,'state',acct.state,'| players',players.map(p=>p.slice(0,8)).join(' vs '));
const all=await program.account.card.all();
const locked=all.filter(c=>c.account.lockedBy.toBase58()===MATCH.toBase58()).map(c=>c.account.id.toNumber());
console.log('cards locked to it:',locked.length);
const cfg=await program.account.config.fetch(pda(Buffer.from('config')));
const ra=locked.map(i=>({pubkey:pda(Buffer.from('card'),le(i)),isWritable:true,isSigner:false}));
if(acct.state===1){
  try{
    const sig=await program.methods.claimTimeout().accounts({config:pda(Buffer.from('config')),
      matchAccount:MATCH,claimer:kp.publicKey,winnerAccount:kp.publicKey,
      treasury:new PublicKey(cfg.treasury),playerA:new PublicKey(players[0]),playerB:new PublicKey(players[1]),
      matchLog:pda(Buffer.from('log'),le(ID))}).remainingAccounts(ra).rpc();
    console.log('ClaimTimeout ->',sig.slice(0,22)+'…');
  }catch(e){console.log('claimTimeout:',(e.message||'').slice(0,160));}
}
try{
  const sig=await program.methods.releaseCards().accounts({matchAccount:MATCH,payer:kp.publicKey})
    .remainingAccounts(ra).rpc();
  console.log('ReleaseCards ->',sig.slice(0,22)+'…');
}catch(e){console.log('releaseCards:',(e.message||'').slice(0,160));}
const after=await program.account.card.all([{memcmp:{offset:16,bytes:kp.publicKey.toBase58()}}]);
const free=after.filter(c=>c.account.lockedBy.toBase58()===DEF);
console.log('B free cards:',free.length,'| distinct coins:',new Set(free.map(c=>c.account.coinMint.toBase58())).size);
