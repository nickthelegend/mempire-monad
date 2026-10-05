import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import type { Adapter } from '@solana/wallet-adapter-base';
import { apiFetch, apiPost, hasApi } from '../lib/api';
import { getConnection, getProvider } from './provider';

/**
 * The $MEMPIRE market, when it lives on Bags rather than in our own pool.
 *
 * Bags is a launchpad built on Meteora's Dynamic Bonding Curve: a token trades
 * against a virtual pool from the moment it launches and graduates into a real
 * DAMM pool at a threshold. Using it instead of `mempire_amm` means not
 * deploying a second program and not seeding liquidity, and it pays rather than
 * costs — the token's creator earns a share of every trade, forever.
 *
 * Everything here goes through the relay. Bags authenticates with an API key,
 * and a key in a browser bundle is a key anyone can spend; the relay holds it
 * and this module only ever talks to our own origin.
 *
 * The important property, and the one worth protecting: **when there is no
 * market, this says so.** `describe()` returning `configured: false` is the
 * normal state before $MEMPIRE is launched, and the swap screen renders that
 * as a refusal. A quote invented in that state would be the single most
 * damaging thing this file could do.
 */

export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

export interface MarketInfo {
  configured: boolean;
  venue: string;
  /** The $MEMPIRE mint on this venue, or null before it is launched. */
  mint: string | null;
  quoteMint: string;
  note: string;
}

export interface MarketQuote {
  inAmount: bigint;
  outAmount: bigint;
  /** Worst case after slippage — this is the number a UI should promise. */
  minOutAmount: bigint;
  priceImpactPct: number;
  slippageBps: number;
  /** Ties a swap transaction to the exact quote that was shown. */
  requestId: string;
}

let cached: MarketInfo | null = null;

/** Whether a market exists, and against which mint. Cached per session. */
export async function describe(): Promise<MarketInfo> {
  if (cached) return cached;
  const absent: MarketInfo = {
    configured: false, venue: 'bags', mint: null,
    quoteMint: WSOL_MINT.toBase58(),
    note: 'No market is configured for this build.',
  };
  if (!hasApi()) return absent;
  try {
    const res = await apiFetch('/api/market');
    if (!res?.ok) return absent;
    cached = (await res.json()) as MarketInfo;
    return cached;
  } catch {
    return absent;
  }
}

/**
 * A quote for swapping `amount` of `inputMint` into `outputMint`.
 *
 * `amount` is in the input token's smallest unit, exactly as the venue expects
 * — converting units in more than one place is how a screen ends up quoting
 * one number and filling another. Returns null when there is no market or the
 * venue cannot fill this size, which callers must render as "no quote" rather
 * than as zero.
 */
export async function quote(
  inputMint: string, outputMint: string, amount: bigint, slippageBps?: number,
): Promise<MarketQuote | null> {
  const market = await describe();
  if (!market.configured) return null;
  const qs = new URLSearchParams({ inputMint, outputMint, amount: amount.toString() });
  if (slippageBps !== undefined) qs.set('slippageBps', String(slippageBps));
  try {
    const res = await apiFetch(`/api/market/quote?${qs}`);
    if (!res?.ok) return null;
    const q = await res.json();
    return {
      inAmount: BigInt(q.inAmount ?? '0'),
      outAmount: BigInt(q.outAmount ?? '0'),
      minOutAmount: BigInt(q.minOutAmount ?? q.outAmount ?? '0'),
      priceImpactPct: Number(q.priceImpactPct ?? 0),
      slippageBps: Number(q.slippageBps ?? 0),
      requestId: String(q.requestId ?? ''),
    };
  } catch {
    return null;
  }
}

/**
 * Execute a quote. The relay builds the transaction; the wallet signs it.
 *
 * The relay never holds a player's key, so it can only ever hand back an
 * unsigned transaction. `requestId` is what binds this to the quote already on
 * screen — swapping against a freshly-fetched quote instead would let the
 * price move between what was shown and what was signed.
 */
export async function swap(adapter: Adapter | null, requestId: string): Promise<string> {
  const provider = getProvider(adapter);
  const userPublicKey = provider.wallet.publicKey?.toBase58();
  if (!userPublicKey) throw new Error('connect a wallet to swap');

  const res = await apiPost('/api/market/swap', 'market.swap', { requestId, userPublicKey });
  if (!res?.ok) {
    const body = await res?.json().catch(() => null);
    throw new Error(body?.error ?? 'the venue could not build that swap');
  }
  const { transaction } = await res.json();
  if (!transaction) throw new Error('the venue returned no transaction');

  const tx = VersionedTransaction.deserialize(
    Uint8Array.from(atob(transaction), (c) => c.charCodeAt(0)),
  );
  const signed = await provider.wallet.signTransaction(tx);
  const conn: Connection = getConnection();
  const sig = await conn.sendRawTransaction(signed.serialize(), {
    preflightCommitment: 'confirmed',
  });
  await conn.confirmTransaction(sig, 'confirmed');
  return sig;
}
