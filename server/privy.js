/**
 * Privy: embedded wallets, sponsored gas, and a session signer bound by a policy.
 *
 * # What Privy does in Mempire
 *
 * A player who signs in with email (or Google) gets a Privy embedded wallet.
 * Two Privy features then remove every wallet prompt from a match:
 *
 *  1. **Native gas sponsorship.** The player's own transactions — the stake,
 *     a mint — go out with `sponsor: true`, so a brand-new account plays with
 *     zero MON for gas.
 *  2. **A session signer with a policy.** At first sign-in the player adds this
 *     server's authorization key as a signer on their wallet, limited by
 *     `MATCH_POLICY`: only `MempireArena.play`, `checkpoint` and `claim`, only
 *     to the arena, only with value 0, only on this chain, and only until the
 *     consent expires. During a match the relay sends those calls *as the
 *     player's wallet*, through Privy, sponsored — no popups, and no way for the
 *     server to touch a stake, a card or a token, because the policy (enforced
 *     inside Privy's TEE) denies everything else.
 *
 * This file checks the same policy itself before asking Privy to sign, so a
 * bug here is refused twice.
 *
 * # Two modes
 *
 *  - `privy`: real. Needs PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AUTHORIZATION_KEY
 *    (base64 PKCS8 P-256, no PEM headers) and PRIVY_SIGNER_ID (the key quorum
 *    id registered for it). PRIVY_POLICY_ID is used if set, otherwise the
 *    policy is created at boot from MATCH_POLICY.
 *  - `mock`: LOCAL ONLY, labelled in every response. It emulates Privy's
 *    custody model so the identical flow runs on anvil without an account: the
 *    "embedded wallet" key is held server-side (as Privy's TEE would hold it),
 *    the player authenticates with a session token, "sponsorship" is the
 *    relayer topping the wallet up with exactly the gas a call needs, and the
 *    session signer is a recorded consent checked against the same policy.
 *    Refused on any chain but 31337.
 */
import { randomBytes } from 'node:crypto';
import {
  createWalletClient, decodeFunctionData, getAddress, http, isAddress, parseEther, toFunctionSelector,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { abis, chain, CHAIN_ID, deployment, publicClient, RPC_URL } from './chain.js';
import { sendRelayerTx } from './relayer.js';

const APP_ID = process.env.PRIVY_APP_ID ?? '';
const APP_SECRET = process.env.PRIVY_APP_SECRET ?? '';
const AUTH_KEY = process.env.PRIVY_AUTHORIZATION_KEY ?? '';
const SIGNER_ID = process.env.PRIVY_SIGNER_ID ?? '';
let POLICY_ID = process.env.PRIVY_POLICY_ID ?? '';

/** How long one consent lasts. The player re-consents after this. */
export const CONSENT_TTL_SECS = 24 * 60 * 60;

export const privyMode = () => {
  if (APP_ID && APP_SECRET && AUTH_KEY && SIGNER_ID) return 'privy';
  return CHAIN_ID === 31337 ? 'mock' : 'off';
};

// ──────────────────────────────────────────────────────────────── the policy

const ALLOWED = ['play', 'checkpoint', 'claim'];
const selectorOf = (name) => {
  const item = abis.arena.find((x) => x.type === 'function' && x.name === name);
  return toFunctionSelector(item);
};

/**
 * The policy, in Privy's policy-engine format. Default DENY; one ALLOW rule per
 * arena method, each pinned to the arena address, value 0 and this chain, and
 * the decoded calldata's function name. Created in Privy at boot (real mode)
 * and evaluated locally by `checkPolicy` in both modes.
 */
export function matchPolicy() {
  const arena = deployment?.arena ?? '0x0000000000000000000000000000000000000000';
  return {
    version: '1.0',
    name: 'mempire-match-actions',
    chain_type: 'ethereum',
    rules: ALLOWED.map((fn) => ({
      name: `arena.${fn}`,
      method: 'eth_sendTransaction',
      action: 'ALLOW',
      conditions: [
        { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: arena },
        { field_source: 'ethereum_transaction', field: 'value', operator: 'eq', value: '0' },
        { field_source: 'ethereum_transaction', field: 'chain_id', operator: 'eq', value: String(CHAIN_ID) },
        {
          field_source: 'ethereum_calldata',
          field: `${fn}.matchId`,
          abi: abis.arena.filter((x) => x.type === 'function' && x.name === fn),
          operator: 'gte',
          value: '1',
        },
      ],
    })),
  };
}

/**
 * The same policy, evaluated here. Returns null when the transaction is
 * allowed, or the reason it is not.
 */
export function checkPolicy(tx, consent) {
  if (!deployment) return 'no deployment on this chain';
  if (!consent) return 'no session signer consent for this wallet';
  if (consent.expiresAt * 1000 < Date.now()) return 'session signer consent has expired';
  if (Number(tx.chainId ?? CHAIN_ID) !== CHAIN_ID) return 'wrong chain';
  if (!tx.to || getAddress(tx.to) !== getAddress(deployment.arena)) return 'only the arena may be called';
  if (BigInt(tx.value ?? 0) !== 0n) return 'value must be 0';
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: abis.arena, data: tx.data });
  } catch {
    return 'calldata is not an arena call';
  }
  if (!ALLOWED.includes(decoded.functionName)) return `${decoded.functionName} is not allowed by the policy`;
  return null;
}

