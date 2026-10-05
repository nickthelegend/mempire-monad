/**
 * Mempire persistence API.
 *
 * The browser cannot talk to Atlas directly, so player state lives behind this
 * thin service. One document per wallet address; the client owns game logic and
 * this only stores the result, so a compromised client can't do anything it
 * couldn't already do locally. Real balances move onchain, never here.
 */
import cors from 'cors';
import express from 'express';
import { requireWallet, setReplayStore, setWalletLimiter } from './auth.js';
import { verifySettledMatch } from './chain-verify.js';
import { registerBagsRoutes, bagsConfigured } from './bags.js';
import { MongoClient } from 'mongodb';
import { readFileSync } from 'node:fs';
import { registerClanRoutes } from './clans.js';
import { registerFaucetRoutes } from './faucet.js';
import { registerPlayerRoutes } from './player.js';
import { recordEvent, registerTelemetryRoutes } from './telemetry.js';
import { registerTvlRoutes } from './tvl.js';
import { registerInsightRoutes } from './insights.js';
import { errorRecorder, rateLimiter, registerOpsRoutes, walletLimiter } from './ops.js';
import { applyMatch, leagueFor } from './ranking.js';
import { registerMatchmaker } from './matchmaker.js';

const { MONGODB_URI, MONGODB_DB = 'mempire', PORT = 8787 } = process.env;
if (!MONGODB_URI) {
  console.error('MONGODB_URI missing — copy server/.env.example to server/.env');
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
let players;
let leaderboard;
let ladder;
// Pairings the matchmaker witnessed — what a ladder report has to cite.
let pairings;
/**
 * The database handle, at module scope.
 *
 * Routes defined above the startup block still need it — `recordEvent` takes a
 * `db`, and the player save is registered long before `client.connect()`
 * resolves. Assigned once at startup; every route that uses it only runs after
 * the server is listening, which is after that assignment.
 */
let db;

const app = express();
// Heroku terminates TLS at its router, so without this req.ip is the router
// for every client — one shared limiter bucket, and one noisy player 429s the
// whole playerbase. One hop only: trusting the whole chain would make the key
// a spoofable X-Forwarded-For.
app.set('trust proxy', 1);
// Locked to the deployed app's origin in production; open in development.
app.use(cors(process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN.split(',') } : undefined));
app.use(express.json({ limit: '256kb' }));

/*
 * A body this service could not parse is the caller's mistake, not a fault.
 *
 * `express.json` throws a SyntaxError on malformed input, and with no handler
 * for it that surfaced as a 500 — which tells the caller to retry, tells the
 * operator something is broken, and puts noise in the error recorder for what
 * is really just a bad request. Payloads over the limit get the same treatment
 * for the same reason.
 */
app.use((err, _req, res, next) => {
  if (!err) return next();
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'body too large' });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'malformed JSON body' });
  }
  return next(err);
});

/*
 * Rate limiting lives in `ops.js` and is installed at startup, because it needs
 * the database.
 *
 * It used to be a token bucket in a local Map. That is correct for exactly one
 * instance: every replica keeps its own counter, so a limit of 80 becomes 80 ×
 * replicas, and scaling out to absorb abuse loosens the limit in proportion to
 * the abuse. A rolling deploy also reset every bucket.
 *
 * The delegating shim is here rather than the limiter itself because order
 * matters: every route below is registered at module load, and middleware added
 * later would sit behind all of them and never run. This holds the slot.
 */
let credits = null;
let limit = null;
let bagsLimit = null;
/*
 * A bucket for the public GETs that are not free to serve.
 *
 * Most reads here are a Mongo lookup and the shared limiter rightly waves them
 * through. Two are not: the faucet status endpoint and the TVL dashboard both
 * spend the relay's RPC quota, and that is the same quota `chain-verify` needs
 * to establish who was paid what. Leaving them on the read exemption meant an
 * anonymous loop against a status endpoint could throttle our egress IP and
 * take money verification down with it.
 */
