import { create } from 'zustand';
import { COINS, isEligible } from '../lib/coins';
import {
  bytesToHex, deriveDrops, hexToBytes, localSeed, tierFromSeed,
} from '../lib/chestDrop';
import { useCollection } from './collection';
import { forget, remind } from '../lib/native';

/**
 * Chests — what winning pays out.
 *
 * # Crowns are gone
 *
 * This store used to hold `gems`: a soft currency granted freely, spent on
 * shop cards and rerolls, never touching the chain. The argument for it was
 * that a currency the game *spends* should not be repriced by traders. The
 * argument against it was on screen the whole time — a header reading
 * `0 $MEMPIRE` beside `120 ♛`, where the number players watched was the one
 * that did not exist. There is one currency now and it is the SPL token; see
 * `state/mempire.ts`.
 *
 * Chests therefore pay in **cards**, not currency. That is also the better
 * game: a chest you open for a fighter you can field is a reason to play the
 * next match, and a chest that pays a number is a reason to check a balance.
 *
 * The rule that survives unchanged: nothing bought here may sell stats. Power
 * comes from playing, so a paying player never out-levels a skilled one.
 */

export type ChestTier = 'silver' | 'golden' | 'magic' | 'legendary';

export interface ChestDef {
  tier: ChestTier;
  name: string;
  unlockMs: number;
  cards: number;
  /** Relative weight when a win rolls a chest. */
  weight: number;
  colors: [string, string];
}

/** What actually came out — the def plus the cards it minted, by ticker. */
export interface OpenedChest extends ChestDef {
  droppedTickers: string[];
  /** The seed these drops came from, so the reward screen can show it. */
  seed: string;
  source: 'vrf' | 'local';
}

export const CHESTS: Record<ChestTier, ChestDef> = {
  silver: {
    tier: 'silver', name: 'Silver Chest', unlockMs: 15 * 60_000,
    cards: 1, weight: 62, colors: ['#dfe8f5', '#8b9dbb'],
  },
  golden: {
    tier: 'golden', name: 'Golden Chest', unlockMs: 3 * 3_600_000,
    cards: 2, weight: 26, colors: ['#ffd766', '#c8890b'],
  },
  magic: {
    tier: 'magic', name: 'Magic Chest', unlockMs: 8 * 3_600_000,
    cards: 3, weight: 9, colors: ['#c77dff', '#6a2fb5'],
  },
  legendary: {
    tier: 'legendary', name: 'Legendary Chest', unlockMs: 12 * 3_600_000,
    cards: 4, weight: 3, colors: ['#7cf6d8', '#12a88a'],
  },
};

export const CHEST_SLOTS = 4;

/** Tier index → name, matching `TIER_WEIGHTS` in the program. */
export const TIER_ORDER: ChestTier[] = ['silver', 'golden', 'magic', 'legendary'];

/** Devnet demo pacing: minutes, not hours, so a judge sees the whole loop. */
import { IS_MAINNET } from '../chain/provider';

/**
 * Devnet demo pacing: an hour-long unlock plays out in a minute. On mainnet
 * the chest card states its real unlock time, so it must run at 1:1 — a
 * "12h legendary" that opens in 12 minutes would be the UI lying about the
 * scarcity the whole chest economy is priced on.
 */
export const DEMO_TIME_SCALE = IS_MAINNET ? 1 : 1 / 60;

export interface ChestSlot {
  id: string;
  tier: ChestTier;
  /** 0 = not started, else the timestamp it finishes unlocking. */
  readyAt: number;
  unlocking: boolean;
  /**
   * True while the oracle's answer for this chest is still in flight.
   *
   * The tier shown before the oracle replies is a local roll, and the player
   * could start its timer — which `reconcileNewestChest` refuses to overwrite,
   * so one tap took whichever of the two rolls they preferred. On the single
   * outcome the house is supposed to decide, `max(local, vrf)` was available
   * for free. A rolling chest is not actionable until its roll lands.
   */
  rolling?: boolean;
  /**
   * Where this chest's tier came from.
   *
   * `vrf` means a MagicBlock oracle rolled it and `randomness` holds the bytes
   * that produced it, so anyone can re-derive the result. `local` means this
   * session cannot sign — Guest play — and the roll was made in the browser.
   *
   * Recorded rather than assumed because the difference is the whole claim: a
   * chest is only "provably fair" if it actually went through the oracle, and
   * a UI that shows the same badge either way is lying about the one mechanic
   * where the house picks the outcome.
   */
  source: 'vrf' | 'local';
  /**
   * The 32 bytes this chest's contents are derived from, hex-encoded.
   *
   * Always present, whatever the provenance. A local seed is still a *recorded*
   * seed, which means the drop is a published function of something written down
   * rather than of an unrecorded `Math.random()` — the difference between "we
   * picked fairly, trust us" and "here is the input, check it yourself".
   *
   * `source` says who produced it. Only `vrf` was attested by the oracle, and
   * only `vrf` earns the fairness claim in the UI.
   */
  seed: string;
}

