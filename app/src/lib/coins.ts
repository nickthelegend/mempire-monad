import cardCatalogue from '../data/cards.json';
import devnet from './devnet-coins.json';
import mainnet from './mainnet-coins.json';
import { IS_MAINNET } from '../chain/provider';

/*
 * One registry per cluster, chosen at build time, and the choice is checked.
 *
 * The devnet file is 66 seeded mints with fixed reference prices — honest
 * where no market exists. The mainnet file is built by
 * `chain/build-mainnet-registry.mjs` from Jupiter's *verified* token list
 * (identity) plus DexScreener per-mint reads (market data) — never from
 * symbol search, which returns scam tokens wearing real tickers. A build
 * whose registry stamp disagrees with its cluster refuses to boot: a card
 * game staking real tokens must not guess which chain its mints live on.
 */
const registry = (IS_MAINNET ? mainnet : devnet) as {
  cluster: string; coins: SeededCoin[]; programId?: string; config?: string;
};
if (IS_MAINNET !== String(registry.cluster).startsWith('mainnet')) {
  throw new Error(`registry is stamped ${registry.cluster} but this build is ${IS_MAINNET ? 'mainnet' : 'devnet'}`);
}

/**
 * The coin registry.
 *
 * Mints are the **real devnet SPL mints** written by `chain/scripts/seed-devnet.ts`
 * and registered onchain, not placeholders. That matters for one specific reason:
 * archetype is `fnv1a(mint_base58) % 6` in both `sim/archetypes.ts` and the Rust
 * program, so a card's class is only consistent between client and chain if the
 * client is hashing the same string the program hashed. Placeholder mints looked
 * fine and would have silently disagreed the moment a card was minted for real.
 *
 * Presentation (ticker, name, hue, art) and the simulated-mode balance live here,
 * keyed by ticker; the economic facts (mint, price, liquidity, age) come from the
 * seed file so re-seeding cannot leave the UI describing a coin that no longer
 * exists. Real balances, when a wallet is connected, come from the chain store.
 */
/** Meme coins, blue-chip crypto, and tokenised stocks all become cards. */
export type AssetKind = 'meme' | 'crypto' | 'stock';

export const ASSET_KINDS: { id: AssetKind; label: string }[] = [
  { id: 'meme', label: 'Memes' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'stock', label: 'Stocks' },
];

export interface Coin {
  mint: string;
  ticker: string;
  name: string;
  hue: number;
  balance: number; // simulated-mode holdings; real balances come from chain
  priceUsd: number;
  liquidityUsd: number;
  ageHours: number;
  logoUrl?: string;
  /**
   * Full-bleed character card art (3:4). When present the card frame fills its
   * portrait well with this instead of the round badge — a fighter, not a token.
   */
  cardArt?: string;
  /** What this asset is, for the Cards filter. */
  kind: AssetKind;
  decimals: number;
  /** Live market data, present only on coins enriched from the feed. */
  fdvUsd?: number;
  change24h?: number;
  volume24h?: number;
  pumpFun?: boolean;
  url?: string;
}

/** Ticker → look and demo balance. Economic facts never live here. */
const PRESENTATION: Record<string, {
  name: string; hue: number; balance: number; art: string;
}> = {
  DOGGO: { name: 'Doggo', hue: 38, balance: 1_250_000, art: 'coin_doggo' },
  WIFHAT: { name: 'Dog Wif Hat', hue: 320, balance: 48_000, art: 'coin_wifhat' },
  POPKAT: { name: 'Popkat', hue: 265, balance: 310_000, art: 'coin_popkat' },
  PENG: { name: 'Peng', hue: 205, balance: 92_000, art: 'coin_peng' },
  FRG: { name: 'Frog', hue: 130, balance: 660_000, art: 'coin_frg' },
  MOONCAT: { name: 'Mooncat', hue: 52, balance: 178_000, art: 'coin_mooncat' },
  RKT: { name: 'Rocket', hue: 12, balance: 84_500, art: 'coin_rkt' },
  CHAD: { name: 'Chad', hue: 350, balance: 21_000, art: 'coin_chad' },
  GMI: { name: 'Gonna Make It', hue: 88, balance: 505_000, art: 'coin_gmi' },
  SER: { name: 'Ser', hue: 228, balance: 130_000, art: 'coin_ser' },
  BBWHALE: { name: 'Baby Whale', hue: 190, balance: 44_000, art: 'coin_bbwhale' },
  RUGPROOF: { name: 'Rugproof', hue: 28, balance: 900_000, art: 'coin_rugproof' },
};

/**
 * Asset class per ticker, read from the card catalogue that also drives art
 * generation. One source: a coin cannot be a stock in the filter and a meme in
 * the art pipeline.
 */
const KIND_BY_TICKER = new Map<string, AssetKind>(
  (cardCatalogue.cards as { ticker: string; kind: string }[])
    .map((c) => [c.ticker.toUpperCase(), c.kind as AssetKind]),
);

interface SeededCoin {
  mint: string;
  ticker: string;
  name: string;
  hue: number;
  priceUsd: number;
  liquidityUsd: number;
  firstSeen: number;
  decimals: number;
}

/** Tickers always render with the $ the culture uses. */
export const tickerOf = (c: Coin): string => `$${c.ticker.replace(/^\$+/, '')}`;

