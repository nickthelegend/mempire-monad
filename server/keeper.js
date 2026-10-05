/**
 * The meta keeper: posts the Pyth-derived market meta once per ten-minute window.
 *
 * `MarketMeta.postFromPyth` is permissionless — anyone may pay the Pyth update
 * fee and have the contract derive every fighter's modifier from spot-vs-EMA in
 * that same transaction. Someone has to actually do it each window, though, and
 * that is this loop. It only ever submits fresh Pyth updates; the numbers are
 * computed on chain, so the keeper cannot choose them.
 *
 * On by default on the local chain (signed local oracle), opt-in elsewhere with
 * `META_KEEPER=1`. When a CRE workflow is the meta's writer, leave it off: the
 * two share one epoch clock and whichever posts first owns the window.
 */
import { abis, CHAIN_ID, deployment, publicClient, roster } from './chain.js';
import { fetchPythUpdate, pythConfigured } from './pyth.js';
import { relayerAddress, sendRelayerTx } from './relayer.js';

const WINDOW = 600;
const pythAbi = [{
  type: 'function', name: 'getUpdateFee', stateMutability: 'view',
  inputs: [{ type: 'bytes[]', name: 'updateData' }], outputs: [{ type: 'uint256' }],
}];

let last = { epoch: 0, hash: null, at: 0, error: null };
export const keeperStatus = () => ({ enabled: enabled(), ...last });

function enabled() {
  const flag = process.env.META_KEEPER;
  if (flag === '0') return false;
  return (flag === '1' || CHAIN_ID === 31337) && Boolean(deployment?.marketMeta) && pythConfigured();
}

/** Posts this window's meta if nobody has yet. Returns the tx hash or null. */
export async function tickKeeper(now = Math.floor(Date.now() / 1000)) {
  if (!enabled() || !relayerAddress()) return null;
  const client = publicClient();
  const want = BigInt(Math.floor(now / WINDOW));
  const current = await client.readContract({ address: deployment.marketMeta, abi: abis.marketMeta, functionName: 'currentEpoch' });
  if (current >= want) return null;
  const ids = roster.map((c) => c.coinId);
  const { updateData, prices } = await fetchPythUpdate(ids);
  const coinIds = prices.map((p) => p.coinId);
  const fee = await client.readContract({ address: deployment.pyth, abi: pythAbi, functionName: 'getUpdateFee', args: [updateData] });
  try {
    const { hash } = await sendRelayerTx({
      address: deployment.marketMeta, abi: abis.marketMeta, functionName: 'postFromPyth', args: [coinIds, updateData], value: fee,
    });
    last = { epoch: Number(want), hash, at: Date.now(), error: null };
    console.log(`keeper: posted meta epoch ${want} for ${coinIds.length} fighters (${hash.slice(0, 10)}…)`);
    return hash;
  } catch (e) {
    last = { ...last, error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 160) };
    // StaleEpoch: someone else (CRE, another keeper) took the window. Fine.
    if (!/StaleEpoch/.test(last.error)) console.warn(`keeper: ${last.error}`);
    return null;
  }
}

export function startKeeper() {
  if (!enabled()) return;
  const run = () => { void tickKeeper().catch((e) => { last = { ...last, error: String(e?.message ?? e) }; }); };
  setTimeout(run, 2_000);
  setInterval(run, 60_000);
  console.log('keeper: posting Pyth momentum meta each ten-minute window');
}
