import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../helpers/data.ts';
import { runRetryCase } from '../../src/scenarios/drivers.ts';
import { checkHistory, historyToCheckOps } from '../../src/checker/linearizability.ts';
import { strategyName, type Strategy } from '../../src/chooser.ts';
import { CONFIRMED } from '../../src/types.ts';
import type { Scenarios } from '../../src/scenarios/data.ts';

const AC_BUDGET = { maxStates: 100_000 };
const STRATEGIES: Strategy[] = [{ type: 'min' }, { type: 'max' }, ...Array.from({ length: 21 }, (_, i) => ({ type: 'seed' as const, seed: i === 0 ? 5105 : i }))];

/** '原操作的已確認結果' in the data means: the original operation's confirmed result. */
const expectedOf = (e: string | undefined) => (e === '原操作的已確認結果' ? CONFIRMED : e);

function violations(data: Scenarios, name: 'completed_write' | 'completed_read', s: Strategy): string[] {
  const c = data.retry_cases[name];
  const run = runRetryCase(data, name, s);
  const exp = run.experiment;
  const ops = exp.history();
  const out: string[] = [];
  const firstIndex = new Map<string, number>();
  c.steps.forEach((st, i) => {
    if (!firstIndex.has(st.request)) firstIndex.set(st.request, i);
  });
  for (const [i, st] of c.steps.entries()) {
    const op = ops.find((o) => o.requestId === st.request);
    if (!op || op.outcome.status !== '已完成') {
      out.push(`${st.request} not completed`);
      continue;
    }
    if (st.is_retry) {
      // The retry is another attempt of the original operation and is answered with the original result.
      const original = c.steps[firstIndex.get(st.request)!]!;
      const retry = op.attempts.at(-1)!;
      if (op.attempts.length < 2) out.push(`${st.request}: retry not recorded as an attempt of the original operation`);
      if (retry.reply !== op.outcome.result) out.push(`${st.request}: retry got ${retry.reply}, original ${op.outcome.result}`);
      if (retry.reply !== expectedOf(st.expected)) out.push(`${st.request}: retry result ${retry.reply}, expected ${expectedOf(st.expected)}`);
      if (op.outcome.result !== expectedOf(original.expected)) out.push(`${st.request}: original result changed to ${op.outcome.result}`);
      const prev = ops.find((o) => o.requestId === c.steps[i - 1]!.request);
      if (prev?.outcome.status !== '已完成' || retry.sentAt <= prev.outcome.complete) out.push(`${st.request}: retry not sent after the newer step completed`);
    } else if (op.outcome.result !== st.expected) out.push(`${st.request}: ${op.outcome.result}, expected ${st.expected}`);
  }
  // The retry really reached the cluster (not a late duplicate reply): it added a new log entry that the
  // state machine answered from its dedup table, so the request's effect was applied exactly once.
  for (const st of c.steps.filter((x) => x.is_retry)) {
    const ref = `${st.client}/${st.request}`;
    for (const m of run.settledMembers) {
      const entries = exp.nodeStable(m).log.filter((e) => e.command.clientId === st.client && e.command.requestId === st.request).length;
      if (entries < 2) out.push(`${m}: retry of ${st.request} added no log entry (${entries})`);
      if (exp.nodeAppliedRequests(m).filter((k) => k === ref).length !== 1) out.push(`${m}: ${st.request} effect not applied exactly once`);
    }
  }
  // No old value written back: every settled state machine holds the newest written value.
  const lastWrite = [...c.steps].reverse().find((st) => st.action === 'write' && !st.is_retry)!;
  for (const m of run.settledMembers) if (exp.nodeValue(m, lastWrite.key) !== lastWrite.value) out.push(`${m}.${lastWrite.key} = ${exp.nodeValue(m, lastWrite.key)}`);
  if (run.settledMembers.length < data.cluster.majority_count) out.push('fewer than a majority settled');
  const distinct = new Set(c.steps.map((st) => st.request)).size;
  if (ops.length !== distinct) out.push(`${ops.length} logical operations, expected ${distinct}`);
  const declared = (c as { expected_distinct_logical_operations?: number }).expected_distinct_logical_operations;
  if (declared !== undefined && ops.length !== declared) out.push(`distinct ops ${ops.length} != ${declared}`);
  const v = checkHistory(historyToCheckOps(ops), data.cluster.initial_values, AC_BUDGET);
  if (v.type !== '合法') out.push(`checker: ${v.type}`);
  return out;
}

test('AC-RUL-05 已完成操作的重試不回寫舊值或改變舊讀值（retry_cases.completed_write）', () => {
  const data = scenarios();
  const failures = STRATEGIES.flatMap((s) => violations(data, 'completed_write', s).map((v) => `${strategyName(s)}: ${v}`));
  assert.deepEqual(failures, []);
  assert.equal(data.retry_cases.completed_write.expected_distinct_logical_operations, 3);
});

test('AC-RUL-05 已完成操作的重試不回寫舊值或改變舊讀值（retry_cases.completed_read）', () => {
  const data = scenarios();
  const failures = STRATEGIES.flatMap((s) => violations(data, 'completed_read', s).map((v) => `${strategyName(s)}: ${v}`));
  assert.deepEqual(failures, []);
});
