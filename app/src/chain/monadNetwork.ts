import { createPublicClient, defineChain, encodeAbiParameters, http, type Hex } from 'viem';

/*
 * Read-only access to Monad testnet itself, whatever chain the game runs on.
 *
 * Two Monad-native things are read live here:
 *  - **native staking** — the staking precompile at 0x…1000 (current epoch,
 *    whether the epoch delay period is on, the proposer's validator record),
 *    batched into one `eth_call` through the canonical **Multicall3**. The
 *    staking precompile only answers CALL, never STATICCALL, and Multicall3's
 *    `aggregate3` uses CALL, so the batch works;
 *  - **P256VERIFY at 0x…0100** — a passkey (WebAuthn) signature verified by
 *    Monad's precompile with a plain `eth_call`. No transaction, no MON.
 *
 * Testnet was reset from genesis on 2025-12-16, so viem's built-in
 * `monadTestnet` (blockTime 400, an old explorer, a stale multicall
 * `blockCreated`) is not used; the chain is defined here.
 */

export const MONAD_TESTNET_RPC = (import.meta.env?.VITE_MONAD_RPC as string | undefined) ?? 'https://testnet-rpc.monad.xyz';
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;
export const STAKING = '0x0000000000000000000000000000000000001000' as const;
export const P256_VERIFY = '0x0000000000000000000000000000000000000100' as const;

const monadTestnetLive = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [MONAD_TESTNET_RPC] } },
  blockExplorers: { default: { name: 'MonadVision', url: 'https://testnet.monadvision.com' } },
  contracts: { multicall3: { address: MULTICALL3 } },
});

let client: ReturnType<typeof makeClient> | null = null;
function makeClient() {
  return createPublicClient({ chain: monadTestnetLive, transport: http(MONAD_TESTNET_RPC, { retryCount: 2, retryDelay: 400 }) });
}
export const monadTestnet = () => (client ??= makeClient());

/*
 * From the official @monad-crypto/viem 0.0.3 staking ABI (monad-crypto/monad-ts):
 * the three reads used here. Declared nonpayable there because the precompile
 * rejects STATICCALL; an eth_call through Multicall3 is fine.
 */
export const stakingAbi = [
  { type: 'function', name: 'getEpoch', inputs: [], outputs: [{ name: 'epoch', type: 'uint64' }, { name: 'inEpochDelayPeriod', type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'getProposerValId', inputs: [], outputs: [{ name: 'val_id', type: 'uint64' }], stateMutability: 'nonpayable' },
  {
    type: 'function', name: 'getValidator', inputs: [{ name: 'validatorId', type: 'uint64' }], stateMutability: 'nonpayable',
    outputs: [
      { name: 'authAddress', type: 'address' }, { name: 'flags', type: 'uint64' }, { name: 'stake', type: 'uint256' },
      { name: 'accRewardPerToken', type: 'uint256' }, { name: 'commission', type: 'uint256' }, { name: 'unclaimedRewards', type: 'uint256' },
      { name: 'consensusStake', type: 'uint256' }, { name: 'consensusCommission', type: 'uint256' },
      { name: 'snapshotStake', type: 'uint256' }, { name: 'snapshotCommission', type: 'uint256' },
      { name: 'secpPubkey', type: 'bytes' }, { name: 'blsPubkey', type: 'bytes' },
    ],
  },
] as const;

export interface StakingSnapshot {
  epoch: number;
  inDelay: boolean;
  proposer: number;
  /** In MON (18 decimals). */
  proposerStake: number | null;
  /** Commission as a fraction (the precompile stores 1e18 = 100%). */
  proposerCommission: number | null;
  block: number;
}

/** Epoch + proposer in one Multicall3 batch, then the proposer's record. */
export async function readStaking(): Promise<StakingSnapshot> {
  const c = monadTestnet();
  const [epochRes, proposerRes] = await c.multicall({
    contracts: [
      { address: STAKING, abi: stakingAbi, functionName: 'getEpoch' },
      { address: STAKING, abi: stakingAbi, functionName: 'getProposerValId' },
    ],
    multicallAddress: MULTICALL3,
    allowFailure: true,
  });
  if (epochRes.status !== 'success' || proposerRes.status !== 'success') throw new Error('the staking precompile did not answer');
  const [epoch, inDelay] = epochRes.result as readonly [bigint, boolean];
  const proposer = Number(proposerRes.result as bigint);
  const block = Number(await c.getBlockNumber());
  let proposerStake: number | null = null;
  let proposerCommission: number | null = null;
  try {
    const v = await c.readContract({ address: STAKING, abi: stakingAbi, functionName: 'getValidator', args: [BigInt(proposer)] }) as readonly unknown[];
    proposerStake = Number((v[2] as bigint) / 10n ** 15n) / 1000;
    proposerCommission = Number((v[4] as bigint) / 10n ** 12n) / 1e6;
  } catch { /* the epoch and proposer still stand */ }
  return { epoch: Number(epoch), inDelay, proposer, proposerStake, proposerCommission, block };
}

/** P256VERIFY on Monad testnet: true when the precompile returns 1. */
export async function p256VerifyOnMonad(hash: Hex, r: Hex, s: Hex, x: Hex, y: Hex): Promise<boolean> {
  const data = encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [hash, r, s, x, y],
  );
  const res = await monadTestnet().call({ to: P256_VERIFY, data });
  return BigInt(res.data ?? '0x0') === 1n;
}
