import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../helpers/data.ts';
import { runBaseline } from '../../src/scenarios/drivers.ts';
import { checkHistory, historyToCheckOps } from '../../src/checker/linearizability.ts';
import { ABSENT } from '../../src/types.ts';

const AC_BUDGET = { maxStates: 100_000 };

test('AC-RUL-01 客戶端基準讀寫符合單機可見語義（baseline_case）', () => {
  const data = scenarios();
  const c = data.baseline_case;
  const run = runBaseline(data, { type: 'seed', seed: data.replay_case.seed });
  const ops = run.experiment.history();

  assert.equal(run.steps.length, c.steps.length);
  for (const [i, step] of c.steps.entries()) {
    const op = ops.find((o) => o.requestId === step.request);
    assert.ok(op, `${step.request} was invoked`);
    assert.equal(op.client, step.client);
    assert.equal(op.action, step.action);
    assert.equal(op.key, step.key);
    assert.equal(op.outcome.status, '已完成', `${step.request} completed`);
    if (op.outcome.status !== '已完成') continue;
    assert.equal(op.outcome.result, step.expected, `${step.request} result`);
    assert.ok(op.outcome.complete - op.invoke <= c.completion_bound_per_operation_ticks, `${step.request} within ${c.completion_bound_per_operation_ticks} ticks`);
    // Sequential: each step starts after the previous one completed.
    const prev = i > 0 ? ops.find((o) => o.requestId === c.steps[i - 1]!.request) : undefined;
    if (prev && prev.outcome.status === '已完成') assert.ok(op.invoke > prev.outcome.complete);
  }
  // Absent keys yield the explicit absent result, not an empty value.
  const absentSteps = c.steps.filter((s) => s.expected === data.cluster.absent_result);
  assert.ok(absentSteps.length >= 2);
  assert.equal(data.cluster.absent_result, ABSENT);

  // The observed history maps to a single-machine sequence in step order.
  const verdict = checkHistory(historyToCheckOps(ops), c.initial_values, AC_BUDGET);
  assert.equal(verdict.type, '合法');
  if (verdict.type === '合法') {
    const order = verdict.witness.flatMap((w) => w.order);
    for (const key of new Set(c.steps.map((s) => s.key))) {
      const expected = c.steps.filter((s) => s.key === key).map((s) => s.request);
      assert.deepEqual(order.filter((id) => expected.includes(id)), expected);
    }
  }
});
