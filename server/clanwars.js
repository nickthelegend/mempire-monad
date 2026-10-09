/**
 * Clan wars: clan-vs-clan brackets fought in staked matches.
 *
 * Leaders enter their clan; when the bracket is full (CLAN_WAR_SIZE: 2, 4 or 8
 * clans) it starts. Each round lasts CLAN_WAR_ROUND_MS. A member's staked match
 * scores for their clan only once the relay has verified its settlement on
 * chain (the same `verifySettledMatch` that credits the money board): a win is
 * 3 points, a draw 1, a loss 0. Nothing a client reports is counted — not its
 * crowns, not its own claim of victory. At the round's end the higher score in
 * each pairing advances (a tie goes to the clan that entered first) until one
 * clan is champion.
 *
 * Entry is free; the stakes are the matches themselves. Pooled clan prize
 * money would need an escrow contract and an oracle for the bracket, so it is
 * deliberately not done here.
 *
 *   POST /api/clan-wars/enter   (signed by a leader or co-leader: 'clanwar.enter', { tag })
 *   GET  /api/clan-wars/current?tag=TAG
 */
import { requireWallet } from './auth.js';

export const WAR_SIZE = [2, 4, 8].includes(Number(process.env.CLAN_WAR_SIZE)) ? Number(process.env.CLAN_WAR_SIZE) : 4;
export const ROUND_MS = Number(process.env.CLAN_WAR_ROUND_MS) > 0 ? Number(process.env.CLAN_WAR_ROUND_MS) : 24 * 3600 * 1000;
export const POINTS = { win: 3, draw: 1, loss: 0 };

const emptyScore = () => ({ points: 0, wins: 0, draws: 0, losses: 0 });

/** Pure: begin round 1 of a full bracket (clans in entry order). */
export function startWar(war, now) {
  const pairs = [];
  for (let i = 0; i < war.clans.length; i += 2) pairs.push([war.clans[i], war.clans[i + 1]]);
  return {
    ...war,
    status: 'running',
    rounds: [{ pairs, startsAt: now, endsAt: now + war.roundMs, scores: Object.fromEntries(war.clans.map((t) => [t, emptyScore()])) }],
  };
}

/** Pure: close every round whose time is up, pairing the winners onward. */
export function advanceWar(war, now) {
  let w = war;
  while (w.status === 'running') {
    const round = w.rounds[w.rounds.length - 1];
    if (now < round.endsAt) break;
    const order = (t) => w.clans.indexOf(t);
    const winners = round.pairs.map(([a, b]) => {
      const pa = round.scores[a]?.points ?? 0;
      const pb = round.scores[b]?.points ?? 0;
      return pa > pb || (pa === pb && order(a) < order(b)) ? a : b;
    });
    const rounds = [...w.rounds.slice(0, -1), { ...round, winners }];
    if (winners.length === 1) return { ...w, rounds, status: 'done', champion: winners[0] };
    const pairs = [];
    for (let i = 0; i < winners.length; i += 2) pairs.push([winners[i], winners[i + 1]]);
    rounds.push({ pairs, startsAt: round.endsAt, endsAt: round.endsAt + w.roundMs, scores: Object.fromEntries(winners.map((t) => [t, emptyScore()])) });
    w = { ...w, rounds };
  }
  return w;
}

/** Pure: a chain-verified staked result for a member of `tag`; ignored unless `tag` is fighting this round. */
export function applyResult(war, tag, result, now) {
  if (war.status !== 'running') return war;
  const round = war.rounds[war.rounds.length - 1];
  if (now < round.startsAt || now >= round.endsAt || !round.pairs.some((p) => p.includes(tag))) return war;
  const s = { ...(round.scores[tag] ?? emptyScore()) };
  if (result.won) { s.wins += 1; s.points += POINTS.win; } else if (result.draw) { s.draws += 1; s.points += POINTS.draw; } else s.losses += 1;
  return { ...war, rounds: [...war.rounds.slice(0, -1), { ...round, scores: { ...round.scores, [tag]: s } }] };
}

/** Advance a stored bracket without overwriting a settlement scored concurrently. */
export async function loadWar(wars, filter, now = Date.now()) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const war = (await wars.find(filter).sort({ createdAt: -1 }).limit(1).toArray())[0] ?? null;
    if (!war) return null;
    const next = advanceWar(war, now);
    if (next === war) return war;
    const update = { status: next.status, rounds: next.rounds };
    if (next.champion) update.champion = next.champion;
    // The score snapshot is part of the compare-and-swap. If a settlement
    // changed it while this read was in flight, recalculate the winners.
    const result = await wars.updateOne({ _id: war._id, status: war.status, rounds: war.rounds }, { $set: update });
    if (result.matchedCount) return next;
  }
  throw new Error('The bracket changed repeatedly; refresh standings.');
}

