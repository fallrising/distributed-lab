import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../helpers/data.ts';
import { checkHistory, notVerified, buildReport, smallHistoryOps, type Verdict } from '../../src/checker/linearizability.ts';
import type { Clock } from '../../src/checker/clock.ts';

const AC_BUDGET = { maxStates: 100_000 };

/** Deterministic fake clock: every reading advances by `step` ms. */
function steppingClock(step: number): Clock {
  let t = 0;
  return { now: () => (t += step) };
}

test('AC-QLT-01 small_histories 全部案例符合期望與見證', () => {
  const sh = scenarios().small_histories;
  assert.equal(Object.keys(sh).length, 5);
  for (const [name, h] of Object.entries(sh)) {
    const v = checkHistory(smallHistoryOps(h), h.initial_values, AC_BUDGET);
    assert.equal(v.type, h.expected, name);
    if (v.type === '合法') {
      assert.deepEqual(v.witness.flatMap((w) => w.order), h.legal_order_witness, `${name} witness`);
      const included = v.witness.flatMap((w) => w.includedPending);
      const pending = h.operations.filter((o) => o.complete === null).map((o) => o.request);
      // legal_pending_write: 將未完成的 w-red 納入並置於 r-red 之前
      if (h.legal_completion_witness !== undefined) assert.deepEqual(included, pending, `${name} includes the pending write`);
      else assert.deepEqual(included, []);
    }
    if (v.type === '非法') assert.ok(v.reason.text.length > 0, `${name} has a reason`);
  }
});

test('AC-QLT-01 合法、非法與未判定互不混用（analysis_outcomes）', () => {
  const data = scenarios();
  const sh = data.small_histories;
  const legal = sh.legal_overlap;
  const illegal = sh.illegal_reverted_value;
  const verdictFor = (status: string): Verdict => {
    switch (status) {
      case '已完成且有合法序列':
        return checkHistory(smallHistoryOps(legal), legal.initial_values, AC_BUDGET);
      case '已完成且無合法序列':
        return checkHistory(smallHistoryOps(illegal), illegal.initial_values, AC_BUDGET);
      case '時間預算用盡':
        return checkHistory(smallHistoryOps(legal), legal.initial_values, { timeBudgetMs: 1, clock: steppingClock(1) });
      case '資源預算用盡':
        return checkHistory(smallHistoryOps(legal), legal.initial_values, { maxStates: 1 });
      case '尚未執行':
        return notVerified();
      default:
        throw new Error(`unknown analysis status ${status}`);
    }
  };
  assert.equal(data.analysis_outcomes.length, 5);
  for (const o of data.analysis_outcomes) {
    const v = verdictFor(o.analysis_status);
    assert.equal(v.type, o.expected, o.analysis_status);
    if (v.type === '未判定') {
      assert.equal(v.cause, o.analysis_status, 'keeps the reason');
      assert.ok(!('witness' in v) && !('reason' in v), 'no fabricated evidence');
    }
  }

  // Report: only verdict == expectation counts as pass; undetermined and unverified keep their own columns.
  const cases = [
    ...Object.entries(sh).map(([name, h]) => ({ name, expected: h.expected, verdict: checkHistory(smallHistoryOps(h), h.initial_values, AC_BUDGET) })),
    { name: 'legal_overlap/時間預算用盡', expected: legal.expected, verdict: verdictFor('時間預算用盡') },
    { name: 'legal_overlap/資源預算用盡', expected: legal.expected, verdict: verdictFor('資源預算用盡') },
    { name: 'legal_overlap/尚未執行', expected: legal.expected, verdict: verdictFor('尚未執行') },
  ];
  const report = buildReport(cases);
  assert.deepEqual(report.通過.sort(), Object.keys(sh).sort());
  assert.deepEqual(report.失敗, []);
  assert.deepEqual(report.未判定, [
    { name: 'legal_overlap/時間預算用盡', cause: '時間預算用盡' },
    { name: 'legal_overlap/資源預算用盡', cause: '資源預算用盡' },
  ]);
  assert.deepEqual(report.未驗證, ['legal_overlap/尚未執行']);
  // A wrong verdict is a failure, not a pass.
  const wrong = buildReport([{ name: 'x', expected: '非法', verdict: verdictFor('已完成且有合法序列') }]);
  assert.deepEqual(wrong.失敗, ['x']);
  assert.deepEqual(wrong.通過, []);
});
