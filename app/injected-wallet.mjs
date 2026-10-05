import { readFileSync } from 'node:fs';

/**
 * Install a Phantom-shaped wallet into a Playwright browser context.
 *
 * # Why this exists rather than seeding the Guest key
 *
 * `mempire_guest_sk` is a real ed25519 key and its signatures are real, but it
 * enters the app through the Guest branch — a different code path from the one
 * every actual player uses. This plants a provider on `window.phantom.solana`
 * instead, so `PhantomWalletAdapter` detects an installed wallet and the whole
 * adapter path runs: readyState detection, `connect()`, `signTransaction`,
 * `signMessage`, the disconnect listener.
 *
 * The provider is not a stub. It holds the keypair, signs with tweetnacl over
 * exactly the bytes it is handed, and every transaction it returns goes to
 * devnet. What is skipped is the extension's approval UI, which Playwright
 * cannot drive and which is not the thing under test.
 *
 * @param ctx a Playwright BrowserContext, before any page has loaded
 * @param keypair a web3.js Keypair this wallet will sign for
 */
export async function installInjectedWallet(ctx, keypair) {
  const nacl = readFileSync(
    new URL('./node_modules/tweetnacl/nacl-fast.min.js', import.meta.url),
    'utf8',
  );

  await ctx.addInitScript(({ naclSrc, sk, b58 }) => {
    // eslint-disable-next-line no-eval
    (0, eval)(naclSrc);
    const kp = window.nacl.sign.keyPair.fromSecretKey(
      Uint8Array.from(atob(sk), (c) => c.charCodeAt(0)),
    );

    /**
     * A PublicKey-shaped object, not the real class.
     *
     * web3.js lives inside the app's bundle and is unreachable from an init
     * script, so shipping a second copy into the page would mean two
     * `PublicKey` implementations disagreeing about identity. The adapter only
     * calls `toBytes`/`toBase58`/`equals` on what a provider returns.
     */
    const pk = {
      toBytes: () => kp.publicKey,
      toBuffer: () => kp.publicKey,
      toBase58: () => b58,
      toString: () => b58,
      equals: (o) => (o?.toBase58?.() ?? String(o)) === b58,
    };

    const listeners = {};
    const emit = (ev, ...a) => (listeners[ev] ?? []).forEach((f) => f(...a));

    /**
     * Sign over the serialized message, then write the transaction's own slot.
     *
     * `addSignature` is avoided deliberately: it looks the signer up by
     * `PublicKey` identity, which a duck-typed key cannot satisfy. Finding the
     * slot by base58 is the same result without depending on the class.
     */
    const sign = (tx) => {
      const legacy = typeof tx.serializeMessage === 'function';
      if (!legacy) {
        const sig = window.nacl.sign.detached(tx.message.serialize(), kp.secretKey);
        const keys = tx.message.staticAccountKeys ?? tx.message.accountKeys ?? [];
        const i = keys.findIndex((k) => k.toBase58() === b58);
        if (i >= 0) tx.signatures[i] = sig;
        return tx;
      }
      const sig = window.nacl.sign.detached(tx.serializeMessage(), kp.secretKey);
      const slot = tx.signatures.find((s) => s.publicKey?.toBase58?.() === b58);
      if (slot) slot.signature = sig;
      return tx;
    };

    const provider = {
      isPhantom: true,
      publicKey: null,
      isConnected: false,
      connect: async () => {
        provider.publicKey = pk;
        provider.isConnected = true;
        emit('connect', pk);
        return { publicKey: pk };
      },
      disconnect: async () => {
        provider.publicKey = null;
        provider.isConnected = false;
        emit('disconnect');
      },
      signTransaction: async (tx) => sign(tx),
      signAllTransactions: async (txs) => txs.map(sign),
      signMessage: async (message) => ({
        signature: window.nacl.sign.detached(message, kp.secretKey),
        publicKey: pk,
      }),
      on: (ev, fn) => { (listeners[ev] ??= []).push(fn); },
      off: (ev, fn) => { listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn); },
      removeListener: (ev, fn) => provider.off(ev, fn),
      removeAllListeners: () => { for (const k of Object.keys(listeners)) delete listeners[k]; },
    };

    window.phantom = { solana: provider };
    window.solana = provider;
    // The adapter requires this flag *as well as* `isPhantom`; without it
    // readyState never leaves NotDetected and the picker offers an install link
    // rather than a connect button.
    window.isPhantomInstalled = true;
  }, {
    naclSrc: nacl,
    sk: Buffer.from(keypair.secretKey).toString('base64'),
    b58: keypair.publicKey.toBase58(),
  });
}
