// AC-EXP-04 is verified by owner confirmation (驗證：人工確認). These tests only check that the teaching
// screen is faithful to teaching_fixture and to the simulation; they do not replace the owner's confirmation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scenarios } from '../helpers/data.ts';
import { buildTeachingModel, renderTeachingHtml } from '../../src/teaching/page.ts';
import { replayExperiment } from '../../src/sim/experiment.ts';
import { canonicalJson } from '../../src/canonical.ts';

test('AC-EXP-04（人工確認另計）教學畫面資料忠於 teaching_fixture', () => {
  const data = scenarios();
  const f = data.teaching_fixture;
  const model = buildTeachingModel(data);
  assert.equal(f.basis, 'partition_case');
  // Precondition: A self-reports leader before the partition, reached by recorded choices.
  const beforeCut = model.frames.find((fr) => fr.tick === data.partition_case.start_tick - 1)!;
  assert.equal(beforeCut.nodes.find((n) => n.node === 'A')?.role, 'leader');
  assert.ok(model.recording.choices.length > 0, 'the choices that produce the precondition are in the replay data');
  // Final frame: both displayed states, with different generations and the specified groups and results.
  const last = model.frames.at(-1)!;
  for (const d of f.displayed_states) {
    const n = last.nodes.find((x) => x.node === d.node)!;
    assert.equal(n.role, d.self_reported_role, `${d.node} role`);
    assert.deepEqual(n.group, d.connected_group, `${d.node} group`);
    assert.equal(model.sideResult(d.node), d.new_write_result, `${d.node} side new write`);
  }
  const [a, c] = f.displayed_states.map((d) => last.nodes.find((x) => x.node === d.node)!.term);
  assert.ok(a! < c!, 'the minority leader is of an older generation');
  assert.ok(f.exact_generation_numbers_are_teaching_example_only);
});

test('AC-EXP-04（人工確認另計）畫面標示自述、不宣稱唯一 leader、涵蓋解說主題，且與產生器一致', () => {
  const data = scenarios();
  const f = data.teaching_fixture;
  const html = renderTeachingHtml(buildTeachingModel(data));
  assert.equal(html, readFileSync('docs/teaching/index.html', 'utf8'), 'docs/teaching/index.html is regenerated (npm run teaching)');
  assert.ok(f.must_label_role_as_self_reported);
  assert.match(html, /自述/);
  assert.equal(f.global_single_leader_at_every_instant_required, false);
  for (const banned of ['唯一 leader', '唯一的 leader', '全域 leader', '真正的 leader']) assert.ok(!html.includes(banned), `does not claim "${banned}"`);
  for (const topic of f.explanation_topics) assert.ok(html.includes(topic), `explains ${topic}`);
});

test('AC-EXP-04（人工確認另計）畫面的資料可由錄製的選擇重播得到', () => {
  const model = buildTeachingModel(scenarios());
  const replay = replayExperiment(model.recording);
  for (const fr of model.frames) {
    replay.advanceTo(fr.tick);
    assert.equal(canonicalJson(replay.nodeStatuses()), canonicalJson(fr.nodes), `tick ${fr.tick}`);
  }
  assert.equal(replay.replayRemaining(), 0);
});
