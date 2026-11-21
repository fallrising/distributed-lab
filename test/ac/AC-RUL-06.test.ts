import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../helpers/data.ts';
import { runConflictingIntent, runPendingRetry } from '../../src/scenarios/drivers.ts';
import { checkHistory, historyToCheckOps } from '../../src/checker/linearizability.ts';
import { strategyName, type Strategy } from '../../src/chooser.ts';
import { CONFIRMED, intentOf, requestKey } from '../../src/types.ts';
import type { Scenarios } from '../../src/scenarios/data.ts';

const AC_BUDGET = { maxStates: 100_000 };
const STRATEGIES: Strategy[] = [{ type: 'min' }, { type: 'max' }, ...Array.from({ length: 21 }, (_, i) => ({ type: 'seed' as const, seed: i === 0 ? 5105 : i }))];

function conflictViolations(data: Scenarios, s: Strategy): string[] {
  const c = data.retry_cases.conflicting_intent;
  const run = runConflictingIntent(data, s);
  const ops = run.experiment.history();
  const out: string[] = [];
  if (ops.length !== 1) out.push(`${ops.length} logical operations, expected 1`);
  const op = ops[0];
  if (!op || op.outcome.status !== '已完成' || op.outcome.result !== c.original.expected) out.push(`original outcome ${JSON.stringify(op?.outcome)}`);
  if (op?.conflicts.length !== c.conflicting_attempts.length) out.push(`conflicts recorded: ${op?.conflicts.length}`);
  for (const [i, a] of c.conflicting_attempts.entries()) {
    const rec = op?.conflicts[i];
    const intent = intentOf({ clientId: a.client, requestId: a.request, action: a.action as 'read' | 'write', key: a.key, ...(a.value !== undefined ? { value: a.value } : {}) });
    if (rec?.intent !== intent) out.push(`conflict ${i} intent ${rec?.intent}`);
    if (rec?.result !== c.expected_each) out.push(`conflict ${i} result ${rec?.result}, expected ${c.expected_each}`);
  }
  // No data change: every member's state machine holds the original value.
  for (const [key, value] of Object.entries(c.expected_values_after)) {
    for (const m of run.settledMembers) if (run.experiment.nodeValue(m, key) !== value) out.push(`${m}.${key} = ${run.experiment.nodeValue(m, key)}`);
  }
  const v = checkHistory(historyToCheckOps(ops), data.cluster.initial_values, AC_BUDGET);
  if (v.type !== '合法') out.push(`checker: ${v.type}`);
  return out;
}

function pendingViolations(data: Scenarios, s: Strategy): string[] {
  const c = data.retry_cases.pending_retry;
  const run = runPendingRetry(data, s);
  const exp = run.experiment;
  const ops = exp.history();
  const out: string[] = [];
  if (ops.length !== c.expected_distinct_logical_operations) out.push(`${ops.length} logical operations`);
  const op = ops.find((o) => o.requestId === c.original.request);
  if (!op) return [...out, 'no operation'];
  // The fault: every success reply of the original attempt was dropped before the client saw it.
  const ref = requestKey(c.original.client, c.original.request);
  const dropped = exp.log().filter((e) => e.kind === 'effect' && e.action === 'drop' && e.requestRef === ref);
  if (dropped.length === 0) out.push('no reply was dropped');
  // Only replies sent before the retry are part of the fault; each was dropped before delivery.
  const retryAt = op.attempts[1]?.sentAt ?? Infinity;
  for (const d of dropped) {
    const m = exp.messageById(d.target);
    if (!m || m.sentAt >= retryAt) out.push(`dropped ${d.target} was not sent before the retry`);
    if (exp.log().some((e) => e.kind === 'effect' && e.action === 'deliver' && e.target === d.target)) out.push(`${d.target} delivered`);
  }
  if (op.attempts[0]?.result !== 'unavailable') out.push(`first attempt ${op.attempts[0]?.result}, expected unavailable`);
  if (op.attempts.length < 2) out.push('no retry of the same request');
  if (op.outcome.status !== '已完成' || op.outcome.result !== c.expected_final_result) out.push(`final ${JSON.stringify(op.outcome)}`);
  if (op.outcome.status === '已完成' && op.outcome.complete < (op.attempts[1]?.sentAt ?? Infinity)) out.push('completed before the retry');
  if (op.replies[0]?.result !== CONFIRMED) out.push('first reply seen is not the confirmation');
  // One logical effect: the state machine applied the request once and holds the value.
  for (const [key, value] of Object.entries(c.expected_values_after)) {
    for (const m of run.settledMembers) {
      if (exp.nodeValue(m, key) !== value) out.push(`${m}.${key} = ${exp.nodeValue(m, key)}`);
      if (exp.nodeAppliedRequests(m).filter((k) => k === ref).length !== 1) out.push(`${m} applied ${ref} effect not exactly once`);
    }
  }
  return out;
}

test('AC-RUL-06 請求識別衝突與未確認重送有不同結果（conflicting_intent）', () => {
  const data = scenarios();
  const failures = STRATEGIES.flatMap((s) => conflictViolations(data, s).map((v) => `${strategyName(s)}: ${v}`));
  assert.deepEqual(failures, []);
});

test('AC-RUL-06 請求識別衝突與未確認重送有不同結果（pending_retry）', () => {
  const data = scenarios();
  const failures = STRATEGIES.flatMap((s) => pendingViolations(data, s).map((v) => `${strategyName(s)}: ${v}`));
  assert.deepEqual(failures, []);
});
