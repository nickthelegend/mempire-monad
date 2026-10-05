import type { Idl, Program } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { getConnection, getProgram } from './provider';
import { configPda } from './pdas';

/**
 * Reads. Everything here works without a wallet, because a visitor who has
 * connected nothing should still see the real registry rather than a mock.
 *
 * Anchor's generated account namespace is untyped without a codegen step, so
 * each fetch is narrowed into an explicit shape at this boundary. Nothing
 * downstream sees `any`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const accounts = (p: Program<Idl>) => p.account as any;

const num = (v: unknown): number => Number(v ?? 0);

export interface ChainConfig {
  address: string;
  admin: string;
  treasury: string;
  mintFeeSol: number;
  rakePct: number;
  tieRakePct: number;
  unstakeFeePct: number;
  unstakeCooldownSecs: number;
  matchTimeoutSecs: number;
  minAgeSecs: number;
  powerBand: number;
  nextCardId: number;
  nextMatchId: number;
}

export async function fetchConfig(): Promise<ChainConfig | null> {
  const program = getProgram();
  const pda = configPda();
  const raw = await accounts(program).config.fetchNullable(pda);
  if (!raw) return null;
  return {
    address: pda.toBase58(),
    admin: raw.admin.toBase58(),
    treasury: raw.treasury.toBase58(),
    mintFeeSol: num(raw.mintFeeLamports) / 1e9,
    rakePct: num(raw.rakeBps) / 100,
    tieRakePct: num(raw.tieRakeBps) / 100,
    unstakeFeePct: num(raw.unstakeFeeBps) / 100,
    unstakeCooldownSecs: num(raw.unstakeCooldownSecs),
    matchTimeoutSecs: num(raw.matchTimeoutSecs),
    minAgeSecs: num(raw.minAgeSecs),
    powerBand: num(raw.powerBand),
    nextCardId: num(raw.nextCardId),
    nextMatchId: num(raw.nextMatchId),
  };
}

export interface ChainCoin {
  mint: string;
  liquidityUsd: number;
  priceUsd: number;
  firstSeenTs: number;
  decimals: number;
}

export async function fetchRegisteredCoins(): Promise<ChainCoin[]> {
  const program = getProgram();
  const all = await accounts(program).coinInfo.all();
  return all.map((c: any) => ({
    mint: c.account.mint.toBase58(),
    liquidityUsd: num(c.account.liquidityUsd),
    priceUsd: num(c.account.priceMicroUsd) / 1e6,
    firstSeenTs: num(c.account.firstSeenTs),
    decimals: num(c.account.decimals),
  }));
}

export interface ChainCard {
  address: string;
  id: number;
  owner: string;
  mint: string;
  archetype: number;
  level: number;
  /** True while the card is locked into a match. */
  inMatch: boolean;
  /** The match holding the lock, or null when free. */
  lockedBy: string | null;
}

function toCard(address: PublicKey, a: any): ChainCard {
  return {
    address: address.toBase58(),
    id: num(a.id),
    owner: a.owner.toBase58(),
    mint: a.coinMint.toBase58(),
    archetype: num(a.archetype),
    level: num(a.level),
    // The chain replaced the `in_match` flag with the key of the match that
    // holds the lock, so settlement can refuse to free a card belonging to
    // some other, still-running match. `inMatch` stays in this shape because
    // every screen only ever asked the yes/no question.
    inMatch: !!a.lockedBy && !a.lockedBy.equals(PublicKey.default),
    lockedBy:
      a.lockedBy && !a.lockedBy.equals(PublicKey.default)
        ? a.lockedBy.toBase58()
        : null,
  };
}

/**
 * Cards owned by one wallet.
 *
 * Filtered server-side by a memcmp on the `owner` field rather than fetching
 * every card and filtering locally — the discriminator is 8 bytes and `id` is a
 * u64, so `owner` starts at byte 16.
 */
const CARD_OWNER_OFFSET = 8 + 8;

export async function fetchCardsFor(owner: string): Promise<ChainCard[]> {
  const program = getProgram();
  const all = await accounts(program).card.all([
    { memcmp: { offset: CARD_OWNER_OFFSET, bytes: owner } },
  ]);
  return all
    .map((c: any) => toCard(c.publicKey, c.account))
    .sort((a: ChainCard, b: ChainCard) => a.id - b.id);
}

export interface ChainMatch {
  address: string;
  id: number;
  tier: number;
  stakeSol: number;
  players: [string, string];
  state: number;
  createdAt: number;
  deadline: number;
  winner: number;
  finalHash: string;
}

