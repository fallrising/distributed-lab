import assert from 'node:assert/strict';
import { runSnapshotCase } from '../../src/scenarios/drivers.ts';
import type { Scenarios } from '../../src/scenarios/data.ts';
import type { Experiment } from '../../src/sim/experiment.ts';
import { checkHistory, historyToCheckOps } from '../../src/checker/linearizability.ts';
import { intentOf, requestKey } from '../../src/types.ts';

export type SnapshotRun = ReturnType<typeof runSnapshotCase>;
export type SnapshotStage = Scenarios['snapshot_case']['stages'][number];

export function stageSpec(data: Scenarios, action: string): SnapshotStage {
  const stage = data.snapshot_case.stages.find((s) => s.action === action);
  assert.ok(stage, `snapshot_case contains ${action}`);
  return stage;
}

export function operation(exp: Experiment, client: string, request: string) {
  const op = exp.history().find((o) => o.client === client && o.requestId === request);
  assert.ok(op, `${client}/${request} was invoked`);
  return op;
}

export function completedOperation(exp: Experiment, client: string, request: string) {
  const op = operation(exp, client, request);
  assert.equal(op.outcome.status, '已完成', `${client}/${request} completed`);
  if (op.outcome.status !== '已完成') throw new Error('operation did not complete');
  return { op, result: op.outcome.result, complete: op.outcome.complete };
}

export function assertStageSequence(data: Scenarios, run: SnapshotRun, compaction = true): void {
  const omit = compaction ? [] : data.snapshot_equivalence.variants.find((v) => v.id === 'without_compaction')!.omit_stages!;
  const ids = [...data.snapshot_case.stages.filter((s) => !omit.includes(s.id)).map((s) => s.id), 'retry-original', 'new-read-after-retry'];
  assert.deepEqual(run.stages.map((s) => s.id), ids, 'no required stage omitted or invented');
  let previousEnd = 0;
  for (const stage of run.stages) {
    assert.equal(stage.start, previousEnd + 1, `${stage.id}: starts immediately after the preceding stage`);
    assert.ok(stage.end >= stage.start, `${stage.id}: end follows start`);
    assert.ok(stage.end - stage.start <= data.snapshot_case.completion_bound_per_stage_ticks, `${stage.id}: original stage deadline`);
    assert.equal(stage.ok, true, `${stage.id}: completed`);
    assert.ok(run.stageStates[stage.id], `${stage.id}: captured actual end state`);
    previousEnd = stage.end;
  }
  assert.equal(run.experiment.now, previousEnd, 'no unbudgeted settling after the final stage');
  for (const spec of data.snapshot_case.stages) {
    if (spec.request === undefined || spec.client === undefined) continue;
    const result = completedOperation(run.experiment, spec.client, spec.request);
    const stage = run.stages.find((s) => s.id === spec.id)!;
    assert.equal(result.op.invoke, stage.start, `${spec.id}: request starts at original stage start`);
    assert.equal(result.result, spec.expected ?? spec.require_result, `${spec.id}: result from pinned data`);
    assert.ok(result.complete <= stage.start + data.snapshot_case.completion_bound_per_stage_ticks, `${spec.id}: client reply within deadline`);
    assert.ok(result.complete <= stage.end, `${spec.id}: result observed before advancing stage`);
  }
}

export function assertSnapshotContents(data: Scenarios, run: SnapshotRun): void {
  const spec = stageSpec(data, 'take_snapshot');
  const before = run.stageStates[spec.id]!;
  for (const member of spec.members!) {
    const snapshot = before.stable[member]!.snapshot;
    assert.ok(snapshot, `${member}: stable snapshot exists`);
    assert.deepEqual(snapshot.kv, spec.expected_values, `${member}: snapshot KV from pinned data`);
    assert.ok(snapshot.lastIncludedIndex > 0, `${member}: nonempty committed prefix`);
    const status = before.statuses.find((s) => s.node === member)!;
    assert.equal(snapshot.lastIncludedIndex, status.lastApplied, `${member}: snapshot covers applied prefix only`);
    assert.ok(snapshot.lastIncludedIndex <= status.commitIndex, `${member}: snapshot is committed`);
    for (const request of spec.covers_confirmed_requests!) {
      const original = data.snapshot_case.stages.find((s) => s.request === request)!;
      const ref = requestKey(original.client!, original.request!);
      const record: { readonly intent: string; readonly result: string } | undefined = snapshot.applied[ref];
      assert.ok(record, `${member}: snapshot retains ${ref} identity`);
      assert.equal(record.intent, intentOf({ clientId: original.client!, requestId: original.request!, action: original.action as 'read' | 'write', key: original.key!, ...(original.value !== undefined ? { value: original.value } : {}) }));
      assert.equal(record.result, original.require_result ?? original.expected, `${member}: original result retained`);
      assert.equal(snapshot.effects.filter((key) => key === ref).length, 1, `${member}: one effect for ${ref}`);
    }
  }
}

export function assertLinearizable(data: Scenarios, exp: Experiment): void {
  const result = checkHistory(historyToCheckOps(exp.history()), data.cluster.initial_values, { maxStates: 100_000 });
  assert.equal(result.type, '合法', 'complete logical history remains linearizable');
}

/** Compare the four business dimensions named by snapshot_equivalence.compare, excluding timing. */
export function businessResult(data: Scenarios, run: SnapshotRun) {
  const operations = run.experiment.history().map((op) => {
    assert.equal(op.outcome.status, '已完成', `${op.client}/${op.requestId}: pair must complete`);
    return {
      client: op.client,
      requestId: op.requestId,
      action: op.action,
      key: op.key,
      value: op.value,
      intent: op.intent,
      result: op.outcome.status === '已完成' ? op.outcome.result : undefined,
    };
  }).sort((a, b) => requestKey(a.client, a.requestId).localeCompare(requestKey(b.client, b.requestId)));
  const final = run.stageStates['new-read-after-retry']!;
  return {
    operations,
    readResults: operations.filter((op) => op.action === 'read').map((op) => ({ client: op.client, requestId: op.requestId, result: op.result })),
    confirmedValues: Object.fromEntries(data.cluster.members.map((member) => [member, final.values[member]])),
  };
}
