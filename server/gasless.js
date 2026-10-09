/**
 * Gasless chests: EIP-7702 + an ERC-4337 paymaster, with the relay as sponsor
 * and bundler.
 *
 * A player with no MON delegates their own address to MempireAccount7702
 * (one EIP-7702 authorization, signed once) and sends their chest calls —
 * start the timer, open, reveal — as user operations through the canonical
 * EntryPoint v0.8. MempirePaymaster pays the gas from its deposit.
 *
 * The relay signs a sponsorship only for a chest call that succeeds when
 * simulated from the player's own address, with sane gas limits, a short
 * validity window and a per-player daily cap. It then bundles the signed
 * operation itself (the relayer key is the paymaster's sponsor and the
 * EntryPoint reimburses it as beneficiary). No third-party bundler.
 *
 *   GET  /api/gasless            what is deployed here, or why it is off
 *   POST /api/gasless/sponsor    { userOp }                 → { paymasterAndData, validUntil }
 *   POST /api/gasless/send       { userOp, authorization? } → { hash, success }
 */
import { concat, decodeFunctionData, isAddress, isHex, numberToHex, pad, parseEventLogs } from 'viem';
import { entryPoint08Abi } from 'viem/account-abstraction';
import { recoverAuthorizationAddress } from 'viem/utils';
import { abiOf, deployment, publicClient, sameAddress } from './chain.js';
import { relayerAddress, sendRelayerTx, signAsRelayer } from './relayer.js';

const paymasterAbi = abiOf('MempirePaymaster');
const accountAbi = abiOf('MempireAccount7702');

export const SPONSOR_WINDOW_S = 120;
export const DAILY_CAP = Number(process.env.GASLESS_DAILY_CAP ?? 30);
const PM_VERIFICATION_GAS = 100_000n;
const PM_POST_OP_GAS = 30_000n;
const LIMITS = { verification: 300_000n, call: 2_000_000n, preVerification: 100_000n };

const used = new Map(); // `${sender}:${day}` → sponsorships today

/** Why gasless is off on this relay, or null when it is on. */
export function gaslessRefusal() {
  if (!deployment?.paymaster || /^0x0+$/.test(deployment.paymaster)) return 'no paymaster in this deployment';
  if (!relayerAddress()) return 'no relayer key';
  return null;
}

const split = (w) => [BigInt(w) >> 128n, BigInt(w) & ((1n << 128n) - 1n)];

/** A user operation from JSON, with numbers as bigints; throws on a malformed one. */
export function parseUserOp(u) {
  const hex = (v) => { if (!isHex(v)) throw new Error('bad hex field'); return v; };
  if (!u || !isAddress(u.sender)) throw new Error('bad sender');
  return {
    sender: u.sender,
    nonce: BigInt(u.nonce),
    initCode: hex(u.initCode ?? '0x'),
    callData: hex(u.callData),
    accountGasLimits: hex(u.accountGasLimits),
    preVerificationGas: BigInt(u.preVerificationGas),
    gasFees: hex(u.gasFees),
    paymasterAndData: hex(u.paymasterAndData ?? '0x'),
    signature: hex(u.signature ?? '0x'),
  };
}

