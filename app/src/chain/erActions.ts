import { AnchorProvider, BN, Program, type Idl } from '@coral-xyz/anchor';
import type { Adapter } from '@solana/wallet-adapter-base';
import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import rollupIdl from './mempire_rollup.idl.json';
import { canSign, getConnection, getProvider } from './provider';
import { readableChainError } from './actions';
import { matchPda } from './pdas';
import {
  closeSession, forgetSession, openSession, sessionFor, sessionProvider,
} from './session';
import {
  IS_LOCALNET, LOCALNET_VALIDATOR, MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID,
  confirmCommit, getDelegationStatus, resolveEr, waitUndelegated,
} from './magicblock';

/**
 * The battle loop on MagicBlock.
 *
 * # Two programs, on purpose
 *
 * The rollup state lives in a **separate program** (`mempire_rollup`) from the
 * money (`mempire`). Two reasons, and the second matters more:
 *
 * 1. Adding the ER SDK to `mempire` — which already carries `anchor-spl` for the
 *    staking vaults — pushed that binary past what its deploy buffer could be
 *    funded for. The rollup program needs no token CPI and is a third the size.
 * 2. The rollup program **cannot move money**. It owns no lamports beyond its own
 *    rent and has no transfer path, so a delegated log can never guard a pot.
 *    Escrow, deck locks and payout stay in `mempire` on base layer, settled by
 *    its existing signature-verified `settle` using the hash this program
 *    commits. A stalled rollup costs latency and falls back to `claim_timeout`.
 *
 * # Routing — the destination is the contract
 *
 *   initLogTx       → base   (create the log)
 *   delegateLogTx   → base   (hand it to a rollup)
 *   playCardEr      → ER     (one card play)
 *   checkpointEr    → ER     (state-hash checkpoint)
 *   endLogEr        → ER     (seal + commit_and_undelegate)
 *   closeLogTx      → base   (reclaim rent once sealed)
 *
 * The same instruction sent to the wrong layer fails in a way that reads like a
 * program bug, so each function names its layer.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export const ROLLUP_PROGRAM_ID = new PublicKey((rollupIdl as { address: string }).address);

const enc = new TextEncoder();

function u64le(n: number | bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}

export function matchLogPda(matchId: number | bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc.encode('log'), u64le(matchId)],
    ROLLUP_PROGRAM_ID,
  )[0];
}

/**
 * MagicBlock's permission program, and the seed it derives from.
 *
 * The trailing colon is part of the seed. Dropping it derives a different PDA
 * that the permission program simply refuses, with an error that points nowhere
 * near the cause.
 */
export const PERMISSION_PROGRAM_ID = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');
export const EPHEMERAL_VAULT_ID = new PublicKey('MagicVau1t999999999999999999999999999999999');
const PERMISSION_SEED = enc.encode('permission:');

/** The ER-local permission guarding a delegated log. */
export function permissionPda(log: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [PERMISSION_SEED, log.toBytes()],
    PERMISSION_PROGRAM_ID,
  )[0];
}

export class NoSignerError extends Error {
  constructor() { super('This wallet cannot sign — connect a real wallet to play onchain.'); }
}

/**
 * The key that will sign, or throw.
 *
 * A guest has no adapter — it signs with a browser-held keypair the provider
 * knows about — so requiring `adapter.publicKey` would reject every guest
 * regardless of what `canSign` reports. Ask the provider instead, which is the
 * thing that actually does the signing.
 */
function requireSigner(adapter: Adapter | null): { publicKey: PublicKey } {
  if (!canSign(adapter)) throw new NoSignerError();
  const key = adapter?.publicKey ?? getProvider(adapter).wallet.publicKey;
  if (!key) throw new NoSignerError();
  return { publicKey: key };
}

/** The rollup program on base layer. */
function baseProgram(adapter: Adapter | null): Program<Idl> {
  return new Program(rollupIdl as Idl, getProvider(adapter));
}

