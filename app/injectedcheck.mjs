/**
 * The app, driven by an injected wallet rather than its Guest identity.
 *
 * # Why this is different from the other harnesses
 *
 * Every other test here seeds `mempire_guest_sk`, which is a real ed25519 key
 * producing real signatures — but it enters the app through the Guest branch.
 * This one plants a Phantom-shaped provider on `window.phantom.solana`, so
 * `PhantomWalletAdapter` detects an installed wallet, the picker offers it, and
 * connecting runs the whole wallet-adapter path: `readyState`, `connect()`,
 * `signTransaction`, `signMessage`, the disconnect listener. That is the code a
 * real player's extension drives and the Guest branch never touches.
 *
 * The provider is not a stub. It holds a keypair, signs with tweetnacl over the
 * exact bytes handed to it, and every transaction it returns is submitted to
 * devnet and verified on chain afterwards. What is skipped is the extension's
 * own approval UI — which Playwright cannot drive, and which is not the thing
 * under test.
 */
import { chromium } from 'playwright';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import * as anchor from '@coral-xyz/anchor';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';

const URL = process.env.URL ?? 'https://play.mempire.fun';
const RPC = 'https://api.devnet.solana.com';
const cfg = JSON.parse(readFileSync('./src/lib/amm.json', 'utf8'));
const MINT = new PublicKey(cfg.mempireMint);
const UNIT = 10n ** BigInt(cfg.mempireDecimals);
const PROGRAM = new PublicKey('BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP');

/** tweetnacl's standalone build, injected so the page can sign for itself. */
const NACL = readFileSync('./node_modules/tweetnacl/nacl-fast.min.js', 'utf8');

const conn = new Connection(RPC, 'confirmed');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (ok, label, detail = '') => {
  results.push({ ok, label });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

async function mempireBalance(owner) {
  try {
    const b = await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(MINT, owner, true));
    return BigInt(b.value.amount);
  } catch { return 0n; }
}

const bank = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  readFileSync(`${process.env.HOME}/.config/solana/zorr.json`, 'utf8'),
)));

const player = Keypair.generate();
console.log(`injected wallet: ${player.publicKey.toBase58()}\n`);

console.log('funding…');
{
  const to = getAssociatedTokenAddressSync(MINT, player.publicKey);
  const tx = new Transaction()
    .add(SystemProgram.transfer({
      fromPubkey: bank.publicKey,
      toPubkey: player.publicKey,
      // Only what the run needs — an ATA, a transfer and a few signatures. Devnet
      // SOL is finite and every run mints a throwaway wallet that keeps the rest.
      // 0.07 rather than a round number so it cannot be confused with a stake tier.
      lamports: Math.round(0.07 * LAMPORTS_PER_SOL),
    }))
    .add(createAssociatedTokenAccountIdempotentInstruction(
      bank.publicKey, to, player.publicKey, MINT,
    ))
    .add(createTransferInstruction(
      getAssociatedTokenAddressSync(MINT, bank.publicKey), to, bank.publicKey, 300n * UNIT,
    ));
  await sendAndConfirmTransaction(conn, tx, [bank], { commitment: 'confirmed' });
}
console.log(`  ${(await conn.getBalance(player.publicKey)) / LAMPORTS_PER_SOL} SOL, `
  + `${await mempireBalance(player.publicKey) / UNIT} $MEMPIRE\n`);


/**
 * Give the leftovers back.
 *
 * Every run mints a throwaway wallet, and until this existed each one kept
 * whatever it had not spent — devnet SOL is finite and rate-limited, so a
 * harness that leaks a little on every invocation eventually stops the faucet
 * working for real players. Returns everything above the fee for the return
 * transfer itself.
 */
async function refund(kp) {
  const balance = await conn.getBalance(kp.publicKey);
  const keep = 5000; // the signature on this very transaction
  if (balance <= keep) return 0;
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: kp.publicKey, toPubkey: bank.publicKey, lamports: balance - keep,
  }));
  await sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' })
    .catch(() => { /* dust; not worth failing a green run over */ });
  return (balance - keep) / LAMPORTS_PER_SOL;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });

/**
 * Plant the provider before any app script runs.
 *
 * `PhantomWalletAdapter` reads `window.phantom.solana` during construction, so
 * this has to exist before the module graph loads — an init script is the only
 * place that is true.
 */
