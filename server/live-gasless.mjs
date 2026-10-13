/**
 * Gasless chests, live on Monad testnet, through the hosted relay.
 *
 * A fresh wallet gets 100 $MEMPIRE and a little MON from the deployer, buys
 * one golden chest, then opens and reveals it as ERC-4337 user operations from
 * its own address (EIP-7702 delegation to MempireAccount7702), sponsored by
 * MempirePaymaster and bundled by the relay. Its MON balance must not change
 * across the two sponsored operations.
 *
 *   node live-gasless.mjs   (writes ../docs/LIVE-GASLESS.json)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, formatEther, http, numberToHex, pad, parseEther } from 'viem';
import { entryPoint08Abi } from 'viem/account-abstraction';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { defineChain } from 'viem';

const RELAY = process.env.RELAY_URL ?? 'https://relay-production-9c75.up.railway.app';
const RPC = 'https://testnet-rpc.monad.xyz';
const chain = defineChain({ id: 10143, name: 'Monad Testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const dep = read('./shared/deployments/10143.json');
const cardsAbi = read('./shared/abi/MempireCards.json');
const accountAbi = read('./shared/abi/MempireAccount7702.json');
const keyJson = read('../keys/deployer.json');
const deployer = privateKeyToAccount((keyJson[0] ?? keyJson).private_key);
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = (account) => createWalletClient({ account, chain, transport: http(RPC) });
const word = (hi, lo) => pad(numberToHex((BigInt(hi) << 128n) | BigInt(lo)), { size: 32 });
const json = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
const post = async (path, body) => { const r = await fetch(`${RELAY}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
const evidence = { relay: RELAY, at: new Date().toISOString(), txs: {} };

async function send(account, call) {
  const gas = await pub.estimateContractGas({ account, ...call });
  const hash = await wallet(account).writeContract({ ...call, gas: (gas * 115n) / 100n });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${call.functionName} reverted`);
  return hash;
}

async function userOp(player, fn, args) {
  const gasPrice = await pub.getGasPrice();
  return {
    sender: player.address,
    nonce: await pub.readContract({ address: dep.entryPoint, abi: entryPoint08Abi, functionName: 'getNonce', args: [player.address, 0n] }),
    initCode: '0x',
    callData: encodeFunctionData({ abi: accountAbi, functionName: 'execute', args: [dep.cards, 0n, encodeFunctionData({ abi: cardsAbi, functionName: fn, args })] }),
    accountGasLimits: word(150_000, fn === 'reveal' ? 1_500_000 : 200_000),
    preVerificationGas: 60_000n,
    gasFees: word(gasPrice / 2n, gasPrice),
    paymasterAndData: '0x',
    signature: '0x',
  };
}
async function sponsorSignSend(player, fn, args, authorization) {
  const op = await userOp(player, fn, args);
  const s = await post('/api/gasless/sponsor', { userOp: json(op) });
  if (s.status !== 200) throw new Error(`sponsor ${fn}: ${s.data.error}`);
  op.paymasterAndData = s.data.paymasterAndData;
  const hash = await pub.readContract({ address: dep.entryPoint, abi: entryPoint08Abi, functionName: 'getUserOpHash', args: [op] });
  op.signature = await player.sign({ hash });
  const sent = await post('/api/gasless/send', { userOp: json(op), ...(authorization ? { authorization: json(authorization) } : {}) });
  if (sent.status !== 200 || !sent.data.success) throw new Error(`send ${fn}: ${JSON.stringify(sent.data)}`);
  return sent.data;
}

const player = privateKeyToAccount(generatePrivateKey());
evidence.player = player.address;
console.log('player', player.address);
evidence.txs.fundMempire = await send(deployer, { address: dep.token, abi: erc20Abi, functionName: 'transfer', args: [player.address, parseEther('100')] });
const fundHash = await wallet(deployer).sendTransaction({ to: player.address, value: parseEther('0.3'), gas: 21_000n });
await pub.waitForTransactionReceipt({ hash: fundHash });
evidence.txs.fundMon = fundHash;
// The public RPC is load-balanced: wait until the funding is visible before spending it.
while ((await pub.getBalance({ address: player.address })) === 0n) await new Promise((r) => { setTimeout(r, 500); });
// Monad executes a few blocks behind consensus, and consensus checks a sender's
// balance as of then: a wallet funded this instant still looks empty to it.
const funded = await pub.getBlockNumber();
while ((await pub.getBlockNumber()) < funded + 6n) await new Promise((r) => { setTimeout(r, 400); });
evidence.txs.approve = await send(player, { address: dep.token, abi: erc20Abi, functionName: 'approve', args: [dep.cards, parseEther('100')] });
evidence.txs.buyChest = await send(player, { address: dep.cards, abi: cardsAbi, functionName: 'buyChest', args: [] });
const [ids] = await pub.readContract({ address: dep.cards, abi: cardsAbi, functionName: 'chestsOf', args: [player.address] });
const chestId = ids[0];

const before = await pub.getBalance({ address: player.address });
const authorization = await player.signAuthorization({ contractAddress: dep.account7702, chainId: 10143, nonce: await pub.getTransactionCount({ address: player.address }) });
const opened = await sponsorSignSend(player, 'open', [chestId], authorization);
evidence.txs.gaslessOpen = opened.hash;
console.log('open (with 7702 authorization):', opened.hash, 'paymaster paid', formatEther(BigInt(opened.actualGasCost)), 'MON');
// Wait for the reveal block to pass.
const openBlock = (await pub.getTransactionReceipt({ hash: opened.hash })).blockNumber;
while ((await pub.getBlockNumber()) <= openBlock + 1n) await new Promise((r) => { setTimeout(r, 400); });
const [cardsBefore] = await pub.readContract({ address: dep.cards, abi: cardsAbi, functionName: 'cardsOf', args: [player.address] });
const revealed = await sponsorSignSend(player, 'reveal', [chestId, []]);
evidence.txs.gaslessReveal = revealed.hash;
const [cardsAfter] = await pub.readContract({ address: dep.cards, abi: cardsAbi, functionName: 'cardsOf', args: [player.address] });
const after = await pub.getBalance({ address: player.address });
const code = await pub.getCode({ address: player.address });
evidence.delegatedTo = code;
evidence.monBefore = formatEther(before);
evidence.monAfter = formatEther(after);
evidence.cardsMinted = cardsAfter.length - cardsBefore.length;
evidence.paymasterPaidMon = formatEther(BigInt(opened.actualGasCost) + BigInt(revealed.actualGasCost));
const ok = before === after && evidence.cardsMinted > 0 && code?.toLowerCase().startsWith('0xef0100');
writeFileSync(new URL('../docs/LIVE-GASLESS.json', import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
console.log(ok ? 'LIVE GASLESS PASS' : 'LIVE GASLESS FAIL');
process.exit(ok ? 0 : 1);