/** The rollup program bound to a specific ER endpoint. */
function erProgram(adapter: Adapter | null, conn: Connection): Program<Idl> {
  const base = getProvider(adapter);
  return new Program(rollupIdl as Idl, new AnchorProvider(conn, base.wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  }));
}

export interface TxResult { signature: string }

/** Base layer. Creates the log and records both seats. */
export async function initLogTx(
  adapter: Adapter | null, matchId: number, players: [string, string],
): Promise<TxResult & { log: string }> {
  const wallet = requireSigner(adapter);
  const program = baseProgram(adapter);
  const log = matchLogPda(matchId);

  /*
   * The rollup program now reads the seats out of the escrowed match rather
   * than believing this argument, so it needs the match account itself. The
   * two keys are still sent and still have to agree with what the chain says —
   * a client that disagrees is refused rather than quietly logging a different
   * match than it meant.
   */
  const signature = await program.methods
    .initLog(new BN(matchId), [new PublicKey(players[0]), new PublicKey(players[1])])
    .accounts({
      matchAccount: matchPda(matchId),
      log,
      payer: wallet.publicKey!,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();

  return { signature, log: log.toBase58() };
}

/**
 * Base layer. Delegates the log to an ephemeral rollup.
 *
 * `validator` is only supplied on localnet. Naming a specific validator is
 * *required* there — an unassigned delegation is refused by a specific ER even
 * though base ownership and the ER clone both look correct, which is a
 * genuinely confusing failure. On devnet the router assigns placement, so the
 * account is left off.
 */
export async function delegateLogTx(
  adapter: Adapter | null, matchId: number, localnet = false,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const program = baseProgram(adapter);

  /*
   * Put the log on the validator that already holds this wallet's chest rail.
   *
   * `end_log` grants the winner's chest only when the rail is an account the
   * same rollup can write, and `endLogEr` drops the rail rather than risk the
   * settlement when it is not. Left to the router, the log and the rail are
   * placed by two independent decisions — so the rail was routinely somewhere
   * else, the grant was skipped every time, and the chest fell back to a local
   * roll with no VRF badge ever reaching the UI. Nothing looked broken; the
   * one account that had to be co-located simply never was.
   *
   * Falls back to router assignment if the hint is unusable. A missed chest is
   * worth far less than a match that cannot start.
   */
  let validator: PublicKey | null = localnet ? LOCALNET_VALIDATOR : null;
  if (!localnet) {
    try {
      const rail = chestsPda(wallet.publicKey!);
      const status = await getDelegationStatus(rail);
      const authority = status.isDelegated ? status.delegationRecord?.authority : undefined;
      if (authority) validator = new PublicKey(authority);
    } catch { /* router unreachable — let it assign */ }
  }

  const send = (v: PublicKey | null) => program.methods
    .delegateLog(new BN(matchId))
    .accounts({ payer: wallet.publicKey!, log: matchLogPda(matchId), validator: v } as any)
    .rpc();

  try {
    return { signature: await send(validator) };
  } catch (e) {
    if (localnet || !validator) throw e;
    return { signature: await send(null) };
  }
}

/**
 * ER. One card play.
 *
 * Resolves the rollup through the router on each call rather than caching an
 * endpoint for the match: placement is the router's to decide, and a cached FQDN
 * is how an integration ends up talking to a validator that no longer holds the
 * account.
 */
export async function playCardEr(
  adapter: Adapter | null,
  matchId: number,
  tick: number,
  deckIndex: number,
  x: number,
  y: number,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const log = matchLogPda(matchId);
  const er = await resolveEr(log);
  if (!er) throw new Error('match log is not delegated to a rollup');

  // Sign with the match's session key when it has one. The rollup accepts
  // either the seat's wallet or the temporary key that seat authorised, and
  // the account list is identical — so this is purely a question of who holds
  // the pen, never of what gets passed.
  const kp = sessionFor(matchId);
  const prog = kp
    ? new Program(rollupIdl as Idl, sessionProvider(er.conn, kp))
    : erProgram(adapter, er.conn);

  const signature = await prog.methods
    .playCard(tick, deckIndex, x, y)
    .accounts({ log, player: (kp?.publicKey ?? wallet.publicKey)! } as any)
    .rpc();

  return { signature };
}

/** ER. Records a state-hash checkpoint. */
export async function checkpointEr(
  adapter: Adapter | null, matchId: number, tick: number, hash: bigint,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const log = matchLogPda(matchId);
  const er = await resolveEr(log);
  if (!er) throw new Error('match log is not delegated to a rollup');

  const kp = sessionFor(matchId);
  const prog = kp
    ? new Program(rollupIdl as Idl, sessionProvider(er.conn, kp))
    : erProgram(adapter, er.conn);

  const signature = await prog.methods
    .checkpoint(tick, new BN(hash.toString()))
    .accounts({ log, player: (kp?.publicKey ?? wallet.publicKey)! } as any)
    .rpc();

  return { signature };
}

/**
 * ER. Seals the log and commits it back to base layer.
 *
 * Reports the base-layer commit signature only after confirming it there. The ER
 * signature alone proves the intent was accepted, not that the state landed —
 * and settlement reads base-layer state.
 */
/**
 * Rollup. Seals the log so only the two seats can read it (PER).
 *
 * The simulation runs two ticks behind the input a player submits. That delay
 * is only safe while nobody can read the log faster than the sim consumes it —
 * otherwise an observer polling the rollup sees the opponent's card and
 * placement *before* it resolves on screen. With real SOL on the match that is
 * a cheat, not a leak.
 *
 * Idempotent onchain: sealing an already-sealed log returns success.
 */
export async function sealLogEr(
  adapter: Adapter | null, matchId: number,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const log = matchLogPda(matchId);
  const er = await resolveEr(log);
  if (!er) throw new Error('match log is not delegated to a rollup');

  const signature = await erProgram(adapter, er.conn).methods
    .sealLog()
    .accounts({
      payer: wallet.publicKey!,
      log,
      permission: permissionPda(log),
      ephemeralVault: EPHEMERAL_VAULT_ID,
      permissionProgram: PERMISSION_PROGRAM_ID,
      magicProgram: MAGIC_PROGRAM_ID,
    } as any)
    .rpc();
  return { signature };
}

/**
 * Rollup. Closes the seal, refunding its rent to the log.
 *
 * Must run before `endLogEr`: the permission is ER-local, so once the log is
 * undelegated nothing can reach it to close it and its rent stays behind.
 *
 * Not idempotent — once the permission is closed the account is gone and
 * transaction verification rejects it before the instruction runs. Callers
 * treat a failure here as non-fatal and continue to end the match; `end_log`
 * deliberately does not depend on the permission, so the worst case is a few
 * lamports stranded on a rollup that is about to forget them anyway.
 */
export async function unsealLogEr(
  adapter: Adapter | null, matchId: number,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const log = matchLogPda(matchId);
  const er = await resolveEr(log);
  if (!er) throw new Error('match log is not delegated to a rollup');

  const signature = await erProgram(adapter, er.conn).methods
    .unsealLog()
    .accounts({
      payer: wallet.publicKey!,
      log,
      permission: permissionPda(log),
      ephemeralVault: EPHEMERAL_VAULT_ID,
      permissionProgram: PERMISSION_PROGRAM_ID,
      magicProgram: MAGIC_PROGRAM_ID,
    } as any)
    .rpc();
  return { signature };
}

/* ── VRF chests ────────────────────────────────────────────────────────────
 *
 * The rail is a delegated account, so a roll costs nothing: MagicBlock prices
 * ER randomness at zero and base-layer randomness at 0.0008 SOL per request.
 * Everything below routes to the rollup for that reason.
 */

/** Delegated VRF queue. Only a queue that lives on the ER is writable from it. */
export const EPHEMERAL_QUEUE = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc');

export function chestsPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc.encode('chests'), owner.toBytes()],
    ROLLUP_PROGRAM_ID,
  )[0];
}

