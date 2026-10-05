import { AnchorProvider, Program, type Idl } from '@coral-xyz/anchor';
import type { Adapter } from '@solana/wallet-adapter-base';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey,
  Transaction, type VersionedTransaction,
} from '@solana/web3.js';
import type { Signer, ConfirmOptions, TransactionSignature } from '@solana/web3.js';
import idl from './mempire.idl.json';
import { PROGRAM_ID } from './pdas';
import { guestSolanaSigner } from '../lib/identity';

/**
 * The connection to the deployed program.
 *
 * Two capability tiers, kept explicit because they behave differently and the
 * UI has to tell the truth about which one it is in:
 *
 *  - **read** — always available, no wallet needed. Coins, config, cards,
 *    matches. This is what makes the app show real onchain data to a visitor
 *    who has not connected anything.
 *  - **write** — needs an adapter that can actually sign. Guest mode cannot,
 *    by construction: it has an address but no keypair. Anything that would
 *    submit a transaction must check `canSign` first rather than failing at
 *    signature time with a confusing wallet error.
 */

export const CLUSTER = (import.meta.env.VITE_CLUSTER as string | undefined) ?? 'devnet';

/** One switch for everything that must behave differently with real money. */
export const IS_MAINNET = CLUSTER === 'mainnet-beta' || CLUSTER === 'mainnet';

/*
 * The label and the endpoint must agree, and the tie-breaker is the endpoint.
 *
 * Everything money-adjacent keys off CLUSTER — but CLUSTER is a free-text env
 * var that defaults to 'devnet', and VITE_RPC_URL is set independently. Set a
 * mainnet RPC while forgetting the label and every "devnet-only" gate stays
 * open: most dangerously the guest signer, which would hand an unencrypted
 * localStorage keypair a live mainnet connection. So any URL that so much as
 * mentions mainnet forces the mainnet posture regardless of the label, and a
 * mainnet label with a devnet-looking URL is refused at module load — a build
 * misconfigured about which chain it is on must not boot quietly.
 */
const RPC_LOOKS_MAINNET = /mainnet/i.test(String(import.meta.env.VITE_RPC_URL ?? ''));
const RPC_LOOKS_DEVNET = /devnet|localhost|127\.0\.0\.1/i.test(String(import.meta.env.VITE_RPC_URL ?? ''));
export const TREAT_AS_MAINNET = IS_MAINNET || RPC_LOOKS_MAINNET;
if ((IS_MAINNET && RPC_LOOKS_DEVNET) || (!IS_MAINNET && RPC_LOOKS_MAINNET)) {
  throw new Error(
    `VITE_CLUSTER says ${CLUSTER} but VITE_RPC_URL says otherwise — refusing to boot a build that is confused about which chain it is on`,
  );
}

/**
 * Whether the deployed program carries the `nft` cargo feature.
 *
 * `nft` and `rollup` are compile-time features, so the launch build genuinely
 * has fewer instructions than this bundle's IDL describes — deploy rent scales
 * with program bytes, and Metaplex is the most expensive thing we link. This
 * client cannot ask the chain which build is deployed: the on-chain IDL is a
 * separate artifact that only changes when someone runs `anchor idl upgrade`,
 * so trusting it would trade one drift for another.
 *
 * So it is declared at build time, alongside the cluster it must agree with.
 * Getting it wrong is not dangerous — `readableChainError` still turns the
 * program's refusal into a sentence a player can read — it just means offering
 * a button that cannot work.
 *
 * Defaults on, because devnet runs the full build.
 */
export const NFT_ENABLED = String(import.meta.env.VITE_FEATURE_NFT ?? '1') !== '0';

/*
 * The default RPC follows the cluster. MagicBlock's base-layer endpoint is the
 * mainnet default because the game already depends on their infrastructure for
 * the rollup, and `api.mainnet-beta.solana.com` throttles browsers hard enough
 * to be unusable. A dedicated provider (Helius etc.) still wins when set.
 */
