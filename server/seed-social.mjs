/**
 * Team-seeded demo activity, part 2 (13 Oct): clans, a clan war and gasless
 * chests, from the guest wallets that played the seeded matches
 * (keys/seed-13oct.json, gitignored). Everything goes through the hosted relay
 * and the real contracts: founders pay the 250 $MEMPIRE charter on chain, and
 * chests are unlocked with EIP-7702 + the paymaster.
 *
 *   node seed-social.mjs   (writes ../docs/evidence/seed-social.json)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, erc20Abi, http, numberToHex, pad, parseEther } from 'viem';
import { entryPoint08Abi } from 'viem/account-abstraction';
import { privateKeyToAccount } from 'viem/accounts';

const RELAY = 'https://relay-production-9c75.up.railway.app';
const RPC = 'https://testnet-rpc.monad.xyz';
const chain = defineChain({ id: 10143, name: 'Monad Testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const dep = read('./shared/deployments/10143.json');
const cardsAbi = read('./shared/abi/MempireCards.json');
const accountAbi = read('./shared/abi/MempireAccount7702.json');
const dk = read('../keys/deployer.json');
const deployer = privateKeyToAccount((dk[0] ?? dk).private_key);
const seeds = read('../keys/seed-13oct.json').map((s) => ({ ...s, account: privateKeyToAccount(s.key) }));
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = (account) => createWalletClient({ account, chain, transport: http(RPC) });
const authMessage = (address, action, ts) => `Mempire\naction: ${action}\nwallet: ${address}\nts: ${ts}`;
const evidence = { at: new Date().toISOString(), note: 'Team-seeded demo activity, not organic users.', clans: [], war: null, gasless: [], txs: [] };

async function signedPost(path, account, action, body = {}) {
  const ts = Date.now();
  const signature = await account.signMessage({ message: authMessage(account.address, action, ts) });
  const r = await fetch(`${RELAY}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, address: account.address, ts, signature }) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function send(account, call) {
  const gas = await pub.estimateContractGas({ account, ...call });
  const hash = await wallet(account).writeContract({ ...call, gas: (gas * 115n) / 100n });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${call.functionName} reverted`);
  return hash;
}
const powerOf = async (a) => (await pub.readContract({ address: dep.cards, abi: cardsAbi, functionName: 'cardsOf', args: [a] }))[0].length;

// ── clans ────────────────────────────────────────────────────────────────
const treasury = await pub.readContract({ address: dep.cards, abi: cardsAbi, functionName: 'treasury' });
const plan = [
  { name: 'Diamond Hands', founder: 0, members: [1, 3] },
  { name: 'Bridge Burners', founder: 2, members: [5, 7] },
  { name: 'Candle Knights', founder: 4, members: [6] },
];
for (const c of plan) {
  const f = seeds[c.founder].account;
  const fund = await send(deployer, { address: dep.token, abi: erc20Abi, functionName: 'transfer', args: [f.address, parseEther('250')] });
  const charter = await send(f, { address: dep.token, abi: erc20Abi, functionName: 'transfer', args: [treasury, parseEther('250')] });
  const created = await signedPost('/api/clans', f, 'clan.create', {
    name: c.name, description: 'Seeded by the Mempire team for the demo', region: 'Global',
    crest: { shape: c.founder % 4, emblem: c.founder % 5, hue: (c.founder * 70) % 360 }, requiredPower: 0, joinMode: 'open',
    memberName: `seed-${c.founder}`, power: await powerOf(f.address), paymentTx: charter,
  });
  const tag = created.data?.tag;
  console.log(`clan ${c.name}: ${created.status} ${tag ?? JSON.stringify(created.data).slice(0, 120)}`);
  const joined = [];
  for (const m of c.members) {
    const a = seeds[m].account;
    const j = await signedPost(`/api/clans/${tag}/join`, a, 'clan.join', { power: await powerOf(a.address), memberName: `seed-${m}` });
    joined.push({ member: a.address, status: j.status });
  }
  evidence.clans.push({ name: c.name, tag, founder: f.address, charterTx: charter, fundTx: fund, joined });
}

// ── a clan war: the first two clans' leaders enter a 2-clan bracket ─────────
const entries = [];
for (const c of plan.slice(0, 2)) entries.push(await signedPost('/api/clan-wars/enter', seeds[c.founder].account, 'clanwar.enter'));
evidence.war = entries.map((e) => ({ status: e.status, war: e.data?.war?._id ?? null, warStatus: e.data?.war?.status ?? e.data?.error }));
console.log('clan war:', JSON.stringify(evidence.war));

// ── gasless: unlock two winners' chests through EIP-7702 + the paymaster ────
const word = (hi, lo) => pad(numberToHex((BigInt(hi) << 128n) | BigInt(lo)), { size: 32 });
const json = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
const relay = async (path, body) => { const r = await fetch(`${RELAY}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
let done = 0;
for (const s of seeds) {
  if (done >= 2) break;
  const [ids, data] = await pub.readContract({ address: dep.cards, abi: cardsAbi, functionName: 'chestsOf', args: [s.account.address] });
  const idx = data.findIndex((c) => Number(c.state) === 1); // idle: start its timer
  if (idx < 0) continue;
  const chestId = ids[idx];
  const gasPrice = await pub.getGasPrice();
  const op = {
    sender: s.account.address,
    nonce: await pub.readContract({ address: dep.entryPoint, abi: entryPoint08Abi, functionName: 'getNonce', args: [s.account.address, 0n] }),
    initCode: '0x',
    callData: encodeFunctionData({ abi: accountAbi, functionName: 'execute', args: [dep.cards, 0n, encodeFunctionData({ abi: cardsAbi, functionName: 'startUnlock', args: [chestId] })] }),
    accountGasLimits: word(150_000, 200_000), preVerificationGas: 60_000n, gasFees: word(gasPrice / 2n, gasPrice), paymasterAndData: '0x', signature: '0x',
  };
  const sp = await relay('/api/gasless/sponsor', { userOp: json(op) });
  if (sp.status !== 200) { console.log('sponsor refused:', sp.data.error); continue; }
  op.paymasterAndData = sp.data.paymasterAndData;
  op.signature = await s.account.sign({ hash: await pub.readContract({ address: dep.entryPoint, abi: entryPoint08Abi, functionName: 'getUserOpHash', args: [op] }) });
  const code = await pub.getCode({ address: s.account.address });
  const delegated = code?.toLowerCase().startsWith('0xef0100');
  const auth = delegated ? null : await s.account.signAuthorization({ contractAddress: dep.account7702, chainId: 10143, nonce: await pub.getTransactionCount({ address: s.account.address }) });
  const before = await pub.getBalance({ address: s.account.address });
  const sent = await relay('/api/gasless/send', { userOp: json(op), ...(auth ? { authorization: json(auth) } : {}) });
  const after = await pub.getBalance({ address: s.account.address });
  console.log(`gasless startUnlock chest ${chestId} for ${s.account.address}: ${JSON.stringify(sent.data)} · MON ${before === after ? 'unchanged' : 'CHANGED'}`);
  if (sent.data?.success) { evidence.gasless.push({ player: s.account.address, chestId: String(chestId), tx: sent.data.hash, monUnchanged: before === after }); done += 1; }
}
writeFileSync(new URL('../docs/evidence/seed-social.json', import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`);
console.log('done');
