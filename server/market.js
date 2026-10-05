/**
 * Market data for the roster — what each fighter's asset is trading at.
 *
 * Sourced server-side so the browser is not blocked by CORS and upstreams see
 * one cached call rather than one per player.
 *
 *  - **Crypto and memecoins** from CoinGecko's keyless `simple/price`, cached
 *    for sixty seconds. A failed refresh serves the last good answer rather
 *    than nothing: the game must stay playable when an upstream flakes.
 *  - **Stocks** from Pyth through `pyth.js`, when a Pyth key is configured.
 *    Without one they are simply absent, and so is any 24-hour change Pyth
 *    does not publish.
 *
 * Nothing here is ever estimated. A coin with no price from either source is
 * left out of the list rather than shown at a number nobody quoted.
 */
import { formatUnits } from 'viem';
import { roster } from './chain.js';
import { fetchPythUpdate, pythConfigured } from './pyth.js';

const TTL_MS = 60_000;
/**
 * How soon to try again after a refresh that got nothing. CoinGecko's keyless
 * tier answers 429 under load, and retrying on every request while it does is
 * how a rate limit becomes a ban.
 */
const RETRY_MS = 15_000;
const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price';
/** Optional. The keyless tier works; a free demo key just rate-limits less. */
const CG_KEY = process.env.COINGECKO_API_KEY || '';

let good = { at: 0, coins: [] };
let lastAttempt = 0;
let inflight = null;

/** Pyth's integer price and exponent as a plain USD number. */
function pythUsd(price, expo) {
  const p = BigInt(price);
  return expo < 0 ? Number(formatUnits(p, -expo)) : Number(p * 10n ** BigInt(expo));
}

async function fromCoinGecko() {
  const listed = roster.filter((c) => c.coingeckoId);
  const ids = [...new Set(listed.map((c) => c.coingeckoId))].join(',');
  const res = await fetch(`${COINGECKO}?ids=${ids}&vs_currencies=usd&include_24hr_change=true`, {
    headers: { accept: 'application/json', ...(CG_KEY ? { 'x-cg-demo-api-key': CG_KEY } : {}) },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`coingecko answered ${res.status}`);
  const body = await res.json();
  const out = [];
  for (const c of listed) {
    const q = body?.[c.coingeckoId];
    const priceUsd = Number(q?.usd);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;
    const change = Number(q?.usd_24h_change);
    out.push({
      coinId: c.coinId,
      ticker: c.ticker,
      priceUsd,
      change24h: Number.isFinite(change) ? change : null,
    });
  }
  return out;
}

/** Stock rows from Pyth, or null when there is no key and so no source at all. */
async function fromPyth() {
  if (!pythConfigured()) return null;
  const stocks = roster.filter((c) => c.kind === 'stock');
  if (!stocks.length) return [];
  const { prices } = await fetchPythUpdate(stocks.map((c) => c.coinId));
  const byId = new Map(stocks.map((c) => [c.coinId, c]));
  return prices.map((p) => ({
    coinId: p.coinId,
    ticker: byId.get(p.coinId).ticker,
    priceUsd: pythUsd(p.price, p.expo),
    // Pyth's latest-price endpoint has no 24-hour change, and a stock's last
    // print may be a weekend old. Unknown is the honest value.
    change24h: null,
    publishTime: p.publishTime,
  }));
}

/**
 * Refreshes both sources independently: CoinGecko being down must not take the
 * stocks with it, or the reverse. Each half falls back to its own last good
 * rows.
 */
async function refresh() {
  lastAttempt = Date.now();
  const [cg, py] = await Promise.allSettled([fromCoinGecko(), fromPyth()]);
  const prior = new Map(good.coins.map((c) => [c.coinId, c]));
  const keep = (kindTest) => [...prior.values()].filter((c) => kindTest(roster.find((r) => r.coinId === c.coinId)));
  const pythOk = py.status === 'fulfilled' && py.value !== null;
  const crypto = cg.status === 'fulfilled' ? cg.value : keep((r) => r?.kind !== 'stock');
  const stocks = pythOk ? py.value : (py.status === 'fulfilled' ? [] : keep((r) => r?.kind === 'stock'));
  const coins = [...crypto, ...stocks].sort((a, b) => a.coinId - b.coinId);
  // Only a source that actually answered makes the list "fresh".
  if (cg.status === 'fulfilled' || pythOk) good = { at: Date.now(), coins };
  else if (cg.status === 'rejected') console.warn(`coins: refresh failed — ${String(cg.reason?.message ?? cg.reason).slice(0, 80)}`);
}

export function registerMarketRoutes(app) {
  app.get('/api/coins', async (_req, res) => {
    let age = Date.now() - good.at;
    const due = age >= TTL_MS || !good.coins.length;
    if (due && Date.now() - lastAttempt >= RETRY_MS) {
      inflight ??= refresh().finally(() => { inflight = null; });
      await inflight.catch(() => null);
      age = Date.now() - good.at;
    }
    // The age rides in a header so the body stays the plain list the client
    // renders. A large age means upstream has been failing and these are the
    // last prices anyone actually quoted.
    res.set('x-data-age-seconds', String(good.at ? Math.round(age / 1000) : -1));
    res.json(good.coins);
  });
}
