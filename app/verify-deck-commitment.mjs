/**
 * F1: the client must reproduce the deck commitment the program derives.
 *
 * `validate_and_lock_deck` hashes SHA-256 over `(coin_mint, level)` for each
 * card in the order they were passed. This recomputes that from the cards the
 * chain says are locked to a live match and compares it to the `deck_hash` the
 * program actually stored. If they differ, `verifyOpponentCommitment` voids
 * every staked match — which is what it was doing.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import anchor from '@coral-xyz/anchor';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';

const idl = JSON.parse(fs.readFileSync('src/chain/mempire.idl.json', 'utf8'));
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), {});
const program = new anchor.Program(idl, provider);

const matches = await program.account.matchAccount.all();
matches.sort((a, b) => Number(b.account.id) - Number(a.account.id));
console.log(`  ${matches.length} match accounts on chain\n`);

// One sweep of every card, grouped by the match holding its lock — the public
// devnet RPC rate-limits a per-match `memcmp` scan long before 89 matches.
const allCards = await program.account.card.all();
const byLock = new Map();
for (const c of allCards) {
  const lock = c.account.lockedBy.toBase58();
  if (lock === '11111111111111111111111111111111') continue;
  if (!byLock.has(lock)) byLock.set(lock, []);
  byLock.get(lock).push(c);
}
console.log(`  ${allCards.length} cards, ${byLock.size} matches holding locks\n`);

let tested = 0;
for (const m of matches) {
  const id = Number(m.account.id);
  const cards = byLock.get(m.publicKey.toBase58()) ?? [];
  if (!cards.length) continue;

  // Group the locked cards by owner — each seat committed its own eight.
  for (let seat = 0; seat < 2; seat += 1) {
    const who = m.account.players[seat].toBase58();
    const mine = cards.filter((c) => c.account.owner.toBase58() === who);
    if (mine.length !== 8) continue;
    const stored = Buffer.from(m.account.deckHash[seat]).toString('hex');
    if (/^0+$/.test(stored)) continue;

    // The program hashes in the order the accounts were passed. That order is
    // not recoverable from chain, so try the two orders the client can produce
    // and report which — a match on either proves the preimage layout.
    const orders = {
      'by card id': [...mine].sort((a, b) => Number(a.account.id) - Number(b.account.id)),
      'by pubkey': [...mine].sort((a, b) => a.publicKey.toBase58().localeCompare(b.publicKey.toBase58())),
    };
    let hit = null;
    for (const [label, deck] of Object.entries(orders)) {
      const pre = Buffer.concat(deck.map((c) => Buffer.concat([
        c.account.coinMint.toBuffer(), Buffer.from([c.account.level]),
      ])));
      if (createHash('sha256').update(pre).digest('hex') === stored) hit = label;
    }
    tested += 1;
    console.log(`  match #${id} seat ${seat} (${who.slice(0, 8)}…)`);
    console.log(`    stored   ${stored.slice(0, 32)}…`);
    console.log(`    levels   [${mine.map((c) => c.account.level).join(', ')}]`);
    console.log(hit
      ? `    MATCH — preimage layout confirmed (order: ${hit})\n`
      : `    no order matched — layout differs\n`);
  }
  if (tested >= 4) break;
}
if (!tested) console.log('  no match currently holds a full locked deck — create one to test');
