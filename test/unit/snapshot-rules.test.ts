import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RaftNode } from '../../src/sim/node.ts';
import type { Entry, Outgoing, Payload, Snapshot } from '../../src/sim/messages.ts';
import { intentOf, requestKey } from '../../src/types.ts';

const MEMBERS = ['A', 'B', 'C', 'D', 'E'];
const node = (id = 'B') => new RaftNode(id, { members: MEMBERS, electionTimeout: 4, heartbeatInterval: 1, gatewayResendInterval: 4, staleCandidateBackoff: 25, initialValues: {} }, 0);
const entry = (term: number, requestId: string, value = requestId): Entry => ({ term, command: { clientId: 'writer', requestId, action: 'write', key: 'x', value } });
const ae = (p: Partial<Extract<Payload, { type: 'AppendEntries' }>> = {}): Extract<Payload, { type: 'AppendEntries' }> => ({ type: 'AppendEntries', term: 3, leaderId: 'A', prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0, ...p });
const only = <T extends Payload['type']>(outs: Outgoing[], type: T) => outs.map((o) => o.payload).filter((p): p is Extract<Payload, { type: T }> => p.type === type);
const install = (n: RaftNode, snapshot: Snapshot, term = 3, now = 10) => n.handle('A', { type: 'InstallSnapshot', term, leaderId: 'A', snapshot }, now);

function loaded(entries: Entry[], commit = entries.length, id = 'B'): RaftNode {
  const n = node(id);
  n.handle('A', ae({ entries, leaderCommit: commit }), 1);
  return n;
}

function elect(n: RaftNode, now: number): void {
  n.tick(now);
  const term = n.stable.currentTerm;
  for (const peer of MEMBERS.filter((m) => m !== n.id).slice(0, 2)) {
    n.handle(peer, { type: 'RequestVoteReply', term, voteGranted: true, logOk: true }, now + 1);
  }
  assert.equal(n.volatile?.role, 'leader');
}

test('ADR-0003 S2: snapshot captures only applied state, is copied, and compaction is a separate guarded operation', () => {
  const empty = node();
  assert.throws(() => empty.takeSnapshot(), /applied prefix/);
  assert.throws(() => empty.compact(), /stable snapshot/);
  const red = entry(3, 'red', '紅');
  const n = loaded([red, entry(3, 'uncommitted', '藍')], 1);
  const snapshot = n.takeSnapshot();
  assert.equal(snapshot.lastIncludedIndex, 1);
  assert.deepEqual(snapshot.kv, { x: '紅' });
  assert.deepEqual(snapshot.effects, [requestKey('writer', 'red')]);
  assert.equal(snapshot.applied[requestKey('writer', 'uncommitted')], undefined);
  assert.equal(n.stable.log.length, 2, 'taking the snapshot retains detailed entries');
  assert.equal(n.stable.logStartIndex, 1);
  (snapshot.kv as Record<string, string>).x = 'corrupted caller copy';
  (snapshot.applied[requestKey('writer', 'red')] as { result: string }).result = 'corrupted caller copy';
  (snapshot.effects as string[]).push('corrupted caller copy');
  assert.equal(n.stable.snapshot?.kv.x, '紅');
  assert.equal(n.stable.snapshot?.applied[requestKey('writer', 'red')]?.result, '已確認');
  n.compact();
  assert.equal(n.stable.logStartIndex, 2);
  assert.equal(n.stable.logBaseTerm, 3);
  assert.deepEqual(n.stable.log.map((e) => e.command.requestId), ['uncommitted']);
  const stable = structuredClone(n.stable);
  n.compact();
  assert.deepEqual(n.stable, stable, 'repeated compaction is idempotent');
  n.crash();
  assert.throws(() => n.takeSnapshot(), /crashed/);
  assert.throws(() => n.compact(), /crashed/);
  n.restart(15);
  assert.deepEqual(n.stable, stable, 'restart preserves the stable image');
  assert.equal(n.volatile?.commitIndex, 1);
  assert.equal(n.volatile?.lastApplied, 1);
  assert.equal(n.volatile?.kv.get('x'), '紅', 'uncommitted suffix is not applied on restart');
  assert.deepEqual(n.volatile?.effects, [requestKey('writer', 'red')]);
});