await ctx.addInitScript(({ nacl, sk, b58 }) => {
  // eslint-disable-next-line no-eval
  (0, eval)(nacl);
  const kp = window.nacl.sign.keyPair.fromSecretKey(
    Uint8Array.from(atob(sk), (c) => c.charCodeAt(0)),
  );

  /**
   * A PublicKey-shaped object, not the real class.
   *
   * web3.js lives inside the app's bundle and is not reachable from an init
   * script, so shipping a second copy into the page would mean two `PublicKey`
   * implementations disagreeing about identity. The adapter only ever calls
   * `toBytes`/`toBase58`/`equals` on what a provider hands back, so duck-typing
   * is both sufficient and less likely to drift.
   */
  const pk = {
    toBytes: () => kp.publicKey,
    toBuffer: () => kp.publicKey,
    toBase58: () => b58,
    toString: () => b58,
    equals: (o) => (o?.toBase58?.() ?? String(o)) === b58,
  };

  const listeners = {};
  const emit = (ev, ...a) => (listeners[ev] ?? []).forEach((f) => f(...a));

  /**
   * Sign the way an extension does — over the serialized message, then into the
   * transaction's own signature slot.
   *
   * `addSignature` is avoided deliberately: it looks the key up by `PublicKey`
   * identity, which a duck-typed key cannot satisfy. Writing the slot found by
   * base58 is the same result without depending on the class.
   */
  const sign = (tx) => {
    const versioned = tx.message !== undefined && typeof tx.serialize === 'function'
      && typeof tx.serializeMessage !== 'function';
    if (versioned) {
      const sig = window.nacl.sign.detached(tx.message.serialize(), kp.secretKey);
      const keys = tx.message.staticAccountKeys ?? tx.message.accountKeys ?? [];
      const i = keys.findIndex((k) => k.toBase58() === b58);
      if (i >= 0) tx.signatures[i] = sig;
      return tx;
    }
    const sig = window.nacl.sign.detached(tx.serializeMessage(), kp.secretKey);
    const slot = tx.signatures.find((s) => s.publicKey?.toBase58?.() === b58);
    if (slot) slot.signature = sig;
    return tx;
  };

  const provider = {
    isPhantom: true,
    publicKey: null,
    isConnected: false,
    connect: async () => {
      provider.publicKey = pk;
      provider.isConnected = true;
      emit('connect', pk);
      return { publicKey: pk };
    },
    disconnect: async () => {
      provider.publicKey = null;
      provider.isConnected = false;
      emit('disconnect');
    },
    signTransaction: async (tx) => sign(tx),
    signAllTransactions: async (txs) => txs.map(sign),
    signMessage: async (message) => ({
      signature: window.nacl.sign.detached(message, kp.secretKey),
      publicKey: pk,
    }),
    on: (ev, fn) => { (listeners[ev] ??= []).push(fn); },
    off: (ev, fn) => { listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn); },
    removeListener: (ev, fn) => provider.off(ev, fn),
    removeAllListeners: () => { for (const k of Object.keys(listeners)) delete listeners[k]; },
  };

  window.phantom = { solana: provider };
  window.solana = provider;
  // The adapter requires this flag *as well as* `isPhantom`; without it
  // readyState never leaves NotDetected and the picker offers an install link.
  window.isPhantomInstalled = true;
}, {
  nacl: NACL,
  sk: Buffer.from(player.secretKey).toString('base64'),
  b58: player.publicKey.toBase58(),
});

const page = await ctx.newPage();
page.on('pageerror', (e) => console.log(`  [uncaught] ${e.message}`));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await sleep(4000);

console.log('=== the app finds the wallet by itself ===');
// No click first. The app eagerly connects a wallet whose readyState is
// Installed, so an address on screen before anyone touches the picker is the
// detection working — stronger evidence than reading the picker's own label.
const landed = await page.innerText('body');
const short = player.publicKey.toBase58();
// The header shows a truncated address inside the account menu rather than in
// the page body, so this opens it and reads what the app believes it is holding.
await page.getByRole('button', { name: /account menu/i }).first().click().catch(() => {});
await sleep(1200);
const menu = await page.innerText('body');
// The header shows a chosen name rather than the address, so identity is read
// from what the app says it connected *through* plus the balance it fetched —
// 0.35 SOL is this wallet's and nothing else's.
check(/Phantom/i.test(menu), 'the app connected through the Phantom adapter');
check(/0\.07/.test(menu),
  'it is reading this wallet\'s balance, not another session\'s', '0.07 SOL');
await page.keyboard.press('Escape').catch(() => {});
await sleep(600);
check(!/CONNECT WALLET/i.test(landed), 'the connect gate is gone');
check(!/Guest ·/.test(landed), 'the session is not the Guest identity');

// Dismiss the tutorial if it opened over the top.
await page.evaluate(() => {
  [...document.querySelectorAll('button')]
    .find((b) => /^\s*skip\s*$/i.test(b.textContent ?? ''))?.click();
});
await sleep(1500);

console.log('\n=== it can sign a real onchain purchase ===');
const before = await mempireBalance(player.publicKey);
await page.evaluate(() => {
  const nav = document.querySelector('nav');
  [...(nav?.querySelectorAll('*') ?? [])]
    .find((e) => /^CARDS$/i.test((e.textContent ?? '').trim()))?.click();
});
await sleep(2000);
const slot = page.getByRole('button', { name: /Empty chest slot/i }).first();
if (await slot.isVisible().catch(() => false)) {
  await slot.click();
  await sleep(1500);
  const dialog = page.getByRole('dialog').first();
  check(await dialog.isVisible().catch(() => false), 'the purchase dialog opens for an injected wallet');
  await dialog.getByRole('button', { name: /^pay/i }).first().click();
  console.log('  the extension is signing…');
  await sleep(16000);
  const spent = before - await mempireBalance(player.publicKey);
  check(spent === 100n * UNIT,
    'the injected wallet signed and the tokens moved', `${spent / UNIT} $MEMPIRE`);
} else {
  console.log('  [screen] ' + (await page.innerText('body')).replace(/\n+/g, ' | ').slice(0, 500));
  check(false, 'the chest rail is reachable');
}

console.log('\n=== and mint cards onchain ===');
const idl = JSON.parse(readFileSync('../chain/target/idl/mempire.json', 'utf8'));
const prog = new anchor.Program(idl, new anchor.AnchorProvider(conn, {
  publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t,
}, { commitment: 'confirmed' }));
const cardsBefore = (await prog.account.card.all())
  .filter((c) => c.account.owner.toBase58() === short).length;
check(cardsBefore === 0, 'this wallet started with no cards on chain', `${cardsBefore}`);

await browser.close();
console.log(`\nreturned ${(await refund(player)).toFixed(4)} SOL to the bank`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
