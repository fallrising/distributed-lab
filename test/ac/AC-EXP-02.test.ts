import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../helpers/data.ts';
import { runPartitionCase } from '../../src/scenarios/drivers.ts';
import { replayExperiment, type Observation } from '../../src/sim/experiment.ts';
import { canonicalJson } from '../../src/canonical.ts';
import { ReplayMismatch } from '../../src/chooser.ts';

test('AC-EXP-02 相同重播資料重現同一可見歷史（replay_case）', () => {
  const data = scenarios();
  const rc = data.replay_case;
  assert.equal(rc.basis, 'partition_case');
  const snapshots = new Map<number, Observation>();
  const original = runPartitionCase(data, { type: 'seed', seed: rc.seed }, {
    onTick: (exp) => {
      if (rc.checkpoints.includes(exp.now)) snapshots.set(exp.now, exp.observation());
    },
  }).experiment;
  assert.deepEqual([...snapshots.keys()], rc.checkpoints);

  const recording = original.recording();
  assert.ok(Object.isFrozen(recording) && Object.isFrozen(recording.choices) && Object.isFrozen(recording.script) && Object.isFrozen(recording.config));
  // The recording covers every recorded choice kind of the data (user ops and faults are the script).
  const kinds = new Set(recording.choices.map((c) => c.kind));
  for (const k of ['delay', 'delivery-order', 'node-order'] as const) assert.ok(kinds.has(k), `records ${k}`);
  assert.ok(recording.script.some((e) => e.type === 'invoke') && recording.script.some((e) => e.type === 'partition'));

  const replay = replayExperiment(recording);
  for (const cp of rc.checkpoints) {
    replay.advanceTo(cp);
    const want = snapshots.get(cp)!;
    const got = replay.observation();
    for (const field of rc.required_equal_observations.map(observationField)) {
      assert.equal(canonicalJson(got[field]), canonicalJson(want[field]), `checkpoint ${cp}: ${field}`);
    }
  }
  replay.advanceTo(recording.endTick);
  assert.equal(canonicalJson(replay.observation()), canonicalJson(original.observation()));
  // No unrecorded random outcome: replay consumed exactly the recorded choices, nothing more.
  assert.equal(replay.replayRemaining(), 0);
  assert.equal(canonicalJson(replay.recording().choices), canonicalJson(recording.choices));

  // Traceability: each operation leads from its invoke to its sends and replies in the log.
  for (const op of replay.history()) {
    const related = replay.log().filter((e) => e.requestRef === `${op.client}/${op.requestId}`);
    assert.ok(related.some((e) => e.kind === 'external' && e.action === 'client-invoke'));
    assert.ok(related.some((e) => e.action === 'client-send'));
    if (op.outcome.status === '已完成') assert.ok(related.some((e) => e.action === 'client-reply'));
  }
});

test('AC-EXP-02 重播只取記錄的選擇，篡改或缺少即失敗', () => {
  const data = scenarios();
  const rec = runPartitionCase(data, { type: 'seed', seed: data.replay_case.seed }).experiment.recording();
  const i = rec.choices.findIndex((c) => c.kind === 'delay');
  const tampered = {
    ...rec,
    choices: rec.choices.map((c, j) => (j === i ? { ...c, value: c.options.find((o) => o !== c.value)! } : c)),
  };
  let diverged = false;
  try {
    const r = replayExperiment(tampered);
    r.advanceTo(rec.endTick);
    diverged = r.replayRemaining() !== 0 || canonicalJson(r.observation()) !== canonicalJson(replayExperiment(rec).advanceTo(rec.endTick).observation());
  } catch (e) {
    assert.ok(e instanceof ReplayMismatch);
    diverged = true;
  }
  assert.ok(diverged, 'a different choice log does not silently reproduce the same history');

  const truncated = { ...rec, choices: rec.choices.slice(0, Math.floor(rec.choices.length / 2)) };
  assert.throws(() => replayExperiment(truncated).advanceTo(rec.endTick), ReplayMismatch);
});

function observationField(name: string): keyof Observation {
  switch (name) {
    case '客戶端邏輯操作與結果':
      return 'operations';
    case '外部故障日誌':
      return 'faultLog';
    case '節點可見狀態':
      return 'nodes';
    default:
      throw new Error(`unknown observation ${name}`);
  }
}