const RPC_URL = (import.meta.env.VITE_RPC_URL as string | undefined)
  ?? (IS_MAINNET ? 'https://rpc.magicblock.app/mainnet' : 'https://api.devnet.solana.com');

let connection: Connection | null = null;

/**
 * Rate-limit-aware fetch for the RPC.
 *
 * The public devnet endpoint sheds load with 429s, and web3.js surfaces one as
 * a rejected read rather than a retry. Every caller in this app treats a failed
 * read as an empty answer, so a throttled `getBalance` presented a funded
 * wallet as `◎ 0` — the stake tiers then greyed out and the game looked like it
 * had lost matchmaking, when it had merely been told to slow down.
 *
 * Retries only the responses worth retrying: 429 and 5xx are the endpoint
 * asking for time, and honouring `Retry-After` is the difference between
 * backing off and being banned. Anything else is a real answer and is returned
 * untouched. Four attempts caps the added wait at roughly three seconds, which
 * is far less than a player spends deciding a deck.
 */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export async function resilientFetch(
  input: RequestInfo | URL, init?: RequestInit,
): Promise<Response> {
  let wait = 250;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(input, init);
    } catch (e) {
      // A transport failure is worth one more try for the same reason a 503 is.
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, wait));
      wait *= 2;
      continue;
    }
    if (!RETRY_STATUS.has(res.status) || attempt >= 3) return res;

    const after = Number(res.headers.get('retry-after'));
    const delay = Number.isFinite(after) && after > 0
      ? Math.min(after * 1000, 4000)
      // Jittered, so a page that fires several reads at once does not line them
      // all up to retry on the same tick and get throttled together again.
      : wait + Math.floor(Math.random() * 150);
    await new Promise((r) => setTimeout(r, delay));
    wait *= 2;
  }
}

export function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(RPC_URL, {
      commitment: 'confirmed',
      // The public devnet RPC is slow under load; the default 30s times out on
      // confirmations that do in fact land.
      confirmTransactionInitialTimeout: 90_000,
      fetch: resilientFetch,
    });
  }
  return connection;
}

/** Minimal signing surface Anchor needs. An adapter satisfies it or it doesn't. */
interface SigningWallet {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
}

/**
 * The guest keypair, wrapped as something Anchor can sign with.
 *
 * Signs locally with no prompt, which is the point — but also means a guest
 * never gets the "do you approve this?" moment a wallet gives them. Every
 * caller that spends is behind an explicit button for exactly that reason.
 *
 * Returns null off devnet: an unencrypted browser key must not be handed
 * anything that holds real value. See `guestSolanaSigner`.
 */
function guestSigningWallet(): SigningWallet | null {
  // Fail closed on the *effective* cluster: a mainnet-looking RPC disables
  // guest signing even when the label says devnet. See TREAT_AS_MAINNET.
  if (TREAT_AS_MAINNET) return null;
  const kp = guestSolanaSigner(CLUSTER);
  if (!kp) return null;
  // tweetnacl keeps the 64-byte expanded secret; web3.js wants the same shape.
  const signer = Keypair.fromSecretKey(kp.secretKey);
  const sign = <T extends Transaction | VersionedTransaction>(tx: T): T => {
    if ('version' in tx) (tx as VersionedTransaction).sign([signer]);
    else (tx as Transaction).partialSign(signer);
    return tx;
  };
  return {
    publicKey: signer.publicKey,
    signTransaction: async (tx) => sign(tx),
    signAllTransactions: async (txs) => txs.map(sign),
  };
}

