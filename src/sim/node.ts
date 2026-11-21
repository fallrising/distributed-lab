// Raft-style replicated KV node (ADR-0001 D5, D6, D7).
// A node is exactly two fields: `stable` (survives crash) and `volatile` (null while crashed).
import { ABSENT, CONFIRMED, CONFLICT, intentOf, requestKey, type Command } from '../types.ts';
import type { Entry, Outgoing, Payload } from './messages.ts';

export type Role = 'follower' | 'candidate' | 'leader';

const gatewayKey = (c: Command) => `${requestKey(c.clientId, c.requestId)}#${intentOf(c)}`;

export interface StableStorage {
  currentTerm: number;
  votedFor: string | null;
  log: Entry[];
}

interface GatewayEntry {
  readonly command: Command;
  nextResendAt: number;
}

export interface VolatileState {
  role: Role;
  leaderId: string | null;
  commitIndex: number;
  lastApplied: number;
  kv: Map<string, string>;
  /** Request-identity dedup table of the state machine: key -> {intent, result}. */
  applied: Map<string, { intent: string; result: string }>;
  /** Request keys in the order their (first and only) effect was applied by this state machine. */
  effects: string[];
  votes: Set<string>;
  nextIndex: Map<string, number>;
  matchIndex: Map<string, number>;
  electionResetAt: number;
  heartbeatDue: number;
  gateway: Map<string, GatewayEntry>;
}

export interface NodeParams {
  readonly members: readonly string[];
  readonly electionTimeout: number;
  readonly heartbeatInterval: number;
  readonly gatewayResendInterval: number;
  /** ADR-0002 E3: a candidate refused for a stale log waits this long before campaigning again. */
  readonly staleCandidateBackoff: number;
  readonly initialValues: Readonly<Record<string, string>>;
}

/** Self-reported node state. It is what the node claims, not a global judgement. */
export interface NodeStatus {
  readonly node: string;
  readonly alive: boolean;
  readonly selfReported: true;
  readonly role: Role | 'stopped';
  readonly term: number;
  readonly leaderId: string | null;
  readonly commitIndex: number;
  readonly lastApplied: number;
  readonly logLength: number;
}

export class RaftNode {
  readonly id: string;
  readonly params: NodeParams;
  stable: StableStorage;
  volatile: VolatileState | null;

  constructor(id: string, params: NodeParams, now: number) {
    this.id = id;
    this.params = params;
    this.stable = { currentTerm: 0, votedFor: null, log: [] };
    this.volatile = this.freshVolatile(now);
  }

  get majority(): number {
    return Math.floor(this.params.members.length / 2) + 1;
  }

  private get peers(): string[] {
    return this.params.members.filter((m) => m !== this.id);
  }

  private freshVolatile(now: number): VolatileState {
    return {
      role: 'follower',
      leaderId: null,
      commitIndex: 0,
      lastApplied: 0,
      kv: new Map(Object.entries(this.params.initialValues)),
      applied: new Map(),
      effects: [],
      votes: new Set(),
      nextIndex: new Map(),
      matchIndex: new Map(),
      electionResetAt: now,
      heartbeatDue: now,
      gateway: new Map(),
    };
  }

  crash(): void {
    this.volatile = null;
  }

  /** Rebuild from stable storage only (ADR D5). */
  restart(now: number): void {
    this.volatile = this.freshVolatile(now);
  }

  status(): NodeStatus {
    const v = this.volatile;
    return {
      node: this.id,
      alive: v !== null,
      selfReported: true,
      role: v === null ? 'stopped' : v.role,
      term: this.stable.currentTerm,
      leaderId: v?.leaderId ?? null,
      commitIndex: v?.commitIndex ?? 0,
      lastApplied: v?.lastApplied ?? 0,
      logLength: this.stable.log.length,
    };
  }

  private alive(): VolatileState {
    if (this.volatile === null) throw new Error(`node ${this.id} is crashed`);
    return this.volatile;
  }

  private lastLogIndex(): number {
    return this.stable.log.length;
  }

