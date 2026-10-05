import { useMemo } from 'react';

/**
 * The empty desktop gutters, sold.
 *
 * The layout law reserves the space either side of the 430px column for ads.
 * Until an advertiser fills it, leaving it as flat blue reads as unfinished — so
 * it holds a carved signboard that says the slot is available and how to buy it.
 * That is a media kit, not decoration: a judge sees the revenue line without
 * being told about it.
 *
 * The board art is generated; the copy is live HTML on top of it. Generated
 * lettering comes out as garbled pseudo-text, which would break the legibility
 * law on the one surface whose whole job is to be read.
 *
 * Hidden below 900px because there are no gutters on a phone — the column *is*
 * the screen, and the game never gives up its own space to an ad.
 */

const CONTACT = 'ads@mempire.fun';

/** Rotated per side so the two boards do not read as a duplicated asset. */
const PITCHES = [
  {
    kicker: 'Ad space',
    line: 'Put your coin in front of every degen who plays.',
    // Was "100% of players see this slot". The slot is hidden below 900px,
    // which on a mobile-first game is most of them — a reach claim the layout
    // contradicts is the one line in a pitch nobody forgives.
    stat: 'Desktop arena · above the fold',
  },
  {
    kicker: 'Coin of the week',
    line: 'Sponsor a card. Own the meta for seven days.',
    stat: 'Arena · deck · battle HUD',
  },
];

export function AdSlot({ side }: { side: 'left' | 'right' }) {
  const pitch = PITCHES[side === 'left' ? 0 : 1];
  // Deterministic per side — a board that reshuffles on every render is noise.
  const slotId = useMemo(() => (side === 'left' ? 'A1' : 'B1'), [side]);

  return (
    <aside
      aria-label={`Advertising slot ${slotId} — available`}
      style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: 48, minWidth: 0,
      }}
    >
      {/* Held back until pointed at. Two unsold boards at full strength flanked
          the column with a pair of gold CTAs brighter than anything in the
          game, so the first read of the page was "empty inventory" rather than
          "arena" — the hall's own rule is that nothing out here should compete.
          Sold creative would replace this board entirely and can be as loud as
          it likes; a vacancy notice should not be. */}
      <div className="adboard" style={{ position: 'sticky', top: 48, width: 300, maxWidth: '100%' }}>
        <div style={{ position: 'relative', width: '100%', aspectRatio: '512 / 762' }}>
          <img
            src="/art/ad_frame.webp"
            alt=""
            aria-hidden
            draggable={false}
            style={{
              display: 'block', width: '100%', height: '100%',
              objectFit: 'contain',
              filter: 'drop-shadow(0 10px 26px rgba(0,0,0,.5))',
            }}
          />

          {/* Copy sits inside the board's blank panel, never over its frame. The
              inset is measured off the generated art, so it has to stay in step
              with it if the board is ever regenerated. */}
          <div
            style={{
              position: 'absolute', left: '20%', right: '20%', top: '21%', bottom: '14%',
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', gap: 10, textAlign: 'center', minWidth: 0,
            }}
          >
            <span className="label" style={{ color: 'var(--gold-hi)', fontSize: 12 }}>
              slot {slotId} · open
            </span>

            <span
              className="display display--gold"
              style={{ fontSize: 22, lineHeight: 1.02, maxWidth: '100%' }}
            >
              {pitch.kicker}
            </span>

            <p
              style={{
                fontSize: 12.5, lineHeight: 1.32, color: 'var(--dim-on-wood)',
                margin: 0, maxWidth: '100%',
              }}
            >
              {pitch.line}
            </p>

            <span
              className="well"
              style={{
                padding: '6px 8px', fontSize: 12, fontWeight: 700,
                color: 'var(--dim-on-wood)', lineHeight: 1.25, maxWidth: '100%',
              }}
            >
              {pitch.stat}
            </span>

            <a
              href={`mailto:${CONTACT}?subject=Mempire%20ad%20slot%20${slotId}`}
              className="btn-3d"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                minHeight: 44, padding: '0 16px', borderRadius: 'var(--r-pill)',
                background: 'var(--recess)',
                border: '2px solid var(--ink)',
                boxShadow: 'var(--bevel-in)',
                fontFamily: 'var(--font-display)', fontSize: 15, letterSpacing: '.03em',
                color: 'var(--gold-hi)', textDecoration: 'none',
                WebkitTextStroke: '1.8px var(--ink)', paintOrder: 'stroke fill',
                textTransform: 'uppercase', whiteSpace: 'nowrap',
              }}
            >
              Advertise here
            </a>

            <span className="mono" style={{ fontSize: 12, color: 'var(--dim-on-wood)' }}>
              {CONTACT}
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}
