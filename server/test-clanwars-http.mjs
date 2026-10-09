// HTTP integration with production in-memory storage and genuine wallet signatures.
// This does not claim a real staked chain settlement or sponsor integration.
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { once } from 'node:events';
import { createMemoryDb } from './memstore.js';
import { registerClanWarRoutes, WAR_SIZE } from './clanwars.js';
import { freshAccount, signed } from './test-util.mjs';

test('real signed leaders enter a bracket; unsigned/member entries are refused', async () => {
  const db = createMemoryDb();
  const app = express(); app.use(express.json());
  registerClanWarRoutes(app, db);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body) => fetch(`${base}/api/clan-wars/enter`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({})).status, 401);
    const member = freshAccount();
    await db.collection('clans').insertOne({ _id: 'MEMBER', name: 'Members', members: [{ address: member.address.toLowerCase(), role: 'member' }] });
    assert.equal((await post(await signed(member, 'clanwar.enter'))).status, 403);
    let first;
    for (let i = 0; i < WAR_SIZE; i++) {
      const leader = freshAccount(); first ??= leader;
      const tag = `CLAN${i}`;
      await db.collection('clans').insertOne({ _id: tag, name: tag, members: [{ address: leader.address.toLowerCase(), role: 'leader' }] });
      const response = await post(await signed(leader, 'clanwar.enter', { tag: 'MEMBER' }));
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.ok(result.war.clans.includes(tag), 'entry uses signed leader roster, not body tag');
      assert.equal(result.war.status, i === WAR_SIZE - 1 ? 'running' : 'open');
    }
    assert.equal((await post(await signed(first, 'clanwar.enter'))).status, 409);
    const response = await fetch(`${base}/api/clan-wars/current?tag=CLAN0`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.war.status, 'running');
    assert.equal(body.war.rounds[0].pairs.length, WAR_SIZE / 2);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
