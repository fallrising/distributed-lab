import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../helpers/data.ts';
import { timingStrategies } from '../helpers/strategies.ts';
import { assertLinearizable, assertStageSequence, completedOperation, stageSpec } from '../helpers/snapshot.ts';
import { runSnapshotCase } from '../../src/scenarios/drivers.ts';
import { strategyName } from '../../src/chooser.ts';
import { intentOf, requestKey } from '../../src/types.ts';

test('AC-RUL-08 快照及重啟後重試仍是原操作（snapshot_case.retry_after_recovery，235 種策略）', () => {
  const data = scenarios();
  for (const strategy of timingStrategies(data.cluster.members, data.replay_case.seed)) {
    const run = runSnapshotCase(data, strategy);
    const exp = run.experiment;
    const context = strategyName(strategy);
    assertStageSequence(data, run);
    const original = data.snapshot_case.retry_after_recovery.original_request;
    const fresh = data.snapshot_case.retry_after_recovery.new_read;
    const restart = stageSpec(data, 'restart');
    const snapshot = stageSpec(data, 'take_snapshot');
    const ref = requestKey(original.client, original.request);
    const intent = intentOf({ clientId: original.client, requestId: original.request, action: original.action as 'write', key: original.key, value: original.value });
    const { op, result } = completedOperation(exp, original.client, original.request);
    const firstStage = data.snapshot_case.stages.find((s) => s.client === original.client && s.request === original.request)!;
    assert.equal(result, firstStage.require_result, `${context}: original confirmation retained`);
    assert.equal(op.intent, intent, `${context}: logical identity and intent retained`);
    assert.equal(exp.history().filter((o) => o.client === original.client && o.requestId === original.request).length, 1, `${context}: one logical operation`);
    assert.equal(op.attempts.length, 2, `${context}: retry is a second attempt of the original`);
    const attempt = op.attempts[1]!;
    assert.equal(attempt.sentAt, run.retryTick, `${context}: recorded retry tick`);
    assert.equal(attempt.via, restart.target, `${context}: retry goes through restarted B`);
    assert.equal(attempt.result, 'reply', `${context}: retry waits for its own transmission reply`);
    assert.equal(attempt.reply, result, `${context}: retry returns the original result`);
    const retryStage = run.stages.find((s) => s.id === 'retry-original')!;
    assert.equal(run.retryTick, retryStage.start);
    assert.ok(attempt.at! >= attempt.sentAt && attempt.at! <= retryStage.end, `${context}: real retry reply precedes stage completion`);
    const clientDeliveries = exp.log().filter((entry) => {
      const message = exp.messageById(entry.target);
      return entry.action === 'deliver' && message?.sentAt === run.retryTick && message.to === restart.target && message.payload.type === 'ClientRequest' && message.payload.command.clientId === original.client && message.payload.command.requestId === original.request;
    });
    assert.ok(clientDeliveries.length > 0, `${context}: retry reached the node, rather than a client-side cache`);
    const freshReplies = exp.log().filter((entry) => {
      const message = exp.messageById(entry.target);
      return entry.action === 'deliver' && entry.tick === attempt.at && message?.to === original.client && message.sentAt >= run.retryTick && message.payload.type === 'ClientReply' && message.payload.clientId === original.client && message.payload.requestId === original.request && message.payload.intent === intent && message.payload.result === result;
    });
    assert.ok(freshReplies.length > 0, `${context}: retry was answered by a newly sent cluster reply`);
    for (const member of [restart.target!, data.snapshot_case.lagging_member]) {
      const stable = exp.nodeStable(member);
      const retained = stable.snapshot!.applied[ref];
      assert.deepEqual(retained, { intent, result }, `${context} ${member}: recovered snapshot retains the original result`);
      assert.ok(stable.log.some((entry) => entry.command.clientId === original.client && entry.command.requestId === original.request), `${context} ${member}: the retry was logged after compression`);
      assert.equal(exp.nodeAppliedRequests(member).filter((key) => key === ref).length, 1, `${context} ${member}: old write effect was not applied twice`);
      for (const [key, value] of Object.entries(snapshot.expected_values!)) assert.equal(exp.nodeValue(member, key), value, `${context} ${member}: old write did not restore its old value`);
    }
    const freshResult = completedOperation(exp, fresh.client, fresh.request);
    assert.notEqual(fresh.request, original.request, `${context}: latest read has a new logical identity`);
    assert.ok(freshResult.op.invoke > retryStage.end, `${context}: fresh read begins after retry completes`);
    assert.equal(freshResult.result, fresh.expected, `${context}: fresh read keeps the latest value`);
    assertLinearizable(data, exp);
  }
});
