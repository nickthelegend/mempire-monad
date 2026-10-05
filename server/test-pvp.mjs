/**
 * Matchmaker protocol test — two fake clients over real WebSockets.
 *
 * Verifies the four behaviours the game depends on: pairing with a shared
 * seed, input relay, the hash referee voiding on divergence, and the
 * disconnect → opponent_left forfeit path. The lockstep sim itself is proven
 * deterministic by app/scripts/sim-test.ts; this proves the wire between two
 * of them.
 *
 * Run: node test-pvp.mjs      (server must be running)
 */
import WebSocket from 'ws';

const WS = process.env.WS ?? 'ws://localhost:8787/ws';
const DECK = Array.from({ length: 8 }, (_, i) => ({
  coinId: `M${i}`, name: `C${i}`, archetype: i % 6, level: 3,
}));

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`); } else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

function client(name) {
  const ws = new WebSocket(WS);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    const w = waiters.findIndex((x) => x.t === msg.t);
    if (w >= 0) waiters.splice(w, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  ws.on('error', () => { /* surfaced via open()/next() timeouts instead */ });
  return {
    name,
    ws,
    send: (m) => ws.send(JSON.stringify(m)),
    // readyState check first: with several sockets constructed together, one
    // can finish opening before its once('open') listener is registered, and
    // a listener added after the event waits forever.
    open: () => (ws.readyState === WebSocket.OPEN
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${name}: connect timeout`)), 4000);
        ws.once('open', () => { clearTimeout(timer); resolve(); });
      })),
    next: (t, ms = 4000) => {
      const hit = inbox.findIndex((m) => m.t === t);
      if (hit >= 0) return Promise.resolve(inbox.splice(hit, 1)[0]);
      return new Promise((resolve, reject) => {
        const entry = { t, resolve: (m) => { clearTimeout(timer); resolve(m); } };
        const timer = setTimeout(() => {
          // A timed-out waiter must leave the queue, or it swallows the next
          // real message of this type meant for a later, live waiter.
          const i = waiters.indexOf(entry);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`${name}: timed out waiting for '${t}'`));
        }, ms);
        waiters.push(entry);
      });
    },
    close: () => ws.close(),
  };
}

const addr = (s) => s.padEnd(40, 'x').slice(0, 40) + 'AAAA';

async function main() {
  console.log(`matchmaker → ${WS}\n`);

  // ── pairing ────────────────────────────────────────────────────────────
  console.log('1. pairing');
  const a = client('A');
  const b = client('B');
  await a.open();
  await b.open();

  a.send({ t: 'queue', address: addr('AliceWallet'), name: 'alice', tier: 1, power: 200, deck: DECK, deckHash: 'a' });
  const queued = await a.next('queued');
  check('first player queues', queued.t === 'queued');

  b.send({ t: 'queue', address: addr('BobWallet'), name: 'bob', tier: 1, power: 210, deck: DECK, deckHash: 'b' });
  const [ma, mb] = await Promise.all([a.next('matched'), b.next('matched')]);
  check('both matched', ma.matchId === mb.matchId, `match ${ma.matchId}`);
  check('seats are opposite', ma.role === 0 && mb.role === 1, `A=${ma.role} B=${mb.role}`);
  check('identical seed', ma.seed === mb.seed, `seed ${ma.seed}`);
  check('identical start time', ma.startAt === mb.startAt);
  // Both clients need the server's own clock to correct their local drift
  // against, or a machine with a wrong clock steps the sim out of step and
  // voids a staked match on a hash mismatch.
  check('both are told the matchmaker clock',
    typeof ma.serverNow === 'number' && typeof mb.serverNow === 'number'
      && Math.abs(ma.serverNow - mb.serverNow) < 50,
    `${ma.serverNow} / ${mb.serverNow}`);
  check('opponent deck delivered', mb.opponent.deck.length === 8 && mb.opponent.name === 'alice');

  // ── input relay ────────────────────────────────────────────────────────
  console.log('\n2. input relay');
  const input = { tick: 120, player: 0, deckIndex: 3, x: 4096, y: 8192 };
  a.send({ t: 'input', input });
  const relayed = await b.next('input');
  check('relayed untouched', JSON.stringify(relayed.input) === JSON.stringify(input));

  a.send({ t: 'input', input: { tick: 'nope' } });
  let leaked = false;
  await b.next('input', 700).then(() => { leaked = true; }).catch(() => {});
  check('malformed input dropped, not relayed', !leaked);

  // ── hash referee ───────────────────────────────────────────────────────
  console.log('\n3. hash referee');
  a.send({ t: 'hash', tick: 40, hash: 1111 });
  b.send({ t: 'hash', tick: 40, hash: 1111 });
  let earlyDesync = false;
  await a.next('desync', 700).then(() => { earlyDesync = true; }).catch(() => {});
  check('matching hashes pass silently', !earlyDesync);

  a.send({ t: 'hash', tick: 80, hash: 2222 });
  b.send({ t: 'hash', tick: 80, hash: 9999 });
  const [da, db] = await Promise.all([a.next('desync'), b.next('desync')]);
  check('mismatch voids both sides', da.tick === 80 && db.tick === 80);

  a.close();
  b.close();

  // ── disconnect forfeit ─────────────────────────────────────────────────
  console.log('\n4. disconnect forfeit');
  const c = client('C');
  const d = client('D');
  await c.open();
  await d.open();
  c.send({ t: 'queue', address: addr('CarolWallet'), name: 'carol', tier: 2, power: 300, deck: DECK, deckHash: 'c' });
  await c.next('queued');
  d.send({ t: 'queue', address: addr('DaveWallet'), name: 'dave', tier: 2, power: 310, deck: DECK, deckHash: 'd' });
  await Promise.all([c.next('matched'), d.next('matched')]);
  c.close(); // Carol vanishes mid-match
  const left = await d.next('opponent_left');
  check('survivor told the opponent left', left.t === 'opponent_left');
  d.close();

  // ── self-match refusal ─────────────────────────────────────────────────
  console.log('\n5. self-match refusal');
  const e1 = client('E1');
  const e2 = client('E2');
  await e1.open();
  await e2.open();
  const same = addr('SameWallet');
  e1.send({ t: 'queue', address: same, name: 'e', tier: 3, power: 100, deck: DECK, deckHash: 'e' });
  await e1.next('queued');
  e2.send({ t: 'queue', address: same, name: 'e', tier: 3, power: 100, deck: DECK, deckHash: 'e' });
  let selfMatched = false;
  await e2.next('matched', 800).then(() => { selfMatched = true; }).catch(() => {});
  check('one wallet cannot fight itself', !selfMatched);
  e1.close();
  e2.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
