import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../helpers/data.ts';
import { runPartitionCase } from '../../src/scenarios/drivers.ts';
import { canonicalJson } from '../../src/canonical.ts';
import { ReplayChooser, ReplayMismatch, StrategyChooser } from '../../src/chooser.ts';
import { SplitMix64 } from '../../src/rng.ts';
import { checkHistory } from '../../src/checker/linearizability.ts';

test('D2: the same strategy yields byte-identical recordings and observations', () => {
  const data = scenarios();
  for (const s of [{ type: 'seed', seed: 7 } as const, { type: 'max' } as const]) {
    const a = runPartitionCase(data, s).experiment;
    const b = runPartitionCase(data, s).experiment;
    assert.equal(canonicalJson(a.recording()), canonicalJson(b.recording()));
    assert.equal(canonicalJson(a.observation()), canonicalJson(b.observation()));
  }
  const x = runPartitionCase(data, { type: 'seed', seed: 1 }).experiment.recording();
  const y = runPartitionCase(data, { type: 'seed', seed: 2 }).experiment.recording();
  assert.notEqual(canonicalJson(x.choices), canonicalJson(y.choices), 'different seeds give different choice logs');
});

test('D2: splitmix64 is a fixed sequence', () => {
  const r = new SplitMix64(0);
  assert.equal(r.next(), 0xe220a8397b1dcdafn);
  assert.equal(r.next(), 0x6e789e6aa1b965f4n);
});

test('D2: ReplayChooser refuses a different kind, tick or option list', () => {
  const rec = new StrategyChooser({ type: 'seed', seed: 3 });
  rec.choose('delay', [1, 2], { tick: 1 });
  rec.choose('node-order', ['A', 'B'], { tick: 1 });
  assert.throws(() => new ReplayChooser(rec.records).choose('node-order', ['A', 'B'], { tick: 1 }), ReplayMismatch);
  assert.throws(() => new ReplayChooser(rec.records).choose('delay', [1, 2], { tick: 2 }), ReplayMismatch);
  assert.throws(() => new ReplayChooser(rec.records).choose('delay', [1, 2, 3], { tick: 1 }), ReplayMismatch);
  const ok = new ReplayChooser(rec.records);
  ok.choose('delay', [1, 2], { tick: 1 });
  ok.choose('node-order', ['A', 'B'], { tick: 1 });
  assert.equal(ok.remaining, 0);
  assert.throws(() => ok.choose('delay', [1, 2], { tick: 1 }), ReplayMismatch, 'nothing beyond the record');
});

test('D9: keys are judged independently and any illegal key makes the history illegal', () => {
  const ops = [
    { id: 'wx', action: 'write' as const, key: 'x', value: '紅', invoke: 1, complete: 2, result: '已確認' },
    { id: 'rx', action: 'read' as const, key: 'x', invoke: 3, complete: 4, result: '紅' },
    { id: 'wy', action: 'write' as const, key: 'y', value: '藍', invoke: 1, complete: 2, result: '已確認' },
    { id: 'ry', action: 'read' as const, key: 'y', invoke: 3, complete: 4, result: '不存在' },
  ];
  const v = checkHistory(ops, {}, { maxStates: 1000 });
  assert.equal(v.type, '非法');
  assert.equal(checkHistory(ops.slice(0, 2), {}, { maxStates: 1000 }).type, '合法');
  // A pending read never constrains the history; a pending write may be left out.
  const pending = [
    { id: 'w', action: 'write' as const, key: 'x', value: '紅', invoke: 1, complete: null },
    { id: 'r', action: 'read' as const, key: 'x', invoke: 2, complete: 3, result: '不存在' },
    { id: 'rp', action: 'read' as const, key: 'x', invoke: 2, complete: null },
  ];
  const pv = checkHistory(pending, {}, { maxStates: 1000 });
  assert.equal(pv.type, '合法');
  if (pv.type === '合法') assert.deepEqual(pv.witness[0]?.includedPending, []);
});
