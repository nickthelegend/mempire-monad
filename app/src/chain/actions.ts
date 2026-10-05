import { AnchorProvider, BN } from '@coral-xyz/anchor';
import type { Adapter } from '@solana/wallet-adapter-base';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import {
  PublicKey, SystemProgram, Transaction, type TransactionInstruction,
} from '@solana/web3.js';
import { canSign, getProgram, getProvider, getConnection } from './provider';
import {
  PROGRAM_ID, cardPda, coinPda, configPda, matchPda,
} from './pdas';
import { fetchConfig } from './read';
import { MEMPIRE_MINT } from './amm';
import { track } from '../lib/track';

/**
 * Writes. Every one of these submits a real transaction and returns its
 * signature, so the UI can link to the explorer and the player can verify the
 * claim themselves.
 *
 * All of them refuse early when the wallet cannot sign. Guest mode has an
 * address but no keypair, and failing here with a sentence beats failing deep in
 * an adapter with a stack trace.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export class NoSignerError extends Error {
  constructor() { super('This wallet cannot sign — connect a real wallet to go onchain.'); }
}

/**
 * The public key that will sign, or throw.
 *
 * Returns a key rather than an adapter because there may not *be* an adapter:
 * a guest signs with a browser-held keypair and has no wallet object at all.
 * The old version demanded `adapter?.publicKey`, which meant every guest hit
 * `NoSignerError` no matter what `canSign` said — the button did nothing, threw
 * nothing a user could see, and the whole guest-signing path was dead on
 * arrival.
 */
function requireSigner(adapter: Adapter | null): { publicKey: PublicKey } {
  if (!canSign(adapter)) throw new NoSignerError();
  const key = adapter?.publicKey ?? getProvider(adapter).wallet.publicKey;
  if (!key) throw new NoSignerError();
  return { publicKey: key };
}

/**
 * Anchor error codes carry the program's own message, which is already written
 * for a human ("coin is younger than the minimum age"). Surface that rather than
 * a simulation dump; fall back to the raw text when it is something else.
 */
export function readableChainError(e: unknown): string {
  const anyErr = e as any;
  const fromAnchor = anyErr?.error?.errorMessage
    ?? anyErr?.error?.errorCode?.code
    ?? anyErr?.errorMessage;

  /*
   * "Fallback functions are not supported" is what the program answers when it
   * has no instruction matching the discriminator it was sent — which happens
   * whenever this bundle knows about an instruction the deployed build
   * compiled out. `nft` and `rollup` are cargo features, so the launch build
   * genuinely has fewer instructions than this IDL describes.
   *
   * Checked before the Anchor passthrough below, because Anchor reports it as
   * a structured `errorMessage` and the passthrough would return it verbatim —
   * leaving the player reading jargon about fallback functions. The honest
   * reading is that the feature is not deployed on this network.
   */
  if (/fallback function/i.test(`${fromAnchor ?? ''} ${anyErr?.message ?? ''}`)) {
    return 'That is not available on this network yet';
  }
  if (typeof fromAnchor === 'string' && fromAnchor) return fromAnchor;

  const msg = String(anyErr?.message ?? e ?? 'transaction failed');
  if (/user rejected|rejected the request|declined/i.test(msg)) return 'You rejected the transaction';
  if (/insufficient (lamports|funds)|0x1 /i.test(msg)) return 'Not enough SOL for this transaction';
  if (/blockhash|timed out|429|Too many requests/i.test(msg)) return 'Network is busy — try again';
  // Anchor writes the real cause into the simulation logs
  const logs: string[] = anyErr?.logs ?? [];
  const hit = logs.find((l) => l.includes('Error Message:'));
  if (hit) return hit.split('Error Message:')[1].trim();
  /*
   * Never hand back an empty string.
   *
   * Something in the rollup path rejects with a value whose `message` is empty,
   * and this returned that emptiness verbatim — so a failure logged its reason
   * as nothing at all, which is how lost checkpoints went undiagnosed. If there
   * is genuinely no text, say what kind of thing was thrown instead.
   */
  const trimmed = msg.trim();
  if (trimmed) return trimmed.slice(0, 120);
  const kind = anyErr?.name ?? anyErr?.constructor?.name ?? typeof e;
  return `the network rejected it without a reason (${kind})`;
}

