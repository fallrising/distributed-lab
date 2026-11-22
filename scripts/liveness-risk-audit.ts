// T-0458: bounded evidence, not a proof of reachability or a replacement for AC-QLT-02.
// Formal search: 2*512 initial + 4*767 mutations <=4092 candidate simulations;
// four further 80-tick replays are reserved, two for this tool and two for independent review.
// Inputs use only public partition/heal events at distinct prefix ticks; the original
// invoke, stable-window events, read, deadlines, and result strings come from pinned data.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson } from '../src/canonical.ts';
import { SplitMix64 } from '../src/rng.ts';
import { parseScenarios, type Scenarios } from '../src/scenarios/data.ts';
import { clusterConfig, livenessWindow } from '../src/scenarios/drivers.ts';
import { judgeLiveness } from '../src/scenarios/liveness.ts';
import { checkHistory, historyToCheckOps } from '../src/checker/linearizability.ts';
import { newExperiment, replayExperiment, type Experiment, type Recording } from '../src/sim/experiment.ts';
import type { NodeStatus, StableStorage } from '../src/sim/node.ts';
import {
  FORMAL_PLAN, SimulationBudget, candidateSignature, compareRanks, exactStaleBackoff, h1Configuration, h2Configuration, h2NonStrictConfiguration,
  initialPrefix, mutatePrefix, rankEvidence, setPartitions, validatePlan, validatePrefix,
  type AuditPlan, type Candidate, type Freshness, type StateEvidence, type Target,
} from './liveness-risk-search.ts';

const digest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
export function logFreshness(stable: StableStorage): Freshness {
  const last = stable.log.at(-1);
  return { term: last?.term ?? stable.snapshot?.lastIncludedTerm ?? stable.logBaseTerm, index: stable.logStartIndex + stable.log.length - 1 };
}
export interface BackoffEvidence {
  readonly tick: number;
  readonly messageId: string;
  readonly voter: string;
  readonly replyTerm: number;
  readonly beforeRole: string;
  readonly beforeTerm: number;
  readonly afterRole: string;
  readonly afterTerm: number;
  readonly requestedFreshness: Freshness | null;
  readonly candidateFreshness: Freshness;
  readonly exact: boolean;
}
export interface CandidateSummary {
  readonly candidate: Candidate;
  readonly signature: string;
  readonly states: Readonly<Record<string, StateEvidence>>;
  readonly configurationTick: number;
  readonly configurations: Readonly<Record<string, { readonly H1: boolean; readonly H2Strict: boolean; readonly H2NonStrict: boolean }>>;
  readonly h2BackoffTicks: readonly number[];
  readonly h1Hit: boolean;
  readonly h2Configuration: boolean;
  readonly h2NonStrictConfiguration: boolean;
  readonly h2Hit: boolean;
  readonly h2NearMatch: boolean;
  readonly staleRefusals: readonly BackoffEvidence[];
  readonly ranks: Readonly<Record<Target, readonly number[]>>;
  readonly writeComplete: number | null;
  readonly readComplete: number | null;
  readonly judgement: ReturnType<typeof judgeLiveness>;
  readonly safety: ReturnType<typeof checkHistory>['type'];
  readonly inputErrors: readonly string[];
  readonly failures: readonly string[];
  readonly inconclusive: readonly string[];
  readonly recordingDigest: string;
  readonly observationDigest: string;
  readonly stableDigest: string;
}
export interface EvaluatedCandidate { readonly summary: CandidateSummary; readonly recording: Recording }

function stateEvidence(exp: Experiment, data: Scenarios): StateEvidence {
  const pending = data.liveness_case.fault_prefix.pending_write;
  const op = exp.history().find((item) => item.client === pending.client && item.requestId === pending.request);
  return {
    tick: exp.now,
    freshness: Object.fromEntries(data.cluster.members.map((member) => [member, logFreshness(exp.nodeStable(member))])),
    bContainsPendingWrite: exp.nodeStable('B').log.some((entry) => entry.command.clientId === pending.client && entry.command.requestId === pending.request),
    pendingWriteUncompleted: op?.outcome.status === '未完成',
  };
}

