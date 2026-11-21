import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../helpers/data.ts';
import { LIVENESS_TARGETED_PREFIXES, livenessWindow, runLiveness, type LivenessOptions } from '../../src/scenarios/drivers.ts';
import { judgeLiveness } from '../../src/scenarios/liveness.ts';
import { checkHistory, historyToCheckOps } from '../../src/checker/linearizability.ts';
import type { Scenarios } from '../../src/scenarios/data.ts';

const AC_BUDGET = { maxStates: 100_000 };

function violations(data: Scenarios, opts: LivenessOptions): string[] {
  const c = data.liveness_case;
  const w = c.stable_window;
  const exp = runLiveness(data, opts).experiment;
  const out: string[] = [];
  const write = exp.history().find((o) => o.requestId === c.fault_prefix.pending_write.request);
  const read = exp.history().find((o) => o.requestId === w.fresh_read.request);
  if (!write || write.invoke !== c.fault_prefix.pending_write.invoke) out.push('pending write not invoked as specified');
  if (write?.outcome.status !== '已完成' || write.outcome.result !== data.cluster.successful_write_result) out.push(`write ${JSON.stringify(write?.outcome)}`);
  else if (write.outcome.complete > w.pending_write_complete_by_tick) out.push(`write completed at ${write.outcome.complete} > ${w.pending_write_complete_by_tick}`);
  if (!read || read.invoke !== w.fresh_read.invoke) out.push(`fresh read invoked at ${read?.invoke}`);
  if (read?.outcome.status !== '已完成' || read.outcome.result !== w.fresh_read.expected) out.push(`read ${JSON.stringify(read?.outcome)}`);
  else if (read.outcome.complete > w.fresh_read.complete_by) out.push(`read completed at ${read.outcome.complete} > ${w.fresh_read.complete_by}`);
  // The judge checks the window preconditions from the run itself and uses only the data deadlines.
  const j = judgeLiveness(exp, livenessWindow(data));
  if (!j.required) out.push(`judge: not required (${j.missing.join(', ')})`);
  if (j.violations.length > 0) out.push(`judge: ${j.violations.join('; ')}`);
  if (exp.now < w.ends_at_tick) out.push(`observed only to ${exp.now}`);
  const v = checkHistory(historyToCheckOps(exp.history()), data.cluster.initial_values, AC_BUDGET);
  if (v.type !== '合法') out.push(`checker: ${v.type}`);
  return out;
}

test('AC-QLT-02 恢復穩定多數後在固定窗口內完成（liveness_case，針對性前綴）', () => {
  const data = scenarios();
  const failures: string[] = [];
  assert.ok(LIVENESS_TARGETED_PREFIXES.includes('stale-a-older-term'), 'includes the ADR-0002 review counterexamples');
  for (const prefix of LIVENESS_TARGETED_PREFIXES) {
    // The data leaves the fresh read's gateway open: every client-reachable member is tried.
    for (const readVia of data.liveness_case.stable_window.client_reachable_members) {
      for (const seed of [data.replay_case.seed, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
        const v = violations(data, { prefix, readVia, strategy: { type: 'seed', seed } });
        if (v.length > 0) failures.push(`${prefix}/via ${readVia}/seed:${seed}: ${v.join('; ')}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('AC-QLT-02 恢復穩定多數後在固定窗口內完成（liveness_case，200 個前綴種子 × 前綴傳遞上限 2 與 6）', () => {
  const data = scenarios();
  const failures: string[] = [];
  for (const prefixBound of [2, 6]) {
    for (let seed = 1; seed <= 200; seed++) {
      const readVia = data.liveness_case.stable_window.client_reachable_members[seed % 3];
      const v = violations(data, { prefix: 'random', prefixSeed: seed, prefixBound, strategy: { type: 'seed', seed }, ...(readVia !== undefined ? { readVia } : {}) });
      if (v.length > 0) failures.push(`bound ${prefixBound}/seed:${seed}: ${v.join('; ')}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('AC-QLT-02 期限只取資料，判定者能抓到逾期', () => {
  const data = scenarios();
  const w = livenessWindow(data);
  const exp = runLiveness(data, { prefix: 'random', prefixSeed: 1, prefixBound: 2, strategy: { type: 'seed', seed: 1 } }).experiment;
  assert.deepEqual(
    w.deadlines.map((d) => [d.request, d.by]),
    [
      [data.liveness_case.fault_prefix.pending_write.request, data.liveness_case.stable_window.pending_write_complete_by_tick],
      [data.liveness_case.stable_window.fresh_read.request, data.liveness_case.stable_window.fresh_read.complete_by],
    ],
  );
  // A tighter (wrong) deadline is reported as a violation instead of passing silently.
  const tight = { ...w, deadlines: w.deadlines.map((d) => ({ ...d, by: 11 })) };
  assert.ok(judgeLiveness(exp, tight).violations.length > 0);
});
