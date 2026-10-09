/**
 * Gasless chests on a real chain: an anvil fork of Monad testnet under Prague
 * (EIP-7702), with the canonical EntryPoint v0.8 that is already deployed
 * there, our paymaster and 7702 account from the deploy script, and the relay
 * as sponsor and bundler.
 *
 * A fresh player with 0 MON gets a golden chest, signs one EIP-7702
 * authorization and two user operations (open, reveal), and ends with new
 * cards and still 0 MON. The relay refuses what it must: non-chest calls,
 * calls that would revert, foreign authorizations, unsponsored operations.
 *
 *   node test-gasless.mjs   (forks its own chain on :8613)
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, encodeFunctionData, http, numberToHex, pad, parseEther } from 'viem';
import { entryPoint08Abi } from 'viem/account-abstraction';
import { startTestChain } from './test-chain.mjs';
import { client, freshAccount, startRelay, tally } from './test-util.mjs';

const tc = await startTestChain({ hardfork: 'prague' });
const RPC_URL = tc.rpcUrl;
const PORT = Number(process.env.PORT ?? 8794);
const RELAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const cardsAbi = read('./shared/abi/MempireCards.json');
const accountAbi = read('./shared/abi/MempireAccount7702.json');
const dep = tc.dep;
const pub = createPublicClient({ chain: tc.chain, transport: http(RPC_URL) });
const rpc = (method, params) => fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());
const word = (hi, lo) => pad(numberToHex((BigInt(hi) << 128n) | BigInt(lo)), { size: 32 });

const { check, done } = tally();
console.log(`gasless → anvil ${RPC_URL} (prague), relay :${PORT}\n`);
const relay = await startRelay(PORT, { CHAIN_ID: String(tc.chainId), RPC_URL, RELAYER_PRIVATE_KEY: RELAYER_KEY });
const req = client(relay.base);

/** An unsigned operation calling cards.<fn>(args) through the player's 7702 account. */
async function userOp(player, fn, args) {
  const inner = encodeFunctionData({ abi: cardsAbi, functionName: fn, args });
  const gasPrice = await pub.getGasPrice();
  return {
    sender: player.address,
    nonce: await pub.readContract({ address: dep.entryPoint, abi: entryPoint08Abi, functionName: 'getNonce', args: [player.address, 0n] }),
    initCode: '0x',
    callData: encodeFunctionData({ abi: accountAbi, functionName: 'execute', args: [dep.cards, 0n, inner] }),
    accountGasLimits: word(150_000, 1_500_000),
    preVerificationGas: 60_000n,
    gasFees: word(gasPrice / 2n, gasPrice),
    paymasterAndData: '0x',
    signature: '0x',
  };
}
const json = (op) => JSON.parse(JSON.stringify(op, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
/** Sponsor via the relay, then sign the operation hash as the player. */
async function sponsorAndSign(player, op) {
  const s = await req('POST', '/api/gasless/sponsor', { userOp: json(op) });
  if (s.status !== 200) return { status: s.status, error: s.data?.error };
  const signedOp = { ...op, paymasterAndData: s.data.paymasterAndData };
  // The EntryPoint's own hash (EIP-712 in v0.8): the account checks a raw signature over it.
  const hash = await pub.readContract({ address: dep.entryPoint, abi: entryPoint08Abi, functionName: 'getUserOpHash', args: [signedOp] });
  signedOp.signature = await player.sign({ hash });
  return { status: 200, op: signedOp };
}
const chestState = async (id) => (await pub.readContract({ address: dep.cards, abi: cardsAbi, functionName: 'chests', args: [id] }))[2];

try {
  console.log('0. the deployment has the gasless pieces');
  const info = await req('GET', '/api/gasless');
  check('the relay reports gasless available', info.data?.available === true, JSON.stringify(info.data));
  check('the EntryPoint is the canonical v0.8, already on the fork', (await pub.getCode({ address: dep.entryPoint }))?.length > 1000 && dep.entryPoint.toLowerCase() === '0x4337084d9e255ff0702461cf8895ce9e3b5ff108');

  console.log('\n1. a player with 0 MON and a golden chest');
  const player = freshAccount();
  // Chests come from wins and the season pass; impersonate the season pass to grant one.
  await rpc('anvil_impersonateAccount', [dep.seasonPass]);
  await rpc('anvil_setBalance', [dep.seasonPass, numberToHex(parseEther('1'))]);
  const impersonated = createWalletClient({ account: dep.seasonPass, chain: tc.chain, transport: http(RPC_URL) });
  await pub.waitForTransactionReceipt({ hash: await impersonated.writeContract({ address: dep.cards, abi: cardsAbi, functionName: 'grantGolden', args: [player.address] }) });
  await rpc('anvil_stopImpersonatingAccount', [dep.seasonPass]);
  const [ids] = await pub.readContract({ address: dep.cards, abi: cardsAbi, functionName: 'chestsOf', args: [player.address] });
  const chestId = ids[0];
  check('the player holds 0 MON', (await pub.getBalance({ address: player.address })) === 0n);
  check('and a golden chest ready to open', (await chestState(chestId)) === 2, String(chestId));

  console.log('\n2. what the relay refuses');
  const bad = await sponsorAndSign(player, { ...(await userOp(player, 'open', [chestId])), callData: encodeFunctionData({ abi: accountAbi, functionName: 'execute', args: [dep.token, 0n, '0x'] }) });
  check('a non-chest call is not sponsored', bad.status === 400, bad.error);
  const reverting = await sponsorAndSign(player, await userOp(player, 'reveal', [chestId, []]));
  check('a chest call that would revert is not sponsored', reverting.status === 400 && /would fail/.test(reverting.error ?? ''), reverting.error);
  const greedy = await sponsorAndSign(player, { ...(await userOp(player, 'open', [chestId])), accountGasLimits: word(150_000, 9_000_000) });
  check('oversized gas limits are not sponsored', greedy.status === 400, greedy.error);

  console.log('\n3. open, gasless, with the 7702 authorization in the same transaction');
  const authorization = await player.signAuthorization({ contractAddress: dep.account7702, chainId: tc.chainId, nonce: 0 });
  const auth = { address: authorization.address, chainId: authorization.chainId, nonce: authorization.nonce, r: authorization.r, s: authorization.s, yParity: authorization.yParity };
  const open = await sponsorAndSign(player, await userOp(player, 'open', [chestId]));
  check('the relay sponsors the open', open.status === 200, open.error);
  const stranger = freshAccount();
  const foreign = await stranger.signAuthorization({ contractAddress: dep.account7702, chainId: tc.chainId, nonce: 0 });
  const wrongAuth = await req('POST', '/api/gasless/send', { userOp: json(open.op), authorization: json(foreign) });
  check("someone else's authorization is refused", wrongAuth.status === 400, wrongAuth.data?.error);
  const sent = await req('POST', '/api/gasless/send', { userOp: json(open.op), authorization: json(auth) });
  check('the relay bundles it; the operation succeeds', sent.status === 200 && sent.data?.success === true, JSON.stringify(sent.data));
  const code = await pub.getCode({ address: player.address });
  check("the player's address now delegates to MempireAccount7702", code?.toLowerCase() === `0xef0100${dep.account7702.slice(2).toLowerCase()}`, code);
  check('the chest is opening', (await chestState(chestId)) === 3);

  console.log('\n4. reveal, gasless (already delegated: no authorization)');
  await rpc('anvil_mine', ['0x2']);
  const [before] = await pub.readContract({ address: dep.cards, abi: cardsAbi, functionName: 'cardsOf', args: [player.address] });
  const reveal = await sponsorAndSign(player, await userOp(player, 'reveal', [chestId, []]));
  const sent2 = reveal.status === 200 ? await req('POST', '/api/gasless/send', { userOp: json(reveal.op) }) : reveal;
  check('reveal sponsored and bundled', sent2.status === 200 && sent2.data?.success === true, JSON.stringify(sent2.data ?? sent2.error));
  const [after] = await pub.readContract({ address: dep.cards, abi: cardsAbi, functionName: 'cardsOf', args: [player.address] });
  check('new cards landed on the player', after.length > before.length, `${before.length} → ${after.length}`);
  check('and the player still holds 0 MON', (await pub.getBalance({ address: player.address })) === 0n);

  const unsponsored = await req('POST', '/api/gasless/send', { userOp: json({ ...reveal.op, paymasterAndData: '0x' }) });
  check('an operation without the Mempire paymaster is not bundled', unsponsored.status === 400);
} catch (e) {
  check('suite ran to completion', false, String(e?.stack ?? e).slice(0, 400));
} finally {
  await relay.stop();
  await tc.stop();
}
process.exit(done() ? 1 : 0);