  private lastLogTerm(): number {
    return this.stable.log[this.stable.log.length - 1]?.term ?? 0;
  }

  // ---------------------------------------------------------------- timers (tick step 3)

  tick(now: number): Outgoing[] {
    const v = this.alive();
    const out: Outgoing[] = [];
    if (v.role === 'leader') {
      if (now >= v.heartbeatDue) {
        for (const p of this.peers) out.push(this.appendEntriesFor(p));
        v.heartbeatDue = now + this.params.heartbeatInterval;
      }
    } else if (now >= v.electionResetAt + this.params.electionTimeout) {
      out.push(...this.startElection(now));
    }
    for (const key of [...v.gateway.keys()].sort()) {
      const g = v.gateway.get(key) as GatewayEntry;
      if (now >= g.nextResendAt) out.push(...this.route(g, now));
    }
    return out;
  }

  private startElection(now: number): Outgoing[] {
    const v = this.alive();
    // Rule 1: persist currentTerm and votedFor before asking for votes.
    this.stable.currentTerm += 1;
    this.stable.votedFor = this.id;
    v.role = 'candidate';
    v.leaderId = null;
    v.votes = new Set([this.id]);
    v.electionResetAt = now; // Rule 8: becoming a candidate.
    if (v.votes.size >= this.majority) return this.becomeLeader(now);
    const req: Payload = {
      type: 'RequestVote',
      term: this.stable.currentTerm,
      candidateId: this.id,
      lastLogIndex: this.lastLogIndex(),
      lastLogTerm: this.lastLogTerm(),
    };
    return this.peers.map((p) => ({ to: p, payload: req }));
  }

  private becomeLeader(now: number): Outgoing[] {
    const v = this.alive();
    v.role = 'leader';
    v.leaderId = this.id;
    v.nextIndex = new Map(this.peers.map((p) => [p, this.lastLogIndex() + 1]));
    v.matchIndex = new Map(this.peers.map((p) => [p, 0]));
    v.heartbeatDue = now;
    // No term-start no-op (ADR D5). Re-route held requests at once (ADR D7).
    return this.rerouteAll(now);
  }

  /** Step down. Rule 8: converting from leader/candidate to follower resets the election timer. */
  private observeTerm(term: number, now: number): void {
    const v = this.alive();
    if (term > this.stable.currentTerm) {
      this.stable.currentTerm = term;
      this.stable.votedFor = null;
      v.leaderId = null;
      if (v.role !== 'follower') {
        v.role = 'follower';
        v.electionResetAt = now;
      }
    }
  }

  private appendEntriesFor(peer: string): Outgoing {
    const v = this.alive();
    const next = Math.max(1, v.nextIndex.get(peer) ?? 1);
    const prev = next - 1;
    return {
      to: peer,
      payload: {
        type: 'AppendEntries',
        term: this.stable.currentTerm,
        leaderId: this.id,
        prevLogIndex: prev,
        prevLogTerm: prev > 0 ? (this.stable.log[prev - 1] as Entry).term : 0,
        entries: this.stable.log.slice(prev),
        leaderCommit: v.commitIndex,
      },
    };
  }

  // ---------------------------------------------------------------- message handling (tick steps 1–2)

  handle(from: string, payload: Payload, now: number): Outgoing[] {
    switch (payload.type) {
      case 'RequestVote':
        return this.onRequestVote(from, payload, now);
      case 'RequestVoteReply':
        return this.onRequestVoteReply(from, payload, now);
      case 'AppendEntries':
        return this.onAppendEntries(from, payload, now);
      case 'AppendEntriesReply':
        return this.onAppendEntriesReply(from, payload, now);
      case 'ClientRequest':
        return this.onClientRequest(payload.command, now);
      case 'Forward':
        return this.onForward(payload.command, now);
      case 'ClientReply':
      case 'Diagnostic':
        return []; // diagnostic messages are received but not processed (message_binding)
    }
  }