export const ELIGIBILITY = { minLiquidityUsd: 25_000, minAgeHours: 48 };

export const isEligible = (c: Coin): boolean =>
  c.liquidityUsd >= ELIGIBILITY.minLiquidityUsd && c.ageHours >= ELIGIBILITY.minAgeHours;

export const ineligibleReason = (c: Coin): string | null => {
  if (c.liquidityUsd < ELIGIBILITY.minLiquidityUsd) return 'liquidity below $25k';
  if (c.ageHours < ELIGIBILITY.minAgeHours) return 'younger than 48h';
  return null;
};

/** The cluster the active registry belongs to. */
export const REGISTRY_META = { cluster: registry.cluster };

function build(): Coin[] {
  const nowSec = Date.now() / 1000;
  return registry.coins.map((c) => {
    const look = PRESENTATION[c.ticker];
    return {
      mint: c.mint,
      ticker: c.ticker,
      name: look?.name ?? c.name,
      hue: look?.hue ?? c.hue,
      // Simulated-mode holdings. Assets without a hand-tuned entry get roughly
      // $600 worth, so every card in the registry is actually stakeable in the
      // demo rather than sitting at zero and looking broken.
      // Simulated holdings exist only where the tokens don't: a mainnet
      // build starts every real coin at zero and holdings come from the
      // wallet, because pretending to hold $600 of a real asset is a lie.
      balance: IS_MAINNET ? 0 : (look?.balance ?? Math.max(1, Math.round(600 / Math.max(c.priceUsd, 1e-6)))),
      priceUsd: c.priceUsd,
      liquidityUsd: c.liquidityUsd,
      // Age is derived from the seeded first-seen timestamp, so the two gated
      // coins stay gated for the same reason the program gates them.
      ageHours: Math.max(0, Math.round((nowSec - c.firstSeen) / 3600)),
      decimals: c.decimals,
      kind: KIND_BY_TICKER.get(c.ticker.toUpperCase()) ?? 'meme',
      // Round badge only for the originally-arted coins; everything else relies
      // on its character card, with CoinBadge's procedural fallback behind it.
      logoUrl: look ? `/art/${look.art}.webp` : undefined,
      /*
       * WebP, and the conventional path.
       *
       * The art is AI-rendered at 512x679, which PNG compresses terribly —
       * 413 KB each, 26 MB across the set. A match pulls eight of these at
       * once and decodes them on the main thread while the clock is already
       * running, which was most of the cold-start cost. The same images as
       * WebP q86 are ~58 KB, an eight-fold cut, at a size nobody can tell
       * apart at the 200px these render at.
       *
       * The PNGs stay on disk: an NFT's metadata `image` points at
       * `card_<ticker>.png` and that URI is on chain, so deleting them would
       * break every card already tokenised.
       *
       * The file may not exist yet; both the card frame and the battle
       * billboard fall back to the round badge on a load error, so dropping
       * `card_<ticker>.webp` into /art is the whole install step.
       */
      cardArt: `/art/card_${c.ticker.toLowerCase()}.webp`,
    };
  });
}

export const COINS: Coin[] = build();

const BY_MINT = new Map(COINS.map((c) => [c.mint, c]));
const BY_TICKER = new Map(COINS.map((c) => [c.ticker, c]));

export const coinByMint = (mint: string): Coin | undefined => BY_MINT.get(mint);
export const coinByTicker = (ticker: string): Coin | undefined =>
  BY_TICKER.get(ticker.replace(/^\$+/, '').toUpperCase());

/** Token units → raw base units for a transfer. */
export function toRawAmount(coin: Coin, uiAmount: number): bigint {
  return BigInt(Math.round(uiAmount * 10 ** coin.decimals));
}

/** Raw base units → token units for display. */
export function fromRawAmount(coin: Coin, raw: number | bigint): number {
  return Number(raw) / 10 ** coin.decimals;
}

/**
 * Live prices, for the cluster where prices are real.
 *
 * The bundled registry's numbers are fixed reference prices — the honest
 * choice on devnet, where the mints have no market, and a lie on mainnet,
 * where they do. This overlays the relay's DexScreener read onto the same
 * `Coin` objects every consumer already holds, keyed by mint, and reports
 * whether anything changed so the caller can trigger a re-render. Money paths
 * read `priceUsd` at click time, so the overlay corrects them immediately
 * even before the UI repaints.
 *
 * Devnet builds never call this; their disclosure says exactly what the
 * numbers are.
 */
export function overlayLivePrices(
  live: { mint: string; priceUsd?: number; liquidityUsd?: number }[],
): boolean {
  let changed = false;
  for (const row of live) {
    const coin = BY_MINT.get(row.mint);
    if (!coin) continue;
    if (typeof row.priceUsd === 'number' && row.priceUsd > 0 && row.priceUsd !== coin.priceUsd) {
      coin.priceUsd = row.priceUsd; changed = true;
    }
    if (typeof row.liquidityUsd === 'number' && row.liquidityUsd >= 0
        && row.liquidityUsd !== coin.liquidityUsd) {
      coin.liquidityUsd = row.liquidityUsd; changed = true;
    }
  }
  return changed;
}