export interface TxResult { signature: string }

/**
 * Mint a card from any eligible coin.
 *
 * The program re-checks liquidity and age, so a patched client cannot talk it
 * into minting an ineligible coin. It no longer checks the caller's balance:
 * holding the coin stopped being a requirement, because gating the roster
 * behind a wallet audit meant nobody could field a deck without first
 * acquiring eight specific SPL tokens.
 */
export async function mintCardTx(
  adapter: Adapter | null, mint: string, payWith: 'sol' | 'mempire' = 'sol',
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const program = getProgram(adapter);
  const owner = wallet.publicKey!;
  const mintKey = new PublicKey(mint);

  const cfg = await fetchConfig();
  if (!cfg) throw new Error('Program config not found on this cluster');

  /*
   * The token account is passed only when it exists.
   *
   * Minting no longer requires holding the coin, and someone who does not hold
   * it has no associated token account for it — naming an address that has
   * never been created fails account resolution before the program is even
   * reached, which would have locked out precisely the players the change was
   * made for. Null is a legal value for an optional account; a non-existent
   * address is not.
   */
  const ata = getAssociatedTokenAddressSync(mintKey, owner);
  const holdsIt = await getConnection().getAccountInfo(ata).catch(() => null);

  /*
   * Paying in $MEMPIRE waives the lamport fee rather than adding to it. The
   * program takes one or the other; naming these three accounts is what picks
   * the token. The amount is the program's constant — the shop used to pass a
   * price of its own, and a price the payer names is not a price.
   */
  const pre: TransactionInstruction[] = [];
  let ownerMempire: PublicKey | null = null;
  let treasuryMempire: PublicKey | null = null;
  if (payWith === 'mempire') {
    ownerMempire = getAssociatedTokenAddressSync(MEMPIRE_MINT, owner);
    treasuryMempire = getAssociatedTokenAddressSync(
      MEMPIRE_MINT, new PublicKey(cfg.treasury), true,
    );
    pre.push(createAssociatedTokenAccountIdempotentInstruction(
      owner, treasuryMempire, new PublicKey(cfg.treasury), MEMPIRE_MINT,
    ));
  }

  const signature = await program.methods
    .mintCard()
    .accounts({
      config: configPda(),
      coinInfo: coinPda(mintKey),
      card: cardPda(cfg.nextCardId),
      ownerTokens: holdsIt ? ata : null,
      ownerMempire,
      treasuryMempire,
      tokenProgram: ownerMempire ? TOKEN_PROGRAM_ID : null,
      owner,
      treasury: new PublicKey(cfg.treasury),
      systemProgram: SystemProgram.programId,
    } as any)
    .preInstructions(pre)
    .rpc();

  track('card.mint', { count: 1, mint });
  return { signature };
}

/**
 * Merge a duplicate card into one you keep, for a level.
 *
 * Decks are one-card-per-coin, so a second card for a coin you already own can
 * never be fielded — before this it was a mint fee spent on nothing. Now it is
 * the level. The duplicate is closed and its rent returned, so the merge costs
 * the $MEMPIRE fee and the signature.
 */
