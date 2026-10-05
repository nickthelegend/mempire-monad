/**
 * Does spending $MEMPIRE actually work, and does it tell the truth when it can't.
 *
 * Two wallets, because the two interesting states are different code paths and
 * only one of them is the happy one:
 *
 *   POOR — holds zero $MEMPIRE. The dialog must *say so*, name the shortfall,
 *          and refuse to sign. A greyed-out button with no reason is the bug
 *          this test exists to catch.
 *   RICH — funded from the mint authority. The dialog must take exactly the
 *          stated price, the treasury must receive exactly that, and the thing
 *          bought must appear.
 *
 * Everything is checked against chain balances rather than against what the UI
 * says about itself. A screen can claim a purchase happened; a token account
 * cannot.
 */
import { chromium } from 'playwright';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';

const URL = process.env.URL ?? 'https://play.mempire.fun';
const RPC = 'https://api.devnet.solana.com';
const cfg = JSON.parse(readFileSync('./src/lib/amm.json', 'utf8'));
const MINT = new PublicKey(cfg.mempireMint);
const UNIT = 10n ** BigInt(cfg.mempireDecimals);
const PROGRAM = new PublicKey('BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP');
const PRICE = { chestBuy: 100n, clanCharter: 250n };

const conn = new Connection(RPC, 'confirmed');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

async function mempireBalance(owner) {
  const ata = getAssociatedTokenAddressSync(MINT, owner, true);
  try {
    const b = await conn.getTokenAccountBalance(ata);
    return BigInt(b.value.amount);
  } catch {
    return 0n;
  }
}

/**
 * Give a wallet SOL for fees and, optionally, $MEMPIRE to spend.
 *
 * Transfers rather than mints. Minting fresh tokens for a test would inflate a
 * supply the AMM prices against, and the point here is to move real circulating
 * tokens exactly the way a player's would move. Devnet's airdrop is rate-limited
 * to uselessness, so the SOL comes from the same wallet.
 */
async function fund(payer, owner, tokens) {
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: owner.publicKey,
    lamports: Math.round(0.02 * LAMPORTS_PER_SOL),
  }));
  if (tokens > 0n) {
    const from = getAssociatedTokenAddressSync(MINT, payer.publicKey);
    const to = getAssociatedTokenAddressSync(MINT, owner.publicKey);
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, to, owner.publicKey, MINT,
    ));
    tx.add(createTransferInstruction(from, to, payer.publicKey, tokens * UNIT));
  }
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: 'confirmed' });
}

