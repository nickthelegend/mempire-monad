import nacl from 'tweetnacl';
import bs58 from 'bs58';

/**
 * Proving who you are to the API.
 *
 * The server used to identify a caller by the wallet address in the URL — an
 * address it publishes itself through the ladder and the clan pages. So anyone
 * could read a rival's address off a public endpoint and write to their record.
 * It now demands an ed25519 signature over a timestamped, per-action message,
 * and this is the client half of that.
 *
 * # Guests can sign too
 *
 * Guest mode existed so the whole game is playable without a wallet
 * extension, and its address used to be forty random base58 characters — a
 * string that looks like a pubkey and is not one. Nothing could sign for it,
 * so once the server demanded signatures a guest would have been locked out of
 * every write: no ladder, no clan, no saved progress.
 *
 * A guest now gets a real ed25519 keypair, generated in the browser and kept
 * in localStorage, and their address is its actual public key. That makes
 * guest identity exactly as provable as wallet identity — the difference is
 * only where the key lives and that this one holds no funds.
 *
 * The secret key is stored unencrypted. That is fine for precisely what it
 * guards: a devnet ladder position and a clan tag. It must never be used for
 * anything that holds value, and it is generated fresh rather than derived
 * from anything the player might reuse elsewhere.
 */

const GUEST_SK = 'mempire_guest_sk';

/** The bytes the server will verify. Must match `authMessage` in server/auth.js. */
export function authMessage(address: string, action: string, ts: number): string {
  return `Mempire\naction: ${action}\nwallet: ${address}\nts: ${ts}`;
}

/**
 * The stored guest keypair, or null. Never creates one.
 *
 * Everything that merely *reads* must use this. `getProvider(null)` builds a
 * guest signing wallet so a guest can sign without an extension, and the chain
 * registry read runs for every visitor whether or not they have connected — so
 * a creating lookup on that path minted and persisted an ed25519 secret key
 * for anyone who so much as opened the page, before they had chosen anything.
 * Generating a wallet for a passer-by is not a thing to do quietly.
 */
function storedGuestKeypair(): nacl.SignKeyPair | null {
  try {
    const saved = localStorage.getItem(GUEST_SK);
    if (saved) return nacl.sign.keyPair.fromSecretKey(bs58.decode(saved));
  } catch { /* private mode, or a corrupt entry */ }
  return null;
}

/**
 * The guest's keypair, created on first use and reused thereafter.
 *
 * Creation is a side effect, so this is called only where establishing an
 * identity is the point — `connectGuest`, and signing an action as a guest who
 * already chose to be one.
 */
function guestKeypair(): nacl.SignKeyPair {
  const saved = storedGuestKeypair();
  if (saved) return saved;
  const kp = nacl.sign.keyPair();
  try { localStorage.setItem(GUEST_SK, bs58.encode(kp.secretKey)); } catch { /* ignore */ }
  return kp;
}

/** The guest's address: the real base58 public key of the keypair above. */
export function guestAddress(): string {
  return bs58.encode(guestKeypair().publicKey);
}

export interface Signed {
  address: string;
  ts: number;
  signature: string;
}

/**
 * Signs `action` as `address`.
 *
 * `walletSign` is the connected adapter's `signMessage` when there is one.
 * Returns null when this identity cannot sign — a connected wallet that does
 * not support message signing, or a rejected prompt. Callers must treat null
 * as "do not send", not as "send unsigned": an unsigned write is a 401, and a
 * silent 401 looks to a player like the game forgot their progress.
 */
export async function signAction(
  address: string,
  action: string,
  walletSign?: (msg: Uint8Array) => Promise<Uint8Array>,
): Promise<Signed | null> {
  const ts = Date.now();
  try {
    if (walletSign) {
      const bytes = new TextEncoder().encode(authMessage(address, action, ts));
      return { address, ts, signature: bs58.encode(await walletSign(bytes)) };
    }

    /*
     * A guest signs as whoever the stored key actually is.
     *
     * The caller passes `wallet.address`, which was read once at connect time,
     * and the key in localStorage can move underneath it — a cleared store, a
     * private-mode failure, or a second tab that regenerated one. When they
     * diverge, this signed as the new key while claiming the old address, and
     * the server correctly refused every signature. Every guest write failed
     * at once — clans, ladder, progress sync, telemetry — and the only symptom
     * was a 401 nothing surfaced. Observed live: the stored key derived to
     * `3nHXcCdD…` while the app was still calling itself `2cmeus9p…`.
     *
     * Deriving the address here means the two can never disagree: whatever
     * signs is what the message names.
     */
    const kp = guestKeypair();
    const signer = bs58.encode(kp.publicKey);
    const bytes = new TextEncoder().encode(authMessage(signer, action, ts));
    return { address: signer, ts, signature: bs58.encode(nacl.sign.detached(bytes, kp.secretKey)) };
  } catch {
    return null;
  }
}

/**
 * The guest keypair as a Solana transaction signer.
 *
 * # Why this exists
 *
 * A guest already holds a real ed25519 keypair with a real public key — the
 * only thing separating it from a wallet was that nothing let it sign a
 * *transaction*, only a message. So guest mode could read the chain, hold a
 * ladder position and join a clan, but the moment a match wanted to escrow a
 * stake it fell back to "playing for rating only". The address was real, the
 * funds could be real, and the game refused anyway.
 *
 * Wiring it up means someone can open the site, get a fundable address, and
 * play a genuinely on-chain staked match without installing anything.
 *
 * # Why it is devnet-only
 *
 * The secret key sits unencrypted in localStorage. That is an acceptable place
 * to keep a devnet key guarding play funds and a ladder row. It is not an
 * acceptable place to keep anything holding real value: any script on the page
 * can read it, it does not survive a cleared browser, and there is no recovery
 * phrase. So this returns null off devnet, and the UI routes those players to
 * a real wallet instead of quietly giving them a worse one.
 */
export function guestSolanaSigner(cluster: string): {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
} | null {
  if (cluster !== 'devnet') return null;
  // Read-only: this is reached from provider construction, which happens on
  // every page load whether or not anyone has connected.
  const kp = storedGuestKeypair();
  return kp ? { publicKey: kp.publicKey, secretKey: kp.secretKey } : null;
}

/** Wipe the guest key. The only way to abandon a browser-held identity. */
export function clearGuestIdentity(): void {
  try { localStorage.removeItem(GUEST_SK); } catch { /* nothing to clear */ }
  markGuestActive(false);
}

/**
 * Whether this browser is mid-session as a guest.
 *
 * Separate from the key itself, and deliberately so: `guestKeypair` *creates* a
 * key when it finds none, so any "do we have a guest?" check written against
 * the key would mint an identity for a first-time visitor and skip the connect
 * screen entirely. This flag only ever says yes to someone who already chose
 * Play as Guest — which is what lets a reload put them back where they were
 * instead of dropping them on Connect Wallet with a live keypair in storage.
 */
const GUEST_ON = 'mempire_guest_on';

export function markGuestActive(on: boolean): void {
  try {
    if (on) localStorage.setItem(GUEST_ON, '1');
    else localStorage.removeItem(GUEST_ON);
  } catch { /* private mode — the session simply will not survive a reload */ }
}

export function guestWasActive(): boolean {
  try { return localStorage.getItem(GUEST_ON) === '1'; } catch { return false; }
}