function findRequestFreshness(exp: Experiment, replyId: string): Freshness | null {
  const reply = exp.messageById(replyId);
  if (!reply || reply.payload.type !== 'RequestVoteReply') return null;
  // A reply is produced while handling RequestVote at sentAt. A lower-term request that
  // received a higher-term reply is deliberately excluded from exact stale-backoff evidence.
  for (const entry of exp.log()) {
    if (entry.tick !== reply.sentAt || entry.action !== 'deliver') continue;
    const request = exp.messageById(entry.target);
    if (request?.to !== reply.from || request.from !== 'C' || request.payload.type !== 'RequestVote') continue;
    const payload = request.payload;
    if (payload.candidateId === 'C' && payload.term === reply.payload.term) return { term: payload.lastLogTerm, index: payload.lastLogIndex };
  }
  return null;
}

/** Exactly one full original-window simulation. It only calls public Experiment APIs. */
export function evaluateCandidate(data: Scenarios, candidate: Candidate, budget: SimulationBudget): EvaluatedCandidate {
  validatePrefix(candidate.prefix, data.cluster.members, data.liveness_case.fault_prefix.through_tick);
  if (![2, 6].includes(candidate.prefixBound)) throw new Error('only predeclared prefix bounds 2/6 are permitted');
  const c = data.liveness_case;
  const w = c.stable_window;
  if (!w.client_reachable_members.includes(candidate.readVia)) throw new Error('read gateway must be an original reachable member');
  budget.consume('search');
  const exp = newExperiment(clusterConfig(data, {
    deliveryBound: w.delivery_bound_ticks,
    deliveryBounds: [{ fromTick: c.fault_prefix.start_tick, bound: candidate.prefixBound }, { fromTick: w.starts_at_tick, bound: w.delivery_bound_ticks }],
    retryIfUnavailable: c.retry_original_if_unavailable,
  }), { type: 'seed', seed: candidate.strategySeed });
  for (const event of candidate.prefix) exp.schedule(event.type === 'heal'
    ? { ...event, clientReachable: [...data.cluster.members] }
    : { ...event, groups: event.groups.map((group) => [...group]), clientReachable: [...data.cluster.members] });
  const pending = c.fault_prefix.pending_write;
  exp.schedule({ tick: pending.invoke, type: 'invoke', client: pending.client, requestId: pending.request, action: pending.action as 'write', key: pending.key, value: pending.value!, via: w.client_reachable_members[0]! });
  exp.schedule({ tick: w.starts_at_tick, type: 'heal', clientReachable: w.client_reachable_members });
  for (const member of w.other_members) exp.schedule({ tick: w.starts_at_tick, type: 'crash', node: member });
  const read = w.fresh_read;
  exp.schedule({ tick: read.invoke, type: 'invoke', client: read.client, requestId: read.request, action: read.action as 'read', key: read.key, via: candidate.readVia });
  const states: Record<string, StateEvidence> = {};
  const refusals: BackoffEvidence[] = [];
  let consumedEntries = 0;
  const observationTicks = new Set([c.fault_prefix.through_tick, w.starts_at_tick, w.starts_at_tick + 5]);
  while (exp.now < w.ends_at_tick) {
    // At the start of each tick C's role/term and log are actual public observations.
    // Delivery is before timers. Replaying each C delivery's post-state reconstructs its
    // role/term before the next delivery; no tick-end log is labelled an instantaneous log.
    let cBefore: NodeStatus = exp.nodeStatus('C');
    const cFreshness = logFreshness(exp.nodeStable('C'));
    exp.advance(1);
    for (const entry of exp.log().slice(consumedEntries)) {
      if (entry.action !== 'deliver' || !entry.nodeStatus) continue;
      const message = exp.messageById(entry.target);
      if (!message || message.to !== 'C') continue;
      const payload = message.payload;
      if (exp.now <= w.starts_at_tick + 5 && payload.type === 'RequestVoteReply' && ['D', 'E'].includes(message.from) && !payload.voteGranted && !payload.logOk) {
        const requested = findRequestFreshness(exp, message.id);
        const evidence: BackoffEvidence = {
          tick: exp.now, messageId: message.id, voter: message.from, replyTerm: payload.term,
          beforeRole: cBefore.role, beforeTerm: cBefore.term, afterRole: entry.nodeStatus.role, afterTerm: entry.nodeStatus.term,
          candidateFreshness: cFreshness, requestedFreshness: requested,
          exact: exactStaleBackoff({ beforeRole: cBefore.role, beforeTerm: cBefore.term, afterRole: entry.nodeStatus.role, afterTerm: entry.nodeStatus.term, replyTerm: payload.term, voteGranted: payload.voteGranted, logOk: payload.logOk, voter: message.from, candidateFreshness: cFreshness, requestedFreshness: requested }),
        };
        refusals.push(evidence);
      }
      cBefore = entry.nodeStatus;
    }
    consumedEntries = exp.log().length;
    if (observationTicks.has(exp.now)) states[String(exp.now)] = stateEvidence(exp, data);
  }
  const at19 = states[String(c.fault_prefix.through_tick)]!;
  const h1Hit = h1Configuration(at19);
  const h2Config = h2Configuration(at19);
  const h2NonStrict = h2NonStrictConfiguration(at19);
  const exactBackoffs = refusals.filter((refusal) => refusal.exact).length;
  const rankInput = { h1Hit, h2Hit: h2Config && exactBackoffs > 0, h2Configuration: h2Config, exactBackoffs, refusals: refusals.length, at19 };
  const judgement = judgeLiveness(exp, livenessWindow(data));
  const safety = checkHistory(historyToCheckOps(exp.history()), data.cluster.initial_values, { maxStates: 100_000 }).type;
  const writeOp = exp.history().find((op) => op.client === pending.client && op.requestId === pending.request);
  const readOp = exp.history().find((op) => op.client === read.client && op.requestId === read.request);
  const inputErrors: string[] = [];
  if (writeOp?.invoke !== pending.invoke) inputErrors.push('pending write invocation differs from pinned data');
  if (readOp?.invoke !== read.invoke || readOp?.attempts[0]?.via !== candidate.readVia) inputErrors.push('fresh read invocation/gateway differs from declared input');
  if (exp.history().length !== 2) inputErrors.push('unexpected logical operations');
  const failures = [...judgement.violations];
  if (writeOp?.outcome.status === '已完成' && writeOp.outcome.result !== data.cluster.successful_write_result) failures.push('pending write returned a wrong result');
  if (readOp?.outcome.status === '已完成' && readOp.outcome.result !== read.expected) failures.push('fresh read returned a wrong value');
  if (safety === '非法') failures.push('confirmed logical history violates linearizability');
  const inconclusive: string[] = [];
  if (!judgement.required) inconclusive.push(`stable-window preconditions were not met: ${judgement.missing.join('; ')}`);
  if (safety !== '合法' && safety !== '非法') inconclusive.push(`safety checker returned ${safety}`);
  const recording = exp.recording();
  return { recording, summary: {
    candidate, signature: candidateSignature(candidate), states, configurationTick: c.fault_prefix.through_tick,
    configurations: Object.fromEntries(Object.entries(states).map(([tick, state]) => [tick, { H1: h1Configuration(state), H2Strict: h2Configuration(state), H2NonStrict: h2NonStrictConfiguration(state) }])),
    h2BackoffTicks: refusals.filter((refusal) => refusal.exact).map((refusal) => refusal.tick),
    h1Hit, h2Configuration: h2Config, h2NonStrictConfiguration: h2NonStrict,
    h2Hit: rankInput.h2Hit, h2NearMatch: !rankInput.h2Hit && (h2NonStrict || exactBackoffs > 0), staleRefusals: refusals,
    ranks: { H1: rankEvidence(rankInput, 'H1'), H2: rankEvidence(rankInput, 'H2') },
    writeComplete: writeOp?.outcome.status === '已完成' ? writeOp.outcome.complete : null,
    readComplete: readOp?.outcome.status === '已完成' ? readOp.outcome.complete : null,
    judgement, safety, inputErrors, failures, inconclusive,
    recordingDigest: digest(recording), observationDigest: digest(exp.observation()), stableDigest: digest(data.cluster.members.map((member) => exp.nodeStable(member))),
  } };
}

