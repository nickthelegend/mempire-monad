import { erc20Abi, formatEther, type Abi, type Address } from 'viem';
import seasonAbiJson from '../shared/abi/SeasonPass.json';
import { send } from './account';
import { DEPLOYMENT, publicClient } from './provider';

/*
 * The $MEMPIRE season pass, read and used from the client.
 *
 * Everything here is the contract's own state: the season window and price,
 * the tiers (staked wins needed for each golden chest), whether this account
 * holds a pass, its progress (`MempireArena.wins` since buying) and which
 * tiers it has claimed. Buying approves the exact price, then calls buyPass.
 */

const SEASON_ABI = seasonAbiJson as Abi;

export interface SeasonView {
  id: number;
  startsAt: number;
  endsAt: number;
  price: bigint;
  priceLabel: string;
  tiers: number[];
  hasPass: boolean;
  progress: number;
  claimed: boolean[];
}

export async function readSeason(owner: Address | null): Promise<SeasonView | null> {
  const addr = DEPLOYMENT?.seasonPass;
  if (!addr) return null;
  const c = publicClient();
  const id = Number(await c.readContract({ address: addr, abi: SEASON_ABI, functionName: 'seasonCount' }));
  if (id === 0) return null;
  const [s, tiers] = await Promise.all([
    c.readContract({ address: addr, abi: SEASON_ABI, functionName: 'seasons', args: [BigInt(id)] }) as Promise<readonly [bigint, bigint, bigint]>,
    c.readContract({ address: addr, abi: SEASON_ABI, functionName: 'tierWins', args: [BigInt(id)] }) as Promise<readonly number[]>,
  ]);
  let hasPass = false; let progress = 0; let mask = 0n;
  if (owner) {
    const [base, prog, m] = await Promise.all([
      c.readContract({ address: addr, abi: SEASON_ABI, functionName: 'passBase', args: [BigInt(id), owner] }) as Promise<number>,
      c.readContract({ address: addr, abi: SEASON_ABI, functionName: 'progress', args: [BigInt(id), owner] }) as Promise<number>,
      c.readContract({ address: addr, abi: SEASON_ABI, functionName: 'claimedMask', args: [BigInt(id), owner] }) as Promise<bigint>,
    ]);
    hasPass = Number(base) > 0; progress = Number(prog); mask = BigInt(m);
  }
  return {
    id, startsAt: Number(s[0]), endsAt: Number(s[1]), price: s[2], priceLabel: Number(formatEther(s[2])).toLocaleString('en-US'),
    tiers: tiers.map(Number), hasPass, progress,
    claimed: tiers.map((_, i) => (mask & (1n << BigInt(i))) !== 0n),
  };
}

export async function buyPass(owner: Address, season: SeasonView): Promise<void> {
  const addr = DEPLOYMENT!.seasonPass!;
  const allowance = await publicClient().readContract({ address: DEPLOYMENT!.token, abi: erc20Abi, functionName: 'allowance', args: [owner, addr] });
  if (allowance < season.price) {
    await send({ address: DEPLOYMENT!.token, abi: erc20Abi as Abi, functionName: 'approve', args: [addr, season.price] });
  }
  await send({ address: addr, abi: SEASON_ABI, functionName: 'buyPass', args: [BigInt(season.id)] });
}

export async function claimTier(season: SeasonView, tier: number): Promise<void> {
  await send({ address: DEPLOYMENT!.seasonPass!, abi: SEASON_ABI, functionName: 'claim', args: [BigInt(season.id), tier] });
}
