import anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
const conn=new Connection('https://api.devnet.solana.com','confirmed');
const kp=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('.demo-wallets.json'))['1']));
const PROGRAM=new PublicKey('BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP');
const idl=JSON.parse(readFileSync('src/chain/mempire.idl.json'));
const w={publicKey:kp.publicKey,signTransaction:async t=>{t.partialSign(kp);return t;},signAllTransactions:async ts=>ts.map(t=>{t.partialSign(kp);return t;})};
const program=new anchor.Program(idl,new anchor.AnchorProvider(conn,w,{commitment:'confirmed'}));
const DEF=PublicKey.default.toBase58();
const cards=await program.account.card.all([{memcmp:{offset:16,bytes:kp.publicKey.toBase58()}}]);
console.log('B total cards:',cards.length);
const locked=cards.filter(c=>c.account.lockedBy.toBase58()!==DEF);
const free=cards.filter(c=>c.account.lockedBy.toBase58()===DEF);
console.log('free:',free.length,'| locked:',locked.length);
console.log('free distinct coins:',new Set(free.map(c=>c.account.coinMint.toBase58())).size);
console.log('all distinct coins:',new Set(cards.map(c=>c.account.coinMint.toBase58())).size);
const byMatch=new Map();
for(const c of locked){const k=c.account.lockedBy.toBase58(); if(!byMatch.has(k))byMatch.set(k,[]); byMatch.get(k).push(c.account.id.toNumber());}
for(const [m,ids] of byMatch){
  let st='?'; try{const a=await program.account.matchAccount.fetch(new PublicKey(m)); st=a.state;}catch{st='gone';}
  console.log('  locked by',m.slice(0,12)+'…','state',st,'cards',ids.join(','));
}
