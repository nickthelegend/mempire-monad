import type { Hash, Hex } from 'viem';
import { CHAIN_ID, publicClient } from './provider';

/*
 * How long a transaction took to land, told honestly.
 *
 * Two numbers, because Monad has two answers:
 *  - **executed** — the receipt is back: the block is Proposed and speculatively
 *    executed (~1 slot, 300 ms);
 *  - **final** — the block is Finalized (2 slots, ~600 ms) and can no longer
 *    change. A Proposed receipt's block hash *can* change, so final is checked
 *    against the finalized block at that height, not assumed.
 *
 * Only Monad itself has the second number. On the local anvil fork every block
 * is final the instant it is mined, so the UI says "local fork · instant mining"
 * there instead of printing a finality time it did not measure.
 */

export const IS_MONAD_NETWORK = CHAIN_ID === 10143 || CHAIN_ID === 143;

/**
 * Milliseconds from `t0` until the block holding this receipt is Finalized, or
 * null when this is not Monad (fork) or it did not finalize in time. If a
 * different block finalized at that height, the transaction moved: also null,
 * and the caller re-reads the receipt.
 */
export async function waitFinal(blockNumber: bigint, blockHash: Hex, t0: number, timeoutMs = 15_000): Promise<number | null> {
  if (!IS_MONAD_NETWORK) return null;
  const client = publicClient();
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const fin = await client.getBlock({ blockTag: 'finalized' }).catch(() => null);
    if (fin && fin.number !== null && fin.number >= blockNumber) {
      const at = fin.number === blockNumber ? fin : await client.getBlock({ blockNumber }).catch(() => null);
      return at?.hash === blockHash ? Math.round(performance.now() - t0) : null;
    }
    await new Promise((r) => { setTimeout(r, 120); });
  }
  return null;
}

/**
 * Monad's `txpool_statusByHash`: whether the node has the transaction before it
 * is in a block (`eth_getTransactionByHash` does not return pending ones on
 * Monad). Monad networks only; null anywhere else or on any error.
 */
export async function txpoolStatus(hash: Hash): Promise<string | null> {
  if (!IS_MONAD_NETWORK) return null;
  try {
    const r = await publicClient().request({ method: 'txpool_statusByHash' as 'eth_chainId', params: [hash] as never });
    const status = (r as unknown as { status?: string } | null)?.status;
    return typeof status === 'string' ? status : null;
  } catch {
    return null;
  }
}
