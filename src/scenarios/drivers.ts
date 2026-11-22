// Scenario drivers: turn data/scenarios.yaml cases into experiments (ADR-0001 D7 "情境驅動").
// Timers are the fixed ADR D5 values; all scenario numbers come from the data.
import type { Strategy } from '../chooser.ts';
import { canonicalJson } from '../canonical.ts';
import { branchExperiment, newExperiment, type Experiment, type ExperimentConfig, type Observation, type ScriptEvent } from '../sim/experiment.ts';
import type { NodeStatus, StableStorage } from '../sim/node.ts';
import type { Action } from '../types.ts';
import type { RetryStep, Scenarios, StepSpec } from './data.ts';
import { SplitMix64 } from '../rng.ts';
import { MISSING_MAJORITY, type LivenessWindow } from './liveness.ts';
import { intentOf } from '../types.ts';

/** ADR-0001 D5: fixed, distinct election timeouts; heartbeat 1; gateway resend 4. ADR D7: attempt timeout 20. */
export const ELECTION_TIMEOUTS: Readonly<Record<string, number>> = { A: 4, C: 7, D: 14, E: 19, B: 25 };
export const HEARTBEAT_INTERVAL = 1;
export const GATEWAY_RESEND_INTERVAL = 4;
export const CLIENT_ATTEMPT_TIMEOUT = 20;

export function clusterConfig(data: Scenarios, overrides: Partial<ExperimentConfig> = {}): ExperimentConfig {
  return {
    members: data.cluster.members,
    clients: data.cluster.clients,
    electionTimeouts: ELECTION_TIMEOUTS,
    heartbeatInterval: HEARTBEAT_INTERVAL,
    gatewayResendInterval: GATEWAY_RESEND_INTERVAL,
    clientAttemptTimeout: CLIENT_ATTEMPT_TIMEOUT,
    deliveryBound: data.cluster.default_delivery_delay_ticks,
    deliveryMode: 'auto',
    initialValues: data.cluster.initial_values,
    retryIfUnavailable: false,
    aliases: [],
    ...overrides,
  };
}

function invokeEvent(step: StepSpec, tick: number, via: string): ScriptEvent {
  if (step.request === undefined || step.client === undefined || step.key === undefined) throw new Error(`step is not a client operation: ${JSON.stringify(step)}`);
  return {
    tick,
    type: 'invoke',
    client: step.client,
    requestId: step.request,
    action: step.action as Action,
    key: step.key,
    ...(step.value !== undefined ? { value: step.value } : {}),
    via,
  };
}

/** Sequential scenarios send each step via the first reachable live member (ADR D7). */
function firstReachable(exp: Experiment): string {
  const s = exp.nodeStatuses().find((n) => n.alive);
  if (s === undefined) throw new Error('no live member');
  return s.node;
}

const completed = (exp: Experiment, request: string) => exp.history().find((o) => o.requestId === request)?.outcome.status === '已完成';

// ---------------------------------------------------------------- baseline_case

export interface BaselineRun {
  readonly experiment: Experiment;
  readonly steps: readonly StepSpec[];
}

export function runBaseline(data: Scenarios, strategy: Strategy): BaselineRun {
  const c = data.baseline_case;
  const exp = newExperiment(clusterConfig(data, { deliveryBound: c.delivery_bound_ticks, initialValues: c.initial_values }), strategy);
  const bound = c.completion_bound_per_operation_ticks;
  let i = 0;
  exp.schedule(invokeEvent(c.steps[0] as StepSpec, 1, firstReachable(exp)));
  let invokedAt = 1;
  while (i < c.steps.length) {
    exp.advance(1);
    if (completed(exp, (c.steps[i] as StepSpec).request as string)) {
      i++;
      if (i < c.steps.length) {
        invokedAt = exp.now + 1;
        exp.schedule(invokeEvent(c.steps[i] as StepSpec, invokedAt, firstReachable(exp)));
      }
    } else if (exp.now - invokedAt > bound) break; // the test reports the miss
  }
  return { experiment: exp, steps: c.steps.slice(0, i + (i < c.steps.length ? 1 : 0)) };
}

