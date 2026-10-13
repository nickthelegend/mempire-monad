import { useEffect, useState } from 'react';
import { apiFetch } from './api';

/*
 * Which fighters the relay's Pyth key cannot price. A card is minted only at a
 * fresh Pyth price, so these can't be minted right now; the Cards screen says
 * so instead of offering a Mint button that would fail. Fetched once per load.
 */
let cached: Promise<Set<number>> | null = null;
const load = () => {
  cached ??= apiFetch('/api/pyth/coverage')
    .then(async (r) => (r?.ok ? new Set<number>(((await r.json()) as { unavailable?: number[] }).unavailable ?? []) : new Set<number>()))
    .catch(() => new Set<number>());
  return cached;
};

export function usePythUnavailable(): Set<number> {
  const [set, setSet] = useState<Set<number>>(new Set());
  useEffect(() => {
    let live = true;
    void load().then((s) => { if (live) setSet(s); });
    return () => { live = false; };
  }, []);
  return set;
}