/** Base layer. Creates the rail, then hands it to a rollup. Idempotent. */
export async function ensureChestRail(adapter: Adapter | null): Promise<PublicKey> {
  const wallet = requireSigner(adapter);
  const owner = wallet.publicKey!;
  const rail = chestsPda(owner);
  const conn = getConnection();

  const existing = await conn.getAccountInfo(rail);
  if (!existing) {
    await baseProgram(adapter).methods
      .initChests()
      .accounts({ chests: rail, owner, systemProgram: SystemProgram.programId } as any)
      .rpc();
  }
  const status = await resolveEr(rail);
  if (!status) {
    await baseProgram(adapter).methods
      .delegateChests()
      .accounts({ owner, chests: rail, validator: IS_LOCALNET ? LOCALNET_VALIDATOR : null } as any)
      .rpc();
  }
  return rail;
}

/**
 * Rollup. Asks the oracle to roll one chest.
 *
 * Returns when the request is *accepted*, which is not an outcome — the oracle
 * fulfils it in a separate transaction. Callers must poll `readChestRail` and
 * show "opening" until the slot reports filled.
 */
export async function requestChestEr(
  adapter: Adapter | null, slotIndex: number, clientSeed: number,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const owner = wallet.publicKey!;
  const rail = chestsPda(owner);
  const er = await resolveEr(rail);
  if (!er) throw new Error('chest rail is not delegated to a rollup');

  const signature = await erProgram(adapter, er.conn).methods
    .requestChest(slotIndex, clientSeed & 0xff)
    .accounts({
      payer: owner, chests: rail, owner, oracleQueue: EPHEMERAL_QUEUE,
    } as any)
    .rpc();
  return { signature };
}