export async function upgradeCardTx(
  adapter: Adapter | null, keepCardId: number, duplicateCardId: number,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const program = getProgram(adapter);
  const owner = wallet.publicKey!;

  const cfg = await fetchConfig();
  if (!cfg) throw new Error('Program config not found on this cluster');

  /*
   * The merge fee lands in the treasury's $MEMPIRE account, which on a fresh
   * mainnet has never been created — the treasury is a brand new multisig that
   * has never held the mint. Naming it unconditionally would fail account
   * resolution, so the *first* player to merge on mainnet would simply be told
   * the merge failed, and merging would stay broken until somebody happened to
   * make a shop purchase (which does create it). Idempotent, so that first
   * player pays the rent once and nobody after them does.
   */
  const treasuryMempire = getAssociatedTokenAddressSync(
    MEMPIRE_MINT, new PublicKey(cfg.treasury), true,
  );

  const signature = await program.methods
    .upgradeCard()
    .accounts({
      config: configPda(),
      card: cardPda(keepCardId),
      duplicate: cardPda(duplicateCardId),
      ownerMempire: getAssociatedTokenAddressSync(MEMPIRE_MINT, owner),
      treasuryMempire,
      // Required, not optional: the program refuses to merge away a card whose
      // 1-of-1 exists, because doing so would leave whoever bought that NFT
      // holding a token pointing at a closed account.
      duplicateNftMint: nftMintPda(duplicateCardId),
      owner,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .preInstructions([createAssociatedTokenAccountIdempotentInstruction(
      owner, treasuryMempire, new PublicKey(cfg.treasury), MEMPIRE_MINT,
    )])
    .rpc();

  track('card.upgrade', { keep: keepCardId, burned: duplicateCardId });
  return { signature };
}

/** Metaplex Token Metadata. Same address on every cluster. */
export const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
);

/** Where a wallet's rewarded-win count lives. */
export const rewardCountPda = (player: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync(
    [Buffer.from('rewarded'), player.toBuffer()], PROGRAM_ID,
  )[0];

export const nftMintPda = (cardId: number): PublicKey => PublicKey.findProgramAddressSync(
  [Buffer.from('nftmint'), new BN(cardId).toArrayLike(Buffer, 'le', 8)],
  PROGRAM_ID,
)[0];

const metadataPda = (mint: PublicKey): PublicKey => PublicKey.findProgramAddressSync(
  [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
  TOKEN_METADATA_PROGRAM_ID,
)[0];

/**
 * Turn a card into a real 1-of-1 NFT.
 *
 * A card is an Anchor PDA — correct, cheap, and invisible to every wallet and
 * explorer, which render it as a program account full of bytes. This mints the
 * token that makes it visible: 0 decimals, supply one, Metaplex metadata
 * pointing at the fighter's art, mint authority dropped afterwards.
 *
 * Seeded on the card id, so a card can be tokenised exactly once — the second
 * attempt fails on `init` rather than minting a rival copy.
 */
export async function tokenizeCardTx(
  adapter: Adapter | null, cardId: number, ticker: string,
): Promise<TxResult & { nftMint: string }> {
  const wallet = requireSigner(adapter);
  const program = getProgram(adapter);
  const owner = wallet.publicKey!;
  const nftMint = nftMintPda(cardId);

  const signature = await program.methods
    .tokenizeCard(ticker.replace(/^\$+/, '').toUpperCase())
    .accounts({
      config: configPda(),
      card: cardPda(cardId),
      nftMint,
      mintAuthority: PublicKey.findProgramAddressSync(
        [Buffer.from('nft'), new BN(cardId).toArrayLike(Buffer, 'le', 8)],
        PROGRAM_ID,
      )[0],
      ownerNft: getAssociatedTokenAddressSync(nftMint, owner),
      metadata: metadataPda(nftMint),
      owner,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: new PublicKey('SysvarRent111111111111111111111111111111111'),
    } as any)
    .rpc();

  track('card.tokenize', { cardId, ticker });
  return { signature, nftMint: nftMint.toBase58() };
}

/** What merging the next level costs, in whole $MEMPIRE. Mirrors the program. */
export const upgradeCost = (level: number): number => 100 * level;




/**
 * Open a match and escrow the stake.
 *
 * The eight deck cards ride in `remaining_accounts`; the program validates
 * ownership, one-card-per-coin and the power band, then locks them. Order is the
 * deck order, which is what `deckHash` commits to.
 */
export async function createMatchTx(
  adapter: Adapter | null,
  tier: number,
  stakeSol: number,
  deckCardIds: number[],
  deckHash: Uint8Array,
): Promise<TxResult & { matchId: number; matchAddress: string }> {
  const wallet = requireSigner(adapter);
  const program = getProgram(adapter);

  const cfg = await fetchConfig();
  if (!cfg) throw new Error('Program config not found on this cluster');
  const matchId = cfg.nextMatchId;
  const matchAccount = matchPda(matchId);

  const signature = await program.methods
    .createMatch(tier, new BN(Math.round(stakeSol * 1e9)), Array.from(deckHash))
    .accounts({
      config: configPda(),
      matchAccount,
      player: wallet.publicKey!,
      systemProgram: SystemProgram.programId,
    } as any)
    .remainingAccounts(deckCardIds.map((id) => ({
      pubkey: cardPda(id), isWritable: true, isSigner: false,
    })))
    .rpc();

  return { signature, matchId, matchAddress: matchAccount.toBase58() };
}

/** Join an open match at the same stake. Same deck validation, plus the bracket. */
export async function joinMatchTx(
  adapter: Adapter | null,
  matchId: number,
  deckCardIds: number[],
  deckHash: Uint8Array,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const program = getProgram(adapter);

  const signature = await program.methods
    .joinMatch(Array.from(deckHash))
    .accounts({
      config: configPda(),
      matchAccount: matchPda(matchId),
      player: wallet.publicKey!,
      systemProgram: SystemProgram.programId,
    } as any)
    .remainingAccounts(deckCardIds.map((id) => ({
      pubkey: cardPda(id), isWritable: true, isSigner: false,
    })))
    .rpc();
  return { signature };
}

/**
 * Settle with both signatures.
 *
 * This is the honest constraint in the current design: settlement needs *both*
 * players to sign the same final state hash, so it cannot be driven from one
 * client alone. `claimTimeoutTx` is the escape hatch when an opponent vanishes.
 */
export async function settleTx(
  adapter: Adapter | null,
  matchId: number,
  playerB: string,
  finalHash: bigint,
  winner: number,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const program = getProgram(adapter);
  const cfg = await fetchConfig();
  if (!cfg) throw new Error('Program config not found on this cluster');

  const signature = await program.methods
    .settle(new BN(finalHash.toString()), winner)
    .accounts({
      config: configPda(),
      matchAccount: matchPda(matchId),
      playerA: wallet.publicKey!,
      playerB: new PublicKey(playerB),
      treasury: new PublicKey(cfg.treasury),
    } as any)
    .rpc();
  return { signature };
}

/**
 * Claim a stalled match's pot after the deadline. One signature, by design.
 *
 * Takes the deck accounts because settling has to unlock them, and the match
 * log because the program uses it to tell an abandoned match from a disputed
 * one — a seat that lied about the result and then called this used to take the
 * whole pot. The log PDA is seed-pinned on chain, so passing it is not a
 * courtesy the caller can decline.
 */
export async function claimTimeoutTx(
  adapter: Adapter | null,
  matchId: number,
  winnerAccount: string,
  players: [string, string],
  deckCardIds: number[] = [],
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const program = getProgram(adapter);
  const cfg = await fetchConfig();
  if (!cfg) throw new Error('Program config not found on this cluster');

  const signature = await program.methods
    .claimTimeout()
    .accounts({
      config: configPda(),
      matchAccount: matchPda(matchId),
      claimer: wallet.publicKey!,
      winnerAccount: new PublicKey(winnerAccount),
      treasury: new PublicKey(cfg.treasury),
      playerA: new PublicKey(players[0]),
      playerB: new PublicKey(players[1]),
      matchLog: baseLogPda(matchId),
    } as any)
    .remainingAccounts(deckCardIds.map((id) => ({
      pubkey: cardPda(id), isWritable: true, isSigner: false,
    })))
    .rpc();
  return { signature };
}

/** The base program's own match-log PDA — the one `settle_from_log` reads. */
export function baseLogPda(matchId: number): PublicKey {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(matchId), true);
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('log'), b], PROGRAM_ID,
  )[0];
}

