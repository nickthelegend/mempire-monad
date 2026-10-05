/**
 * Binds the game stores to the persistence API.
 *
 * Mounted once from the Shell. Loading is keyed on wallet address, so a player
 * gets their empire back on any device; a wallet with no saved state falls back
 * to the seeded starter collection already in the store.
 */
import { useEffect, useRef } from 'react';
import { coinByMint } from '../lib/coins';
import { loadPlayer, savePlayer, type SavedState } from '../lib/persist';
import { useCollection, type MintedCard } from './collection';
import { useChain } from './chain';
import { useDeck, DECK_SLOTS } from './deck';
import { bytesToHex, localSeed } from '../lib/chestDrop';
import { useEconomy } from './economy';
import { useMatch } from './match';
import { useShop } from './shop';
import { useWallet } from './wallet';

/**
 * Saved state can be older than the coin registry. When the devnet mints were
 * replaced with the real seeded ones, every card persisted before the swap
 * pointed at a mint that no longer exists — and `coin.ticker` on undefined
 * crashed the Battle button for exactly the returning players who had the most
 * invested. Migration rule: cards from retired mints are dropped on load, deck
 * lists are re-pointed at surviving cards, and a deck left short is refilled
 * from the collection (one card per coin) so the player is never handed a deck
 * that cannot fight.
 */
function migrate(saved: SavedState): SavedState {
  const cards = (saved.cards ?? []).filter((c) => coinByMint(c.mint));
  const dropped = (saved.cards?.length ?? 0) - cards.length;
  if (dropped > 0) {
    console.info(`[sync] dropped ${dropped} card(s) from retired mints`);
  }

  const ids = new Set(cards.map((c) => c.id));

  /**
   * Repair a saved deck — and only repair it.
   *
   * The refill exists for one situation: a card in the deck referred to a mint
   * that has since been retired, so the deck came back short through no choice
   * of the player's. Filling the gap is right there.
   *
   * It used to refill *any* deck under eight, which silently reverted every
   * deliberately short deck on load. Take a card out, refresh, and it was back
   * — the save had worked perfectly and the loader put it straight back. That
   * is worse than not saving at all, because the player watches their edit
   * apply and only discovers later that it never held.
   *
   * So the refill is now conditional on something actually having been lost.
   * `removed` counts entries the deck named that no longer exist; when it is
   * zero the deck is returned exactly as the player left it, short or not.
   */
  const fixDeck = (deck: string[] | undefined): string[] => {
    const named = deck ?? [];
    const kept = named.filter((id) => ids.has(id));
    const removed = named.length - kept.length;
    if (kept.length >= 8 || removed === 0) return kept.slice(0, 8);

    // Backfill only what retirement took, one card per coin, favouring what
    // is already in the deck.
    const usedMints = new Set(kept.map((id) => cards.find((c) => c.id === id)?.mint));
    let toAdd = removed;
    for (const c of cards) {
      if (toAdd <= 0 || kept.length >= 8) break;
      if (!kept.includes(c.id) && !usedMints.has(c.mint)) {
        kept.push(c.id);
        usedMints.add(c.mint);
        toAdd -= 1;
      }
    }
    return kept;
  };

  return {
    ...saved,
    cards,
    deck: fixDeck(saved.deck),
    slots: (saved.slots ?? []).map(fixDeck),
  };
}

