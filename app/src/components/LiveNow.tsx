import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { shortAddr } from '../lib/format';

/*
 * Staked matches being played right now, each one watchable from the chain.
 * The relay only says which matches are live and when they started; the
 * spectator screen reads the plays from the arena itself.
 */

interface Live { matchId: number; startAt: number; format: 'standard' | 'rush'; seats: [string, string] }

export function LiveNow() {
  const nav = useNavigate();
  const [rows, setRows] = useState<Live[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => apiFetch('/api/live')
      .then((r) => (r?.ok ? r.json() : { matches: [] }))
      .then((j: { matches: Live[] }) => { if (alive) setRows(j.matches ?? []); })
      .catch(() => { if (alive) setRows([]); });
    void load();
    const iv = setInterval(load, 5000);
    return () => { alive = false; clearInterval(iv); };
  }, []);
  if (rows.length === 0) return null;
  return (
    <section aria-label="Live now" className="well" style={{ padding: '8px 12px', display: 'grid', gap: 6 }}>
      <span className="label" style={{ fontSize: 12, color: 'var(--teal)' }}>● Live now · watch from the chain</span>
      {rows.slice(0, 3).map((m) => (
        <button
          key={m.matchId}
          type="button"
          onClick={() => nav(`/watch/${m.matchId}`)}
          aria-label={`Watch match #${m.matchId} live`}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', minHeight: 36,
            background: 'none', border: 0, borderTop: '1px solid var(--border)', color: 'inherit', cursor: 'pointer', textAlign: 'left',
          }}
        >
          <span className="mono" style={{ fontSize: 12, flex: 1 }}>#{m.matchId} · {shortAddr(m.seats[0])} vs {shortAddr(m.seats[1])}{m.format === 'rush' ? ' · rush' : ''}</span>
          <span className="label" style={{ fontSize: 11, color: 'var(--teal)' }}>👁 watch</span>
        </button>
      ))}
    </section>
  );
}