export function registerClanWarRoutes(app, db) {
  const wars = db.collection('clan_wars');
  const clans = db.collection('clans');
  // The embedded roster is the source of truth for who is in which clan.
  const clanOf = (address) => clans.findOne({ 'members.address': address });

  const newest = async (filter, dir = -1) => (await wars.find(filter).sort({ createdAt: dir }).limit(1).toArray())[0] ?? null;
  const load = (filter) => loadWar(wars, filter);

  // The clan entered is the signer's own: the signature covers the action, not
  // a tag, so the tag is never taken from the request.
  app.post('/api/clan-wars/enter', requireWallet('clanwar.enter'), async (req, res) => {
    try {
      const clan = await clanOf(req.wallet);
      const me = clan?.members?.find((m) => m.address === req.wallet);
      if (!me || !['leader', 'coleader'].includes(me.role)) return res.status(403).json({ error: 'only a clan leader or co-leader can enter a war' });
      const tag = clan._id;
      const busy = await load({ clans: tag, status: { $in: ['open', 'running'] } });
      if (busy && busy.status !== 'done') return res.status(409).json({ error: 'this clan is already in a war', war: busy._id });
      const now = Date.now();
      let war = await newest({ status: 'open' }, 1);
      if (!war) {
        war = { _id: `war-${now.toString(36)}`, size: WAR_SIZE, roundMs: ROUND_MS, clans: [], names: {}, status: 'open', rounds: [], createdAt: now };
        await wars.insertOne(war);
      }
      // Conditional on the bracket still having room and not holding this tag,
      // so two leaders entering at once cannot overfill it.
      const grown = await wars.findOneAndUpdate(
        { _id: war._id, status: 'open', clans: { $ne: tag }, [`clans.${war.size - 1}`]: { $exists: false } },
        { $push: { clans: tag }, $set: { [`names.${tag}`]: clan.name } },
        { returnDocument: 'after' },
      );
      const doc = grown;
      if (!doc) return res.status(409).json({ error: 'the bracket filled up; try again' });
      let next = doc;
      if (doc.clans.length >= doc.size) {
        next = startWar(doc, now);
        await wars.updateOne({ _id: doc._id, status: 'open' }, { $set: { status: next.status, rounds: next.rounds } });
      }
      res.json({ ok: true, war: next });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/clan-wars/current', async (req, res) => {
    const tag = String(req.query.tag ?? '').toUpperCase();
    try {
      const war = (tag ? await load({ clans: tag }) : null) ?? await load({ status: 'open' });
      res.json({ war, size: WAR_SIZE, roundMs: ROUND_MS, points: POINTS });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * Called once per (match, player), at the moment the relay has verified that
   * match's settlement on chain. A match against a clanmate scores nothing:
   * otherwise two members could trade a win back and forth for free points.
   */
  return async function scoreClanWar(address, verified, matchId) {
    if (!verified || verified.voided || !Number.isSafeInteger(matchId) || matchId <= 0) return;
    const clan = await clanOf(address);
    if (!clan) return;
    const opponent = verified.players?.find((p) => p.toLowerCase() !== address.toLowerCase());
    if (!opponent || clan.members.some((m) => m.address.toLowerCase() === opponent.toLowerCase())) return;
    const war = await load({ clans: clan._id, status: 'running' });
    if (!war) return;
    const tag = clan._id;
    const active = war.rounds[war.rounds.length - 1];
    // Old settled matches cannot be carried into a new bracket/round.
    if (!Number.isFinite(verified.createdAt) || verified.createdAt < active.startsAt || verified.createdAt >= active.endsAt) return;
    if (applyResult(war, tag, verified, Date.now()) === war) return;
    // Atomic increments, so two results landing at once both count.
    const i = war.rounds.length - 1;
    const at = `rounds.${i}.scores.${tag}`;
    const inc = verified.won ? { [`${at}.wins`]: 1, [`${at}.points`]: POINTS.win }
      : verified.draw ? { [`${at}.draws`]: 1, [`${at}.points`]: POINTS.draw }
        : { [`${at}.losses`]: 1 };
    const credit = `${matchId}:${address.toLowerCase()}`;
    // Claim and increment are one atomic write: duplicate settlement reports
    // cannot add points, even if two requests pass the chain read together.
    await wars.updateOne({ _id: war._id, status: 'running', scored: { $ne: credit }, [`rounds.${i}.endsAt`]: war.rounds[i].endsAt }, { $inc: inc, $addToSet: { scored: credit } });
  };
}
