// Linearizability checker for single-key read/write histories (ADR-0001 D9).
// Wing–Gong / Lowe style DFS per key, memoised on (linearized set, current value).
// Pending writes may take effect at any point after their invoke, or never; pending reads are ignored.
import { ABSENT, CONFLICT } from '../types.ts';
import type { LogicalOp } from '../sim/client.ts';
import type { SmallHistory } from '../scenarios/data.ts';
import type { Clock } from './clock.ts';

export interface CheckOp {
  readonly id: string;
  readonly action: 'read' | 'write';
  readonly key: string;
  readonly value?: string;
  readonly invoke: number;
  /** null = not completed (未完成). */
  readonly complete: number | null;
  readonly result?: string;
}

export interface Budget {
  /** Resource budget: maximum explored states (summed over keys). */
  readonly maxStates?: number;
  /** Time budget in ms, measured with the injected clock. */
  readonly timeBudgetMs?: number;
  readonly clock?: Clock;
}

export interface KeyWitness {
  readonly key: string;
  readonly order: string[];
  /** Pending writes the witness includes (their effect is assumed to have happened). */
  readonly includedPending: string[];
}

export interface RealTimeViolation {
  readonly read: string;
  /** Latest completed writes the read must follow in real time. */
  readonly mustFollow: string[];
  readonly value: string;
  readonly text: string;
}

export interface IllegalReason {
  readonly key: string;
  /** Deepest linearized prefix reached before getting stuck. */
  readonly stuckPrefix: string[];
  /** Why each remaining candidate could not be placed next at that prefix. */
  readonly blocked: { readonly op: string; readonly why: string }[];
  readonly realTimeViolations: RealTimeViolation[];
  readonly text: string;
}

export type UndeterminedCause = '時間預算用盡' | '資源預算用盡';

export type Verdict =
  | { readonly type: '合法'; readonly witness: KeyWitness[] }
  | { readonly type: '非法'; readonly reason: IllegalReason }
  | { readonly type: '未判定'; readonly cause: UndeterminedCause }
  | { readonly type: '未驗證' };

export function notVerified(): Verdict {
  return { type: '未驗證' };
}

class BudgetExhausted extends Error {
  readonly budgetCause: UndeterminedCause;
  constructor(cause: UndeterminedCause) {
    super(cause);
    this.budgetCause = cause;
  }
}

interface Meter {
  states: number;
  readonly maxStates: number;
  readonly deadline: number | null;
  readonly clock: Clock | null;
}

function tickMeter(m: Meter): void {
  m.states += 1;
  if (m.states > m.maxStates) throw new BudgetExhausted('資源預算用盡');
  if (m.deadline !== null && m.clock !== null && m.clock.now() > m.deadline) throw new BudgetExhausted('時間預算用盡');
}

const show = (v: string | undefined) => v ?? ABSENT;
const precedes = (a: CheckOp, b: CheckOp) => a.complete !== null && a.complete < b.invoke;

/** Checks one history. Keys are independent for single-key reads and writes. */
export function checkHistory(ops: readonly CheckOp[], initialValues: Readonly<Record<string, string>>, budget: Budget = {}): Verdict {
  const clock = budget.clock ?? null;
  const meter: Meter = {
    states: 0,
    maxStates: budget.maxStates ?? Number.POSITIVE_INFINITY,
    clock,
    deadline: budget.timeBudgetMs !== undefined && clock !== null ? clock.now() + budget.timeBudgetMs : null,
  };
  const keys = [...new Set(ops.map((o) => o.key))].sort();
  const witness: KeyWitness[] = [];
  let undetermined: UndeterminedCause | null = null;
  for (const key of keys) {
    const keyOps = ops
      .filter((o) => o.key === key)
      .filter((o) => !(o.action === 'read' && o.complete === null)) // pending reads have no effect
      .filter((o) => o.result !== CONFLICT); // rejected identity reuse has no effect
    try {
      const r = checkKey(key, keyOps, initialValues[key], meter);
      if (r.type === '非法') return r; // any illegal key makes the whole history illegal
      witness.push(r.witness);
    } catch (e) {
      if (!(e instanceof BudgetExhausted)) throw e;
      undetermined ??= e.budgetCause;
      // Keep checking other keys only for a definite 非法; budgets are shared, so stop here.
      break;
    }
  }
  if (undetermined !== null) return { type: '未判定', cause: undetermined };
  return { type: '合法', witness };
}

