import { getProvider } from './provider';
import { AnchorProvider, BN, Program, type Idl } from '@coral-xyz/anchor';
import type { Adapter } from '@solana/wallet-adapter-base';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

/**
 * The match session key.
 *
 * A three-minute match writes a card play per drop and a checkpoint every forty
 * ticks. Signed by the connected wallet, that is dozens of Phantom popups —
 * which does not make the game annoying so much as unplayable. The seat
 * authorises a temporary keypair once, at match start, and the rollup accepts
 * it for the rest of the match.
 *
 * # Why handing this key out is safe
 *
 * The rollup program has **no transfer path**. It owns no lamports beyond its
 * own rent and cannot move a token. A stolen session key can write nonsense
 * plays into one match log — and the lockstep hash check already voids a match
 * whose log disagrees with the simulation, refunding both stakes. Escrow and
 * payout live in the base-layer program and stay wallet-only, deliberately.
 *
 * The scope is one seat, one match, thirty minutes at most, revocable.
 *
 * # Where the key lives
 *
 * In memory, for the lifetime of the tab. Never in localStorage, never sent
 * anywhere, never logged. It is worthless after the match and there is no
 * reason for it to outlive one.
 */

/** Session lifetime. The program caps this at 1800s and enforces it on-chain. */
export const SESSION_TTL_SECS = 900;

interface Live {
  matchId: number;
  keypair: Keypair;
  expiresAt: number;
}

let live: Live | null = null;

/** The active session key, if this match has one that has not expired. */
export function sessionFor(matchId: number): Keypair | null {
  if (!live || live.matchId !== matchId) return null;
  // Stop using it slightly before the chain would refuse it: a transaction
  // built at T-1s can easily land at T+1s, and a rejected play mid-match is
  // worse than one extra wallet prompt.
  if (Date.now() / 1000 > live.expiresAt - 20) return null;
  return live.keypair;
}

export function hasSession(matchId: number): boolean {
  return sessionFor(matchId) !== null;
}

/**
 * An Anchor provider that signs with the session key rather than the wallet.
 *
 * The session keypair pays its own fees on the rollup, where fees are zero — so
 * it never needs funding, which is the other reason a session key on an ER is
 * cheap to hand out.
 */
export function sessionProvider(conn: Connection, kp: Keypair): AnchorProvider {
  const wallet = {
    publicKey: kp.publicKey,
    signTransaction: async (tx: never) => {
      (tx as { sign: (...k: Keypair[]) => void }).sign(kp);
      return tx;
    },
    signAllTransactions: async (txs: never[]) => {
      for (const tx of txs) (tx as { sign: (...k: Keypair[]) => void }).sign(kp);
      return txs;
    },
    payer: kp,
  };
  return new AnchorProvider(conn, wallet as never, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
}

/**
 * Asks the wallet to authorise a fresh session for this match. One popup.
 *
 * Returns false rather than throwing when it cannot: a match whose session
 * failed to open still plays perfectly well, it just prompts per write. Losing
 * the match over a UX optimisation would be the wrong trade.
 */
export async function openSession(
  adapter: Adapter | null,
  matchId: number,
  program: Program<Idl>,
  log: PublicKey,
): Promise<boolean> {
  // A guest has no adapter and still signs, through the provider. Taking the
  // key from whichever of the two is present keeps this working for both —
  // `adapter?.publicKey` alone silently returned false for every guest, so
  // guests played every match with a wallet prompt per card.
  const player = adapter?.publicKey
    ?? (program.provider as { wallet?: { publicKey?: PublicKey } }).wallet?.publicKey;
  if (!player) return false;
  const kp = Keypair.generate();
  try {
    await program.methods
      .openSession(kp.publicKey, new BN(SESSION_TTL_SECS))
      .accounts({ log, player } as never)
      .rpc();
    live = {
      matchId,
      keypair: kp,
      expiresAt: Date.now() / 1000 + SESSION_TTL_SECS,
    };
    return true;
  } catch {
    live = null;
    return false;
  }
}

/**
 * Revokes the session on-chain and forgets the key.
 *
 * Expiry is the backstop, not the mechanism. A player who finishes a match
 * should not leave a usable key behind for fifteen minutes, and the local
 * `live = null` happens even if the on-chain revoke fails — a key we have
 * forgotten cannot be used by this client whatever the chain thinks.
 */
export async function closeSession(
  adapter: Adapter | null,
  program: Program<Idl>,
  log: PublicKey,
): Promise<void> {
  const had = live;
  live = null;
  if (!had) return;
  // A guest signs without an adapter, so `adapter?.publicKey` alone skipped
  // this for them and left the session key alive on chain until it expired.
  const player = adapter?.publicKey ?? getProvider(adapter).wallet.publicKey;
  if (!player) return;
  try {
    await program.methods
      .closeSession()
      .accounts({ log, player } as never)
      .rpc();
  } catch { /* it expires on its own; the local key is already gone */ }
}

/** Drops the key without touching the chain. For teardown paths. */
export function forgetSession(): void {
  live = null;
}