function toMatch(address: PublicKey, a: any): ChainMatch {
  return {
    address: address.toBase58(),
    id: num(a.id),
    tier: num(a.tier),
    stakeSol: num(a.stakeLamports) / 1e9,
    players: [a.players[0].toBase58(), a.players[1].toBase58()],
    state: num(a.state),
    createdAt: num(a.createdAt),
    deadline: num(a.deadline),
    winner: num(a.winner),
    finalHash: String(a.finalHash ?? '0'),
  };
}

export async function fetchMatch(address: string): Promise<ChainMatch | null> {
  const program = getProgram();
  const pk = new PublicKey(address);
  const raw = await accounts(program).matchAccount.fetchNullable(pk);
  return raw ? toMatch(pk, raw) : null;
}

/** Matches awaiting a second player — the real matchmaking pool. */
const MATCH_STATE_OPEN = 0;

export async function fetchOpenMatches(): Promise<ChainMatch[]> {
  const program = getProgram();
  const all = await accounts(program).matchAccount.all();
  return all
    .map((m: any) => toMatch(m.publicKey, m.account))
    .filter((m: ChainMatch) => m.state === MATCH_STATE_OPEN)
    .sort((a: ChainMatch, b: ChainMatch) => b.createdAt - a.createdAt);
}

/**
 * Matches this wallet is still a player in, that never settled.
 *
 * Stake recovery used to read the escrow store, which lives in memory: reload
 * the page and `matchId` is null and `phase` is 'none', so a stranded pot
 * became invisible at exactly the moment its owner would come looking for it.
 * A stake sitting in an open match account is a fact about the chain, so it is
 * read from the chain.
 *
 * Open and Active both count — the pot is escrowed in either, and neither has
 * paid out. Settled is the only state where the money has moved.
 */
/** One match by its account address, for a card that names it in `locked_by`. */
export async function fetchMatchByAddress(address: string): Promise<ChainMatch | null> {
  try {
    const program = getProgram();
    const a = await accounts(program).matchAccount.fetch(new PublicKey(address));
    return toMatch(new PublicKey(address), a);
  } catch {
    return null;
  }
}

export async function fetchStrandedMatches(owner: string): Promise<ChainMatch[]> {
  const program = getProgram();
  const all = await accounts(program).matchAccount.all();
  return all
    .map((m: any) => toMatch(m.publicKey, m.account))
    .filter((m: ChainMatch) => m.players.includes(owner)
      && m.state !== MATCH_STATE_SETTLED)
    .sort((a: ChainMatch, b: ChainMatch) => b.createdAt - a.createdAt);
}

export async function fetchSolBalance(owner: string): Promise<number> {
  const lamports = await getConnection().getBalance(new PublicKey(owner));
  return lamports / 1e9;
}

/**
 * Real SPL balances for one wallet, keyed by mint.
 *
 * The roster a wallet actually owns. Cards are accounts the player holds —
 * minting one never required holding the underlying coin, and the game does
 * not touch anyone's tokens. This is simply the coins a player can
 * mint cards from are the coins this call reports, not a fixture.
 */
export async function fetchTokenBalances(owner: string): Promise<Map<string, number>> {
  const res = await getConnection().getParsedTokenAccountsByOwner(
    new PublicKey(owner),
    { programId: TOKEN_PROGRAM_ID },
  );
  const out = new Map<string, number>();
  for (const { account } of res.value) {
    const info = (account.data as any).parsed?.info;
    if (!info) continue;
    const amount = Number(info.tokenAmount?.uiAmount ?? 0);
    if (amount > 0) out.set(info.mint as string, amount);
  }
  return out;
}

/** A match the program has already paid out. */
export const MATCH_STATE_SETTLED = 2;

/**
 * Real settled matches, newest first.
 *
 * The Arena's "recent settlements" strip used to be six hardcoded names and
 * amounts — `chad.sol won 0.45` — cycling on a timer. It looked exactly like a
 * live feed of other players' matches and was a fabrication, on the one screen
 * whose entire job is to convince someone the pot is real.
 *
 * This returns what actually settled. An empty list is a legitimate answer on
 * a young devnet and the caller says so rather than inventing filler.
 */
export async function fetchRecentSettlements(limit = 12): Promise<ChainMatch[]> {
  const program = getProgram();
  const all = await accounts(program).matchAccount.all();
  return all
    .map((r: { publicKey: PublicKey; account: unknown }) => toMatch(r.publicKey, r.account))
    // `winner` 0/1 is a result and 2 is a draw. 3 is what `cancel_match`
    // writes for a match nobody joined — no game was played and no pot was
    // won, so showing it as a settlement (and worse, as "a draw split the
    // pot") would be inventing a match that never happened.
    .filter((m: ChainMatch) => m.state === MATCH_STATE_SETTLED
      && m.stakeSol > 0
      && m.winner <= 2)
    .sort((a: ChainMatch, b: ChainMatch) => b.id - a.id)
    .slice(0, limit);
}
