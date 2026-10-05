import type { Address, Hash, Hex, WalletClient } from 'viem';
import { CHAIN } from '../chain/provider';
import { apiFetch } from './api';

/*
 * Privy, from the client's side.
 *
 * Sign in with email → a Privy embedded wallet. Then two things Privy does
 * that a login alone does not:
 *
 *  - **Sponsored transactions.** The player's own transactions (stake, mint)
 *    go out with `sponsor: true` — a new account plays with zero MON.
 *  - **A session signer under a policy.** The player adds the relay's
 *    authorization key as a signer on their wallet, limited to arena
 *    play/checkpoint/claim (see `server/privy.js`). During a match the relay
 *    sends those calls as the player, so nothing prompts.
 *
 * Real mode (`VITE_PRIVY_APP_ID` set) runs through `@privy-io/react-auth`,
 * loaded lazily by `PrivyGate` so the SDK only ships to builds that use it;
 * the gate registers its hooks here as a `Bridge`. Without an app id the
 * relay's MOCK mode stands in on the local chain — same calls, same policy,
 * labelled "mock" everywhere it shows.
 */

export const PRIVY_APP_ID = (import.meta.env.VITE_PRIVY_APP_ID as string | undefined)?.trim() || null;

export type PrivyMode = 'privy' | 'mock' | 'off';

export interface PrivyConfig {
  mode: PrivyMode;
  signerId: string | null;
  policyId: string | null;
  policy: { name: string; rules: { name: string }[] };
  consentTtlSecs: number;
}

let config: PrivyConfig | null = null;

/** What the relay will do for Privy users, read once. */
export async function privyConfig(): Promise<PrivyConfig | null> {
  if (config) return config;
  const res = await apiFetch('/api/privy/config');
  if (!res?.ok) return null;
  config = await res.json() as PrivyConfig;
  if (PRIVY_APP_ID && config.mode !== 'privy') {
    console.warn('privy: the app has an app id but the relay is not configured for Privy');
  }
  return config;
}

export const privyAvailable = async (): Promise<boolean> => {
  if (PRIVY_APP_ID) return true;
  const c = await privyConfig();
  return c?.mode === 'mock';
};

/** The real SDK's hooks, registered by `PrivyGate` once it has mounted. */
export interface Bridge {
  login: () => Promise<void>;
  logout: () => Promise<void>;
  address: () => Address | null;
  accessToken: () => Promise<string | null>;
  signMessage: (message: string) => Promise<Hex>;
  signTypedData: (td: unknown) => Promise<Hex>;
  sendSponsored: (tx: { to: Address; data?: Hex; value?: bigint }) => Promise<Hash>;
  addSigners: (address: Address, signerId: string, policyIds: string[]) => Promise<void>;
  removeSigners: (address: Address) => Promise<void>;
}

let bridge: Bridge | null = null;
let bridgeWaiters: ((b: Bridge) => void)[] = [];
export function registerBridge(b: Bridge | null): void {
  bridge = b;
  if (b) { for (const w of bridgeWaiters) w(b); bridgeWaiters = []; }
}
const waitForBridge = (): Promise<Bridge> => (bridge ? Promise.resolve(bridge)
  : new Promise((r) => { bridgeWaiters.push(r); }));

// ──────────────────────────────────────────────────────────────── session

export interface PrivySession {
  mode: 'privy' | 'mock';
  address: Address;
  label: string;
  /** Mock: the relay's session token. Real: none (access tokens are fetched per call). */
  token: string | null;
}

let session: PrivySession | null = null;
export const privySession = (): PrivySession | null => session;

async function post<T>(path: string, body: Record<string, unknown>, method = 'POST'): Promise<T> {
  const res = await apiFetch(path, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res) throw new Error('the relay is unreachable');
  const j = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(j.error ?? `the relay answered ${res.status}`);
  return j;
}

/** Who is asking, in the form the relay's Privy routes accept. */
async function auth(): Promise<Record<string, string>> {
  if (!session) throw new Error('not signed in with Privy');
  if (session.mode === 'mock') return { token: session.token! };
  const t = await (await waitForBridge()).accessToken();
  if (!t) throw new Error('the Privy session has expired — sign in again');
  return { accessToken: t };
}