export function registerGaslessRoutes(app) {
  const client = publicClient();

  app.get('/api/gasless', (_req, res) => {
    const off = gaslessRefusal();
    res.json(off ? { available: false, reason: off } : {
      available: true, entryPoint: deployment.entryPoint, paymaster: deployment.paymaster,
      account7702: deployment.account7702, dailyCap: DAILY_CAP,
    });
  });

  app.post('/api/gasless/sponsor', async (req, res) => {
    const off = gaslessRefusal();
    if (off) return res.status(503).json({ error: off });
    let op;
    try { op = parseUserOp(req.body?.userOp); } catch (e) { return res.status(400).json({ error: e.message }); }
    try {
      const [verification, call] = split(op.accountGasLimits);
      const [, maxFee] = split(op.gasFees);
      const gasPrice = await client.getGasPrice();
      if (verification > LIMITS.verification || call > LIMITS.call || op.preVerificationGas > LIMITS.preVerification) {
        return res.status(400).json({ error: 'gas limits above what a chest call needs' });
      }
      if (maxFee > gasPrice * 2n) return res.status(400).json({ error: 'fee above twice the current gas price' });
      if (op.initCode !== '0x') return res.status(400).json({ error: 'initCode is not sponsored' });
      const ok = await client.readContract({ address: deployment.paymaster, abi: paymasterAbi, functionName: 'sponsorable', args: [op.callData] });
      if (!ok) return res.status(400).json({ error: 'only chest calls (start, open, reveal) are sponsored' });
      // The call must succeed as the player, or the paymaster would pay for a revert.
      const { args: [target, , inner] } = decodeFunctionData({ abi: accountAbi, data: op.callData });
      await client.call({ account: op.sender, to: target, data: inner }).catch((e) => {
        throw Object.assign(new Error(`that chest call would fail: ${e.shortMessage ?? e.message}`), { status: 400 });
      });
      const key = `${op.sender.toLowerCase()}:${Math.floor(Date.now() / 86_400_000)}`;
      if ((used.get(key) ?? 0) >= DAILY_CAP) return res.status(429).json({ error: `daily gasless cap reached (${DAILY_CAP})` });

      const validUntil = Math.floor(Date.now() / 1000) + SPONSOR_WINDOW_S;
      const head = concat([deployment.paymaster, pad(numberToHex(PM_VERIFICATION_GAS), { size: 16 }), pad(numberToHex(PM_POST_OP_GAS), { size: 16 }), pad(numberToHex(validUntil), { size: 6 }), pad('0x0', { size: 6 })]);
      const hash = await client.readContract({
        address: deployment.paymaster, abi: paymasterAbi, functionName: 'sponsorHash',
        args: [{ ...op, paymasterAndData: concat([head, pad('0x0', { size: 65 })]) }, validUntil, 0],
      });
      const paymasterAndData = concat([head, await signAsRelayer(hash)]);
      used.set(key, (used.get(key) ?? 0) + 1);
      res.json({ paymasterAndData, validUntil });
    } catch (e) {
      res.status(e.status ?? 500).json({ error: e.message });
    }
  });

  app.post('/api/gasless/send', async (req, res) => {
    const off = gaslessRefusal();
    if (off) return res.status(503).json({ error: off });
    let op;
    try { op = parseUserOp(req.body?.userOp); } catch (e) { return res.status(400).json({ error: e.message }); }
    if (!op.paymasterAndData.toLowerCase().startsWith(deployment.paymaster.toLowerCase())) {
      return res.status(400).json({ error: 'only operations sponsored by the Mempire paymaster are bundled here' });
    }
    try {
      const auth = req.body?.authorization;
      let authorizationList;
      if (auth) {
        authorizationList = [{
          address: auth.address, chainId: Number(auth.chainId), nonce: Number(auth.nonce),
          r: auth.r, s: auth.s, yParity: Number(auth.yParity),
        }];
        if (!sameAddress(auth.address, deployment.account7702)) return res.status(400).json({ error: 'the authorization must delegate to MempireAccount7702' });
        const authority = await recoverAuthorizationAddress({ authorization: authorizationList[0] });
        if (!sameAddress(authority, op.sender)) return res.status(400).json({ error: 'the authorization is not signed by the sender' });
      }
      const { hash, receipt } = await sendRelayerTx({
        address: deployment.entryPoint, abi: entryPoint08Abi, functionName: 'handleOps',
        args: [[op], relayerAddress()], ...(authorizationList ? { authorizationList } : {}),
      });
      const [event] = parseEventLogs({ abi: entryPoint08Abi, eventName: 'UserOperationEvent', logs: receipt.logs });
      res.json({ hash, success: Boolean(event?.args.success), actualGasCost: event?.args.actualGasCost?.toString() ?? null });
    } catch (e) {
      // The EntryPoint says why in FailedOp(index, "AAxx reason"); pass that on.
      const why = e.cause?.data?.args?.map(String).join(' · ');
      res.status(400).json({ error: why ? `${e.cause.data.errorName}: ${why}` : e.shortMessage ?? e.message, hash: e.hash ?? null });
    }
  });
}
