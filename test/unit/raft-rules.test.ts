// ADR-0001 D5 必守規則 1–8, each exercised with duplicated or reordered AppendEntries / RequestVote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RaftNode } from '../../src/sim/node.ts';
import type { Entry, Outgoing, Payload } from '../../src/sim/messages.ts';

const MEMBERS = ['A', 'B', 'C', 'D', 'E'];
const node = (id: string, timeout = 4) => new RaftNode(id, { members: MEMBERS, electionTimeout: timeout, heartbeatInterval: 1, gatewayResendInterval: 4, initialValues: {} }, 0);
const entry = (term: number, requestId: string, value = requestId): Entry => ({ term, command: { clientId: 'writer', requestId, action: 'write', key: 'x', value } });
const ae = (p: Partial<Extract<Payload, { type: 'AppendEntries' }>>): Payload => ({ type: 'AppendEntries', term: 1, leaderId: 'A', prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0, ...p });
const only = <T extends Payload['type']>(outs: Outgoing[], type: T) => outs.map((o) => o.payload).filter((p): p is Extract<Payload, { type: T }> => p.type === type);

/** Makes A leader of term 1 with votes from B and C. */
function leaderA(): RaftNode {
  const a = node('A');
  a.tick(4);
  a.handle('B', { type: 'RequestVoteReply', term: 1, voteGranted: true }, 5);
  a.handle('C', { type: 'RequestVoteReply', term: 1, voteGranted: true }, 5);
  assert.equal(a.volatile?.role, 'leader');
  return a;
}

test('D5 rule 1: vote and term are persisted before the reply; a crash cannot make the node vote twice', () => {
  const b = node('B', 25);
  const outs = b.handle('A', { type: 'RequestVote', term: 1, candidateId: 'A', lastLogIndex: 0, lastLogTerm: 0 }, 5);
  assert.equal(only(outs, 'RequestVoteReply')[0]?.voteGranted, true);
  assert.deepEqual({ term: b.stable.currentTerm, votedFor: b.stable.votedFor }, { term: 1, votedFor: 'A' });
  b.crash();
  b.restart(6);
  const again = b.handle('C', { type: 'RequestVote', term: 1, candidateId: 'C', lastLogIndex: 0, lastLogTerm: 0 }, 6);
  assert.equal(only(again, 'RequestVoteReply')[0]?.voteGranted, false, 'same term, other candidate, after restart');
  // A duplicated RequestVote from the same candidate is granted again (idempotent), not a second vote.
  const dup = b.handle('A', { type: 'RequestVote', term: 1, candidateId: 'A', lastLogIndex: 0, lastLogTerm: 0 }, 7);
  assert.equal(only(dup, 'RequestVoteReply')[0]?.voteGranted, true);
});

test('D5 rule 1: entries are in stable storage before the ack; the leader logs before replicating', () => {
  const b = node('B', 25);
  const outs = b.handle('A', ae({ entries: [entry(1, 'r1')] }), 9);
  assert.equal(only(outs, 'AppendEntriesReply')[0]?.success, true);
  b.crash();
  assert.equal(b.stable.log.length, 1, 'acked entry survives a crash right after the ack');
  const a = leaderA();
  a.handle('writer', { type: 'ClientRequest', command: entry(1, 'w').command }, 6);
  assert.equal(a.stable.log.length, 1, 'proposal written to the leader log first');
  const sent = only(a.tick(6), 'AppendEntries');
  assert.ok(sent.every((p) => p.entries.length === 1));
});

