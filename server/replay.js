/**
 * A staked match's replay record: what the chain does not hold.
 *
 * The plays, the state checkpoints, the decks' card ids, the power the arena
 * recorded and the meta epoch are all on chain. A deterministic replay also
 * needs the seed the matchmaker drew and the decks as the two sims received
 * them, so the matchmaker writes those on the pairing row and ties it to the
 * arena match id when seat 0 opens it. The client verifies all of it against
 * the chain before calling a replay "verified".
 *
 *   GET /api/replay/:matchId → { matchId, seats, seed, format, decks }
 */
const PUBLIC = (doc) => ({
  matchId: doc.replay.onchainMatchId,
  seats: doc.seats,
  seed: doc.replay.seed,
  format: doc.replay.format,
  decks: doc.replay.decks,
  at: doc.at,
});

export function registerReplayRoutes(app, db) {
  const pairings = db.collection('ladder_pairings');
  pairings.createIndex({ 'replay.onchainMatchId': 1 }).catch(() => {});

  app.get('/api/replay/:matchId', async (req, res) => {
    const id = Number(req.params.matchId);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'bad match id' });
    try {
      const doc = await pairings.findOne({ 'replay.onchainMatchId': id });
      if (!doc?.replay) return res.status(404).json({ error: 'no replay record for this match' });
      res.json(PUBLIC(doc));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
