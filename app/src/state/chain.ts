import { create } from 'zustand';
import type { Adapter } from '@solana/wallet-adapter-base';
import {
  fetchCardsFor, fetchConfig, fetchRegisteredCoins, fetchSolBalance, fetchTokenBalances,
  type ChainCard, type ChainCoin, type ChainConfig,
} from '../chain/read';
import { CLUSTER, IS_MAINNET, canSign, explorerUrl } from '../chain/provider';
import { apiFetch, hasApi } from '../lib/api';
import { overlayLivePrices } from '../lib/coins';
import { useWallet } from './wallet';

/**
 * Onchain state, and the app's honesty about whether it has any.
 *
 * `mode` is the important field. Three values, and the UI must say which one it
 * is in rather than implying everything is real:
 *
 *  - `offline`   — the program could not be reached. Play continues simulated.
 *  - `simulated` — reachable, but this wallet cannot sign (Guest). Reads are
 *                  real, writes are local.
 *  - `onchain`   — reachable and signable. Cards are PDAs, fees are paid, the
 *                  explorer link in the UI resolves.
 *
 * Nothing here writes. Writes live in `chain/actions.ts` so a failed transaction
 * cannot leave this store half-updated; the flow is always act → refresh.
 */

export type ChainMode = 'offline' | 'simulated' | 'onchain';

interface ChainState {
  mode: ChainMode;
  cluster: string;
  loading: boolean;
  /** Last read failure. Not fatal — the app falls back to simulated play. */
  error: string | null;
  config: ChainConfig | null;
  coins: ChainCoin[];
  cards: ChainCard[];
  /** Real SPL balances by mint, for the wallet in `owner`. */
  balances: Map<string, number>;
  solBalance: number;
  owner: string | null;
  lastSignature: string | null;

  /** Reads config + registry. Safe with no wallet; call once at boot. */
  init: () => Promise<void>;
  /** Reads the connected wallet's cards, balances and SOL. */
  loadWallet: (owner: string, adapter: Adapter | null) => Promise<void>;
  /** Re-reads just the wallet-scoped data after a transaction lands. */
  refresh: () => Promise<void>;
  /**
   * Re-read until the chain has caught up with a transaction that just landed.
   *
   * `refresh` once, straight after a confirmed signature, is not enough:
   * `getProgramAccounts` indexing runs a slot or two behind confirmation, so
   * the read returns the pre-transaction state and nothing ever reads again.
   * A card would mint, the transaction would confirm, and the header would
   * keep saying "not minted onchain yet" until the page was reloaded — the
   * write was real and the screen disagreed with it.
   */
  refreshSettled: () => Promise<void>;
  clearWallet: () => void;
  noteSignature: (sig: string) => void;
  explorer: (idOrSig: string, kind?: 'tx' | 'address') => string;
  /** A card the player owns onchain, by its numeric PDA id. */
  cardById: (id: number) => ChainCard | undefined;
}

export const useChain = create<ChainState>((set, get) => ({
  mode: 'offline',
  cluster: CLUSTER,
  loading: false,
  error: null,
  config: null,
  coins: [],
  cards: [],
  balances: new Map(),
  solBalance: 0,
  owner: null,
  lastSignature: null,

  init: async () => {
    set({ loading: true, error: null });

    /*
     * Mainnet prices are real, so they must come from a market, not a bundle.
     * Overlaid before the first store write so the first painted number is
     * already live; refreshed on an interval because money paths read
     * `priceUsd` at click time and drift compounds quietly. Devnet keeps its
     * fixed reference prices and the disclosure that says so.
     */
    if (IS_MAINNET && hasApi()) {
      const refresh = async () => {
        try {
          const res = await apiFetch('/api/coins');
          const body = res && res.ok ? await res.json() : null;
          if (Array.isArray(body?.coins)) overlayLivePrices(body.coins);
        } catch { /* stale prices beat no app; the next tick retries */ }
      };
      await refresh();
      setInterval(() => { void refresh(); }, 5 * 60_000);
    }

    try {
      const [config, coins] = await Promise.all([fetchConfig(), fetchRegisteredCoins()]);
      if (!config) {
        set({ mode: 'offline', loading: false, error: 'Program not initialized on this cluster' });
        return;
      }
      set({
        config,
        coins,
        loading: false,
        error: null,
        // A successful read leaves `offline` immediately — otherwise a retry
        // that worked would still wear the red dot until a wallet connected.
        mode: get().mode === 'offline' ? 'simulated' : get().mode,
      });
    } catch (e) {
      // A dead RPC must not take the game down with it.
      set({
        mode: 'offline',
        loading: false,
        error: e instanceof Error ? e.message : 'Could not reach the cluster',
      });
    }
  },

  loadWallet: async (owner, adapter) => {
    // Not `adapter !== null` any more: a guest with no adapter can still sign
    // on devnet through its own browser-held keypair, and calling that
    // 'simulated' would have the badge understating what the session can do.
    const signable = canSign(adapter);
    set({ loading: true, owner });
    try {
      if (!get().config) await get().init();
      const [cards, balances, solBalance] = await Promise.all([
        fetchCardsFor(owner),
        fetchTokenBalances(owner),
        fetchSolBalance(owner),
      ]);
      set({
        cards,
        balances,
        solBalance,
        loading: false,
        error: null,
        mode: get().config ? (signable ? 'onchain' : 'simulated') : 'offline',
      });
      // Push it into the wallet store so the Arena's stake tiers, the Empire
      // header and every "can you afford this" check read the real number.
      // Reading the balance and then not using it is how a wallet with 0.01
      // SOL was shown as holding 12.4.
      useWallet.getState().setChainBalance(solBalance);
    } catch (e) {
      set({
        loading: false,
        mode: 'offline',
        error: e instanceof Error ? e.message : 'Could not read wallet state',
      });
    }
  },

  refreshSettled: async () => {
    // Immediately, then twice more. Cheap, and covers the indexing lag without
    // making the UI wait on a poll loop before it shows anything at all.
    for (const delay of [0, 1500, 4000]) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      await get().refresh();
    }
  },

  refresh: async () => {
    const { owner, mode } = get();
    if (!owner || mode === 'offline') return;
    try {
      const [cards, balances, solBalance, config] = await Promise.all([
        fetchCardsFor(owner),
        fetchTokenBalances(owner),
        fetchSolBalance(owner),
        fetchConfig(),
      ]);
      set({ cards, balances, solBalance, config: config ?? get().config });
      useWallet.getState().setChainBalance(solBalance);
    } catch {
      // A failed refresh leaves the last good read in place rather than blanking
      // the collection — stale is better than empty here.
    }
  },

  clearWallet: () => set({
    owner: null, cards: [], balances: new Map(), solBalance: 0,
    mode: get().config ? 'simulated' : 'offline', lastSignature: null,
  }),

  noteSignature: (sig) => set({ lastSignature: sig }),
  explorer: (idOrSig, kind = 'tx') => explorerUrl(idOrSig, kind),
  cardById: (id) => get().cards.find((c) => c.id === id),
}));

/** True when a transaction would actually be submitted. */
export const isOnchain = (s: ChainState): boolean => s.mode === 'onchain';
