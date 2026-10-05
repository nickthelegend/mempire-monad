import { IS_MAINNET } from '../chain/provider';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CardFrame } from '../components/CardFrame';
import { Tutorial, resetTutorial, tutorialDone } from '../components/Tutorial';
import { LeagueBadge } from '../components/LeagueBadge';
import { Crowns, Pill } from '../components/ui';
import { fmtSol, shortAddr } from '../lib/format';
import { leagueFor } from '../lib/ranking';
import { EASE_SNAP, usePulse } from '../lib/motion';
import { FEES, useCollection } from '../state/collection';
import { TIERS, useDeck } from '../state/deck';
import { useLadder } from '../state/ladder';
import { useMatch } from '../state/match';
import { warmBattleChunk } from '../lib/warm';
import { signer, useWallet } from '../state/wallet';
import { useChain } from '../state/chain';
import { fetchRecentSettlements, type ChainMatch } from '../chain/read';
import { mintDeckTx, readableChainError } from '../chain/actions';

/**
 * Recent settlements, read from the chain.
 *
 * This strip used to be six invented names and amounts on a rotating timer,
 * which is the single most dishonest thing the app could have done: a fake
 * feed of other people's winnings, on the screen whose whole job is to make
 * the pot feel real. It now shows matches the program actually paid, and an
 * empty devnet gets an empty state that says so.
 */
function useSettlementFeed(): { rows: ChainMatch[]; loading: boolean } {
  const [rows, setRows] = useState<ChainMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const mode = useChain((s) => s.mode);

  useEffect(() => {
    let live = true;
    if (mode === 'offline') { setLoading(false); return () => { live = false; }; }
    const load = () => {
      fetchRecentSettlements(12)
        .then((m) => { if (live) { setRows(m); setLoading(false); } })
        .catch(() => { if (live) setLoading(false); });
    };
    load();
    // Slow on purpose: settlements are rare and this is decoration, not state
    // the player acts on. A tight poll would spend RPC quota to no end.
    const t = setInterval(load, 45_000);
    return () => { live = false; clearInterval(t); };
  }, [mode]);

  return { rows, loading };
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export function Logo({ width = 260 }: { width?: number }) {
  return (
    <img
      src="/art/logo.webp"
      alt="Mempire"
      width={width}
      draggable={false}
      style={{ display: 'block', margin: '0 auto', height: 'auto', maxWidth: '100%' }}
    />
  );
}

/**
 * Resource chip — the gold/token pills along the top of a Supercell HUD.
 *
 * The number bumps when it changes. Winning a pot and returning to the Arena
 * used to leave the balance silently different; a resource that moved should say
 * so, and scale says it without touching the colour rules.
 */
function Chip({ icon, value, tone }: { icon: string; value: string; tone: 'gold' | 'blue' }) {
  const ref = usePulse(value, [
    { transform: 'scale(1)' },
    { transform: 'scale(1.22)', offset: 0.38 },
    { transform: 'scale(1)' },
  ], { duration: 420, easing: EASE_SNAP });

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 5,
      padding: '3px 10px 3px 5px', borderRadius: 999,
      background: 'var(--recess)',
      border: '2px solid var(--ink)',
      boxShadow: 'var(--bevel-in)',
      minWidth: 0,
    }}
    >
      <span aria-hidden style={{ fontSize: 15, lineHeight: 1 }}>{icon}</span>
      <span
        ref={ref as React.RefObject<HTMLSpanElement>}
        className="money"
        style={{
          fontSize: 14, color: tone === 'gold' ? 'var(--gold-hi)' : 'var(--blue-pale)',
          whiteSpace: 'nowrap', display: 'inline-block',
        }}
      >
        {value}
      </span>
    </div>
  );
}

function ConnectHero() {
  const openPicker = useWallet((s) => s.openPicker);
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center',
      padding: '40px 22px', gap: 20, textAlign: 'center',
    }}
    >
      <Logo width={320} />
      {/* The old line was "Your bags are your army" over "mint cards from the
          meme coins you hold, stake them for power". Every clause of that was a
          rule the game no longer has: minting never required the coin, levels
          come from winning, and nothing is staked. It is also the first thing
          anyone reads, so it was the most-seen wrong sentence in the app. */}
      <p className="display" style={{ fontSize: 21, lineHeight: 1.2 }}>
        Every coin is a fighter.
      </p>
      <p style={{ color: 'var(--dim)', fontSize: 14, maxWidth: 300, margin: '-8px auto 0' }}>
        Coins, stocks and crypto as fighters. Level them up by winning, and battle for the pot.
      </p>
      <div style={{ padding: '0 12px', marginTop: 6 }}>
        <Pill onClick={openPicker} tone="gold" style={{ fontSize: 19 }}>Connect Wallet</Pill>
      </div>
      <span className="label" style={{ fontSize: 12 }}>{IS_MAINNET ? 'mainnet · real funds' : 'devnet · no real funds'}</span>
    </div>
  );
}

