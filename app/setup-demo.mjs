/**
 * Stand up two funded, camera-ready player wallets for the gameplay demo.
 *
 * # Why this exists
 *
 * Recording the demo means driving two clients at once, and a browser
 * extension cannot be driven — Playwright can reach the page but not Phantom's
 * approval popup. `injected-wallet.mjs` plants a Phantom-shaped provider
 * holding a real keypair instead, so the app runs its normal adapter path and
 * every signature is genuine. That only works if the keypairs it plants are
 * already funded and already hold the tokens the flow needs.
 *
 * This script prepares them, once, before the shoot.
 *
 * # What "ready" means
 *
 * A wallet that can be recorded end to end needs four things, and missing any
 * one of them breaks a *later* shot rather than the one it belongs to:
 *
 *  - **SOL** for the stake, mint fees and gas.
 *  - **The starter coins**, because `mint_card` requires holding the coin. A
 *    wallet with SOL and no coins can mint nothing and can field no deck.
 *  - **$MEMPIRE**, because chests and clan charters are priced in it. Acquiring
 *    it properly means swapping USDC on the AMM, which is a different demo;
 *    here it is minted directly by the mint authority.
 *  - **Eight cards already minted on chain.** This is the one that bites.
 *    `useChainSync` replaces the locally seeded collection with whatever the
 *    wallet actually holds, so a wallet holding one card gets a one-card
 *    collection, its deck is re-pointed to that single card, and BATTLE refuses
 *    with "deck needs 8 cards". Minting the eight is a separate step
 *    (`premint-demo.mjs`) because it goes through the Anchor program rather
 *    than plain SPL transfers.
 *
 * # Keys
 *
 * The two demo keypairs are written to `.demo-wallets.json`, gitignored. They
 * are devnet-only and hold nothing of value, but they are still keys, and a
 * committed key is a habit worth not forming.
 *
 * Usage:
 *   node setup-demo.mjs            # create if absent, fund, report
 *   node setup-demo.mjs --report   # report balances only, move nothing
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import bs58 from 'bs58';

const RPC = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
const WALLETS_FILE = new URL('./.demo-wallets.json', import.meta.url);
const REPORT_ONLY = process.argv.includes('--report');

/** Left in the faucet so the in-app starter-kit button still works on camera. */
const FAUCET_KEEP_SOL = 2.0;
/** Each player. Covers a 0.25 stake, nine mint fees, rent and many retakes. */
const PLAYER_SOL = 1.5;
/** Whole $MEMPIRE per player. A chest is 100, a skip 25. */
const PLAYER_MEMPIRE = 2_000;
/** Whole tokens of each starter coin. One is enough to mint a card. */
const PLAYER_COIN_TOKENS = 50;

const MEMPIRE_MINT = new PublicKey('AhF5trvRTrqRU3gdDGQKCX5H5zZh5WjSw4bmeCwYFpR8');
const MEMPIRE_DECIMALS = 6;

