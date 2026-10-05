/**
 * A2.3 / B4 — the faucet must refuse a second claim from an address that has
 * already been paid, and must refuse an unsigned one outright.
 */
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const API = 'https://mempire-relay-production.up.railway.app';
const SK = '3wPGAXsW5jBgAwg42V5X71gFmBesVba173vmqKh8H2Ruzg6HGUdKhZtvQPtkmN9JmdYeM7EGKCc4w3r3sRy7Pkap';

const kp = nacl.sign.keyPair.fromSecretKey(bs58.decode(SK));
const address = bs58.encode(kp.publicKey);
const ts = Date.now();
const msg = `Mempire\naction: faucet\nwallet: ${address}\nts: ${ts}`;
const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey));

const signed = await fetch(`${API}/api/faucet`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ address, ts, signature }),
});
const signedBody = await signed.json().catch(() => null);
console.log(`A2.3 second claim (signed)  -> ${signed.status} ${JSON.stringify(signedBody)}`);
console.log(`  ${signed.status === 409 ? 'PASS' : 'FAIL'} — want 409 already claimed`);

const bad = await fetch(`${API}/api/faucet`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ address, ts, signature: bs58.encode(new Uint8Array(64)) }),
});
console.log(`B4 forged signature         -> ${bad.status}`);
console.log(`  ${bad.status === 401 ? 'PASS' : 'FAIL'} — want 401 unauthorised`);
