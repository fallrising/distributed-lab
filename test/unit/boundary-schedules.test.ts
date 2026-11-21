// ADR-0001 D5 "證據不只靠推導": two fixed boundary schedules for partition_case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../helpers/data.ts';
import { runPartitionCase } from '../../src/scenarios/drivers.ts';
import type { ChoiceContext, ChoiceKind, Option, Strategy } from '../../src/chooser.ts';
import type { Experiment, MessageView } from '../../src/sim/experiment.ts';

type DelayRule = (ctx: ChoiceContext) => number | undefined;

/** Delay = first matching rule, else 2 (the bound); every order choice takes the first option. */
function schedule(name: string, rules: DelayRule[]): Strategy {
  return {
    type: 'function',
    name,
    pick: (kind: ChoiceKind, options: readonly Option[], ctx: ChoiceContext) => {
      if (kind !== 'delay') return options[0] as Option;
      for (const r of rules) {
        const d = r(ctx);
        if (d !== undefined) return d;
      }
      return 2;
    },
  };
}
const at = (tick: number, from: string, to: string | null, d: number): DelayRule => (c) => (c.tick === tick && c.from === from && (to === null || c.to === to) ? d : undefined);

function allMessages(exp: Experiment): MessageView[] {
  const out: MessageView[] = [];
  for (let i = 1; ; i++) {
    const m = exp.messageById(`msg-${i}`);
    if (m === undefined) return out;
    out.push(m);
  }
}
const deliveredAt = (exp: Experiment, id: string) => exp.log().find((e) => e.kind === 'effect' && e.action === 'deliver' && e.target === id)?.tick;
const majorityDone = (exp: Experiment) => {
  const o = exp.history().find((x) => x.requestId === 'majority-new');
  return o?.outcome.status === '已完成' ? o.outcome.complete : null;
};

test('D5 zero-slack schedule: A elected at 8, D last reset 5, C last reset 9; C runs at 16 and wins before D times out', () => {
  const data = scenarios();
  const s = schedule('zero-slack', [
    at(4, 'A', 'D', 1), // D votes at 5 (its last reset)
    at(5, 'D', 'A', 2), // D's vote arrives at 7
    at(8, 'A', 'C', 1), // first heartbeat reaches C at 9 (C's last reset)
    at(8, 'A', 'D', 2), // first heartbeat to D would arrive at 10: dropped by the partition
    at(9, 'A', null, 1), // heartbeats sent at 9 arrive at 10: cross-group ones dropped
    at(16, 'C', 'D', 2), // C's RequestVote reaches D at the latest possible tick
  ]);
  const exp = runPartitionCase(data, s).experiment;
  const msgs = allMessages(exp);
  const firstHeartbeat = msgs.find((m) => m.from === 'A' && m.payload.type === 'AppendEntries');
  assert.equal(firstHeartbeat?.sentAt, 8, 'A becomes leader at 8');
  const toD = msgs.filter((m) => m.from === 'A' && m.to === 'D' && m.payload.type === 'AppendEntries');
  assert.ok(toD.every((m) => deliveredAt(exp, m.id) === undefined), 'no heartbeat ever reaches D, so D last reset at 5 (vote)');
  const cVote = msgs.find((m) => m.from === 'C' && m.payload.type === 'RequestVote' && m.to === 'D');
  assert.equal(cVote?.sentAt, 16, 'C campaigns at 9 + 7');
  assert.equal(deliveredAt(exp, cVote!.id), 18);
  assert.ok(18 < 5 + 14, 'one tick of slack before D (timeout 14) would campaign');
  assert.ok(!msgs.some((m) => m.from === 'D' && m.payload.type === 'RequestVote'), 'D never campaigns: no split vote');
  const done = majorityDone(exp);
  assert.ok(done !== null && done <= 30, `majority-new completed at ${done}`);
});

test('D5 first-review counterexample: first heartbeat reaches D and E but not C; C is not rejected as having an older log', () => {
  const data = scenarios();
  const s = schedule('first-review-counterexample', [
    at(8, 'A', 'C', 2), // arrives at 10: dropped by the partition
    at(8, 'A', null, 1),
    at(9, 'A', 'C', 1), // arrives at 10: dropped
  ]);
  const exp = runPartitionCase(data, s).experiment;
  const msgs = allMessages(exp);
  assert.equal(msgs.find((m) => m.from === 'A' && m.payload.type === 'AppendEntries')?.sentAt, 8);
  assert.ok(msgs.filter((m) => m.from === 'A' && m.to === 'C' && m.payload.type === 'AppendEntries').every((m) => deliveredAt(exp, m.id) === undefined));
  // No term-start no-op: every log in the majority is still empty when C campaigns, so no vote is refused for log age.
  const refusals = msgs.filter((m) => m.to === 'C' && m.payload.type === 'RequestVoteReply' && !m.payload.voteGranted);
  assert.deepEqual(refusals.map((m) => m.id), []);
  const done = majorityDone(exp);
  assert.ok(done !== null && done <= 30, `majority-new completed at ${done}`);
});
