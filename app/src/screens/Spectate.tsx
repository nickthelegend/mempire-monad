import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { IS_MONAD_NETWORK } from '../chain/landing';
import { DEPLOYMENT } from '../chain/provider';
import { MONAD_WS } from '../lib/monadHeads';
import { subscribeMatchLogs } from '../lib/monadLogs';
import { loadReplay, pollReplay, type ReplayBundle } from '../lib/replay';
import { shortAddr } from '../lib/format';
import { CHECKPOINT_EVERY, inputsByTick, newReplaySim, replayStep } from '../sim/replay';
import { TICKS_PER_SEC, type InputEvent, type SimState } from '../sim/types';
import { useMatch } from '../state/match';
import { BattleScene } from '../three/BattleScene';

/*
 * Watching a staked match while it is played — from the chain.
 *
 * The plays two people are making land on chain as they make them; this screen
 * reads them and runs the same deterministic sim a few seconds behind real
 * time, in the real arena, checking each state checkpoint the seats post as it
 * arrives. Nothing comes from the players' browsers: only the matchmaker's seed
 * and the decks (checked against the arena) come from the relay.
 *
 * On Monad itself, plays stream over `monadLogs`, shown as they are Proposed and
 * counted by commit state. On the local fork (no `monadLogs`), the arena's logs
 * are polled every second, and the screen says so.
 */

