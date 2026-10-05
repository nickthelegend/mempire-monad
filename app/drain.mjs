/**
 * Return every staked token before the staking instructions are removed.
 *
 * The two-step unstake exists so a withdrawal is deliberate; here it means
 * request on all of them, wait out the single shared cooldown, then claim.
 * Removing an instruction is the one change that can strand a balance
 * forever, so this runs first and reports what it could not free.
 */
import anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import { Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
const conn=new Connection('https://api.devnet.solana.com','confirmed');
const kp=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.HOME+'/.config/solana/zorr.json'))));
console.log('acting as',kp.publicKey.toBase58());
const PROGRAM=new PublicKey('BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP');
// The staking instructions are gone from the source, so the freshly built IDL
// no longer describes them. The deployed devnet program still has them — this
// drain is what makes it safe to replace it — so decode against the IDL that
// shipped with that deployment.
const idl=JSON.parse(readFileSync(process.env.OLD_IDL));
const w={publicKey:kp.publicKey,signTransaction:async t=>{t.partialSign(kp);return t;},signAllTransactions:async ts=>ts.map(t=>{t.partialSign(kp);return t;})};
const program=new anchor.Program(idl,new anchor.AnchorProvider(conn,w,{commitment:'confirmed'}));
const le=n=>new anchor.BN(n).toArrayLike(Buffer,'le',8);
const pda=(...s)=>PublicKey.findProgramAddressSync(s,PROGRAM)[0];
async function retry(what, fn, tries=8){
  for(let i=0;i<tries;i++){
    try{ return await fn(); }
    catch(e){ const m=(e.message||''); 
      if(i===tries-1) throw e;
      console.log(`  ${what} retry ${i+1}: ${m.slice(0,50)}`);
      await new Promise(r=>setTimeout(r, 3000*(i+1)));
    }
  }
}
const cards=(await retry('scan',()=>program.account.card.all()))
  .filter(c=>c.account.owner.toBase58()===kp.publicKey.toBase58()
    && (Number(c.account.stakedTokens)>0||Number(c.account.pendingUnstakeTokens)>0));
console.log('cards to drain:',cards.length);
const ok=[],fail=[];
for(const c of cards){
  const id=c.account.id.toNumber(), amt=c.account.stakedTokens;
  if(Number(amt)>0){
    try{ await retry(`#${id} request`,()=>program.methods.requestUnstake(amt)
      .accounts({config:pda(Buffer.from('config')),card:pda(Buffer.from('card'),le(id)),owner:kp.publicKey}).rpc());
      console.log(`  #${id} requested ${amt}`);
      await new Promise(r=>setTimeout(r,900));
    }catch(e){ console.log(`  #${id} request failed: ${(e.message||'').slice(0,60)}`); fail.push(id); continue; }
  }
  ok.push({id, mint:c.account.coinMint});
}
console.log('waiting out the 60s cooldown…');
await new Promise(r=>setTimeout(r,66000));
const cfg=await program.account.config.fetch(pda(Buffer.from('config')));
for(const {id,mint} of ok){
  try{
    // The vault is the vault_authority PDA's associated token account for the
    // card's coin — not a PDA in its own right, which is what the first pass
    // guessed and why every claim failed on `account: vault`.
    const vaultAuthority=pda(Buffer.from('vault'),le(id));
    /*
     * The unstake fee needs somewhere to land. `claim_unstake` constrains the
     * destination to the treasury's token account for this coin, and for coins
     * the treasury has never received, that account does not exist yet — which
     * fails account deserialization long before the constraint is even read.
     * Idempotent creation costs nothing when it is already there.
     */
    const ownerAta=getAssociatedTokenAddressSync(mint,kp.publicKey);
    if(!(await conn.getAccountInfo(ownerAta))){
      await retry(`#${id} owner ata`,()=>sendAndConfirmTransaction(conn,
        new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(
          kp.publicKey, ownerAta, kp.publicKey, mint)), [kp]));
      await new Promise(r=>setTimeout(r,600));
    }
    const treasuryAta=getAssociatedTokenAddressSync(mint,new PublicKey(cfg.treasury),true);
    if(!(await conn.getAccountInfo(treasuryAta))){
      await retry(`#${id} treasury ata`,()=>sendAndConfirmTransaction(conn,
        new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(
          kp.publicKey, treasuryAta, new PublicKey(cfg.treasury), mint)), [kp]));
      await new Promise(r=>setTimeout(r,600));
    }
    await retry(`#${id} claim`,()=>program.methods.claimUnstake().accounts({
      config:pda(Buffer.from('config')), card:pda(Buffer.from('card'),le(id)),
      vaultAuthority,
      vault:getAssociatedTokenAddressSync(mint,vaultAuthority,true),
      ownerTokens:ownerAta,
      treasuryTokens:treasuryAta,
      owner:kp.publicKey, tokenProgram:TOKEN_PROGRAM_ID,
    }).rpc());
    console.log(`  #${id} claimed`);
    await new Promise(r=>setTimeout(r,900));
  }catch(e){ console.log(`  #${id} claim failed: ${(e.message||'').slice(0,80)}`); fail.push(id); }
}
const after=(await retry('final scan',()=>program.account.card.all())).filter(c=>Number(c.account.stakedTokens)>0||Number(c.account.pendingUnstakeTokens)>0);
console.log('DRAIN DONE — cards still holding tokens:',after.length, after.length?after.map(c=>'#'+c.account.id).join(' '):'(none)');