/** Read a match account, or null if it does not exist yet. */
export async function readMatch(matchId: number): Promise<{
  id: number; state: number; players: string[]; stakeLamports: number;
  winner: number; deadline: number; deckHashes: Uint8Array[];
} | null> {
  const program = getProgram(null);
  try {
    const m = await (program.account as any).matchAccount.fetch(matchPda(matchId));
    return {
      id: Number(m.id),
      state: Number(m.state),
      players: (m.players as PublicKey[]).map((p) => p.toBase58()),
      stakeLamports: Number(m.stakeLamports),
      winner: Number(m.winner),
      deadline: Number(m.deadline),
      // The per-seat deck commitments, so a client can hold the relayed deck
      // against what the opponent actually locked on chain.
      deckHashes: (m.deckHash as number[][]).map((h) => Uint8Array.from(h)),
    };
  } catch {
    return null;
  }
}

/**
 * Withdraw a match nobody joined. Refunds the stake and releases the deck.
 *
 * The counterpart to `createMatchTx`: if the opponent's join never lands —
 * they closed the tab, their wallet refused, their RPC was down — the creator
 * is otherwise left with a stake in a match that will never start and eight
 * cards locked behind it.
 */
/**
 * Free cards still locked to a match that has already settled.
 *
 * `unlock_deck` frees exactly the accounts a settlement was handed, so a
 * settlement driven by one player used to leave the *other* player's eight
 * cards naming a match that no longer exists in any meaningful sense. Their
 * deck then could not be fielded and nothing in the app would ever fix it —
 * observed on a real wallet, eight cards locked to a settled match.
 *
 * The program allows anyone to pay for this precisely because a settled match
 * is the whole authority, so a client can clean up after itself without
 * needing the other player online.
 */
