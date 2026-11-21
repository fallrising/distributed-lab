// Discrete-event experiment: virtual ticks, network, fault controls, append-only log,
// recording, replay and counterfactual branches (ADR-0001 D2, D3, D4, D10, D11).
import { BranchChooser, ReplayChooser, StrategyChooser, choosePermutation, type Chooser, type ChoiceRecord, type Strategy } from '../chooser.ts';
import { canonicalJson, deepFreeze } from '../canonical.ts';
import { RaftNode, type NodeStatus, type StableStorage } from './node.ts';
import { Client, type LogicalOp } from './client.ts';
import { requestRefOf, type Outgoing, type Payload } from './messages.ts';
import type { Action, Command } from '../types.ts';

export interface AliasSpec {
  readonly alias: string;
  readonly from: string;
  readonly to: string;
  readonly label: string;
}

export interface ExperimentConfig {
  readonly members: readonly string[];
  readonly clients: readonly string[];
  readonly electionTimeouts: Readonly<Record<string, number>>;
  readonly heartbeatInterval: number;
  readonly gatewayResendInterval: number;
  readonly clientAttemptTimeout: number;
  /** Auto mode: each message's delay is chosen in [1, deliveryBound]. */
  readonly deliveryBound: number;
  /** Optional time-dependent bounds: from `fromTick` on, sends use `bound` (ADR-0002 E3). */
  readonly deliveryBounds?: readonly { readonly fromTick: number; readonly bound: number }[];
  readonly deliveryMode: 'auto' | 'manual';
  readonly initialValues: Readonly<Record<string, string>>;
  readonly retryIfUnavailable: boolean;
  readonly aliases: readonly AliasSpec[];
}

export type ScriptEvent =
  | {
      readonly tick: number;
      readonly type: 'invoke';
      readonly client: string;
      readonly requestId: string;
      readonly action: Action;
      readonly key: string;
      readonly value?: string;
      readonly via: string;
    }
  | { readonly tick: number; readonly type: 'partition'; readonly groups: readonly (readonly string[])[]; readonly clientReachable?: readonly string[] }
  | { readonly tick: number; readonly type: 'heal'; readonly clientReachable?: readonly string[] }
  | { readonly tick: number; readonly type: 'crash'; readonly node: string }
  | { readonly tick: number; readonly type: 'restart'; readonly node: string }
  | { readonly tick: number; readonly type: 'delay'; readonly message: string; readonly at: number }
  | { readonly tick: number; readonly type: 'drop'; readonly message: string }
  | { readonly tick: number; readonly type: 'duplicate'; readonly message: string; readonly copyAlias?: string }
  | { readonly tick: number; readonly type: 'deliver'; readonly message: string }
  | { readonly tick: number; readonly type: 'client-reach'; readonly members: readonly string[] };

export interface Recording {
  readonly config: ExperimentConfig;
  readonly script: readonly ScriptEvent[];
  readonly choices: readonly ChoiceRecord[];
  readonly endTick: number;
}

/** One append-only log entry (ADR D10). */
export interface LogEntry {
  readonly seq: number;
  readonly tick: number;
  readonly kind: 'external' | 'effect';
  readonly action: string;
  readonly target: string;
  readonly messageRelation?: { readonly originId?: string; readonly diagnostic?: boolean };
  readonly outcome?: string;
  readonly requestRef?: string;
  readonly nodeStatus?: NodeStatus & { readonly group: readonly string[] | null };
  readonly causeSeq?: number;
  readonly detail?: string;
}

export interface MessageView {
  readonly id: string;
  readonly seq: number;
  readonly alias?: string;
  readonly from: string;
  readonly to: string;
  readonly payload: Payload;
  readonly sentAt: number;
  readonly deliverAt: number;
  readonly earliestAt: number;
  readonly originId?: string;
  readonly diagnostic: boolean;
}

