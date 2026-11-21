// Teaching screen for AC-EXP-04 (ADR-0002 E4). The page is static HTML with data precomputed by the same
// simulation (partition_case, replay_case.seed); it does not run the simulation in the browser.
// Owner confirmation of AC-EXP-04 is separate from the fidelity tests of this module.
import { runPartitionCase } from '../scenarios/drivers.ts';
import type { Scenarios } from '../scenarios/data.ts';
import type { Experiment, Recording } from '../sim/experiment.ts';
import type { NodeStatus } from '../sim/node.ts';
import { checkHistory, historyToCheckOps } from '../checker/linearizability.ts';

export interface TeachingNode extends NodeStatus {
  readonly group: readonly string[] | null;
}

export interface TeachingFrame {
  readonly tick: number;
  readonly nodes: readonly TeachingNode[];
}

export interface TeachingOp {
  readonly requestId: string;
  readonly client: string;
  readonly action: string;
  readonly key: string;
  readonly value: string | null;
  readonly via: string;
  readonly invoke: number;
  readonly complete: number | null;
  readonly result: string | null;
}

export interface TeachingModel {
  readonly seed: number;
  readonly partitionTick: number;
  readonly groups: readonly (readonly string[])[];
  readonly completeBy: number;
  readonly frames: readonly TeachingFrame[];
  readonly ops: readonly TeachingOp[];
  readonly verdict: string;
  readonly topics: readonly string[];
  readonly recording: Recording;
  /** The new-write result on the side of `node` at the end: the data's 未確認 / 已確認. */
  sideResult(node: string): string;
}

