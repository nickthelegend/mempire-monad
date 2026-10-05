/**
 * Privy beyond login, end to end on the local anvil deployment (mock mode).
 *
 * A player signs up with an email and gets an embedded wallet. Every one of
 * their own transactions is sponsored — the wallet starts with zero MON and
 * still stakes. They consent to the session signer under the match policy, and
 * from then on their in-match calls go out as their wallet, through the relay,
 * with no prompt: the policy lets `play` and `claim` through and refuses
 * anything else — a token transfer, a cancel, a call to the wrong contract.
 *
 *   anvil on 127.0.0.1:8611 with shared/deployments/31337.json deployed
 *   node test-privy.mjs
 */
import { readFileSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, http, parseEther, zeroAddress,
} from 'viem';
import { authMessage, client, freshAccount, signed, startRelay, tally } from './test-util.mjs';

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8611';
const PORT = Number(process.env.PORT ?? 8795);
const RELAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const FUNDER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // anvil #2

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const dep = read('./shared/deployments/31337.json');
const cardsAbi = read('./shared/abi/MempireCards.json');
const arenaAbi = read('./shared/abi/MempireArena.json');
const chain = { id: 31337, name: 'Anvil', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } };
const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const NO_PERMIT = { deadline: 0n, v: 0, r: `0x${'00'.repeat(32)}`, s: `0x${'00'.repeat(32)}` };

const { check, done } = tally();
console.log(`privy (mock) → anvil ${RPC_URL}, relay :${PORT}\n`);
const relay = await startRelay(PORT, {
  CHAIN_ID: '31337', RPC_URL, RELAYER_PRIVATE_KEY: RELAYER_KEY, ONBOARD_MON_DRIP: '0', META_KEEPER: '0', AUSD_FAUCET: dep.ausdFaucet,
});
const req = client(relay.base);

