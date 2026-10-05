/**
 * The Pyth price proxy.
 *
 * Minting a card posts a fresh Pyth update in the same transaction —
 * `MempireCards.mint` takes the signed update bytes and records the price the
 * card was minted at, and an asset with no live price cannot be minted at all.
 * Those bytes come from Hermes, and Hermes has required an API key since
 * 2026-08-26. A key in the browser bundle is a key anyone can lift and spend,
 * so the browser asks this route and the key stays here.
 *
 * Responses are cached for about two seconds per set of feeds. A price update
 * is only useful while it is fresh (crypto feeds are registered with a 120 s
 * maximum age), but a burst of players opening the mint screen at once should
 * cost one upstream call, not one each.
 */
import { coinById } from './chain.js';

const HERMES = (process.env.PYTH_HERMES_URL || 'https://pyth.dourolabs.app/hermes').replace(/\/+$/, '');
const KEY = process.env.PYTH_API_KEY || '';
const TTL_MS = 2_000;
/** A mint posts one feed; a deck screen might price eight. Beyond that is a scrape. */
const MAX_FEEDS = 16;

export const pythConfigured = () => Boolean(KEY);

const cache = new Map(); // sorted coin ids → { at, body } | { at, inflight }

/** Strips the 0x Hermes omits, so feed ids compare in one spelling. */
const bare = (feedId) => feedId.toLowerCase().replace(/^0x/, '');

/**
 * Latest prices and signed update data for `coinIds`, via Hermes.
 *
 * Resolves `{ updateData: ['0x…'], prices: [{ coinId, price, expo, publishTime }] }`.
 * `price` is the raw integer Pyth publishes, as a string — a price times
 * 10^expo is the USD value, and a JS number cannot carry every int64 exactly.
 */
export async function fetchPythUpdate(coinIds) {
  if (!KEY) throw Object.assign(new Error('pyth api key not configured'), { status: 503 });
  const ids = [...new Set(coinIds)].sort((a, b) => a - b);
  const cacheKey = ids.join(',');
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.body ?? hit.inflight;

  const coins = ids.map((id) => coinById.get(id));
  const qs = coins.map((c) => `ids[]=${c.feedId}`).join('&');
  const inflight = (async () => {
    const res = await fetch(`${HERMES}/v2/updates/price/latest?${qs}&encoding=hex&parsed=true`, {
      headers: { accept: 'application/json', authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      throw Object.assign(new Error(`hermes answered ${res.status}`), { status: 502 });
    }
    const body = await res.json();
    const byFeed = new Map(coins.map((c) => [bare(c.feedId), c.coinId]));
    const prices = (body?.parsed ?? [])
      .filter((p) => byFeed.has(bare(String(p.id))))
      .map((p) => ({
        coinId: byFeed.get(bare(String(p.id))),
        price: String(p.price?.price),
        expo: Number(p.price?.expo),
        publishTime: Number(p.price?.publish_time),
      }));
    const updateData = (body?.binary?.data ?? []).map((d) => (d.startsWith('0x') ? d : `0x${d}`));
    return { updateData, prices };
  })();

  cache.set(cacheKey, { at: Date.now(), inflight });
  try {
    const out = await inflight;
    cache.set(cacheKey, { at: Date.now(), body: out });
    // Keyed by whatever combination the callers asked for, so prune rather
    // than let a stream of distinct combinations grow the map for ever.
    if (cache.size > 200) {
      for (const [k, v] of cache) if (Date.now() - v.at > TTL_MS) cache.delete(k);
    }
    return out;
  } catch (e) {
    cache.delete(cacheKey);
    throw e;
  }
}

/** Parses `?coinIds=1,2` into roster coin ids, or returns an error string. */
export function parseCoinIds(raw) {
  const parts = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return 'coinIds is required, e.g. ?coinIds=0,26';
  if (parts.length > MAX_FEEDS) return `at most ${MAX_FEEDS} coinIds per request`;
  const ids = [];
  for (const p of parts) {
    if (!/^\d{1,5}$/.test(p) || !coinById.has(Number(p))) return `unknown coinId ${p.slice(0, 8)}`;
    ids.push(Number(p));
  }
  return ids;
}

export function registerPythRoutes(app, gate) {
  const pass = (_req, _res, next) => next();
  app.get('/api/pyth/update', gate ?? pass, async (req, res) => {
    if (!KEY) return res.status(503).json({ error: 'pyth api key not configured' });
    const ids = parseCoinIds(req.query.coinIds);
    if (typeof ids === 'string') return res.status(400).json({ error: ids });
    try {
      res.set('cache-control', 'no-store');
      res.json(await fetchPythUpdate(ids));
    } catch (e) {
      res.status(e?.status ?? 502).json({ error: String(e?.message ?? e).slice(0, 160) });
    }
  });
}
