import { IS_MONAD_NETWORK } from '../chain/landing';
import { useMatch } from '../state/match';
import { usePlayLog, type PlayRecord } from '../state/playLog';

/*
 * Your moves, landing. Every card you drop is a transaction from the match's
 * session key; this shows the last few as they travel: sent → executed (the
 * receipt, with its measured ms) → final (Monad only, checked against the
 * finalized block). Driven entirely by the play log's real receipts — nothing
 * here advances on a timer. On the local fork it stops at "executed" and says
 * "fork", because the fork mines instantly and has no finality to measure.
 */

const STATE: Record<PlayRecord['state'], { bg: string; fg: string }> = {
  sent: { bg: 'var(--recess)', fg: 'var(--dim)' },
  executed: { bg: IS_MONAD_NETWORK ? 'var(--btn-blue)' : 'var(--teal)', fg: IS_MONAD_NETWORK ? 'var(--text)' : '#0d1120' },
  final: { bg: 'var(--btn-green)', fg: '#0d1120' },
  failed: { bg: 'var(--red)', fg: 'var(--text)' },
};

function label(p: PlayRecord): string {
  if (p.state === 'sent') return p.pool ? `in pool (${p.pool.toLowerCase()})` : 'sent…';
  if (p.state === 'failed') return 'not logged';
  if (p.state === 'final') return `exec ${p.executedMs} · final ${p.finalMs} ms`;
  return IS_MONAD_NETWORK ? `exec ${p.executedMs} ms · finalizing` : `${p.executedMs} ms · fork`;
}

export function PlayTicker() {
  const plays = usePlayLog((s) => s.plays);
  const phase = usePlayLog((s) => s.phase);
  const deck = useMatch((s) => s.playerDeck);
  if (phase === 'off' || plays.length === 0) return null;
  const recent = plays.slice(-3).reverse();
  return (
    <div
      role="log"
      aria-label="Your card plays landing on chain"
      aria-live="polite"
      style={{ display: 'flex', justifyContent: 'center', gap: 4, flexWrap: 'wrap', minHeight: 22 }}
    >
      {recent.map((p) => {
        const look = STATE[p.state];
        const name = deck?.[p.deckIndex]?.name;
        return (
          <span
            key={p.id}
            title={p.hash ? `tick ${p.tick} · ${p.hash}` : `tick ${p.tick}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px',
              borderRadius: 999, border: '2px solid var(--ink)', background: look.bg, color: look.fg,
              fontFamily: 'var(--font-mono)', fontSize: 10.5, whiteSpace: 'nowrap',
              transition: 'background 180ms var(--ease-snap)',
            }}
          >
            <b>{name ? `$${name}` : `card ${p.deckIndex + 1}`}</b>
            <span>{label(p)}</span>
          </span>
        );
      })}
    </div>
  );
}
