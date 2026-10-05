/**
 * Formatting for money, tokens and time.
 *
 * Every numeric formatter defends against NaN/Infinity/undefined at this
 * boundary. Saved state crosses versions and networks, so a missing field
 * arriving here is a matter of time — and "NaN SOL" in a pot readout is the
 * single worst string this app could ever render.
 */
const safe = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

export const fmtSol = (n: number): string => {
  const v = safe(n);
  return `${v.toLocaleString('en-US', { maximumFractionDigits: v < 1 ? 3 : 2 })} SOL`;
};

export const fmtUsd = (n: number): string => {
  const v = safe(n);
  return v >= 1000
    ? `$${(v / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k`
    : `$${v.toLocaleString('en-US', { maximumFractionDigits: v < 1 ? 4 : 0 })}`;
};

export const fmtTokens = (n: number): string => {
  const v = safe(n);
  return v >= 1_000_000 ? `${(v / 1_000_000).toFixed(2)}M`
    : v >= 1_000 ? `${(v / 1_000).toFixed(1)}k`
      : v.toFixed(0);
};

export const shortAddr = (a: string): string =>
  (a && a.length > 9 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || '—');

export const fmtClock = (ticks: number): string => {
  const s = Math.max(0, Math.ceil(safe(ticks) / 20));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