test('D5 rule 2: duplicated or reordered older AppendEntries never truncate matching entries', () => {
  const b = node('B', 25);
  b.handle('A', ae({ entries: [entry(1, 'r1'), entry(1, 'r2')] }), 9);
  b.handle('A', ae({ entries: [entry(1, 'r1')] }), 10); // older, delayed copy
  assert.deepEqual(b.stable.log.map((e) => e.command.requestId), ['r1', 'r2'], 'not truncated by the older copy');
  b.handle('A', ae({ entries: [entry(1, 'r1'), entry(1, 'r2')] }), 10); // duplicate
  assert.deepEqual(b.stable.log.map((e) => e.command.requestId), ['r1', 'r2']);
  // A real term conflict does truncate.
  b.handle('C', ae({ term: 2, leaderId: 'C', prevLogIndex: 1, prevLogTerm: 1, entries: [entry(2, 'c1')] }), 11);
  assert.deepEqual(b.stable.log.map((e) => `${e.term}:${e.command.requestId}`), ['1:r1', '2:c1']);
});

test('D5 rule 3: the ack reports prevLogIndex + entries.length, not the follower log length', () => {
  const b = node('B', 25);
  b.handle('A', ae({ entries: [entry(1, 'r1'), entry(1, 'r2'), entry(1, 'r3')] }), 9);
  const outs = b.handle('A', ae({ entries: [entry(1, 'r1')] }), 10);
  assert.equal(only(outs, 'AppendEntriesReply')[0]?.matchIndex, 1);
  const hb = b.handle('A', ae({ prevLogIndex: 2, prevLogTerm: 1 }), 10);
  assert.equal(only(hb, 'AppendEntriesReply')[0]?.matchIndex, 2);
});

test('D5 rule 4: matchIndex never decreases on reordered replies; nextIndex stays >= 1', () => {
  const a = leaderA();
  for (const id of ['w1', 'w2']) a.handle('writer', { type: 'ClientRequest', command: entry(1, id).command }, 6);
  a.handle('B', { type: 'AppendEntriesReply', term: 1, success: true, matchIndex: 2, prevLogIndex: 0 }, 7);
  a.handle('B', { type: 'AppendEntriesReply', term: 1, success: true, matchIndex: 1, prevLogIndex: 0 }, 7); // stale, reordered
  a.handle('B', { type: 'AppendEntriesReply', term: 1, success: false, matchIndex: 0, prevLogIndex: 0 }, 7); // stale failure
  assert.equal(a.volatile?.matchIndex.get('B'), 2);
  assert.ok((a.volatile?.nextIndex.get('B') ?? 0) >= 3);
  for (let i = 0; i < 5; i++) a.handle('C', { type: 'AppendEntriesReply', term: 1, success: false, matchIndex: 0, prevLogIndex: 0 }, 8);
  assert.equal(a.volatile?.nextIndex.get('C'), 1);
});

test('D5 rule 5: replies of another term are ignored; a higher term turns the node into a follower', () => {
  const a = leaderA();
  a.handle('writer', { type: 'ClientRequest', command: entry(1, 'w1').command }, 6);
  // Bump A to term 2 as a candidate that then gets an old-term vote: ignored.
  const c = node('C');
  c.tick(4); // term 1 candidate
  c.tick(8); // term 2 candidate
  c.handle('D', { type: 'RequestVoteReply', term: 1, voteGranted: true }, 9);
  c.handle('E', { type: 'RequestVoteReply', term: 1, voteGranted: true }, 9);
  assert.equal(c.volatile?.role, 'candidate', 'term-1 votes do not elect a term-2 candidate');
  a.handle('B', { type: 'AppendEntriesReply', term: 0, success: true, matchIndex: 1, prevLogIndex: 0 }, 7);
  assert.equal(a.volatile?.matchIndex.get('B'), 0, 'old-term ack ignored');
  a.handle('B', { type: 'AppendEntriesReply', term: 3, success: false, matchIndex: 0, prevLogIndex: 0 }, 7);
  assert.equal(a.volatile?.role, 'follower');
  assert.equal(a.stable.currentTerm, 3);
});