/** Rollup. Takes a filled chest and frees its slot. */
export async function claimChestEr(
  adapter: Adapter | null, slotIndex: number,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const owner = wallet.publicKey!;
  const rail = chestsPda(owner);
  const er = await resolveEr(rail);
  if (!er) throw new Error('chest rail is not delegated to a rollup');

  const signature = await erProgram(adapter, er.conn).methods
    .claimChest(slotIndex)
    .accounts({ chests: rail, owner } as any)
    .rpc();
  return { signature };
}

export interface ChestSlotChain {
  state: number; // 0 empty, 1 pending, 2 filled
  tier: number;
  nonce: bigint;
  randomness: Uint8Array;
}

/** Reads the rail from wherever it currently lives. */
export async function readChestRail(
  adapter: Adapter | null,
): Promise<{
  slots: ChestSlotChain[]; pendingSlot: number; earned: number; opened: number;
} | null> {
  const wallet = requireSigner(adapter);
  const rail = chestsPda(wallet.publicKey!);
  const er = await resolveEr(rail);
  const conn = er ? er.conn : getConnection();
  try {
    const acc: any = await (erProgram(adapter, conn).account as any)
      .playerChests.fetch(rail);
    return {
      slots: acc.slots.map((s: any) => ({
        state: Number(s.state),
        tier: Number(s.tier),
        nonce: BigInt(s.nonce.toString()),
        randomness: Uint8Array.from(s.randomness),
      })),
      pendingSlot: Number(acc.pendingSlot),
      /*
       * The entitlement counters, which are not two of a kind.
       *
       * `earned` is the balance `request_chest` spends — the program's actual
       * test is `require!(c.earned > 0, NoChestEarned)`. `opened` is a
       * lifetime tally the program keeps "purely for display and
       * reconciliation" and never reads back.
       *
       * This comment used to say the program refused anything but
       * `earned > opened`, and the caller was written to match it. It does
       * not, and since `earned` is capped at MAX_UNSPENT_CHESTS while
       * `opened` only grows, that gate shut for good after four chests and
       * quietly took the oracle roll with it.
       */
      earned: Number(acc.earned),
      opened: Number(acc.opened),
    };
  } catch {
    return null;
  }
}

/**
 * Authorises a temporary signer for this match. One wallet popup, then none.
 *
 * Runs on the rollup, where the log lives — a session recorded on base layer
 * would not be readable by the validator that has to check it.
 */
