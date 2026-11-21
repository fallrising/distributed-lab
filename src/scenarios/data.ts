// Typed view of data/scenarios.yaml. Values are only read, never rewritten (ADR D12).
import { parse } from 'yaml';

export interface StepSpec {
  readonly request?: string;
  readonly client?: string;
  readonly action: string;
  readonly key?: string;
  readonly value?: string;
  readonly expected?: string;
  readonly require_result?: string;
  readonly stage?: string;
  readonly nodes?: string[];
  readonly duration_ticks?: number;
  readonly delivery_bound_ticks?: number;
  readonly invoke?: number;
  readonly via?: string;
  readonly complete_by?: number;
}

export interface SmallOp {
  readonly request: string;
  readonly client: string;
  readonly action: 'read' | 'write';
  readonly key: string;
  readonly value?: string;
  readonly invoke: number;
  readonly complete: number | null;
  readonly result: string;
}

export interface SmallHistory {
  readonly initial_values: Record<string, string>;
  readonly operations: readonly SmallOp[];
  readonly expected: '合法' | '非法';
  readonly legal_order_witness?: string[];
  readonly legal_completion_witness?: string;
  readonly reason?: string;
}

export interface TraceEvent {
  readonly tick: number;
  readonly action: string;
  readonly target?: string;
  readonly deliver_at?: number;
  readonly copies_added?: number;
  readonly copy_id?: string;
  readonly groups?: string[][];
  readonly expected?: string;
}

export interface Scenarios {
  readonly cluster: {
    readonly members: string[];
    readonly node_count: number;
    readonly majority_count: number;
    readonly initial_values: Record<string, string>;
    readonly absent_result: string;
    readonly clients: string[];
    readonly default_delivery_delay_ticks: number;
    readonly successful_write_result: string;
    readonly unavailable_result: string;
  };
  readonly baseline_case: {
    readonly alive_members: string[];
    readonly initial_values: Record<string, string>;
    readonly delivery_bound_ticks: number;
    readonly completion_bound_per_operation_ticks: number;
    readonly steps: readonly StepSpec[];
  };
  readonly small_histories: {
    readonly legal_sequential: SmallHistory;
    readonly legal_overlap: SmallHistory;
    readonly legal_pending_write: SmallHistory;
    readonly illegal_stale_read: SmallHistory;
    readonly illegal_reverted_value: SmallHistory;
  };
  readonly partition_case: {
    readonly start_tick: number;
    readonly end_observation_tick: number;
    readonly groups: string[][];
    readonly minority_client_reachable: string[];
    readonly majority_client_reachable: string[];
    readonly within_majority_delivery_bound_ticks: number;
    readonly new_operations: readonly StepSpec[];
    readonly minority_stale_read_probe: {
      readonly operation: StepSpec & { readonly forbidden_result: string; readonly invoke_after: string };
      readonly partition_remains_through: number;
      readonly observe_through_tick: number;
    };
  };
  readonly durability_case: { readonly steps: readonly StepSpec[] };
  readonly fault_trace: {
    readonly delivery_mode: string;
    readonly initial_pending_messages: readonly { readonly id: string; readonly from: string; readonly to: string; readonly content_label: string }[];
    readonly events: readonly TraceEvent[];
    readonly required_log_context: string[];
  };
  readonly replay_case: {
    readonly basis: string;
    readonly seed: number;
    readonly recorded_choices: string[];
    readonly checkpoints: number[];
    readonly required_equal_observations: string[];
  };
  readonly counterfactual_case: {
    readonly basis: string;
    readonly branch_tick: number;
    readonly pending_request: string;
    readonly original: { readonly partition_remains_through: number; readonly expected_pending_request: string };
    readonly branch: {
      readonly changed_event: { readonly tick: number; readonly action: string; readonly directions: string };
      readonly delivery_bound_ticks: number;
      readonly client_reachable_after_heal: string[];
      readonly retry_same_request_if_unavailable: boolean;
      readonly complete_by_tick: number;
      readonly expected_pending_request: string;
    };
  };
  readonly analysis_outcomes: readonly { readonly analysis_status: string; readonly expected: string }[];
  readonly retry_cases: {
    readonly completed_write: RetrySequence & { readonly expected_distinct_logical_operations: number };
    readonly completed_read: RetrySequence;
    readonly conflicting_intent: {
      readonly original: RetryStep;
      readonly conflicting_attempts: readonly RetryStep[];
      readonly expected_each: string;
      readonly expected_values_after: Readonly<Record<string, string>>;
    };
    readonly pending_retry: {
      readonly original: RetryStep;
      readonly fault: string;
      readonly retry: RetryStep;
      readonly expected_final_result: string;
      readonly expected_distinct_logical_operations: number;
      readonly expected_values_after: Readonly<Record<string, string>>;
    };
  };
  readonly liveness_case: {
    readonly fault_prefix: { readonly start_tick: number; readonly through_tick: number; readonly network: string; readonly pending_write: RetryStep & { readonly invoke: number } };
    readonly stable_window: {
      readonly starts_at_tick: number;
      readonly ends_at_tick: number;
      readonly alive_members: string[];
      readonly other_members: string[];
      readonly other_members_state: string;
      readonly delivery_bound_ticks: number;
      readonly drops: boolean;
      readonly new_partitions: boolean;
      readonly client_reachable_members: string[];
      readonly pending_write_complete_by_tick: number;
      readonly fresh_read: RetryStep & { readonly invoke: number; readonly complete_by: number; readonly expected: string };
    };
    readonly retry_original_if_unavailable: boolean;
    readonly no_other_writes: boolean;
  };
  readonly no_liveness_case: {
    readonly alive_members: string[];
    readonly crashed_members: string[];
    readonly client_reachable_members: string[];
    readonly observation_end_tick: number;
    readonly new_write: RetryStep;
    readonly allowed_results: string[];
    readonly forbidden_result: string;
    readonly missing_precondition: string;
  };
  readonly teaching_fixture: {
    readonly basis: string;
    readonly precondition: string;
    readonly displayed_states: readonly {
      readonly node: string;
      readonly self_reported_role: string;
      readonly leadership_generation: number;
      readonly connected_group: string[];
      readonly new_write_result: string;
    }[];
    readonly exact_generation_numbers_are_teaching_example_only: boolean;
    readonly must_label_role_as_self_reported: boolean;
    readonly global_single_leader_at_every_instant_required: boolean;
    readonly explanation_topics: string[];
  };
}

export interface RetryStep {
  readonly request: string;
  readonly client: string;
  readonly action: string;
  readonly key: string;
  readonly value?: string;
  readonly expected?: string;
  readonly is_retry?: boolean;
}

export interface RetrySequence {
  readonly steps: readonly RetryStep[];
  readonly operations_are_sequential: boolean;
}

export function parseScenarios(text: string): Scenarios {
  return parse(text) as Scenarios;
}
