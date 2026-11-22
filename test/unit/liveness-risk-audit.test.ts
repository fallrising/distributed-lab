import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../helpers/data.ts';
import { SplitMix64 } from '../../src/rng.ts';
import { canonicalJson } from '../../src/canonical.ts';
import { runAudit } from '../../scripts/liveness-risk-audit.ts';
import {
  FORMAL_PLAN, SimulationBudget, candidateSignature, compareFreshness, compareRanks,
  exactStaleBackoff, h1Configuration, h2Configuration, h2NonStrictConfiguration,
  initialPrefix, mutatePrefix, rankEvidence, setPartitions, validatePlan, validatePrefix,
  type BackoffInput, type Candidate, type StateEvidence,
} from '../../scripts/liveness-risk-search.ts';

test('liveness risk audit: canonical five-member partition universe is exactly 52, including 1–5 groups', () => {
  const members = scenarios().cluster.members;
  const partitions = setPartitions(members);
  assert.equal(partitions.length, 52);
  assert.equal(new Set(partitions.map(canonicalJson)).size, 52);
  assert.deepEqual([...new Set(partitions.map((partition) => partition.length))].sort(), [1, 2, 3, 4, 5]);
  for (const groups of partitions) {
    assert.deepEqual(groups.flat().sort(), [...members].sort());
    assert.equal(new Set(groups.flat()).size, members.length);
  }
});

test('liveness risk audit: initial prefixes reproduce and cover all partitions under each declared bound', () => {
  const data = scenarios();
  const members = data.cluster.members;
  const through = data.liveness_case.fault_prefix.through_tick;
  for (const bound of [2, 6]) {
    const covered = new Set<string>();
    for (let ordinal = 0; ordinal < FORMAL_PLAN.initialPerBound; ordinal++) {
      const prefix = initialPrefix(members, through, FORMAL_PLAN.auditSeed, bound, ordinal);
      assert.ok(prefix.length >= 4 && prefix.length <= 8);
      validatePrefix(prefix, members, through);
      assert.equal(canonicalJson(prefix), canonicalJson(initialPrefix(members, through, FORMAL_PLAN.auditSeed, bound, ordinal)));
      assert.equal(prefix[0]!.type, 'partition');
      if (prefix[0]!.type === 'partition') covered.add(canonicalJson(prefix[0]!.groups));
    }
    assert.equal(covered.size, 52, `initial bound ${bound} covers the complete partition universe`);
  }
});

test('liveness risk audit: mutations change only one external event and complete-input signatures include delivery seed and gateway', () => {
  const data = scenarios();
  const through = data.liveness_case.fault_prefix.through_tick;
  const prefix = initialPrefix(data.cluster.members, through, FORMAL_PLAN.auditSeed, 2, 7);
  const rng = new SplitMix64(FORMAL_PLAN.auditSeed);
  const again = new SplitMix64(FORMAL_PLAN.auditSeed);
  for (let i = 0; i < 100; i++) {
    const mutated = mutatePrefix(prefix, data.cluster.members, through, rng);
    assert.equal(canonicalJson(mutated), canonicalJson(mutatePrefix(prefix, data.cluster.members, through, again)));
    validatePrefix(mutated, data.cluster.members, through);
    const removed = prefix.filter((event) => !mutated.some((next) => canonicalJson(next) === canonicalJson(event)));
    const added = mutated.filter((event) => !prefix.some((old) => canonicalJson(old) === canonicalJson(event)));
    assert.ok(removed.length <= 1 && added.length <= 1 && removed.length + added.length > 0, 'one tick/group edit, insert, or delete');
  }
  const input: Candidate = { id: 'unit', prefixBound: 2, prefix, strategySeed: 7, readVia: 'A' };
  assert.notEqual(candidateSignature(input), candidateSignature({ ...input, strategySeed: 8 }));
  assert.notEqual(candidateSignature(input), candidateSignature({ ...input, readVia: 'B' }));
  assert.notEqual(candidateSignature(input), candidateSignature({ ...input, prefixBound: 6 }));
  const relabelled: Candidate = { ...input, id: 'different-label-same-experiment' };
  assert.equal(candidateSignature(input), candidateSignature(relabelled));
});