export async function releaseCardsTx(
  adapter: Adapter | null, matchId: number, cardIds: number[],
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const program = getProgram(adapter);
  const signature = await program.methods
    .releaseCards()
    .accounts({
      matchAccount: matchPda(matchId),
      payer: wallet.publicKey!,
    } as any)
    .remainingAccounts(cardIds.map((id) => ({
      pubkey: cardPda(id), isWritable: true, isSigner: false,
    })))
    .rpc();
  return { signature };
}

export async function cancelMatchTx(
  adapter: Adapter | null, matchId: number, deckCardIds: number[],
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const program = getProgram(adapter);
  const signature = await program.methods
    .cancelMatch()
    .accounts({
      matchAccount: matchPda(matchId),
      player: wallet.publicKey!,
    } as any)
    .remainingAccounts(deckCardIds.map((id) => ({
      pubkey: cardPda(id), isWritable: true, isSigner: false,
    })))
    .rpc();
  return { signature };
}

/**
 * Pay the pot from the committed log. One signature, either player.
 *
 * This is what makes the stake real without needing both wallets awake at the
 * same instant: each seat records its own result with `endMatchLogEr`, and
 * whichever of them gets here first triggers the payout. The program refuses
 * unless both claims are present and agree, so calling it early is a no-op
 * rather than a way to take the pot.
 *
 * The eight-plus-eight deck accounts ride along so settlement releases both
 * decks in the same transaction that moves the money.
 */
/** PDA that owns the $MEMPIRE the program pays winners from. */
export const rewardAuthorityPda = (): PublicKey => PublicKey.findProgramAddressSync(
  [Buffer.from('rewards')], PROGRAM_ID,
)[0];

