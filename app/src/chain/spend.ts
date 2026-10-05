import { AnchorProvider } from '@coral-xyz/anchor';
import type { Adapter } from '@solana/wallet-adapter-base';
import { PublicKey, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { MEMPIRE_MINT, UNIT, tokenBalance } from './amm';
import { canSign, getConnection, getProvider } from './provider';
import { fetchConfig } from './read';

/**
 * Spending $MEMPIRE on things the game sells.
 *
 * # Why the token and not Crowns
 *
 * Crowns are a soft currency with no market — they exist so the game has a
 * unit it can grant freely without touching anything tradable. That is the
 * right shape for rewards, and the wrong shape for a sink. A sink is what
 * gives a token a reason to be held: chests and clan charters cost $MEMPIRE,
 * the tokens go to the treasury, and demand for them is demand a pool can
 * actually price.
 *
 * # What this deliberately is not
 *
 * Not a burn, and not a program instruction. A plain SPL transfer to the
 * treasury is legible — anyone can read the treasury's token account and see
 * exactly what the game has taken in. Routing it through a custom program
 * would add a place for a bug to live and prove nothing extra.
 */

/** What the game sells, and for how much. Whole $MEMPIRE. */
export const PRICES = {
  /** Skip a chest's timer outright. */
  chestSkip: 25,
  /** Open a chest slot immediately without waiting for a win. */
  chestBuy: 100,
  /** Found a clan. Priced to be a real commitment, not an impulse. */
  clanCharter: 250,
} as const;

/**
 * A card bought with $MEMPIRE instead of SOL.
 *
 * Mirrors `MINT_FEE_MEMPIRE` in the program, which is what actually gets
 * charged — this constant exists so the shop can *display* the number it will
 * be billed. The shop used to render a per-offer discounted price and charge
 * something else entirely; a screen that quotes one figure and takes another is
 * the bug this pair is here to prevent, so if the program's constant changes,
 * change this one in the same commit.
 */
export const MINT_PRICE_MEMPIRE = 250;

export type SpendKind = keyof typeof PRICES;

/**
 * What a spend costs, in whole $MEMPIRE.
 *
 * Takes a named kind or a bare number, because the shop's prices are per-offer
 * and there is no sensible way to name them ahead of time. Crowns used to
 * cover that case — they were the currency with arbitrary, game-set prices —
 * and with one currency left the price simply travels with the call.
 */
export type SpendPrice = SpendKind | number;

export const priceOf = (p: SpendPrice): number => (typeof p === 'number' ? p : PRICES[p]);

export interface SpendCheck {
  /** Whole tokens the wallet holds. */
  balance: number;
  /** Whole tokens the purchase costs. */
  price: number;
  affordable: boolean;
  /** How many more tokens are needed. Zero when affordable. */
  shortfall: number;
  /** Why it cannot proceed, if it cannot. Empty when it can. */
  blocker: string;
}

/**
 * Can this wallet afford `kind` right now.
 *
 * Returns the numbers rather than a boolean so the UI can say "you need 60
 * more $MEMPIRE" instead of greying a button out with no explanation — a
 * disabled control with no stated reason is the most common way an app makes
 * a player think it is broken.
 */
export async function checkSpend(
  adapter: Adapter | null,
  kind: SpendPrice,
  address: string | null,
): Promise<SpendCheck> {
  const price = priceOf(kind);
  const base: SpendCheck = {
    balance: 0, price, affordable: false, shortfall: price, blocker: '',
  };

  if (!canSign(adapter)) {
    return { ...base, blocker: 'This session cannot sign a transaction.' };
  }
  if (!address) return { ...base, blocker: 'No wallet connected.' };

  try {
    const raw = await tokenBalance(new PublicKey(address), MEMPIRE_MINT);
    const balance = Number(raw / UNIT);
    const shortfall = Math.max(0, price - balance);
    return {
      balance,
      price,
      affordable: shortfall === 0,
      shortfall,
      blocker: shortfall === 0
        ? ''
        : `You hold ${balance.toLocaleString()} $MEMPIRE and this costs `
          + `${price.toLocaleString()} — ${shortfall.toLocaleString()} short.`,
    };
  } catch {
    return { ...base, blocker: 'Could not read your $MEMPIRE balance.' };
  }
}

/**
 * Move `kind`'s price in $MEMPIRE from the player to the treasury.
 *
 * Re-reads the balance immediately before signing rather than trusting a
 * check the UI ran a moment ago: a player can swap or spend between opening a
 * confirmation dialog and pressing the button, and the failure that produces
 * is a raw SPL error rather than a sentence anyone can act on.
 */
export async function spendMempire(
  adapter: Adapter | null,
  kind: SpendPrice,
  address: string,
): Promise<string> {
  const check = await checkSpend(adapter, kind, address);
  if (!check.affordable) throw new Error(check.blocker || 'Not enough $MEMPIRE.');

  const cfg = await fetchConfig();
  if (!cfg) throw new Error('Program config not found on this cluster');

  const provider = getProvider(adapter) as AnchorProvider;
  const owner = adapter?.publicKey ?? provider.wallet.publicKey;
  if (!owner) throw new Error('This session cannot sign a transaction.');

  const treasury = new PublicKey(cfg.treasury);
  const from = getAssociatedTokenAddressSync(MEMPIRE_MINT, owner);
  const to = getAssociatedTokenAddressSync(MEMPIRE_MINT, treasury, true);

  const tx = new Transaction();
  // The treasury may never have held this mint. Idempotent, so paying for the
  // account once costs the first buyer a little rent and nobody after them.
  tx.add(createAssociatedTokenAccountIdempotentInstruction(owner, to, treasury, MEMPIRE_MINT));
  tx.add(createTransferInstruction(
    from, to, owner, BigInt(priceOf(kind)) * UNIT,
  ));

  const conn = getConnection();
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = owner;

  const signature = await provider.sendAndConfirm!(tx, []);
  await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  return signature;
}
