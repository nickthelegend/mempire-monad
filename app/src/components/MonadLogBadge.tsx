import { usePlayLog, type LogPhase } from '../state/playLog';
import { DEPLOYMENT, explorerUrl } from '../chain/provider';
import { IS_MONAD_NETWORK } from '../chain/landing';

/*
 * What the chain has of this match, said in one pill.
 *
 * "on Monad · 7 · exec 310 ms · final 620 ms" means seven card plays are in
 * blocks, the last one executed 310 ms after it left the player's hand and was
 * final 620 ms after. On the local fork it reads "local fork · 7 · 40 ms": the
 * fork mines instantly and has no finality to measure, so it says so. The latency is measured, not
 * quoted: send-to-receipt on the player's own connection. Plays that could not
 * be logged are counted beside it rather than hidden, and a lost checkpoint is
 * reported separately, because it is a different and smaller failure — the
 * audit trail thins, the record of play does not.
 */

const LOOK: Record<LogPhase, { dot: string; text: string; title: string }> = {
  off: { dot: 'var(--dim)', text: 'local sim', title: 'No session key — the match runs locally' },
  live: {
    dot: 'var(--teal)',
    text: IS_MONAD_NETWORK ? 'on Monad' : 'local fork',
    title: IS_MONAD_NETWORK
      ? 'Every card play is a Monad transaction from this match’s session key'
      : 'Every card play is a transaction on the local fork of Monad testnet — instant mining, so these are not Monad timings',
  },
  done: { dot: 'var(--teal)', text: 'logged', title: 'The match’s plays are on chain' },
};

export function MonadLogBadge() {
  const phase = usePlayLog((s) => s.phase);
  const confirmed = usePlayLog((s) => s.confirmed);
  const playsLost = usePlayLog((s) => s.playsLost);
  const marksLost = usePlayLog((s) => s.marksLost);
  const latency = usePlayLog((s) => s.lastLatencyMs);
  const lastHash = usePlayLog((s) => s.lastHash);
  const finalMs = usePlayLog((s) => s.lastFinalMs);
  if (phase === 'off') return null;
  const look = LOOK[phase];

  const shell: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '3px 9px', borderRadius: 999,
    background: 'var(--recess)', border: '2px solid var(--ink)',
    boxShadow: 'var(--bevel-in)', textDecoration: 'none', color: 'inherit',
  };

  const body = (
    <>
      <span
        aria-hidden
        style={{
          width: 6, height: 6, borderRadius: '50%', background: look.dot,
          boxShadow: `0 0 6px ${look.dot}`, flexShrink: 0,
        }}
      />
      <span className="label" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
        {look.text}
        {confirmed > 0 && ` · ${confirmed}`}
        {latency !== null && (IS_MONAD_NETWORK ? ` · exec ${latency} ms` : ` · ${latency} ms`)}
        {IS_MONAD_NETWORK && finalMs !== null && ` · final ${finalMs} ms`}
        {playsLost > 0 && ` · ${playsLost} unlogged`}
        {marksLost > 0 && ` · ${marksLost} unmarked`}
      </span>
    </>
  );

  const href = (lastHash ? explorerUrl(lastHash, 'tx') : DEPLOYMENT ? explorerUrl(DEPLOYMENT.arena, 'address') : undefined) ?? null;
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" title={`${look.title} — open the latest one`} style={shell}>
      {body}
    </a>
  ) : (
    <span title={look.title} style={shell}>{body}</span>
  );
}