function asSigningWallet(adapter: Adapter | null): SigningWallet | null {
  // No adapter: fall back to the guest's own keypair, if this cluster allows
  // it. That is what lets someone play a genuinely staked match without
  // installing a wallet — the guest address is a real, fundable pubkey and was
  // only ever short a way to sign a transaction with it.
  if (!adapter?.publicKey) return guestSigningWallet();
  const a = adapter as unknown as Partial<SigningWallet>;
  if (typeof a.signTransaction !== 'function') return null;
  return {
    publicKey: adapter.publicKey,
    signTransaction: a.signTransaction.bind(adapter) as SigningWallet['signTransaction'],
    signAllTransactions: (typeof a.signAllTransactions === 'function'
      ? a.signAllTransactions.bind(adapter)
      // Not every adapter implements the batch path; signing one at a time is
      // equivalent, just more prompts.
      : (async <T extends Transaction | VersionedTransaction>(txs: T[]) => {
        const out: T[] = [];
        for (const tx of txs) out.push(await (a.signTransaction as SigningWallet['signTransaction'])(tx));
        return out;
      })) as SigningWallet['signAllTransactions'],
  };
}

/**
 * A read-only wallet. Anchor requires *a* wallet to build a provider even for
 * fetches; this one throws loudly if anything tries to sign through it, so a
 * missing `canSign` check surfaces as a clear error rather than a silent no-op.
 */
const READ_ONLY_KEY = new PublicKey('11111111111111111111111111111111');
const readOnlyWallet: SigningWallet = {
  publicKey: READ_ONLY_KEY,
  signTransaction: () => { throw new Error('read-only provider cannot sign'); },
  signAllTransactions: () => { throw new Error('read-only provider cannot sign'); },
};

/**
 * Micro-lamports per compute unit added to every base-layer transaction on
 * mainnet. Without a priority fee a transaction competes at zero and can sit
 * unlanded through the whole blockhash window during any congestion — which
 * for this app means stakes that never escrow and matches that never settle.
 * 10k µlamports ≈ 2,000 lamports on a 200k-CU transaction: a fraction of the
 * 5k base fee, bought landing reliability. Devnet stays at zero.
 */
const PRIORITY_MICROLAMPORTS = Number(import.meta.env.VITE_PRIORITY_FEE ?? (IS_MAINNET ? 10_000 : 0));

/**
 * AnchorProvider that prepends the compute-unit price to legacy transactions.
 *
 * One override instead of edits at thirty call sites: every `program.methods
 * .x().rpc()` in this app funnels through `sendAndConfirm`. Versioned
 * transactions pass through untouched (nothing here builds them), and the
 * instruction is skipped when one is already present so a caller that sets
 * its own fee is not double-charged.
 */
class FeeAwareProvider extends AnchorProvider {
  override async sendAndConfirm(
    tx: Transaction | VersionedTransaction,
    signers?: Signer[],
    opts?: ConfirmOptions,
  ): Promise<TransactionSignature> {
    if (
      PRIORITY_MICROLAMPORTS > 0
      && tx instanceof Transaction
      && !tx.instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId))
    ) {
      tx.instructions = [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICROLAMPORTS }),
        ...tx.instructions,
      ];
    }
    return super.sendAndConfirm(tx, signers, opts);
  }
}

export function getProvider(adapter: Adapter | null = null): AnchorProvider {
  const wallet = asSigningWallet(adapter) ?? readOnlyWallet;
  return new FeeAwareProvider(getConnection(), wallet as never, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
}

export function getProgram(adapter: Adapter | null = null): Program<Idl> {
  return new Program(idl as Idl, getProvider(adapter));
}

/** True when this adapter can actually submit a transaction. */
export function canSign(adapter: Adapter | null): boolean {
  return asSigningWallet(adapter) !== null;
}

export { PROGRAM_ID };

/** Explorer link. Mainnet is the explorer's default; devnet needs the param. */
export function explorerUrl(idOrSig: string, kind: 'tx' | 'address' = 'tx'): string {
  const suffix = IS_MAINNET ? '' : `?cluster=${CLUSTER}`;
  return `https://explorer.solana.com/${kind}/${idOrSig}${suffix}`;
}