// ──────────────────────────────────────────────────────────────── consents

/** Wallet → { expiresAt, policyId, walletId? }. The consent the player gave. */
const consents = new Map();
export const consentFor = (address) => consents.get(getAddress(address)) ?? null;

// ──────────────────────────────────────────────────────────────── mock custody

/** session token → { address, key, email }. LOCAL ONLY. */
const mockSessions = new Map();
const mockByEmail = new Map();

function mockWallet(key) {
  const account = privateKeyToAccount(key);
  return createWalletClient({ account, chain, transport: http(RPC_URL) });
}

/**
 * "Sponsorship" in mock mode: the relayer sends the wallet exactly the gas this
 * call will cost, then the wallet sends it. Net effect for the player: zero
 * MON spent. The real path is Privy's `sponsor: true`.
 */
async function mockSponsoredSend(key, tx) {
  const client = publicClient();
  const wallet = mockWallet(key);
  const from = wallet.account.address;
  // Estimated at a zero gas price: the wallet may hold nothing yet, and a node
  // refuses to estimate a call its sender cannot afford at the market price.
  const gas = (await client.estimateGas({
    account: from, to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0), gasPrice: 0n,
  }) * 120n) / 100n;
  // The fees that size the top-up are the fees the transaction pays: letting
  // the client re-estimate after the top-up block lands can ask for more.
  const fees = await client.estimateFeesPerGas();
  const maxFeePerGas = (fees.maxFeePerGas * 3n) / 2n;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
  const need = gas * maxFeePerGas + BigInt(tx.value ?? 0);
  const have = await client.getBalance({ address: from });
  if (have < need) await sendRelayerTx({ to: from, value: need - have });
  return wallet.sendTransaction({
    to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0), gas, maxFeePerGas, maxPriorityFeePerGas,
  });
}

// ──────────────────────────────────────────────────────────────── real Privy

let client = null;
async function privy() {
  if (!client) {
    const { PrivyClient } = await import('@privy-io/node');
    client = new PrivyClient({ appId: APP_ID, appSecret: APP_SECRET });
  }
  return client;
}

async function ensurePolicy() {
  if (POLICY_ID || privyMode() !== 'privy' || !deployment) return POLICY_ID;
  const p = await (await privy()).policies().create(matchPolicy());
  POLICY_ID = p.id;
  console.log(`privy: created policy ${POLICY_ID} (arena play/checkpoint/claim, value 0, chain ${CHAIN_ID})`);
  return POLICY_ID;
}

/** Verifies a Privy access token and returns the user's embedded Ethereum wallet. */
async function privyWalletOf(accessToken) {
  const p = await privy();
  const { user_id: userId } = await p.utils().auth().verifyAccessToken(accessToken);
  const user = await p.users()._get(userId);
  const embedded = user.linked_accounts.find((a) => a.type === 'wallet' && a.chain_type === 'ethereum'
    && (a.wallet_client_type === 'privy' || a.connector_type === 'embedded'));
  if (!embedded?.address) throw Object.assign(new Error('this Privy user has no embedded wallet'), { status: 403 });
  return { address: getAddress(embedded.address), walletId: embedded.id, userId };
}

// ──────────────────────────────────────────────────────────────── routes

async function authenticate(body) {
  if (privyMode() === 'mock') {
    const s = mockSessions.get(String(body.token ?? ''));
    if (!s) throw Object.assign(new Error('unknown or expired mock session'), { status: 401 });
    return { address: s.address, key: s.key };
  }
  if (!body.accessToken) throw Object.assign(new Error('accessToken required'), { status: 401 });
  try {
    return await privyWalletOf(String(body.accessToken));
  } catch (e) {
    throw Object.assign(new Error(e?.status ? e.message : 'that Privy session is not valid — sign in again'), { status: e?.status ?? 401 });
  }
}

const fail = (res, e) => res.status(e?.status ?? 400).json({ error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 200) });

