import { generatePrivateKey, nonceManager, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { localSigner, type Signer } from './account';

/*
 * Per-match session keys.
 *
 * A match writes every card drop to the chain as it happens. Asking the
 * player's wallet to approve each one would end the game at the first card, so
 * a match gets its own throwaway key: generated in the browser, named as the
 * seat's session in the create/join transaction, and funded in that same
 * transaction with a few cents of MON for gas. The arena accepts it for that
 * seat of that match and nothing else — it can log plays, post checkpoints and
 * record the result, and it can never move a stake or a card.
 *
 * It is kept in sessionStorage for the life of the tab, so a reload mid-match
 * can still record the result rather than stranding the seat's claim.
 */

/*
 * MON forwarded to the session key for its gas.
 *
 * A logged card play is ~38k gas at Monad testnet's 100 gwei floor — about
 * 0.004 MON — and a player drops ~20 cards a match, plus checkpoints and the
 * claim. 0.1 MON covers that with room; whatever is left is swept back to the
 * player when the match ends, so the allowance is a float, not a fee.
 */
export const SESSION_GAS_WEI = 100_000_000_000_000_000n; // 0.1 MON
/** Kept back from logging so the seat can always afford to record its result. */
export const CLAIM_RESERVE_WEI = 15_000_000_000_000_000n; // 0.015 MON

const KEY = (matchId: number) => `mempire_session_${matchId}`;
const PENDING = 'mempire_session_pending';

interface Live {
  matchId: number;
  signer: Signer;
}

let live: Live | null = null;

/** A fresh key for the match about to be created or joined. Its id is not known yet. */
export function prepareSession(): Address {
  const k = generatePrivateKey();
  try { sessionStorage.setItem(PENDING, k); } catch { /* memory only */ }
  pending = k;
  return privateKeyToAccount(k).address;
}

let pending: Hex | null = null;

/** Bind the prepared key to the match id the chain assigned. */
export function bindSession(matchId: number): Signer | null {
  const k = pending ?? (() => {
    try { return sessionStorage.getItem(PENDING) as Hex | null; } catch { return null; }
  })();
  if (!k) return null;
  pending = null;
  try {
    sessionStorage.setItem(KEY(matchId), k);
    sessionStorage.removeItem(PENDING);
  } catch { /* memory only */ }
  live = { matchId, signer: localSigner('guest', privateKeyToAccount(k, { nonceManager }), 'Session') };
  return live.signer;
}

/** The session signer for a match, recovered from this tab's storage if needed. */
export function sessionFor(matchId: number): Signer | null {
  if (live?.matchId === matchId) return live.signer;
  try {
    const k = sessionStorage.getItem(KEY(matchId)) as Hex | null;
    if (!k) return null;
    live = { matchId, signer: localSigner('guest', privateKeyToAccount(k, { nonceManager }), 'Session') };
    return live.signer;
  } catch {
    return null;
  }
}

export const hasSession = (matchId: number): boolean => sessionFor(matchId) !== null;

/**
 * Return a finished match's unspent gas float to the player, then forget the key.
 * Best effort: a sweep that fails leaves dust on a key nobody will use again.
 */
export async function sweepSession(matchId: number, to: Address): Promise<void> {
  const s = sessionFor(matchId);
  if (!s) return;
  try {
    const { publicClient } = await import('./provider');
    const client = publicClient();
    const [balance, gasPrice] = await Promise.all([
      client.getBalance({ address: s.address }),
      client.getGasPrice(),
    ]);
    const fee = gasPrice * 21_000n;
    if (balance > fee * 2n) {
      await s.wallet.sendTransaction({
        account: s.account, chain: s.wallet.chain, to, value: balance - fee, gas: 21_000n, gasPrice,
      });
    }
  } catch { /* dust */ }
  forgetSession(matchId);
}

/** Forget a finished match's key. What MON it has left is dust by design. */
export function forgetSession(matchId?: number): void {
  if (matchId !== undefined) {
    try { sessionStorage.removeItem(KEY(matchId)); } catch { /* nothing */ }
  }
  live = null;
}
