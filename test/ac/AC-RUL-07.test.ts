import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../helpers/data.ts';
import { timingStrategies } from '../helpers/strategies.ts';
import { assertLinearizable, assertSnapshotContents, assertStageSequence, completedOperation, stageSpec } from '../helpers/snapshot.ts';
import { runSnapshotCase } from '../../src/scenarios/drivers.ts';
import { canonicalJson } from '../../src/canonical.ts';
import { strategyName } from '../../src/chooser.ts';
import { requestKey } from '../../src/types.ts';

test('AC-RUL-07 落後節點跨越已壓縮區段後恢復可用（snapshot_case，235 種策略）', () => {
  const data = scenarios();
  for (const strategy of timingStrategies(data.cluster.members, data.replay_case.seed)) {
    const run = runSnapshotCase(data, strategy);
    const exp = run.experiment;
    const context = strategyName(strategy);
    assertStageSequence(data, run);
    assertSnapshotContents(data, run);
    const isolate = stageSpec(data, 'partition');
    const snapshot = stageSpec(data, 'take_snapshot');
    const compress = stageSpec(data, 'compact_covered_log');
    const crash = stageSpec(data, 'crash');
    const restart = stageSpec(data, 'restart');
    const rejoin = stageSpec(data, 'heal');
    const read = data.snapshot_case.stages.find((s) => s.via === data.snapshot_case.lagging_member && s.action === 'read')!;
    const lagging = data.snapshot_case.lagging_member;
    const compacted = run.stageStates[compress.id]!;
    for (const member of compress.members!) {
      const before = run.stageStates[snapshot.id]!.stable[member]!;
      const after = compacted.stable[member]!;
      assert.ok(after.snapshot, `${context} ${member}: compacted snapshot survives`);
      assert.equal(after.logStartIndex, after.snapshot.lastIncludedIndex + 1, `${context} ${member}: global offset advances`);
      assert.equal(after.logBaseTerm, after.snapshot.lastIncludedTerm, `${context} ${member}: compacted boundary term survives`);
      assert.ok(after.log.length < before.log.length, `${context} ${member}: detailed prefix really removed`);
      for (const request of compress.covered_requests!) {
        assert.ok(!after.log.some((entry) => entry.command.requestId === request), `${context} ${member}: ${request} removed from detail`);
      }
      assert.equal(canonicalJson(after.snapshot), canonicalJson(before.snapshot), `${context} ${member}: compact does not alter state-machine snapshot`);
    }
    // E did not participate in confirmation, and the historical capture is not an alias of final state.
    const isolated = run.stageStates[compress.id]!;
    assert.equal(isolate.isolated_member, lagging);
    const lagStatus = isolated.statuses.find((s) => s.node === lagging)!;
    assert.equal(lagStatus.lastApplied, 0, `${context}: isolated E applied no confirmed request`);
    for (const [key, value] of Object.entries(snapshot.expected_values!)) {
      assert.notEqual(isolated.values[lagging]![key], value, `${context}: E remained behind before recovery`);
    }
    const stopped = run.stageStates[crash.id]!;
    const rebuilt = run.stageStates[restart.id]!;
    assert.equal(stopped.statuses.find((s) => s.node === crash.target)!.alive, false, `${context}: crash really stops B`);
    assert.equal(canonicalJson(compacted.stable[crash.target!]), canonicalJson(stopped.stable[crash.target!]), `${context}: crash retains stable bytes`);
    assert.equal(canonicalJson(stopped.stable[crash.target!]), canonicalJson(rebuilt.stable[crash.target!]), `${context}: restart retains stable bytes`);
    const restartedStatus = rebuilt.statuses.find((s) => s.node === restart.target)!;
    const restartedSnapshot = rebuilt.stable[restart.target!]!.snapshot!;
    assert.equal(restartedStatus.alive, true, `${context}: B restarted`);
    assert.equal(restartedStatus.role, 'follower', `${context}: role is rebuilt`);
    assert.equal(restartedStatus.lastApplied, restartedSnapshot.lastIncludedIndex, `${context}: restart restores applied boundary`);
    assert.equal(restartedStatus.commitIndex, restartedSnapshot.lastIncludedIndex, `${context}: restart restores committed boundary`);
    assert.deepEqual(rebuilt.values[restart.target!], restartedSnapshot.kv, `${context}: restart restores snapshot KV`);
    const readStage = run.stages.find((s) => s.id === read.id)!;
    const rejoinStage = run.stages.find((s) => s.id === rejoin.id)!;
    assert.equal(readStage.start, rejoinStage.end + 1, `${context}: read starts immediately after heal`);
    const recoveredRead = completedOperation(exp, read.client!, read.request!);
    assert.equal(recoveredRead.op.attempts[0]!.via, read.via, `${context}: actual request went through E`);
    assert.ok(recoveredRead.op.replies.every((r) => r.result === read.expected), `${context}: no successful stale reply during recovery`);
    const recovered = run.stageStates[read.id]!;
    const e = recovered.statuses.find((s) => s.node === lagging)!;
    const recoveredSnapshot = recovered.stable[lagging]!.snapshot;
    assert.ok(recoveredSnapshot, `${context}: E actually installed a snapshot`);
    assert.ok(e.commitIndex >= recoveredSnapshot.lastIncludedIndex && e.lastApplied >= recoveredSnapshot.lastIncludedIndex, `${context}: E reached the snapshot boundary`);
    assert.equal(recovered.values[lagging]![read.key!], read.expected, `${context}: E caught up with current value`);
    const readRef = requestKey(read.client!, read.request!);
    assert.ok(exp.nodeAppliedRequests(lagging).includes(readRef), `${context}: E applied the new read, not just a forwarded response`);
    const snapshotDeliveries = exp.log().filter((entry) => entry.action === 'deliver' && exp.messageById(entry.target)?.to === lagging && exp.messageById(entry.target)?.payload.type === 'InstallSnapshot');
    assert.ok(snapshotDeliveries.length > 0, `${context}: catch-up crossed the original network as InstallSnapshot`);
    assert.ok(snapshotDeliveries.some((entry) => entry.tick > rejoinStage.start && entry.tick <= readStage.end), `${context}: installation happened in the recovery stage`);
    assertLinearizable(data, exp);
  }
});