// ---------------------------------------------------------------- partition_case

export interface PartitionRun {
  readonly experiment: Experiment;
}

export interface PartitionOptions {
  /** Last observed tick; default minority_stale_read_probe.observe_through_tick. The partition is never healed. */
  readonly until?: number;
  readonly retryIfUnavailable?: boolean;
  readonly onTick?: (exp: Experiment) => void;
}

export function runPartitionCase(data: Scenarios, strategy: Strategy, opts: PartitionOptions = {}): PartitionRun {
  const c = data.partition_case;
  const probe = c.minority_stale_read_probe;
  const until = opts.until ?? probe.observe_through_tick;
  const exp = newExperiment(
    clusterConfig(data, { deliveryBound: c.within_majority_delivery_bound_ticks, retryIfUnavailable: opts.retryIfUnavailable ?? false }),
    strategy,
  );
  exp.schedule({ tick: c.start_tick, type: 'partition', groups: c.groups, clientReachable: [...c.minority_client_reachable, ...c.majority_client_reachable] });
  for (const op of c.new_operations) exp.schedule(invokeEvent(op, op.invoke as number, op.via as string));
  const majorityRequest = (c.new_operations.find((o) => o.complete_by !== undefined) as StepSpec).request as string;
  let probeScheduled = false;
  while (exp.now < until) {
    exp.advance(1);
    opts.onTick?.(exp);
    // invoke_after: majority-new 已確認 -> the probe is sent the next tick; the tick is written into the script.
    if (!probeScheduled && completed(exp, majorityRequest) && exp.now + 1 <= until) {
      exp.schedule(invokeEvent(probe.operation, exp.now + 1, probe.operation.via as string));
      probeScheduled = true;
    }
  }
  return { experiment: exp };
}

// ---------------------------------------------------------------- durability_case

export interface DurabilityRun {
  readonly experiment: Experiment;
  readonly restartTick: number;
  readonly stableBeforeCrash: Record<string, StableStorage>;
  readonly stableAfterCrash: Record<string, StableStorage>;
  readonly stableAfterRestart: Record<string, StableStorage>;
  readonly downStatuses: NodeStatus[];
  readonly restartStatuses: NodeStatus[];
}

export function runDurability(data: Scenarios, strategy: Strategy): DurabilityRun {
  const steps = data.durability_case.steps;
  const window = steps.find((s) => s.action === 'establish_stable_window') as StepSpec;
  const bound = window.duration_ticks as number;
  const exp = newExperiment(clusterConfig(data, { deliveryBound: window.delivery_bound_ticks as number }), strategy);
  const stableAll = () => Object.fromEntries(data.cluster.members.map((m) => [m, exp.nodeStable(m)]));
  let stableBeforeCrash: Record<string, StableStorage> = {};
  let stableAfterCrash: Record<string, StableStorage> = {};
  let stableAfterRestart: Record<string, StableStorage> = {};
  let downStatuses: NodeStatus[] = [];
  let restartStatuses: NodeStatus[] = [];
  let restartTick = -1;
  for (const step of steps) {
    const tick = exp.now + 1;
    if (step.action === 'crash') {
      stableBeforeCrash = stableAll();
      for (const n of step.nodes ?? []) exp.schedule({ tick, type: 'crash', node: n });
      exp.advance(1);
      stableAfterCrash = stableAll();
      downStatuses = exp.nodeStatuses();
    } else if (step.action === 'restart') {
      for (const n of step.nodes ?? []) exp.schedule({ tick, type: 'restart', node: n });
      exp.advance(1);
      restartTick = exp.now;
      stableAfterRestart = stableAll();
      restartStatuses = exp.nodeStatuses();
    } else if (step.action === 'establish_stable_window') {
      // The cluster is fully connected with bounded delivery from here on; nothing to inject.
    } else {
      // Each stage with a result completes before the next one starts (sequence_rule).
      exp.schedule(invokeEvent(step, tick, firstReachable(exp)));
      const deadline = tick + bound + 1;
      while (!completed(exp, step.request as string) && exp.now < deadline) exp.advance(1);
      if (!completed(exp, step.request as string)) break; // the test reports the miss
    }
  }
  return { experiment: exp, restartTick, stableBeforeCrash, stableAfterCrash, stableAfterRestart, downStatuses, restartStatuses };
}