/** Skipping the wait is the product. Price scales with time left. */
export function skipCost(remainingMs: number): number {
  const hours = remainingMs / 3_600_000;
  return Math.max(1, Math.ceil(hours * 18));
}

interface EconomyState {
  chests: ChestSlot[];
  nextChestId: number;

  /**
   * Awards a chest, seeded locally.
   *
   * No `roll` parameter: the seed decides both tier and contents by the same
   * rule the program uses, so one recorded input explains the whole chest.
   */
  awardChest: () => { tier: ChestTier; id: string } | null;
  /**
   * Puts a chest of a stated tier in a free slot, having been paid for.
   *
   * Separate from `awardChest` because a bought chest is not a roll. What the
   * confirmation dialog names is what lands: paying a fixed price for a random
   * tier would make that dialog a claim about value it cannot keep. The seed
   * still decides the *contents* — the purchase buys a golden chest, not a
   * particular set of cards out of it.
   */
  buyChest: (tier: ChestTier) => void;
  startUnlock: (id: string) => void;
  skipUnlock: (id: string) => boolean;
  collect: (id: string) => OpenedChest | null;
  /**
   * Upgrades the newest chest from a local roll to the oracle's answer.
   *
   * The result screen awards optimistically so it never waits on an async
   * callback; this is what makes that honest. If the tier changed, the oracle
   * wins — it is the authority — and the chest stops claiming to be local.
   */
  reconcileChest: (id: string, tier: number, randomness: string) => void;
  /** The oracle is not coming — settle this chest on the roll it already has. */
  settleLocalChest: (id: string) => void;
}

/**
 * Mint the cards a chest contains, derived from its recorded seed.
 *
 * Not a roll. `deriveDrops` is a pure function of (seed, eligible list in
 * registry order, owned set), so the contents of any chest can be re-derived
 * and checked afterwards — which is the whole reason the oracle's bytes are
 * stored on the chest rather than consumed and thrown away.
 *
 * Unowned coins are drawn first and without replacement: a drop that teaches a
 * new card beats a duplicate. That preference is part of the published rule, not
 * a thumb on the scale, and duplicates become possible again once the collection
 * fills out (Clash's dupes feed upgrades; ours feed extra stake vessels for the
 * same coin).
 */
function dropCards(n: number, seed: Uint8Array): string[] {
  const { cards, mintCard } = useCollection.getState();
  const eligible = COINS.filter((c) => isEligible(c));
  if (!eligible.length) return [];
  const owned = new Set(cards.map((c) => c.mint));
  const picks = deriveDrops(seed, eligible, owned, n);
  const out: string[] = [];
  for (const pick of picks) {
    if (mintCard(pick.mint)) out.push(pick.ticker);
  }
  return out;
}


