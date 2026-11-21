import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../helpers/data.ts';
import { timingStrategies } from '../helpers/strategies.ts';
import { runPartitionCase, type PartitionRun } from '../../src/scenarios/drivers.ts';
import { checkHistory, historyToCheckOps } from '../../src/checker/linearizability.ts';
import { strategyName, type Strategy } from '../../src/chooser.ts';
import type { Scenarios } from '../../src/scenarios/data.ts';

const AC_BUDGET = { maxStates: 100_000 };

/** Returns the list of violated expectations of partition_case for one run (empty = pass). */
function violations(data: Scenarios, run: PartitionRun): string[] {
  const c = data.partition_case;
  const probeSpec = c.minority_stale_read_probe;
  const out: string[] = [];
  const exp = run.experiment;
  const ops = exp.history();
  const op = (id: string) => ops.find((o) => o.requestId === id);
  const [minoritySpec, majoritySpec] = c.new_operations;
  const minority = op(minoritySpec!.request as string);
  const majority = op(majoritySpec!.request as string);
  const probe = op(probeSpec.operation.request as string);

  if (exp.now !== probeSpec.observe_through_tick) out.push(`observed through ${exp.now}, expected ${probeSpec.observe_through_tick}`);
  // Minority side: the new write is not confirmed (未確認或不可用).
  if (!minority) out.push('minority-new not invoked');
  else if (minority.outcome.status !== '未完成') out.push(`minority-new completed: ${JSON.stringify(minority.outcome)}`);
  else if (minority.invoke !== minoritySpec!.invoke || minority.attempts[0]?.via !== minoritySpec!.via) out.push('minority-new not sent as specified');
  // Majority side: confirmed by complete_by.
  if (!majority) out.push('majority-new not invoked');
  else if (majority.outcome.status !== '已完成') out.push('majority-new not completed');
  else {
    if (majority.outcome.result !== majoritySpec!.expected) out.push(`majority-new result ${majority.outcome.result}`);
    if (majority.outcome.complete > (majoritySpec!.complete_by as number)) out.push(`majority-new completed at ${majority.outcome.complete} > ${majoritySpec!.complete_by}`);
  }
  // Stale-read probe: started after majority-new completed, via the minority; no result (not 不存在, not even 藍) through 40.
  if (!probe) out.push('probe not invoked');
  else {
    if (majority?.outcome.status === '已完成' && probe.invoke !== majority.outcome.complete + 1) out.push(`probe invoked at ${probe.invoke}`);
    if (probe.attempts[0]?.via !== probeSpec.operation.via) out.push('probe not sent via the minority');
    if (probe.outcome.status !== '未完成') out.push(`probe returned ${JSON.stringify(probe.outcome)}`);
    if (probe.replies.some((r) => r.result === probeSpec.operation.forbidden_result)) out.push('probe saw the forbidden result');
  }
  // The old leader keeps self-reporting leader on the minority side; that is not a success basis.
  const a = exp.nodeStatus(minoritySpec!.via as string);
  if (a.role !== 'leader') out.push(`minority node ${a.node} self-reports ${a.role}, expected the stale leader`);
  // The whole confirmed history stays linearizable (pending operations may or may not take effect).
  const verdict = checkHistory(historyToCheckOps(ops), data.cluster.initial_values, AC_BUDGET);
  if (verdict.type !== '合法') out.push(`checker: ${verdict.type}`);
  return out;
}

test('AC-RUL-03 少數分割保持未確認並由多數維持合法結果（partition_case，seed 5105）', () => {
  const data = scenarios();
  const run = runPartitionCase(data, { type: 'seed', seed: data.replay_case.seed });
  assert.deepEqual(violations(data, run), []);
  // Both sides are visible: minority stale leader and majority leader of a newer term coexist.
  const statuses = run.experiment.nodeStatuses();
  const leaders = statuses.filter((s) => s.role === 'leader');
  assert.ok(leaders.length >= 2, 'two self-reported leaders of different terms coexist');
  assert.notEqual(leaders[0]!.term, leaders[1]!.term);
});

test('AC-RUL-03 少數分割保持未確認並由多數維持合法結果（min、max、32 種目的地延遲、種子 5105＋200 個種子）', () => {
  const data = scenarios();
  const failures: string[] = [];
  const strategies: Strategy[] = timingStrategies(data.cluster.members, data.replay_case.seed);
  for (const s of strategies) {
    const v = violations(data, runPartitionCase(data, s));
    if (v.length > 0) failures.push(`${strategyName(s)}: ${v.join('; ')}`);
  }
  assert.deepEqual(failures, []);
  assert.equal(strategies.length, 2 + 32 + 1 + 200);
});
