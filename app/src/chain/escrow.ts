/**
 * The money half of a ranked match: escrow, log, agreement, payout.
 *
 * This is the piece the game shipped without. `create_match` and `join_match`
 * existed and were tested, but nothing in the app called them, so the SOL tier
 * on the Arena screen was a number in a store — a match with "0.05 SOL" on it
 * moved exactly zero lamports. Everything below drives the base `mempire`
 * program's own log, because that is the log `settle_from_log` reads.
 *
 * The sequence, and why it is this sequence:
 *
 *   seat 0  create_match       stake escrows, deck locks, match id assigned
 *           → relay the id, because seat 1 cannot derive it
 *   seat 1  join_match          second stake escrows, match goes Active
 *   seat 0  init + delegate     the log goes to a rollup
 *   both    end_match_log       each seat records its own result
 *   either  settle_from_log     one signature; the program checks agreement
 *
 * No step trusts the relay. Seat 1 reads the match account and checks the
 * stake, the state and the opponent before it stakes anything, so a peer that
 * lies about the id costs a refused join rather than a lost stake.
 *
 * Every failure path leaves the stake recoverable: an unjoined match is
 * `cancel_match`, an abandoned one is `claim_timeout`, and a disagreement voids
 * and refunds. None of them is silent — the caller reports which one ran.
 */
import { AnchorProvider, BN, Program, type Idl } from '@coral-xyz/anchor';
import type { Adapter } from '@solana/wallet-adapter-base';
import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import baseIdl from './mempire.idl.json';
import { PROGRAM_ID, matchPda } from './pdas';
import { getConnection, getProvider } from './provider';
import { baseLogPda } from './actions';
import { MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID, resolveEr, waitUndelegated } from './magicblock';

/**
 * The base program bound to a specific connection.
 *
 * The same program, and the same wallet, but pointed at either the base layer
 * or the rollup — `end_match_log` runs on the rollup while everything around
 * it runs on Solana, and using one provider for both would send half the
 * sequence to the wrong place.
 */
function programOn(adapter: Adapter | null, conn: Connection): Program {
  const base = getProvider(adapter);
  return new Program(baseIdl as Idl, new AnchorProvider(conn, base.wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  }));
}

/** Base layer, seat 0: create the log the settlement path reads. */
export async function initBaseLogTx(
  adapter: Adapter | null, matchId: number,
): Promise<string> {
  const conn = getConnection();
  const program = programOn(adapter, conn);
  const wallet = (program.provider as AnchorProvider).wallet;
  return program.methods
    .initMatchLog(new BN(matchId))
    .accounts({
      matchAccount: matchPda(matchId),
      matchLog: baseLogPda(matchId),
      payer: wallet.publicKey,
      systemProgram: SystemProgram.programId,
    } as never)
    .rpc();
}

/** Base layer, seat 0: hand the log to a rollup. */
export async function delegateBaseLogTx(
  adapter: Adapter | null, matchId: number, validator: PublicKey | null,
): Promise<string> {
  const conn = getConnection();
  const program = programOn(adapter, conn);
  const wallet = (program.provider as AnchorProvider).wallet;
  return program.methods
    .delegateMatchLog(new BN(matchId))
    .accounts({
      payer: wallet.publicKey,
      matchLog: baseLogPda(matchId),
      validator,
    } as never)
    .rpc();
}

/**
 * Rollup: record *this seat's* result.
 *
 * Both seats call it. The program keeps the two claims separately and only
 * commits the log home once both are in — so this is safe to call without
 * knowing whether the opponent has already gone, and there is no ordering to
 * coordinate.
 */
export async function claimResultEr(
  adapter: Adapter | null, matchId: number, winner: number, finalHash: bigint,
): Promise<{ signature: string; committed: boolean }> {
  const log = baseLogPda(matchId);
  const er = await resolveEr(log);

  /*
   * Settle wherever the log actually is.
   *
   * This used to throw when the log was not delegated, which made a rollup a
   * hard requirement for getting paid — so a lean deploy without the rollup
   * feature, or simply a rollup that was unreachable when the log was being
   * prepared, turned every finished match into an unpayable one that could
   * only time out. The claims are the same bytes either way; the only
   * difference is which cluster writes them and whether there is a commit to
   * schedule afterwards. Base layer needs no magic accounts, and the log is
   * already home, so there is nothing to wait for.
   */
  if (!er) {
    const program = programOn(adapter, getConnection());
    const wallet = (program.provider as AnchorProvider).wallet;
    const signature = await program.methods
      .endMatchLog(winner, new BN(finalHash.toString()))
      .accounts({ payer: wallet.publicKey, matchLog: log } as never)
      .rpc();
    return { signature, committed: true };
  }

  const program = programOn(adapter, er.conn);
  const wallet = (program.provider as AnchorProvider).wallet;
  const signature = await program.methods
    .endMatchLog(winner, new BN(finalHash.toString()))
    .accounts({
      payer: wallet.publicKey,
      matchLog: log,
      magicContext: MAGIC_CONTEXT_ID,
      magicProgram: MAGIC_PROGRAM_ID,
    } as never)
    .rpc();

  // The log only comes home once both seats agree. A false here is the normal
  // "still waiting on the opponent" case, not a failure.
  const committed = await waitUndelegated(log, PROGRAM_ID, 12_000).catch(() => false);
  return { signature, committed };
}

/** Has the log come home with both claims in it? */
export async function logIsSettleable(matchId: number): Promise<boolean> {
  const conn = getConnection();
  const info = await conn.getAccountInfo(baseLogPda(matchId)).catch(() => null);
  if (!info || !info.owner.equals(PROGRAM_ID)) return false;
  try {
    const program = programOn(null, conn);
    const log = await (program.account as never as {
      matchLog: { fetch: (a: PublicKey) => Promise<{ claims: number[] }> };
    }).matchLog.fetch(baseLogPda(matchId));
    return log.claims[0] !== 3 && log.claims[1] !== 3;
  } catch {
    return false;
  }
}
