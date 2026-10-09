import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createMemoryDb } from './memstore.js';
import { startWar, advanceWar, loadWar, registerClanWarRoutes } from './clanwars.js';

const alice = '0x1111111111111111111111111111111111111111';
const bob = '0x2222222222222222222222222222222222222222';
const stranger = '0x3333333333333333333333333333333333333333';
async function setup() {
  const db = createMemoryDb();
  await db.collection('clans').insertOne({ _id: 'AAA', members: [{ address: alice }, { address: bob }] });
  const now = Date.now();
  const war = startWar({ _id: 'test-war', clans: ['AAA', 'BBB'], size: 2, roundMs: 60_000, createdAt: now }, now);
  await db.collection('clan_wars').insertOne(war);
  return { db, war, score: registerClanWarRoutes(express(), db) };
}

test('verified settlement increments exactly once even across concurrent retries', async () => {
  const { db, score } = await setup();
  const result = { createdAt: Date.now(), won: true, draw: false, players: [alice, stranger] };
  await Promise.all(Array.from({ length: 8 }, () => score(alice, result, 11)));
  const war = await db.collection('clan_wars').findOne({ _id: 'test-war' });
  assert.equal(war.rounds[0].scores.AAA.points, 3);
  assert.equal(war.rounds[0].scores.AAA.wins, 1);
  assert.deepEqual(war.scored, [`11:${alice}`]);
});

test('clanmates, voided results, missing opponent and invalid match IDs do not score', async () => {
  const { db, score } = await setup();
  await score(alice, { createdAt: Date.now(), won: true, players: [alice, bob.toUpperCase()] }, 12);
  await score(alice, { createdAt: Date.now(), won: true, voided: true, players: [alice, stranger] }, 13);
  await score(alice, { createdAt: Date.now(), won: true, players: [alice] }, 14);
  await score(alice, { createdAt: Date.now(), won: true, players: [alice, stranger] }, NaN);
  await score(alice, { createdAt: 1, won: true, players: [alice, stranger] }, 17);
  const war = await db.collection('clan_wars').findOne({ _id: 'test-war' });
  assert.equal(war.rounds[0].scores.AAA.points, 0);
});

test('draw and loss use verified outcomes and each player-match claim is independent', async () => {
  const { db, score } = await setup();
  await score(alice, { createdAt: Date.now(), draw: true, players: [alice, stranger] }, 15);
  await score(bob, { createdAt: Date.now(), won: false, draw: false, players: [bob, stranger] }, 16);
  const war = await db.collection('clan_wars').findOne({ _id: 'test-war' });
  assert.deepEqual(war.rounds[0].scores.AAA, { points: 1, wins: 0, draws: 1, losses: 1 });
});

test('bracket advances by points, then entry order; finished bracket can be observed', () => {
  const war = startWar({ clans: ['AAA', 'BBB', 'CCC', 'DDD'], roundMs: 100 }, 1000);
  war.rounds[0].scores.BBB.points = 3;
  const next = advanceWar(war, 1100);
  assert.deepEqual(next.rounds[1].pairs, [['BBB', 'CCC']]);
  assert.equal(advanceWar(next, 1200).champion, 'BBB');
});


test('round advancement recomputes winners if a score arrives during its read', async () => {
  const { db, war } = await setup();
  const wars = db.collection('clan_wars');
  const update = wars.updateOne.bind(wars);
  let raced = false;
  wars.updateOne = async (filter, change) => {
    if (!raced && change.$set?.status === 'done') {
      raced = true;
      await update({ _id: war._id }, { $inc: { 'rounds.0.scores.BBB.points': 3 } });
    }
    return update(filter, change);
  };
  const next = await loadWar(wars, { _id: war._id }, war.rounds[0].endsAt);
  assert.equal(next.champion, 'BBB');
  const stored = await wars.findOne({ _id: war._id });
  assert.equal(stored.rounds[0].scores.BBB.points, 3);
  assert.equal(stored.champion, 'BBB');
});