// ---------------------------------------------------------------- counterfactual_case

export interface CounterfactualRun {
  readonly base: Experiment;
  readonly branch: Experiment;
  readonly branchTick: number;
  readonly baseAtBranchTick: Observation;
  readonly branchAtBranchTick: Observation;
  readonly baseFingerprintBeforeBranch: string;
}

export function runCounterfactual(data: Scenarios, strategy: Strategy, branchStrategy: Strategy): CounterfactualRun {
  const c = data.counterfactual_case;
  if (c.basis !== 'partition_case') throw new Error(`unsupported basis ${c.basis}`);
  let baseAtBranchTick: Observation | null = null;
  // The retry policy is part of the shared configuration, so base and branch differ only in the heal event.
  const base = runPartitionCase(data, strategy, {
    until: c.original.partition_remains_through,
    retryIfUnavailable: c.branch.retry_same_request_if_unavailable,
    onTick: (exp) => {
      if (exp.now === c.branch_tick) baseAtBranchTick = exp.observation();
    },
  }).experiment;
  const baseFingerprintBeforeBranch = canonicalJson({ r: base.recording(), o: base.observation() });
  const ev = c.branch.changed_event;
  if (ev.action !== 'heal') throw new Error(`unsupported changed event ${ev.action}`);
  const branch = branchExperiment(base, c.branch_tick, { add: [{ tick: ev.tick, type: 'heal', clientReachable: c.branch.client_reachable_after_heal }] }, branchStrategy);
  const branchAtBranchTick = branch.observation();
  branch.advanceTo(c.branch.complete_by_tick);
  if (baseAtBranchTick === null) throw new Error('base did not pass the branch tick');
  return { base, branch, branchTick: c.branch_tick, baseAtBranchTick, branchAtBranchTick, baseFingerprintBeforeBranch };
}

// ---------------------------------------------------------------- fault_trace

export interface FaultTraceOptions {
  /** Schedule trace events up to this tick (default: all). */
  readonly eventsThroughTick?: number;
  readonly deliveryMode?: 'auto' | 'manual';
}

/** fault_trace: manual delivery; m-one etc. are bound once at the start per message_binding. */
export function faultTraceExperiment(data: Scenarios, opts: FaultTraceOptions = {}): Experiment {
  const t = data.fault_trace;
  const exp = newExperiment(
    clusterConfig(data, {
      deliveryMode: opts.deliveryMode ?? 'manual',
      aliases: t.initial_pending_messages.map((m) => ({ alias: m.id, from: m.from, to: m.to, label: m.content_label })),
    }),
    { type: 'min' },
  );
  const through = opts.eventsThroughTick ?? Number.POSITIVE_INFINITY;
  for (const e of t.events) {
    if (e.tick > through) continue;
    switch (e.action) {
      case 'delay':
        exp.schedule({ tick: e.tick, type: 'delay', message: e.target as string, at: e.deliver_at as number });
        break;
      case 'duplicate':
        for (let i = 0; i < (e.copies_added ?? 1); i++) {
          exp.schedule({ tick: e.tick, type: 'duplicate', message: e.target as string, ...(e.copy_id !== undefined && i === 0 ? { copyAlias: e.copy_id } : {}) });
        }
        break;
      case 'deliver':
        exp.schedule({ tick: e.tick, type: 'deliver', message: e.target as string });
        break;
      case 'drop':
        exp.schedule({ tick: e.tick, type: 'drop', message: e.target as string });
        break;
      case 'partition':
        exp.schedule({ tick: e.tick, type: 'partition', groups: e.groups as string[][] });
        break;
      case 'crash':
        exp.schedule({ tick: e.tick, type: 'crash', node: e.target as string });
        break;
      case 'restart':
        exp.schedule({ tick: e.tick, type: 'restart', node: e.target as string });
        break;
      case 'heal':
        exp.schedule({ tick: e.tick, type: 'heal' });
        break;
      default:
        throw new Error(`unknown fault_trace action ${e.action}`);
    }
  }
  return exp;
}

