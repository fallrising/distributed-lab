import type { Command } from '../types.ts';

export interface Entry {
  readonly term: number;
  readonly command: Command;
}

/** Stable, complete state-machine prefix (ADR-0003 S1). No mutable Maps travel on the wire. */
export interface Snapshot {
  readonly lastIncludedIndex: number;
  readonly lastIncludedTerm: number;
  readonly kv: Readonly<Record<string, string>>;
  readonly applied: Readonly<Record<string, { readonly intent: string; readonly result: string }>>;
  readonly effects: readonly string[];
}

export type Payload =
  | { readonly type: 'RequestVote'; readonly term: number; readonly candidateId: string; readonly lastLogIndex: number; readonly lastLogTerm: number }
  | {
      readonly type: 'RequestVoteReply';
      readonly term: number;
      readonly voteGranted: boolean;
      /** False when the voter refused because the candidate's log is not at least as up to date (ADR-0002 E3). */
      readonly logOk: boolean;
    }
  | {
      readonly type: 'AppendEntries';
      readonly term: number;
      readonly leaderId: string;
      readonly prevLogIndex: number;
      readonly prevLogTerm: number;
      readonly entries: readonly Entry[];
      readonly leaderCommit: number;
    }
  | { readonly type: 'AppendEntriesReply'; readonly term: number; readonly success: boolean; readonly matchIndex: number; readonly prevLogIndex: number; readonly nextIndexHint?: number }
  | { readonly type: 'InstallSnapshot'; readonly term: number; readonly leaderId: string; readonly snapshot: Snapshot }
  | { readonly type: 'InstallSnapshotReply'; readonly term: number; readonly lastIncludedIndex: number; readonly success: boolean }
  | { readonly type: 'ClientRequest'; readonly command: Command }
  | { readonly type: 'Forward'; readonly command: Command }
  | { readonly type: 'ClientReply'; readonly clientId: string; readonly requestId: string; readonly intent: string; readonly result: string }
  | { readonly type: 'Diagnostic'; readonly label: string };

export interface Outgoing {
  readonly to: string;
  readonly payload: Payload;
}

export function requestRefOf(p: Payload): string | undefined {
  switch (p.type) {
    case 'ClientRequest':
    case 'Forward':
      return `${p.command.clientId}/${p.command.requestId}`;
    case 'ClientReply':
      return `${p.clientId}/${p.requestId}`;
    default:
      return undefined;
  }
}