test('ADR-0003 S1: compact at 5, then snapshot at 8 without compacting retains the older boundary term through restart and replication', () => {
  const entries = Array.from({ length: 8 }, (_, i) => entry(i < 5 ? 2 : 3, `w${i + 1}`));
  const n = loaded(entries, 5);
  n.takeSnapshot();
  n.compact();
  n.handle('A', ae({ prevLogIndex: 5, prevLogTerm: 2, entries: entries.slice(5), leaderCommit: 8 }), 2);
  n.takeSnapshot();
  assert.equal(n.stable.snapshot?.lastIncludedIndex, 8);
  assert.equal(n.stable.snapshot?.lastIncludedTerm, 3);
  assert.equal(n.stable.logStartIndex, 6);
  assert.equal(n.stable.logBaseTerm, 2, 'taking a newer snapshot must not overwrite the actual boundary term');
  const before = structuredClone(n.stable);
  n.crash();
  n.restart(20);
  assert.deepEqual(n.stable, before);
  assert.equal(n.volatile?.lastApplied, 8);
  elect(n, 24);
  n.handle('C', { type: 'AppendEntriesReply', term: 4, success: false, matchIndex: 0, prevLogIndex: 6 }, 26);
  const sent = n.tick(27).find((o) => o.to === 'C')?.payload;
  assert.equal(sent?.type, 'AppendEntries');
  if (sent?.type !== 'AppendEntries') return;
  assert.equal(sent.prevLogIndex, 5);
  assert.equal(sent.prevLogTerm, 2, 'uses logBaseTerm, not latest snapshot term 3');
  assert.deepEqual(sent.entries.map((e) => e.command.requestId), ['w6', 'w7', 'w8']);
  const receiver = loaded(entries.slice(0, 5), 5, 'C');
  receiver.takeSnapshot();
  receiver.compact();
  const ack = only(receiver.handle(n.id, sent, 28), 'AppendEntriesReply')[0];
  assert.equal(ack?.success, true);
  assert.equal(ack?.matchIndex, 8);
});

test('ADR-0003 S3: old AppendEntries below the compacted boundary return only a retry hint; committed entries cannot be truncated', () => {
  const n = loaded([entry(2, 'red', '紅'), entry(3, 'blue', '藍')]);
  n.takeSnapshot();
  n.compact();
  const before = structuredClone(n.stable);
  const ack = only(n.handle('A', ae({ entries: [entry(3, 'wrong')], leaderCommit: 99 }), 10), 'AppendEntriesReply')[0];
  assert.deepEqual(ack, { type: 'AppendEntriesReply', term: 3, success: false, matchIndex: 0, prevLogIndex: 0, nextIndexHint: 3 });
  assert.deepEqual(n.stable, before);
  assert.equal(n.volatile?.lastApplied, 2);
  assert.equal(n.volatile?.kv.get('x'), '藍');
  n.handle('A', ae({ prevLogIndex: 2, prevLogTerm: 3, entries: [entry(3, 'suffix')], leaderCommit: 3 }), 11);
  const bad = only(n.handle('A', ae({ prevLogIndex: 2, prevLogTerm: 3, entries: [entry(2, 'conflict')], leaderCommit: 3 }), 12), 'AppendEntriesReply')[0];
  assert.equal(bad?.success, false);
  assert.equal(n.stable.log[0]?.command.requestId, 'suffix');
  assert.equal(n.volatile?.lastApplied, 3);
});

test('ADR-0003 S3: installing a matching boundary keeps only the suffix; a conflicting boundary drops the uncommitted suffix', () => {
  const entries = [entry(1, 'red', '紅'), entry(2, 'blue', '藍'), entry(2, 'third'), entry(3, 'fourth')];
  const snapshot = loaded(entries.slice(0, 3)).takeSnapshot();
  const n = loaded(entries, 1);
  const out = install(n, snapshot);
  assert.deepEqual(only(out, 'InstallSnapshotReply'), [{ type: 'InstallSnapshotReply', term: 3, lastIncludedIndex: 3, success: true }]);
  assert.deepEqual(only(out, 'ClientReply'), [], 'installing state is not a client success');
  assert.deepEqual(n.stable.log.map((e) => e.command.requestId), ['fourth']);
  assert.equal(n.stable.logStartIndex, 4);
  assert.equal(n.stable.logBaseTerm, 2);
  assert.equal(n.volatile?.lastApplied, 3);
  n.handle('A', ae({ prevLogIndex: 4, prevLogTerm: 3, leaderCommit: 4 }), 11);
  assert.equal(n.volatile?.kv.get('x'), 'fourth');
  const conflicting = loaded([entries[0]!, entries[1]!, entry(3, 'different')]).takeSnapshot();
  const m = loaded(entries, 1, 'C');
  install(m, conflicting);
  assert.deepEqual(m.stable.log, []);
  assert.equal(m.stable.logStartIndex, 4);
  assert.equal(m.stable.logBaseTerm, 3);
  m.crash();
  m.restart(12);
  assert.equal(m.volatile?.kv.get('x'), 'different', 'acknowledged image survives an immediate crash');
  assert.equal(m.volatile?.lastApplied, 3);
});

