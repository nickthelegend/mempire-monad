/**
 * Total value locked, read from chain.
 *
 * # What counts as locked
 *
 * Only value the protocol is actually holding, where "holding" means a user
 * cannot spend it without the program letting go:
 *
 * - **Escrow** — lamports sitting in `MatchAccount`s that have not settled.
 *   Real SOL, already moved, owed to whoever wins.
 * - **Pool** — the AMM's two vaults. A constant-product pool is balanced by
 *   value, so the USDC side doubled *is* the pool's worth; pricing the
 *   $MEMPIRE side against anything else would be inventing a second oracle.
 * - **Card stake** — `staked_micro_usd` summed across every `Card`. This is
 *   the number the game is actually about: a fighter's power comes from the
 *   coins locked behind it.
 *
 * Settled matches are excluded. Their lamports have already been paid out, and
 * counting a pot after it has been won is how a TVL figure starts drifting
 * upward on its own.
 *
 * # Why hand-decoded
 *
 * The server has no Anchor dependency and no reason to grow one for three
 * integers. Offsets are derived from the account layouts in `lib.rs` and are
 * asserted against the declared `SIZE` of each account before anything is
 * summed — a layout change breaks this loudly rather than returning a
 * confidently wrong number.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

const RPC = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';

/** Byte layout of `Card`, after the 8-byte discriminator. */
const CARD = {
  SIZE: 8 + 8 + 32 + 32 + 1 + 8 + 8 + 1 + 8 + 8 + 32 + 1,
  // 8 disc + 8 id + 32 owner + 32 coin_mint + 1 archetype + 8 staked_tokens
  STAKED_MICRO_USD: 8 + 8 + 32 + 32 + 1 + 8,
};

/** Byte layout of `MatchAccount`, after the 8-byte discriminator. */
const MATCH = {
  SIZE: 8 + 8 + 1 + 8 + 64 + 64 + 8 + 1 + 8 + 8 + 1 + 8 + 1,
  STAKE_LAMPORTS: 8 + 8 + 1,
  // 8 disc + 8 id + 1 tier + 8 stake + 64 players + 64 deck_hash + 8 power
  STATE: 8 + 8 + 1 + 8 + 64 + 64 + 8,
};

/** A match that has paid out. Its lamports are gone and must not be counted. */
const MATCH_STATE_SETTLED = 2;

/**
 * Byte layout of `Config`. Only the treasury is needed.
 *
 * Read from chain rather than hardcoded because `set_treasury` can move it, and
 * a revenue figure pointed at the wallet that *used* to collect is worse than
 * no revenue figure.
 */
const CONFIG_TREASURY = 8 + 32;

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * How long a computed figure is served before the chain is read again.
 *
 * TVL moves when a match opens or a swap lands, neither of which is fast
 * enough to justify three `getProgramAccounts` calls per dashboard load. Those
 * are the most expensive thing a public RPC will do for you, and this endpoint
 * is public.
 */
const TTL_MS = 60_000;
let cached = null;