// ---------------------------------------------------------------- retry_cases (ADR-0002 E1, E2)

/** retry_cases do not state a delivery bound; they use the baseline's stable bound. */
function retryConfig(data: Scenarios, overrides: Partial<ExperimentConfig> = {}): ExperimentConfig {
  return clusterConfig(data, { deliveryBound: data.baseline_case.delivery_bound_ticks, ...overrides });
}

function stepEvent(step: RetryStep, tick: number, via: string): ScriptEvent {
  return {
    tick,
    type: 'invoke',
    client: step.client,
    requestId: step.request,
    action: step.action as Action,
    key: step.key,
    ...(step.value !== undefined ? { value: step.value } : {}),
    via,
  };
}

/** Whether the latest send of `step` has its answer: a new op completed, a retry got a reply, a conflict got a result. */
function answered(exp: Experiment, step: RetryStep): boolean {
  const op = exp.history().find((o) => o.client === step.client && o.requestId === step.request);
  if (op === undefined) return false;
  const intent = intentOf({ clientId: step.client, requestId: step.request, action: step.action as Action, key: step.key, ...(step.value !== undefined ? { value: step.value } : {}) });
  if (intent !== op.intent) return op.conflicts.filter((c) => c.intent === intent).every((c) => c.result !== undefined);
  return op.attempts.at(-1)?.result === 'reply';
}

/** Runs steps one after another: each is sent the tick after the previous one was answered (sequential cases). */
function runSequential(exp: Experiment, steps: readonly RetryStep[], bound: number): void {
  for (const step of steps) {
    const tick = exp.now + 1;
    exp.schedule(stepEvent(step, tick, firstReachable(exp)));
    exp.advance(1);
    while (!answered(exp, step) && exp.now - tick <= bound) exp.advance(1);
    if (!answered(exp, step)) return; // the test reports the miss
  }
}

/** Advance until every live member has applied the same prefix, then report those members. */
function settle(exp: Experiment, ticks = 10): string[] {
  exp.advance(ticks);
  const alive = exp.nodeStatuses().filter((n) => n.alive);
  const top = Math.max(...alive.map((n) => n.lastApplied));
  return alive.filter((n) => n.lastApplied === top).map((n) => n.node);
}

export interface RetryRun {
  readonly experiment: Experiment;
  /** Members whose state machines applied the whole committed log when the run ended. */
  readonly settledMembers: string[];
}

const RETRY_STEP_BOUND = 40;

export function runRetryCase(data: Scenarios, name: 'completed_write' | 'completed_read', strategy: Strategy): RetryRun {
  const exp = newExperiment(retryConfig(data), strategy);
  runSequential(exp, data.retry_cases[name].steps, RETRY_STEP_BOUND);
  return { experiment: exp, settledMembers: settle(exp) };
}

export function runConflictingIntent(data: Scenarios, strategy: Strategy): RetryRun {
  const c = data.retry_cases.conflicting_intent;
  const exp = newExperiment(retryConfig(data), strategy);
  runSequential(exp, [c.original, ...c.conflicting_attempts], RETRY_STEP_BOUND);
  return { experiment: exp, settledMembers: settle(exp) };
}

/**
 * pending_retry: every success reply of the original attempt is dropped before delivery (ADR-0002 E2): at the
 * end of each tick, pending replies of the request are dropped at the next tick's step 1, which precedes
 * delivery. Dropping stops once the client resends the same request after its attempt timed out.
 */