test('D5 rule 6: follower commitIndex = min(leaderCommit, last new entry) and never moves back', () => {
  const b = node('B', 25);
  b.handle('A', ae({ entries: [entry(1, 'r1')], leaderCommit: 5 }), 9);
  assert.equal(b.volatile?.commitIndex, 1);
  b.handle('A', ae({ entries: [entry(1, 'r1'), entry(1, 'r2')], leaderCommit: 2 }), 10);
  assert.equal(b.volatile?.commitIndex, 2);
  b.handle('A', ae({ entries: [entry(1, 'r1')], leaderCommit: 1 }), 11); // reordered older message
  assert.equal(b.volatile?.commitIndex, 2);
  // A heartbeat whose prev is behind does not commit past what it covers.
  const c = node('C', 25);
  c.handle('A', ae({ entries: [entry(1, 'r1'), entry(1, 'r2')], leaderCommit: 0 }), 9);
  c.handle('A', ae({ prevLogIndex: 1, prevLogTerm: 1, leaderCommit: 2 }), 10);
  assert.equal(c.volatile?.commitIndex, 1);
});

test('D5 rule 7: an old-term entry is not committed by counting replicas alone', () => {
  const c = node('C');
  // C has an uncommitted term-1 entry, then becomes leader of term 2.
  c.handle('A', ae({ entries: [entry(1, 'old')] }), 3);
  c.tick(3 + 4);
  c.tick(3 + 4 + 4); // two timeouts without votes: terms 2 and 3
  assert.equal(c.stable.currentTerm, 3);
  c.handle('D', { type: 'RequestVoteReply', term: 3, voteGranted: true }, 12);
  c.handle('E', { type: 'RequestVoteReply', term: 3, voteGranted: true }, 12);
  assert.equal(c.volatile?.role, 'leader');
  c.handle('D', { type: 'AppendEntriesReply', term: 3, success: true, matchIndex: 1, prevLogIndex: 0 }, 13);
  c.handle('E', { type: 'AppendEntriesReply', term: 3, success: true, matchIndex: 1, prevLogIndex: 0 }, 13);
  assert.equal(c.volatile?.commitIndex, 0, 'term-1 entry on a majority is still not committed');
  c.handle('writer', { type: 'ClientRequest', command: entry(3, 'new').command }, 14);
  c.handle('D', { type: 'AppendEntriesReply', term: 3, success: true, matchIndex: 2, prevLogIndex: 1 }, 15);
  c.handle('E', { type: 'AppendEntriesReply', term: 3, success: true, matchIndex: 2, prevLogIndex: 1 }, 15);
  assert.equal(c.volatile?.commitIndex, 2, 'a current-term entry commits the earlier one too');
});

test('D5 rule 8: the election timer resets exactly on leader AppendEntries, granted votes, candidacy and stepping down', () => {
  const b = node('B', 25);
  b.handle('A', ae({}), 9);
  assert.equal(b.volatile?.electionResetAt, 9, 'AppendEntries from the current leader');
  b.handle('C', { type: 'RequestVote', term: 2, candidateId: 'C', lastLogIndex: 0, lastLogTerm: 0 }, 12);
  assert.equal(b.volatile?.electionResetAt, 12, 'granting a vote');
  b.handle('D', { type: 'RequestVote', term: 2, candidateId: 'D', lastLogIndex: 0, lastLogTerm: 0 }, 13);
  assert.equal(b.volatile?.electionResetAt, 12, 'a refused vote does not reset');
  b.handle('A', ae({ term: 1 }), 14);
  assert.equal(b.volatile?.electionResetAt, 12, 'a stale-term AppendEntries does not reset');
  const c = node('C', 7);
  c.tick(7);
  assert.equal(c.volatile?.electionResetAt, 7, 'becoming a candidate');
  const a = leaderA();
  a.handle('C', { type: 'RequestVote', term: 5, candidateId: 'C', lastLogIndex: 9, lastLogTerm: 4 }, 20);
  assert.equal(a.volatile?.role, 'follower');
  assert.equal(a.volatile?.electionResetAt, 20, 'leader -> follower');
});