/** How far behind real time the spectator runs, so plays land before their tick. */
const LAG_TICKS = 3 * TICKS_PER_SEC;
const TICK_MS = 1000 / TICKS_PER_SEC;
const clock = (tick: number) => {
  const s = Math.max(0, Math.floor(tick / TICKS_PER_SEC));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const crownsOf = (sim: SimState): [number, number] => {
  let a = 0; let b = 0;
  for (const t of sim.towers) if (t.hp <= 0) { if (t.owner === 1) a += 1; else b += 1; }
  return [a, b];
};
const keyOf = (e: InputEvent) => `${e.player}:${e.tick}:${e.deckIndex}:${e.x}:${e.y}`;

export function Spectate() {
  const { id } = useParams();
  const matchId = Number(id);
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [bundle, setBundle] = useState<ReplayBundle | null>(null);
  const [tick, setTick] = useState(0);
  const [settled, setSettled] = useState(false);
  const [verified, setVerified] = useState<{ matched: number; diverged: number | null }>({ matched: 0, diverged: null });
  const [states, setStates] = useState<Record<string, number>>({}); // commit-state counts (Monad only)
  const inputs = useRef<InputEvent[]>([]);
  const seen = useRef(new Set<string>());
  const chainHashes = useRef(new Map<number, bigint>());
  const ourHashes = useRef(new Map<number, number>());
  const simRef = useRef<SimState | null>(null);
  const byTick = useRef(new Map<number, InputEvent[]>());

  // The arena reads the sim and decks from the match store; leave it idle after.
  useEffect(() => {
    if (useMatch.getState().status !== 'idle') useMatch.getState().dismiss();
    return () => { useMatch.setState({ sim: null }); };
  }, []);

  useEffect(() => {
    let live = true;
    const unsubs: (() => void)[] = [];

    const rebuild = (b: ReplayBundle, toTick: number) => {
      byTick.current = inputsByTick(inputs.current);
      ourHashes.current = new Map();
      const sim = newReplaySim({ ...b, inputs: inputs.current });
      while (sim.tick < toTick && sim.phase !== 'ended') {
        const h = replayStep(sim, byTick.current);
        if (h !== null) ourHashes.current.set(sim.tick, h);
      }
      simRef.current = sim;
      useMatch.setState({ sim, playerDeck: b.decks[0], botDeck: b.decks[1], perspective: 0 });
    };
    const recheck = () => {
      let matched = 0; let diverged: number | null = null;
      for (const [t, want] of chainHashes.current) {
        const got = ourHashes.current.get(t);
        if (got === undefined) continue;
        if (BigInt(got) === want) matched += 1; else if (diverged === null || t < diverged) diverged = t;
      }
      setVerified({ matched, diverged });
    };
    const addInputs = (b: ReplayBundle, more: InputEvent[]) => {
      let late = false;
      for (const e of more) {
        const k = keyOf(e);
        if (seen.current.has(k)) continue;
        seen.current.add(k);
        inputs.current.push(e);
        if (simRef.current && e.tick < simRef.current.tick) late = true;
      }
      // A play that landed after its tick: re-run from the start to here.
      if (late && simRef.current) { rebuild(b, simRef.current.tick); recheck(); } else byTick.current = inputsByTick(inputs.current);
    };

    void loadReplay(matchId).then((b) => {
      if (!live) return;
      if (!b.startAt) { setError('the relay has no start time for this match, so it cannot be followed live — open its replay instead'); return; }
      const startAt = b.startAt;
      for (const e of b.inputs) seen.current.add(keyOf(e));
      inputs.current = [...b.inputs];
      for (const c of b.checkpoints) chainHashes.current.set(c.tick, c.hash);
      setBundle(b);
      setSettled(b.settled);
      rebuild(b, Math.max(0, Math.floor((Date.now() - startAt) / TICK_MS) - LAG_TICKS));
      recheck();

      if (IS_MONAD_NETWORK && DEPLOYMENT) {
        // Monad: plays arrive the moment they are Proposed.
        unsubs.push(subscribeMatchLogs(MONAD_WS, DEPLOYMENT.arena, matchId, (l) => {
          setStates((s) => ({ ...s, [l.commitState]: (s[l.commitState] ?? 0) + 1 }));
          if (l.eventName === 'Played') {
            addInputs(b, [{ tick: Number(l.args.tick), player: Number(l.args.seat) as 0 | 1, deckIndex: Number(l.args.cardIndex), x: Number(l.args.x), y: Number(l.args.y) }]);
          } else if (l.eventName === 'Checkpoint') {
            chainHashes.current.set(Number(l.args.tick), BigInt(l.args.stateHash as bigint));
            recheck();
          } else if (l.eventName === 'MatchSettled' || l.eventName === 'MatchVoided') setSettled(true);
        }, () => {}));
      } else {
        // The local fork has no monadLogs: poll the arena's logs.
        let cursor = b;
        const iv = setInterval(() => {
          void pollReplay(cursor).then((r) => {
            cursor = { ...cursor, blocks: [cursor.blocks[0], r.to] };
            addInputs(b, r.inputs);
            for (const c of r.checkpoints) chainHashes.current.set(c.tick, c.hash);
            if (r.checkpoints.length) recheck();
            if (r.settled) setSettled(true);
          }).catch(() => { /* the next poll retries */ });
        }, 1000);
        unsubs.push(() => clearInterval(iv));
      }

      // Step toward real time minus the lag, at real speed.
      const step = setInterval(() => {
        const sim = simRef.current;
        if (!sim) return;
        const target = Math.floor((Date.now() - startAt) / TICK_MS) - LAG_TICKS;
        let n = 0;
        while (sim.tick < target && sim.phase !== 'ended' && n < 8) {
          const h = replayStep(sim, byTick.current);
          if (h !== null) { ourHashes.current.set(sim.tick, h); if (chainHashes.current.has(sim.tick)) recheck(); }
          n += 1;
        }
        setTick(sim.tick);
      }, TICK_MS);
      unsubs.push(() => clearInterval(step));
    }).catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; for (const u of unsubs) u(); };
  }, [matchId]);

  const sim = simRef.current;
  const crowns = sim ? crownsOf(sim) : [0, 0];
  const ended = sim?.phase === 'ended';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 12px', minHeight: '100%' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" className="icon-btn" aria-label="Back" onClick={() => nav(-1)} style={{ width: 44, height: 44, fontSize: 22 }}>‹</button>
        <h1 className="display" style={{ fontSize: 22, margin: 0 }}>Watching · match #{matchId}</h1>
      </header>
      {error && <section className="well" role="alert" style={{ padding: 12 }}><p className="fine" style={{ margin: 0 }}>{error}</p></section>}
      {!error && !bundle && <section className="well" style={{ padding: 12 }}><p className="fine" style={{ margin: 0 }}>Finding match #{matchId} on chain…</p></section>}
      {bundle && (
        <>
          <section aria-label="Spectator status" className="well" style={{ padding: '9px 12px', display: 'grid', gap: 4 }}>
            <span className="label" style={{ fontSize: 13, color: settled || ended ? 'var(--gold)' : 'var(--teal)' }}>
              {settled ? '■ Settled on chain' : ended ? '■ Final whistle — waiting for settlement' : `● Live · ${LAG_TICKS / TICKS_PER_SEC} s behind the players`}
            </span>
            <span className="fine" style={{ fontSize: 12, color: 'var(--dim)' }}>
              {shortAddr(bundle.seats[0])} vs {shortAddr(bundle.seats[1])} · {inputs.current.length} plays read from chain ·{' '}
              {verified.diverged !== null
                ? <b style={{ color: 'var(--red)' }}>diverges from the chain at {clock(verified.diverged)}</b>
                : <b style={{ color: 'var(--teal)' }}>✓ {verified.matched} on-chain checkpoint{verified.matched === 1 ? '' : 's'} matched so far</b>}
            </span>
            <span className="fine" style={{ fontSize: 11, color: 'var(--dim)' }}>
              {IS_MONAD_NETWORK
                ? `Plays stream over monadLogs as they are proposed${Object.keys(states).length ? ` (${Object.entries(states).map(([k, v]) => `${k.toLowerCase()} ${v}`).join(' · ')})` : ''}.`
                : 'Local fork: plays are read by polling the arena’s logs each second. On Monad they stream over monadLogs as they are proposed.'}
              {' '}A checkpoint lands every {CHECKPOINT_EVERY / TICKS_PER_SEC} s of play.
            </span>
          </section>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="display display--sm" style={{ fontSize: 18 }} aria-label={`Crowns: seat 0 ${crowns[0]}, seat 1 ${crowns[1]}`}>♛ {crowns[0]} – {crowns[1]}</span>
            <span className="mono" style={{ fontSize: 14 }} aria-label="Match clock">{clock(tick)}</span>
            {settled && (
              <button type="button" className="label" onClick={() => nav(`/replay/${matchId}`)} style={{ background: 'none', border: '1.5px solid var(--border)', borderRadius: 999, color: 'var(--teal)', padding: '4px 10px', minHeight: 32 }}>
                ▶ full replay
              </button>
            )}
          </div>
          <div style={{ position: 'relative', flex: 1, minHeight: 420, borderRadius: 'var(--r-card)', overflow: 'hidden' }}>
            <BattleScene onPlace={() => {}} placing={false} marker={null} perspective={0} />
          </div>
        </>
      )}
    </div>
  );
}