export function runPendingRetry(data: Scenarios, strategy: Strategy): RetryRun {
  const c = data.retry_cases.pending_retry;
  const exp = newExperiment(retryConfig(data, { retryIfUnavailable: true }), strategy);
  exp.schedule(stepEvent(c.original, 1, firstReachable(exp)));
  const intent = intentOf({ clientId: c.original.client, requestId: c.original.request, action: c.original.action as Action, key: c.original.key, ...(c.original.value !== undefined ? { value: c.original.value } : {}) });
  const dropped = new Set<string>();
  const op = () => exp.history().find((o) => o.requestId === c.original.request);
  const deadline = 1 + CLIENT_ATTEMPT_TIMEOUT + RETRY_STEP_BOUND;
  while (exp.now < deadline && op()?.outcome.status !== '已完成') {
    exp.advance(1);
    // The fault covers replies sent before the retry tick; replies sent at or after it are delivered.
    const retryAt = op()?.attempts[1]?.sentAt ?? Number.POSITIVE_INFINITY;
    for (const m of exp.pending()) {
      const p = m.payload;
      if (p.type === 'ClientReply' && m.sentAt < retryAt && m.to === c.original.client && p.requestId === c.original.request && p.intent === intent && !dropped.has(m.id)) {
        exp.schedule({ tick: exp.now + 1, type: 'drop', message: m.id });
        dropped.add(m.id);
      }
    }
  }
  return { experiment: exp, settledMembers: settle(exp) };
}

// ---------------------------------------------------------------- liveness_case, no_liveness_case (ADR-0002 E3)

export const LIVENESS_TARGETED_PREFIXES = [
  'minority-leader-write',
  'leader-d-at-window',
  'split-then-regroup',
  // ADR-0002 review counterexamples: A (shortest timeout) holds an uncommitted entry of an older term.
  'stale-a-older-term',
  'stale-a-five-events',
] as const;
export type LivenessPrefix = 'random' | (typeof LIVENESS_TARGETED_PREFIXES)[number];

export interface LivenessOptions {
  readonly prefix: LivenessPrefix;
  /** Seed of the random prefix (only for prefix 'random'). */
  readonly prefixSeed?: number;
  /** Delivery bound for messages sent during the fault prefix; the window always uses the data's bound. */
  readonly prefixBound?: number;
  readonly strategy: Strategy;
  /** Gateway of the fresh read; the data leaves it open (default: the first client-reachable member). */
  readonly readVia?: string;
}

function prefixEvents(members: readonly string[], opts: LivenessOptions, through: number): ScriptEvent[] {
  const all = [...members];
  const cut = (tick: number, a: string[]): ScriptEvent => ({ tick, type: 'partition', groups: [a, all.filter((m) => !a.includes(m))], clientReachable: all });
  const part = (tick: number, groups: string[][]): ScriptEvent => ({ tick, type: 'partition', groups, clientReachable: all });
  const heal = (tick: number): ScriptEvent => ({ tick, type: 'heal', clientReachable: all });
  switch (opts.prefix) {
    case 'minority-leader-write':
      // A leads before the cut; the write reaches only A's minority side; C's side elects a newer leader.
      return [cut(9, ['A', 'B'])];
    case 'leader-d-at-window':
      // Only B, D, E can elect: D (timeout 14) leads when the window starts and then crashes with E.
      return [cut(1, ['A', 'C'])];
    case 'split-then-regroup':
      return [cut(1, ['A']), cut(12, ['A', 'C'])];
    case 'stale-a-older-term':
      return [part(9, [['C', 'D'], ['A', 'E'], ['B']]), heal(12), cut(19, ['A', 'B'])];
    case 'stale-a-five-events':
      return [cut(1, ['A', 'B', 'C', 'E']), heal(6), part(9, [['C', 'D'], ['A', 'E'], ['B']]), heal(12), cut(19, ['A', 'B'])];
    case 'random': {
      const rng = new SplitMix64((opts.prefixSeed ?? 0) * 7919 + 1);
      const count = 2 + rng.nextInt(3);
      const ticks = new Set<number>();
      while (ticks.size < count) ticks.add(1 + rng.nextInt(through));
      return [...ticks]
        .sort((a, b) => a - b)
        .map((tick) => {
          if (rng.nextInt(3) === 0) return { tick, type: 'heal', clientReachable: all } as ScriptEvent;
          const mask = 1 + rng.nextInt((1 << all.length) - 2);
          return cut(tick, all.filter((_, i) => (mask & (1 << i)) !== 0));
        });
    }
  }
}