function TopHud({ onReplayTutorial }: { onReplayTutorial: () => void }) {
  const wallet = useWallet();
  const trophies = useLadder((s) => s.trophies);
  const history = useMatch((s) => s.history);
  const [open, setOpen] = useState(false);
  const wins = history.filter((h) => h.won).length;

  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Account menu"
        className="btn-3d"
        style={{
          display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
          padding: '4px 12px 4px 4px', borderRadius: 999, minHeight: 44,
          background: 'var(--recess)', border: '2px solid var(--ink)',
          boxShadow: 'var(--bevel-in)', minWidth: 0,
        }}
      >
        <img
          src="/art/avatar_guest.webp"
          alt=""
          aria-hidden
          width={34}
          height={34}
          style={{ display: 'block', filter: 'drop-shadow(0 1px 3px rgba(0,0,0,.6))' }}
        />
        <span style={{ minWidth: 0 }}>
          <span
            className="display display--sm"
            style={{ display: 'block', fontSize: 14 }}
          >
            anon_king
          </span>
          {/* The wallet, not the address.
              "Guest · ANoN…8UEG" needed 139px in a 110px box, so it rendered
              as "Guest · ANoN…" — an address truncated twice is an address
              nobody can check, which is the only reason to print one. The full
              form now sits in the menu below, where it has room and a copy
              button next to it. What stays is the part a player actually needs
              at a glance: whether this session is a real wallet or a guest. */}
          <span
            className="mono"
            style={{
              display: 'block', fontSize: 12, color: 'var(--dim)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}
          >
            {wallet.walletName}
          </span>
        </span>
      </button>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* The badge carried the trophy count only in its aria-label, so it
            sat between two chips that both showed a number and showed none
            itself — reading as a decorative crest rather than the rank it is.
            Trophies are the number a ladder game is played for; it belongs on
            screen, in the same chip shape as the two beside it. */}
        <div
          title={`${leagueFor(trophies).name} · ${trophies} trophies`}
          style={{
            display: 'flex', alignItems: 'center', gap: 3,
            padding: '2px 9px 2px 2px', borderRadius: 999,
            background: 'var(--recess)', boxShadow: 'var(--bevel-in)',
            border: '2px solid var(--ink)',
          }}
        >
          <LeagueBadge trophies={trophies} size={28} />
          <span
            className="display display--sm"
            style={{ fontSize: 14, color: 'var(--text)' }}
          >
            {trophies}
          </span>
        </div>
        <Chip icon="👑" value={String(wins)} tone="blue" />
        <Chip icon="◎" value={fmtSol(wallet.sol).replace(' SOL', '')} tone="gold" />
      </div>

      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 24 }} onClick={() => setOpen(false)} />
          <div
            className="panel"
            style={{ position: 'absolute', top: 48, left: 0, zIndex: 25, padding: 6, minWidth: 200 }}
          >
            {/* The address itself, before the button that copies it. "Copy
                address" on its own asks the player to take on trust which
                address they are about to paste. */}
            <p
              className="mono"
              style={{
                margin: 0, padding: '8px 10px 6px', fontSize: 11.5,
                color: 'var(--dim-on-wood)', wordBreak: 'break-all',
                lineHeight: 1.45, userSelect: 'all',
              }}
            >
              {wallet.address}
            </p>
            <button
              onClick={() => { void navigator.clipboard?.writeText(wallet.address); setOpen(false); }}
              className="menu-item"
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '11px 10px', borderRadius: 8, fontSize: 13, minHeight: 44, fontWeight: 700, color: 'var(--dim-on-wood)' }}
            >
              Copy address
            </button>
            <button
              onClick={() => { resetTutorial(); setOpen(false); onReplayTutorial(); }}
              className="menu-item"
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '11px 10px', borderRadius: 8, fontSize: 13, minHeight: 44, fontWeight: 700, color: 'var(--dim-on-wood)' }}
            >
              Replay tutorial
            </button>
            <button
              onClick={() => { wallet.disconnect(); setOpen(false); }}
              className="menu-item"
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '11px 10px', borderRadius: 8, fontSize: 13, minHeight: 44, fontWeight: 700, color: 'var(--red-on-wood)' }}
            >
              Disconnect
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function Arena() {
  /*
   * Start the battle chunk downloading while the player is still choosing a
   * tier. Practice goes straight from click to arena with no queue to hide the
   * fetch behind, so warming it only at queue time would leave the one mode
   * that needs it most exactly as slow as before.
   */
  useEffect(() => { warmBattleChunk(); }, []);

  const wallet = useWallet();
  const trophies = useLadder((s) => s.trophies);
  const deck = useDeck();
  const cards = useCollection((s) => s.cards);
  const match = useMatch();
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [feedIdx, setFeedIdx] = useState(0);
  const settlements = useSettlementFeed();
  // First connect only; replay lives in the account menu.
  const [showTutorial, setShowTutorial] = useState(false);
  useEffect(() => {
    if (wallet.connected && !tutorialDone()) setShowTutorial(true);
  }, [wallet.connected]);

  useEffect(() => {
    const t = setInterval(() => setFeedIdx((i) => i + 1), 2600);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (match.status === 'battle') nav('/battle');
  }, [match.status, nav]);

  const deckCards = useMemo(
    () => deck.active.map((id) => cards.find((c) => c.id === id)).filter(Boolean),
    [deck.active, cards],
  );

  // Every hook has to run on every render, so these live above the
  // not-connected early return rather than beside the value they feed.
  const chainMode = useChain((s) => s.mode);
  const chainCards = useChain((s) => s.cards);

  if (!wallet.connected) return <ConnectHero />;

  const tier = TIERS[deck.tier];
  const pot = tier.stakeSol * 2;
  const queueing = match.status === 'queuing' || match.status === 'found';

  /**
   * Can this player actually stake, and if not, which of the three reasons.
   *
   * Checked here so the Arena can say it *before* a match, rather than the
   * player discovering afterwards that the pot they were shown was decorative.
   * The deck check mirrors `onchainDeckIds`: eight cards, each minted and not
   * already locked into another match.
   */
  const mintedDeck = deckCards.filter(
    (c) => c && chainCards.some((k) => k.mint === c.mint && !k.inMatch),
  ).length;
  const unmintedMints = deckCards
    .filter((c) => c && !chainCards.some((k) => k.mint === c.mint))
    .map((c) => c!.mint);
  // A guest is no longer blocked by being a guest: its address is a real,
  // fundable pubkey and it can sign for itself on devnet. What blocks anyone
  // is the same three things — an unreachable cluster, a deck that is not
  // minted, or not holding the tier.
  const stakeBlocker = chainMode !== 'onchain'
    ? 'The program is unreachable, so nothing is escrowed'
    : mintedDeck < 8
      ? `${8 - mintedDeck} of your cards are not minted onchain yet`
      : wallet.sol < tier.stakeSol
        ? `You hold ${fmtSol(wallet.sol)} — fund ${shortAddr(wallet.address)} to stake this tier`
        : '';
  const canStake = stakeBlocker === '';

  // The gap and the wordmark are sized to land this screen inside one 812px
  // viewport — the common iPhone. The battle deck is the last row, and a new
  // player's own deck arriving already cut off by the tab bar is the worst
  // first impression a game about decks could make. 669px of content plus
  // 80px of gaps plus the tab bar's 80px reserve overran by 37px, so the gap
  // comes down and the wordmark gives up the rest: the app is already open,
  // and nobody needs a 102px logo to know which one they are in.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '10px 16px 6px' }}>
      <TopHud onReplayTutorial={() => setShowTutorial(true)} />
      <Logo width={168} />

      {/* tier picker — carved wood rail of stake plates */}
      <section className="panel" data-tut="tier" style={{ padding: 9 }}>
        <div className="label" style={{ marginBottom: 7, textAlign: 'center' }}>
          Stake tier
        </div>
        <div role="radiogroup" aria-label="Stake tier" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 7 }}>
          {TIERS.map((t, i) => {
            const active = deck.tier === i;
            const affordable = wallet.sol >= t.stakeSol;
            return (
              <button
                key={t.name}
                role="radio"
                aria-checked={active}
                aria-label={`${t.name} tier, ${t.stakeSol} SOL`}
                onClick={() => deck.setTier(i)}
                disabled={!affordable || queueing}
                className="btn-3d"
                style={{
                  padding: '7px 2px 6px', minHeight: 52, borderRadius: 9, textAlign: 'center',
                  background: active
                    ? 'linear-gradient(180deg, var(--btn-blue-hi), var(--btn-blue))'
                    : 'var(--recess)',
                  border: '2px solid var(--ink)',
                  boxShadow: active
                    ? 'inset 0 2px 0 rgba(255,255,255,.45), 0 3px 0 var(--btn-blue-dark)'
                    : 'var(--bevel-in)',
                  filter: affordable ? 'none' : 'saturate(.3)',
                  transition: 'background 160ms var(--ease-snap), box-shadow 120ms var(--ease-snap)',
                }}
              >
                <Crowns n={t.crowns} size={11} />
                <div
                  className="money"
                  style={{
                    fontSize: 13, marginTop: 2,
                    color: !affordable ? 'var(--red-on-wood)' : 'var(--gold-hi)',
                  }}
                >
                  {t.stakeSol}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* the moment */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {queueing ? (
          <>
            <div
              className="panel"
              style={{
                padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12,
              }}
            >
              {/* three pulsing crowns — a search that visibly progresses */}
              <span aria-hidden style={{ display: 'flex', gap: 3 }}>
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    style={{
                      fontSize: 17, color: 'var(--gold)',
                      animation: `searchPulse 1.1s ${i * 0.18}s ease-in-out infinite`,
                    }}
                  >
                    ♛
                  </span>
                ))}
              </span>
              <span style={{ minWidth: 0, textAlign: 'left' }}>
                <span className="display display--sm" style={{ fontSize: 17, display: 'block' }}>
                  {match.status === 'found' ? 'Opponent found!' : 'Finding opponent'}
                </span>
                <span className="fine" style={{ color: 'var(--dim-on-wood)', fontSize: 12 }}>
                  {match.status === 'found'
                    ? `${match.opponentName} · entering arena`
                    : match.ranked
                      // The wait is bounded now — after twenty seconds the AI
                      // steps in — so the copy promises an end rather than an
                      // open-ended "humans only" that was true and unhelpful.
                      ? `matching near ${trophies} 🏆 · the AI steps in if nobody's about`
                      : `matching your deck power (${deck.power()})`}
                </span>
              </span>
              <style>{'@keyframes searchPulse{0%,100%{opacity:.28;transform:translateY(0)}50%{opacity:1;transform:translateY(-3px)}}'}</style>
            </div>
            {/* Once found, the die is cast — stake escrowed, opponent committed.
                Offering Cancel there would either lie or forfeit; it does neither. */}
            {match.status === 'queuing' && (
              <Pill tone="blue" onClick={() => match.cancelQueue()} style={{ fontSize: 15, minHeight: 46, padding: '10px 18px' }}>
                Cancel search
              </Pill>
            )}
          </>
        ) : (
          <>
            {/* The one CTA on the screen. A slow transform-only breathe so the
                eye finds it against the patterned field, without competing with
                the money readouts for attention. */}
            <div data-tut="battle">
              <Pill
                onClick={() => setError(match.startQueue({ ranked: true }))}
                tone="gold"
                style={{
                  fontSize: 25,
                  padding: '19px 24px',
                  animation: 'ctaBreathe 2.6s ease-in-out infinite',
                }}
              >
                Ranked
              </Pill>
            </div>
            {/* Rush: 30 seconds, same stake tier, trophies still on the line.
                Sits beside Ranked rather than under Practice because it is a
                real match — the short format is the only difference. */}
            <Pill
              tone="blue"
              onClick={() => setError(match.startQueue({ ranked: true, rush: true }))}
              style={{ fontSize: 16, minHeight: 48, padding: '11px 18px' }}
            >
              Rush · 30s
            </Pill>
            {/* No stake, no rake, no chest — somewhere to learn the controls
                without paying tuition in SOL. */}
            <div data-tut="practice">
              <Pill
                tone="green"
                onClick={() => setError(match.startQueue({ practice: true }))}
                style={{ fontSize: 15, minHeight: 46, padding: '10px 18px' }}
              >
                Practice · free
              </Pill>
            </div>
          </>
        )}
        {error && (
          <div role="alert" className="well" style={{ color: 'var(--red-on-wood)', fontSize: 13, textAlign: 'center', padding: '8px 10px', fontWeight: 700 }}>
            {error}
          </div>
        )}

        <div className="panel" style={{ padding: '8px 12px', display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="label">Pot</span>
            <span className="money" style={{ fontSize: 22 }}>{fmtSol(pot)}</span>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--dim-on-wood)', textAlign: 'right', lineHeight: 1.25 }}>
              you stake {fmtSol(tier.stakeSol)}<br />
              winner takes {100 - FEES.rakePct}%
            </span>
          </div>
          {/*
            Whether that pot is real, said before the match rather than after.

            A stake needs three things: a wallet that can sign, a deck that is
            actually minted onchain, and enough SOL. Without all three the match
            still runs and still moves rating — it just does not move money, and
            a pot figure printed over a match that escrows nothing is the exact
            thing this line exists to stop.
          */}
          <span className="fine" style={{
            color: canStake ? 'var(--teal)' : 'var(--dim-on-wood)', lineHeight: 1.3,
          }}>
            {canStake
              ? 'Escrowed onchain — the winner is paid by the program.'
              : `${stakeBlocker} · this match counts for rating only.`}
          </span>
          {/*
            The one blocker the player can clear from here.

            "3 of your cards are not minted onchain yet" is a true sentence and
            a useless one if the only way to act on it is eight separate mints
            on another screen. Batched three to a transaction, so a full deck is
            three prompts rather than eight.
          */}
          {!canStake && unmintedMints.length > 0 && (
            <MintDeckButton mints={unmintedMints} />
          )}
        </div>
      </section>

      {/* live feed — real settlements only */}
      <section aria-label="Recent settlements" className="well" style={{ padding: '9px 12px', overflow: 'hidden' }}>
        {settlements.rows.length > 0 ? (
          (() => {
            const row = settlements.rows[feedIdx % settlements.rows.length];
            const winnerAddr = row.winner <= 1 ? row.players[row.winner] : null;
            const payout = row.stakeSol * 2 * (1 - FEES.rakePct / 100);
            return (
              <div key={feedIdx} style={{ display: 'flex', alignItems: 'center', gap: 8, animation: 'feedIn 400ms var(--ease-snap)' }}>
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', background: 'var(--teal)',
                  boxShadow: '0 0 8px var(--teal)', flexShrink: 0,
                }}
                />
                <span style={{ fontSize: 13, color: 'var(--dim)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <strong style={{ color: 'var(--text)' }}>
                    {winnerAddr ? short(winnerAddr) : 'a draw'}
                  </strong>
                  {winnerAddr ? ' won' : ' split the pot'}
                </span>
                <span className="money" style={{ marginLeft: 'auto', fontSize: 14, whiteSpace: 'nowrap' }}>
                  +{fmtSol(winnerAddr ? payout : payout / 2)}
                </span>
              </div>
            );
          })()
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%', background: 'var(--dim)', flexShrink: 0,
            }}
            />
            <span style={{ fontSize: 13, color: 'var(--dim)' }}>
              {settlements.loading
                ? 'reading settled matches…'
                : 'no staked matches have settled yet — be the first'}
            </span>
          </div>
        )}
        <style>{'@keyframes feedIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}'}</style>
      </section>

      {/* deck strip */}
      <section data-tut="deck">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
          <span className="label">Battle deck</span>
          {/* power is a game stat, not money — gold stays reserved for SOL */}
          <span className="label" style={{ color: 'var(--blue-pale)' }}>power {deck.power()}</span>
        </div>
        <div
          style={{
            display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 7,
          }}
        >
          {deckCards.slice(0, 4).map((c) => c && <CardFrame key={c.id} card={c} width={74} fluid />)}
        </div>
      </section>

      {showTutorial && <Tutorial onDone={() => setShowTutorial(false)} />}
    </div>
  );
}

/**
 * Mint the deck's missing cards, batched.
 *
 * Deliberately not a silent background job: minting spends real SOL per card
 * and the player should be the one deciding to, with the count in front of
 * them. Progress is reported per transaction because three confirmations on
 * devnet is long enough that a static spinner reads as a hang.
 */
function MintDeckButton({ mints }: { mints: string[] }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const refresh = useChain((s) => s.refresh);

  if (state === 'done') {
    return (
      <span className="fine" style={{ color: 'var(--teal)' }}>
        Deck minted — this match will escrow.
      </span>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <Pill
        tone="blue"
        disabled={state === 'busy'}
        onClick={() => {
          setState('busy');
          setError(null);
          void mintDeckTx(signer(), mints, (done) => setProgress(done))
            .then(async () => {
              await refresh();
              setState('done');
            })
            .catch((e) => {
              setError(readableChainError(e));
              setState('idle');
            });
        }}
      >
        {state === 'busy'
          ? `Minting ${progress}/${mints.length}…`
          : `Mint ${mints.length} card${mints.length === 1 ? '' : 's'} to stake`}
      </Pill>
      {error && (
        <span className="fine" style={{ color: 'var(--red-on-wood)' }}>{error}</span>
      )}
    </div>
  );
}
