// Client logical operations and attempts (ADR-0001 D7, D8).
import { UNAVAILABLE, type Action, type Command } from '../types.ts';

export type AttemptResult = 'reply' | 'unavailable' | 'none';

export interface Attempt {
  readonly sentAt: number;
  readonly via: string;
  result: AttemptResult;
  at?: number;
}

export type Outcome = { readonly status: '已完成'; readonly complete: number; readonly result: string } | { readonly status: '未完成' };

/** One logical operation. "不可用" is an attempt result, never an outcome (ADR D8). */
export interface LogicalOp {
  readonly client: string;
  readonly requestId: string;
  readonly action: Action;
  readonly key: string;
  readonly value?: string;
  readonly invoke: number;
  readonly attempts: Attempt[];
  outcome: Outcome;
  /** Every reply received for this operation, in arrival order (the first one decides the outcome). */
  readonly replies: { at: number; result: string; duplicate: boolean }[];
  readonly retryIfUnavailable: boolean;
}

export interface ClientParams {
  readonly attemptTimeout: number;
}

export interface ClientSend {
  readonly via: string;
  readonly command: Command;
}

export class Client {
  readonly id: string;
  readonly params: ClientParams;
  readonly ops: LogicalOp[] = [];

  constructor(id: string, params: ClientParams) {
    this.id = id;
    this.params = params;
  }

  invoke(spec: { requestId: string; action: Action; key: string; value?: string; via: string; retryIfUnavailable: boolean }, now: number): ClientSend {
    if (this.ops.some((o) => o.requestId === spec.requestId)) throw new Error(`request ${this.id}/${spec.requestId} already used`);
    const op: LogicalOp = {
      client: this.id,
      requestId: spec.requestId,
      action: spec.action,
      key: spec.key,
      ...(spec.value !== undefined ? { value: spec.value } : {}),
      invoke: now,
      attempts: [{ sentAt: now, via: spec.via, result: 'none' }],
      outcome: { status: '未完成' },
      replies: [],
      retryIfUnavailable: spec.retryIfUnavailable,
    };
    this.ops.push(op);
    return { via: spec.via, command: this.commandOf(op) };
  }

  private commandOf(op: LogicalOp): Command {
    return { clientId: this.id, requestId: op.requestId, action: op.action, key: op.key, ...(op.value !== undefined ? { value: op.value } : {}) };
  }

  /** First reply decides the outcome, even after the attempt timed out; later ones are duplicates. */
  onReply(requestId: string, result: string, now: number): { op: LogicalOp; duplicate: boolean } | null {
    const op = this.ops.find((o) => o.requestId === requestId);
    if (op === undefined) return null;
    const duplicate = op.outcome.status === '已完成';
    op.replies.push({ at: now, result, duplicate });
    if (!duplicate) {
      op.outcome = { status: '已完成', complete: now, result };
      const open = op.attempts.find((a) => a.result === 'none');
      if (open !== undefined) {
        open.result = 'reply';
        open.at = now;
      }
    }
    return { op, duplicate };
  }

  hasTimerDue(now: number): boolean {
    return this.ops.some((o) => o.attempts.some((a) => a.result === 'none' && now >= a.sentAt + this.params.attemptTimeout));
  }

  /** Step 4: expire attempts as 不可用 and resend the same request when the scenario asks for it. */
  tick(now: number): { timeouts: { op: LogicalOp; attempt: Attempt }[]; resends: ClientSend[] } {
    const timeouts: { op: LogicalOp; attempt: Attempt }[] = [];
    const resends: ClientSend[] = [];
    for (const op of this.ops) {
      for (const a of op.attempts) {
        if (a.result === 'none' && now >= a.sentAt + this.params.attemptTimeout) {
          a.result = 'unavailable';
          a.at = now;
          timeouts.push({ op, attempt: a });
          if (op.outcome.status === '未完成' && op.retryIfUnavailable) {
            op.attempts.push({ sentAt: now, via: a.via, result: 'none' });
            resends.push({ via: a.via, command: this.commandOf(op) });
          }
        }
      }
    }
    return { timeouts, resends };
  }
}

export const ATTEMPT_UNAVAILABLE = UNAVAILABLE;