export function registerPrivyRoutes(app, { gate } = {}) {
  const guard = gate ?? ((_req, _res, next) => next());
  if (privyMode() === 'privy') void ensurePolicy().catch((e) => console.warn(`privy: policy create failed — ${e?.message ?? e}`));

  app.get('/api/privy/config', (_req, res) => {
    res.json({
      mode: privyMode(),
      appId: privyMode() === 'privy' ? APP_ID : null,
      signerId: privyMode() === 'privy' ? SIGNER_ID : 'mock-signer',
      policyId: privyMode() === 'privy' ? POLICY_ID || null : 'mock-policy',
      policy: matchPolicy(),
      consentTtlSecs: CONSENT_TTL_SECS,
    });
  });

  // ── mock custody (LOCAL ONLY) ──
  app.post('/api/privy/mock/login', guard, (req, res) => {
    if (privyMode() !== 'mock') return res.status(404).json({ error: 'mock mode is off' });
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]{1,64}@[^@\s]{1,128}$/.test(email)) return res.status(400).json({ error: 'a valid email is required' });
    let key = mockByEmail.get(email);
    if (!key) { key = generatePrivateKey(); mockByEmail.set(email, key); }
    const token = randomBytes(24).toString('hex');
    const address = privateKeyToAccount(key).address;
    mockSessions.set(token, { address, key, email });
    res.json({ mode: 'mock', token, address, note: 'mock Privy: no OTP is sent and the key is held by this local relay' });
  });

  app.post('/api/privy/mock/sign', guard, async (req, res) => {
    try {
      const s = await authenticate(req.body ?? {});
      const message = String(req.body?.message ?? '');
      if (!message || message.length > 2000) return res.status(400).json({ error: 'message required' });
      res.json({ mode: 'mock', signature: await mockWallet(s.key).signMessage({ message }) });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/privy/mock/signTypedData', guard, async (req, res) => {
    try {
      const s = await authenticate(req.body ?? {});
      const td = req.body?.typedData;
      if (!td?.domain || !td?.types || !td?.primaryType) return res.status(400).json({ error: 'typedData required' });
      const parse = (v) => JSON.parse(JSON.stringify(v), (_k, x) => (typeof x === 'string' && /^\d+n$/.test(x) ? BigInt(x.slice(0, -1)) : x));
      res.json({ mode: 'mock', signature: await mockWallet(s.key).signTypedData(parse(td)) });
    } catch (e) { fail(res, e); }
  });

  /** The player's own transaction, sponsored (mock: relayer-funded gas). */
  app.post('/api/privy/mock/send', guard, async (req, res) => {
    try {
      const s = await authenticate(req.body ?? {});
      const tx = req.body?.tx ?? {};
      if (!isAddress(String(tx.to ?? ''))) return res.status(400).json({ error: 'tx.to required' });
      const hash = await mockSponsoredSend(s.key, tx);
      res.json({ mode: 'mock', hash, sponsored: true });
    } catch (e) { fail(res, e); }
  });

  /** Record the player's consent to the session signer under the policy. */
  app.post('/api/privy/signers', guard, async (req, res) => {
    try {
      const s = await authenticate(req.body ?? {});
      const expiresAt = Math.floor(Date.now() / 1000) + CONSENT_TTL_SECS;
      consents.set(getAddress(s.address), {
        expiresAt, policyId: privyMode() === 'privy' ? POLICY_ID : 'mock-policy', walletId: s.walletId ?? null,
      });
      res.json({ mode: privyMode(), address: s.address, expiresAt, policy: matchPolicy().name });
    } catch (e) { fail(res, e); }
  });

  app.delete('/api/privy/signers', guard, async (req, res) => {
    try {
      const s = await authenticate(req.body ?? {});
      consents.delete(getAddress(s.address));
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  /**
   * An in-match action, sent as the player's wallet by the session signer.
   * Body: { token | accessToken, tx: { to, data } }. Only what the policy
   * allows goes out; everything else is refused before Privy is asked.
   */
  app.post('/api/privy/act', guard, async (req, res) => {
    try {
      const s = await authenticate(req.body ?? {});
      const consent = consentFor(s.address);
      const tx = { to: req.body?.tx?.to, data: req.body?.tx?.data, value: 0, chainId: CHAIN_ID };
      const refusal = checkPolicy(tx, consent);
      if (refusal) return res.status(403).json({ error: `policy: ${refusal}` });
      let hash;
      if (privyMode() === 'mock') {
        hash = await mockSponsoredSend(s.key, tx);
      } else {
        const out = await (await privy()).wallets().ethereum().sendTransaction(consent.walletId ?? s.walletId, {
          caip2: `eip155:${CHAIN_ID}`,
          params: { transaction: { to: tx.to, data: tx.data, value: '0x0', chain_id: CHAIN_ID } },
          sponsor: true,
          authorization_context: { authorization_private_keys: [AUTH_KEY] },
        });
        hash = out.hash;
      }
      res.json({ mode: privyMode(), hash, sponsored: true });
    } catch (e) { fail(res, e); }
  });
}

/** Test seam: the local policy, without HTTP. */
export const _test = { consents, selectorOf, parseEther };