  private onRequestVote(from: string, p: Extract<Payload, { type: 'RequestVote' }>, now: number): Outgoing[] {
    const v = this.alive();
    this.observeTerm(p.term, now);
    let granted = false;
    const upToDate = p.lastLogTerm > this.lastLogTerm() || (p.lastLogTerm === this.lastLogTerm() && p.lastLogIndex >= this.lastLogIndex());
    if (p.term === this.stable.currentTerm) {
      if ((this.stable.votedFor === null || this.stable.votedFor === p.candidateId) && upToDate) {
        this.stable.votedFor = p.candidateId; // Rule 1: persisted before the reply is produced.
        v.electionResetAt = now; // Rule 8: granting a vote.
        granted = true;
      }
    }
    return [{ to: from, payload: { type: 'RequestVoteReply', term: this.stable.currentTerm, voteGranted: granted, logOk: upToDate } }];
  }

  private onRequestVoteReply(from: string, p: Extract<Payload, { type: 'RequestVoteReply' }>, now: number): Outgoing[] {
    const v = this.alive();
    this.observeTerm(p.term, now);
    // Rule 5: replies of another term are ignored.
    if (v.role !== 'candidate' || p.term !== this.stable.currentTerm) return [];
    if (!p.voteGranted) {
      // ADR-0002 E3: refused for a stale log. Step down and back off so a node with a newer log can win
      // instead of being knocked back by our ever-higher terms (the liveness_case livelock).
      if (!p.logOk) {
        v.role = 'follower';
        v.electionResetAt = now + this.params.staleCandidateBackoff;
      }
      return [];
    }
    v.votes.add(from);
    return v.votes.size >= this.majority ? this.becomeLeader(now) : [];
  }

  private onAppendEntries(from: string, p: Extract<Payload, { type: 'AppendEntries' }>, now: number): Outgoing[] {
    const v = this.alive();
    const reply = (success: boolean, matchIndex: number): Outgoing[] => [
      { to: from, payload: { type: 'AppendEntriesReply', term: this.stable.currentTerm, success, matchIndex, prevLogIndex: p.prevLogIndex } },
    ];
    if (p.term < this.stable.currentTerm) return reply(false, 0);
    this.observeTerm(p.term, now);
    const out: Outgoing[] = [];
    if (v.role !== 'follower') v.role = 'follower'; // same-term candidate yields; Rule 8 reset follows below
    v.electionResetAt = now; // Rule 8: AppendEntries from the current leader.
    if (v.leaderId !== p.leaderId) {
      v.leaderId = p.leaderId;
      out.push(...this.rerouteAll(now));
    }
    const log = this.stable.log;
    if (p.prevLogIndex > log.length || (p.prevLogIndex > 0 && (log[p.prevLogIndex - 1] as Entry).term !== p.prevLogTerm)) {
      return [...out, ...reply(false, 0)];
    }
    // Rule 2: truncate only on a term conflict; entries that already match are kept.
    p.entries.forEach((e, i) => {
      const idx = p.prevLogIndex + 1 + i;
      const existing = log[idx - 1];
      if (existing === undefined) log.push(e);
      else if (existing.term !== e.term) {
        log.length = idx - 1;
        log.push(e);
      }
    });
    // Rule 3: acknowledge prevLogIndex + entries.length, not our own log length.
    const lastNew = p.prevLogIndex + p.entries.length;
    // Rule 6: commitIndex = min(leaderCommit, last new entry), never backwards.
    const commit = Math.min(p.leaderCommit, lastNew);
    if (commit > v.commitIndex) {
      v.commitIndex = commit;
      out.push(...this.applyCommitted());
    }
    // Rule 1: the log above is already in stable storage when the ack is produced.
    return [...out, ...reply(true, lastNew)];
  }

  private onAppendEntriesReply(from: string, p: Extract<Payload, { type: 'AppendEntriesReply' }>, now: number): Outgoing[] {
    const v = this.alive();
    this.observeTerm(p.term, now);
    if (v.role !== 'leader' || p.term !== this.stable.currentTerm) return []; // Rule 5
    const match = v.matchIndex.get(from) ?? 0;
    const next = v.nextIndex.get(from) ?? 1;
    if (p.success) {
      // Rule 4: matchIndex only grows.
      const m = Math.max(match, p.matchIndex);
      v.matchIndex.set(from, m);
      v.nextIndex.set(from, Math.max(next, m + 1));
      return this.advanceCommit();
    }
    // Rule 4: nextIndex never below 1 (nor below what is known to match).
    v.nextIndex.set(from, Math.max(1, match + 1, Math.min(next, p.prevLogIndex)));
    return [];
  }

