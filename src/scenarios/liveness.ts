// Liveness judge (ADR-0002 E3): completion is required only when the window preconditions really held in
// the run. Deadlines come from the data; the judge never extends them. Safety is the checker's job.
import type { Experiment } from '../sim/experiment.ts';

export const MISSING_MAJORITY = '存活且可互相送達的多數';

export interface LivenessWindow {
  readonly from: number;
  readonly to: number;
  readonly alive: readonly string[];
  readonly clientReachable: readonly string[];
  readonly deliveryBound: number;
  readonly deadlines: readonly { readonly client: string; readonly request: string; readonly by: number }[];
}

export interface LivenessJudgement {
  /** True when every precondition held, so the deadlines apply. */
  readonly required: boolean;
  /** Preconditions that did not hold (completion is then not required). */
  readonly missing: string[];
  /** Deadline misses while completion was required. */
  readonly violations: string[];
}

const same = (a: readonly string[], b: readonly string[]) => [...a].sort().join() === [...b].sort().join();

export function judgeLiveness(exp: Experiment, w: LivenessWindow): LivenessJudgement {
  const rec = exp.recording();
  const members = rec.config.members;
  const majority = Math.floor(members.length / 2) + 1;
  const missing: string[] = [];
  const add = (m: string) => {
    if (!missing.includes(m)) missing.push(m);
  };
  if (exp.now < w.to) add(`觀察未到窗口終點 ${w.to}`);
  // Events at the window's first tick count as inside it, except the heal/crash that establish it.
  const inWindow = rec.script.filter((e) => e.tick >= w.from && e.tick <= w.to && !(e.tick === w.from && (e.type === 'heal' || e.type === 'crash')));
  // Alive members: as specified, a majority, and unchanged inside the window.
  const alive = exp.nodeStatuses().filter((n) => n.alive).map((n) => n.node);
  if (w.alive.length < majority || !same(alive, w.alive)) add(MISSING_MAJORITY);
  if (inWindow.some((e) => e.type === 'crash' || e.type === 'restart')) add(MISSING_MAJORITY);
  // Mutual reachability: no partition in force and no new partition or drop inside the window.
  const groups = exp.partitionGroups();
  if (groups !== null && !groups.some((g) => w.alive.every((m) => g.includes(m)))) add(MISSING_MAJORITY);
  if (inWindow.some((e) => e.type === 'partition')) add('窗口內沒有新的分割');
  if (inWindow.some((e) => e.type === 'drop')) add('窗口內沒有丟棄');
  // Clients reach the specified members.
  if (!same(exp.clientReachableNow(), w.clientReachable) || inWindow.some((e) => e.type === 'client-reach')) add('客戶端可達指定成員');
  // Bounded delivery inside the window.
  const bounds = [exp.deliveryBoundAt(w.from), ...(rec.config.deliveryBounds ?? []).filter((b) => b.fromTick > w.from && b.fromTick <= w.to).map((b) => b.bound)];
  if (bounds.some((b) => b > w.deliveryBound)) add('傳遞上限');

  const violations: string[] = [];
  if (missing.length === 0) {
    for (const d of w.deadlines) {
      const op = exp.history().find((o) => o.client === d.client && o.requestId === d.request);
      if (op === undefined) violations.push(`${d.request} 未發出`);
      else if (op.outcome.status !== '已完成') violations.push(`${d.request} 在 ${d.by} 前未完成`);
      else if (op.outcome.complete > d.by) violations.push(`${d.request} 於 ${op.outcome.complete} 完成，晚於 ${d.by}`);
    }
  }
  return { required: missing.length === 0, missing, violations };
}
