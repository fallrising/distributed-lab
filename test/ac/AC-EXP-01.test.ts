import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../helpers/data.ts';
import { faultTraceExperiment } from '../../src/scenarios/drivers.ts';
import { canonicalJson } from '../../src/canonical.ts';
import type { Experiment, LogEntry } from '../../src/sim/experiment.ts';

const externalAt = (exp: Experiment, tick: number, action: string): LogEntry => {
  const e = exp.log().find((x) => x.kind === 'external' && x.tick === tick && x.action === action);
  assert.ok(e, `external ${action} logged at ${tick}`);
  return e;
};
const effectsOf = (exp: Experiment, cause: LogEntry) => exp.log().filter((x) => x.kind === 'effect' && x.causeSeq === cause.seq);

test('AC-EXP-01 組合故障的控制與日誌符合明確語義（fault_trace，手動傳遞）', () => {
  const data = scenarios();
  const trace = data.fault_trace;
  const exp = faultTraceExperiment(data);

  // message_binding: every alias is bound once, to a distinct message with the specified direction.
  const ids = trace.initial_pending_messages.map((m) => exp.resolve(m.id));
  assert.equal(new Set(ids).size, ids.length);
  for (const m of trace.initial_pending_messages) {
    const msg = exp.pending().find((p) => p.id === exp.resolve(m.id));
    assert.ok(msg);
    assert.equal(msg.from, m.from);
    assert.equal(msg.to, m.to);
    if (msg.diagnostic) {
      // A diagnostic stand-in is marked as such in the log.
      assert.ok(exp.log().some((e) => e.action === 'bind-alias' && e.target === msg.id && e.messageRelation?.diagnostic === true));
    }
  }
  const content = new Map(exp.pending().map((p) => [p.id, canonicalJson(p.payload)]));
  const [mOne, mTwo, mThree] = ids as [string, string, string];

  // Pause: advancing is refused and reading the log does not move time.
  exp.pause();
  const before = { now: exp.now, len: exp.log().length };
  assert.throws(() => exp.advance(1), /paused/);
  exp.log();
  exp.pending();
  assert.deepEqual({ now: exp.now, len: exp.log().length }, before);
  exp.resume();

  const lastEvent = Math.max(...trace.events.map((e) => e.tick));
  const deliveredTicks = new Map<string, number>();
  for (let t = 1; t <= lastEvent; t++) {
    const pendingBefore = new Set(exp.pending().map((p) => p.id));
    const stableB = exp.nodeStable('B');
    exp.advance(1);
    for (const e of exp.log().filter((x) => x.tick === t && x.action === 'deliver')) deliveredTicks.set(e.target, t);

    for (const ev of trace.events.filter((e) => e.tick === t)) {
      const ext = externalAt(exp, t, ev.action);
      const effects = effectsOf(exp, ext);
      switch (ev.action) {
        case 'delay': {
          assert.equal(ext.target, mOne);
          const p = exp.pending().find((x) => x.id === mOne);
          assert.ok(p, 'delayed message stays pending (manual mode)');
          assert.equal(p.earliestAt, ev.deliver_at);
          assert.equal(canonicalJson(p.payload), content.get(mOne), 'delay does not change content');
          break;
        }
        case 'duplicate': {
          const copyId = exp.resolve(ev.copy_id as string);
          const copy = exp.pending().find((x) => x.id === copyId);
          assert.ok(copy);
          assert.equal(copy.originId, mTwo);
          assert.equal(canonicalJson(copy.payload), content.get(mTwo), 'copy keeps the content');
          assert.equal(effects.length, ev.copies_added);
          assert.equal(effects[0]!.messageRelation?.originId, mTwo);
          break;
        }
        case 'deliver': {
          const id = exp.resolve(ev.target as string);
          assert.equal(ext.target, id);
          assert.equal(effects.length, 1);
          assert.equal(effects[0]!.action, 'deliver');
          assert.equal(effects[0]!.target, id);
          assert.equal(effects[0]!.outcome, '已傳遞');
          assert.ok(!exp.pending().some((x) => x.id === id));
          if (ev.target === 'm-two-copy') assert.equal(effects[0]!.messageRelation?.originId, mTwo);
          break;
        }
        case 'drop': {
          assert.equal(ext.target, mThree);
          assert.equal(effects.length, 1);
          assert.equal(effects[0]!.action, 'drop');
          assert.ok(!exp.pending().some((x) => x.id === mThree));
          break;
        }
        case 'partition': {
          const groups = ev.groups as string[][];
          const side = (n: string) => groups.findIndex((g) => g.includes(n));
          const crossing = [...pendingBefore].filter((id) => {
            const m = exp.messageById(id);
            return m !== undefined && side(m.from) !== -1 && side(m.to) !== -1 && side(m.from) !== side(m.to);
          });
          assert.ok(crossing.length > 0, 'the partition has pending cross-group traffic to drop');
          assert.deepEqual(effects.filter((x) => x.action === 'partition-drop').map((x) => x.target).sort(), [...crossing].sort());
          assert.ok(exp.pending().every((m) => side(m.from) === -1 || side(m.to) === -1 || side(m.from) === side(m.to)));
          break;
        }
        case 'crash': {
          assert.equal(ext.target, 'B');
          const s = exp.nodeStatus('B');
          assert.equal(s.alive, false);
          assert.equal(canonicalJson(exp.nodeStable('B')), canonicalJson(stableB), 'stable storage survives the crash');
          assert.ok(!exp.pending().some((m) => m.to === 'B'), 'messages to the crashed node are dropped');
          assert.ok(effects.every((x) => x.action === 'crash-drop' || x.action === 'node-stopped'));
          break;
        }
        case 'restart': {
          assert.equal(ext.target, 'B');
          const s = exp.nodeStatus('B');
          assert.equal(s.alive, true);
          assert.equal(s.role, 'follower');
          assert.equal(canonicalJson(exp.nodeStable('B')), canonicalJson(stableB), 'restart keeps the same stable storage');
          break;
        }
        case 'heal': {
          assert.equal(effects.length, 0, 'heal re-sends nothing');
          break;
        }
        default:
          assert.fail(`unexpected event ${ev.action}`);
      }
    }
  }

  // Reorder: m-one was sent before m-two but delivered after it; the copy arrived as a repeat in between.
  assert.ok(mOne < mTwo || exp.messageById(mOne)!.seq < exp.messageById(mTwo)!.seq);
  assert.equal(deliveredTicks.get(mTwo), 2);
  assert.equal(deliveredTicks.get(exp.resolve('m-two-copy')), 4);
  assert.equal(deliveredTicks.get(mOne), 5);

  // Manual mode: nothing is delivered without a user deliver.
  const delivers = exp.log().filter((x) => x.action === 'deliver');
  assert.ok(delivers.every((d) => d.causeSeq !== undefined && exp.log()[d.causeSeq]?.action === 'deliver' && exp.log()[d.causeSeq]?.kind === 'external'));

  // Heal does not resurrect dropped messages: they never reappear and cannot be delivered.
  const dropped = exp.log().filter((x) => x.action.endsWith('drop')).map((x) => x.target);
  exp.advance(5);
  assert.ok(!exp.pending().some((m) => dropped.includes(m.id)));
  exp.schedule({ tick: exp.now + 1, type: 'deliver', message: mThree });
  exp.advance(1);
  const rejected = exp.log().find((x) => x.kind === 'external' && x.tick === exp.now && x.action === 'deliver');
  assert.ok(rejected);
  assert.match(String(rejected.outcome), /^拒絕/);
  assert.equal(effectsOf(exp, rejected).length, 0);
  // After heal, new cross-group messages stay pending instead of being dropped.
  const postHealDrops = exp.log().filter((x) => x.tick > 9 && x.action === 'partition-drop');
  assert.deepEqual(postHealDrops, []);

  // required_log_context is covered by log fields.
  const log = exp.log();
  assert.equal(trace.required_log_context.length, 7);
  assert.ok(log.every((e) => Number.isInteger(e.tick) && Number.isInteger(e.seq) && (e.kind === 'external' || e.kind === 'effect') && typeof e.action === 'string' && typeof e.target === 'string'));
  assert.ok(log.some((e) => e.messageRelation?.originId !== undefined), '原訊息關係');
  assert.ok(log.filter((e) => e.action.endsWith('drop') || e.action === 'deliver').every((e) => typeof e.outcome === 'string'), '傳遞或丟棄結果');
  assert.ok(log.filter((e) => e.action === 'deliver' && exp.messageById(e.target)?.to.match(/^[A-E]$/)).every((e) => e.nodeStatus !== undefined), '節點自述狀態');
  assert.ok(log.every((e, i) => e.seq === i), 'append-only sequence');
});