export function runLiveness(data: Scenarios, opts: LivenessOptions): { readonly experiment: Experiment } {
  const c = data.liveness_case;
  const w = c.stable_window;
  const exp = newExperiment(
    clusterConfig(data, {
      deliveryBound: w.delivery_bound_ticks,
      deliveryBounds: [
        { fromTick: c.fault_prefix.start_tick, bound: opts.prefixBound ?? w.delivery_bound_ticks },
        { fromTick: w.starts_at_tick, bound: w.delivery_bound_ticks },
      ],
      retryIfUnavailable: c.retry_original_if_unavailable,
    }),
    opts.strategy,
  );
  for (const ev of prefixEvents(data.cluster.members, opts, c.fault_prefix.through_tick)) exp.schedule(ev);
  exp.schedule(stepEvent(c.fault_prefix.pending_write, c.fault_prefix.pending_write.invoke, w.client_reachable_members[0] as string));
  exp.schedule({ tick: w.starts_at_tick, type: 'heal', clientReachable: w.client_reachable_members });
  for (const n of w.other_members) exp.schedule({ tick: w.starts_at_tick, type: 'crash', node: n });
  exp.schedule(stepEvent(w.fresh_read, w.fresh_read.invoke, opts.readVia ?? (w.client_reachable_members[0] as string)));
  exp.advanceTo(w.ends_at_tick);
  return { experiment: exp };
}

export function livenessWindow(data: Scenarios): LivenessWindow {
  const c = data.liveness_case;
  const w = c.stable_window;
  return {
    from: w.starts_at_tick,
    to: w.ends_at_tick,
    alive: w.alive_members,
    clientReachable: w.client_reachable_members,
    deliveryBound: w.delivery_bound_ticks,
    deadlines: [
      { client: c.fault_prefix.pending_write.client, request: c.fault_prefix.pending_write.request, by: w.pending_write_complete_by_tick },
      { client: w.fresh_read.client, request: w.fresh_read.request, by: w.fresh_read.complete_by },
    ],
  };
}

/** no_liveness_case: C, D, E crash at tick 1, clients reach only A; the write is sent via A at tick 2. */
export function runNoLiveness(data: Scenarios, strategy: Strategy): { readonly experiment: Experiment } {
  const c = data.no_liveness_case;
  const exp = newExperiment(clusterConfig(data), strategy);
  for (const n of c.crashed_members) exp.schedule({ tick: 1, type: 'crash', node: n });
  exp.schedule({ tick: 1, type: 'client-reach', members: c.client_reachable_members });
  exp.schedule(stepEvent(c.new_write, 2, c.client_reachable_members[0] as string));
  exp.advanceTo(c.observation_end_tick);
  return { experiment: exp };
}

export function noLivenessWindow(data: Scenarios): LivenessWindow {
  const c = data.no_liveness_case;
  return {
    from: 1,
    to: c.observation_end_tick,
    alive: c.alive_members,
    clientReachable: c.client_reachable_members,
    deliveryBound: data.cluster.default_delivery_delay_ticks,
    deadlines: [{ client: c.new_write.client, request: c.new_write.request, by: c.observation_end_tick }],
  };
}

export { MISSING_MAJORITY };

// ---------------------------------------------------------------- snapshot_case (ADR-0003)

