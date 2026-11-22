import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../helpers/data.ts';
import { timingStrategies } from '../helpers/strategies.ts';
import { assertLinearizable, assertStageSequence, businessResult, stageSpec } from '../helpers/snapshot.ts';
import { runSnapshotCase } from '../../src/scenarios/drivers.ts';
import { branchExperiment, replayExperiment } from '../../src/sim/experiment.ts';
import { canonicalJson } from '../../src/canonical.ts';
import { strategyName } from '../../src/chooser.ts';

test('AC-QLT-04 快照開關配對維持相同業務結果（snapshot_equivalence，235 種策略）', () => {
  const data = scenarios();
  assert.equal(data.snapshot_equivalence.basis, 'snapshot_case');
  for (const strategy of timingStrategies(data.cluster.members, data.replay_case.seed)) {
    const withCompaction = runSnapshotCase(data, strategy, { compaction: true });
    const withoutCompaction = runSnapshotCase(data, strategy, { compaction: false });
    const context = strategyName(strategy);
    assertStageSequence(data, withCompaction, true);
    assertStageSequence(data, withoutCompaction, false);
    assert.deepEqual(businessResult(data, withCompaction), businessResult(data, withoutCompaction), `${context}: same identities, completed results, new reads and confirmed KV`);
    const compactTypes = ['take-snapshot', 'compact'];
    assert.ok(withCompaction.experiment.recording().script.some((e) => e.type === 'take-snapshot'), `${context}: enabled variant really takes snapshots`);
    assert.ok(withCompaction.experiment.recording().script.some((e) => e.type === 'compact'), `${context}: enabled variant really compacts`);
    assert.ok(!withoutCompaction.experiment.recording().script.some((e) => compactTypes.includes(e.type)), `${context}: disabled variant really omits the specified stages`);
    for (const member of data.cluster.members) assert.equal(withoutCompaction.experiment.nodeStable(member).snapshot, null, `${context} ${member}: no hidden snapshot in disabled variant`);
    assertLinearizable(data, withCompaction.experiment);
    assertLinearizable(data, withoutCompaction.experiment);
  }
});

test('AC-QLT-04 快照流程可逐階段重播，快照後分支保留前綴及原實驗', () => {
  const data = scenarios();
  const run = runSnapshotCase(data, { type: 'seed', seed: data.replay_case.seed });
  const exp = run.experiment;
  const recording = exp.recording();
  const before = canonicalJson({ recording, observation: exp.observation(), stable: data.cluster.members.map((m) => exp.nodeStable(m)) });
  const replay = replayExperiment(recording);
  for (const stage of run.stages) {
    replay.advanceTo(stage.end);
    const state = run.stageStates[stage.id]!;
    assert.deepEqual(replay.nodeStatuses(), state.statuses, `${stage.id}: node status replay`);
    for (const member of data.cluster.members) {
      assert.deepEqual(replay.nodeStable(member), state.stable[member], `${stage.id} ${member}: stable snapshot/log replay`);
      for (const [key, value] of Object.entries(state.values[member]!)) assert.equal(replay.nodeValue(member, key), value, `${stage.id} ${member}.${key}: state-machine replay`);
    }
  }
  assert.equal(replay.now, recording.endTick);
  assert.equal(canonicalJson(replay.observation()), canonicalJson(exp.observation()), 'all visible operations and fault effects reproduce');
  assert.equal(replay.replayRemaining(), 0, 'replay consumes exactly the recorded choices');
  const snapshotId = stageSpec(data, 'take_snapshot').id;
  const branchTick = run.stages.find((stage) => stage.id === snapshotId)!.end;
  const branch = branchExperiment(exp, branchTick, { remove: (event) => event.type === 'compact' }, { type: 'seed', seed: data.replay_case.seed });
  assert.equal(canonicalJson(branch.log()), canonicalJson(exp.log().filter((entry) => entry.tick <= branchTick)), 'branch includes the identical snapshot prefix');
  assert.deepEqual(branch.nodeStable(data.cluster.members[0]!), run.stageStates[snapshotId]!.stable[data.cluster.members[0]!], 'branch starts with the actual stable snapshot');
  branch.advanceTo(recording.endTick);
  assert.ok(!branch.recording().script.some((event) => event.type === 'compact' && event.tick > branchTick), 'counterfactual removes only later compression events');
  const branchReplay = replayExperiment(branch.recording()).advanceTo(branch.now);
  assert.equal(canonicalJson(branchReplay.observation()), canonicalJson(branch.observation()), 'changed branch has its own complete replay choices');
  assert.equal(branchReplay.replayRemaining(), 0);
  assert.equal(canonicalJson({ recording: exp.recording(), observation: exp.observation(), stable: data.cluster.members.map((m) => exp.nodeStable(m)) }), before, 'branch leaves the base experiment and stable snapshots unchanged');
});
