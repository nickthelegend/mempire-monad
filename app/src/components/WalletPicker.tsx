import { IS_MAINNET } from '../chain/provider';
import { useEffect, useMemo } from 'react';
import { click } from '../lib/audio';
import { listWallets, useWallet } from '../state/wallet';
import { Spinner } from './ui';

/** Guest mark — the only entry without an official adapter icon. */
function GuestMark({ size = 34 }: { size?: number }) {
  return (
    <img
      src="/art/avatar_guest.webp"
      alt=""
      aria-hidden
      width={size}
      height={size}
      style={{ display: 'block', borderRadius: 8 }}
    />
  );
}

/**
 * `busy` is the row the player actually tapped. Dimming every row equally while
 * one connects left no trace of which one was chosen — the only signal was a
 * 12px sub-line.
 */
function Row({
  onClick, disabled, busy, mark, title, sub, right, highlight,
}: {
  onClick: () => void; disabled?: boolean; busy?: boolean; mark: React.ReactNode;
  title: string; sub: string; right?: React.ReactNode; highlight?: boolean;
}) {
  return (
    <button
      onClick={() => { click(); onClick(); }}
      disabled={disabled}
      /* Every row here is an icon plus styled spans, and the tree was computing
         no accessible name at all from them — the whole connect step read as a
         stack of unlabelled buttons to a screen reader. */
      aria-label={`${title} — ${sub}`}
      className="btn-3d"
      style={{
        display: 'flex', alignItems: 'center', gap: 11, width: '100%',
        padding: '9px 13px', minHeight: 58, borderRadius: 'var(--r-card)',
        textAlign: 'left',
        background: highlight
          ? 'linear-gradient(180deg, var(--btn-blue-hi), var(--btn-blue))'
          : 'var(--recess)',
        border: `2.5px solid ${busy ? 'var(--gold)' : 'var(--ink)'}`,
        boxShadow: highlight
          ? 'inset 0 2px 0 rgba(255,255,255,.45), 0 4px 0 var(--btn-blue-dark)'
          : 'var(--bevel-in)',
        opacity: disabled && !busy ? 0.45 : 1,
      }}
    >
      {mark}
      <span style={{ minWidth: 0, flex: 1 }}>
        <span className="display display--sm" style={{ display: 'block', fontSize: 16 }}>
          {title}
        </span>
        <span className="fine" style={{ display: 'block', fontSize: 12, color: 'var(--dim)' }}>
          {sub}
        </span>
      </span>
      {right}
    </button>
  );
}

export function WalletPicker() {
  const { pickerOpen, closePicker, connect, connectGuest, connecting, error } = useWallet();
  // readyState is read once per open — adapters announce synchronously
  const wallets = useMemo(() => (pickerOpen ? listWallets() : []), [pickerOpen]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closePicker(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickerOpen, closePicker]);

  if (!pickerOpen) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', justifyContent: 'center' }}>
      <div aria-hidden onClick={closePicker} style={{ position: 'absolute', inset: 0, background: 'var(--scrim)' }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Connect a wallet"
        className="panel sheet"
        style={{ maxHeight: '90dvh', overflowY: 'auto', gap: 9 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 2 }}>
          <div>
            <h2 className="display" style={{ fontSize: 25, lineHeight: 1.1 }}>Connect Wallet</h2>
            <p className="fine" style={{ color: 'var(--dim-on-wood)' }}>{IS_MAINNET ? 'Mainnet · real funds move' : 'Devnet · no real funds move'}</p>
          </div>
          <button
            onClick={() => { click(); closePicker(); }}
            aria-label="Close"
            className="icon-btn"
            style={{ marginLeft: 'auto', color: 'var(--dim-on-wood)', fontSize: 27, width: 44, height: 44, flexShrink: 0 }}
          >
            ×
          </button>
        </div>

        {wallets.map((w) => {
          const busy = connecting === w.name;
          return (
            <Row
              key={w.name}
              highlight={w.installed}
              disabled={connecting !== null}
              busy={busy}
              onClick={() => void connect(w.name)}
              mark={(
                <img
                  src={w.icon}
                  alt=""
                  aria-hidden
                  width={34}
                  height={34}
                  style={{ display: 'block', borderRadius: 8 }}
                />
              )}
              title={w.name}
              sub={busy ? 'Approve in your wallet…' : w.installed ? 'Detected' : 'Not installed — get it'}
              right={busy ? <Spinner size={16} /> : (
                <span
                  className="label"
                  style={{ fontSize: 12, color: w.installed ? 'var(--teal)' : 'var(--dim)' }}
                >
                  {w.installed ? 'Ready' : 'Install'}
                </span>
              )}
            />
          );
        })}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '3px 2px' }}>
          <span style={{ flex: 1, height: 2, background: 'rgba(0,0,0,.3)' }} />
          <span className="label" style={{ fontSize: 12, color: 'var(--dim-on-wood)' }}>or</span>
          <span style={{ flex: 1, height: 2, background: 'rgba(0,0,0,.3)' }} />
        </div>

        <Row
          disabled={connecting !== null}
          onClick={connectGuest}
          mark={<GuestMark />}
          title="Play as Guest"
          sub={IS_MAINNET
            ? 'Play-only on mainnet — connect a wallet to mint or stake'
            : 'A real keypair in this browser — plays and stakes onchain'}
        />

        {error && (
          <p role="alert" className="fine" style={{ color: 'var(--red-on-wood)', textAlign: 'center' }}>{error}</p>
        )}
        <p className="fine" style={{ color: 'var(--dim-on-wood)', textAlign: 'center' }}>
          Mempire never asks for your seed phrase.
        </p>
      </div>
    </div>
  );
}
