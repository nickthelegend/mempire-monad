#!/usr/bin/env node
/**
 * Refuse to build a bundle that would address the wrong chain or the wrong
 * token.
 *
 * The app already fails closed at runtime — `provider.ts` throws when the
 * cluster and the RPC disagree, and `amm.ts` throws when a mainnet build has
 * no mainnet mint. But a runtime throw means the broken bundle is *built*,
 * *deployed*, and then bricks on load, which is a worse way to find out than
 * a failed build. This is the same set of rules, checked before Vite starts.
 *
 * Devnet builds are unaffected: every rule below only tightens for mainnet.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const amm = JSON.parse(readFileSync(join(HERE, '..', 'src', 'lib', 'amm.json'), 'utf8'));

const env = process.env;
const cluster = env.VITE_CLUSTER ?? 'devnet';
const rpc = env.VITE_RPC_URL ?? '';
const mint = (env.VITE_MEMPIRE_MINT ?? '').trim();
const decimals = Number(env.VITE_MEMPIRE_DECIMALS ?? amm.mempireDecimals ?? 6);

const isMainnet = cluster === 'mainnet-beta' || cluster === 'mainnet';
const rpcLooksMainnet = /mainnet/i.test(rpc);
const rpcLooksDevnet = /devnet|localhost|127\.0\.0\.1/i.test(rpc);
const ammIsMainnet = String(amm.cluster ?? '').startsWith('mainnet');

const fail = [];

if (isMainnet && rpcLooksDevnet) {
  fail.push(`VITE_CLUSTER=${cluster} but VITE_RPC_URL points at devnet (${rpc})`);
}
if (!isMainnet && rpcLooksMainnet) {
  fail.push(`VITE_CLUSTER=${cluster} but VITE_RPC_URL points at mainnet (${rpc})`);
}

/*
 * The one that would actually have shipped. `amm.json` is written by the
 * pool-setup script, which never runs on mainnet now that $MEMPIRE launches on
 * Bags — so its devnet stamp is permanent, and without an explicit mint every
 * $MEMPIRE path would address the devnet token.
 */
if (isMainnet && !mint && !ammIsMainnet) {
  fail.push(
    'mainnet build with no VITE_MEMPIRE_MINT, and amm.json is stamped '
    + `"${amm.cluster}" — every $MEMPIRE path would address the devnet mint `
    + `(${amm.mempireMint})`,
  );
}

/*
 * The program's amount constants (WIN_REWARD, UPGRADE_BASE_FEE, shop prices)
 * are compiled against six decimals. A mint with different decimals does not
 * fail — it misprices every sink by a power of ten.
 */
if (decimals !== 6) {
  fail.push(
    `$MEMPIRE decimals is ${decimals}; the program's constants assume 6, so `
    + `fees and rewards would be off by 10^${Math.abs(6 - decimals)}`,
  );
}

if (fail.length) {
  console.error('\n  preflight refused this build:\n');
  for (const f of fail) console.error(`    ✗ ${f}`);
  console.error('');
  process.exit(1);
}

console.log(
  `preflight ok — cluster=${cluster}`
  + ` mint=${(mint || amm.mempireMint).slice(0, 8)}… decimals=${decimals}`,
);
