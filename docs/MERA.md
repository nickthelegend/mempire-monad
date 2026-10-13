# How Mempire uses Mera: a passkey is the whole account

*Mempire · Monad Metropolis, Track 03 · live at https://mempire-monad.vercel.app*

Mempire is a real-time 1v1 card battler on Monad.
- Every fighter is a real asset, and the market buffs or nerfs it daily.
- Two players stake and play.
- Every card they drop is a Monad transaction.

Our players are crypto-native but casual. They will tap a passkey prompt, and they won't install an extension or write down 24 words. Mera is how we got there.

## The problem Mera solves

A staked game needs a real EOA that signs real transactions. The usual options all lose players in the first minute:
- **Seed phrases** ask too much of a casual player.
- **Browser extensions** are one more install.
- **Custodial email wallets** put a backend in custody of player keys.

We wanted **one biometric prompt**, nothing secret stored anywhere, and the same account on every device.

## How it works

### Best UX: one prompt, a deterministic account (`app/src/lib/passkey.ts`)

"Create with passkey" runs one WebAuthn ceremony through Mera, with a PRF extension salt for our account namespace. The authenticator returns 32 bytes that depend only on (credential, domain, salt). Those bytes become the account:

```ts
import { createPasskeyWithPrfOutput, createSecp256k1SigningSession, getPasskeyPrfOutput } from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';

function deriveSession(prfOutput: Uint8Array): Secp256k1SigningSession {
  const mnemonic = entropyToMnemonic(prfOutput, wordlist);      // a phrase the player never sees
  const seed = mnemonicToSeedSync(mnemonic);
  const node = HDKey.fromMasterSeed(seed).derive(DERIVATION_PATH); // m/44'/60'/0'/0/0
  const privateKey = new Uint8Array(node.privateKey!);
  try {
    return createSecp256k1SigningSession({ privateKey });       // Mera holds the key from here
  } finally {
    privateKey.fill(0); seed.fill(0); node.wipePrivateData();  // every intermediate is zeroed
  }
}
```

- The Mera signing session is the only holder of the key, and `toViemAccount` turns it into a viem account for every Monad transaction.
- Only the credential id and the address are kept, as a hint. Clearing them loses nothing: signing in falls back to a discoverable prompt, and the same key comes back.

**After the prompt, no more popups.**
- On first sign-in our relayer mints an 8-card starter deck, sends test AUSD and drips gas.
- When a staked match starts, the stake transaction funds a per-match session key. That key signs every card play, so the battle runs without wallet prompts. Its unspent gas is swept back to the player afterwards.

### Many Keys: a second, unrelated key from the same passkey (`app/src/lib/locker.ts`)

The **passkey locker** on the Deck screen uses a **different PRF salt** (`mempire.locker.v1`), so it gets 32 bytes unrelated to the account key. HKDF splits them into two keys with different `info` labels:

```ts
base = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey', 'deriveBits']);
// storage id:  HKDF-SHA-256(info = 'mempire/locker/id')
// cipher key:  HKDF-SHA-256(info = 'mempire/locker/aes-256-gcm') → AES-256-GCM
```

A player can encrypt a deck and reopen it with the same passkey on any device. The storage id is unlinkable to the account, and nothing but ciphertext is stored.

### Passkeys checked by Monad itself (`contracts/src/PasskeyRegistry.sol`)

Monad has the P-256 verification precompile at `0x0100`. `PasskeyRegistry` binds a passkey to an account and verifies WebAuthn assertions with `P256.verifyNative`. In the app, **Empire → Verify a passkey on Monad** has a passkey sign a fresh challenge, and Monad's precompile checks it by `eth_call`. A tampered copy is shown being refused.

Measured cost: **12,773 gas through `0x0100`, against 353,980 for a Solidity P-256 verifier** (about 28× cheaper). Tested under the Osaka EVM profile.

**In production** the only sign-in options are Mera passkeys and a labelled "Play as Guest" fallback (a browser-held key for devices without passkey PRF). Privy, email and browser-extension wallets are off in the hosted build.

## Engineering notes

- PRF output, seed and private key are zeroed as soon as they've been used. The session's `end()` zeroes it too.
- The account and the locker use different salts, so compromising one derived key reveals nothing about the other.
- A browser without PRF gets a clear fallback ("Play as Guest"), never a silent downgrade.
- The P256 check in the app uses a dedicated P-256 passkey, because Mera's sign-in key isn't exposed as a public key. The UI says so.

## The value it brought

- **Onboarding in about 10 seconds.** One biometric prompt gives a funded account with a deck on chain. This is the first-five-minutes problem Mempire exists to solve.
- **No custody and no recovery desk.** There's no seed phrase to lose and no backend holding keys. The same passkey restores the same account wherever it syncs.
- **No popups during play.** Mera for the account plus a session key for the match is what makes "every card is a transaction" feel like a game.

## Live proof (Monad testnet)

- **A passkey account created in the demo recording:** [`0x6A41c085c9B0FCE41bAda0B9e31d8e0Af14a55C4`](https://testnet.monadvision.com/address/0x6A41c085c9B0FCE41bAda0B9e31d8e0Af14a55C4).
  - It holds 9 cards: 8 starters plus 1 Pyth-priced mint signed by the passkey-derived key.
  - It sent 2 transactions (the mint and its staked match).
- **PasskeyRegistry:** [`0x91e9E6d880FbB31D7f000DcB9e30B222E298BDDd`](https://testnet.monadvision.com/address/0x91e9E6d880FbB31D7f000DcB9e30B222E298BDDd), verified on Sourcify.
- **Demo video:** `docs/demo/mempire-demo.mp4` (passkey sign-up right after the opening shot; the P256 check in the Empire segment).

**Honest limits:**
- The recording uses a WebAuthn virtual authenticator, the CDP one Chrome provides for automation. A real device prompt is the same Mera code path.
- The in-app P256 check is a read-only `eth_call`; binding through `PasskeyRegistry` has no live transaction yet.