test('ADR-0003 S3: stale terms and reordered snapshots never roll state back; replies prove the requested boundary only', () => {
  const source = loaded([entry(2, 'red', '紅')]);
  const old = source.takeSnapshot();
  source.handle('A', ae({ prevLogIndex: 1, prevLogTerm: 2, entries: [entry(3, 'blue', '藍')], leaderCommit: 2 }), 2);
  const newer = source.takeSnapshot();
  const n = node();
  install(n, newer, 4, 10);
  const image = structuredClone(n.stable);
  const timer = n.volatile?.electionResetAt;
  const stale = install(n, old, 3, 11);
  assert.equal(only(stale, 'InstallSnapshotReply')[0]?.success, false);
  assert.deepEqual(n.stable, image);
  assert.equal(n.volatile?.electionResetAt, timer, 'stale term does not reset the timer');
  const reordered = install(n, old, 4, 12);
  assert.equal(only(reordered, 'InstallSnapshotReply')[0]?.lastIncludedIndex, 1, 'do not claim the larger local index 2');
  assert.deepEqual(n.stable, image);
  install(n, newer, 4, 13);
  assert.deepEqual(n.stable, image, 'a duplicate is idempotent');
  assert.equal(n.volatile?.lastApplied, 2);
  assert.equal(n.volatile?.kv.get('x'), '藍');
  assert.deepEqual(only([...reordered, ...stale], 'ClientReply'), []);
});

test('ADR-0003 S3: snapshot messages and installed state do not alias mutable sender state or the in-flight payload', () => {
  const leader = loaded([entry(3, 'red', '紅')], 1, 'A');
  leader.takeSnapshot();
  leader.compact();
  elect(leader, 5);
  leader.handle('E', { type: 'AppendEntriesReply', term: 4, success: false, matchIndex: 0, prevLogIndex: 0 }, 7);
  const payload = leader.tick(8).find((o) => o.to === 'E')?.payload;
  assert.equal(payload?.type, 'InstallSnapshot');
  if (payload?.type !== 'InstallSnapshot') return;
  leader.volatile?.kv.set('x', 'later live value');
  assert.equal(payload.snapshot.kv.x, '紅');
  const follower = node('E');
  follower.handle('A', payload, 9);
  (payload.snapshot.kv as Record<string, string>).x = 'mutated payload';
  (payload.snapshot.applied[requestKey('writer', 'red')] as { result: string }).result = 'mutated payload';
  assert.equal(follower.stable.snapshot?.kv.x, '紅');
  assert.equal(follower.volatile?.kv.get('x'), '紅');
  assert.equal(follower.stable.snapshot?.applied[requestKey('writer', 'red')]?.result, '已確認');
});

test('ADR-0003 S3: snapshot and append acknowledgements are term-checked and monotone; a hint never proves replication', () => {
  const n = loaded([entry(2, 'one'), entry(3, 'two')], 2, 'A');
  n.takeSnapshot();
  n.compact();
  elect(n, 5);
  n.handle('E', { type: 'InstallSnapshotReply', term: 4, lastIncludedIndex: 2, success: true }, 7);
  n.handle('E', { type: 'InstallSnapshotReply', term: 4, lastIncludedIndex: 1, success: true }, 8);
  n.handle('E', { type: 'AppendEntriesReply', term: 4, success: false, matchIndex: 0, prevLogIndex: 0, nextIndexHint: 1 }, 9);
  assert.equal(n.volatile?.matchIndex.get('E'), 2);
  assert.equal(n.volatile?.nextIndex.get('E'), 3);
  n.handle('D', { type: 'InstallSnapshotReply', term: 3, lastIncludedIndex: 2, success: true }, 10);
  n.handle('D', { type: 'InstallSnapshotReply', term: 4, lastIncludedIndex: 2, success: false }, 10);
  n.handle('D', { type: 'AppendEntriesReply', term: 4, success: false, matchIndex: 2, prevLogIndex: 0, nextIndexHint: 99 }, 10);
  assert.equal(n.volatile?.matchIndex.get('D'), 0, 'neither stale/failed ack nor a hint proves entries match');
  assert.equal(n.volatile?.nextIndex.get('D'), 3, 'hint is capped by leader last index + 1');
  n.handle('D', { type: 'InstallSnapshotReply', term: 5, lastIncludedIndex: 2, success: true }, 11);
  assert.equal(n.volatile?.role, 'follower');
  assert.equal(n.stable.currentTerm, 5);
});

