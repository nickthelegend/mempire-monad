import { useEffect } from 'react';
import { useChain } from './chain';
import { seedCards, useCollection, type MintedCard } from './collection';
import { useDeck } from './deck';
import { useLadder } from './ladder';
import { signer, useWallet } from './wallet';
import { COINS } from '../lib/coins';
import { MATCH_STATE_SETTLED, fetchMatchByAddress } from '../chain/read';
import { releaseCardsTx } from '../chain/actions';
import { canSign } from '../chain/provider';
import { ensureChestRail } from '../chain/erActions';

/**
 * Keeps onchain state in step with the wallet.
 *
 * Boots the registry read once regardless of connection, because a visitor who
 * has connected nothing should still see the real coin registry — that read needs
 * no signer. Then loads wallet-scoped data whenever the address changes.
 *
 * Mounted once, in Shell.
 */
export function useChainSync(): void {
  const address = useWallet((s) => s.address);
  const connected = useWallet((s) => s.connected);
  const isGuest = useWallet((s) => s.isGuest);
  const init = useChain((s) => s.init);
  const loadWallet = useChain((s) => s.loadWallet);
  const clearWallet = useChain((s) => s.clearWallet);

  useEffect(() => { void init(); }, [init]);

  // Ladder standing is per-wallet and read-only here; the match store writes it.
  useEffect(() => {
    if (connected && address) {
      void useLadder.getState().load(address);
      void useLadder.getState().loadTop();
    } else {
      useLadder.getState().reset();
    }
  }, [connected, address]);

  useEffect(() => {
    if (!connected || !address) { clearWallet(); return; }
    // A guest signs through its own browser-held keypair, so it is passed the
    // same null adapter a wallet-less session has — `canSign` resolves the
    // difference downstream.
    void loadWallet(address, isGuest ? null : signer());
  }, [connected, address, isGuest, loadWallet, clearWallet]);

  useChestRail();

  useChainCollection();
}

/**
 * Have the chest rail ready before any match can end.
 *
 * `end_log` credits the winner's chest entitlement only when the winner's rail
 * is passed as an optional account, and `endLogEr` only passes it when that
 * rail is already delegated to the same rollup as the log. The rail was being
 * created in two places, both too late to be reliable:
 *
 *  - `openOnchainMatch`, which only the player who *creates* the match runs.
 *    The opponent who joins never sets one up, so whenever the joiner won, the
 *    entitlement had nowhere to go.
 *  - `rollChestOnchain`, which runs *after* the match has already settled —
 *    by then `end_log` has been and gone.
 *
 * The failure was silent all the way down: no rail meant no entitlement, no
 * entitlement meant `request_chest` was refused with `NoChestEarned`, and that
 * error was swallowed by a bare catch. Every chest quietly fell back to a local
 * roll and no surface anywhere said why — the 🎲 "rolled by MagicBlock VRF"
 * badge simply never appeared for anyone.
 *
 * Readiness of the rail is a property of the *player*, not of a match, so it
 * belongs here: once per connected wallet, idempotent, and long before any
 * match needs it. `ensureChestRail` no-ops when the rail already exists and is
 * delegated, so this costs one account read on a warm wallet.
 */
function useChestRail(): void {
  const connected = useWallet((s) => s.connected);
  const address = useWallet((s) => s.address);
  const mode = useChain((s) => s.mode);

  useEffect(() => {
    /*
     * Guests get chests too.
     *
     * This skipped `isGuest` on the grounds that a guest "signs locally and
     * never reaches the rollup" — but a guest holds a real ed25519 keypair and
     * `getProvider(null)` builds a signing wallet from it, which is how a guest
     * signs `create_match` and escrows a real stake. Nothing in
     * `ensureChestRail` wants a wallet extension; it is the same
     * `requireSigner`/`baseProgram` path.
     *
     * The cost of the gate was that guests — the default way into this game,
     * and so most players who will ever open it — could never be credited a
     * VRF chest. `end_log` only pays an entitlement into a delegated rail, so
     * the 🎲 badge was unreachable for them no matter how many matches they won.
     *
     * Offline still returns early: there is no chain there to prepare on.
     */
    if (!connected || !address || mode !== 'onchain') return;
    let live = true;
    void (async () => {
      try {
        const adapter = signer();
        if (!canSign(adapter)) return;
        await ensureChestRail(adapter);
        if (live) console.info('chest rail ready — wins can be rolled by VRF');
      } catch (e) {
        // Non-fatal, and now audible. A wallet that cannot prepare its rail
        // still plays; it just keeps the honest local roll, and says so.
        console.warn('chest rail not ready — chests will use a local roll:', e);
      }
    })();
    return () => { live = false; };
  }, [connected, address, mode]);
}