test('AC-EXP-01 手動模式下延後的訊息不能早於指定時刻傳遞', () => {
  const data = scenarios();
  const exp = faultTraceExperiment(data, { eventsThroughTick: 1 });
  const mOne = exp.resolve('m-one');
  exp.advance(1);
  exp.schedule({ tick: 2, type: 'deliver', message: 'm-one' });
  exp.advance(1);
  const ext = externalAt(exp, 2, 'deliver');
  assert.match(String(ext.outcome), /^拒絕/);
  assert.ok(exp.pending().some((p) => p.id === mOne), 'still pending');
});

test('AC-EXP-01 自動模式的延遲、複製與分割（fault_controls 語義）', () => {
  const data = scenarios();
  const exp = faultTraceExperiment(data, { eventsThroughTick: 0, deliveryMode: 'auto' });
  // Let A start an election so there is real traffic, then apply controls to it.
  exp.advanceTo(4);
  const rv = exp.pending().find((m) => m.from === 'A' && m.to === 'B' && m.payload.type === 'RequestVote');
  assert.ok(rv);
  exp.schedule({ tick: 5, type: 'delay', message: rv.id, at: 9 });
  exp.schedule({ tick: 5, type: 'duplicate', message: rv.id, copyAlias: 'rv-copy' });
  exp.advance(1);
  const delayed = exp.pending().find((m) => m.id === rv.id);
  assert.ok(delayed && delayed.deliverAt >= 9, 'delay only moves the delivery time');
  assert.equal(canonicalJson(delayed.payload), canonicalJson(rv.payload));
  exp.advanceTo(9);
  const delivered = exp.log().filter((e) => e.action === 'deliver' && e.target === rv.id);
  assert.equal(delivered.length, 1);
  assert.ok(delivered[0]!.tick >= 9);
  // Partition drops pending cross-group messages at once and new ones at send time.
  exp.schedule({ tick: 10, type: 'partition', groups: [['A', 'B'], ['C', 'D', 'E']] });
  exp.advanceTo(14);
  const part = externalAt(exp, 10, 'partition');
  const effects = effectsOf(exp, part);
  assert.ok(effects.length > 0);
  assert.ok(effects.every((e) => e.action === 'partition-drop'));
  assert.ok(effects.some((e) => e.tick > 10), 'later sends across the cut are dropped at send time');
  assert.ok(!exp.log().some((e) => e.tick > 10 && e.action === 'deliver' && crosses(exp, e.target)));
});

function crosses(exp: Experiment, id: string): boolean {
  const m = exp.messageById(id);
  if (!m) return false;
  const side = (n: string) => (['A', 'B'].includes(n) ? 0 : ['C', 'D', 'E'].includes(n) ? 1 : -1);
  return side(m.from) !== -1 && side(m.to) !== -1 && side(m.from) !== side(m.to);
}
