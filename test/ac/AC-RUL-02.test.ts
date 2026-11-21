import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../helpers/data.ts';
import { checkHistory, smallHistoryOps } from '../../src/checker/linearizability.ts';

const AC_BUDGET = { maxStates: 100_000 };

test('AC-RUL-02 已完成寫入後的新讀取不得回傳被覆蓋前值（illegal_stale_read）', () => {
  const h = scenarios().small_histories.illegal_stale_read;
  assert.equal(h.expected, '非法');
  const verdict = checkHistory(smallHistoryOps(h), h.initial_values, AC_BUDGET);
  assert.equal(verdict.type, '非法');
  if (verdict.type !== '非法') return;
  // Data reason: w-red 完成早於 r-absent 開始，且無後續覆蓋，讀值不可為不存在
  const v = verdict.reason.realTimeViolations.find((x) => x.read === 'r-absent');
  assert.ok(v, 'names the violating read r-absent');
  assert.deepEqual(v.mustFollow, ['w-red']);
  assert.equal(v.value, '不存在');
  assert.equal(v.text, 'r-absent 必須在 w-red 之後');
});

test('AC-RUL-02 已完成寫入後的新讀取不得回傳被覆蓋前值（illegal_reverted_value）', () => {
  const h = scenarios().small_histories.illegal_reverted_value;
  assert.equal(h.expected, '非法');
  const verdict = checkHistory(smallHistoryOps(h), h.initial_values, AC_BUDGET);
  assert.equal(verdict.type, '非法');
  if (verdict.type !== '非法') return;
  // Data reason: 已確認的 w-blue 必須先於 r-old，沒有較新寫入可解釋讀回紅
  const v = verdict.reason.realTimeViolations.find((x) => x.read === 'r-old');
  assert.ok(v, 'names the violating read r-old');
  assert.deepEqual(v.mustFollow, ['w-blue']);
  assert.equal(v.value, '紅');
  assert.equal(v.text, 'r-old 必須在 w-blue 之後，且沒有更新的紅');
});

test('AC-RUL-02 呈現順序或最後收斂不改變非法判定', () => {
  const h = scenarios().small_histories.illegal_reverted_value;
  const ops = smallHistoryOps(h);
  // Presenting the events in another order must not change the verdict.
  for (const order of [ops, [...ops].reverse(), [ops[2]!, ops[0]!, ops[1]!]]) {
    assert.equal(checkHistory(order, h.initial_values, AC_BUDGET).type, '非法');
  }
  // A later read that "converges" to the latest value does not make the earlier stale read legal.
  const converged = [...ops, { id: 'r-late', action: 'read' as const, key: 'x', invoke: 7, complete: 8, result: '藍' }];
  assert.equal(checkHistory(converged, h.initial_values, AC_BUDGET).type, '非法');
});
