import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { buyPass, claimTier, readSeason, type SeasonView } from '../chain/season';
import { readableChainError } from '../chain/account';
import { useChain } from '../state/chain';
import { useWallet } from '../state/wallet';
import { Pill } from './ui';

/*
 * The season pass, honestly.
 *
 * A pass is spent $MEMPIRE — it goes to the treasury and does not come back —
 * and in return each tier of staked wins this season claims a golden chest.
 * Progress is read from the arena (`MempireArena.wins` since you bought), so
 * nothing here is a score the app made up. It is a game mechanic: it says
 * nothing about what $MEMPIRE is worth, and it has no resale value.
 */

const left = (endsAt: number) => {
  const s = Math.max(0, endsAt - Math.floor(Date.now() / 1000));
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h left` : `${h}h ${Math.floor((s % 3600) / 60)}m left`;
};

export function SeasonPassPanel() {
  const address = useWallet((s) => s.address);
  const connected = useWallet((s) => s.connected);
  const mempire = useChain((s) => s.mempireBalance);
  const refresh = useChain((s) => s.refresh);
  const [season, setSeason] = useState<SeasonView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSeason(await readSeason(connected && address ? address as Address : null));
      setError(null);
    } catch (e) {
      setSeason(null);
      setError(readableChainError(e));
    }
  }, [address, connected]);
  useEffect(() => { void load(); }, [load]);

  if (!season) return error ? (
    <section aria-label="Season pass" className="panel" style={{ padding: '10px 12px' }}>
      <p className="fine" role="alert">The season pass could not be read. {error}</p>
      <Pill onClick={() => void load()}>Try again</Pill>
    </section>
  ) : null;
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setError(null);
    try { await fn(); await Promise.all([load(), refresh()]); } catch (e) { setError(readableChainError(e)); } finally { setBusy(null); }
  };
  const open = Date.now() / 1000 >= season.startsAt && Date.now() / 1000 < season.endsAt;
  const top = season.tiers[season.tiers.length - 1];
  const canAfford = mempire >= Number(season.priceLabel.replace(/,/g, ''));

  return (
    <section aria-label="Season pass" className="panel" style={{ padding: '10px 12px', display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span className="display display--sm" style={{ fontSize: 17 }}>Season {season.id} pass</span>
        <span className="label" style={{ marginLeft: 'auto', fontSize: 11 }}>{open ? left(season.endsAt) : 'closed'}</span>
      </div>
      <span className="fine" style={{ fontSize: 12, color: 'var(--dim-on-wood)' }}>Staked wins unlock golden chests</span>
      <details className="fine" style={{ fontSize: 11, color: 'var(--dim-on-wood)' }}>
        <summary style={{ cursor: 'pointer' }}>Details</summary>
        Tiers: {season.tiers.map((t) => `${t} win${t === 1 ? '' : 's'}`).join(' · ')}. Only staked wins after you buy count, read from the arena contract.
        The {season.priceLabel} $MEMPIRE goes to the treasury: it is spent, not invested, has no resale value and says nothing about what $MEMPIRE is worth.
      </details>
      {season.hasPass ? (
        <>
          <div aria-label={`Season progress: ${season.progress} of ${top} wins`} style={{ height: 10, borderRadius: 999, background: 'var(--recess)', border: '2px solid var(--ink)', overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(100, (season.progress / top) * 100)}%`, height: '100%', background: 'linear-gradient(90deg, var(--btn-gold-hi), var(--btn-gold))' }} />
          </div>
          <span className="fine" style={{ fontSize: 12 }}>{season.progress} staked win{season.progress === 1 ? '' : 's'} since you bought the pass</span>
          <div role="list" aria-label="Season tiers" style={{ display: 'grid', gridTemplateColumns: `repeat(${season.tiers.length}, 1fr)`, gap: 6 }}>
            {season.tiers.map((t, i) => {
              const reached = season.progress >= t;
              return (
                <div role="listitem" key={t} style={{ display: 'grid', gap: 4, justifyItems: 'center' }}>
                  <span className="label" style={{ fontSize: 11 }}>{t} win{t === 1 ? '' : 's'}</span>
                  {season.claimed[i] ? (
                    <span className="label" style={{ fontSize: 11, color: 'var(--teal)' }}>✓ claimed</span>
                  ) : (
                    <Pill
                      ghost={!reached}
                      disabled={!reached || !open || busy !== null}
                      onClick={() => void run(`claim${i}`, () => claimTier(season, i))}
                      style={{ minHeight: 36, padding: '4px 8px', fontSize: 12 }}
                    >
                      {busy === `claim${i}` ? '…' : reached ? 'Claim chest' : '🔒'}
                    </Pill>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <Pill
          disabled={!open || !connected || busy !== null || !canAfford}
          onClick={() => void run('buy', () => buyPass(address as Address, season))}
          style={{ minHeight: 42, fontSize: 15 }}
        >
          {busy === 'buy' ? 'Buying…' : !canAfford ? `Needs ${season.priceLabel} $MEMPIRE` : `Buy pass · ${season.priceLabel} $MEMPIRE`}
        </Pill>
      )}
      {error && <p className="fine" role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--red-on-wood)' }}>{error}</p>}
    </section>
  );
}
