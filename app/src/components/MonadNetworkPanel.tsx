import { useEffect, useState } from 'react';
import { bytesToHex, type Hex } from 'viem';
import { MULTICALL3, p256VerifyOnMonad, readStaking, type StakingSnapshot } from '../chain/monadNetwork';
import { Pill } from './ui';

/*
 * Monad, read live — two things no other EVM chain has, shown in the app:
 *
 *  - native staking: the staking precompile (0x…1000), epoch and the block
 *    proposer's validator record, in one batched eth_call through the
 *    canonical Multicall3;
 *  - passkeys verified by the chain: a WebAuthn signature from this device's
 *    passkey checked by Monad's P256VERIFY precompile (0x…0100) with a plain
 *    eth_call — plus a tampered copy, which must be refused, so "verified"
 *    means something. Mera's sign-in passkey does not expose its public key,
 *    so this uses a dedicated P-256 passkey made for the check and says so.
 *
 * Both are read-only reads of Monad testnet: no transaction, no MON.
 */

const CHECK_KEY = 'mempire_p256_check_key';
const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** DER ECDSA signature → (r, s) as 32-byte words. */
function derToRS(der: Uint8Array): [Hex, Hex] {
  let i = 2;
  const part = () => {
    if (der[i] !== 0x02) throw new Error('not a DER signature');
    const len = der[i + 1];
    let v = der.slice(i + 2, i + 2 + len);
    i += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return bytesToHex(out);
  };
  return [part(), part()];
}

async function sha256(b: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(b)));
}

interface CheckKey { id: string; x: Hex; y: Hex }

async function ensureCheckKey(): Promise<CheckKey> {
  try {
    const saved = JSON.parse(localStorage.getItem(CHECK_KEY) ?? 'null') as CheckKey | null;
    if (saved?.id && saved.x && saved.y) return saved;
  } catch { /* make a new one */ }
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Mempire', id: location.hostname },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'mempire-p256-check', displayName: 'Mempire on-chain passkey check' },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      // ES256 (P-256) first; RS256 listed only as the browser's recommended
      // fallback — an authenticator that picks it gets a clear refusal below.
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { userVerification: 'preferred', residentKey: 'discouraged' },
      timeout: 60_000,
    },
  }) as PublicKeyCredential | null;
  const att = cred?.response as AuthenticatorAttestationResponse | undefined;
  if (att?.getPublicKeyAlgorithm && att.getPublicKeyAlgorithm() !== -7) {
    throw new Error('this authenticator made an RSA key; Monad’s P256 check needs an ES256 (P-256) passkey');
  }
  const spki = att?.getPublicKey?.();
  if (!cred || !spki) throw new Error('this browser did not return a P-256 public key');
  const raw = new Uint8Array(spki).slice(-64); // uncompressed point: 0x04 ‖ x ‖ y, at the end of the SPKI
  const key = { id: b64u(cred.rawId), x: bytesToHex(raw.slice(0, 32)), y: bytesToHex(raw.slice(32)) };
  try { localStorage.setItem(CHECK_KEY, JSON.stringify(key)); } catch { /* fine for this session */ }
  return key;
}

interface P256Result { ok: boolean; tamperedRefused: boolean; ms: number; challenge: string }

async function verifyPasskeyOnMonad(): Promise<P256Result> {
  const key = await ensureCheckKey();
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const got = await navigator.credentials.get({
    publicKey: { challenge, allowCredentials: [{ type: 'public-key', id: fromB64u(key.id) }], userVerification: 'preferred', timeout: 60_000 },
  }) as PublicKeyCredential | null;
  const res = got?.response as AuthenticatorAssertionResponse | undefined;
  if (!res) throw new Error('the passkey prompt was cancelled');
  const clientData = new Uint8Array(res.clientDataJSON);
  const parsed = JSON.parse(new TextDecoder().decode(clientData)) as { type: string; challenge: string };
  if (parsed.type !== 'webauthn.get' || parsed.challenge !== b64u(challenge)) throw new Error('the assertion is not over this challenge');
  const auth = new Uint8Array(res.authenticatorData);
  const signed = new Uint8Array([...auth, ...(await sha256(clientData))]);
  const hash = bytesToHex(await sha256(signed));
  const [r, s] = derToRS(new Uint8Array(res.signature));
  const t0 = performance.now();
  const ok = await p256VerifyOnMonad(hash, r, s, key.x, key.y);
  const ms = Math.round(performance.now() - t0);
  const flipped = `0x${(BigInt(s) ^ 1n).toString(16).padStart(64, '0')}` as Hex;
  const tamperedRefused = !(await p256VerifyOnMonad(hash, r, flipped, key.x, key.y));
  return { ok, tamperedRefused, ms, challenge: b64u(challenge).slice(0, 10) };
}

