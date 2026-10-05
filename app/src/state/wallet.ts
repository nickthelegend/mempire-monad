import {
  WalletAdapterNetwork, WalletReadyState, type Adapter,
} from '@solana/wallet-adapter-base';
import {
  CoinbaseWalletAdapter,
  NightlyWalletAdapter,
  PhantomWalletAdapter,
  SolflareWalletAdapter,
  TrustWalletAdapter,
} from '@solana/wallet-adapter-wallets';
import { create } from 'zustand';
import { guestAddress, guestWasActive, markGuestActive } from '../lib/identity';

/**
 * Wallet connection on the official Solana wallet adapters.
 *
 * Using the adapters directly rather than the React context provider keeps the
 * store as the single source of truth, and gives us each wallet's own official
 * icon (a base64 SVG the adapter ships) plus real readyState detection —
 * including Wallet Standard wallets the browser announces at runtime.
 *
 * Balances: real for a real wallet, simulated for a Guest.
 *
 * A connected wallet now shows what the chain says it holds, refreshed after
 * every transaction. It used to show a hardcoded 12.4 SOL for everybody, which
 * made the Arena's stake tiers a fiction — the game would happily let you
 * "stake 5 SOL" from an empty wallet, and the number never moved when a match
 * paid out because nothing had been paid.
 *
 * A Guest keeps a simulated balance on purpose: guest mode exists so the whole
 * game is playable with no wallet and no funds, and a guest cannot stake
 * anything anyway. `isGuest` is what the Arena reads to decide whether a tier
 * is real money or a scoreboard.
 */

import { IS_MAINNET } from '../chain/provider';

const NETWORK = IS_MAINNET ? WalletAdapterNetwork.Mainnet : WalletAdapterNetwork.Devnet;



/**
 * Guest identity is per **tab** (sessionStorage), not per browser.
 *
 * The matchmaker refuses to pair a wallet against itself — the program's
 * SelfMatch rule, mirrored — so two guest tabs sharing one hardcoded address
 * could never fight each other, which is exactly how PvP gets demoed on one
 * machine. The address is random but stable within the tab, so a mid-session
 * refresh keeps the same identity. Real wallets are untouched.
 */
/*
 * The guest's address is now a real ed25519 public key, generated in the
 * browser and kept alongside its secret key — see lib/identity.ts.
 *
 * It used to be forty random base58 characters: a string shaped like a pubkey
 * that nothing could sign for. That was fine while the API trusted whatever
 * address it was handed, and became a lockout the moment it started demanding
 * signatures — a guest would have had no ladder, no clan and no saved
 * progress. A guest identity is now exactly as provable as a wallet one.
 */

/**
 * Ordered by how likely a Solana player is to have it.
 *
 * Backpack is absent on purpose: it ships as a Wallet Standard wallet, so it
 * registers itself at runtime rather than needing a hardcoded adapter.
 *
 * Ledger is excluded deliberately — its adapter reaches for Node's Buffer at
 * construction and hard-crashes the picker in a browser, and a hardware wallet
 * is the wrong fit for a mobile meme-coin game anyway.
 */
function buildAdapters(): Adapter[] {
  return [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter({ network: NETWORK }),
    new CoinbaseWalletAdapter(),
    new TrustWalletAdapter(),
    new NightlyWalletAdapter(),
  ];
}

let adapters: Adapter[] = [];
export function getAdapters(): Adapter[] {
  if (!adapters.length) adapters = buildAdapters();
  return adapters;
}

export interface WalletChoice {
  name: string;
  icon: string; // official base64 SVG from the adapter
  installed: boolean;
  url: string;
}

/** Installed wallets first; everything else stays visible with an install link. */
export function listWallets(): WalletChoice[] {
  return getAdapters()
    .map((a) => ({
      name: a.name as string,
      icon: a.icon,
      installed: a.readyState === WalletReadyState.Installed,
      url: a.url,
    }))
    .sort((x, y) => Number(y.installed) - Number(x.installed));
}

/**
 * The adapter currently connected, or null for Guest / disconnected.
 *
 * Held outside the store deliberately: an Adapter is a live object with event
 * emitters, so putting it in zustand state would make every consumer re-render
 * on identity churn and would serialise badly. `signer()` is the accessor
 * everything onchain goes through.
 */
let activeAdapter: Adapter | null = null;

/** The adapter that can sign, or null when this session is simulated. */
export function signer(): Adapter | null {
  return activeAdapter;
}

interface WalletState {
  connected: boolean;
  connecting: string | null; // adapter name in flight
  error: string | null;
  address: string;
  walletName: string;
  walletIcon: string | null;
  sol: number;
  /**
   * True when this session is the browser-local keypair rather than a wallet
   * extension.
   *
   * It signs messages (lib/identity.ts) *and*, on devnet only, transactions
   * (chain/provider.ts `guestSigningWallet`) — so a guest genuinely mints and
   * stakes with real SOL. The stale claim here was "holds no funds and can
   * never submit a transaction", which is what put the false "play money" line
   * on the Empire tab.
   */
  isGuest: boolean;
  /**
   * The connected adapter's message signer, when it has one.
   *
   * Undefined for a guest, whose signing happens locally against the browser
   * keypair, and for the handful of adapters that support transactions but
   * not `signMessage`.
   */
  signMessage?: (msg: Uint8Array) => Promise<Uint8Array>;
  pickerOpen: boolean;
  openPicker: () => void;
  closePicker: () => void;
  connect: (name: string) => Promise<void>;
  connectGuest: () => void;
  autoConnect: () => Promise<void>;
  disconnect: () => void;
  spend: (amount: number) => boolean;
  receive: (amount: number) => void;
  /** Replace the balance with what the chain reports. No-op for a Guest. */
  setChainBalance: (sol: number) => void;
}