export interface ReplayResult { readonly signature: string; readonly success: boolean; readonly remainingChoices: number; readonly recordingDigest: string }
export function replayEvidence(data: Scenarios, evidence: EvaluatedCandidate, budget: SimulationBudget): ReplayResult {
  budget.consume('replay');
  const exp = replayExperiment(evidence.recording).advanceTo(evidence.recording.endTick);
  const remaining = exp.replayRemaining();
  return { signature: evidence.summary.signature, success: remaining === 0 && digest(exp.observation()) === evidence.summary.observationDigest && digest(data.cluster.members.map((member) => exp.nodeStable(member))) === evidence.summary.stableDigest && digest(exp.recording()) === evidence.summary.recordingDigest, remainingChoices: remaining, recordingDigest: digest(exp.recording()) };
}

export interface AuditResult {
  readonly plan: AuditPlan;
  readonly candidateEvaluations: number;
  readonly replayEvaluations: number;
  readonly completeSimulations: number;
  readonly remainingReplayAllowance: number;
  readonly duplicateSkips: number;
  readonly generated: Readonly<Record<string, number>>;
  readonly evaluated: Readonly<Record<string, number>>;
  readonly readViaCoverage: Readonly<Record<string, number>>;
  readonly partitionCoverage: Readonly<Record<string, number>>;
  readonly hits: { readonly H1: number; readonly H1UncompletedWrite: number; readonly H2Configuration: number; readonly H2NonStrictConfiguration: number; readonly H2ExactBackoff: number; readonly H2Combined: number; readonly H2NearMatch: number };
  readonly worstWrite: number | null;
  readonly worstRead: number | null;
  readonly stoppedBecause: 'exhausted finite plan' | 'first product failure' | 'inconclusive or invalid input' | 'replay mismatch';
  readonly firstFailure: CandidateSummary | null;
  readonly summaries: readonly CandidateSummary[];
  readonly representatives: readonly { readonly labels: readonly string[]; readonly evidence: EvaluatedCandidate }[];
  readonly replays: readonly ReplayResult[];
}

