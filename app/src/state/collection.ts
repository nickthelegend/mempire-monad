import { create } from 'zustand';
import { COINS, coinByMint } from '../lib/coins';
import { archetypeForMint } from '../sim/archetypes';
import type { Archetype } from '../sim/types';

export const FEES = {
  mintSol: 0.02,
  rakePct: 10,
  tieRakePct: 5,
};

// Devnet demo cooldown — mainnet is 72h; 60s here so judges can see the flow.

export interface MintedCard {
  id: string;
  mint: string; // coin mint
  archetype: Archetype;

  level: number;

  /**
   * A starter card, not something the player minted.
   *
   * These exist so a deck is fieldable before anyone spends anything, and they
   * merge alongside the real chain cards (see `useChainSync`). Anything asking
   * "has this coin been minted?" has to exclude them, or the answer is yes for
   * all eight starters and their Mint buttons vanish before they were ever used.
   */
  seeded?: boolean;
}

interface CollectionState {
  cards: MintedCard[];
  nextId: number;
  mintCard: (mint: string) => MintedCard | null;
  card: (id: string) => MintedCard | undefined;
}

/*
 * The starter deck: eight cards so a first run has something to play.
 *
 * These used to carry invented staked balances and derive a level from them,
 * which was the old economy — hold the coin, lock it, buy a level. Levels now
 * come only from winning and merging duplicates, so a starter card is simply
 * a level-1 card. Nothing here pretends to hold anything.
 */
export const seedCards = (): MintedCard[] =>
  COINS.slice(0, 8).map((c, i) => ({
    id: `card_${i + 1}`,
    mint: c.mint,
    archetype: archetypeForMint(c.mint),
    level: 1,
    seeded: true,
  }));

export const useCollection = create<CollectionState>((set, get) => ({
  cards: seedCards(),
  nextId: 9,
  mintCard: (mint) => {
    const coin = coinByMint(mint);
    if (!coin) return null;
    const card: MintedCard = {
      id: `card_${get().nextId}`,
      mint,
      archetype: archetypeForMint(mint),
      level: 1,
    };
    set((s) => ({ cards: [...s.cards, card], nextId: s.nextId + 1 }));
    return card;
  },
  card: (id) => get().cards.find((c) => c.id === id),
}));