interface Message {
  id: string;
  seq: number;
  alias?: string;
  from: string;
  to: string;
  payload: Payload;
  sentAt: number;
  deliverAt: number;
  earliestAt: number;
  originId?: string;
  diagnostic: boolean;
}

export interface Observation {
  readonly operations: LogicalOp[];
  readonly faultLog: LogEntry[];
  readonly nodes: (NodeStatus & { readonly group: readonly string[] | null })[];
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class Experiment {
  readonly config: ExperimentConfig;
  private readonly chooser: Chooser;
  private readonly nodes = new Map<string, RaftNode>();
  private readonly clients = new Map<string, Client>();
  private readonly script: ScriptEvent[] = [];
  private readonly entries: LogEntry[] = [];
  private readonly messages = new Map<string, Message>();
  private pendingIds: string[] = [];
  private readonly aliases = new Map<string, string>();
  private msgSeq = 0;
  private groups: string[][] | null = null;
  private clientReachable: Set<string>;
  private partitionSeq: number | undefined;
  private readonly crashSeq = new Map<string, number>();
  private pausedFlag = false;
  now = 0;

  constructor(config: ExperimentConfig, chooser: Chooser) {
    this.config = config;
    this.chooser = chooser;
    this.clientReachable = new Set(config.members);
    for (const m of config.members) {
      const timeout = config.electionTimeouts[m];
      if (timeout === undefined) throw new Error(`no election timeout for ${m}`);
      this.nodes.set(
        m,
        new RaftNode(
          m,
          {
            members: config.members,
            electionTimeout: timeout,
            heartbeatInterval: config.heartbeatInterval,
            gatewayResendInterval: config.gatewayResendInterval,
            staleCandidateBackoff: Math.max(...Object.values(config.electionTimeouts)),
            initialValues: config.initialValues,
          },
          0,
        ),
      );
    }
    for (const c of config.clients) this.clients.set(c, new Client(c, { attemptTimeout: config.clientAttemptTimeout }));
    this.bindAliases();
  }

  // ---------------------------------------------------------------- user controls

  schedule(ev: ScriptEvent): void {
    if (!Number.isInteger(ev.tick) || ev.tick <= this.now) throw new Error(`cannot schedule at tick ${ev.tick}; now is ${this.now}`);
    this.script.push(ev);
  }

  pause(): void {
    this.pausedFlag = true;
  }

  resume(): void {
    this.pausedFlag = false;
  }

  get paused(): boolean {
    return this.pausedFlag;
  }

  advance(n = 1): this {
    if (this.pausedFlag) throw new Error('experiment is paused; resume before advancing');
    for (let i = 0; i < n; i++) this.step(this.now + 1);
    return this;
  }

  advanceTo(tick: number): this {
    if (tick < this.now) throw new Error(`virtual time cannot go back (${tick} < ${this.now})`);
    return this.advance(tick - this.now);
  }

  // ---------------------------------------------------------------- read-only views (never advance time)

  log(): readonly LogEntry[] {
    return this.entries;
  }

  history(): LogicalOp[] {
    return [...this.clients.values()].flatMap((c) => c.ops).sort((a, b) => a.invoke - b.invoke || (a.client < b.client ? -1 : a.client > b.client ? 1 : 0));
  }

  pending(): MessageView[] {
    return this.pendingIds.map((id) => this.view(this.messages.get(id) as Message));
  }

  messageById(id: string): MessageView | undefined {
    const m = this.messages.get(id);
    return m === undefined ? undefined : this.view(m);
  }

  resolve(ref: string): string {
    return this.aliases.get(ref) ?? ref;
  }

  nodeStatus(id: string): NodeStatus & { readonly group: readonly string[] | null } {
    const n = this.nodes.get(id);
    if (n === undefined) throw new Error(`unknown node ${id}`);
    return { ...n.status(), group: this.groupOf(id) };
  }

  nodeStatuses(): (NodeStatus & { readonly group: readonly string[] | null })[] {
    return this.config.members.map((m) => this.nodeStatus(m));
  }

  /** The node's state-machine value for `key` (undefined when absent or crashed). Observer view. */
  nodeValue(id: string, key: string): string | undefined {
    return this.nodes.get(id)?.volatile?.kv.get(key);
  }

  /** Request keys whose effect this node's state machine applied, in order (dedup hits are not effects). */
  nodeAppliedRequests(id: string): string[] {
    return [...(this.nodes.get(id)?.volatile?.effects ?? [])];
  }

  clientReachableNow(): string[] {
    return this.config.members.filter((m) => this.clientReachable.has(m));
  }

  partitionGroups(): string[][] | null {
    return this.groups === null ? null : this.groups.map((g) => [...g]);
  }

  deliveryBoundAt(t: number): number {
    let bound = this.config.deliveryBound;
    for (const b of this.config.deliveryBounds ?? []) if (t >= b.fromTick) bound = b.bound;
    return bound;
  }

  /**
   * Observer note (ADR-0002 E3): from the gateway, count live nodes in its connected group. Fewer than a
   * majority means the liveness precondition "存活且可互相送達的多數" is missing. Nodes do not know this.
   */
  private missingMajorityFrom(via: string): string | null {
    const majority = Math.floor(this.config.members.length / 2) + 1;
    const node = this.nodes.get(via);
    if (node === undefined) return null;
    const group = this.groupOf(via) ?? [...this.config.members];
    const usable = group.filter((m) => (this.nodes.get(m) as RaftNode).volatile !== null);
    const viaUsable = node.volatile !== null && this.clientReachable.has(via);
    if (viaUsable && usable.length >= majority) return null;
    const why = viaUsable ? `可用 ${usable.join('、') || '無'}；需要 ${majority}` : `閘道 ${via} 不可用`;
    return `缺少前提：存活且可互相送達的多數（${why}）`;
  }

  nodeStable(id: string): StableStorage {
    const n = this.nodes.get(id);
    if (n === undefined) throw new Error(`unknown node ${id}`);
    return clone(n.stable);
  }

  observation(): Observation {
    return clone({ operations: this.history(), faultLog: [...this.entries], nodes: this.nodeStatuses() });
  }

  /** Configuration, script and choice log, deep-frozen (ADR D11). */
  recording(): Recording {
    return deepFreeze(clone({ config: this.config, script: this.script, choices: this.chooser.records, endTick: this.now }));
  }

  replayRemaining(): number {
    if (this.chooser instanceof ReplayChooser) return this.chooser.remaining;
    if (this.chooser instanceof BranchChooser) return this.chooser.prefixRemaining;
    return 0;
  }

  // ---------------------------------------------------------------- one tick (ADR D3)

  private step(t: number): void {
    this.now = t;
    // 1. External events in script order.
    for (const ev of this.script.filter((e) => e.tick === t)) this.applyExternal(ev, t);
    // 2. Automatic deliveries that are due, in a chosen order.
    if (this.config.deliveryMode === 'auto') {
      const due = this.pendingIds.map((id) => this.messages.get(id) as Message).filter((m) => m.deliverAt <= t);
      for (const m of choosePermutation(this.chooser, 'delivery-order', due, (x) => x.id, { tick: t })) {
        if (this.pendingIds.includes(m.id)) this.deliver(m, t, undefined);
      }
    }
    // 3. Node timers in a chosen order.
    const alive = this.config.members.filter((m) => (this.nodes.get(m) as RaftNode).volatile !== null);
    for (const id of choosePermutation(this.chooser, 'node-order', alive, (x) => x, { tick: t })) {
      const node = this.nodes.get(id) as RaftNode;
      if (node.volatile !== null) this.sendAll(id, node.tick(t), t);
    }
    // 4. Client timers in a chosen order.
    const dueClients = this.config.clients.filter((c) => (this.clients.get(c) as Client).hasTimerDue(t));
    for (const id of choosePermutation(this.chooser, 'client-order', dueClients, (x) => x, { tick: t })) {
      const { timeouts, resends } = (this.clients.get(id) as Client).tick(t);
      for (const { op, attempt } of timeouts) {
        this.append({ tick: t, kind: 'effect', action: 'client-timeout', target: id, outcome: '不可用', requestRef: `${id}/${op.requestId}`, detail: `attempt sent at ${attempt.sentAt} via ${attempt.via}` });
        const missing = this.missingMajorityFrom(attempt.via);
        if (missing !== null) this.append({ tick: t, kind: 'effect', action: 'precondition', target: attempt.via, outcome: missing, requestRef: `${id}/${op.requestId}` });
      }
      for (const r of resends) this.clientSend(id, r.via, r.command, t, undefined, 'client-resend');
    }
  }

  private applyExternal(ev: ScriptEvent, t: number): void {
    switch (ev.type) {
      case 'invoke': {
        const client = this.clients.get(ev.client);
        if (client === undefined) throw new Error(`unknown client ${ev.client}`);
        const ref = `${ev.client}/${ev.requestId}`;
        const ext = this.append({ tick: t, kind: 'external', action: 'client-invoke', target: ev.via, requestRef: ref, detail: `${ev.action} ${ev.key}${ev.value !== undefined ? `=${ev.value}` : ''}` });
        const send = client.invoke({ requestId: ev.requestId, action: ev.action, key: ev.key, ...(ev.value !== undefined ? { value: ev.value } : {}), via: ev.via, retryIfUnavailable: this.config.retryIfUnavailable }, t);
        if (send.kind === 'conflict-local') {
          this.append({ tick: t, kind: 'effect', action: 'client-conflict-rejected', target: ev.client, outcome: '請求識別衝突（原操作尚無結果，用戶端拒絕，未送出）', requestRef: ref, causeSeq: ext.seq });
        } else this.clientSend(ev.client, send.via, send.command, t, ext.seq, send.kind === 'new' ? 'client-send' : send.kind === 'retry' ? 'client-resend' : 'client-conflict-send');
        return;
      }
      case 'partition': {
        const ext = this.append({ tick: t, kind: 'external', action: 'partition', target: ev.groups.map((g) => g.join('')).join('|') });
        this.groups = ev.groups.map((g) => [...g]);
        if (ev.clientReachable !== undefined) this.clientReachable = new Set(ev.clientReachable);
        this.partitionSeq = ext.seq;
        for (const id of [...this.pendingIds]) {
          const m = this.messages.get(id) as Message;
          if (this.blocked(m.from, m.to)) this.discard(m, t, 'partition-drop', ext.seq, '已丟棄（跨分割）');
        }
        return;
      }
      case 'client-reach': {
        this.append({ tick: t, kind: 'external', action: 'client-reach', target: ev.members.join('') || '-' });
        this.clientReachable = new Set(ev.members);
        return;
      }
      case 'heal': {
        this.append({ tick: t, kind: 'external', action: 'heal', target: 'all' });
        this.groups = null;
        this.clientReachable = new Set(ev.clientReachable ?? this.config.members);
        this.partitionSeq = undefined;
        return; // dropped messages are not resurrected
      }
      case 'crash': {
        const node = this.nodes.get(ev.node) as RaftNode;
        const ext = this.append({ tick: t, kind: 'external', action: 'crash', target: ev.node });
        node.crash();
        this.crashSeq.set(ev.node, ext.seq);
        this.append({ tick: t, kind: 'effect', action: 'node-stopped', target: ev.node, outcome: '停止，穩定儲存保留', nodeStatus: this.nodeStatus(ev.node), causeSeq: ext.seq });
        for (const id of [...this.pendingIds]) {
          const m = this.messages.get(id) as Message;
          if (m.to === ev.node) this.discard(m, t, 'crash-drop', ext.seq, '已丟棄（收件節點崩潰）');
        }
        return;
      }
      case 'restart': {
        const node = this.nodes.get(ev.node) as RaftNode;
        const ext = this.append({ tick: t, kind: 'external', action: 'restart', target: ev.node });
        node.restart(t);
        this.crashSeq.delete(ev.node);
        this.append({ tick: t, kind: 'effect', action: 'node-restarted', target: ev.node, outcome: '自穩定儲存重建', nodeStatus: this.nodeStatus(ev.node), causeSeq: ext.seq });
        return;
      }
      case 'delay': {
        const m = this.pendingMessage(ev.message);
        if (m === undefined) return this.reject(t, 'delay', ev.message, '拒絕：不是待送訊息');
        const ext = this.append({ tick: t, kind: 'external', action: 'delay', target: m.id, outcome: `最早交付 ${ev.at}` });
        m.earliestAt = Math.max(m.earliestAt, ev.at);
        if (this.config.deliveryMode === 'auto') m.deliverAt = Math.max(m.deliverAt, ev.at);
        this.append({ tick: t, kind: 'effect', action: 'delayed', target: m.id, outcome: `最早交付 ${m.earliestAt}`, causeSeq: ext.seq, ...this.relation(m) });
        return;
      }
      case 'drop': {
        const m = this.pendingMessage(ev.message);
        if (m === undefined) return this.reject(t, 'drop', ev.message, '拒絕：不是待送訊息');
        const ext = this.append({ tick: t, kind: 'external', action: 'drop', target: m.id });
        this.discard(m, t, 'drop', ext.seq, '已丟棄（使用者）');
        return;
      }
      case 'duplicate': {
        const m = this.pendingMessage(ev.message);
        if (m === undefined) return this.reject(t, 'duplicate', ev.message, '拒絕：不是待送訊息');
        const ext = this.append({ tick: t, kind: 'external', action: 'duplicate', target: m.id });
        const copy = this.newMessage(m.from, m.to, m.payload, t, { originId: m.id, diagnostic: m.diagnostic, earliestAt: m.earliestAt, ...(ev.copyAlias !== undefined ? { alias: ev.copyAlias } : {}) });
        if (this.config.deliveryMode === 'auto') copy.deliverAt = Math.max(m.deliverAt, t + 1);
        if (ev.copyAlias !== undefined) this.aliases.set(ev.copyAlias, copy.id);
        this.pendingIds.push(copy.id);
        this.append({ tick: t, kind: 'effect', action: 'duplicate', target: copy.id, outcome: '已複製，內容相同', causeSeq: ext.seq, ...this.relation(copy) });
        return;
      }
      case 'deliver': {
        const m = this.pendingMessage(ev.message);
        if (m === undefined) return this.reject(t, 'deliver', this.resolve(ev.message), '拒絕：不是待送訊息（已傳遞或已丟棄的訊息不會復活）');
        if (t < m.earliestAt) return this.reject(t, 'deliver', m.id, `拒絕：最早可交付時刻是 ${m.earliestAt}`);
        const ext = this.append({ tick: t, kind: 'external', action: 'deliver', target: m.id });
        this.deliver(m, t, ext.seq);
        return;
      }
    }
  }

  private reject(t: number, action: string, target: string, outcome: string): void {
    this.append({ tick: t, kind: 'external', action, target: this.resolve(target), outcome });
  }

  // ---------------------------------------------------------------- network

  private groupOf(node: string): string[] | null {
    return this.groups?.find((g) => g.includes(node)) ?? null;
  }

  private isNode(id: string): boolean {
    return this.nodes.has(id);
  }

  private blocked(from: string, to: string): boolean {
    const fn = this.isNode(from);
    const tn = this.isNode(to);
    if (fn && tn) {
      const a = this.groupOf(from);
      const b = this.groupOf(to);
      return a !== null && b !== null && a !== b;
    }
    if (fn && !tn) return !this.clientReachable.has(from);
    if (!fn && tn) return !this.clientReachable.has(to);
    return false;
  }

  private newMessage(from: string, to: string, payload: Payload, t: number, extra: { originId?: string; diagnostic?: boolean; alias?: string; earliestAt?: number } = {}): Message {
    this.msgSeq += 1;
    const m: Message = {
      id: `msg-${this.msgSeq}`,
      seq: this.msgSeq,
      from,
      to,
      payload,
      sentAt: t,
      deliverAt: Number.POSITIVE_INFINITY,
      earliestAt: extra.earliestAt ?? t + 1,
      diagnostic: extra.diagnostic ?? false,
      ...(extra.originId !== undefined ? { originId: extra.originId } : {}),
      ...(extra.alias !== undefined ? { alias: extra.alias } : {}),
    };
    this.messages.set(m.id, m);
    return m;
  }

  /** Send one message: dropped at send time across a partition or to a crashed node, else pending. */
  private send(from: string, to: string, payload: Payload, t: number): Message | null {
    const m = this.newMessage(from, to, payload, t);
    const target = this.nodes.get(to);
    if (target !== undefined && target.volatile === null) {
      this.discard(m, t, 'crash-drop', this.crashSeq.get(to), '已丟棄（收件節點崩潰）', false);
      return null;
    }
    if (this.blocked(from, to)) {
      this.discard(m, t, 'partition-drop', this.partitionSeq, '已丟棄（跨分割）', false);
      return null;
    }
    if (this.config.deliveryMode === 'auto') {
      const options = Array.from({ length: this.deliveryBoundAt(t) }, (_, i) => i + 1);
      m.deliverAt = t + this.chooser.choose('delay', options, { tick: t, from, to });
    }
    this.pendingIds.push(m.id);
    return m;
  }

  private sendAll(from: string, outs: readonly Outgoing[], t: number): void {
    for (const o of outs) this.send(from, o.to, o.payload, t);
  }

  private clientSend(client: string, via: string, command: Command, t: number, causeSeq: number | undefined, action: string): void {
    const m = this.send(client, via, { type: 'ClientRequest', command }, t);
    this.append({ tick: t, kind: 'effect', action, target: m?.id ?? via, outcome: m === null ? '送出即丟棄' : `送往 ${via}`, requestRef: `${client}/${command.requestId}`, ...(causeSeq !== undefined ? { causeSeq } : {}) });
  }

  private pendingMessage(ref: string): Message | undefined {
    const id = this.resolve(ref);
    return this.pendingIds.includes(id) ? this.messages.get(id) : undefined;
  }

  private relation(m: Message): Pick<LogEntry, 'messageRelation' | 'requestRef'> {
    const rel: { originId?: string; diagnostic?: boolean } = {};
    if (m.originId !== undefined) rel.originId = m.originId;
    if (m.diagnostic) rel.diagnostic = true;
    const ref = requestRefOf(m.payload);
    return { ...(Object.keys(rel).length > 0 ? { messageRelation: rel } : {}), ...(ref !== undefined ? { requestRef: ref } : {}) };
  }

  private discard(m: Message, t: number, action: string, causeSeq: number | undefined, outcome: string, wasPending = true): void {
    if (wasPending) this.pendingIds = this.pendingIds.filter((id) => id !== m.id);
    this.append({ tick: t, kind: 'effect', action, target: m.id, outcome, detail: `${m.from}->${m.to} ${m.payload.type}`, ...(causeSeq !== undefined ? { causeSeq } : {}), ...this.relation(m) });
  }

  private deliver(m: Message, t: number, causeSeq: number | undefined): void {
    this.pendingIds = this.pendingIds.filter((id) => id !== m.id);
    const node = this.nodes.get(m.to);
    const base = { tick: t, kind: 'effect' as const, target: m.id, detail: `${m.from}->${m.to} ${m.payload.type}`, ...(causeSeq !== undefined ? { causeSeq } : {}), ...this.relation(m) };
    if (node !== undefined) {
      if (node.volatile === null) {
        this.append({ ...base, action: 'crash-drop', outcome: '已丟棄（收件節點崩潰）' });
        return;
      }
      const outs = m.diagnostic ? [] : node.handle(m.from, m.payload, t);
      this.append({ ...base, action: 'deliver', outcome: '已傳遞', nodeStatus: this.nodeStatus(m.to) });
      this.sendAll(m.to, outs, t);
      return;
    }
    const client = this.clients.get(m.to);
    if (client !== undefined && m.payload.type === 'ClientReply') {
      const r = client.onReply(m.payload.requestId, m.payload.intent, m.payload.result, t);
      this.append({ ...base, action: 'deliver', outcome: '已傳遞' });
      this.append({ tick: t, kind: 'effect', action: 'client-reply', target: m.to, outcome: `${m.payload.result}${r?.duplicate ? '（重複回覆）' : ''}`, requestRef: `${m.payload.clientId}/${m.payload.requestId}` });
      return;
    }
    this.append({ ...base, action: 'deliver', outcome: '已傳遞' });
  }

  private bindAliases(): void {
    for (const a of this.config.aliases) {
      const bound = new Set(this.aliases.values());
      const found = this.pendingIds.map((id) => this.messages.get(id) as Message).find((m) => m.from === a.from && m.to === a.to && !bound.has(m.id));
      const m = found ?? this.newMessage(a.from, a.to, { type: 'Diagnostic', label: a.label }, 0, { diagnostic: true, alias: a.alias });
      if (found === undefined) {
        this.pendingIds.push(m.id);
        if (this.config.deliveryMode === 'auto') m.deliverAt = 1;
      } else m.alias = a.alias;
      this.aliases.set(a.alias, m.id);
      this.append({ tick: 0, kind: 'external', action: 'bind-alias', target: m.id, outcome: `綁定 ${a.alias}（${a.from}->${a.to}）`, detail: a.label, ...this.relation(m) });
    }
  }

  private append(e: Omit<LogEntry, 'seq'>): LogEntry {
    const entry: LogEntry = { seq: this.entries.length, ...e };
    this.entries.push(entry);
    return entry;
  }

  private view(m: Message): MessageView {
    return { ...m, payload: clone(m.payload) };
  }
}

export function newExperiment(config: ExperimentConfig, strategy: Strategy): Experiment {
  return new Experiment(config, new StrategyChooser(strategy));
}

/** Re-run a recording with ReplayChooser; any choice outside the record throws (ADR D11). */
export function replayExperiment(rec: Recording): Experiment {
  const exp = new Experiment(rec.config, new ReplayChooser(rec.choices));
  for (const ev of rec.script) exp.schedule(ev);
  return exp;
}

export interface BranchEdits {
  /** Drop base events after the branch tick (events at or before it cannot change). */
  readonly remove?: (ev: ScriptEvent) => boolean;
  readonly add?: readonly ScriptEvent[];
}

/**
 * branch(base, atTick, edits): replay the base to the end of `atTick`, verify the prefix is identical,
 * then continue with the edited script and fresh choices from `strategy` (ADR D11). The base is not touched.
 */
export function branchExperiment(base: Experiment, atTick: number, edits: BranchEdits, strategy: Strategy): Experiment {
  const rec = base.recording();
  if (atTick > rec.endTick) throw new Error(`branch tick ${atTick} is after the base end ${rec.endTick}`);
  for (const ev of edits.add ?? []) if (ev.tick <= atTick) throw new Error('edits may only change events after the branch tick');
  const script = [...rec.script.filter((e) => e.tick <= atTick || !(edits.remove?.(e) ?? false)), ...(edits.add ?? [])];
  const exp = new Experiment(rec.config, new BranchChooser(rec.choices.filter((c) => c.tick <= atTick), atTick, strategy));
  for (const ev of script) exp.schedule(ev);
  exp.advanceTo(atTick);
  const basePrefix = base.log().filter((e) => e.tick <= atTick);
  if (exp.replayRemaining() !== 0 || canonicalJson(exp.log()) !== canonicalJson(basePrefix)) {
    throw new Error(`branch prefix differs from base at tick ${atTick}`);
  }
  return exp;
}