test('D7: leader dedups only an uncommitted entry of its own term; the state machine dedups by request identity', () => {
  const a = leaderA();
  const cmd = entry(1, 'w1').command;
  a.handle('writer', { type: 'ClientRequest', command: cmd }, 6);
  a.handle('C', { type: 'Forward', command: cmd }, 6);
  assert.equal(a.stable.log.length, 1, 'no second append for the same uncommitted current-term request');
  a.handle('B', { type: 'AppendEntriesReply', term: 1, success: true, matchIndex: 1, prevLogIndex: 0 }, 7);
  const replies = a.handle('C', { type: 'AppendEntriesReply', term: 1, success: true, matchIndex: 1, prevLogIndex: 0 }, 7);
  assert.equal(a.volatile?.commitIndex, 1);
  assert.deepEqual(only(replies, 'ClientReply').map((r) => r.result), ['已確認'], 'one reply even though leader is also gateway');
  // After commit the same request is appended again, and the state machine returns the original result.
  a.handle('C', { type: 'Forward', command: cmd }, 8);
  assert.equal(a.stable.log.length, 2);
  a.handle('B', { type: 'AppendEntriesReply', term: 1, success: true, matchIndex: 2, prevLogIndex: 1 }, 9);
  const again = a.handle('C', { type: 'AppendEntriesReply', term: 1, success: true, matchIndex: 2, prevLogIndex: 1 }, 9);
  assert.deepEqual(only(again, 'ClientReply').map((r) => r.result), ['已確認']);
  assert.equal(a.volatile?.kv.get('x'), 'w1');
  // Same identity, different intent -> identity conflict, data unchanged.
  a.handle('writer', { type: 'ClientRequest', command: { ...cmd, value: 'other' } }, 10);
  a.handle('B', { type: 'AppendEntriesReply', term: 1, success: true, matchIndex: 3, prevLogIndex: 2 }, 11);
  const conflict = a.handle('C', { type: 'AppendEntriesReply', term: 1, success: true, matchIndex: 3, prevLogIndex: 2 }, 11);
  assert.deepEqual(only(conflict, 'ClientReply').map((r) => r.result), ['請求識別衝突']);
  assert.equal(a.volatile?.kv.get('x'), 'w1');
});

test('D6: reads are log entries; an isolated leader never answers a read from local data', () => {
  const a = leaderA();
  a.handle('writer', { type: 'ClientRequest', command: { clientId: 'reader', requestId: 'r', action: 'read', key: 'x' } }, 6);
  const outs = [...a.tick(6), ...a.tick(7), ...a.tick(30)];
  assert.deepEqual(only(outs, 'ClientReply'), [], 'no reply without a majority');
  assert.equal(a.volatile?.commitIndex, 0);
});

test('D7: a different intent under the same identity is not deduplicated away; it is answered as a conflict', () => {
  const a = leaderA();
  const red = entry(1, 'same-id', '紅').command;
  a.handle('writer', { type: 'ClientRequest', command: red }, 6);
  // Same identity, different intent, while the original is still uncommitted (gateway and leader both hold it).
  a.handle('writer', { type: 'ClientRequest', command: { ...red, value: '藍' } }, 6);
  a.handle('C', { type: 'Forward', command: { ...red, value: '藍' } }, 6);
  assert.deepEqual(a.stable.log.map((e) => e.command.value), ['紅', '藍'], 'conflicting intent is appended once, not dropped');
  a.handle('B', { type: 'AppendEntriesReply', term: 1, success: true, matchIndex: 2, prevLogIndex: 0 }, 7);
  const replies = only(a.handle('C', { type: 'AppendEntriesReply', term: 1, success: true, matchIndex: 2, prevLogIndex: 0 }, 7), 'ClientReply');
  assert.deepEqual(replies.map((r) => r.result), ['已確認', '請求識別衝突']);
  assert.equal(a.volatile?.kv.get('x'), '紅');
});
