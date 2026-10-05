/**
 * A stand-in for the Bags upstream, for exercising the swap path without a key.
 *
 * NOT a mock of the client and NOT a mock of the relay — those are the things
 * under test and they run for real. This impersonates only the third party at
 * the far end, which is the one piece that cannot be reached without a paid
 * API key and a launched token. `server/bags.js` reads its base URL from
 * `BAGS_API`, so pointing that here puts a real relay and a real browser on
 * either side of a real transaction.
 *
 * The swap it returns is a genuine, signable, sendable Solana transaction — a
 * one-lamport self-transfer — so the client's deserialize → sign → send →
 * confirm path is exercised end to end rather than asserted about.
 *
 *   node bags-stub.mjs            # listens on 8899
 */
import http from 'node:http';
import {
  Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';

const conn = new Connection(process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com', 'confirmed');
// One SOL buys a million $MEMPIRE: lamports (9dp) -> base units (6dp) is ×1000.
const RATE = 1000n;
const quotes = new Map();

const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/trade/quote') {
    const amount = BigInt(url.searchParams.get('amount') ?? '0');
    const bps = BigInt(url.searchParams.get('slippageBps') ?? '50');
    const input = url.searchParams.get('inputMint');
    const wsol = 'So11111111111111111111111111111111111111112';
    // Buying $MEMPIRE with SOL multiplies; selling divides.
    const out = input === wsol ? amount * RATE : amount / RATE;
    const requestId = `stub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    quotes.set(requestId, { amount, out });
    return send(res, 200, {
      success: true,
      response: {
        inAmount: amount.toString(),
        outAmount: out.toString(),
        minOutAmount: ((out * (10_000n - bps)) / 10_000n).toString(),
        priceImpactPct: 0.42,
        slippageBps: Number(bps),
        requestId,
      },
    });
  }

  if (url.pathname === '/trade/swap' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { requestId, userPublicKey } = JSON.parse(raw || '{}');
    if (!quotes.has(requestId)) return send(res, 400, { error: 'unknown requestId' });
    const owner = new PublicKey(userPublicKey);
    const { blockhash } = await conn.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: owner,
      recentBlockhash: blockhash,
      instructions: [SystemProgram.transfer({ fromPubkey: owner, toPubkey: owner, lamports: 1 })],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    return send(res, 200, {
      success: true,
      response: { transaction: Buffer.from(tx.serialize()).toString('base64') },
    });
  }

  send(res, 404, { error: `stub has no ${url.pathname}` });
}).listen(8899, () => console.log('bags stub on :8899'));