function checkKey(key: string, ops: readonly CheckOp[], initial: string | undefined, meter: Meter): { type: '合法'; witness: KeyWitness } | { type: '非法'; reason: IllegalReason } {
  // Deterministic candidate order: by invoke, then id.
  const sorted = [...ops].sort((a, b) => a.invoke - b.invoke || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = sorted.length;
  const required = sorted.map((o) => o.complete !== null);
  const seen = new Set<string>();
  let deepest: number[] = [];
  let deepestBlocked: { op: string; why: string }[] = [];

  const valueKey = (v: string | undefined) => (v === undefined ? '\u0000' : `=${v}`);

  const dfs = (done: boolean[], order: number[], value: string | undefined): number[] | null => {
    tickMeter(meter);
    if (required.every((r, i) => !r || done[i])) return order;
    const memo = done.map((d) => (d ? '1' : '0')).join('') + valueKey(value);
    if (seen.has(memo)) return null;
    seen.add(memo);
    const blocked: { op: string; why: string }[] = [];
    for (let i = 0; i < n; i++) {
      if (done[i]) continue;
      const op = sorted[i] as CheckOp;
      const before = sorted.findIndex((a, j) => j !== i && !done[j] && precedes(a, op));
      if (before !== -1) {
        blocked.push({ op: op.id, why: `必須先排入 ${(sorted[before] as CheckOp).id}（它在 ${op.id} 開始前已完成）` });
        continue;
      }
      if (op.action === 'read' && show(value) !== op.result) {
        blocked.push({ op: op.id, why: `讀到 ${op.result ?? '?'}，但此位置的值是 ${show(value)}` });
        continue;
      }
      const next = done.slice();
      next[i] = true;
      const r = dfs(next, [...order, i], op.action === 'write' ? op.value : value);
      if (r !== null) return r;
    }
    if (order.length >= deepest.length) {
      deepest = order;
      deepestBlocked = blocked;
    }
    return null;
  };

  const found = dfs(sorted.map(() => false), [], initial);
  if (found !== null) {
    return {
      type: '合法',
      witness: {
        key,
        order: found.map((i) => (sorted[i] as CheckOp).id),
        includedPending: found.filter((i) => (sorted[i] as CheckOp).complete === null).map((i) => (sorted[i] as CheckOp).id),
      },
    };
  }
  const violations = realTimeViolations(sorted, initial);
  const stuckPrefix = deepest.map((i) => (sorted[i] as CheckOp).id);
  const text =
    violations.length > 0
      ? violations.map((v) => v.text).join('；')
      : `鍵 ${key} 沒有合法序列；卡在 [${stuckPrefix.join(', ')}] 之後：${deepestBlocked.map((b) => `${b.op} ${b.why}`).join('；')}`;
  return { type: '非法', reason: { key, stuckPrefix, blocked: deepestBlocked, realTimeViolations: violations, text } };
}

/**
 * A completed read that real-time order forbids: it must follow some completed writes, and no write that
 * may still come after the latest of them (and before the read) produced the value it returned.
 */
function realTimeViolations(ops: readonly CheckOp[], initial: string | undefined): RealTimeViolation[] {
  const out: RealTimeViolation[] = [];
  const writes = ops.filter((o) => o.action === 'write');
  for (const r of ops) {
    if (r.action !== 'read' || r.complete === null) continue;
    const must = writes.filter((w) => precedes(w, r));
    if (must.length === 0) {
      if (show(initial) === r.result || writes.some((w) => w.value === r.result && !precedes(r, w))) continue;
      out.push({ read: r.id, mustFollow: [], value: r.result ?? ABSENT, text: `${r.id} 讀到 ${r.result ?? ABSENT}，沒有寫入能解釋` });
      continue;
    }
    // Latest writes among those the read must follow: not forced before another one of them.
    const latest = must.filter((w) => !must.some((x) => x !== w && precedes(w, x)));
    const explains = (x: CheckOp) => x.value === r.result && !precedes(r, x) && latest.every((l) => l === x || !precedes(x, l));
    if (writes.some(explains)) continue;
    const value = r.result ?? ABSENT;
    const ids = latest.map((w) => w.id).sort();
    const text = value === ABSENT ? `${r.id} 必須在 ${ids.join('、')} 之後` : `${r.id} 必須在 ${ids.join('、')} 之後，且沒有更新的${value}`;
    out.push({ read: r.id, mustFollow: ids, value, text });
  }
  return out;
}

// ---------------------------------------------------------------- adapters

export function smallHistoryOps(h: SmallHistory): CheckOp[] {
  return h.operations.map((o) => ({
    id: o.request,
    action: o.action,
    key: o.key,
    ...(o.value !== undefined ? { value: o.value } : {}),
    invoke: o.invoke,
    complete: o.complete,
    ...(o.complete !== null ? { result: o.result } : {}),
  }));
}

/** Logical operations of an experiment. Retries stay one operation; 不可用 is never a result (ADR D8). */
export function historyToCheckOps(ops: readonly LogicalOp[]): CheckOp[] {
  return ops.map((o) => ({
    id: o.requestId,
    action: o.action,
    key: o.key,
    ...(o.value !== undefined ? { value: o.value } : {}),
    invoke: o.invoke,
    complete: o.outcome.status === '已完成' ? o.outcome.complete : null,
    ...(o.outcome.status === '已完成' ? { result: o.outcome.result } : {}),
  }));
}

// ---------------------------------------------------------------- case evaluation and report

export type CaseColumn = '通過' | '失敗' | '未判定' | '未驗證';

/** A case passes only when the verdict equals the data's expectation. */
export function evaluateCase(verdict: Verdict, expected: string): CaseColumn {
  if (verdict.type === '未判定') return '未判定';
  if (verdict.type === '未驗證') return '未驗證';
  return verdict.type === expected ? '通過' : '失敗';
}

export interface Report {
  readonly 通過: string[];
  readonly 失敗: string[];
  readonly 未判定: { readonly name: string; readonly cause: UndeterminedCause }[];
  readonly 未驗證: string[];
}

export function buildReport(cases: readonly { readonly name: string; readonly expected: string; readonly verdict: Verdict }[]): Report {
  const report: Report = { 通過: [], 失敗: [], 未判定: [], 未驗證: [] };
  for (const c of cases) {
    const col = evaluateCase(c.verdict, c.expected);
    if (col === '未判定' && c.verdict.type === '未判定') report.未判定.push({ name: c.name, cause: c.verdict.cause });
    else if (col === '通過') report.通過.push(c.name);
    else if (col === '失敗') report.失敗.push(c.name);
    else report.未驗證.push(c.name);
  }
  return report;
}
