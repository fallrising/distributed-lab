// Finite, deterministic input search for T-0458. This file never changes simulator state.
import { SplitMix64 } from '../src/rng.ts';
import { canonicalJson } from '../src/canonical.ts';

export type Target = 'H1' | 'H2';
export type PrefixEvent = { readonly tick: number; readonly type: 'heal' } | { readonly tick: number; readonly type: 'partition'; readonly groups: readonly (readonly string[])[] };
export interface Candidate {
  readonly id: string;
  readonly prefixBound: number;
  readonly prefix: readonly PrefixEvent[];
  readonly strategySeed: number;
  readonly readVia: string;
}
export interface AuditPlan {
  readonly auditSeed: number;
  readonly initialPerBound: number;
  readonly mutationsPerCell: number;
  readonly maxReplays: number;
  readonly beamWidth: number;
  readonly maxSimulations: number;
}
export const FORMAL_PLAN: AuditPlan = Object.freeze({ auditSeed: 45801, initialPerBound: 512, mutationsPerCell: 767, maxReplays: 4, beamWidth: 4, maxSimulations: 4096 });

export function validatePlan(plan: AuditPlan): void {
  for (const [key, value] of Object.entries(plan)) if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid audit plan ${key}`);
  if (plan.beamWidth < 1 || plan.initialPerBound < 1) throw new Error('audit requires a nonempty initial population and beam');
  if (2 * plan.initialPerBound + 4 * plan.mutationsPerCell + plan.maxReplays > plan.maxSimulations) throw new Error('planned complete simulations exceed the budget');
  if (plan.maxSimulations > FORMAL_PLAN.maxSimulations || plan.maxReplays > 4) throw new Error('audit cannot expand the approved budget');
}

export class SimulationBudget {
  readonly plan: AuditPlan;
  search = 0;
  replays = 0;
  constructor(plan: AuditPlan) { validatePlan(plan); this.plan = plan; }
  get total(): number { return this.search + this.replays; }
  consume(kind: 'search' | 'replay'): void {
    if (this.total >= this.plan.maxSimulations) throw new Error('complete simulation budget exhausted');
    if (kind === 'search') {
      if (this.search >= this.plan.maxSimulations - this.plan.maxReplays) throw new Error('replay reservation cannot be spent on search');
      this.search++;
    } else {
      if (this.replays >= this.plan.maxReplays) throw new Error('replay budget exhausted');
      this.replays++;
    }
  }
}

/** Canonical restricted-growth enumeration; five members have Bell(5) = 52 set partitions. */
export function setPartitions(members: readonly string[]): string[][][] {
  if (new Set(members).size !== members.length) throw new Error('members must be distinct');
  const result: string[][][] = [];
  const groups: string[][] = [];
  function visit(index: number): void {
    if (index === members.length) { result.push(groups.map((g) => [...g])); return; }
    const member = members[index]!;
    for (const group of groups) { group.push(member); visit(index + 1); group.pop(); }
    groups.push([member]); visit(index + 1); groups.pop();
  }
  visit(0);
  return result;
}

export function candidateSignature(candidate: Pick<Candidate, 'prefixBound' | 'prefix' | 'strategySeed' | 'readVia'>): string {
  return canonicalJson({ bound: candidate.prefixBound, prefix: candidate.prefix, strategySeed: candidate.strategySeed, readVia: candidate.readVia });
}

export function validatePrefix(prefix: readonly PrefixEvent[], members: readonly string[], through: number): void {
  if (prefix.length < 2 || prefix.length > 8) throw new Error('prefix requires 2–8 events');
  const ticks = prefix.map((event) => event.tick);
  if (ticks.some((tick, i) => !Number.isInteger(tick) || tick < 1 || tick > through || (i > 0 && tick <= ticks[i - 1]!))) throw new Error('prefix ticks must be distinct, sorted, and in the original prefix');
  const expected = [...members].sort().join(',');
  for (const event of prefix) if (event.type === 'partition') {
    const flat = event.groups.flat();
    if (event.groups.some((group) => group.length === 0) || new Set(flat).size !== flat.length || [...flat].sort().join(',') !== expected) throw new Error('partition must contain every member exactly once');
  }
}

function shuffledTicks(through: number, rng: SplitMix64): number[] {
  const ticks = Array.from({ length: through }, (_, i) => i + 1);
  for (let i = ticks.length - 1; i > 0; i--) { const j = rng.nextInt(i + 1); [ticks[i], ticks[j]] = [ticks[j]!, ticks[i]!]; }
  return ticks;
}

export function initialPrefix(members: readonly string[], through: number, auditSeed: number, bound: number, ordinal: number): PrefixEvent[] {
  const rng = new SplitMix64(auditSeed * 1_000_003 + bound * 65_537 + ordinal);
  const partitions = setPartitions(members);
  const count = 4 + rng.nextInt(5);
  const ticks = shuffledTicks(through, rng).slice(0, count).sort((a, b) => a - b);
  // Force the earliest partition to cycle all 52 possibilities in each bound's initial population.
  return ticks.map((tick, index) => index === 0 || rng.nextInt(4) !== 0
    ? { tick, type: 'partition', groups: partitions[index === 0 ? ordinal % partitions.length : rng.nextInt(partitions.length)]! }
    : { tick, type: 'heal' });
}

/** Change exactly one event's tick/network state, insert one, or delete one. */
export function mutatePrefix(prefix: readonly PrefixEvent[], members: readonly string[], through: number, rng: SplitMix64): PrefixEvent[] {
  const out: PrefixEvent[] = prefix.map((event) => event.type === 'heal' ? { ...event } : { ...event, groups: event.groups.map((g) => [...g]) });
  const partitions = setPartitions(members);
  const index = rng.nextInt(out.length);
  const action = rng.nextInt(4);
  const free = Array.from({ length: through }, (_, i) => i + 1).filter((tick) => !out.some((event) => event.tick === tick));
  if (action === 2 && out.length < 8) {
    const tick = free[rng.nextInt(free.length)]!;
    out.push(rng.nextInt(4) === 0 ? { tick, type: 'heal' } : { tick, type: 'partition', groups: partitions[rng.nextInt(partitions.length)]! });
  } else if (action === 3 && out.length > 2) out.splice(index, 1);
  else if (action === 1) {
    const event = out[index]!;
    const alternatives: PrefixEvent[] = [{ tick: event.tick, type: 'heal' }, ...partitions.map((groups) => ({ tick: event.tick, type: 'partition' as const, groups }))];
    const different = alternatives.filter((choice) => canonicalJson(choice) !== canonicalJson(event));
    out[index] = different[rng.nextInt(different.length)]!;
  } else out[index] = { ...out[index]!, tick: free[rng.nextInt(free.length)]! };
  out.sort((a, b) => a.tick - b.tick);
  validatePrefix(out, members, through);
  return out;
}

export interface Freshness { readonly term: number; readonly index: number }
export function compareFreshness(a: Freshness, b: Freshness): number { return a.term - b.term || a.index - b.index; }
export interface StateEvidence {
  readonly tick: number;
  readonly freshness: Readonly<Record<string, Freshness>>;
  readonly bContainsPendingWrite: boolean;
  readonly pendingWriteUncompleted: boolean;
}
export function h1Configuration(state: StateEvidence): boolean {
  const f = state.freshness;
  return compareFreshness(f.B!, f.A!) > 0 && compareFreshness(f.B!, f.C!) > 0 && state.bContainsPendingWrite;
}
export function h2Configuration(state: StateEvidence): boolean {
  const f = state.freshness;
  return compareFreshness(f.C!, f.A!) > 0 && compareFreshness(f.C!, f.B!) > 0 && ['D', 'E'].some((member) => compareFreshness(f[member]!, f.C!) > 0);
}
export function h2NonStrictConfiguration(state: StateEvidence): boolean {
  const f = state.freshness;
  return compareFreshness(f.C!, f.A!) >= 0 && compareFreshness(f.C!, f.B!) >= 0 && ['D', 'E'].some((member) => compareFreshness(f[member]!, f.C!) > 0);
}

export interface BackoffInput {
  readonly beforeRole: string;
  readonly beforeTerm: number;
  readonly afterRole: string;
  readonly afterTerm: number;
  readonly replyTerm: number;
  readonly voteGranted: boolean;
  readonly logOk: boolean;
  readonly voter: string;
  readonly candidateFreshness: Freshness;
  readonly requestedFreshness: Freshness | null;
}
/** A higher-term stepdown, obsolete refusal, or missing causal request is never an exact backoff hit. */
export function exactStaleBackoff(input: BackoffInput): boolean {
  return ['D', 'E'].includes(input.voter) && input.beforeRole === 'candidate' && input.beforeTerm === input.replyTerm
    && input.afterRole === 'follower' && input.afterTerm === input.replyTerm && !input.voteGranted && !input.logOk
    && input.requestedFreshness !== null && compareFreshness(input.candidateFreshness, input.requestedFreshness) === 0;
}

export interface RankEvidence {
  readonly h1Hit: boolean;
  readonly h2Hit: boolean;
  readonly h2Configuration: boolean;
  readonly exactBackoffs: number;
  readonly refusals: number;
  readonly at19: StateEvidence;
}
/** Lexicographic rank, with every component emitted in the report. Higher is preferred; signatures break ties. */
export function rankEvidence(evidence: RankEvidence, target: Target): number[] {
  const f = evidence.at19.freshness;
  if (target === 'H1') return [Number(evidence.h1Hit), Number(compareFreshness(f.B!, f.A!) > 0) + Number(compareFreshness(f.B!, f.C!) > 0), Number(evidence.at19.bContainsPendingWrite), Number(evidence.at19.pendingWriteUncompleted), f.B!.term, f.B!.index];
  return [Number(evidence.h2Hit), Number(evidence.h2Configuration), evidence.exactBackoffs, Number(compareFreshness(f.C!, f.A!) > 0) + Number(compareFreshness(f.C!, f.B!) > 0), Number(compareFreshness(f.D!, f.C!) > 0) + Number(compareFreshness(f.E!, f.C!) > 0), evidence.refusals, f.C!.term, f.C!.index];
}
export function compareRanks(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const difference = (a[i] ?? 0) - (b[i] ?? 0); if (difference !== 0) return difference; }
  return 0;
}
