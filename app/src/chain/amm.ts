import { AnchorProvider, BN, Program, type Idl } from '@coral-xyz/anchor';
import type { Adapter } from '@solana/wallet-adapter-base';
import { PublicKey, Transaction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import ammIdl from './mempire_amm.idl.json';
import cfg from '../lib/amm.json';
import { IS_MAINNET, canSign, getConnection, getProvider } from './provider';

/**
 * The $MEMPIRE / USDC pool.
 *
 * Quoted in Circle's real USDC, not a stand-in — `amm.json` carries the mint
 * the pool was actually opened against, and it is the same file the setup
 * script wrote, so the UI and the chain cannot drift apart about what is being
 * traded.
 *
 * Every number the swap screen shows comes from the pool account read live.
 * Nothing here estimates: a quote the pool would not honour is worse than no
 * quote, because the trader finds out by losing money.
 */

/*
 * A mainnet build quoting a devnet pool would show real-looking prices for a
 * market that does not exist on the cluster the user is on. `amm.json` is
 * written by the pool-setup script and stamps which cluster it opened the pool
 * on; the swap screen refuses to quote when the stamp and the build disagree,
 * which is exactly the state between "mainnet build cut" and "mainnet pool
 * opened" if the runbook is run out of order.
 */
export const AMM_CONFIG_MATCHES_CLUSTER = IS_MAINNET
  ? String(cfg.cluster).startsWith('mainnet')
  : !String(cfg.cluster).startsWith('mainnet');

export const AMM_PROGRAM_ID = new PublicKey(cfg.ammProgramId);

/*
 * $MEMPIRE's mint, and the one value in this file that is *not* only about the
 * AMM.
 *
 * `amm.json` is written by the pool-setup script, and the swap screen guards
 * against a stale one with `AMM_CONFIG_MATCHES_CLUSTER`. But `MEMPIRE_MINT` is
 * imported far outside that screen — the merge fee, every $MEMPIRE sink, the
 * balance readout, and the address of the win-reward vault — and none of those
 * consult the guard.
 *
 * That was survivable while our own AMM was the plan, because deploying the
 * pool rewrote this file. Launching on Bags instead means the pool-setup script
 * never runs on mainnet, so the stamp would stay `devnet` permanently and every
 * $MEMPIRE path would quietly address the *devnet* mint: balances read zero,
 * merges fail the program's own mint constraint, sinks move a token nobody
 * holds, and the reward vault resolves to an account that does not exist, so
 * the reward never pays.
 *
 * So the mint gets its own env var, and a mainnet build that has not been told
 * one refuses to start — the same fail-closed rule `provider.ts` applies to the
 * cluster and the RPC, for the same reason: a silent mismatch here is
 * discovered by players, in transactions, after the money is spent.
 */
const MINT_FROM_ENV = String(import.meta.env.VITE_MEMPIRE_MINT ?? '').trim();
const CONFIG_IS_MAINNET = String(cfg.cluster).startsWith('mainnet');

if (IS_MAINNET && !MINT_FROM_ENV && !CONFIG_IS_MAINNET) {
  throw new Error(
    'This is a mainnet build but $MEMPIRE\'s mint comes from a devnet-stamped '
    + 'amm.json and VITE_MEMPIRE_MINT is unset — refusing to boot rather than '
    + 'address the wrong token. Set VITE_MEMPIRE_MINT to the mainnet mint.',
  );
}

export const MEMPIRE_MINT = new PublicKey(MINT_FROM_ENV || cfg.mempireMint);
export const USDC_MINT = new PublicKey(cfg.usdcMint);
export const POOL = new PublicKey(cfg.pool);
export const FEE_BPS = BigInt(cfg.feeBps);

/**
 * One whole $MEMPIRE in base units.
 *
 * Six decimals is not a free choice — every amount constant in the *program* is
 * written against it (`WIN_REWARD`, `UPGRADE_BASE_FEE`, the shop prices), and
 * those are compiled in. If the launch mint is created with different decimals
 * the client and the program disagree by a factor of ten per decimal, so this
 * reads the configured value and refuses anything else rather than silently
 * mispricing every sink. `bake-mainnet-mint.mjs` warns about the same thing
 * from the other side.
 */
const MEMPIRE_DECIMALS = Number(
  import.meta.env.VITE_MEMPIRE_DECIMALS ?? cfg.mempireDecimals ?? 6,
);
if (MEMPIRE_DECIMALS !== 6) {
  throw new Error(
    `$MEMPIRE is configured with ${MEMPIRE_DECIMALS} decimals, but the program's `
    + 'amount constants assume 6. Rebuild the program for the real decimals '
    + 'before shipping this, or the fees and rewards are off by orders of magnitude.',
  );
}
export const UNIT = 10n ** BigInt(MEMPIRE_DECIMALS);

export interface PoolState {
  reserveBase: bigint;
  reserveQuote: bigint;
  lpSupply: bigint;
  swaps: number;
  /** USDC per $MEMPIRE, as a float — display only, never used to size a trade. */
  price: number;
}

function program(adapter: Adapter | null = null): Program<Idl> {
  return new Program(ammIdl as Idl, getProvider(adapter) as AnchorProvider);
}

/** Reads the pool. Returns null when it is unreachable rather than guessing. */
export async function readPool(): Promise<PoolState | null> {
  try {
    const acc = await (program().account as never as {
      pool: { fetch(a: PublicKey): Promise<Record<string, { toString(): string }>> };
    }).pool.fetch(POOL);
    const reserveBase = BigInt(acc.reserveBase.toString());
    const reserveQuote = BigInt(acc.reserveQuote.toString());
    return {
      reserveBase,
      reserveQuote,
      lpSupply: BigInt(acc.lpSupply.toString()),
      swaps: Number(acc.swaps.toString()),
      price: reserveBase === 0n ? 0 : Number(reserveQuote) / Number(reserveBase),
    };
  } catch {
    return null;
  }
}

export interface Quote {
  amountOut: bigint;
  /** What the trade would cost with no price impact at all. */
  idealOut: bigint;
  /** Fraction of value lost to moving the price, 0–1. */
  priceImpact: number;
  /** The fee, in input units. */
  fee: bigint;
  minReceived: bigint;
}

/**
 * The output of a swap, computed exactly as the program computes it.
 *
 * A deliberate re-implementation rather than a simulation call: it is integer
 * arithmetic on `bigint` with the same flooring and the same fee-first
 * ordering, so the number on the button is the number the chain will produce.
 * The e2e asserts the two agree to the unit.
 */
export function quote(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  slippageBps: bigint,
): Quote | null {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return null;
  const afterFee = amountIn * (10_000n - FEE_BPS);
  const amountOut = (afterFee * reserveOut) / (reserveIn * 10_000n + afterFee);
  if (amountOut <= 0n) return null;

  // Price impact measured against the *pre-trade* spot price, which is the
  // number a trader is comparing to. Fee excluded so the two costs are shown
  // separately rather than blurred into one figure.
  const ideal = (amountIn * reserveOut) / reserveIn;
  const impact = ideal === 0n ? 0 : Number(ideal - amountOut) / Number(ideal);

  return {
    amountOut,
    idealOut: ideal,
    priceImpact: Math.max(0, impact - Number(FEE_BPS) / 10_000),
    fee: (amountIn * FEE_BPS) / 10_000n,
    minReceived: (amountOut * (10_000n - slippageBps)) / 10_000n,
  };
}

export class NoSignerError extends Error {
  constructor() { super('Connect a wallet that can sign to swap.'); }
}

/** A wallet's balance of one of the pair, in base units. */
export async function tokenBalance(owner: PublicKey, mint: PublicKey): Promise<bigint> {
  try {
    const acc = await getAccount(getConnection(), getAssociatedTokenAddressSync(mint, owner));
    return acc.amount;
  } catch {
    return 0n; // no account is the same as no balance, for display
  }
}

/**
 * Swaps one side of the pair for the other.
 *
 * `minAmountOut` is required, not optional. A swap sent without one accepts any
 * price, and on a public mempool that is an invitation — so the caller computes
 * it from a quote and a slippage tolerance, and the program enforces it.
 *
 * The destination account is created in the same transaction when missing, so a
 * first-time buyer does not have to know what an associated token account is.
 */
export async function swap(
  adapter: Adapter | null,
  amountIn: bigint,
  minAmountOut: bigint,
  quoteToBase: boolean,
): Promise<string> {
  // A guest signs through the provider with no adapter of its own, so the
  // adapter's key cannot be the gate — `canSign` already accounts for both.
  if (!canSign(adapter)) throw new NoSignerError();
  const prog = program(adapter);
  // Same source as the signature itself, so the two can never disagree — a
  // guest's key comes from the provider, a wallet's from the adapter.
  const owner = adapter?.publicKey ?? (prog.provider as AnchorProvider).wallet.publicKey;
  if (!owner) throw new NoSignerError();

  const userBase = getAssociatedTokenAddressSync(MEMPIRE_MINT, owner);
  const userQuote = getAssociatedTokenAddressSync(USDC_MINT, owner);
  const conn = getConnection();

  const pre: Transaction[] = [];
  for (const [ata, mint] of [[userBase, MEMPIRE_MINT], [userQuote, USDC_MINT]] as const) {
    if (!(await conn.getAccountInfo(ata))) {
      pre.push(new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, mint),
      ));
    }
  }

  const ix = await prog.methods
    .swap(new BN(amountIn.toString()), new BN(minAmountOut.toString()), quoteToBase)
    .accounts({
      pool: POOL,
      baseVault: new PublicKey(cfg.baseVault),
      quoteVault: new PublicKey(cfg.quoteVault),
      userBase,
      userQuote,
      user: owner,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as never)
    .instruction();

  const tx = new Transaction();
  for (const p of pre) tx.add(...p.instructions);
  tx.add(ix);
  return (prog.provider as AnchorProvider).sendAndConfirm!(tx, []);
}

export { ASSOCIATED_TOKEN_PROGRAM_ID };
