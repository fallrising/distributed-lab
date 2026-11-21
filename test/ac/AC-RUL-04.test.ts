import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../helpers/data.ts';
import { timingStrategies } from '../helpers/strategies.ts';
import { runDurability, type DurabilityRun } from '../../src/scenarios/drivers.ts';
import { checkHistory, historyToCheckOps } from '../../src/checker/linearizability.ts';
import { canonicalJson } from '../../src/canonical.ts';
import { strategyName } from '../../src/chooser.ts';
import type { Scenarios } from '../../src/scenarios/data.ts';

const AC_BUDGET = { maxStates: 100_000 };

function violations(data: Scenarios, run: DurabilityRun): string[] {
  const c = data.durability_case;
  const stable = c.steps.find((s) => s.stage === 'stable_again')!;
  const bound = stable.duration_ticks as number;
  const out: string[] = [];
  const ops = run.experiment.history();
  for (const step of c.steps) {
    if (step.request === undefined) continue;
    const op = ops.find((o) => o.requestId === step.request);
    if (!op) {
      out.push(`${step.request} not invoked`);
      continue;
    }
    if (op.outcome.status !== '已完成') {
      out.push(`${step.request} not completed`);
      continue;
    }
    const want = step.expected ?? step.require_result;
    if (op.outcome.result !== want) out.push(`${step.request} result ${op.outcome.result}, expected ${want}`);
    if (step.stage !== 'before_crash' && op.outcome.complete - op.invoke > bound) out.push(`${step.request} took ${op.outcome.complete - op.invoke} > ${bound}`);
    if (step.stage !== 'before_crash' && op.invoke <= run.restartTick) out.push(`${step.request} invoked before restart`);
  }
  // All down: every node stopped; stable storage kept byte-for-byte; volatile state gone.
  if (!run.downStatuses.every((s) => !s.alive)) out.push('not all nodes were down after crash');
  if (canonicalJson(run.stableBeforeCrash) !== canonicalJson(run.stableAfterCrash)) out.push('stable storage changed by crash');
  if (canonicalJson(run.stableAfterCrash) !== canonicalJson(run.stableAfterRestart)) out.push('stable storage changed by restart');
  if (!run.restartStatuses.every((s) => s.alive && s.commitIndex === 0 && s.role === 'follower')) out.push('restart did not rebuild from stable storage only');
  // The confirmed write did not disappear: still completed in the history and the whole history is linearizable.
  const red = ops.find((o) => o.requestId === c.steps[0]!.request);
  if (red?.outcome.status !== '已完成') out.push('confirmed write vanished from history');
  const verdict = checkHistory(historyToCheckOps(ops), data.cluster.initial_values, AC_BUDGET);
  if (verdict.type !== '合法') out.push(`checker: ${verdict.type}`);
  return out;
}

test('AC-RUL-04 全體崩潰重啟保留確認結果並允許後續覆蓋（durability_case，seed 5105）', () => {
  const data = scenarios();
  const run = runDurability(data, { type: 'seed', seed: data.replay_case.seed });
  assert.deepEqual(violations(data, run), []);
  assert.deepEqual(
    run.experiment.history().map((o) => o.requestId),
    data.durability_case.steps.filter((s) => s.request !== undefined).map((s) => s.request),
  );
});

test('AC-RUL-04 全體崩潰重啟保留確認結果並允許後續覆蓋（min、max、32 種目的地延遲、種子 5105＋200 個種子）', () => {
  const data = scenarios();
  const failures: string[] = [];
  for (const s of timingStrategies(data.cluster.members, data.replay_case.seed)) {
    const v = violations(data, runDurability(data, s));
    if (v.length > 0) failures.push(`${strategyName(s)}: ${v.join('; ')}`);
  }
  assert.deepEqual(failures, []);
});
