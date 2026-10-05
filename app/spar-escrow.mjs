/**
 * A sparring partner that actually stakes.
 *
 * The plain `spar.mjs` holds a queue slot but never touches the chain, so the
 * match it pairs into stays `Open` — and the browser seat correctly declines to
 * delegate a rollup log for a match nobody joined. That made C5's settlement
 * half and C7 untestable rather than broken.
 *
 * This one joins the escrow for real with wallet B: same `join_match`
 * instruction, same deck-hash commitment, same locked-card remaining accounts
 * as the client. Once it joins, the match reaches `Active` and the browser's
 * `prepareLog` has something to delegate.
 *
 * It plays no cards. The simulation is the browser's; this exists so the money
 * half of the flow has a genuine second party.
 */
import WebSocket from 'ws';
import anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';

const WS = 'wss://mempire-relay-production.up.railway.app/ws';
const RPC = 'https://api.devnet.solana.com';
const PROGRAM = new PublicKey('BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP');
const idl = JSON.parse(readFileSync(new URL('./src/chain/mempire.idl.json', import.meta.url)));
const demo = JSON.parse(readFileSync(new URL('./.demo-wallets.json', import.meta.url)));

const kp = Keypair.fromSecretKey(Uint8Array.from(demo['1']));
const conn = new Connection(RPC, 'confirmed');
const wallet = {
  publicKey: kp.publicKey,
  signTransaction: async (t) => { t.partialSign(kp); return t; },
  signAllTransactions: async (ts) => ts.map((t) => { t.partialSign(kp); return t; }),
};
const provider = new anchor.AnchorProvider(conn, wallet, { commitment: 'confirmed' });
const program = new anchor.Program(idl, provider);

const le = (n) => new anchor.BN(n).toArrayLike(Buffer, 'le', 8);
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM)[0];
const configPda = () => pda(Buffer.from('config'));
const matchPda = (id) => pda(Buffer.from('match'), le(id));
const cardPda = (id) => pda(Buffer.from('card'), le(id));

/** FNV-1a over the deck's mints, in order — byte-identical to the client. */
function deckHashBytes(mints) {
  const out = new Uint8Array(32);
  let h = 0x811c9dc5;
  const text = mints.join(',');
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  for (let i = 0; i < 32; i += 1) { out[i] = h & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
  return out;
}

// Eight unlocked cards, one per coin — the same rule the deck enforces.
const DEFAULT = PublicKey.default.toBase58();
const owned = await program.account.card.all([
  { memcmp: { offset: 16, bytes: kp.publicKey.toBase58() } },
]);
const byCoin = new Map();
for (const c of owned) {
  if (c.account.lockedBy.toBase58() !== DEFAULT) continue;
  const mint = c.account.coinMint.toBase58();
  if (!byCoin.has(mint)) byCoin.set(mint, c.account.id.toNumber());
}
const deckIds = [...byCoin.values()].slice(0, 8);
const deckMints = [...byCoin.keys()].slice(0, 8);
if (deckIds.length < 8) {
  console.log(`spar-escrow: only ${deckIds.length} free distinct coins — need 8`);
  process.exit(1);
}
console.log('spar-escrow: deck ready', deckIds.join(','));

const relayDeck = deckMints.map((m, i) => ({
  coinId: m, name: `S${i}`, archetype: i % 6, level: 1,
}));

const ws = new WebSocket(WS);
ws.on('open', () => {
  console.log('spar-escrow: queueing');
  ws.send(JSON.stringify({
    t: 'queue', tier: 0, address: kp.publicKey.toBase58(), deck: relayDeck,
    format: 'standard', ranked: true, trophies: 16, name: 'Sparring Partner',
  }));
});

ws.on('message', async (raw) => {
  let m; try { m = JSON.parse(String(raw)); } catch { return; }
  if (m.t !== 'matched') return;
  console.log('spar-escrow: matched, role', m.role, 'opponent', m.opponent?.address);
  if (m.role === 0) { console.log('spar-escrow: we are seat 0 — the browser must queue first'); return; }

  // Seat 1: find the opponent's open match and match their stake.
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    const all = await program.account.matchAccount.all();
    const open = all
      .map((x) => ({ id: x.account.id.toNumber(), state: x.account.state, players: x.account.players.map((p) => p.toBase58()) }))
      .filter((x) => x.state === 0 && x.players[0] === m.opponent.address)
      .sort((a, b) => b.id - a.id)[0];
    if (!open) { console.log('spar-escrow: waiting for their CreateMatch…'); continue; }
    try {
      const sig = await program.methods
        .joinMatch(Array.from(deckHashBytes(deckMints)))
        .accounts({
          config: configPda(),
          matchAccount: matchPda(open.id),
          player: kp.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(deckIds.map((id) => ({ pubkey: cardPda(id), isWritable: true, isSigner: false })))
        .rpc();
      console.log(`spar-escrow: JOINED match #${open.id} — ${sig}`);
      return;
    } catch (e) {
      console.log('spar-escrow: join failed —', e.message?.slice(0, 160));
      return;
    }
  }
});

setTimeout(() => { console.log('spar-escrow: done'); process.exit(0); }, 150000);