export function buildTeachingModel(data: Scenarios): TeachingModel {
  const f = data.teaching_fixture;
  if (f.basis !== 'partition_case') throw new Error(`unsupported basis ${f.basis}`);
  const pc = data.partition_case;
  const seed = data.replay_case.seed;
  const frames: TeachingFrame[] = [];
  const snap = (exp: Experiment) => {
    frames.push({ tick: exp.now, nodes: exp.nodeStatuses() });
  };
  const exp = runPartitionCase(data, { type: 'seed', seed }, { onTick: snap }).experiment;
  const ops: TeachingOp[] = exp.history().map((o) => ({
    requestId: o.requestId,
    client: o.client,
    action: o.action,
    key: o.key,
    value: o.value ?? null,
    via: o.attempts[0]?.via ?? '',
    invoke: o.invoke,
    complete: o.outcome.status === '已完成' ? o.outcome.complete : null,
    result: o.outcome.status === '已完成' ? o.outcome.result : null,
  }));
  const verdict = checkHistory(historyToCheckOps(exp.history()), data.cluster.initial_values, { maxStates: 100_000 }).type;
  const last = frames[frames.length - 1] as TeachingFrame;
  const newWrites = pc.new_operations.filter((o) => o.action === 'write');
  return {
    seed,
    partitionTick: pc.start_tick,
    groups: pc.groups,
    completeBy: newWrites.find((o) => o.complete_by !== undefined)?.complete_by as number,
    frames,
    ops,
    verdict,
    topics: f.explanation_topics,
    recording: exp.recording(),
    sideResult(node: string): string {
      const group = last.nodes.find((n) => n.node === node)?.group ?? [];
      const w = newWrites.find((o) => group.includes(o.via as string));
      const op = ops.find((o) => o.requestId === w?.request);
      return op?.result ?? '未確認';
    },
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderTeachingHtml(m: TeachingModel): string {
  const payload = {
    seed: m.seed,
    partitionTick: m.partitionTick,
    groups: m.groups,
    completeBy: m.completeBy,
    frames: m.frames.map((fr) => ({
      tick: fr.tick,
      nodes: fr.nodes.map((n) => ({ node: n.node, alive: n.alive, role: n.role, term: n.term, leaderId: n.leaderId, commitIndex: n.commitIndex, group: n.group })),
    })),
    ops: m.ops,
    verdict: m.verdict,
  };
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  const [t1, t2, t3, t4] = m.topics.map(esc);
  const minority = esc((m.groups[0] ?? []).join('、'));
  const majority = esc((m.groups[1] ?? []).join('、'));
  return `<title>分割教學畫面</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;600&family=Noto+Sans+TC:wght@400;600&display=swap">
<style>
/* Layout: a tick scrubber over two connected-group lanes, then the operation log and four explanations. */
:root {
  --bg: #f4f6f8; --panel: #ffffff; --fg: #17202a; --muted: #5b6878; --line: #d5dce4;
  --accent: #1f6f8b; --ok: #1d7a46; --pending: #9a6a00; --stopped: #8a94a3;
  --font-body: "IBM Plex Sans", "Noto Sans TC", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #0f151b; --panel: #172029; --fg: #e3e9ef; --muted: #98a6b5; --line: #2a3643;
  --accent: #5fb3cf; --ok: #5cc98a; --pending: #e0b04a; --stopped: #6c7886; color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #0f151b; --panel: #172029; --fg: #e3e9ef; --muted: #98a6b5; --line: #2a3643;
  --accent: #5fb3cf; --ok: #5cc98a; --pending: #e0b04a; --stopped: #6c7886; color-scheme: dark }
body { background: var(--bg); color: var(--fg); font-family: var(--font-body); font-size: 15px; line-height: 1.6;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
main { max-width: 980px; margin: 0 auto; padding-block: 28px 48px; display: grid; gap: 28px; }
h1, h2 { text-wrap: balance; margin: 0; line-height: 1.25; }
h1 { font-size: 1.6rem; }
h2 { font-size: 1.1rem; }
p { margin: 0; max-width: 68ch; }
.muted { color: var(--muted); }
.mono, .tick, td.num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
header { display: grid; gap: 8px; }
.scrub { display: grid; gap: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
.scrub-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; }
.tick { font-size: 1.4rem; font-weight: 600; min-width: 5.5ch; }
input[type=range] { flex: 1 1 260px; accent-color: var(--accent); }
.jumps { display: flex; flex-wrap: wrap; gap: 8px; }
button { font: inherit; font-size: 0.85rem; color: var(--fg); background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
button:hover { border-color: var(--accent); }
button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.phase { font-size: 0.9rem; }
.lanes { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
.lane { display: grid; gap: 10px; align-content: start; min-width: 0; }
.lane-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.lane-head .label { font-size: 0.75rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.cut { border-left: 2px dashed var(--pending); padding-left: 14px; }
.nodes { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
.node { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; display: grid; gap: 4px; }
.node .name { font-family: var(--font-mono); font-weight: 600; font-size: 1.1rem; }
.node .role { font-size: 0.85rem; }
.node .role b { color: var(--accent); font-weight: 600; }
.node.leader { border-color: var(--accent); }
.node.stopped { opacity: 0.6; }
.node dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 0 8px; font-size: 0.8rem; color: var(--muted); }
.node dd { margin: 0; font-family: var(--font-mono); color: var(--fg); }
.side-result { font-size: 0.9rem; }
.chip { display: inline-block; font-size: 0.8rem; border-radius: 999px; padding: 1px 9px; border: 1px solid currentColor; }
.chip.ok { color: var(--ok); }
.chip.pending { color: var(--pending); }
.chip.none { color: var(--stopped); }
.table-wrap { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 0.88rem; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { font-weight: 600; color: var(--muted); font-size: 0.78rem; letter-spacing: 0.04em; }
tr:last-child td { border-bottom: 0; }
.topics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px 28px; }
@media (max-width: 640px) { .topics { grid-template-columns: 1fr; } }
.topic { display: grid; gap: 6px; align-content: start; min-width: 0; }
.topic h3 { margin: 0; font-size: 1rem; }
.note { font-size: 0.85rem; color: var(--muted); }
@media (prefers-reduced-motion: no-preference) { .node { transition: border-color 120ms ease; } }
</style>
<main>
  <header>
    <h1>分割教學畫面</h1>
    <p class="muted">五個節點的虛擬 KV 叢集，在第 <span class="mono">${m.partitionTick}</span> 個時間點切成少數側（${minority}）與多數側（${majority}）。拖動時間點，比對每個節點<strong>自述</strong>的角色與世代，以及兩側新寫入的真實確認狀態。資料由模擬產生（partition_case，種子 <span class="mono">${m.seed}</span>），可以重播。</p>
  </header>

  <section class="scrub" aria-label="時間點">
    <div class="scrub-row">
      <span class="tick" id="tick-label">t=0</span>
      <label class="muted" for="tick">時間點</label>
      <input type="range" id="tick" min="0" max="0" step="1" value="0">
    </div>
    <div class="jumps">
      <button type="button" data-jump="before">分割前</button>
      <button type="button" data-jump="cut">分割</button>
      <button type="button" data-jump="confirmed">多數側確認</button>
      <button type="button" data-jump="end">觀察結束</button>
    </div>
    <p class="phase" id="phase"></p>
  </section>

  <section class="lanes" id="lanes" aria-live="polite"></section>

  <section class="table-wrap" aria-label="操作歷史">
    <table>
      <thead><tr><th>請求</th><th>客戶端</th><th>操作</th><th>經由</th><th>送出</th><th>此時的結果</th></tr></thead>
      <tbody id="ops"></tbody>
    </table>
  </section>

  <section class="topics" aria-label="解說">
    <article class="topic">
      <h3>${t1}</h3>
      <p>少數側只有兩個成員，湊不到五個中的三個。少數側節點即使自述 leader，也無法讓新寫入得到多數確認，所以那筆寫入保持未確認。讀取同樣要經過多數確認，少數側的新讀取拿不到結果，不會用本地的舊資料回覆。</p>
    </article>
    <article class="topic">
      <h3>${t2}</h3>
      <p>分割後，多數側在較新的世代選出自己的 leader；少數側的節點還停在舊世代，仍然自述是 leader。兩個自述角色同時存在並不代表出錯。角色是每個節點自己說的，用來判斷安全的是有沒有得到多數確認。</p>
    </article>
    <article class="topic">
      <h3>${t3}</h3>
      <p>只有得到多數確認的寫入才會回「已確認」，而任兩個多數一定有交集，所以兩側不會各自確認互相衝突的結果。這次的操作歷史經檢查器判定為「<span id="verdict"></span>」。</p>
    </article>
    <article class="topic">
      <h3>${t4}</h3>
      <p>多數側在穩定傳遞與公平處理下，於期限 <span class="mono">${m.completeBy}</span> 前完成新寫入。少數側缺少「存活且可互相送達的多數」，規格不要求它完成；它可以保持未確認，或對客戶端回報不可用，但不能回報成功。</p>
    </article>
  </section>

  <p class="note">畫面上的角色與世代都是節點自述，不表示任何時刻只有一個 leader。世代數字由模擬得出，只是例子。</p>
</main>
<script id="teaching-data" type="application/json">${json}</script>
<script>
(function () {
  var D = JSON.parse(document.getElementById('teaching-data').textContent);
  var range = document.getElementById('tick');
  var label = document.getElementById('tick-label');
  var lanes = document.getElementById('lanes');
  var opsBody = document.getElementById('ops');
  var phase = document.getElementById('phase');
  document.getElementById('verdict').textContent = D.verdict;
  var last = D.frames[D.frames.length - 1].tick;
  var majorityOp = D.ops.find(function (o) { return o.complete !== null && o.action === 'write'; });
  range.min = String(D.frames[0].tick);
  range.max = String(last);
  var roleName = { leader: 'leader', follower: 'follower', candidate: '候選者', stopped: '已停止' };
  function frameAt(t) {
    var f = D.frames[0];
    for (var i = 0; i < D.frames.length; i++) if (D.frames[i].tick <= t) f = D.frames[i];
    return f;
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function chipFor(op, t) {
    if (t < op.invoke) return el('span', 'chip none', '未送出');
    if (op.complete !== null && op.complete <= t) return el('span', 'chip ok', op.result + '（t=' + op.complete + '）');
    return el('span', 'chip pending', '未確認');
  }
  function laneFor(name, members, frame, t, cut) {
    var lane = el('div', 'lane' + (cut ? ' cut' : ''));
    var head = el('div', 'lane-head');
    head.appendChild(el('span', 'label', name));
    var newWrite = D.ops.find(function (o) { return o.action === 'write' && members.indexOf(o.via) >= 0; });
    if (newWrite && t >= D.partitionTick) {
      var r = el('span', 'side-result');
      r.appendChild(document.createTextNode('這一側的新寫入 ' + newWrite.requestId + '：'));
      r.appendChild(chipFor(newWrite, t));
      head.appendChild(r);
    }
    lane.appendChild(head);
    var grid = el('div', 'nodes');
    frame.nodes.filter(function (n) { return members.indexOf(n.node) >= 0; }).forEach(function (n) {
      var card = el('div', 'node ' + n.role);
      card.appendChild(el('span', 'name', n.node));
      var role = el('span', 'role');
      role.appendChild(document.createTextNode('自述角色 '));
      role.appendChild(el('b', '', roleName[n.role] || n.role));
      card.appendChild(role);
      var dl = el('dl');
      [['世代', n.term], ['認定的 leader', n.leaderId || '—'], ['提交進度', n.commitIndex]].forEach(function (kv) {
        dl.appendChild(el('dt', '', kv[0]));
        dl.appendChild(el('dd', '', String(kv[1])));
      });
      card.appendChild(dl);
      grid.appendChild(card);
    });
    lane.appendChild(grid);
    return lane;
  }
  function render(t) {
    var frame = frameAt(t);
    label.textContent = 't=' + t;
    range.value = String(t);
    lanes.replaceChildren();
    if (t < D.partitionTick) {
      lanes.appendChild(laneFor('全體連通', D.frames[0].nodes.map(function (n) { return n.node; }), frame, t, false));
      phase.textContent = '分割前：全體連通。';
    } else {
      lanes.appendChild(laneFor('少數側 ' + D.groups[0].join('、'), D.groups[0], frame, t, false));
      lanes.appendChild(laneFor('多數側 ' + D.groups[1].join('、'), D.groups[1], frame, t, true));
      phase.textContent = '分割中：兩側之間的訊息全部丟棄（觀察到 t=' + last + '）。';
    }
    opsBody.replaceChildren();
    D.ops.forEach(function (o) {
      var tr = el('tr');
      tr.appendChild(el('td', 'mono', o.requestId));
      tr.appendChild(el('td', '', o.client));
      tr.appendChild(el('td', 'mono', o.action === 'write' ? '寫 ' + o.key + '=' + o.value : '讀 ' + o.key));
      tr.appendChild(el('td', 'mono', o.via));
      tr.appendChild(el('td', 'num', 't=' + o.invoke));
      var td = el('td');
      td.appendChild(chipFor(o, t));
      tr.appendChild(td);
      opsBody.appendChild(tr);
    });
  }
  range.addEventListener('input', function () { render(Number(range.value)); });
  var jumps = { before: D.partitionTick - 1, cut: D.partitionTick, confirmed: majorityOp ? majorityOp.complete : last, end: last };
  document.querySelectorAll('[data-jump]').forEach(function (b) {
    b.addEventListener('click', function () { render(jumps[b.getAttribute('data-jump')]); });
  });
  render(last);
})();
</script>
`;
}
