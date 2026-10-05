import { IS_MAINNET } from '../chain/provider';
import { useEffect, useState } from 'react';
import { Pill } from './ui';
import { apiFetch, apiPost } from '../lib/api';
import { useChain } from '../state/chain';
import { useWallet } from '../state/wallet';

/**
 * The devnet starter kit: a little SOL and eight coins, once per address.
 *
 * # Why the game needs this
 *
 * "Your bags are your army" is the premise, and a wallet that has just arrived
 * has no bags. Minting a fighter requires holding its coin, so without this a
 * new player cannot mint a single card, cannot field a legal deck, and can
 * therefore never reach a staked match. Every screen worked and the loop was
 * unreachable — the worst kind of bug, because nothing looks broken.
 *
 * # Why it disappears
 *
 * It renders only when the wallet is genuinely empty and the faucet is
 * genuinely stocked. A permanent "free stuff" button trains people to look for
 * handouts on a screen that is meant to be about their own holdings, and a
 * button that fails because the faucet is dry is worse than no button.
 */
interface FaucetStatus {
  available: boolean;
  dripSol: number;
  /** Whole $MEMPIRE granted with the kit. The game's only currency. */
  dripMempire?: number;
  coins: string[];
  balanceSol?: number;
}

export function StarterKit() {
  /*
   * Devnet only, by definition. The kit is a faucet grant — free SOL and
   * coins — and no faucet exists (or should) where the tokens are money.
   * Returning null beats hiding it in CSS: the claim endpoint stays entirely
   * unreachable from a mainnet build.
   */
  if (IS_MAINNET) return null;

  const address = useWallet((s) => s.address);
  const sol = useWallet((s) => s.sol);
  const chainCards = useChain((s) => s.cards);
  const balances = useChain((s) => s.balances);
  const refresh = useChain((s) => s.refresh);
  const mode = useChain((s) => s.mode);

  const [status, setStatus] = useState<FaucetStatus | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'gone'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void apiFetch('/api/faucet')
      .then((r) => (r?.ok ? r.json() : null))
      .then((j) => { if (live && j) setStatus(j as FaucetStatus); })
      .catch(() => { /* no faucet configured — the button simply never shows */ });
    return () => { live = false; };
  }, []);

  /**
   * Can this wallet field a deck at all?
   *
   * Keyed on coins and cards, not on SOL. Holding coins is what `mint_card`
   * requires, so a wallet with plenty of SOL and no coins is exactly as stuck
   * as an empty one — and the first version of this gate checked `sol < 0.1`,
   * which meant a funded newcomer was told nothing and offered nothing.
   *
   * The SOL check survives only as an *or*: someone holding coins but unable
   * to pay eight mint fees is stuck too, just differently.
   */
  const holdsCoins = [...balances.values()].some((v) => v > 0);
  const canMintDeck = holdsCoins || chainCards.length >= 8;
  const empty = chainCards.length === 0 && (!canMintDeck || sol < 0.2);

  if (state === 'gone') return null;
  if (!address || mode === 'offline') return null;
  if (!status?.available) return null;
  if (!empty && state !== 'done') return null;

  if (state === 'done') {
    return (
      <section className="well" style={{ padding: '10px 12px', display: 'grid', gap: 4 }}>
        <span className="label" style={{ color: 'var(--teal)' }}>Bags delivered</span>
        <p className="fine" style={{ color: 'var(--dim)', margin: 0 }}>
          {status.dripSol} SOL{status.dripMempire
            ? `, ${status.dripMempire.toLocaleString()} $MEMPIRE`
            : ''} and {status.coins.length} coins are in your wallet. Mint any coin
          into a fighter below — you do not have to hold it — then your deck can
          enter a staked match.
        </p>
        <button
          type="button"
          className="fine"
          onClick={() => setState('gone')}
          style={{ background: 'none', border: 0, color: 'var(--dim)', cursor: 'pointer', padding: 0, textAlign: 'left' }}
        >
          dismiss
        </button>
      </section>
    );
  }

  return (
    <section className="well" style={{ padding: '10px 12px', display: 'grid', gap: 6 }}>
      <span className="label">Start with bags</span>
      <p className="fine" style={{ color: 'var(--dim)', margin: 0 }}>
        {/* Was "Your fighters are coins you hold, and this wallet holds none
            yet" — written when `mint_card` required a balance of the coin. It
            does not any more, so the sentence described a rule the program
            stopped enforcing, and it told a new player their empty wallet was
            the thing standing between them and a deck. It is not; the kit is
            just a head start. */}
        A wallet needs a little of everything to get going. Claim{' '}
        {status.dripSol} devnet SOL
        {status.dripMempire ? <>, {status.dripMempire.toLocaleString()} $MEMPIRE</> : null}
        {' '}and {status.coins.length} coins — {status.coins.slice(0, 4).join(', ')} and
        more — enough to mint a full deck, upgrade it, and enter a staked match.
        Devnet only, and worth nothing anywhere else.
      </p>
      <Pill
        tone="gold"
        disabled={state === 'busy'}
        onClick={() => {
          setState('busy');
          setError(null);
          void apiPost('/api/faucet', 'faucet', {})
            .then(async (r) => {
              if (!r) throw new Error('this session could not sign the request');
              const j = await r.json();
              if (!r.ok) throw new Error(j?.error ?? `faucet returned ${r.status}`);
              await refresh();
              setState('done');
            })
            .catch((e) => {
              setError(e instanceof Error ? e.message : String(e));
              setState('idle');
            });
        }}
      >
        {state === 'busy' ? 'Sending…' : 'Claim my starter bags'}
      </Pill>
      {error && <span className="fine" style={{ color: 'var(--red)' }}>{error}</span>}
    </section>
  );
}