export interface SnapshotStageState {
  readonly stable: Record<string, StableStorage>;
  readonly statuses: NodeStatus[];
  readonly values: Record<string, Record<string, string | undefined>>;
}

export interface SnapshotRun {
  readonly experiment: Experiment;
  readonly stages: { id: string; start: number; end: number; ok: boolean }[];
  readonly stageStates: Record<string, SnapshotStageState>;
  readonly retryTick: number;
}

/** Sequential stages keep their original deadline, including waiting for followers before snapshotting. */
export function runSnapshotCase(data: Scenarios, strategy: Strategy, opts: { compaction?: boolean; retryVia?: string } = {}): SnapshotRun {
  const c = data.snapshot_case;
  const exp = newExperiment(clusterConfig(data, { deliveryBound: c.stable_delivery_bound_ticks }), strategy);
  const stages: SnapshotRun['stages'] = [];
  const stageStates: Record<string, SnapshotStageState> = {};
  const keys = [...new Set(c.stages.flatMap((s) => s.key === undefined ? Object.keys(s.expected_values ?? {}) : [s.key]))].sort();
  const capture = (): SnapshotStageState => ({
    stable: Object.fromEntries(data.cluster.members.map((m) => [m, exp.nodeStable(m)])),
    statuses: JSON.parse(JSON.stringify(exp.nodeStatuses())) as NodeStatus[],
    values: Object.fromEntries(data.cluster.members.map((m) => [m, Object.fromEntries(keys.map((k) => [k, exp.nodeValue(m, k)]))])),
  });
  const bound = c.completion_bound_per_stage_ticks;
  const finish = (id: string, start: number, ok: boolean) => {
    stages.push({ id, start, end: exp.now, ok });
    stageStates[id] = capture();
    return ok;
  };
  const wait = (deadline: number, predicate: () => boolean) => {
    while (!predicate() && exp.now < deadline) exp.advance(1);
    return predicate();
  };
  const resultOf = (client: string, request: string) => {
    const op = exp.history().find((o) => o.client === client && o.requestId === request);
    return op?.outcome.status === '已完成' ? op.outcome.result : undefined;
  };
  const controls = (start: number, events: ScriptEvent[]) => {
    for (const event of events) exp.schedule(event);
    exp.advanceTo(start);
    return events.every((event) => !exp.log().some((entry) => entry.tick === start && entry.kind === 'effect' && entry.action === event.type && entry.target === ('node' in event ? event.node : '') && entry.outcome?.startsWith('拒絕：')));
  };
  if (data.snapshot_equivalence.basis !== 'snapshot_case') throw new Error('unsupported snapshot equivalence basis');
  const without = data.snapshot_equivalence.variants.find((v) => v.id === 'without_compaction');
  if (without?.omit_stages === undefined) throw new Error('missing without_compaction stages');
  const omitted = opts.compaction === false ? without.omit_stages : [];
  let retryTick = -1;
  for (const stage of c.stages) {
    if (omitted.includes(stage.id)) continue;
    const start = exp.now + 1;
    const deadline = start + bound;
    let ok: boolean;
    switch (stage.action) {
      case 'partition': {
        if (stage.isolated_member === undefined || stage.others === undefined) throw new Error('invalid isolation stage');
        exp.schedule({ tick: start, type: 'partition', groups: [[...stage.others], [stage.isolated_member]] });
        exp.advanceTo(start);
        ok = true;
        break;
      }
      case 'write':
      case 'read': {
        exp.schedule(invokeEvent(stage, start, stage.via ?? firstReachable(exp)));
        exp.advanceTo(start);
        ok = wait(deadline, () => {
          if (resultOf(stage.client as string, stage.request as string) !== (stage.expected ?? stage.require_result)) return false;
          if (stage.via !== c.lagging_member || stage.action !== 'read') return true;
          // A leader reply may arrive before E applies the read. Both facts must hold by this deadline.
          return exp.nodeAppliedRequests(c.lagging_member).includes(`${stage.client}/${stage.request}`) && exp.nodeValue(c.lagging_member, stage.key as string) === stage.expected;
        });
        break;
      }
      case 'take_snapshot': {
        const ready = () => (stage.members ?? []).every((m) =>
          (stage.covers_confirmed_requests ?? []).every((request) => {
            const op = c.stages.find((s) => s.request === request);
            return op !== undefined && exp.nodeAppliedRequests(m).includes(`${op.client}/${request}`);
          }) && Object.entries(stage.expected_values ?? {}).every(([k, v]) => exp.nodeValue(m, k) === v),
        );
        // Leave one tick within this same stage for the actual recorded snapshot operation.
        while (!ready() && exp.now < deadline - 1) exp.advance(1);
        if (!ready() || exp.now + 1 > deadline) {
          exp.advanceTo(deadline);
          ok = false;
        } else {
          const at = Math.max(start, exp.now + 1);
          ok = controls(at, (stage.members ?? []).map((node) => ({ tick: at, type: 'take-snapshot', node })));
          ok = ok && (stage.members ?? []).every((m) => exp.nodeStable(m).snapshot !== null);
        }
        break;
      }
      case 'compact_covered_log': {
        ok = controls(start, (stage.members ?? []).map((node) => ({ tick: start, type: 'compact', node })));
        ok = ok && (stage.members ?? []).every((m) => {
          const stable = exp.nodeStable(m);
          return stable.snapshot !== null && stable.logStartIndex === stable.snapshot.lastIncludedIndex + 1 && !stable.log.some((entry) => (stage.covered_requests ?? []).includes(entry.command.requestId));
        });
        break;
      }
      case 'crash':
      case 'restart': {
        if (stage.target === undefined) throw new Error(`missing ${stage.action} target`);
        exp.schedule({ tick: start, type: stage.action, node: stage.target });
        exp.advanceTo(start);
        ok = exp.nodeStatus(stage.target).alive === (stage.action === 'restart');
        break;
      }
      case 'heal': {
        exp.schedule({ tick: start, type: 'heal' });
        exp.advanceTo(start);
        ok = true; // no hidden wait for E: the next stage starts next tick, while catch-up is in flight
        break;
      }
      default:
        throw new Error(`unknown snapshot stage action ${stage.action}`);
    }
    if (!finish(stage.id, start, ok)) return { experiment: exp, stages, stageStates, retryTick };
  }
  const original = c.retry_after_recovery.original_request;
  const originalResult = resultOf(original.client, original.request);
  if (originalResult === undefined) return { experiment: exp, stages, stageStates, retryTick };
  retryTick = exp.now + 1;
  const priorAttempts = exp.history().find((o) => o.client === original.client && o.requestId === original.request)!.attempts.length;
  const restarted = c.stages.find((s) => s.action === 'restart')?.target;
  if (restarted === undefined) throw new Error('missing restarted member for retry');
  exp.schedule(stepEvent(original, retryTick, opts.retryVia ?? restarted));
  exp.advanceTo(retryTick);
  const retried = wait(retryTick + bound, () => {
    const op = exp.history().find((o) => o.client === original.client && o.requestId === original.request);
    const attempt = op?.attempts[priorAttempts];
    return attempt?.sentAt === retryTick && attempt.result === 'reply' && attempt.reply === originalResult;
  });
  if (!finish('retry-original', retryTick, retried)) return { experiment: exp, stages, stageStates, retryTick };
  const fresh = c.retry_after_recovery.new_read;
  const start = exp.now + 1;
  exp.schedule(stepEvent(fresh, start, c.lagging_member));
  exp.advanceTo(start);
  const freshDone = wait(start + bound, () => resultOf(fresh.client, fresh.request) === fresh.expected && exp.nodeAppliedRequests(c.lagging_member).includes(`${fresh.client}/${fresh.request}`));
  finish('new-read-after-retry', start, freshDone);
  return { experiment: exp, stages, stageStates, retryTick };
}