export const useEconomy = create<EconomyState>((set, get) => ({
  chests: [],
  nextChestId: 1,

  /** Called on a win. Returns null when every slot is full — that's the hook. */
  awardChest: () => {
    if (get().chests.length >= CHEST_SLOTS) return null;
    const seed = localSeed();
    // Same weighting the on-chain callback applies, so a locally-seeded chest
    // has the published odds rather than merely similar ones.
    const tier = TIER_ORDER[tierFromSeed(seed)] ?? 'silver';
    // Seeded at birth, locally, so the contents are already fixed and recorded
    // before the oracle has answered. If the oracle does answer, `reconcile`
    // replaces both the tier and the seed with its attested pair — a chest is
    // never left with a tier from one source and contents from another.
    const id = `chest_${get().nextChestId}`;
    set((s) => ({
      chests: [...s.chests, {
        id, tier, readyAt: 0, unlocking: false,
        source: 'local', seed: bytesToHex(seed), rolling: true,
      }],
      nextChestId: s.nextChestId + 1,
    }));
    return { tier, id };
  },

  buyChest: (tier) => {
    // Deliberately not capped at CHEST_SLOTS. A win can land a chest during the
    // few seconds a purchase spends being signed, and the alternative is taking
    // someone's tokens and handing them nothing — the one outcome a paid flow
    // must never produce. Paid-for goods always land; the rail grows a slot to
    // show it. `awardChest` still respects the cap, because a *won* chest that
    // has nowhere to go is only a missed reward.
    const seed = localSeed();
    set((s) => ({
      chests: [...s.chests, {
        id: `chest_${s.nextChestId}`, tier, readyAt: 0, unlocking: false,
        // `local`, not `vrf` — the tier was bought rather than rolled, so the
        // provably-fair badge would be claiming something about this chest
        // that is not true of it. The contents still derive from the seed.
        source: 'local', seed: bytesToHex(seed),
      }],
      nextChestId: s.nextChestId + 1,
    }));
  },

  startUnlock: (id) => {
    /*
     * Ask the Android shell to ring when this finishes.
     *
     * A chest is the one thing in this game worth interrupting someone for,
     * and it is also the one thing a web page cannot tell them about — once
     * the tab is backgrounded nothing in it runs. The reminder is tagged by
     * chest id so opening early can withdraw it; a notification that fires
     * for a chest already opened is worse than none.
     */
    const chest = get().chests.find((c) => c.id === id);
    const busy = get().chests.some((c) => c.unlocking && c.readyAt > Date.now());
    if (chest && !busy) {
      const def = CHESTS[chest.tier];
      remind(
        `chest:${id}`,
        `${def.name} is ready`,
        `${def.cards} ${def.cards === 1 ? 'card is' : 'cards are'} waiting in your empire.`,
        (def.unlockMs * DEMO_TIME_SCALE) / 1000,
      );
    }
    return set((s) => ({
      // one at a time, like the games this borrows from
      chests: s.chests.some((c) => c.unlocking && c.readyAt > Date.now())
        ? s.chests
        : s.chests.map((c) => (c.id === id
          ? {
            ...c,
            unlocking: true,
            readyAt: Date.now() + CHESTS[c.tier].unlockMs * DEMO_TIME_SCALE,
          }
          : c)),
    }));
  },

  /**
   * Open a chest now. The caller has already been charged.
   *
   * Deliberately free at this layer. This used to also spend Crowns, from
   * before $MEMPIRE was the price — so a skip took 25 $MEMPIRE on chain and
   * *then* asked for a second currency that could silently refuse. Crowns are
   * gone entirely now, but the rule they broke is worth keeping written down.
   *
   * The price is stated once, in `ConfirmSpend`, and collected once. Anything
   * charging again below that is a second price nobody agreed to.
   */
  skipUnlock: (id) => {
    const chest = get().chests.find((c) => c.id === id);
    if (!chest) return false;
    // The chest is open now, so the reminder is no longer true.
    forget(`chest:${id}`);
    set((s) => ({
      chests: s.chests.map((c) => (c.id === id ? { ...c, unlocking: true, readyAt: 0 } : c)),
    }));
    return true;
  },

  collect: (id) => {
    const chest = get().chests.find((c) => c.id === id);
    if (!chest) return null;
    forget(`chest:${id}`);
    const ready = chest.unlocking && chest.readyAt <= Date.now();
    if (!ready) return null;
    const def = CHESTS[chest.tier];
    set((s) => ({ chests: s.chests.filter((c) => c.id !== id) }));
    // The chest's card count mints real cards, not a number on a toast — and
    // which ones is derived from the seed the chest has been carrying since it
    // was awarded, so the contents were fixed before the player pressed OPEN.
    const dropped = dropCards(def.cards, hexToBytes(chest.seed));
    return { ...def, droppedTickers: dropped, seed: chest.seed, source: chest.source };
  },

  reconcileChest: (id, tier, randomness) => {
    const resolved = TIER_ORDER[tier] ?? 'silver';
    // Check the oracle rather than trusting it. The tier the program wrote must
    // be the tier its own randomness produces under the published weights; if it
    // is not, something between the oracle and the account is wrong and this
    // chest should keep the local roll it already has rather than adopt a number
    // that does not follow from its bytes.
    try {
      const expected = tierFromSeed(hexToBytes(randomness));
      if (expected !== tier) {
        console.warn(
          `chest: oracle reported tier ${tier} but its randomness derives ${expected} — keeping the local roll`,
        );
        return;
      }
    } catch {
      return;
    }
    set((s) => {
      /*
       * The chest this roll was for, not whichever is newest.
       *
       * "Newest" was also wrong on its own terms: a chest bought or won while
       * the oracle was answering would receive somebody else's randomness.
       * The roll is bound to an id now, and a rolling chest is not something
       * the player can have started — so the old `unlocking || readyAt` guard,
       * which is what made the veto possible, is no longer load-bearing and is
       * gone.
       */
      const i = s.chests.findIndex((c) => c.id === id);
      if (i === -1) return s;
      const chests = [...s.chests];
      chests[i] = {
        ...chests[i], tier: resolved, source: 'vrf', seed: randomness, rolling: false,
      };
      return { chests };
    });
  },

  settleLocalChest: (id) => set((s) => ({
    chests: s.chests.map((c) => (c.id === id ? { ...c, rolling: false } : c)),
  })),

}));