/**
 * Make the collection *be* the wallet's on-chain cards.
 *
 * Without this the two never met. The collection was seeded locally from the
 * coin registry and saved to the player row, while the actual minted `Card`
 * PDAs lived on chain — and the two sets had almost no mints in common. So a
 * player looked at eight fighters, picked eight for a deck, and the Arena
 * reported "8 of your cards are not minted onchain yet", because none of the
 * cards they were shown were the ones they owned.
 *
 * That is the game failing quietly: the fighters on screen have to be the
 * cards the wallet actually owns on chain, or the collection is fiction.
 *
 * The local collection survives for exactly one case — a wallet with no minted
 * cards at all, where the seeded set is what lets someone see the game before
 * spending anything. The moment a real card exists, the chain wins.
 */
function useChainCollection(): void {
  const cards = useChain((s) => s.cards);
  const mode = useChain((s) => s.mode);

  useEffect(() => {
    if (mode === 'offline' || cards.length === 0) return;

    const mapped: MintedCard[] = cards.map((c) => ({
      // Keyed on the PDA id so the mapping is stable across reloads and two
      // cards for the same coin can never collide.
      id: `chain_${c.id}`,
      mint: c.mint,
      archetype: c.archetype as MintedCard['archetype'],
      level: c.level,
    }));

    /**
     * Chain cards, plus a seeded card for every coin not yet minted.
     *
     * Replacing the collection outright was a trap. A wallet with one minted
     * card ended up with a one-card collection, `repoint` could fill exactly
     * one deck slot, and `deck needs 8 cards` then blocked every mode —
     * including free Practice, which had worked a moment earlier. Minting your
     * first fighter, the thing the app tells you to do, locked you out of the
     * game, and the only way back was minting seven more distinct coins.
     *
     * So the chain still wins for any coin it knows about, and the seeded card
     * survives for the rest. An unminted card is honest about what it is: the
     * Arena already reports "N of your cards are not minted onchain yet" and
     * holds the match to rating only, which is precisely the pre-mint state.
     */
    const onChainMints = new Set(mapped.map((c) => c.mint));
    const merged: MintedCard[] = [
      ...mapped,
      ...seedCards().filter((s) => !onChainMints.has(s.mint)),
    ];

    const current = useCollection.getState().cards;
    const collectionMatches = current.length === merged.length
      && current.every((c, i) => c.id === merged[i].id && c.level === merged[i].level);

    const fieldableMints = new Set(COINS.map((c) => c.mint));
    // Cards that exist *and* this build can field. A card whose coin was
    // registered after this client was built passes the first test and fails
    // the second, and a deck holding one is just as dead as a deck holding a
    // dangling id — so staleness has to mean both, or the re-point below never
    // runs for the case that needs it most.
    const valid0 = new Set(
      merged.filter((c) => fieldableMints.has(c.mint)).map((c) => c.id),
    );
    const deckNow = useDeck.getState();
    // Checked separately from the collection because the two are restored by
    // different effects and either can land first — this way whichever runs
    // last still leaves both consistent.
    const deckStale = [deckNow.active, ...deckNow.slots]
      .some((slot) => slot.some((id) => !valid0.has(id)));

    if (collectionMatches && !deckStale) return;

    if (!collectionMatches) {
      useCollection.setState({ cards: merged, nextId: merged.length + 1 });
    }

    // Re-point the decks at the cards that now exist. A deck naming ids from
    // the old local set would be eight dangling references, which reads to the
    // player as their deck having been wiped.
    const deck = useDeck.getState();
    const valid = new Set(merged.map((c) => c.id));

    /**
     * Only cards this build can actually field.
     *
     * The coin registry lives on chain and keeps growing; the client ships with
     * whatever list it was built against. A card minted from a coin registered
     * after that build is real, owned, and completely unusable here —
     * `buildDecks` resolves every deck card's mint against `COINS` and returns
     * null on the first miss, which surfaces as "your deck has retired cards"
     * with no way to fix it, because the offending card cannot be rendered on
     * the Deck tab either.
     *
     * Auto-filling a deck with one of those manufactured exactly that dead end.
     * The card stays in the collection — the player does own it — but it is
     * never chosen for them.
     */
    const usable = merged.filter((c) => fieldableMints.has(c.mint));

    const cardById = new Map(merged.map((c) => [c.id, c]));

    /**
     * Re-point one deck slot, preferring cards that actually exist on chain.
     *
     * Keeping whatever was saved is not enough. A staked match requires all
     * eight deck cards to be minted, so a single seeded starter squatting in a
     * slot is the difference between escrow opening and the match dropping to
     * "ladder only" — and that is what happened: a wallet holding ten minted
     * coins queued with seven seeded cards, matched a real opponent, and
     * neither side staked a lamport. The deck had simply never been rebuilt
     * after they minted, because the saved one was still fillable.
     *
     * So a seeded card is swapped out whenever there is a minted coin free to
     * take its place. Seeded cards remain the fallback for a wallet that has
     * not minted anything — they are what makes the game playable before you
     * spend — but they never hold a slot a real card could occupy.
     */
    const repoint = (slot: string[]): string[] => {
      const kept = slot.filter((id) => valid.has(id) && usable.some((c) => c.id === id));
      const usedMints = new Set(kept.map((id) => cardById.get(id)?.mint));

      // Minted, fieldable, and not already represented — one card per coin.
      const spare = mapped
        .filter((c) => fieldableMints.has(c.mint) && !usedMints.has(c.mint));

      const promoted = kept.map((id) => {
        const card = cardById.get(id);
        if (!card?.seeded) return id;
        const swap = spare.shift();
        if (!swap) return id;
        usedMints.delete(card.mint);
        usedMints.add(swap.mint);
        return swap.id;
      });

      if (promoted.length >= 8) return promoted.slice(0, 8);

      // Still short: fill from anything left, minted first (`merged` is ordered
      // chain-then-seeded), one card per coin.
      for (const c of usable) {
        if (promoted.length >= 8) break;
        if (!promoted.includes(c.id) && !usedMints.has(c.mint)) {
          promoted.push(c.id);
          usedMints.add(c.mint);
        }
      }
      return promoted;
    };

    const slots = deck.slots.map(repoint);
    useDeck.setState({ slots, active: repoint(deck.active) });

    /*
     * Free cards still locked to a match that has already settled.
     *
     * Settlement frees exactly the card accounts it was handed, so a match
     * settled by the other player leaves this wallet's eight cards naming it
     * forever. The deck then cannot be fielded and nothing in the app fixes
     * it — a real wallet was found with eight cards locked to a settled match
     * and no way out short of a script.
     *
     * The program lets anyone pay for `release_cards` once a match is settled,
     * so the client can clean up after itself without the opponent online.
     * Best-effort and never awaited: it is housekeeping, and a failure leaves
     * exactly the state that was already there.
     */
    const stuck = cards.filter((c) => c.inMatch && c.lockedBy);
    if (stuck.length) {
      void (async () => {
        const byMatch = new Map<string, number[]>();
        for (const c of stuck) {
          if (!c.lockedBy) continue;
          byMatch.set(c.lockedBy, [...(byMatch.get(c.lockedBy) ?? []), c.id]);
        }
        for (const [address, ids] of byMatch) {
          try {
            const m = await fetchMatchByAddress(address);
            if (!m || m.state !== MATCH_STATE_SETTLED) continue;
            await releaseCardsTx(signer(), m.id, ids);
            await useChain.getState().refresh();
          } catch { /* housekeeping — the lock simply stays until next time */ }
        }
      })();
    }
  }, [cards, mode]);
}