export function usePlayerSync(): void {
  const address = useWallet((s) => s.address);
  const connected = useWallet((s) => s.connected);
  const loadedFor = useRef<string | null>(null);

  // Load on connect (once per address).
  useEffect(() => {
    if (!connected || !address || loadedFor.current === address) return;
    loadedFor.current = address;
    let cancelled = false;
    void loadPlayer(address).then((raw) => {
      if (cancelled || !raw) return;
      const saved = migrate(raw);

      /**
       * The chain owns the collection when the chain has anything to say.
       *
       * `useChainCollection` maps the wallet's actual `Card` PDAs into the
       * collection and re-points the decks at them. This load would then
       * overwrite that with the saved local set, whose ids and mints are a
       * different universe — and the Arena would report every card in the deck
       * as "not minted onchain", because the cards on screen were not the ones
       * the wallet owns.
       *
       * Progress that is genuinely local — chests, crowns, shop state — is
       * still restored below. Only the card list and the deck ids defer.
       */
      const chainOwns = useChain.getState().cards.length > 0;

      if (!chainOwns && saved.cards?.length) {
        useCollection.setState({
          cards: saved.cards as MintedCard[],
          nextId: saved.nextId || saved.cards.length + 1,
        });
      }
      if (!chainOwns && saved.deck?.length) {
        const slots = Array.from({ length: DECK_SLOTS }, (_, i) => saved.slots?.[i] ?? []);
        if (!slots[0]?.length) slots[0] = saved.deck.slice(0, 8);
        useDeck.setState({
          active: saved.deck.slice(0, 8),
          tier: saved.tier ?? 0,
          slots,
          slot: Math.min(Math.max(saved.slot ?? 0, 0), DECK_SLOTS - 1),
        });
      }
      if (typeof saved.sol === 'number' && Number.isFinite(saved.sol)) {
        useWallet.setState({ sol: saved.sol });
      }
      if (saved.history?.length) useMatch.setState({ history: saved.history });
      // Chest slots mid-unlock are real progress and must survive a reload —
      // absolute timestamps, so a timer that was running keeps running — along
      // with the day's shop state. The currency is no longer restored here:
      // $MEMPIRE is an SPL balance read from the chain, and a saved copy of it
      // would be a second, staler answer to a question the chain settles.
      if (Array.isArray(saved.chests)) {
        useEconomy.setState({
          // Chests saved before drops became seed-derived carry no seed, and
          // opening one would throw on decode. Backfilling a local seed keeps
          // them openable and — correctly — labels them as not oracle-rolled,
          // which is exactly what they were.
          chests: Array.isArray(saved.chests)
            ? saved.chests.map((c) => (c.seed
              ? c
              : { ...c, seed: bytesToHex(localSeed()), source: c.source ?? 'local' }))
            : [],
          nextChestId: saved.nextChestId || 1,
        });
      }
      if (saved.shop?.offers?.length) {
        // a stale day self-heals on the shop's next ensureFresh tick
        useShop.setState({
          offers: saved.shop.offers,
          day: saved.shop.day ?? useShop.getState().day,
          rerollsUsed: saved.shop.rerollsUsed ?? 0,
        });
      }
    });
    return () => { cancelled = true; };
  }, [connected, address]);

  // Save whenever anything meaningful changes (debounced inside savePlayer).
  useEffect(() => {
    if (!connected || !address) return;
    const push = () => {
      // Never persist mid-match. The stake leaves the balance at escrow and
      // returns at settle; a save between the two would freeze the money in
      // flight, and a refresh during a battle then silently ate the stake with
      // no result to show for it. Settlement changes status and history, which
      // triggers the save that captures the true post-match balance.
      const ms = useMatch.getState().status;
      if (ms === 'queuing' || ms === 'found' || ms === 'battle') return;
      const deck = useDeck.getState();
      const eco = useEconomy.getState();
      const shop = useShop.getState();
      savePlayer(address, {
        cards: useCollection.getState().cards,
        deck: deck.active,
        tier: deck.tier,
        slots: deck.slots,
        slot: deck.slot,
        sol: useWallet.getState().sol,
        nextId: useCollection.getState().nextId,
        history: useMatch.getState().history,
        chests: eco.chests,
        nextChestId: eco.nextChestId,
        shop: { offers: shop.offers, day: shop.day, rerollsUsed: shop.rerollsUsed },
      });
    };
    const unsubs = [
      useCollection.subscribe(push),
      useDeck.subscribe(push),
      useEconomy.subscribe(push),
      useShop.subscribe(push),
      useWallet.subscribe((s, p) => { if (s.sol !== p.sol) push(); }),
      useMatch.subscribe((s, p) => { if (s.history !== p.history || s.status !== p.status) push(); }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [connected, address]);

  // Reset to a clean slate when the wallet disconnects.
  useEffect(() => {
    if (connected) return;
    loadedFor.current = null;
  }, [connected]);
}