let readLimit = null;
app.use((req, res, next) => (limit ? limit(req, res, next) : next()));

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // base58, Solana pubkey shape
const badAddress = (a) => !a || !ADDRESS.test(a);

app.get('/api/health', async (_req, res) => {
  try {
    await client.db(MONGODB_DB).command({ ping: 1 });
    res.json({ ok: true, db: MONGODB_DB });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

/** Full saved state for a wallet, or null if this is their first visit. */
app.get('/api/player/:address', async (req, res) => {
  const { address } = req.params;
  if (badAddress(address)) return res.status(400).json({ error: 'bad address' });
  try {
    const doc = await players.findOne({ _id: address }, { projection: { _id: 0 } });
    res.json(doc ?? null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Upsert the whole saved slice. Client sends it debounced after changes.
 *
 * Values are clamped, not trusted: this API stores game state for a client
 * that already owns the simulation, so nothing here is authoritative — but a
 * hostile PUT must not be able to poison a document with Infinity, negative
 * gems, or a megabyte of "chests" that every later load chokes on.
 */
const num = (v, lo, hi, fallback = 0) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, lo), hi);
};

app.put('/api/player/:address', requireWallet('player.put'), async (req, res) => {
  const { address } = req.params;
  if (badAddress(address)) return res.status(400).json({ error: 'bad address' });
  const {
    cards, deck, tier, sol, history, nextId,
    slots, slot, gems, chests, nextChestId, gemsSpent, solSpentOnGems, shop,
  } = req.body ?? {};
  if (!Array.isArray(cards) || !Array.isArray(deck)) {
    return res.status(400).json({ error: 'cards and deck are required arrays' });
  }
  if (cards.length > 500 || deck.length > 8) {
    return res.status(400).json({ error: 'payload out of range' });
  }
  try {
    const now = new Date();
    await players.updateOne(
      { _id: address },
      {
        $set: {
          cards,
          deck,
          tier: num(tier, 0, 3),
          sol: num(sol, 0, 1_000_000),
          nextId: num(nextId, 1, 1_000_000, 1),
          history: Array.isArray(history) ? history.slice(0, 50) : [],
          slots: Array.isArray(slots) ? slots.slice(0, 3).map((s) => (Array.isArray(s) ? s.slice(0, 8) : [])) : [],
          slot: num(slot, 0, 2),
          gems: num(gems, 0, 10_000_000),
          chests: Array.isArray(chests) ? chests.slice(0, 4) : [],
          nextChestId: num(nextChestId, 1, 10_000_000, 1),
          gemsSpent: num(gemsSpent, 0, 100_000_000),
          solSpentOnGems: num(solSpentOnGems, 0, 1_000_000),
          shop: shop && typeof shop === 'object'
            ? {
              offers: Array.isArray(shop.offers) ? shop.offers.slice(0, 8) : [],
              day: num(shop.day, 0, 1_000_000),
              rerollsUsed: num(shop.rerollsUsed, 0, 1_000),
            }
            : null,
          updatedAt: now,
          // The analytics window counts distinct wallets by these two fields,
          // and this route — the one the client actually calls — never wrote
          // them. So the dashboard reported 27 players, 0 new and 0 active,
          // which is a chart that looks broken because it was reading a column
          // nothing filled in.
          lastSeenAt: now,
        },
        $setOnInsert: { createdAt: now, firstSeenAt: now },
      },
      { upsert: true },
    );

    recordEvent(db, { type: 'player.save', address });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Append one settled match and bump the player's standing. */
app.post('/api/match/:address', requireWallet('match.post'), async (req, res) => {
  const { address } = req.params;
  if (badAddress(address)) return res.status(400).json({ error: 'bad address' });
  const {
    won, draw, potSol, payoutSol, rakeSol, crowns, escrowed, voided, hashes, matchId,
  } = req.body ?? {};
  try {
    const now = new Date();

    /*
     * Money facts come from the chain or they do not count.
     *
     * The signature on this request proves who sent it, not that the match
     * it describes happened — `escrowed: true, payoutSol: 999` was accepted
     * at face value and ranked on the public board. Now an escrowed claim
     * must name its on-chain match, and the pot, the winner, and the net
     * movement are read from the settled account itself; a claim the chain
     * does not support ranks as zero. W/L and crowns still record either
     * way — rating is the relay's to keep, money is not.
     */
    let verified = null;
    /*
     * One match id, one spelling.
     *
     * The idempotency key below was built from the raw body value while
     * `verifySettledMatch` canonicalised it with `Number(matchId)`. Those two
     * disagree on everything JavaScript is happy to coerce: `90`, `"90"`,
     * `" 90"`, `"90.0"`, `"9e1"` and `"0x5a"` are six different `_id` strings
     * naming one settled match, so the "counted once" guard could be walked
     * straight past six times — and the same pot credited six times — by a
     * caller who only had to retype its own match id. Canonicalise once, here,
     * and let both the claim and the chain read use that single value.
     */
    const mid = Number(matchId);
    const validId = Number.isSafeInteger(mid) && mid >= 0;
    if (escrowed && validId) {
      /*
       * Claim this match for this player before crediting anything. A unique
       * `_id` makes the second attempt a duplicate-key error rather than a
       * second `$inc`, and doing it first means a crash between the claim and
       * the credit loses a record rather than double-counting one.
       *
       * But the claim and the *money* are two different debts, and collapsing
       * them cost honest winners their pot on the board. A client reports the
       * moment its match ends, which is before settlement has landed on chain
       * — `settle_from_log` is a separate transaction, sent after both seats
       * agree. So `verifySettledMatch` routinely finds nothing, `netSol` goes
       * in as zero, and the slot is spent: every later attempt is a duplicate
       * and the money is never credited at all. The one column that is
       * chain-verified was the one column guaranteed to be wrong.
       *
       * So the row records that W/L was counted, and separately whether the
       * money was. A repeat post is still refused a second W/L — but if the
       * money is still owed, it is allowed to settle that and nothing else.
       */
      const creditId = `${mid}:${address}`;
      try {
        await credits.insertOne({ _id: creditId, at: new Date(), moneyCredited: false });
      } catch (e) {
        if (e?.code !== 11000) throw e;
        const prior = await credits.findOne({ _id: creditId });
        if (prior?.moneyCredited) {
          return res.json({ ok: true, duplicate: true, note: 'already recorded' });
        }
        const late = await verifySettledMatch(mid, address).catch(() => null);
        if (!late) {
          return res.json({
            ok: true, duplicate: true, pending: true,
            note: 'counted; the chain has not shown this settlement yet',
          });
        }
        await credits.updateOne(
          { _id: creditId },
          { $set: { moneyCredited: true, creditedAt: new Date() } },
        );
        await leaderboard.updateOne({ _id: address }, { $inc: { netSol: late.netSol } });
        return res.json({ ok: true, duplicate: true, credited: late.netSol });
      }
      verified = await verifySettledMatch(mid, address).catch(() => null);
      if (verified) {
        await credits.updateOne({ _id: creditId }, { $set: { moneyCredited: true } });
      }
    }
    const chainNetSol = verified ? verified.netSol : 0;
    await leaderboard.updateOne(
      { _id: address },
      {
        $inc: {
          matches: 1,
          wins: won ? 1 : 0,
          losses: !won && !draw ? 1 : 0,
          draws: draw ? 1 : 0,
          // Only when lamports actually moved. `potSol` is what the tier says a
          // pot is worth and is present whether or not escrow opened, so
          // counting it unconditionally made this column a running total of
          // money that never existed — a guest's unstaked wins included.
          netSol: chainNetSol,
          /*
           * Bounded, because three towers is all there are.
           *
           * A side has two princess towers and a king, so a match can yield at
           * most three crowns. The clan route already clamps this exact value
           * to 0..3; this one took it straight from the body, so the same
           * number was bounded in one place and unbounded in the other and a
           * client could report `crowns: [999999]` to inflate its column on the
           * public board. Money on that board is chain-verified — this is the
           * one column that was not.
           */
          crowns: Array.isArray(crowns) ? num(crowns[0], 0, 3) : 0,
        },
        $set: { updatedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
    await players.updateOne(
      { _id: address },
      {
        $push: {
          history: {
            $each: [{ won: !!won, draw: !!draw, potSol, payoutSol, rakeSol, crowns, at: now }],
            $position: 0,
            $slice: 50,
          },
        },
      },
    );
    // The funnel's fourth step. Emitted here rather than from the client
    // because this route is the moment a match becomes a record — a browser
    // that closes on the result screen would otherwise never report having
    // played, and "played a match" would read zero while the leaderboard filled
    // up behind it.
    recordEvent(db, {
      type: 'match.end',
      address,
      /**
       * Enough to answer the operational questions without a second query.
       *
       * `voided` is the one that matters most: a lockstep game that silently
       * annuls matches is failing in the way its players will notice first, and
       * a rate nobody is watching is a rate nobody fixes. `hashes` is the
       * checkpoint count, which stands in for how long the match ran.
       */
      props: {
        won: !!won,
        draw: !!draw,
        staked: !!escrowed,
        voided: !!voided,
        potSol: Number(potSol) || 0,
        rakeSol: Number(rakeSol) || 0,
        hashes: Number(hashes) || 0,
      },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Live meme coin feed ──────────────────────────────────────────────────────
// Sourced server-side so the browser is not blocked by CORS and upstreams see
// one cached call rather than one per player. Anything that fails to parse is
// skipped rather than failing the whole list.

const COIN_TTL_MS = 60_000;
const MIN_LIQUIDITY_USD = 25_000;
const MIN_AGE_HOURS = 48;
let coinCache = { at: 0, coins: [] };

const HUE_STEPS = [38, 320, 265, 205, 130, 52, 12, 350, 88, 228, 190, 28, 165, 300, 15];

/**
 * The Solana meme coins worth building a game economy on: deep liquidity, real
 * culture, recognisable art. Addresses ending in `pump` are pump.fun natives.
 * Searching by keyword returned only the PUMP token itself, so the roster is
 * explicit and enriched live.
 */
const MEME_MINTS = [
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF
  '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', // POPCAT
  '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump', // PNUT
  'A8C3xuqscfmyLrte3VmTqrAq8kgMASius9AFNANwpump', // FWOG
  'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump', // GOAT
  'Df6yfrKC8kZE3KNkrHERKzAetSxbrWeniQfyJY4Jpump', // CHILLGUY
  'ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY', // MOODENG
  'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC', // ai16z
  '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', // TRUMP
  'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5', // MEW
  'CATSrLdvUWzxXcnKzEVy9M5vBvfSHXDaAysu9DnEpump', // CATS
];

/** Enrich the roster with live DexScreener market data. */
async function fetchPumpCoins() {
  const urls = [
    `https://api.dexscreener.com/latest/dex/tokens/${MEME_MINTS.join(',')}`,
  ];
  const seen = new Map();

  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) continue;
      const body = await res.json();
      const pairs = Array.isArray(body?.pairs) ? body.pairs : [];
      for (const p of pairs) {
        if (p.chainId !== 'solana') continue;
        const mint = p.baseToken?.address;
        const symbol = p.baseToken?.symbol;
        if (!mint || !symbol) continue;
        const liquidityUsd = Math.round(p.liquidity?.usd ?? 0);
        const priceUsd = Number(p.priceUsd ?? 0);
        if (!priceUsd || liquidityUsd < MIN_LIQUIDITY_USD) continue;
        const createdAt = p.pairCreatedAt ? Number(p.pairCreatedAt) : 0;
        const ageHours = createdAt ? (Date.now() - createdAt) / 3_600_000 : 9999;
        if (ageHours < MIN_AGE_HOURS) continue;
        // several pools per token — keep the deepest, it has the best data
        const prior = seen.get(mint);
        if (prior && prior.liquidityUsd >= liquidityUsd) continue;
        seen.set(mint, {
          mint,
          /*
           * Trimmed, because upstream is not.
           *
           * DexScreener returns symbols and names with trailing spaces —
           * `"PNUT "`, `"Peanut the Squirrel "` were both live in the response.
           * A ticker with a trailing space still renders fine, which is exactly
           * what makes it dangerous: every lookup keyed on ticker
           * (`coinByTicker`, art paths, metadata filenames) misses, and it
           * misses silently. Normalising at the boundary means nothing
           * downstream has to know upstream is dirty.
           */
          // some symbols already ship a leading $; the UI adds its own
          ticker: symbol.trim().replace(/^\$+/, '').trim().toUpperCase().slice(0, 10),
          name: (p.baseToken?.name || symbol).trim().slice(0, 28),
          priceUsd,
          liquidityUsd,
          ageHours: Math.round(ageHours),
          fdvUsd: Math.round(p.fdv ?? p.marketCap ?? 0),
          change24h: Number(p.priceChange?.h24 ?? 0),
          volume24h: Math.round(p.volume?.h24 ?? 0),
          imageUrl: p.info?.imageUrl ?? null,
          pumpFun: /pump$/i.test(mint) || p.dexId === 'pumpswap',
          url: p.url ?? null,
        });
      }
    } catch {
      // upstream flaked — try the next source
    }
  }

  const all = [...seen.values()];
  // pump.fun natives first, then by liquidity
  all.sort((a, b) => (Number(b.pumpFun) - Number(a.pumpFun)) || b.liquidityUsd - a.liquidityUsd);
  return all.slice(0, 40).map((c, i) => ({ ...c, hue: HUE_STEPS[i % HUE_STEPS.length] }));
}

app.get('/api/coins', async (_req, res) => {
  if (Date.now() - coinCache.at < COIN_TTL_MS && coinCache.coins.length) {
    return res.json({ coins: coinCache.coins, cached: true });
  }
  try {
    const coins = await fetchPumpCoins();
    if (coins.length) coinCache = { at: Date.now(), coins };
    res.json({ coins: coinCache.coins, cached: false });
  } catch (e) {
    // serve stale rather than nothing — the game must stay playable
    res.json({ coins: coinCache.coins, error: e.message });
  }
});

// ── Trophy ladder ───────────────────────────────────────────────────────────
// The server is the authority: it is the only party that sees both sides of a
// match. The client computes the same Elo optimistically so the result screen
// is instant, then reconciles with whatever comes back from here.

/** One player's ladder standing, plus their rank. */
app.get('/api/ladder/:address', async (req, res) => {
  const { address } = req.params;
  if (badAddress(address)) return res.status(400).json({ error: 'bad address' });
  try {
    const doc = await ladder.findOne({ _id: address });
    const trophies = doc?.trophies ?? 0;
    // Rank is derived, never stored — a stored rank is stale the moment anyone
    // else plays a match.
    const above = await ladder.countDocuments({ trophies: { $gt: trophies } });
    res.json({
      address,
      trophies,
      best: doc?.best ?? trophies,
      wins: doc?.wins ?? 0,
      losses: doc?.losses ?? 0,
      draws: doc?.draws ?? 0,
      streak: doc?.streak ?? 0,
      bestStreak: doc?.bestStreak ?? 0,
      league: leagueFor(trophies).name,
      rank: doc ? above + 1 : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Apply one ranked result. Returns the new standing. */
app.post('/api/ladder/:address', requireWallet('ladder.post'), async (req, res) => {
  const { address } = req.params;
  if (badAddress(address)) return res.status(400).json({ error: 'bad address' });
  const { outcome, pairKey } = req.body ?? {};
  if (!['win', 'loss', 'draw'].includes(outcome)) {
    return res.status(400).json({ error: 'bad outcome' });
  }
  try {
    /*
     * A rating change has to correspond to a pairing this relay made.
     *
     * The header of this file says the server "is the only party that sees
     * both sides of a match", and the client repeats it — but the ranked
     * ladder was written from a body the winner authored: `outcome` and
     * `opponentTrophies` both came from the caller, with no opponent, no match
     * reference and no idempotency. Any wallet could walk itself to rank one
     * without playing. Seeing both sides and writing none of it down is the
     * same as not seeing it.
     *
     * The matchmaker now records each pairing under a token only the two
     * sockets receive. A report cites it; the opponent's rating is read from
     * that record rather than the body; and the Elo is applied only once both
     * seats have reported and their accounts agree — the same "both must say
     * the same thing" rule settlement uses on chain. One seat cannot move its
     * own rating, and neither can two seats who disagree.
     */
    const pair = pairKey ? await pairings.findOne({ _id: String(pairKey) }) : null;
    if (!pair) {
      return res.status(409).json({ error: 'no such pairing — a rating needs a match the relay saw' });
    }
    const seat = (pair.seats ?? []).indexOf(address);
    if (seat === -1) return res.status(403).json({ error: 'you did not play in that match' });
    if (pair.reports?.[String(seat)]) {
      return res.json({ ok: true, duplicate: true, note: 'already reported' });
    }

    await pairings.updateOne({ _id: pair._id }, { $set: { [`reports.${seat}`]: outcome } });
    const mine = outcome;
    const theirs = pair.reports?.[String(1 - seat)] ?? null;
    if (!theirs) {
      // First to report. Nothing moves until the other seat agrees.
      return res.json({ ok: true, pending: true, note: 'waiting for your opponent to report' });
    }
    const agreed = (mine === 'win' && theirs === 'loss')
      || (mine === 'loss' && theirs === 'win')
      || (mine === 'draw' && theirs === 'draw');
    if (!agreed) {
      await pairings.updateOne({ _id: pair._id }, { $set: { disputed: true } });
      return res.status(409).json({ error: 'the two players reported different results — no rating change' });
    }

    /*
     * Score both seats, not just whoever spoke second.
     *
     * The agreement is what makes the result real, and it becomes true on the
     * second report — so scoring only the caller left the seat that reported
     * first with no rating at all. Their own report is the one that had to
     * wait; it should not also be the one that goes unpaid.
     */
    const now = new Date();
    const scoreSeat = async (who, theirOutcome, oppRating) => {
      const d = await ladder.findOne({ _id: who });
      const was = d?.trophies ?? 0;
      const r = applyMatch(was, num(oppRating, 0, 100_000), theirOutcome);
      const st = theirOutcome === 'win' ? (d?.streak ?? 0) + 1
        : theirOutcome === 'loss' ? 0
          : (d?.streak ?? 0);
      await ladder.updateOne(
        { _id: who },
        {
          $set: {
            trophies: r.after,
            best: Math.max(d?.best ?? 0, r.after),
            streak: st,
            bestStreak: Math.max(d?.bestStreak ?? 0, st),
            updatedAt: now,
          },
          $inc: {
            wins: theirOutcome === 'win' ? 1 : 0,
            losses: theirOutcome === 'loss' ? 1 : 0,
            draws: theirOutcome === 'draw' ? 1 : 0,
            matches: 1,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      );
      return { doc: d, ...r, streak: st };
    };

    // Both are scored against the ratings the relay recorded at pairing time,
    // so neither depends on the order the two reports happened to arrive in.
    const mineScored = await scoreSeat(address, mine, pair.trophies?.[1 - seat]);
    await scoreSeat(pair.seats[1 - seat], theirs, pair.trophies?.[seat]);
    await pairings.updateOne({ _id: pair._id }, { $set: { settled: true } });

    const { doc } = mineScored;
    const { delta, after, floored, streak } = mineScored;

    const above = await ladder.countDocuments({ trophies: { $gt: after } });
    res.json({
      trophies: after,
      delta,
      floored,
      best: Math.max(doc?.best ?? 0, after),
      wins: (doc?.wins ?? 0) + (outcome === 'win' ? 1 : 0),
      losses: (doc?.losses ?? 0) + (outcome === 'loss' ? 1 : 0),
      streak,
      league: leagueFor(after).name,
      rank: above + 1,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** The ladder itself — top players by trophies. */
app.get('/api/ladder', async (_req, res) => {
  try {
    const rows = await ladder.find({}).sort({ trophies: -1 }).limit(50).toArray();
    res.json({
      players: rows.map((r, i) => ({
        rank: i + 1,
        address: r._id,
        name: r.name ?? null,
        trophies: r.trophies ?? 0,
        best: r.best ?? 0,
        wins: r.wins ?? 0,
        losses: r.losses ?? 0,
        streak: r.streak ?? 0,
        league: leagueFor(r.trophies ?? 0).name,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Top players by net SOL — powers the Empire leaderboard. */
app.get('/api/leaderboard', async (_req, res) => {
  try {
    const rows = await leaderboard
      .find({}, { projection: { netSol: 1, wins: 1, losses: 1, crowns: 1, matches: 1 } })
      .sort({ netSol: -1 })
      .limit(25)
      .toArray();
    res.json(rows.map((r) => ({ address: r._id, ...r, _id: undefined })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/*
 * Boot, and say why if it does not.
 *
 * This is a top-level await, so anything thrown inside surfaces as a bare
 * module-evaluation rejection: a raw stack trace, exit code 1, and nothing
 * naming which of the several things this block does actually failed. The
 * `uncaughtException` handlers installed further down are no help, because a
 * top-level-await rejection is not routed through them. On Railway that is
 * five silent restarts and a dead service.
 *
 * The most likely causes are ordinary and worth naming out loud: Mongo
 * unreachable, or a data file the image did not ship.
 */
const server = await (async () => {
  await client.connect();
  db = client.db(MONGODB_DB);
  players = db.collection('players');
  leaderboard = db.collection('leaderboard');
  ladder = db.collection('ladder');
  pairings = db.collection('ladder_pairings');
  /*
   * One settled match, counted once.
   *
   * `verifySettledMatch` proves a claimed pot really happened on chain, which
   * stopped invented payouts — but it says nothing about how many times the
   * same real match has been reported. Every field below is an `$inc`, and the
   * signature on the request proves identity rather than novelty, so a client
   * could sign a hundred fresh requests all describing its one genuine win and
   * add its payout to the money board a hundred times.
   *
   * The id is per (match, player) because both seats legitimately report the
   * same match from their own side.
   */
  credits = db.collection('match_credits');
  await credits.createIndex({ at: 1 }, { expireAfterSeconds: 400 * 24 * 3600 });
  await leaderboard.createIndex({ netSol: -1 });
  // Both the ladder listing and every rank lookup sort on this.
  await ladder.createIndex({ trophies: -1 });
  registerClanRoutes(app, db);

  // The starter kit. Reads the same registry the client does, chosen by the
  // RPC the relay is pointed at — one env var decides the cluster and
  // everything derives from it. The mainnet file comes from
  // chain/build-mainnet-registry.mjs (Jupiter-verified identities); the
  // faucet itself refuses to register on a mainnet RPC regardless.
  const isMainnetRpc = /mainnet/i.test(process.env.SOLANA_RPC ?? '');
  const registryCoins = JSON.parse(
    readFileSync(new URL(isMainnetRpc ? './mainnet-coins.json' : './devnet-coins.json', import.meta.url), 'utf8'),
  ).coins;
  registerFaucetRoutes(app, db, registryCoins, (req, res, next) => (
    readLimit ? readLimit(req, res, next) : next()
  ));
  registerPlayerRoutes(app, db);
  // The $MEMPIRE market. Registers either way — the routes report
  // `configured: false` until BAGS_API_KEY and MEMPIRE_MINT are both set,
  // which is a state the swap screen already knows how to render honestly.
  /*
   * A late-binding shim, not the value.
   *
   * `limit` is still the `null` it was declared as at this point — it is
   * assigned a dozen lines below — and JavaScript passes the value, so handing
   * it over directly froze the Bags gate to its no-op fallback for the life of
   * the process. Every `/api/market/*` route ran unlimited, and the three GET
   * ones were exempt from the global limiter too, which left a paid API key
   * spendable by anonymous traffic. The routes get their own tighter bucket
   * that counts reads, because each one is an outbound call on our key.
   */
  registerBagsRoutes(app, (req, res, next) => (
    bagsLimit ? bagsLimit(req, res, next) : next()
  ));
  console.log(`bags market: ${bagsConfigured() ? 'configured' : 'not configured (no key or mint yet)'}`);
  registerTelemetryRoutes(app, db, requireWallet);
  // Value locked, read straight from chain — the one set of numbers on the
  // dashboard that no client reports and nothing here can inflate.
  registerInsightRoutes(app, db);
  registerOpsRoutes(app, db);
  registerTvlRoutes(app, {
    programId: 'BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP',
    amm: JSON.parse(readFileSync(new URL('./amm.json', import.meta.url), 'utf8')),
  }, (req, res, next) => (readLimit ? readLimit(req, res, next) : next()));

  // Now that there is a database, the shared limiter can take over from the
  // pass-through installed at module load.
  limit = rateLimiter(db);
  // Tighter, and it counts GETs: every one of these is a call on our Bags key.
  bagsLimit = rateLimiter(db, { capacity: 30, refillPerSec: 1, includeReads: true });
  // Generous — these are legitimate dashboard polls — but bounded, and reads
  // count because reads are what costs.
  readLimit = rateLimiter(db, { capacity: 60, refillPerSec: 2, includeReads: true });
  setWalletLimiter(walletLimiter(db));

  // Replay protection: one row per seen signature, expiring shortly after the
  // auth skew window closes so the collection stays tiny. The unique index is
  // the actual check — a duplicate insert throws, and that throw means replay.
  const seen = db.collection('auth_signatures');
  await seen.createIndex({ sig: 1 }, { unique: true });
  await seen.createIndex({ at: 1 }, { expireAfterSeconds: 11 * 60 });
  setReplayStore(async (signature) => {
    try {
      await seen.insertOne({ sig: String(signature), at: new Date() });
      return false;
    } catch (e) {
      if (e?.code === 11000) return true; // duplicate key = replay
      return false; // store trouble must not lock every player out
    }
  });
  // Last, deliberately: Express only routes an error to a four-argument
  // handler registered after everything that could throw.
  app.use(errorRecorder(db).middleware);

  console.log(`mongo connected → ${MONGODB_DB}`);
  const httpServer = app.listen(PORT, () => console.log(`mempire api on :${PORT}`));
  registerMatchmaker(httpServer, db);
  return httpServer;
})().catch((e) => {
  console.error(`startup failed: ${e?.message ?? e}`);
  if (String(e?.name ?? '').startsWith('Mongo')) {
    console.error('  the database was unreachable — check MONGODB_URI and the Atlas IP allowlist');
  }
  if (e?.code === 'ENOENT') {
    console.error(`  a file this build needs is not in the image: ${e.path ?? '(unknown)'}`);
  }
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close();
    await client.close();
    process.exit(0);
  });
}