test('ADR-0003 S1: snapshot boundary controls voting freshness, and snapshot acknowledgements do not commit an older-term suffix', () => {
  const n = loaded([entry(2, 'base'), entry(3, 'old-term-suffix')], 1, 'C');
  n.takeSnapshot();
  n.compact();
  n.handle('D', { type: 'RequestVote', term: 4, candidateId: 'D', lastLogIndex: 0, lastLogTerm: 0 }, 2);
  assert.equal(n.stable.votedFor, null);
  elect(n, 6); // term 5, retained index 2 still belongs to term 3
  n.handle('D', { type: 'InstallSnapshotReply', term: 5, lastIncludedIndex: 1, success: true }, 8);
  n.handle('E', { type: 'InstallSnapshotReply', term: 5, lastIncludedIndex: 1, success: true }, 8);
  n.handle('D', { type: 'AppendEntriesReply', term: 5, success: true, matchIndex: 2, prevLogIndex: 1 }, 9);
  n.handle('E', { type: 'AppendEntriesReply', term: 5, success: true, matchIndex: 2, prevLogIndex: 1 }, 9);
  assert.equal(n.volatile?.commitIndex, 1, 'replicas of an old-term suffix are not sufficient to commit it');
  n.handle('writer', { type: 'ClientRequest', command: entry(5, 'new-term').command }, 10);
  n.handle('D', { type: 'AppendEntriesReply', term: 5, success: true, matchIndex: 3, prevLogIndex: 2 }, 11);
  n.handle('E', { type: 'AppendEntriesReply', term: 5, success: true, matchIndex: 3, prevLogIndex: 2 }, 11);
  assert.equal(n.volatile?.commitIndex, 3);
  assert.equal(n.volatile?.kv.get('x'), 'new-term');
  const snapshotOnly = loaded([entry(3, 'latest')]);
  snapshotOnly.takeSnapshot();
  snapshotOnly.compact();
  const vote = only(snapshotOnly.handle('D', { type: 'RequestVote', term: 4, candidateId: 'D', lastLogIndex: 0, lastLogTerm: 0 }, 2), 'RequestVoteReply')[0];
  assert.equal(vote?.voteGranted, false);
  assert.equal(vote?.logOk, false, 'an empty suffix still has the snapshot boundary term');
});

test('ADR-0003 S2/S3: installed snapshot survives restart with original write/read results and one logical effect per request', () => {
  const red = entry(3, 'red', '紅').command;
  const read = { clientId: 'reader', requestId: 'read-red', action: 'read' as const, key: 'x' };
  const entries: Entry[] = [{ term: 3, command: red }, { term: 3, command: read }, entry(3, 'blue', '藍')];
  const source = loaded(entries);
  const snapshot = source.takeSnapshot();
  const n = node('E');
  install(n, snapshot);
  n.crash();
  n.restart(20);
  const stable = structuredClone(n.stable);
  elect(n, 24);
  const retry = (command: typeof red | typeof read, index: number, now: number): Extract<Payload, { type: 'ClientReply' }>[] => {
    n.handle(command.clientId, { type: 'ClientRequest', command }, now);
    n.handle('A', { type: 'AppendEntriesReply', term: 4, success: true, matchIndex: index, prevLogIndex: index - 1 }, now + 1);
    return only(n.handle('B', { type: 'AppendEntriesReply', term: 4, success: true, matchIndex: index, prevLogIndex: index - 1 }, now + 1), 'ClientReply');
  };
  assert.deepEqual(retry(red, 4, 26).map((p) => p.result), ['已確認']);
  assert.deepEqual(retry(read, 5, 28).map((p) => p.result), ['紅'], 'old read result survives newer blue value');
  const conflict = { ...red, value: 'another intent' };
  const replies = retry(conflict, 6, 30);
  assert.deepEqual(replies.map((p) => p.result), ['請求識別衝突']);
  assert.equal(replies[0]?.intent, intentOf(conflict), 'reply matches the actual conflicting request intent');
  assert.equal(n.volatile?.kv.get('x'), '藍');
  assert.deepEqual(n.volatile?.effects, snapshot.effects);
  assert.equal(n.volatile?.effects.filter((key) => key === requestKey('writer', 'red')).length, 1);
  assert.deepEqual(n.stable.snapshot, stable.snapshot, 'applying a retry does not mutate the stable snapshot');
});
