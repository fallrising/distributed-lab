import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../helpers/data.ts';
import { noLivenessWindow, runNoLiveness } from '../../src/scenarios/drivers.ts';
import { judgeLiveness } from '../../src/scenarios/liveness.ts';
import { strategyName, type Strategy } from '../../src/chooser.ts';
import { requestKey } from '../../src/types.ts';
import type { Scenarios } from '../../src/scenarios/data.ts';

const STRATEGIES: Strategy[] = [{ type: 'min' }, { type: 'max' }, ...Array.from({ length: 21 }, (_, i) => ({ type: 'seed' as const, seed: i === 0 ? 5105 : i }))];

function violations(data: Scenarios, s: Strategy): string[] {
  const c = data.no_liveness_case;
  const exp = runNoLiveness(data, s).experiment;
  const out: string[] = [];
  if (exp.now !== c.observation_end_tick) out.push(`observed to ${exp.now}`);
  const op = exp.history().find((o) => o.requestId === c.new_write.request);
  if (!op) return ['write not invoked'];
  // Allowed: 未確認 or 不可用. Forbidden: 已確認, and no success reply may mask unavailability.
  if (op.outcome.status !== '未完成') out.push(`outcome ${JSON.stringify(op.outcome)}`);
  if (op.replies.some((r) => r.result === c.forbidden_result)) out.push('a success reply was delivered');
  const seen = op.attempts.map((a) => (a.result === 'unavailable' ? '不可用' : '未確認'));
  if (!seen.every((x) => c.allowed_results.includes(x))) out.push(`attempt results ${seen.join(',')}`);
  if (!op.attempts.some((a) => a.result === 'unavailable')) out.push('no attempt reported 不可用 within the observation');
  // The log explains the missing precondition for this request.
  const ref = requestKey(c.new_write.client, c.new_write.request);
  const notes = exp.log().filter((e) => e.kind === 'effect' && e.action === 'precondition' && e.requestRef === ref);
  if (!notes.some((e) => String(e.outcome).includes(c.missing_precondition))) out.push(`log does not explain "${c.missing_precondition}"`);
  // Unfinished is not judged a liveness violation when the precondition is missing.
  const j = judgeLiveness(exp, noLivenessWindow(data));
  if (j.required) out.push('judge requires completion without a majority');
  if (!j.missing.includes(c.missing_precondition)) out.push(`judge missing: ${j.missing.join(', ')}`);
  if (j.violations.length > 0) out.push(`judge violations: ${j.violations.join('; ')}`);
  // Nodes really are as specified.
  const alive = exp.nodeStatuses().filter((n) => n.alive).map((n) => n.node);
  if (alive.join() !== c.alive_members.join()) out.push(`alive ${alive.join()}`);
  return out;
}

test('AC-QLT-03 缺少活性前提不產生虛假成功（no_liveness_case）', () => {
  const data = scenarios();
  const failures = STRATEGIES.flatMap((s) => violations(data, s).map((v) => `${strategyName(s)}: ${v}`));
  assert.deepEqual(failures, []);
});