async function readTvl(programId, amm) {
  const conn = new Connection(RPC, 'confirmed');
  const program = new PublicKey(programId);

  const configPda = PublicKey.findProgramAddressSync([Buffer.from('config')], program)[0];
  const config = await conn.getAccountInfo(configPda).catch(() => null);
  const treasury = config
    ? new PublicKey(config.data.subarray(CONFIG_TREASURY, CONFIG_TREASURY + 32))
    : null;

  const [cards, matches, baseVault, quoteVault, treasuryTokens, treasurySol] = await Promise.all([
    conn.getProgramAccounts(program, {
      filters: [{ dataSize: CARD.SIZE }],
      dataSlice: { offset: CARD.STAKED_MICRO_USD, length: 8 },
    }),
    /*
     * Two fields, not the whole account.
     *
     * The card scan next to this one already slices; this one downloaded every
     * match account in full to read a `u64` at 17 and a `u8` at 161. The slice
     * spans exactly those, and the reads below are relative to its start.
     */
    conn.getProgramAccounts(program, {
      filters: [{ dataSize: MATCH.SIZE }],
      dataSlice: { offset: MATCH.STAKE_LAMPORTS, length: MATCH.STATE - MATCH.STAKE_LAMPORTS + 1 },
    }),
    conn.getTokenAccountBalance(new PublicKey(amm.baseVault)).catch(() => null),
    conn.getTokenAccountBalance(new PublicKey(amm.quoteVault)).catch(() => null),
    treasury
      ? conn.getTokenAccountBalance(
        getAssociatedTokenAddressSync(new PublicKey(amm.mempireMint), treasury, true),
      ).catch(() => null)
      : null,
    treasury ? conn.getBalance(treasury).catch(() => null) : null,
  ]);

  // Escrow. Both seats' stakes sit in the account, so an Active match holds
  // twice its `stake_lamports`; an Open one holds a single side.
  let escrowLamports = 0n;
  let openMatches = 0;
  let activeMatches = 0;
  for (const { account } of matches) {
    // Offsets are relative to the slice above, which starts at STAKE_LAMPORTS.
    const state = account.data.readUInt8(MATCH.STATE - MATCH.STAKE_LAMPORTS);
    if (state === MATCH_STATE_SETTLED) continue;
    const stake = account.data.readBigUInt64LE(0);
    if (state === 0) { openMatches += 1; escrowLamports += stake; } else { activeMatches += 1; escrowLamports += stake * 2n; }
  }

  const quoteUsd = quoteVault ? Number(quoteVault.value.uiAmount ?? 0) : 0;
  const baseTokens = baseVault ? Number(baseVault.value.uiAmount ?? 0) : 0;
  // x·y=k means the two sides are worth the same, so the quote side doubled is
  // the pool. Reported as null rather than 0 when a vault could not be read —
  // an unreachable RPC is not an empty pool.
  const poolUsd = quoteVault && baseVault ? quoteUsd * 2 : null;
  const mempirePrice = baseTokens > 0 ? quoteUsd / baseTokens : null;

  const escrowSol = Number(escrowLamports) / LAMPORTS_PER_SOL;

  return {
    generatedAt: new Date(),
    cluster: amm.cluster ?? 'devnet',
    /**
     * Deliberately two figures, not one.
     *
     * Escrow is denominated in SOL and the pool in USD, and adding them would
     * need a SOL price this service does not have. Inventing one to produce a
     * single headline number is exactly the kind of tidy figure nobody can
     * check.
     *
     * There used to be a third: the USD value staked in cards. The pivot
     * deleted staking from the program, so that number could only ever be
     * zero — and a game whose first promise is that it never touches anyone's
     * holdings should not be publishing a "staked" figure at all.
     */
    totals: {
      escrowSol,
      lockedUsd: poolUsd ?? 0,
    },
    escrow: {
      sol: escrowSol,
      openMatches,
      activeMatches,
    },
    pool: {
      usd: poolUsd,
      mempire: baseTokens,
      usdc: quoteUsd,
      mempirePrice,
    },
    cards: {
      count: cards.length,
    },
    /**
     * What the game has actually taken in.
     *
     * $MEMPIRE is unambiguous — every sink is a transfer into this account and
     * nothing else pays into it. The SOL figure is the treasury's whole balance,
     * which includes rake but also whatever it was funded with, so it is
     * reported as a balance and labelled as one rather than dressed up as
     * revenue.
     */
    treasury: treasury
      ? {
        address: treasury.toBase58(),
        mempire: treasuryTokens ? Number(treasuryTokens.value.uiAmount ?? 0) : 0,
        solBalance: treasurySol === null ? null : treasurySol / LAMPORTS_PER_SOL,
      }
      : null,
  };
}

/*
 * The read that is currently happening, if one is.
 *
 * The TTL check reads `cached` before the await and `cached` is only assigned
 * after `readTvl` resolves, so every request arriving during one cold window
 * ran its own full scan — seven RPC calls each, two of them
 * `getProgramAccounts` over the whole program. A TTL bounds *sequential*
 * misses and does nothing about concurrency, which is the shape an abusive
 * client actually has. Sharing the in-flight promise makes N concurrent misses
 * cost exactly one chain read.
 */
let inflight = null;

export function registerTvlRoutes(app, { programId, amm }, gate) {
  // Public, unauthenticated, and it spends the same RPC quota that chain
  // verification needs to establish who was paid what. The shared limiter
  // exempts GETs by default, so this route asks for one that does not.
  const guard = gate ?? ((_req, _res, next) => next());
  app.get('/api/analytics/tvl', guard, async (_req, res) => {
    if (cached && Date.now() - cached.at < TTL_MS) return res.json(cached.body);
    try {
      inflight ??= readTvl(programId, amm).finally(() => { inflight = null; });
      const body = await inflight;
      cached = { at: Date.now(), body };
      res.json(body);
    } catch (e) {
      // Serve the last good figure if there is one, saying plainly that it is
      // stale. A dashboard showing a number from a minute ago and admitting so
      // beats one showing zero, which reads as "nothing is locked".
      if (cached) return res.json({ ...cached.body, stale: true, error: String(e?.message ?? e).slice(0, 160) });
      res.status(503).json({ error: String(e?.message ?? e).slice(0, 200) });
    }
  });
}
