/**
 * The replay record: what the matchmaker writes so a staked match can be
 * re-run from the chain later.
 *
 * Two WebSocket clients queue and are matched; seat 0 reports the arena match
 * it opened; `/api/replay/:id` must then return the seed both seats were sent
 * and the decks exactly as they queued them, by seat. Seat 1 cannot set the
 * id, a second report cannot overwrite it, and unknown ids are 404.
 *
 *   node test-replay.mjs   (no chain needed)
 */
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { client, freshAccount, startRelay, tally } from './test-util.mjs';

const { check, done } = tally();
const PORT = Number(process.env.PORT ?? 8798);
const roster = JSON.parse(readFileSync(new URL('./shared/roster.json', import.meta.url), 'utf8'));
const deck = (off) => Array.from({ length: 8 }, (_, i) => {
  const c = roster.coins[(i + off) % roster.coins.length];
  return { coinId: c.feedId.toLowerCase(), name: c.ticker, archetype: (i + off) % 6, level: 1 + (i % 3) };
});

const relay = await startRelay(PORT, { CHAIN_ID: '31338', RPC_URL: 'http://127.0.0.1:1' });
const req = client(relay.base);

function seat(address, d) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    const w = waiters.findIndex((x) => x.pred(m));
    if (w >= 0) waiters.splice(w, 1)[0].resolve(m); else inbox.push(m);
  });
  const next = (pred, ms = 8000) => new Promise((resolve, reject) => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
    waiters.push({ pred, resolve });
    setTimeout(() => reject(new Error('timed out waiting for a message')), ms);
  });
  const opened = new Promise((r) => ws.on('open', r));
  const queue = () => ws.send(JSON.stringify({
    t: 'queue', address, tier: 0, currency: 'AUSD', deck: d, deckHash: `h-${address.slice(2, 8)}`,
    power: d.reduce((a, c) => a + c.level, 0), trophies: 0, format: 'rush', name: address.slice(0, 6),
  }));
  return { ws, next, opened, queue };
}

try {
  const [a, b] = [freshAccount(), freshAccount()];
  const [deckA, deckB] = [deck(0), deck(5)];
  const s0 = seat(a.address, deckA);
  const s1 = seat(b.address, deckB);
  await Promise.all([s0.opened, s1.opened]);
  s0.queue();
  await new Promise((r) => { setTimeout(r, 200); });
  s1.queue();
  const [m0, m1] = await Promise.all([s0.next((m) => m.t === 'matched'), s1.next((m) => m.t === 'matched')]);
  check('both seats matched, seat 0 = first in the queue', m0.role === 0 && m1.role === 1);
  check('both received the same seed', m0.seed === m1.seed && Number.isInteger(m0.seed), String(m0.seed));

  const missing = await req('GET', '/api/replay/4242');
  check('no record before seat 0 reports the arena match', missing.status === 404);

  // Seat 1 may not tie the record to an id.
  s1.ws.send(JSON.stringify({ t: 'chain', stage: 'opened', onchainMatchId: 999 }));
  await new Promise((r) => { setTimeout(r, 300); });
  check('seat 1 cannot set the arena match id', (await req('GET', '/api/replay/999')).status === 404);

  s0.ws.send(JSON.stringify({ t: 'chain', stage: 'opened', onchainMatchId: 4242 }));
  await s1.next((m) => m.t === 'chain');
  await new Promise((r) => { setTimeout(r, 300); });
  const got = await req('GET', '/api/replay/4242');
  check('the record is served for the arena match id', got.status === 200, `${got.status} ${JSON.stringify(got.data).slice(0, 100)}`);
  check('it carries the seed both seats were sent', got.data?.seed === m0.seed);
  check('and the format', got.data?.format === 'rush');
  check('and the decks exactly as queued, by seat', JSON.stringify(got.data?.decks) === JSON.stringify([deckA, deckB]));
  check('and the seats', got.data?.seats?.[0] === a.address.toLowerCase() && got.data?.seats?.[1] === b.address.toLowerCase(), JSON.stringify(got.data?.seats));
  check('and the start instant both seats count down to', got.data?.startAt === m0.startAt, `${got.data?.startAt} vs ${m0.startAt}`);
  const liveNow = await req('GET', '/api/live');
  const entry = liveNow.data?.matches?.find((x) => x.matchId === 4242);
  check('the match is listed live for spectators', Boolean(entry) && entry.startAt === m0.startAt && entry.format === 'rush', JSON.stringify(liveNow.data).slice(0, 120));

  s0.ws.send(JSON.stringify({ t: 'chain', stage: 'opened', onchainMatchId: 5151 }));
  await new Promise((r) => { setTimeout(r, 300); });
  check('a second report cannot move the record', (await req('GET', '/api/replay/5151')).status === 404 && (await req('GET', '/api/replay/4242')).status === 200);
  check('a malformed id is 400', (await req('GET', '/api/replay/abc')).status === 400);
  s0.ws.close(); s1.ws.close();
  await new Promise((r) => { setTimeout(r, 500); });
  const after = await req('GET', '/api/live');
  check('and is gone once the match ends', !after.data?.matches?.some((x) => x.matchId === 4242), JSON.stringify(after.data).slice(0, 120));
} catch (e) {
  check('suite ran to completion', false, String(e?.stack ?? e).slice(0, 300));
} finally {
  await relay.stop();
}
process.exit(done() ? 1 : 0);