/** Open the app as `kp`, with the tutorial already dismissed. */
async function open(browser, kp) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  await ctx.addInitScript((sk) => {
    localStorage.setItem('mempire_guest_sk', sk);
    localStorage.setItem('mempire_tutorial_done', '1');
  }, bs58.encode(kp.secretKey));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [uncaught] ${e.message}`));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  // The landing gate, then the tutorial. The seeded key is what "Guest" picks
  // up, so this is the extension UI being skipped — not the wallet layer.
  await page.evaluate(async () => {
    const w = (ms) => new Promise((r) => setTimeout(r, ms));
    const btn = (re) => [...document.querySelectorAll('button')]
      .find((b) => re.test(b.textContent ?? ''));
    const connect = btn(/connect/i);
    if (connect) {
      connect.click();
      await w(700);
      btn(/guest/i)?.click();
      await w(1800);
      btn(/^\s*skip\s*$/i)?.click();
    }
  });
  await sleep(3000);
  return { ctx, page };
}

/** Click an empty chest slot and wait for the confirmation dialog. */
async function openChestBuy(page) {
  // The rail lives on CARDS, not the arena. The tab bar is not made of
  // buttons, so this clicks the element carrying the label.
  await page.evaluate(() => {
    const nav = document.querySelector('nav');
    [...(nav?.querySelectorAll('*') ?? [])]
      .find((e) => /^CARDS$/i.test((e.textContent ?? '').trim()))?.click();
  });
  await sleep(2000);
  const slot = page.getByRole('button', { name: /Empty chest slot/i }).first();
  if (!(await slot.isVisible().catch(() => false))) return null;
  await slot.click();
  await sleep(1200);
  const dialog = page.getByRole('dialog').first();
  return (await dialog.isVisible().catch(() => false)) ? dialog : null;
}

/** The deployer wallet: mint authority, treasury, and the only funded source. */
const bank = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(
    `${process.env.HOME}/.config/solana/zorr.json`, 'utf8',
  ))),
);

const poor = Keypair.generate();
const rich = Keypair.generate();
console.log(`poor wallet: ${poor.publicKey.toBase58()}`);
console.log(`rich wallet: ${rich.publicKey.toBase58()}`);

console.log('\nfunding…');
await fund(bank, poor, 0n);
await fund(bank, rich, 500n);
const richBefore = await mempireBalance(rich.publicKey);
console.log(`  poor holds ${await mempireBalance(poor.publicKey) / UNIT} $MEMPIRE`);
console.log(`  rich holds ${richBefore / UNIT} $MEMPIRE`);


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

// ---------------------------------------------------------------- broke wallet
console.log('\n=== a wallet with nothing in it ===');
{
  const { ctx, page } = await open(browser, poor);
  const dialog = await openChestBuy(page);
  check(!!dialog, 'an empty chest slot offers a purchase');
  if (dialog) {
    const text = await dialog.innerText();
    check(/not enough \$MEMPIRE/i.test(text), 'it says the balance is short', text.split('\n').find((l) => /not enough/i.test(l)) ?? '');
    check(/\b100\b/.test(text), 'it states the price');
    check(/need\s+100\s+more/i.test(text.replace(/\s+/g, ' ')), 'it states the exact shortfall',
      (text.replace(/\s+/g, ' ').match(/You need [\d,]+ more/i) ?? [''])[0]);
    const pay = dialog.getByRole('button', { name: /pay|need/i }).first();
    check(await pay.isDisabled().catch(() => false), 'it will not let them sign');
  }
  const after = await mempireBalance(poor.publicKey);
  check(after === 0n, 'nothing was taken from a wallet that could not pay', `${after} raw`);
  await ctx.close();
}

// ---------------------------------------------------------------- funded wallet
console.log('\n=== a wallet that can pay ===');
{
  const { ctx, page } = await open(browser, rich);
  const dialog = await openChestBuy(page);
  check(!!dialog, 'the purchase dialog opens');
  if (dialog) {
    const text = await dialog.innerText();
    check(/500/.test(text), 'it shows what they actually hold', (text.match(/You hold[\s\S]{0,24}/) ?? [''])[0].replace(/\s+/g, ' '));
    check(/golden chest/i.test(text), 'it names what is being bought');

    const treasuryBefore = await (async () => {
      const cfgPda = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM)[0];
      const info = await conn.getAccountInfo(cfgPda);
      if (!info) return null;
      const treasury = new PublicKey(info.data.subarray(8 + 32, 8 + 64));
      return { key: treasury, amount: await mempireBalance(treasury) };
    })();

    await dialog.getByRole('button', { name: /^pay/i }).first().click();
    console.log('  signing…');
    await sleep(14000);

    const after = await mempireBalance(rich.publicKey);
    const spent = richBefore - after;
    check(spent === PRICE.chestBuy * UNIT,
      'exactly the stated price left the wallet — no more, no less',
      `${spent / UNIT} $MEMPIRE`);

    if (treasuryBefore) {
      const now = await mempireBalance(treasuryBefore.key);
      check(now - treasuryBefore.amount === PRICE.chestBuy * UNIT,
        'the treasury received exactly that',
        `+${(now - treasuryBefore.amount) / UNIT} $MEMPIRE`);
    }

    await sleep(1500);
    const body = await page.innerText('body');
    check(/START/i.test(body) && !/or 100 \$M[\s\S]*or 100 \$M[\s\S]*or 100 \$M[\s\S]*or 100 \$M/.test(body),
      'the chest they paid for is in a slot');
  }

  // ---- skipping the timer: paid once, on chain, and it moves ----
  console.log('\n=== skipping a chest timer ===');
  {
    const before = await mempireBalance(rich.publicKey);
    // Start the bought chest unlocking so a skip has something to skip.
    await page.getByRole('button', { name: /^START$/i }).first().click().catch(() => {});
    await sleep(1500);
    const skip = page.getByRole('button', { name: /Skip .* \$MEMPIRE/i }).first();
    if (await skip.isVisible().catch(() => false)) {
      await skip.click();
      await sleep(1400);
      const d = page.getByRole('dialog').first();
      check(await d.isVisible().catch(() => false), 'skipping asks for confirmation');
      await d.getByRole('button', { name: /^pay/i }).first().click();
      await sleep(14000);
      const spent = before - await mempireBalance(rich.publicKey);
      check(spent === 25n * UNIT, 'the skip cost exactly 25 $MEMPIRE', `${spent / UNIT}`);
      // The bug this covers: the skip used to charge Crowns *as well*, and
      // failing that charge was a silent no-op — paid on chain, timer frozen.
      const body = await page.innerText('body');
      check(/OPEN/.test(body), 'the chest is open now — the timer actually moved');
    } else {
      check(false, 'a started chest offers a paid skip');
    }
  }

  // ---- and the other sink: founding a clan ----
  console.log('\n=== founding a clan ===');
  const beforeClan = await mempireBalance(rich.publicKey);
  const tag = `T${String(Date.now()).slice(-5)}`;
  await page.evaluate(() => {
    const nav = document.querySelector('nav');
    [...(nav?.querySelectorAll('*') ?? [])]
      .find((e) => /^CLAN$/i.test((e.textContent ?? '').trim()))?.click();
  });
  await sleep(2500);
  const found = page.getByRole('button', { name: /found|create/i }).first();
  if (await found.isVisible().catch(() => false)) {
    await found.click();
    await sleep(1200);
    // React controlled input: type it, so onChange fires for every keystroke.
    await page.getByPlaceholder('Degen Dynasty').first().click();
    await page.keyboard.type(`Testers ${tag}`, { delay: 30 });
    await sleep(600);
    await page.getByRole('button', { name: /found clan/i }).first().click();
    console.log('  creating, then charging…');
    await sleep(6000);

    const dialog = page.getByRole('dialog').first();
    const gotDialog = await dialog.isVisible().catch(() => false);
    if (!gotDialog) console.log('  [screen] ' + (await page.innerText('body')).replace(/\n+/g, ' | ').slice(0, 600));
    check(gotDialog, 'the charter asks for confirmation before taking anything');
    if (gotDialog) {
      const text = await dialog.innerText();
      check(/250/.test(text), 'it states the charter price', (text.match(/Price[\s\S]{0,26}/) ?? [''])[0].replace(/\s+/g, ' '));
      check(/dissolved/i.test(text), 'it warns that cancelling dissolves the clan');
      await dialog.getByRole('button', { name: /^pay/i }).first().click();
      await sleep(14000);
      const spent = beforeClan - await mempireBalance(rich.publicKey);
      check(spent === PRICE.clanCharter * UNIT,
        'the charter cost exactly what it said', `${spent / UNIT} $MEMPIRE`);

      // Dissolve it. Every run of this used to leave a clan behind, and five of
      // them were sitting in the live browse list beside the real ones — a test
      // that litters production is a test that makes the product look fake.
      await page.evaluate(async () => {
        const w = (ms) => new Promise((r) => setTimeout(r, ms));
        const btn = (re) => [...document.querySelectorAll('button')]
          .find((b) => re.test(b.textContent ?? ''));
        btn(/disband|leave clan/i)?.click();
        await w(900);
        btn(/disband|confirm|yes/i)?.click();
      });
      await sleep(2500);
    }
  } else {
    check(false, 'the clan screen offers founding');
  }
  await ctx.close();
}

await browser.close();

console.log(`\nreturned ${((await refund(poor)) + (await refund(rich))).toFixed(4)} SOL to the bank`);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
