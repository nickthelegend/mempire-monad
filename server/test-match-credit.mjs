import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryDb } from './memstore.js';
import { claimMoneyCredit } from './match-credit.js';

test('initial and late reports competing for one player-match credit have one winner', async () => {
  const db = createMemoryDb(); const credits = db.collection('match_credits');
  await credits.insertOne({ _id: '42:alice', moneyCredited: false });
  const results = await Promise.all(Array.from({ length: 12 }, () => claimMoneyCredit(credits, '42:alice')));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await claimMoneyCredit(credits, '42:alice'), false);
  assert.equal((await credits.findOne({ _id: '42:alice' })).moneyCredited, true);
});

test('each seat has an independent claim; absent claims cannot create credits', async () => {
  const credits = createMemoryDb().collection('match_credits');
  await credits.insertOne({ _id: '42:alice', moneyCredited: false });
  await credits.insertOne({ _id: '42:bob', moneyCredited: false });
  assert.equal(await claimMoneyCredit(credits, '42:alice'), true);
  assert.equal(await claimMoneyCredit(credits, '42:bob'), true);
  assert.equal(await claimMoneyCredit(credits, '43:alice'), false);
  assert.equal(await credits.countDocuments({}), 2);
});