export const useWallet = create<WalletState>((set, get) => ({
  connected: false,
  connecting: null,
  error: null,
  address: '',
  walletName: '',
  walletIcon: null,
  sol: 0,
  isGuest: false,
  pickerOpen: false,

  openPicker: () => set({ pickerOpen: true, error: null }),
  closePicker: () => set({ pickerOpen: false, connecting: null }),

  connect: async (name) => {
    if (get().connecting) return;
    const adapter = getAdapters().find((a) => a.name === name);
    if (!adapter) {
      set({ error: `${name} is not available` });
      return;
    }
    if (adapter.readyState !== WalletReadyState.Installed
      && adapter.readyState !== WalletReadyState.Loadable) {
      window.open(adapter.url, '_blank', 'noopener,noreferrer');
      return;
    }

    set({ connecting: name, error: null });
    try {
      await adapter.connect();
      const pk = adapter.publicKey;
      if (!pk) throw new Error('wallet returned no public key');
      activeAdapter = adapter;
      set({
        connected: true, connecting: null, pickerOpen: false,
        address: pk.toBase58(),
        walletName: adapter.name as string,
        walletIcon: adapter.icon,
        // Zero until the chain says otherwise — `useChainSync` fills this in
        // from `getBalance` a moment later. Showing a made-up number in the
        // meantime is how the old build ended up letting an empty wallet
        // enter a 5 SOL match.
        sol: 0,
        isGuest: false,
        // Bound here rather than reached for at call time: `activeAdapter` is
        // module state and a disconnect race would sign with the wrong wallet.
        signMessage: typeof (adapter as { signMessage?: unknown }).signMessage === 'function'
          ? (msg: Uint8Array) => (adapter as unknown as {
            signMessage: (m: Uint8Array) => Promise<Uint8Array>;
          }).signMessage(msg)
          : undefined,
      });
      adapter.on('disconnect', () => get().disconnect());
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Connection failed';
      set({
        connecting: null,
        error: /reject|denied|cancel|user/i.test(msg) ? 'Connection rejected' : msg,
      });
    }
  },

  /** Browser-held keypair so the whole game is playable with nothing installed. */
  connectGuest: () => {
    activeAdapter = null;
    markGuestActive(true);
    set({
      connected: true, connecting: null, pickerOpen: false,
      address: guestAddress(), walletName: 'Guest', walletIcon: null,
      // Zero until the chain reports otherwise — the address is real.
      sol: 0, isGuest: true, signMessage: undefined,
    });
  },

  /** Silent reconnect for a wallet already trusted in this browser. */
  autoConnect: async () => {
    if (get().connected) return;
    for (const a of getAdapters()) {
      if (a.readyState !== WalletReadyState.Installed) continue;
      try {
        await a.autoConnect();
        if (!a.publicKey) continue;
        activeAdapter = a;
        set({
          connected: true,
          address: a.publicKey.toBase58(),
          walletName: a.name as string,
          walletIcon: a.icon,
          sol: 0,
          isGuest: false,
        });
        a.on('disconnect', () => get().disconnect());
        return;
      } catch {
        // not trusted yet — the picker handles it
      }
    }
    // No extension took the session. If this browser was already playing as a
    // guest, put it back: the keypair never left localStorage, so landing on
    // Connect Wallet after a refresh threw away a live identity — and, mid
    // match, the match with it.
    if (!get().connected && guestWasActive()) get().connectGuest();
  },

  disconnect: () => {
    markGuestActive(false);
    const name = get().walletName;
    const adapter = getAdapters().find((a) => a.name === name);
    void adapter?.disconnect().catch(() => { /* already gone */ });
    activeAdapter = null;
    set({
      connected: false, address: '', walletName: '', walletIcon: null,
      sol: 0, isGuest: false, pickerOpen: false,
    });
  },

  /**
   * Overwrite the balance with what the chain reports — for everyone.
   *
   * Guests are no longer excluded. A guest address is a real, fundable pubkey
   * that signs for itself on devnet, so it has a genuine balance and showing
   * it play money instead would be the same lie the hardcoded 12.4 was. An
   * unfunded guest sees 0 SOL, which is true, and Practice is free.
   */
  setChainBalance: (sol) => set({ sol: +sol.toFixed(4) }),

  /**
   * Can this wallet afford `amount`, and take it if so.
   *
   * A real wallet is only *checked*. Its balance belongs to the chain: the
   * escrow instruction moves the lamports and the next `getBalance` reports
   * it, so deducting here as well would show the stake leaving twice and the
   * invented half would disappear at the next refresh. A Guest's balance is
   * play money with no chain behind it, so it is genuinely debited here.
   */
  /**
   * Can this wallet afford `amount`.
   *
   * Purely a check now. Every balance in the app is the chain's, including a
   * guest's, so the escrow instruction moves the lamports and the next
   * `getBalance` reports it — deducting here as well would show the stake
   * leaving twice, and the invented half would vanish on the next refresh.
   */
  spend: (amount) => get().sol >= amount,
  /** Kept for unstaked matches, which move no real lamports to credit. */
  receive: () => { /* the chain is the only source of a balance */ },
}));
