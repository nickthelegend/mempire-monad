import { useEffect } from 'react';
import { medianMs, useMonadHeads, type BlockChip, type CommitState } from '../lib/monadHeads';

/*
 * Monad's heartbeat, on screen: the last blocks of Monad testnet moving
 * Proposed → Voted → Finalized → Verified, with the milliseconds this browser
 * measured. It is a live read of the public network over WebSocket, labelled
 * as such, so it is honest whichever chain the game runs on — on the local fork
 * it shows the network the game will deploy to, not the fork.
 */

const LOOK: Record<CommitState, { bg: string; fg: string; label: string }> = {
  Proposed: { bg: 'var(--recess)', fg: 'var(--dim)', label: 'proposed' },
  Voted: { bg: 'var(--btn-blue)', fg: 'var(--text)', label: 'voted' },
  Finalized: { bg: 'var(--btn-green)', fg: '#0d1120', label: 'final' },
  Verified: { bg: 'var(--gold)', fg: '#0d1120', label: 'verified' },
};

const fmt = (ms: number | null) => (ms === null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`);

function Chip({ c }: { c: BlockChip }) {
  const look = LOOK[c.state];
  const ms = c.state === 'Verified' ? c.verifiedMs : c.state === 'Finalized' ? c.finalizedMs : c.state === 'Voted' ? c.votedMs : undefined;
  return (
    <span
      title={`block ${c.number} · ${look.label}${ms !== undefined ? ` after ${ms} ms` : ''} · ${c.hash.slice(0, 10)}…`}
      style={{
        display: 'inline-flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        width: '100%', minWidth: 0, padding: '3px 2px', borderRadius: 7, border: '2px solid var(--ink)',
        background: look.bg, color: look.fg, transition: 'background 160ms var(--ease-snap)',
        fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: 1.15,
      }}
    >
      <span style={{ fontWeight: 700 }}>{String(c.number).slice(-4)}</span>
      <span style={{ fontSize: 9, opacity: 0.9 }}>{c.state === 'Verified' ? '✓' : ms !== undefined ? `${ms}ms` : look.label}</span>
    </span>
  );
}

export function MonadPipeline({ compact = false }: { compact?: boolean }) {
  const retain = useMonadHeads((s) => s.retain);
  const chips = useMonadHeads((s) => s.chips);
  const history = useMonadHeads((s) => s.history);
  const status = useMonadHeads((s) => s.status);
  useEffect(() => retain(), [retain]);

  const voted = medianMs(history, 'votedMs');
  const final = medianMs(history, 'finalizedMs');
  const shown = chips.slice(0, compact ? 5 : 7).reverse();

  return (
    <section
      aria-label="Monad testnet block pipeline"
      className="well"
      style={{ padding: compact ? '6px 8px' : '8px 10px', display: 'grid', gap: 6 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          aria-hidden
          style={{
            width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
            background: status === 'live' ? 'var(--teal)' : status === 'unavailable' ? 'var(--red)' : 'var(--dim)',
            boxShadow: status === 'live' ? '0 0 6px var(--teal)' : 'none',
          }}
        />
        <span className="label" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
          Monad testnet heartbeat{status === 'live' ? '' : status === 'unavailable' ? ' · reconnecting' : ' · connecting'}
        </span>
        <span className="fine" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--dim)', whiteSpace: 'nowrap' }}>
          read-only · live
        </span>
      </div>
      <div
        role="list"
        aria-label="latest blocks"
        style={{
          display: 'grid', gridTemplateColumns: `repeat(${compact ? 5 : 7}, minmax(0, 1fr))`,
          gap: 4, minHeight: 34, alignItems: 'center',
        }}
      >
        {shown.length
          ? shown.map((c) => <span role="listitem" key={c.blockId} style={{ minWidth: 0 }}><Chip c={c} /></span>)
          : (
            <span className="fine" style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--dim)' }}>
              {status === 'unavailable' ? 'Monad testnet WebSocket unreachable — retrying' : 'waiting for the next block…'}
            </span>
          )}
      </div>
      {!compact && (
        <p className="fine" style={{ margin: 0, fontSize: 11, color: 'var(--dim)' }}>
          A block is <b style={{ color: 'var(--text)' }}>voted in {fmt(voted)}</b> and{' '}
          <b style={{ color: 'var(--text)' }}>final in {fmt(final)}</b> — measured in this browser from{' '}
          <code style={{ fontSize: 10 }}>monadNewHeads</code>. Every card you play is one of these transactions.
        </p>
      )}
    </section>
  );
}
