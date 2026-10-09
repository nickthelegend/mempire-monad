import { useCallback, useEffect, useState } from 'react';
import { apiFetch, apiPost } from '../lib/api';
import { Pill } from './ui';

/*
 * Clan war, on the Clan screen.
 *
 * The bracket lives on the relay (server/clanwars.js). Only staked matches
 * whose settlement the relay has verified on chain score: 3 for a win, 1 for a
 * draw. One headline — this round's score against the opposing clan — and the
 * rules behind "Details".
 */

type Score = { points: number; wins: number; draws: number; losses: number };
type War = {
  _id: string;
  status: 'open' | 'running' | 'done';
  clans: string[];
  names: Record<string, string>;
  size: number;
  champion?: string;
  rounds: { pairs: [string, string][]; scores: Record<string, Score>; endsAt: number; winners?: string[] }[];
};
type Standing = { war: War | null; size: number; points: { win: number; draw: number; loss: number } };

const left = (endsAt: number) => {
  const m = Math.max(0, Math.floor((endsAt - Date.now()) / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}m left`;
};

export function ClanWarPanel({ tag, leader }: { tag: string; leader: boolean }) {
  const [standing, setStanding] = useState<Standing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await apiFetch(`/api/clan-wars/current?tag=${encodeURIComponent(tag)}`);
    if (!res) throw new Error('Clan wars need the relay.');
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? 'The bracket could not be read.');
    return body as Standing;
  }, [tag]);

  useEffect(() => {
    let live = true;
    const poll = () => load()
      .then((s) => { if (live) { setStanding(s); setError(null); } })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    void poll();
    const iv = setInterval(poll, 15_000);
    return () => { live = false; clearInterval(iv); };
  }, [load]);

  const enter = async () => {
    setBusy(true); setError(null);
    try {
      const res = await apiPost('/api/clan-wars/enter', 'clanwar.enter', {});
      if (!res) throw new Error('Sign in to enter.');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Entry failed.');
      setStanding(await load());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const war = standing?.war ?? null;
  const entered = war?.clans.includes(tag) ?? false;
  const round = war?.rounds.at(-1);
  const pair = round?.pairs.find((p) => p.includes(tag));
  const them = pair?.find((t) => t !== tag);
  const name = (t: string) => war?.names[t] ?? t;

  let headline = 'Reading the bracket…';
  let line: string | null = null;
  if (standing && !war) { headline = 'No war yet'; line = `${standing.size}-clan bracket · free entry`; }
  else if (war?.status === 'open') { headline = `${war.clans.length}/${war.size} clans`; line = entered ? 'Entered · starts when full' : 'Bracket filling'; }
  else if (war?.status === 'done') { headline = war.champion === tag ? 'Champions!' : `${name(war.champion ?? '')} won`; line = 'War over'; }
  else if (war && round && pair && them) {
    headline = `${round.scores[tag]?.points ?? 0} – ${round.scores[them]?.points ?? 0}`;
    line = `vs ${name(them)} · round ${war.rounds.length} · ${left(round.endsAt)}`;
  } else if (war && round) { headline = 'Knocked out'; line = `Round ${war.rounds.length} · ${left(round.endsAt)}`; }
  else if (!standing && error) headline = 'Bracket unavailable';

  return (
    <section aria-label="Clan war" className="panel" style={{ padding: '10px 12px', display: 'grid', gap: 6 }}>
      <span className="label" style={{ fontSize: 11 }}>Clan war</span>
      <span className="display display--sm" style={{ fontSize: 22 }}>{headline}</span>
      {line && <span className="fine" style={{ fontSize: 12 }}>{line}</span>}
      {error && standing && <span className="fine" role="alert" style={{ fontSize: 12, color: 'var(--red-on-wood)' }}>{error}</span>}
      {leader && (!entered || war?.status === 'done') && (
        <Pill disabled={busy} onClick={() => void enter()} style={{ minHeight: 40, fontSize: 14 }}>
          {busy ? 'Entering…' : 'Enter clan war'}
        </Pill>
      )}
      <details className="fine" style={{ fontSize: 11 }}>
        <summary style={{ cursor: 'pointer' }}>Details</summary>
        Staked matches settled on chain score {standing?.points.win ?? 3} for a win and {standing?.points.draw ?? 1} for a draw.
        Matches against clanmates don&apos;t count. The higher score advances when the round ends. Entry is free, with no pooled prize.
        {!leader && ' A leader or co-leader enters the clan.'}
        {round && war && (
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {round.pairs.map(([a, b]) => (
              <li key={a}>{name(a)} {round.scores[a]?.points ?? 0} – {round.scores[b]?.points ?? 0} {name(b)}</li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}
