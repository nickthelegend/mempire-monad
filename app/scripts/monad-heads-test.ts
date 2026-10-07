/**
 * The commit-state reducer behind the live Monad pipeline strip.
 *
 *   npx tsx scripts/monad-heads-test.ts
 */
import { medianMs, parseHeadFrame, reduceHead, type BlockChip, type HeadMsg } from '../src/lib/monadHeads';

let fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};
const msg = (blockId: string, number: number, commitState: HeadMsg['commitState']): HeadMsg => ({ blockId, number, hash: `0x${blockId}`, commitState });

let c: BlockChip[] = [];
c = reduceHead(c, msg('a', 100, 'Proposed'), 0);
c = reduceHead(c, msg('a', 100, 'Voted'), 310);
c = reduceHead(c, msg('a', 100, 'Finalized'), 590);
c = reduceHead(c, msg('a', 100, 'Verified'), 1450);
check('a block walks Proposed → Voted → Finalized → Verified', c[0].state === 'Verified');
check('each transition is timed from the first message', c[0].votedMs === 310 && c[0].finalizedMs === 590 && c[0].verifiedMs === 1450);

c = reduceHead([], msg('b', 101, 'Proposed'), 0);
c = reduceHead(c, msg('b', 101, 'Finalized'), 600);
check('a skipped Voted is left unset, not invented', c[0].votedMs === undefined && c[0].finalizedMs === 600);

c = reduceHead([], msg('c', 102, 'Proposed'), 0);
c = reduceHead(c, msg('c2', 102, 'Proposed'), 5);
check('two proposals at one height are both tracked', c.filter((x) => x.number === 102).length === 2);
c = reduceHead(c, msg('c', 102, 'Finalized'), 600);
check('finalizing one proposal drops the competing one', c.length === 1 && c[0].blockId === 'c');
c = reduceHead(c, msg('c3', 102, 'Proposed'), 700);
check('a proposal at an already-final height is dead on arrival', c.length === 1);

c = reduceHead([], msg('d', 103, 'Voted'), 0);
c = reduceHead(c, msg('d', 103, 'Finalized'), 300);
check('joining mid-flight reports no timing (no honest t0)', c[0].timed === false && c[0].finalizedMs === undefined);

c = reduceHead([], msg('e', 104, 'Finalized'), 0);
const same = reduceHead(c, msg('e', 104, 'Voted'), 50);
check('states never move backwards', same === c && c[0].state === 'Finalized');

let many: BlockChip[] = [];
for (let i = 0; i < 20; i += 1) many = reduceHead(many, msg(`n${i}`, 200 + i, 'Proposed'), i);
check('keeps only the newest N, newest first', many.length === 8 && many[0].number === 219 && many[7].number === 212);

const timed = [{ finalizedMs: 500 }, { finalizedMs: 700 }, { finalizedMs: 600 }, {}] as BlockChip[];
check('median of measured values only', medianMs(timed, 'finalizedMs') === 600);
check('median is null with no samples', medianMs([], 'votedMs') === null);

const frame = JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: '0x1', result: { blockId: '0xabc', commitState: 'Voted', number: '0x2a', hash: '0xh' } } });
const parsed = parseHeadFrame(frame);
check('parses a monadNewHeads frame', parsed?.number === 42 && parsed.commitState === 'Voted' && parsed.blockId === '0xabc');
check('ignores the subscription ack and garbage', parseHeadFrame('{"jsonrpc":"2.0","id":1,"result":"0x1"}') === null && parseHeadFrame('nope') === null);

console.log(fail ? `\n${fail} failed` : '\nMONAD HEADS OK');
process.exit(fail ? 1 : 0);