export function runAudit(data: Scenarios, options: { readonly plan?: AuditPlan; readonly replayLimit?: number } = {}): AuditResult {
  const plan = options.plan ?? FORMAL_PLAN;
  validatePlan(plan);
  const replayLimit = options.replayLimit ?? Math.min(2, plan.maxReplays);
  if (!Number.isInteger(replayLimit) || replayLimit < 0 || replayLimit > Math.min(2, plan.maxReplays)) throw new Error('tool replays cannot use independent reviewers\' reserved slots');
  const budget = new SimulationBudget(plan);
  const seen = new Set<string>();
  const summaries: CandidateSummary[] = [];
  const initialByBound = new Map<number, CandidateSummary[]>();
  const representatives = new Map<string, EvaluatedCandidate>();
  const generated: Record<string, number> = {};
  const evaluated: Record<string, number> = {};
  const readViaCoverage: Record<string, number> = {};
  const partitionsByBound = new Map<number, Set<string>>();
  let duplicateSkips = 0;
  let firstFailure: CandidateSummary | null = null;
  let stoppedBecause: AuditResult['stoppedBecause'] = 'exhausted finite plan';
  const gateways = data.liveness_case.stable_window.client_reachable_members;
  const through = data.liveness_case.fault_prefix.through_tick;
  let worstWrite: number | null = null;
  let worstRead: number | null = null;
  const hits = { H1: 0, H1UncompletedWrite: 0, H2Configuration: 0, H2NonStrictConfiguration: 0, H2ExactBackoff: 0, H2Combined: 0, H2NearMatch: 0 };
  function visit(prefix: Candidate['prefix'], bound: number, cell: string, ordinal: number, parent?: Candidate): CandidateSummary | null {
    generated[cell] = (generated[cell] ?? 0) + 1;
    const n = budget.search;
    // Directed mutations retain the parent's network seed and gateway: exactly one
    // external event changes. Initial population seed/gateway diversity is declared here.
    const candidate: Candidate = { id: `${cell}/${ordinal}`, prefixBound: bound, prefix, strategySeed: parent?.strategySeed ?? plan.auditSeed + (n + 1) * 7919 + bound * 101, readVia: parent?.readVia ?? gateways[n % gateways.length]! };
    const signature = candidateSignature(candidate);
    if (seen.has(signature)) { duplicateSkips++; return null; }
    seen.add(signature);
    const evidence = evaluateCandidate(data, candidate, budget);
    const summary = evidence.summary;
    summaries.push(summary);
    evaluated[cell] = (evaluated[cell] ?? 0) + 1;
    readViaCoverage[candidate.readVia] = (readViaCoverage[candidate.readVia] ?? 0) + 1;
    const coverage = partitionsByBound.get(bound) ?? new Set<string>();
    for (const event of prefix) if (event.type === 'partition') coverage.add(canonicalJson(event.groups));
    partitionsByBound.set(bound, coverage);
    if (summary.h1Hit) { hits.H1++; if (!representatives.has('H1')) representatives.set('H1', evidence); }
    if (summary.h1Hit && summary.states[String(through)]!.pendingWriteUncompleted) hits.H1UncompletedWrite++;
    if (summary.h2Configuration) hits.H2Configuration++;
    if (summary.h2NonStrictConfiguration) hits.H2NonStrictConfiguration++;
    if (summary.staleRefusals.some((refusal) => refusal.exact)) hits.H2ExactBackoff++;
    if (summary.h2Hit) { hits.H2Combined++; if (!representatives.has('H2')) representatives.set('H2', evidence); }
    if (summary.h2NearMatch) hits.H2NearMatch++;
    if (!representatives.has('H1-best') || compareRanks(summary.ranks.H1, representatives.get('H1-best')!.summary.ranks.H1) > 0) representatives.set('H1-best', evidence);
    if (!representatives.has('H2-best') || compareRanks(summary.ranks.H2, representatives.get('H2-best')!.summary.ranks.H2) > 0) representatives.set('H2-best', evidence);
    if (summary.writeComplete !== null && (worstWrite === null || summary.writeComplete > worstWrite)) { worstWrite = summary.writeComplete; representatives.set('worst-write', evidence); }
    if (summary.readComplete !== null && (worstRead === null || summary.readComplete > worstRead)) { worstRead = summary.readComplete; representatives.set('worst-read', evidence); }
    if (summary.inputErrors.length > 0 || summary.inconclusive.length > 0) { firstFailure = summary; representatives.set('first-failure', evidence); stoppedBecause = 'inconclusive or invalid input'; }
    else if (summary.failures.length > 0) { firstFailure = summary; representatives.set('first-failure', evidence); stoppedBecause = 'first product failure'; }
    return summary;
  }
  for (const bound of [2, 6]) {
    const population: CandidateSummary[] = [];
    initialByBound.set(bound, population);
    for (let i = 0; i < plan.initialPerBound && firstFailure === null; i++) {
      const result = visit(initialPrefix(data.cluster.members, through, plan.auditSeed, bound, i), bound, `initial-${bound}`, i);
      if (result) population.push(result);
    }
    if (firstFailure) break;
  }
  for (const target of ['H1', 'H2'] as const) {
    for (const bound of [2, 6]) {
      if (firstFailure) break;
      const order = (a: CandidateSummary, b: CandidateSummary) => compareRanks(b.ranks[target], a.ranks[target]) || (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0);
      let beam = [...initialByBound.get(bound)!].sort(order).slice(0, plan.beamWidth);
      const rng = new SplitMix64(plan.auditSeed + bound * 1_000_003 + (target === 'H1' ? 17 : 37));
      for (let i = 0; i < plan.mutationsPerCell && firstFailure === null; i++) {
        const parent = beam[i % beam.length]!;
        const prefix = mutatePrefix(parent.candidate.prefix, data.cluster.members, through, rng);
        const child = visit(prefix, bound, `${target}-${bound}`, i, parent.candidate);
        if (child) beam = [...beam, child].sort(order).slice(0, plan.beamWidth);
      }
    }
    if (firstFailure) break;
  }
  const selected = new Map<string, { labels: string[]; evidence: EvaluatedCandidate }>();
  for (const label of ['first-failure', 'H1', 'H2', 'worst-write', 'worst-read', 'H1-best', 'H2-best']) {
    const evidence = representatives.get(label);
    if (!evidence) continue;
    const existing = selected.get(evidence.summary.signature);
    if (existing) existing.labels.push(label);
    else if (selected.size < plan.maxReplays) selected.set(evidence.summary.signature, { labels: [label], evidence });
  }
  const replays: ReplayResult[] = [];
  for (const representative of [...selected.values()].slice(0, replayLimit)) {
    const replay = replayEvidence(data, representative.evidence, budget);
    replays.push(replay);
    if (!replay.success) { stoppedBecause = 'replay mismatch'; break; }
  }
  return {
    plan, candidateEvaluations: budget.search, replayEvaluations: budget.replays, completeSimulations: budget.total,
    remainingReplayAllowance: plan.maxReplays - budget.replays, duplicateSkips, generated, evaluated, readViaCoverage,
    partitionCoverage: Object.fromEntries([2, 6].map((bound) => [String(bound), partitionsByBound.get(bound)?.size ?? 0])),
    hits, worstWrite, worstRead, stoppedBecause, firstFailure, summaries,
    representatives: [...selected.values()], replays,
  };
}

