// Client logical operations, attempts, retries and conflicting attempts (ADR-0001 D7, D8; ADR-0002 E1).
import { intentOf, type Action, type Command } from '../types.ts';

export type AttemptResult = 'reply' | 'unavailable' | 'none';

export interface Attempt {
  readonly sentAt: number;
  readonly via: string;
  result: AttemptResult;
  at?: number;
  /** The reply this attempt received, when it received one. */
  reply?: string;
}

export type Outcome = { readonly status: '已完成'; readonly complete: number; readonly result: string } | { readonly status: '未完成' };

/** A reuse of the identity with a different intent: never a new operation, never the original's result. */
export interface ConflictAttempt {
  readonly sentAt: number;
  readonly via: string;
  readonly intent: string;
  result?: string;
  at?: number;
}

/** One logical operation. "不可用" is an attempt result, never an outcome (ADR-0001 D8). */
export interface LogicalOp {
  readonly client: string;
  readonly requestId: string;
  readonly action: Action;
  readonly key: string;
  readonly value?: string;
  readonly intent: string;
  readonly invoke: number;
  readonly attempts: Attempt[];
  outcome: Outcome;
  /** Every reply received for this operation's intent, in arrival order (the first one decides the outcome). */
  readonly replies: { at: number; result: string; duplicate: boolean }[];
  readonly conflicts: ConflictAttempt[];
  readonly retryIfUnavailable: boolean;
}

export interface ClientParams {
  readonly attemptTimeout: number;
}

export interface ClientSend {
  readonly via: string;
  readonly command: Command;
  /** 'new' operation, 'retry' of the same intent, or 'conflict' (same identity, different intent). */
  readonly kind: 'new' | 'retry' | 'conflict';
}

export interface InvokeSpec {
  readonly requestId: string;
  readonly action: Action;
  readonly key: string;
  readonly value?: string;
  readonly via: string;
  readonly retryIfUnavailable: boolean;
}

export class Client {
  readonly id: string;
  readonly params: ClientParams;
  readonly ops: LogicalOp[] = [];

  constructor(id: string, params: ClientParams) {
    this.id = id;
    this.params = params;
  }

  private commandOf(spec: { requestId: string; action: Action; key: string; value?: string }): Command {
    return { clientId: this.id, requestId: spec.requestId, action: spec.action, key: spec.key, ...(spec.value !== undefined ? { value: spec.value } : {}) };
  }

  invoke(spec: InvokeSpec, now: number): ClientSend {
    const command = this.commandOf(spec);
    const intent = intentOf(command);
    const existing = this.ops.find((o) => o.requestId === spec.requestId);
    if (existing !== undefined) {
      if (existing.intent === intent) {
        // Same identity and intent: a retry, i.e. another attempt of the original operation.
        existing.attempts.push({ sentAt: now, via: spec.via, result: 'none' });
        return { via: spec.via, command, kind: 'retry' };
      }
      existing.conflicts.push({ sentAt: now, via: spec.via, intent });
      return { via: spec.via, command, kind: 'conflict' };
    }
    const op: LogicalOp = {
      client: this.id,
      requestId: spec.requestId,
      action: spec.action,
      key: spec.key,
      ...(spec.value !== undefined ? { value: spec.value } : {}),
      intent,
      invoke: now,
      attempts: [{ sentAt: now, via: spec.via, result: 'none' }],
      outcome: { status: '未完成' },
      replies: [],
      conflicts: [],
      retryIfUnavailable: spec.retryIfUnavailable,
    };
    this.ops.push(op);
    return { via: spec.via, command, kind: 'new' };
  }

  /**
   * Replies are matched by identity and intent. The first reply of the operation's own intent decides the
   * outcome, even after an attempt timed out; replies to a conflicting intent only fill that conflict attempt.
   */
  onReply(requestId: string, intent: string, result: string, now: number): { op: LogicalOp; duplicate: boolean; conflict: boolean } | null {
    const op = this.ops.find((o) => o.requestId === requestId);
    if (op === undefined) return null;
    if (intent !== op.intent) {
      const c = op.conflicts.find((x) => x.intent === intent && x.result === undefined);
      if (c !== undefined) {
        c.result = result;
        c.at = now;
      }
      return { op, duplicate: c === undefined, conflict: true };
    }
    const duplicate = op.outcome.status === '已完成';
    op.replies.push({ at: now, result, duplicate });
    if (!duplicate) op.outcome = { status: '已完成', complete: now, result };
    const open = op.attempts.find((a) => a.result === 'none');
    if (open !== undefined) {
      open.result = 'reply';
      open.at = now;
      open.reply = result;
    }
    return { op, duplicate, conflict: false };
  }

  hasTimerDue(now: number): boolean {
    return this.ops.some((o) => o.attempts.some((a) => a.result === 'none' && now >= a.sentAt + this.params.attemptTimeout));
  }

  /** Step 4: expire attempts as 不可用 and resend the same request when the scenario asks for it. */
  tick(now: number): { timeouts: { op: LogicalOp; attempt: Attempt }[]; resends: ClientSend[] } {
    const timeouts: { op: LogicalOp; attempt: Attempt }[] = [];
    const resends: ClientSend[] = [];
    for (const op of this.ops) {
      for (const a of [...op.attempts]) {
        if (a.result === 'none' && now >= a.sentAt + this.params.attemptTimeout) {
          a.result = 'unavailable';
          a.at = now;
          timeouts.push({ op, attempt: a });
          if (op.outcome.status === '未完成' && op.retryIfUnavailable) {
            op.attempts.push({ sentAt: now, via: a.via, result: 'none' });
            resends.push({ via: a.via, command: this.commandOf(op), kind: 'retry' });
          }
        }
      }
    }
    return { timeouts, resends };
  }
}
