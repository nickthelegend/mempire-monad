import { AnchorProvider, Program, type Idl } from '@coral-xyz/anchor';
import { DELEGATION_PROGRAM_ID, GetCommitmentSignature } from '@magicblock-labs/ephemeral-rollups-sdk';
import type { Adapter } from '@solana/wallet-adapter-base';
import { Connection, PublicKey } from '@solana/web3.js';
import idl from './mempire.idl.json';
import { IS_MAINNET, getConnection as getBaseConnection, getProvider, resilientFetch } from './provider';

/**
 * MagicBlock Ephemeral Rollup plumbing.
 *
 * Three connections, and using the wrong one is the single most common way an ER
 * integration fails silently:
 *
 *  - **base** — Solana devnet. Account creation, delegation, and settlement.
 *  - **router** — resolves *where* a delegated account currently lives. The ER
 *    endpoint is discovered per account, never hardcoded, because placement is
 *    the router's decision and can differ by account and region.
 *  - **ER** — the `fqdn` the router returns. Card plays, checkpoints, and the
 *    commit/undelegate all go here.
 *
 * Delegation flips base-layer ownership to the delegation program. That is a
 * routing signal only — every instruction still enforces its own player and PDA
 * checks on the rollup, exactly as it would on Solana.
 */

// Endpoints follow the cluster. MagicBlock's mainnet fleet (as/eu/us
// .magicblock.app + router.magicblock.app) is live — verified against
// status.magicblock.app before this was written.
const ROUTER_URL = (import.meta.env.VITE_MB_ROUTER as string | undefined)
  ?? (IS_MAINNET ? 'https://router.magicblock.app/' : 'https://devnet-router.magicblock.app/');

/** Only used when the router has nothing to say (account not yet delegated). */
const FALLBACK_ER = (import.meta.env.VITE_MB_ER as string | undefined)
  ?? (IS_MAINNET ? 'https://as.magicblock.app/' : 'https://devnet-as.magicblock.app/');

export const MAGIC_PROGRAM_ID = new PublicKey('Magic11111111111111111111111111111111111111');
export const MAGIC_CONTEXT_ID = new PublicKey('MagicContext1111111111111111111111111111111');
/**
 * The local `mb-stack` validator's identity.
 *
 * Delegation must name this explicitly on localnet: an unassigned delegation
 * (`DelegateConfig::validator = None`) is refused by a specific ER even though
 * base ownership flips and the ER clone reports the right owner — the write then
 * fails with `InvalidWritableAccount`, which points nowhere near the cause. On
 * devnet the router assigns placement, so the field is left unset.
 */
export const LOCALNET_VALIDATOR = new PublicKey('mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev');

/** True when the configured cluster is a local validator. */
export const IS_LOCALNET = /localhost|127\.0\.0\.1/.test(
  (import.meta.env.VITE_RPC_URL as string | undefined) ?? '',
);

export interface DelegationStatus {
  isDelegated: boolean;
  fqdn?: string;
  delegationRecord?: {
    authority: string;
    owner: string;
    delegationSlot: number;
    lamports: number;
  };
}

/** Router JSON-RPC. Throws on a router-level error so callers can fall back. */
export async function getDelegationStatus(account: PublicKey): Promise<DelegationStatus> {
  // Through the same backoff: placement is looked up before every rollup call
  // and before delegating a match log, so a throttled router reads as "not
  // delegated" and quietly downgrades the match off the rollup entirely.
  const res = await resilientFetch(ROUTER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getDelegationStatus',
      params: [account.toBase58()],
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(String(body.error.message ?? 'router error'));
  return (body.result ?? { isDelegated: false }) as DelegationStatus;
}

const erCache = new Map<string, Connection>();

/** One Connection per ER endpoint — they are stateful and shouldn't be rebuilt. */
export function erConnection(fqdn: string): Connection {
  const url = fqdn.replace(/\/+$/, '');
  let c = erCache.get(url);
  if (!c) {
    c = new Connection(url, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 30_000,
      // Same backoff as the base layer. A throttled rollup read is a card play
      // that silently did not land, which in a 20-tick sim is worse than a slow one.
      fetch: resilientFetch,
    });
    erCache.set(url, c);
  }
  return c;
}

/**
 * The ER endpoint for an account, or null when it isn't delegated.
 *
 * Returns null rather than guessing: sending a delegated-account operation to
 * the wrong rollup fails with `InvalidWritableAccount`, and sending it to base
 * layer fails because the delegation program owns the account there.
 */
export async function resolveEr(account: PublicKey): Promise<{ fqdn: string; conn: Connection } | null> {
  try {
    const status = await getDelegationStatus(account);
    if (!status.isDelegated) return null;
    const fqdn = status.fqdn ?? FALLBACK_ER;
    return { fqdn, conn: erConnection(fqdn) };
  } catch {
    return null;
  }
}

/** An Anchor program bound to a specific ER endpoint. */
export function erProgram(adapter: Adapter | null, conn: Connection): Program<Idl> {
  const base = getProvider(adapter);
  const provider = new AnchorProvider(conn, base.wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  return new Program(idl as Idl, provider);
}

/**
 * Confirms that a commit issued on the ER actually landed on base layer.
 *
 * The ER signature only proves the *intent* was accepted. `GetCommitmentSignature`
 * digs the base-layer signature out of the ER logs, and that is the one worth
 * confirming — settlement reads base-layer state, so anything short of this is
 * reporting success before the money is real.
 */
export async function confirmCommit(erSignature: string, conn: Connection): Promise<string | null> {
  try {
    const baseSig = await GetCommitmentSignature(erSignature, conn);
    await getBaseConnection().confirmTransaction(baseSig, 'confirmed');
    return baseSig;
  } catch {
    return null;
  }
}

/**
 * True once the account is back under this program's ownership on base layer.
 *
 * Polled after `commit_and_undelegate` because settlement cannot read the log as
 * an `Account<MatchLog>` until ownership has actually reverted — the Anchor
 * constraint that decodes it *is* the "log is home" check.
 */
export async function waitUndelegated(
  account: PublicKey, programId: PublicKey, timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await getBaseConnection().getAccountInfo(account);
    if (info && info.owner.equals(programId)) return true;
    await new Promise((r) => setTimeout(r, 1200));
  }
  return false;
}

/** Base ownership by the delegation program is the expected delegated state. */
export function looksDelegated(owner: PublicKey): boolean {
  return owner.equals(DELEGATION_PROGRAM_ID);
}

export { DELEGATION_PROGRAM_ID };