async function write(account, call) {
  const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });
  const hash = await wallet.writeContract(call);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${call.functionName} reverted`);
  return r;
}

try {
  console.log('1. config + sign-up');
  const cfg = await req('GET', '/api/privy/config');
  check('config reports mock mode on the local chain', cfg.data?.mode === 'mock');
  check('the policy is default-deny with three allow rules',
    cfg.data?.policy?.rules?.length === 3 && cfg.data.policy.rules.every((r) => r.action === 'ALLOW'));
  check('every rule pins the arena, value 0 and this chain', cfg.data.policy.rules.every((r) => {
    const by = Object.fromEntries(r.conditions.filter((c) => c.field_source === 'ethereum_transaction').map((c) => [c.field, c.value]));
    return by.to === dep.arena && by.value === '0' && by.chain_id === '31337';
  }));

  const email = `p${Date.now()}@example.test`;
  const login = await req('POST', '/api/privy/mock/login', { email });
  check('email sign-up creates an embedded wallet', login.status === 200 && /^0x[0-9a-fA-F]{40}$/.test(login.data?.address ?? ''));
  const { token, address } = login.data;
  const again = await req('POST', '/api/privy/mock/login', { email });
  check('the same email gets the same wallet', again.data?.address === address);
  check('a bad email is refused', (await req('POST', '/api/privy/mock/login', { email: 'nope' })).status === 400);
  check('the wallet starts with zero MON', (await pub.getBalance({ address })) === 0n);

  console.log('\n2. onboard, signed by the embedded wallet');
  const ts = Date.now();
  const sig = await req('POST', '/api/privy/mock/sign', { token, message: authMessage(address, 'onboard', ts) });
  check('the embedded wallet signs a message', /^0x[0-9a-f]{130}$/i.test(sig.data?.signature ?? ''));
  const ob = await req('POST', '/api/onboard', { address, ts, signature: sig.data.signature });
  check('onboard accepts the embedded wallet signature', ob.status === 200, ob.data?.error);
  const [ids] = await pub.readContract({ address: dep.cards, abi: cardsAbi, functionName: 'cardsOf', args: [address] });
  check('starter deck minted to the embedded wallet', ids.length === 8);
  check('still zero MON after onboarding (no drip)', (await pub.getBalance({ address })) === 0n);

  console.log('\n3. a sponsored stake from a wallet with no MON');
  const ausdBal = await pub.readContract({ address: dep.ausd, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
  check('AUSD arrived from the faucet', ausdBal >= 1_000_000n, String(ausdBal));
  const stake = await pub.readContract({ address: dep.arena, abi: arenaAbi, functionName: 'stakeFor', args: [dep.ausd, 0] });
  const approve = await req('POST', '/api/privy/mock/send', {
    token, tx: { to: dep.ausd, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [dep.arena, stake] }) },
  });
  check('approve went out sponsored', approve.status === 200 && approve.data?.sponsored === true, approve.data?.error);
  await pub.waitForTransactionReceipt({ hash: approve.data.hash });
  const id = await pub.readContract({ address: dep.arena, abi: arenaAbi, functionName: 'nextMatchId' });
  const create = await req('POST', '/api/privy/mock/send', {
    token,
    tx: { to: dep.arena, data: encodeFunctionData({ abi: arenaAbi, functionName: 'createMatch', args: [0, dep.ausd, ids, zeroAddress, NO_PERMIT] }) },
  });
  check('createMatch (AUSD $1) went out sponsored', create.status === 200, create.data?.error);
  await pub.waitForTransactionReceipt({ hash: create.data.hash });
  const spentMon = await pub.getBalance({ address });
  check('the player paid no gas of their own (dust only)', spentMon < parseEther('0.001'), String(spentMon));

  // A plain second seat joins.
  const p1 = freshAccount();
  const funder = (await import('viem/accounts')).privateKeyToAccount(FUNDER_KEY);
  await pub.waitForTransactionReceipt({ hash: await createWalletClient({ account: funder, chain, transport: http(RPC_URL) }).sendTransaction({ to: p1.address, value: parseEther('1') }) });
  await req('POST', '/api/onboard', await signed(p1, 'onboard'));
  const [d1] = await pub.readContract({ address: dep.cards, abi: cardsAbi, functionName: 'cardsOf', args: [p1.address] });
  await write(p1, { address: dep.ausd, abi: erc20Abi, functionName: 'approve', args: [dep.arena, stake] });
  await write(p1, { address: dep.arena, abi: arenaAbi, functionName: 'joinMatch', args: [id, d1, zeroAddress, NO_PERMIT] });
  const m = await pub.readContract({ address: dep.arena, abi: arenaAbi, functionName: 'getMatch', args: [id] });
  check('the match is Active', Number(m.state) === 2);

  console.log('\n4. the session signer, bound by the policy');
  const play = { to: dep.arena, data: encodeFunctionData({ abi: arenaAbi, functionName: 'play', args: [id, 40, 2, 100, -100] }) };
  const before = await req('POST', '/api/privy/act', { token, tx: play });
  check('without consent, the signer refuses', before.status === 403 && /consent/.test(before.data?.error ?? ''));
  const consent = await req('POST', '/api/privy/signers', { token });
  check('consent recorded with an expiry', consent.status === 200 && consent.data?.expiresAt > Date.now() / 1000);
  const p = await req('POST', '/api/privy/act', { token, tx: play });
  check('a card play goes out as the player, no prompt', p.status === 200, p.data?.error);
  await pub.waitForTransactionReceipt({ hash: p.data.hash });
  const after = await pub.readContract({ address: dep.arena, abi: arenaAbi, functionName: 'getMatch', args: [id] });
  check('the arena logged the play for seat 0', Number(after.plays0) === 1);

  const refuse = async (label, tx) => {
    const r = await req('POST', '/api/privy/act', { token, tx });
    check(`policy refuses ${label}`, r.status === 403 && /^policy:/.test(r.data?.error ?? ''), r.data?.error);
  };
  await refuse('cancelMatch', { to: dep.arena, data: encodeFunctionData({ abi: arenaAbi, functionName: 'cancelMatch', args: [id] }) });
  await refuse('a token transfer', { to: dep.ausd, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [p1.address, 1n] }) });
  await refuse('a card transfer', { to: dep.cards, data: encodeFunctionData({ abi: cardsAbi, functionName: 'transferFrom', args: [address, p1.address, ids[0]] }) });
  await refuse('garbage calldata to the arena', { to: dep.arena, data: '0xdeadbeef' });
  check('a bad token is 401', (await req('POST', '/api/privy/act', { token: 'x', tx: play })).status === 401);

  console.log('\n5. the result, through the signer; settlement pays');
  const claim = { to: dep.arena, data: encodeFunctionData({ abi: arenaAbi, functionName: 'claim', args: [id, 0, `0x${'ab'.repeat(32)}`] }) };
  const c0 = await req('POST', '/api/privy/act', { token, tx: claim });
  check('the claim goes out through the signer', c0.status === 200, c0.data?.error);
  await pub.waitForTransactionReceipt({ hash: c0.data.hash });
  const ausdBefore = await pub.readContract({ address: dep.ausd, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
  await write(p1, { address: dep.arena, abi: arenaAbi, functionName: 'claim', args: [id, 0, `0x${'ab'.repeat(32)}`] });
  const fin = await pub.readContract({ address: dep.arena, abi: arenaAbi, functionName: 'getMatch', args: [id] });
  const ausdAfter = await pub.readContract({ address: dep.ausd, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
  check('settled to seat 0', Number(fin.state) === 3 && Number(fin.winner) === 0);
  check('the Privy player was paid 90% of the $2 pot', ausdAfter - ausdBefore === 1_800_000n, String(ausdAfter - ausdBefore));

  console.log('\n6. revoking consent stops the signer');
  await req('DELETE', '/api/privy/signers', { token });
  const late = await req('POST', '/api/privy/act', { token, tx: play });
  check('after revocation the signer refuses', late.status === 403);
} finally {
  relay.stop();
}
process.exit(done() ? 1 : 0);