export async function settleFromLogTx(
  adapter: Adapter | null,
  matchId: number,
  players: [string, string],
  deckCardIds: number[],
  winner?: number,
): Promise<TxResult> {
  const wallet = requireSigner(adapter);
  const program = getProgram(adapter);
  const cfg = await fetchConfig();
  if (!cfg) throw new Error('Program config not found on this cluster');

  /**
   * Both decks, discovered from the chain rather than from what this client
   * happens to know.
   *
   * `unlock_deck` only frees the accounts it is handed, and a client reliably
   * knows just its own eight cards — so passing this seat's deck alone left the
   * *opponent's* pinned to a finished match with nothing able to free it. Every
   * settled match stranded one player's collection and they could never field a
   * legal deck again. Sixteen accounts is well inside the transaction limit,
   * and the program skips anything not locked to this match.
   */
  const locked = await cardsLockedTo(matchPda(matchId)).catch(() => [] as PublicKey[]);
  const deckAccounts = locked.length ? locked : deckCardIds.map((id) => cardPda(id));

  /*
   * The winner's $MEMPIRE reward, when there is a vault to pay it from.
   *
   * All three accounts are optional in the program, and null is a legal value
   * — a settlement must never fail because a *reward* account is missing.
   * They are only named when the vault actually exists and the winner already
   * has somewhere to receive tokens; anything less and the pot still settles,
   * the reward simply is not paid.
   */
  const rewardAuthority = rewardAuthorityPda();
  const vault = getAssociatedTokenAddressSync(MEMPIRE_MINT, rewardAuthority, true);
  let rewardVault: PublicKey | null = null;
  let winnerTokens: PublicKey | null = null;
  let rewardCount: PublicKey | null = null;
  const pre: TransactionInstruction[] = [];
  if (winner === 0 || winner === 1) {
    const conn = getConnection();
    const dest = getAssociatedTokenAddressSync(MEMPIRE_MINT, new PublicKey(players[winner]));
    const [vaultInfo, destInfo] = await Promise.all([
      conn.getAccountInfo(vault).catch(() => null),
      conn.getAccountInfo(dest).catch(() => null),
    ]);
    /*
     * Only worth naming when the vault can actually pay: an ATA costs rent to
     * open, and opening one to receive nothing is a fee for no reward.
     * The balance is a u64 at offset 64 of a token account.
     */
    const vaultHasTokens = vaultInfo != null
      && vaultInfo.data.length >= 72
      && vaultInfo.data.readBigUInt64LE(64) > 0n;

    if (vaultHasTokens) {
      rewardVault = vault;
      winnerTokens = dest;
      /*
       * The win reward is capped per wallet, and the chain counts it in a PDA
       * addressed by the winner. It cannot be seeded inside settlement — the
       * winner is only known once the log is read — so it is opened here in the
       * same transaction. Idempotent, so a repeat winner just passes theirs.
       */
      rewardCount = rewardCountPda(new PublicKey(players[winner]));
      pre.push(await program.methods
        .initRewardCount(new PublicKey(players[winner]))
        .accounts({
          rewardCount,
          payer: wallet.publicKey!,
          systemProgram: SystemProgram.programId,
        } as any)
        .instruction());
      /*
       * The winner may never have held $MEMPIRE, and on mainnet that is the
       * *normal* case rather than the edge one — there is no faucet, and this
       * reward is precisely how a new player gets their first. They therefore
       * have no associated token account, and the old code read that as "no
       * reward" and skipped it. The bootstrap failed for exactly the people it
       * was built for, invisibly, because every devnet wallet already holds
       * $MEMPIRE from the faucet.
       *
       * So open it here. Idempotent because the check above races anyone else
       * settling the same match — a plain create would throw on the loser.
       * The settler pays the rent; that is a few thousand lamports against a
       * pot they are already paying to settle.
       */
      if (!destInfo) {
        pre.push(createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey!, dest, new PublicKey(players[winner]), MEMPIRE_MINT,
        ));
      }
    }
  }

  const signature = await program.methods
    .settleFromLog()
    .accounts({
      config: configPda(),
      matchAccount: matchPda(matchId),
      matchLog: baseLogPda(matchId),
      settler: wallet.publicKey!,
      playerA: new PublicKey(players[0]),
      playerB: new PublicKey(players[1]),
      treasury: new PublicKey(cfg.treasury),
      rewardAuthority,
      rewardCount,
      rewardVault,
      winnerTokens,
      tokenProgram: rewardVault ? TOKEN_PROGRAM_ID : null,
    } as any)
    .preInstructions(pre)
    .remainingAccounts(deckAccounts.map((pubkey) => ({
      pubkey, isWritable: true, isSigner: false,
    })))
    .rpc();
  return { signature };
}

