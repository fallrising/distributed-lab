// Shared vocabulary. Result strings are the business terms from data/scenarios.yaml (cluster.*_result).
export const CONFIRMED = '已確認';
export const ABSENT = '不存在';
export const UNAVAILABLE = '不可用';
export const CONFLICT = '請求識別衝突';

export type NodeId = string;
export type ClientId = string;
export type Action = 'read' | 'write';

/** One client request: (clientId, requestId) is the identity of a logical operation (ADR D7). */
export interface Command {
  readonly clientId: ClientId;
  readonly requestId: string;
  readonly action: Action;
  readonly key: string;
  readonly value?: string;
}

export function requestKey(clientId: ClientId, requestId: string): string {
  return `${clientId}/${requestId}`;
}

/** Intent used to tell a same-intent retry from an identity conflict. */
export function intentOf(c: Command): string {
  return JSON.stringify([c.action, c.key, c.action === 'write' ? (c.value ?? null) : null]);
}