/** Sign in. Mock takes an email; real opens Privy's own modal. */
export async function privyLogin(email?: string): Promise<PrivySession> {
  if (PRIVY_APP_ID) {
    const b = await waitForBridge();
    await b.login();
    for (let i = 0; i < 40 && !b.address(); i += 1) await new Promise((r) => { setTimeout(r, 250); });
    const address = b.address();
    if (!address) throw new Error('Privy signed in but no embedded wallet appeared');
    session = { mode: 'privy', address, label: 'Privy', token: null };
    return session;
  }
  const r = await post<{ address: Address; token: string }>('/api/privy/mock/login', { email });
  session = { mode: 'mock', address: r.address, label: `${email} (Privy mock)`, token: r.token };
  return session;
}

export async function privyLogout(): Promise<void> {
  if (session?.mode === 'privy') await bridge?.logout().catch(() => {});
  session = null;
}

// ──────────────────────────────────────────────────────────────── the wallet

/**
 * A viem-shaped wallet for the embedded wallet: the three calls the rest of the
 * client makes (`signMessage`, `signTypedData`, `sendTransaction`), routed to
 * Privy — every transaction sponsored.
 */
export function privyWallet(): WalletClient {
  const signMessage = async ({ message }: { message: string | { raw: Hex } }): Promise<Hex> => {
    const text = typeof message === 'string' ? message : message.raw;
    if (session?.mode === 'privy') return (await waitForBridge()).signMessage(text);
    return (await post<{ signature: Hex }>('/api/privy/mock/sign', { ...(await auth()), message: text })).signature;
  };
  const signTypedData = async (td: Record<string, unknown>): Promise<Hex> => {
    const { account: _a, ...rest } = td;
    if (session?.mode === 'privy') return (await waitForBridge()).signTypedData(rest);
    const json = JSON.parse(JSON.stringify(rest, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
    return (await post<{ signature: Hex }>('/api/privy/mock/signTypedData', { ...(await auth()), typedData: json })).signature;
  };
  const sendTransaction = async (tx: { to: Address; data?: Hex; value?: bigint }): Promise<Hash> => {
    if (session?.mode === 'privy') return (await waitForBridge()).sendSponsored({ to: tx.to, data: tx.data, value: tx.value });
    const r = await post<{ hash: Hash }>('/api/privy/mock/send', {
      ...(await auth()), tx: { to: tx.to, data: tx.data ?? '0x', value: String(tx.value ?? 0n) },
    });
    return r.hash;
  };
  return { chain: CHAIN, signMessage, signTypedData, sendTransaction } as unknown as WalletClient;
}

// ──────────────────────────────────────────────────────────────── the session signer

export interface Consent {
  expiresAt: number;
  policy: string;
}

let consent: Consent | null = null;
export const privyConsent = (): Consent | null =>
  (consent && consent.expiresAt * 1000 > Date.now() ? consent : null);

/**
 * Add the relay as a signer on this wallet, limited by the match policy.
 * Real mode: Privy's `addSigners` (the player approves it in Privy's UI), then
 * the relay records the consent. Mock mode: the relay records it directly.
 */
export async function grantSessionSigner(): Promise<Consent> {
  if (!session) throw new Error('not signed in with Privy');
  const c = await privyConfig();
  if (!c) throw new Error('the relay is unreachable');
  if (session.mode === 'privy') {
    if (!c.signerId || !c.policyId) throw new Error('the relay has no Privy signer configured');
    await (await waitForBridge()).addSigners(session.address, c.signerId, [c.policyId]);
  }
  const r = await post<{ expiresAt: number; policy: string }>('/api/privy/signers', await auth());
  consent = { expiresAt: r.expiresAt, policy: r.policy };
  return consent;
}

export async function revokeSessionSigner(): Promise<void> {
  if (!session) return;
  if (session.mode === 'privy') await (await waitForBridge()).removeSigners(session.address).catch(() => {});
  await post('/api/privy/signers', await auth(), 'DELETE').catch(() => {});
  consent = null;
}

/**
 * A wallet that sends *in-match* calls through the session signer: the relay
 * checks them against the policy and sends them as the player, sponsored.
 * Used in place of a per-match session key for Privy players.
 */
export function privyActorWallet(): WalletClient {
  const sendTransaction = async (tx: { to: Address; data: Hex }): Promise<Hash> => {
    const r = await post<{ hash: Hash }>('/api/privy/act', { ...(await auth()), tx: { to: tx.to, data: tx.data } });
    return r.hash;
  };
  return { chain: CHAIN, sendTransaction } as unknown as WalletClient;
}
