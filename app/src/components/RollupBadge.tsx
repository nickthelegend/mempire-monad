import { useErMatch, type ErPhase } from '../state/erMatch';
import { explorerUrl } from '../chain/provider';

/**
 * What layer this match is running on.
 *
 * The rollup is the difference between "a game with a token" and a game whose
 * moves are onchain, so the battle HUD says which one is true right now — and
 * says `degraded` out loud when the rollup dropped, rather than letting a green
 * light imply the log is complete when it has gaps.
 */
const LOOK: Record<ErPhase, { dot: string; text: string; title: string }> = {
  off: { dot: 'var(--dim)', text: 'local sim', title: 'No signing wallet — the match runs locally' },
  preparing: { dot: 'var(--gold)', text: 'delegating…', title: 'Handing the match log to a rollup' },
  live: { dot: 'var(--teal)', text: 'rollup live', title: 'Card plays are landing on a MagicBlock ephemeral rollup' },
  committing: { dot: 'var(--gold)', text: 'committing…', title: 'Sealing the log and returning it to Solana' },
  committed: { dot: 'var(--teal)', text: 'committed', title: 'The log is back on Solana and settlement can read it' },
  degraded: { dot: 'var(--red)', text: 'rollup down', title: 'The rollup is unreachable — play continues, the log has gaps' },
};

export function RollupBadge() {
  const phase = useErMatch((s) => s.phase);
  const sealed = useErMatch((s) => s.sealed);
  const writes = useErMatch((s) => s.writes);
  const playsLost = useErMatch((s) => s.playsLost);
  const marksLost = useErMatch((s) => s.marksLost);
  const log = useErMatch((s) => s.logAddress);

  // Nothing to say before a rollup is involved at all.
  if (phase === 'off') return null;
  const look = LOOK[phase];

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
        {phase === 'live' && writes > 0 && ` · ${writes}`}
        {/* A padlock only when the permission actually took. A match whose seal
            failed still plays, and claiming privacy it does not have would be
            the one lie this badge exists to prevent. */}
        {phase === 'live' && sealed && ' 🔒'}
        {/*
            Say which thing was lost.
            A single counter fed by both card plays and state-hash checkpoints
            rendered "N lost" beside the play count, so a player whose plays all
            landed was told two of them had vanished. They are not the same
            failure: a lost play is missing from the onchain record of the
            match, while a lost checkpoint only thins the audit trail —
            settlement reads the final hash, which is written at the end.
        */}
        {playsLost > 0 && ` · ${playsLost} lost`}
        {marksLost > 0 && ` · ${marksLost} unmarked`}
      </span>
    </>
  );

  const shell: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '3px 9px', borderRadius: 999,
    background: 'var(--recess)', border: '2px solid var(--ink)',
    boxShadow: 'var(--bevel-in)', textDecoration: 'none', color: 'inherit',
  };

  // Once the log exists onchain the claim is checkable, so link to it.
  if (log && (phase === 'live' || phase === 'committed')) {
    return (
      <a
        href={explorerUrl(log, 'address')}
        target="_blank"
        rel="noopener noreferrer"
        title={`${look.title} — view the match log onchain`}
        style={shell}
      >
        {body}
      </a>
    );
  }

  const title = phase === 'live' && sealed
    ? `${look.title}, sealed to the two players (PER)`
    : look.title;
  return <span title={title} style={shell}>{body}</span>;
}
