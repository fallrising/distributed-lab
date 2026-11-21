// Scenario drivers: turn data/scenarios.yaml cases into experiments (ADR-0001 D7 "情境驅動").
// Timers are the fixed ADR D5 values; all scenario numbers come from the data.
import type { Strategy } from '../chooser.ts';
import { canonicalJson } from '../canonical.ts';
import { branchExperiment, newExperiment, type Experiment, type ExperimentConfig, type Observation, type ScriptEvent } from '../sim/experiment.ts';
import type { NodeStatus, StableStorage } from '../sim/node.ts';
import type { Action } from '../types.ts';
import type { Scenarios, StepSpec } from './data.ts';

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