export function writeAudit(result: AuditResult, directory: string): void {
  mkdirSync(directory, { recursive: true });
  const { representatives, summaries, ...report } = result;
  writeFileSync(join(directory, 'summary.json'), JSON.stringify({ ...report, partitionUniverse: setPartitions(['A', 'B', 'C', 'D', 'E']).length,
    rankDefinitions: { H1: ['fullHit', 'B newer than A/C count', 'B contains pending write', 'write still uncompleted', 'B last-log term', 'B last-log index'], H2: ['combinedHit', 'tick19 hierarchy', 'exact backoff count', 'C newer than A/B count', 'D/E newer than C count', 'stale refusal count', 'C last-log term', 'C last-log index'] },
    limitations: ['Finite external-input search only; absence of hits is not an unreachability proof.', 'H1 requires B strictly newer than A/C and containing the original write; client completion is a separate diagnostic.', 'H2 full configuration uses strict C>A/B and some D/E>C at tick19; C ties are reported only as non-strict near-matches.', 'H2 hierarchy is observed at tick19; a separately identified exact backoff must be in the same candidate, not necessarily the same instant.', 'No internal-state injection, changed deadlines, skipped operations, or modified data.', 'At most two tool replays; the remaining replay allowance is reserved for independent review.'],
  }, null, 2) + '\n');
  writeFileSync(join(directory, 'candidates.json'), JSON.stringify(summaries, null, 2) + '\n');
  for (const representative of representatives) {
    const key = digest(representative.evidence.summary.signature).slice(0, 16);
    writeFileSync(join(directory, `${key}-input.json`), JSON.stringify({ labels: representative.labels, summary: representative.evidence.summary, recordingDigest: representative.evidence.summary.recordingDigest, config: representative.evidence.recording.config, script: representative.evidence.recording.script, recordingFile: `${key}-recording.json` }, null, 2) + '\n');
    writeFileSync(join(directory, `${key}-recording.json`), JSON.stringify(representative.evidence.recording) + '\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (!args.includes('--full') && !args.includes('--smoke')) throw new Error('choose --full only after method review, or --smoke for bounded tool validation');
  if (args.includes('--full') && args.includes('--smoke')) throw new Error('choose one audit mode');
  const out = args.find((arg) => arg.startsWith('--out='))?.slice('--out='.length);
  if (!out) throw new Error('an explicit --out=/tmp/... directory is required');
  const replayArgument = args.find((arg) => arg.startsWith('--replays='));
  const replayLimit = replayArgument ? Number(replayArgument.slice('--replays='.length)) : undefined;
  const plan = args.includes('--full') ? FORMAL_PLAN : { ...FORMAL_PLAN, initialPerBound: 1, mutationsPerCell: 0, maxReplays: 1, maxSimulations: 3 };
  const data = parseScenarios(readFileSync('data/scenarios.yaml', 'utf8'));
  const result = runAudit(data, { plan, replayLimit });
  writeAudit(result, resolve(out));
  const { summaries: _summaries, representatives: _representatives, ...brief } = result;
  process.stdout.write(JSON.stringify(brief, null, 2) + '\n');
  if (result.stoppedBecause !== 'exhausted finite plan') process.exitCode = 1;
}