  /** Rule 7: only entries of the current term are committed by counting replicas (Raft §5.4.2). */
  private advanceCommit(): Outgoing[] {
    const v = this.alive();
    for (let n = this.lastLogIndex(); n > v.commitIndex; n--) {
      if ((this.stable.log[n - 1] as Entry).term !== this.stable.currentTerm) break;
      let count = 1;
      for (const p of this.peers) if ((v.matchIndex.get(p) ?? 0) >= n) count++;
      if (count >= this.majority) {
        v.commitIndex = n;
        return this.applyCommitted();
      }
    }
    return [];
  }

  // ---------------------------------------------------------------- state machine and replies (D6, D7)

  private applyCommitted(): Outgoing[] {
    const v = this.alive();
    const out: Outgoing[] = [];
    while (v.lastApplied < v.commitIndex) {
      v.lastApplied += 1;
      const c = (this.stable.log[v.lastApplied - 1] as Entry).command;
      const key = requestKey(c.clientId, c.requestId);
      const intent = intentOf(c);
      const prior = v.applied.get(key);
      let result: string;
      if (prior !== undefined) result = prior.intent === intent ? prior.result : CONFLICT;
      else {
        if (c.action === 'write') {
          v.kv.set(c.key, c.value as string);
          result = CONFIRMED;
        } else result = v.kv.get(c.key) ?? ABSENT;
        v.applied.set(key, { intent, result });
        v.effects.push(key);
      }
      const reply: Outgoing = { to: c.clientId, payload: { type: 'ClientReply', clientId: c.clientId, requestId: c.requestId, intent, result } };
      const isGateway = v.gateway.delete(gatewayKey(c));
      // Leader replies directly; the gateway also replies as a backup (same reply once if both).
      if (v.role === 'leader' || isGateway) out.push(reply);
    }
    return out;
  }

  private onClientRequest(command: Command, now: number): Outgoing[] {
    const v = this.alive();
    // Keyed by identity and intent: a different intent under the same identity is its own request (ADR D7).
    const key = gatewayKey(command);
    let g = v.gateway.get(key);
    if (g === undefined) {
      g = { command, nextResendAt: now };
      v.gateway.set(key, g);
    }
    return this.route(g, now);
  }

  private onForward(command: Command, now: number): Outgoing[] {
    if (this.alive().role === 'leader') this.propose(command);
    void now;
    return []; // a non-leader drops forwards; the gateway resends
  }

  /** Gateway routing: propose if leader, forward to a known leader, otherwise hold. */
  private route(g: GatewayEntry, now: number): Outgoing[] {
    const v = this.alive();
    g.nextResendAt = now + this.params.gatewayResendInterval;
    if (v.role === 'leader') {
      this.propose(g.command);
      return [];
    }
    if (v.leaderId !== null && v.leaderId !== this.id) return [{ to: v.leaderId, payload: { type: 'Forward', command: g.command } }];
    return [];
  }

  private rerouteAll(now: number): Outgoing[] {
    const v = this.alive();
    const out: Outgoing[] = [];
    for (const key of [...v.gateway.keys()].sort()) out.push(...this.route(v.gateway.get(key) as GatewayEntry, now));
    return out;
  }

  /** Leader-side dedup only for an uncommitted entry of the current term with the same identity and intent (ADR D7). */
  private propose(command: Command): void {
    const v = this.alive();
    const term = this.stable.currentTerm;
    const key = gatewayKey(command);
    const dup = this.stable.log.some((e, i) => i + 1 > v.commitIndex && e.term === term && gatewayKey(e.command) === key);
    if (dup) return;
    // Rule 1: the leader writes its own log before replicating (heartbeat carries it).
    this.stable.log.push({ term, command });
  }
}
