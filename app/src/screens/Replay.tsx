import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Pill } from '../components/ui';
import { HAS_EXPLORER, explorerUrl, DEPLOYMENT } from '../chain/provider';
import { loadReplay, type ReplayBundle } from '../lib/replay';
import { inputsByTick, newReplaySim, replayStep, verifyReplay, type Verification } from '../sim/replay';
import { TICKS_PER_SEC, type SimState } from '../sim/types';
import { useMatch } from '../state/match';
import { shortAddr } from '../lib/format';
import { BattleScene } from '../three/BattleScene';

/*
 * A staked match, re-run from Monad.
 *
 * Every card drop and every fourth state checkpoint of a staked match is on
 * chain. This screen gathers them, re-runs the deterministic sim, and checks
 * each recomputed state hash against the checkpoints the two seats posted —
 * so "verified" here means the chain itself agrees with what you are watching.
 * The 3D arena is the battle's own, driven by the replayed sim.
 */

const SPEEDS = [1, 4] as const;
const crownsOf = (sim: SimState): [number, number] => {
  let a = 0; let b = 0;
  for (const t of sim.towers) if (t.hp <= 0) { if (t.owner === 1) a += 1; else b += 1; }
  return [a, b];
};
const clock = (tick: number) => {
  const s = Math.floor(tick / TICKS_PER_SEC);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function Replay() {
  const { id } = useParams();
  const matchId = Number(id);
  const nav = useNavigate();
  const [bundle, setBundle] = useState<ReplayBundle | null>(null);
  const [verdict, setVerdict] = useState<Verification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [tick, setTick] = useState(0);
  const simRef = useRef<SimState | null>(null);

  useEffect(() => {
    let live = true;
    setBundle(null); setVerdict(null); setError(null);
    loadReplay(matchId)
      .then((b) => {
        if (!live) return;
        setBundle(b);
        // Headless first: the verdict is computed from the whole match before playback.
        setVerdict(verifyReplay(b, b.checkpoints));
      })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [matchId]);

  const byTick = useMemo(() => (bundle ? inputsByTick(bundle.inputs) : new Map()), [bundle]);

  const restart = () => {
    if (!bundle) return;
    const sim = newReplaySim(bundle);
    simRef.current = sim;
    // The arena reads the sim and decks from the match store each frame.
    useMatch.setState({ sim, playerDeck: bundle.decks[0], botDeck: bundle.decks[1], perspective: 0 });
    setTick(0);
  };
  useEffect(() => { if (bundle) { restart(); setPlaying(true); } }, [bundle]); // eslint-disable-line react-hooks/exhaustive-deps
  // Arriving from a result screen: that match is over, put it away first.
  // Leave the match store idle on the way out too.
  useEffect(() => {
    if (useMatch.getState().status !== 'idle') useMatch.getState().dismiss();
    return () => { useMatch.setState({ sim: null }); };
  }, []);

  useEffect(() => {
    if (!playing || !bundle) return;
    const iv = setInterval(() => {
      const sim = simRef.current;
      if (!sim) return;
      for (let i = 0; i < speed; i += 1) {
        if (sim.phase === 'ended') { setPlaying(false); break; }
        replayStep(sim, byTick);
      }
      setTick(sim.tick);
    }, 1000 / TICKS_PER_SEC);
    return () => clearInterval(iv);
  }, [playing, speed, bundle, byTick]);

  const sim = simRef.current;
  const crowns = sim ? crownsOf(sim) : [0, 0];
  const verified = verdict && verdict.compared > 0 && verdict.divergedAt === null && verdict.seatsDisagreeAt === null;
  const checksOk = bundle ? bundle.checks.deckIds && bundle.checks.archetypes && bundle.checks.power : false;
  const arenaLink = DEPLOYMENT ? explorerUrl(DEPLOYMENT.arena, 'address') : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 12px', minHeight: '100%' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" className="icon-btn" aria-label="Back" onClick={() => nav(-1)} style={{ width: 44, height: 44, fontSize: 22 }}>‹</button>
        <h1 className="display" style={{ fontSize: 22, margin: 0 }}>Replay · match #{matchId}</h1>
      </header>

      {error && (
        <section className="well" role="alert" style={{ padding: 12 }}>
          <p className="fine" style={{ margin: 0 }}>Can&apos;t rebuild this match: {error}</p>
        </section>
      )}
      {!error && !bundle && (
        <section className="well" style={{ padding: 12 }}>
          <p className="fine" style={{ margin: 0 }}>Reading match #{matchId} from the chain — plays, checkpoints, decks…</p>
        </section>
      )}

      {bundle && verdict && (
        <section
          aria-label="Replay verification"
          className="well"
          style={{ padding: '10px 12px', display: 'grid', gap: 6, border: `2px solid ${verified && checksOk ? 'var(--teal)' : 'var(--red)'}` }}
        >
          <span className="label" style={{ fontSize: 13, color: verified && checksOk ? 'var(--teal)' : 'var(--red)' }}>
            {verified && checksOk
              ? `✓ Verified against ${verdict.matched} on-chain checkpoint${verdict.matched === 1 ? '' : 's'}`
              : verdict.compared === 0
                ? 'Not verifiable: no on-chain checkpoints for this match'
                : verdict.seatsDisagreeAt !== null
                  ? `The two seats posted different states at tick ${verdict.seatsDisagreeAt}`
                  : verdict.divergedAt !== null
                    ? `Diverges from the chain at tick ${verdict.divergedAt} (${clock(verdict.divergedAt)})`
                    : 'Deck record does not match the chain'}
          </span>
          <p className="fine" style={{ margin: 0, fontSize: 12, color: 'var(--dim)' }}>
            Re-run from {bundle.inputs.length} on-chain plays (blocks {bundle.blocks[0]}–{bundle.blocks[1]}), seed from the matchmaker.
            Decks checked against the arena: card ids {bundle.checks.deckIds ? '✓' : '✗'} · archetypes {bundle.checks.archetypes ? '✓' : '✗'} · power {bundle.checks.power ? '✓' : '✗'}.
            {' '}Result on chain: {bundle.chainWinner === 0 ? `seat 0 (${shortAddr(bundle.seats[0])}) won` : bundle.chainWinner === 1 ? `seat 1 (${shortAddr(bundle.seats[1])}) won` : bundle.chainWinner === 2 ? 'a draw' : 'void'}
            {verdict.winner >= 0 || verdict.winner === -2 ? ` · replay: ${verdict.winner === -2 ? 'a draw' : `seat ${verdict.winner} wins`}` : ''}
            {HAS_EXPLORER && arenaLink ? <> · <a href={arenaLink} target="_blank" rel="noreferrer">arena on MonadVision ↗</a></> : ' · local fork (no explorer)'}
          </p>
          {bundle.checks.detail.length > 0 && (
            <ul className="fine" style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: 'var(--red)' }}>
              {bundle.checks.detail.slice(0, 4).map((d) => <li key={d}>{d}</li>)}
            </ul>
          )}
        </section>
      )}

      {bundle && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span className="display display--sm" style={{ fontSize: 18 }} aria-label={`Crowns: seat 0 ${crowns[0]}, seat 1 ${crowns[1]}`}>
              ♛ {crowns[0]} – {crowns[1]}
            </span>
            <span className="mono" style={{ fontSize: 14 }} aria-label="Match clock">{clock(tick)}</span>
            <span style={{ display: 'flex', gap: 6 }}>
              <Pill ghost onClick={() => setPlaying((p) => !p)} style={{ minHeight: 40, padding: '6px 14px', fontSize: 14 }}>{playing ? 'Pause' : 'Play'}</Pill>
              {SPEEDS.map((sp) => (
                <Pill key={sp} ghost={speed !== sp} onClick={() => setSpeed(sp)} style={{ minHeight: 40, padding: '6px 12px', fontSize: 14 }}>{sp}×</Pill>
              ))}
              <Pill ghost onClick={() => { restart(); setPlaying(true); }} style={{ minHeight: 40, padding: '6px 12px', fontSize: 14 }}>↺</Pill>
            </span>
          </div>
          <div style={{ position: 'relative', flex: 1, minHeight: 420, borderRadius: 'var(--r-card)', overflow: 'hidden' }}>
            <BattleScene onPlace={() => {}} placing={false} marker={null} perspective={0} />
          </div>
        </>
      )}
    </div>
  );
}