export function MonadNetworkPanel() {
  const [stk, setStk] = useState<StakingSnapshot | null>(null);
  const [stkErr, setStkErr] = useState<string | null>(null);
  const [p256, setP256] = useState<P256Result | null>(null);
  const [p256Err, setP256Err] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => readStaking()
      .then((s) => { if (live) { setStk(s); setStkErr(null); } })
      .catch((e) => { if (live) setStkErr(e instanceof Error ? e.message : String(e)); });
    void load();
    const iv = setInterval(load, 30_000);
    return () => { live = false; clearInterval(iv); };
  }, []);

  const run = async () => {
    setBusy(true); setP256Err(null);
    try { setP256(await verifyPasskeyOnMonad()); } catch (e) { setP256Err(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return (
    <section aria-label="Monad network" className="well" style={{ padding: '10px 12px', display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span className="label">Monad network</span>
        <span className="fine" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--dim)' }}>live · testnet · read-only</span>
      </div>

      <div aria-label="Native staking" style={{ display: 'grid', gap: 3 }}>
        {stk ? (
          <>
            <span style={{ fontSize: 13 }}>
              Epoch <b>{stk.epoch}</b>{stk.inDelay ? ' · in epoch delay' : ''} · block proposer: validator <b>#{stk.proposer}</b>
              {stk.proposerStake !== null && <> · {stk.proposerStake.toLocaleString('en-US')} MON staked</>}
              {stk.proposerCommission !== null && <> · {(stk.proposerCommission * 100).toFixed(0)}% commission</>}
            </span>
            <span className="fine" style={{ fontSize: 11, color: 'var(--dim)' }}>
              Staking precompile <code>0x…1000</code>, batched through Multicall3 <code>{MULTICALL3.slice(0, 6)}…{MULTICALL3.slice(-4)}</code> · block {stk.block.toLocaleString('en-US')}
            </span>
          </>
        ) : (
          <span className="fine" style={{ fontSize: 12, color: 'var(--dim)' }}>{stkErr ? `Staking read unavailable: ${stkErr}` : 'reading the staking precompile…'}</span>
        )}
      </div>

      <div aria-label="Passkey verified by Monad" style={{ display: 'grid', gap: 5, borderTop: '2px solid rgba(0,0,0,.28)', paddingTop: 8 }}>
        <span style={{ fontSize: 13 }}>
          Passkeys, checked by the chain: Monad verifies WebAuthn (P-256) signatures natively at <code>0x…0100</code>.
        </span>
        {p256 ? (
          <span className="label" style={{ fontSize: 12, color: p256.ok && p256.tamperedRefused ? 'var(--teal)' : 'var(--red)' }}>
            {p256.ok ? '✓ Your passkey signature verified by Monad’s P256 precompile' : '✗ Monad’s precompile rejected the signature'}
            {' · '}{p256.tamperedRefused ? 'a tampered copy was refused' : 'a tampered copy was NOT refused'} · {p256.ms} ms eth_call
          </span>
        ) : p256Err ? (
          <span className="fine" style={{ fontSize: 12, color: 'var(--red)' }}>{p256Err}</span>
        ) : null}
        <div>
          <Pill ghost disabled={busy} onClick={() => void run()} style={{ minHeight: 40, fontSize: 14 }}>
            {busy ? 'Waiting for the passkey…' : 'Verify a passkey on Monad'}
          </Pill>
        </div>
        <span className="fine" style={{ fontSize: 11, color: 'var(--dim)' }}>
          Uses a separate P-256 passkey made for this check (Mera&apos;s sign-in key is not exposed). On chain, PasskeyRegistry binds a passkey to an account the same way.
        </span>
      </div>
    </section>
  );
}