/**
 * Mint several cards in as few transactions as the wire allows.
 *
 * A staked match needs eight minted cards, and one-at-a-time that is eight
 * wallet prompts and eight confirmations before a player can enter a single
 * pot. Most people would give up at three, which made the whole staking path
 * something the UI promised and almost nobody reached.
 *
 * `card` is a PDA over `config.next_card_id`, which the program increments per
 * mint, so the ids inside one transaction have to be predicted rather than
 * read — they are strictly sequential from whatever `next_card_id` is when the
 * transaction is built, which is exactly what the loop below assumes. Any
 * concurrent mint by someone else invalidates the batch, and the whole
 * transaction fails rather than half-minting: `MINTS_PER_TX` is kept small so
 * a retry is cheap.
 *
 * Returns one signature per transaction sent, and reports partial progress
 * through `onProgress` so a long batch is not a frozen button.
 */
const MINTS_PER_TX = 3;

export async function mintDeckTx(
  adapter: Adapter | null,
  mints: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ signatures: string[]; minted: number }> {
  const wallet = requireSigner(adapter);
  const program = getProgram(adapter);
  const owner = wallet.publicKey!;
  const signatures: string[] = [];
  let minted = 0;

  for (let i = 0; i < mints.length; i += MINTS_PER_TX) {
    const chunk = mints.slice(i, i + MINTS_PER_TX);

    // Re-read between chunks. The previous transaction moved `next_card_id`,
    // and deriving the next batch from a stale config would collide with the
    // cards we just created.
    const cfg = await fetchConfig();
    if (!cfg) throw new Error('Program config not found on this cluster');

    const ixs = await Promise.all(chunk.map(async (m, k) => {
      const mintKey = new PublicKey(m);
      /*
       * Same rule as the single mint above, and it was missed here: naming a
       * token account that has never been created fails account resolution
       * before the program is reached. Holding the coin stopped being a
       * requirement at the pivot, so *not* holding it is now the common case
       * — which made this the common case too.
       */
      const ata = getAssociatedTokenAddressSync(mintKey, owner);
      const holdsIt = await getConnection().getAccountInfo(ata).catch(() => null);
      return program.methods
        .mintCard()
        .accounts({
          config: configPda(),
          coinInfo: coinPda(mintKey),
          card: cardPda(cfg.nextCardId + k),
          ownerTokens: holdsIt ? ata : null,
          owner,
          treasury: new PublicKey(cfg.treasury),
          systemProgram: SystemProgram.programId,
        } as any)
        .instruction();
    }));

    const tx = new Transaction().add(...ixs);
    const sig = await (program.provider as AnchorProvider).sendAndConfirm!(tx, []);
    signatures.push(sig);
    minted += chunk.length;
    onProgress?.(minted, mints.length);
  }

  track('card.mint', { count: minted, batched: true });
  return { signatures, minted };
}

/**
 * Every card account currently locked to a given match.
 *
 * A `memcmp` against the `locked_by` field rather than fetching the whole card
 * set and filtering here: the collection grows without bound and this sits on
 * the critical path of paying somebody their pot.
 */
export async function cardsLockedTo(match: PublicKey): Promise<PublicKey[]> {
  const program = getProgram(null);
  // Card layout after the 8-byte discriminator: id 8, owner 32, coin_mint 32,
  // archetype 1, staked_tokens 8, staked_micro_usd 8, level 1,
  // pending_unstake_tokens 8, unstake_ready_at 8 — then `locked_by`.
  const LOCKED_BY_OFFSET = 8 + 8 + 32 + 32 + 1 + 8 + 8 + 1 + 8 + 8;
  const rows = await (program.account as any).card.all([
    { memcmp: { offset: LOCKED_BY_OFFSET, bytes: match.toBase58() } },
  ]);
  return rows.map((r: { publicKey: PublicKey }) => r.publicKey);
}