export async function openSessionEr(
  adapter: Adapter | null, matchId: number,
): Promise<boolean> {
  // Called for the check, not the key — `openSession` resolves its own signer
  // from the provider, and this refuses early rather than opening a rollup
  // connection for a session that could never be authorised.
  requireSigner(adapter);
  const log = matchLogPda(matchId);
  const er = await resolveEr(log);
  if (!er) return false;
  return openSession(adapter, matchId, erProgram(adapter, er.conn), log);
}

/** Revokes it. Never throws — expiry is the backstop. */
export async function closeSessionEr(
  adapter: Adapter | null, matchId: number,
): Promise<void> {
  if (!canSign(adapter)) { forgetSession(); return; }
  const log = matchLogPda(matchId);
  const er = await resolveEr(log);
  if (!er) { forgetSession(); return; }
  await closeSession(adapter, erProgram(adapter, er.conn), log);
}

/**
 * Rollup. Seals the result, then commits and undelegates the log.
 *
 * `winnerChests` is the rail the chest entitlement is credited to. The program
 * takes it as an optional account and skips the grant when it is absent, so
 * settlement never depends on a reward account existing — but we pass it
 * whenever the winner's rail is already delegated, which `ensureChestRail` at
 * match start makes the normal case.
 */
export async function endLogEr(
  adapter: Adapter | null,
  matchId: number,
  winner: number,
  finalHash: bigint,
  winnerAddress?: PublicKey,
): Promise<TxResult & { commitSignature: string | null; undelegated: boolean }> {
  const wallet = requireSigner(adapter);
  const log = matchLogPda(matchId);
  const er = await resolveEr(log);
  if (!er) throw new Error('match log is not delegated to a rollup');

  // Only send the rail if it is actually on this rollup. Naming an account the
  // rollup does not hold fails the whole transaction, and a missed chest is
  // worth far less than a match that cannot be settled.
  let winnerChests: PublicKey | null = null;
  if (winner < 2 && winnerAddress) {
    const rail = chestsPda(winnerAddress);
    const railEr = await resolveEr(rail).catch(() => null);
    if (railEr && railEr.conn.rpcEndpoint === er.conn.rpcEndpoint) winnerChests = rail;
  }

  const signature = await erProgram(adapter, er.conn).methods
    .endLog(winner, new BN(finalHash.toString()))
    .accounts({
      payer: wallet.publicKey!,
      log,
      winnerChests,
      magicProgram: MAGIC_PROGRAM_ID,
      magicContext: MAGIC_CONTEXT_ID,
    } as any)
    .rpc();

  const commitSignature = await confirmCommit(signature, er.conn);
  const undelegated = await waitUndelegated(log, ROLLUP_PROGRAM_ID);
  return { signature, commitSignature, undelegated };
}

/** Base layer. Reclaims the log's rent once the match is sealed. */
export async function closeLogTx(
  adapter: Adapter | null, matchId: number,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const signature = await baseProgram(adapter).methods
    .closeLog()
    .accounts({ log: matchLogPda(matchId), payer: wallet.publicKey! } as any)
    .rpc();
  return { signature };
}

/** Reads the committed log off base layer — the onchain record of the match. */
export async function fetchLog(matchId: number): Promise<{
  plays: number; lastTick: number; lastHash: string; checkpoints: number;
  ended: boolean; winner: number;
  /** The seat that paid for the account, and the only one `close_log` refunds. */
  funder: string | null;
} | null> {
  try {
    const program = baseProgram(null);
    const raw: any = await (program.account as any).matchLog.fetchNullable(matchLogPda(matchId));
    if (!raw) return null;
    return {
      plays: raw.plays?.length ?? 0,
      lastTick: Number(raw.lastTick ?? 0),
      lastHash: String(raw.lastHash ?? '0'),
      checkpoints: Number(raw.checkpoints ?? 0),
      ended: Boolean(raw.ended),
      winner: Number(raw.winner ?? 255),
      funder: raw.funder ? String(raw.funder) : null,
    };
  } catch {
    return null;
  }
}

export { readableChainError };