test('liveness risk audit: freshness/ranks distinguish strict hypotheses, pending-write diagnostics, and H2 ties', () => {
  assert.ok(compareFreshness({ term: 2, index: 1 }, { term: 1, index: 100 }) > 0, 'last log term precedes length');
  assert.ok(compareFreshness({ term: 2, index: 3 }, { term: 2, index: 4 }) < 0);
  const h1: StateEvidence = { tick: 19, freshness: { A: { term: 1, index: 1 }, B: { term: 2, index: 1 }, C: { term: 1, index: 5 }, D: { term: 0, index: 0 }, E: { term: 0, index: 0 } }, bContainsPendingWrite: true, pendingWriteUncompleted: false };
  assert.equal(h1Configuration(h1), true, 'client completion does not remove the original B-newest risk');
  assert.equal(h1Configuration({ ...h1, bContainsPendingWrite: false }), false);
  const hierarchy: StateEvidence = { ...h1, freshness: { ...h1.freshness, A: { term: 0, index: 0 }, B: { term: 0, index: 0 }, C: { term: 1, index: 1 }, D: { term: 2, index: 1 } } };
  assert.equal(h2Configuration(hierarchy), true);
  const tie = { ...hierarchy, freshness: { ...hierarchy.freshness, A: { term: 1, index: 1 } } };
  assert.equal(h2Configuration(tie), false, 'ties never count as the strict three-level full configuration');
  assert.equal(h2NonStrictConfiguration(tie), true, 'ties remain visible as near-match configuration');
  const base = { h1Hit: false, h2Hit: false, h2Configuration: false, exactBackoffs: 0, refusals: 0, at19: hierarchy };
  assert.ok(compareRanks(rankEvidence({ ...base, h2Hit: true, h2Configuration: true, exactBackoffs: 1 }, 'H2'), rankEvidence(base, 'H2')) > 0);
  assert.ok(compareRanks(rankEvidence({ ...base, h1Hit: true, at19: h1 }, 'H1'), rankEvidence(base, 'H1')) > 0);
});

test('liveness risk audit: exact backoff requires a same-term candidate transition and matching causal RequestVote freshness', () => {
  // Synthetic classifier inputs are unit fixtures, never claimed as reachable product configurations.
  const exact: BackoffInput = { beforeRole: 'candidate', beforeTerm: 7, afterRole: 'follower', afterTerm: 7, replyTerm: 7, voteGranted: false, logOk: false, voter: 'D', candidateFreshness: { term: 3, index: 2 }, requestedFreshness: { term: 3, index: 2 } };
  assert.equal(exactStaleBackoff(exact), true);
  for (const changed of [
    { beforeRole: 'follower' }, { replyTerm: 8, afterTerm: 8 }, { replyTerm: 6 },
    { afterRole: 'candidate' }, { voter: 'B' }, { logOk: true }, { voteGranted: true },
    { requestedFreshness: null }, { requestedFreshness: { term: 2, index: 2 } },
  ]) assert.equal(exactStaleBackoff({ ...exact, ...changed }), false, JSON.stringify(changed));
});

test('liveness risk audit: complete-simulation budget preserves replay slots and rejects expanded plans', () => {
  validatePlan(FORMAL_PLAN);
  assert.equal(2 * FORMAL_PLAN.initialPerBound + 4 * FORMAL_PLAN.mutationsPerCell + FORMAL_PLAN.maxReplays, 4096);
  assert.throws(() => validatePlan({ ...FORMAL_PLAN, mutationsPerCell: 768 }), /budget/);
  const budget = new SimulationBudget({ ...FORMAL_PLAN, initialPerBound: 1, mutationsPerCell: 0, maxReplays: 1, maxSimulations: 3 });
  budget.consume('search'); budget.consume('search');
  assert.throws(() => budget.consume('search'), /reservation/);
  budget.consume('replay');
  assert.equal(budget.total, 3);
  assert.throws(() => budget.consume('replay'), /exhausted/);
});

test('liveness risk audit: bounded tool smoke executes two original-window candidates and one exact replay', () => {
  const plan = { ...FORMAL_PLAN, initialPerBound: 1, mutationsPerCell: 0, maxReplays: 1, maxSimulations: 3 };
  const result = runAudit(scenarios(), { plan, replayLimit: 1 });
  assert.equal(result.stoppedBecause, 'exhausted finite plan');
  assert.equal(result.candidateEvaluations, 2);
  assert.equal(result.replayEvaluations, 1);
  assert.equal(result.completeSimulations, 3);
  assert.equal(result.remainingReplayAllowance, 0);
  assert.equal(result.firstFailure, null);
  assert.equal(result.replays[0]!.success, true);
  assert.equal(result.replays[0]!.remainingChoices, 0);
  assert.deepEqual(result.summaries.map((summary) => summary.candidate.prefixBound), [2, 6]);
  for (const summary of result.summaries) {
    assert.equal(summary.judgement.required, true);
    assert.equal(summary.safety, '合法');
    assert.equal(summary.states['19']!.tick, 19);
    assert.equal(summary.states['20']!.tick, 20);
    assert.equal(summary.states['25']!.tick, 25);
    assert.deepEqual(summary.inputErrors, []);
    assert.deepEqual(summary.failures, []);
  }
});
