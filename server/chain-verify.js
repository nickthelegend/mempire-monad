/**
 * Reads a settled match off the chain so the leaderboard never has to
 * believe a client about money.
 *
 * `/api/match` used to fold client-asserted `payoutSol`/`potSol`/`escrowed`
 * into the public leaderboard's net-SOL column — one crafted POST per five
 * minutes and the top of the board is fiction. The signature middleware
 * proves *who* is talking, not that what they say happened happened. The
 * chain is what happened.
 *
 * Layouts are decoded by fixed offset from the program's account structs
 * (single source: chain/programs/mempire/src/lib.rs). If the program's
 * account layout ever changes, the discriminator stays the same but offsets
 * shift — bump these together with the program.
 */
import { Connection, PublicKey } from '@solana/web3.js';

const RPC = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
const PROGRAM_ID = new PublicKey(
  process.env.MEMPIRE_PROGRAM ?? 'BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP',
);

let conn = null;
const connection = () => (conn ??= new Connection(RPC, 'confirmed'));

const u64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

const matchPda = (id) => PublicKey.findProgramAddressSync(
  [Buffer.from('match'), u64le(id)], PROGRAM_ID,
)[0];
const configPda = () => PublicKey.findProgramAddressSync(
  [Buffer.from('config')], PROGRAM_ID,
)[0];

// Config { admin 32, treasury 32, mint_fee u64, rake_bps u16, tie_rake_bps u16, ... }
let cachedRake = null;
async function rakeBps() {
  if (cachedRake) return cachedRake;
  const info = await connection().getAccountInfo(configPda());
  if (!info) throw new Error('config account missing');
  const d = info.data;
  cachedRake = {
    rake: d.readUInt16LE(8 + 64 + 8),
    tieRake: d.readUInt16LE(8 + 64 + 8 + 2),
  };
  return cachedRake;
}

export const MATCH_STATE_SETTLED = 2;

/**
 * Returns the verified money facts for `address` in match `matchId`, or null
 * when the chain does not support the claim (no such match, not settled, or
 * the address is not a player). Callers treat null as "no lamports moved".
 */
export async function verifySettledMatch(matchId, address) {
  const id = Number(matchId);
  if (!Number.isInteger(id) || id < 0) return null;

  const info = await connection().getAccountInfo(matchPda(id));
  if (!info || !info.owner.equals(PROGRAM_ID)) return null;

  const d = info.data;
  // MatchAccount { id u64, tier u8, stake u64, players 2x32, deck_hash 64,
  //                power 8, state u8, ..., winner u8 (at 178) }
  const stakeLamports = d.readBigUInt64LE(8 + 8 + 1);
  const players = [
    new PublicKey(d.subarray(25, 57)).toBase58(),
    new PublicKey(d.subarray(57, 89)).toBase58(),
  ];
  const state = d.readUInt8(161);
  const winner = d.readUInt8(178);

  if (state !== MATCH_STATE_SETTLED) return null;
  const seat = players.indexOf(String(address));
  if (seat === -1) return null;

  const { rake, tieRake } = await rakeBps();
  const stake = Number(stakeLamports) / 1e9;
  const pot = stake * 2;

  /*
   * Every value `winner` can hold, and no `else`.
   *
   * The program writes four: 0 or 1 for a seat, 2 for a tie or a disputed
   * timeout, 3 for `cancel_match`, and `u8::MAX` at creation. This ended with
   * a bare `else { netSol = -stake }`, so both of the last two landed there.
   * A cancelled match — one nobody ever joined, whose stake `cancel_match`
   * hands straight back — was published on the money leaderboard as a
   * full-stake loss that never happened. It is the one column on that board
   * claiming to be read from the chain, so inventing a number for it is worse
   * than declining to.
   */
  let netSol;
  let won = false;
  let draw = false;
  if (winner === 3) {
    // cancel_match: no opponent ever joined, the whole stake was refunded.
    netSol = 0;
  } else if (winner === 2) {
    /*
     * A tie and a disputed timeout both write 2, and they pay differently:
     * `settle_from_log` takes `tie_rake_bps`, while `claim_timeout`'s dispute
     * branch refunds in full and rakes nothing. The account does not record
     * which happened, so this cannot tell them apart — it reports the tie,
     * which is the common case and errs by at most half the tie rake.
     */
    draw = true;
    netSol = (pot * (1 - tieRake / 10_000)) / 2 - stake;
  } else if (winner === seat) {
    won = true;
    netSol = pot * (1 - rake / 10_000) - stake;
  } else if (winner === 0 || winner === 1) {
    netSol = -stake;
  } else {
    // Settled with an unset winner is a state the program should never leave
    // behind. Report nothing rather than guess at it.
    return null;
  }
  return { netSol, potSol: pot, won, draw, players };
}

/**
 * Was `signature` a payment of at least `minTokens` $MEMPIRE from `payer` to
 * the treasury?
 *
 * The clan charter is charged by the browser, and the browser is not evidence.
 * `POST /api/clans` validated a wallet signature — which proves who is
 * talking, not that anyone paid — and then created the clan. The undo it
 * relied on was the *same browser* calling `leave` if the player cancelled, so
 * a caller that simply never ran that code founded a clan for nothing. This is
 * the check that makes the fee a fee.
 *
 * Balances rather than instructions: `postTokenBalances` minus
 * `preTokenBalances` for the treasury's account is what actually arrived, and
 * it cannot be fooled by an unusual instruction shape, a CPI, or a transfer
 * split across several instructions.
 *
 * Returns { ok: true, amount } or { ok: false, reason }.
 */
export async function verifyTokenPayment(signature, payer, mint, treasury, minBaseUnits) {
  if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(signature)) {
    return { ok: false, reason: 'that is not a transaction signature' };
  }
  let tx;
  try {
    tx = await connection().getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
  } catch (e) {
    return { ok: false, reason: `could not read that transaction: ${String(e?.message ?? e).slice(0, 80)}` };
  }
  if (!tx) return { ok: false, reason: 'that transaction is not on chain yet' };
  if (tx.meta?.err) return { ok: false, reason: 'that transaction failed on chain' };

  // The payer must have signed it, or anyone could cite somebody else's payment.
  const signers = (tx.transaction?.message?.accountKeys ?? [])
    .filter((k) => k.signer)
    .map((k) => String(k.pubkey));
  if (!signers.includes(String(payer))) {
    return { ok: false, reason: 'that payment was not signed by this wallet' };
  }

  const want = String(mint);
  const to = String(treasury);
  const sum = (rows) => (rows ?? [])
    .filter((b) => String(b.mint) === want && String(b.owner) === to)
    .reduce((n, b) => n + BigInt(b.uiTokenAmount?.amount ?? '0'), 0n);
  const delta = sum(tx.meta?.postTokenBalances) - sum(tx.meta?.preTokenBalances);
  if (delta < BigInt(minBaseUnits)) {
    return { ok: false, reason: `the treasury received ${delta} of the required ${minBaseUnits}` };
  }
  return { ok: true, amount: delta.toString() };
}

/** The treasury the program is currently configured to pay. */
export async function treasuryAddress() {
  const info = await connection().getAccountInfo(configPda());
  if (!info) throw new Error('config account missing');
  return new PublicKey(info.data.subarray(8 + 32, 8 + 64)).toBase58();
}
