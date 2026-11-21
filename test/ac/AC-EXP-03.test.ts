import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../helpers/data.ts';
import { timingStrategies } from '../helpers/strategies.ts';
import { runCounterfactual, type CounterfactualRun } from '../../src/scenarios/drivers.ts';
import { checkHistory, historyToCheckOps } from '../../src/checker/linearizability.ts';
import { replayExperiment } from '../../src/sim/experiment.ts';
import { canonicalJson } from '../../src/canonical.ts';
import { strategyName, type Strategy } from '../../src/chooser.ts';
import type { Scenarios } from '../../src/scenarios/data.ts';

const AC_BUDGET = { maxStates: 100_000 };

function violations(data: Scenarios, run: CounterfactualRun): string[] {
  const c = data.counterfactual_case;
  const out: string[] = [];
  const { base, branch } = run;
  // Shared prefix (incl. the in-flight request) is identical up to the branch tick.
  if (canonicalJson(run.branchAtBranchTick) !== canonicalJson(run.baseAtBranchTick)) out.push('prefix differs at branch tick');
  const inflight = (ops: ReturnType<typeof base.history>) => ops.find((o) => o.requestId === c.pending_request);
  const atBranch = run.baseAtBranchTick.operations.find((o) => o.requestId === c.pending_request);
  if (!atBranch || atBranch.outcome.status !== '未完成') out.push('pending request not in flight at branch tick');
  // Only the specified event changed.
  const baseScript = base.recording().script.map((e) => canonicalJson(e));
  const branchScript = branch.recording().script.map((e) => canonicalJson(e));
  const added = branchScript.filter((e) => !baseScript.includes(e));
  const removed = baseScript.filter((e) => !branchScript.includes(e));
  const changed = c.branch.changed_event;
  if (removed.length !== 0 || added.length !== 1 || !added[0]!.includes(`"tick":${changed.tick}`) || !added[0]!.includes(`"type":"${changed.action}"`)) {
    out.push(`script diff: +${added.join(',')} -${removed.join(',')}`);
  }
  // Base keeps the request unconfirmed through its observation end.
  const bOp = inflight(base.history());
  if (base.now !== c.original.partition_remains_through) out.push(`base observed through ${base.now}`);
  if (!bOp || bOp.outcome.status !== '未完成') out.push(`base pending request: ${JSON.stringify(bOp?.outcome)}`);
  // Branch completes the same logical operation in the stable window.
  const brOp = inflight(branch.history());
  if (!brOp || brOp.outcome.status !== '已完成') out.push('branch did not complete the pending request');
  else {
    if (brOp.outcome.result !== c.branch.expected_pending_request) out.push(`branch result ${brOp.outcome.result}`);
    if (brOp.outcome.complete > c.branch.complete_by_tick) out.push(`branch completed at ${brOp.outcome.complete}`);
    if (canonicalJson(brOp.attempts[0]) !== canonicalJson(atBranch?.attempts[0])) out.push('branch did not keep tracking the original operation');
  }
  // The original experiment is untouched by branching.
  if (canonicalJson({ r: base.recording(), o: base.observation() }) !== run.baseFingerprintBeforeBranch) out.push('base changed by branching');
  for (const e of [base, branch]) {
    const v = checkHistory(historyToCheckOps(e.history()), data.cluster.initial_values, AC_BUDGET);
    if (v.type !== '合法') out.push(`checker: ${v.type}`);
  }
  return out;
}

test('AC-EXP-03 改變分割事件只分岔檢查點後的歷史（counterfactual_case，seed 5105）', () => {
  const data = scenarios();
  const seed = data.replay_case.seed;
  const run = runCounterfactual(data, { type: 'seed', seed }, { type: 'seed', seed: seed + 1 });
  assert.deepEqual(violations(data, run), []);
  assert.equal(run.branchTick, data.counterfactual_case.branch_tick);
  // Prefix log is identical entry by entry.
  const prefix = (e: typeof run.base) => e.log().filter((x) => x.tick <= run.branchTick);
  assert.equal(canonicalJson(prefix(run.branch)), canonicalJson(prefix(run.base)));
  // Base recording is frozen; the branch has its own frozen, replayable recording.
  assert.ok(Object.isFrozen(run.base.recording()));
  const br = run.branch.recording();
  assert.ok(Object.isFrozen(br));
  const replay = replayExperiment(br).advanceTo(br.endTick);
  assert.equal(canonicalJson(replay.observation()), canonicalJson(run.branch.observation()));
});

test('AC-EXP-03 改變分割事件只分岔檢查點後的歷史（min、max、32 種目的地延遲、種子 5105＋200 個種子）', () => {
  const data = scenarios();
  const failures: string[] = [];
  for (const s of timingStrategies(data.cluster.members, data.replay_case.seed)) {
    const branchStrategy: Strategy = s.type === 'seed' ? { type: 'seed', seed: s.seed + 1_000_000 } : s;
    const v = violations(data, runCounterfactual(data, s, branchStrategy));
    if (v.length > 0) failures.push(`${strategyName(s)}: ${v.join('; ')}`);
  }
  assert.deepEqual(failures, []);
});