function loadKey(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/** The faucet key, which is what the user funded. */
function faucetKeypair() {
  const env = readFileSync(new URL('../server/.env', import.meta.url), 'utf8');
  const m = env.match(/^FAUCET_SECRET=(.+)$/m);
  if (!m) throw new Error('FAUCET_SECRET not found in server/.env');
  return Keypair.fromSecretKey(bs58.decode(m[1].trim()));
}

/** Created once and reused, so re-running never orphans a funded wallet. */
function demoWallets() {
  if (existsSync(WALLETS_FILE)) {
    const saved = JSON.parse(readFileSync(WALLETS_FILE, 'utf8'));
    return saved.map((s) => Keypair.fromSecretKey(Uint8Array.from(s)));
  }
  const pair = [Keypair.generate(), Keypair.generate()];
  writeFileSync(WALLETS_FILE, JSON.stringify(pair.map((k) => [...k.secretKey]), null, 2));
  return pair;
}

async function send(conn, payer, ixs, label) {
  const tx = new Transaction().add(...ixs);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  console.log(`  ${label} — ${sig}`);
  return sig;
}

const sol = (lamports) => (lamports / LAMPORTS_PER_SOL).toFixed(4);

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const faucet = faucetKeypair();
  const authority = loadKey(`${process.env.HOME}/.config/solana/zorr.json`);
  const [a, b] = demoWallets();
  // The same first eight the server's faucet hands out, so a demo wallet and a
  // wallet that claimed the starter kit can field the same deck.
  const seed = JSON.parse(readFileSync(new URL('./src/lib/devnet-coins.json', import.meta.url), 'utf8'));
  const starters = seed.coins.slice(0, 8);

  console.log('faucet    ', faucet.publicKey.toBase58(), sol(await conn.getBalance(faucet.publicKey)), 'SOL');
  console.log('authority ', authority.publicKey.toBase58(), sol(await conn.getBalance(authority.publicKey)), 'SOL');
  console.log('player A  ', a.publicKey.toBase58(), sol(await conn.getBalance(a.publicKey)), 'SOL');
  console.log('player B  ', b.publicKey.toBase58(), sol(await conn.getBalance(b.publicKey)), 'SOL');

  if (REPORT_ONLY) return;

  const have = await conn.getBalance(faucet.publicKey);
  const need = (PLAYER_SOL * 2 + FAUCET_KEEP_SOL) * LAMPORTS_PER_SOL;
  if (have < need) {
    console.error(`\nfaucet holds ${sol(have)} SOL, this plan needs ${sol(need)}`);
    process.exit(1);
  }

  // ── SOL ──────────────────────────────────────────────────────────────────
  console.log('\nSOL');
  for (const [who, kp] of [['A', a], ['B', b]]) {
    const held = await conn.getBalance(kp.publicKey);
    const want = PLAYER_SOL * LAMPORTS_PER_SOL;
    if (held >= want) { console.log(`  ${who} already holds ${sol(held)} — skipped`); continue; }
    await send(conn, faucet, [SystemProgram.transfer({
      fromPubkey: faucet.publicKey,
      toPubkey: kp.publicKey,
      lamports: want - held,
    })], `${who} +${sol(want - held)} SOL`);
  }

  // ── starter coins, so mint_card has something to mint from ───────────────
  // Split across two transactions: eight ATA creations plus eight transfers
  // packs past the 1232-byte limit, a failure that only appears once the whole
  // kit is assembled.
  console.log('\nstarter coins');
  for (const [who, kp] of [['A', a], ['B', b]]) {
    for (const batch of [starters.slice(0, 4), starters.slice(4)]) {
      const ixs = [];
      for (const c of batch) {
        const mint = new PublicKey(c.mint);
        const to = getAssociatedTokenAddressSync(mint, kp.publicKey);
        ixs.push(createAssociatedTokenAccountIdempotentInstruction(
          faucet.publicKey, to, kp.publicKey, mint,
        ));
        ixs.push(createTransferInstruction(
          getAssociatedTokenAddressSync(mint, faucet.publicKey), to, faucet.publicKey,
          BigInt(PLAYER_COIN_TOKENS) * BigInt(10) ** BigInt(c.decimals ?? 6),
        ));
      }
      await send(conn, faucet, ixs, `${who} ${batch.map((c) => c.ticker).join(' ')}`);
    }
  }

  // ── $MEMPIRE, minted by the authority ────────────────────────────────────
  console.log('\n$MEMPIRE');
  for (const [who, kp] of [['A', a], ['B', b]]) {
    const ata = getAssociatedTokenAddressSync(MEMPIRE_MINT, kp.publicKey);
    await send(conn, authority, [
      createAssociatedTokenAccountIdempotentInstruction(
        authority.publicKey, ata, kp.publicKey, MEMPIRE_MINT,
      ),
      createMintToInstruction(
        MEMPIRE_MINT, ata, authority.publicKey,
        BigInt(PLAYER_MEMPIRE) * BigInt(10) ** BigInt(MEMPIRE_DECIMALS),
      ),
    ], `${who} +${PLAYER_MEMPIRE} $MEMPIRE`);
  }

  console.log('\nfinal');
  for (const [who, kp] of [['faucet', faucet], ['A', a], ['B', b]]) {
    console.log(`  ${who.padEnd(7)} ${sol(await conn.getBalance(kp.publicKey))} SOL  ${kp.publicKey.toBase58()}`);
  }
  console.log(`\nkeys: ${WALLETS_FILE.pathname}`);
  console.log('next: node premint-demo.mjs   (eight cards each — BATTLE refuses without them)');
}

main().catch((e) => { console.error(e); process.exit(1); });
