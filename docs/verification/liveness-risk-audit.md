# 活性殘留風險查核與實驗定位

本輪依 desk T-0458 與產品 issue #27，查核 ADR-0002 E3 的兩項未實測組態。產品起點固定為 `e4e538654f5dd821683f02538cc10c10996764e9`，需求及資料仍為 specs `0f0f4dcf471c1f7ccc381ceeb5eda99c609e98e5`。

## 為什麼繼續這一輪

[產品 PRD](https://github.com/fallrising/specs/blob/0f0f4dcf471c1f7ccc381ceeb5eda99c609e98e5/products/distributed-lab/prd.md)要求可操控故障、核對一致性、重播與分支、可靠重試，以及快照恢復。M1（PR #12）、M2（#21）與 M3（#26）已提供逐條 AC、實際 CI、固定資料與獨立審查證據；M2 的 AC-EXP-04 另有 owner 確認。這些證據支持固定規格案例的工程交付。

本輪只檢查已記錄的兩項活性風險，補足參考實作的證據；不新增功能、不另稱 M4，也不為追求反例持續加額度。已驗證案例的結果保留，未找到反例不提升為所有允許故障的正確性證明。學習效果與完整互動體驗仍須另有實際使用證據。

## 搜尋前固定的條件

- **H1**：B 在故障前綴結束時是存活群組 A/B/C 中唯一最新日誌的持有者；另記錄窗口建立後的狀態。
- **H2**：C 在存活群組中最新，但 D/E 日誌更完整；區分組態條件、拒票訊息與實際觸發退避，不能把每個 `logOk: false` 都當作退避。
- 只從允許的外部 partition／heal 及已記錄傳遞選擇到達狀態，不直接注入節點內部狀態作為產品反例。涵蓋固定五成員的 52 種集合分割，包含三群分割。
- 前綴傳遞上限分別為 2、6，窗口仍取資料的原條件；待定寫入、窗口起點、61 tick 的新讀取及 60/80 tick 期限全部沿用原資料。
- 最多 4096 次完整模擬：1024 個初始候選、最多 3068 個定向候選，預留最多 4 次選中證據的真正重播。固定種子、有限突變規則、beam 與排序；不在搜尋後加種子追結果。
- 第一個真實期限、結果值或安全違反即停，保留原始失敗、輸入及重播入口。未命中組態只記「此範圍內未找到」，不宣稱不可達。
- 工具與分類方法經非作者審查後才執行完整搜尋。搜尋候選與額外的工具單元驗證分開記錄；原產品 67 個測試全部保留。

## 結果

本輪按有限計畫結束，沒有追加候選。方法見 [ADR-0004](../decisions/0004-bounded-liveness-risk-validation.md)，原始摘要與工具 digest 見 [結果索引](liveness-risk-audit-results.json)，四個代表輸入見 [案例索引](liveness-risk-audit-cases.json)。

| 觀測項目 | 本次結果 |
| --- | --- |
| 生成候選嘗試 | 4092（初始 1024、定向 3068） |
| 重複排除／實際不同候選 | 264／3828 |
| 工具／非作者重播 | 各 2 次，全部精確相同、選擇剛好耗盡 |
| 正式搜尋及證據重播總模擬數 | 3832，低於 4096 上限 |
| 每個前綴 bound 的群組組合 | 各涵蓋 52 種分割 |
| H1 完整組態 | 0 |
| H2 嚴格／含平手的日誌層次 | 均為 0 |
| C 因 D/E 同任期拒票實際退避 | 266 個候選；未同時符合 H2 層次 |
| 真實期限／值／安全違反 | 0；所有候選的窗口前提成立、歷史合法 |
| 最晚完成 | 寫入 43 tick（期限 60）、讀取 71 tick（期限 80） |

在 tick 19、20、25 三個記錄點，都未找到 H1 或 H2 的日誌層次條件。266 個退避候選只證明有觀察到退避機制，沒有重現第二項完整風險。因此本次結論是：**在本輪有界搜尋中未找到兩個目標組態，也未發現新的違反；原有兩項限制繼續保留。**

覆蓋仍有限：beam 保留 parent 的傳遞種子及閘道，讓單一事件突變可比較，但使讀取閘道分布偏斜（A 2371、B 1100、C 357）。同一個前綴沒有逐一窮舉所有閘道及所有傳遞先後。本輪不以補足上限為由繼續搜尋。

工具另有七個單元測試，其中小型 smoke 每次使用兩個候選及一次重播；它屬於工具驗證，不作正式搜尋覆蓋或模型比較。原 67 個產品測試保留，加上工具測試共 74/74，無失敗或跳過。

## 重建單一代表案例

完整 choices 暫存在本次 `/tmp/distributed-lab-liveness-audit`，容器保存期限未知。repo 的案例索引保留輸入及觀測 digest；使用本輪工具版本與未修改的產品基準，可以重建錄製再做真正重播，毋須重跑完整搜尋：

```sh
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { parseScenarios } from './src/scenarios/data.ts';
import { FORMAL_PLAN, SimulationBudget } from './scripts/liveness-risk-search.ts';
import { evaluateCandidate, replayEvidence } from './scripts/liveness-risk-audit.ts';
const data = parseScenarios(readFileSync('data/scenarios.yaml', 'utf8'));
const fixture = JSON.parse(readFileSync('docs/verification/liveness-risk-audit-cases.json', 'utf8'));
const item = fixture.cases.find(c => c.labels.includes('worst-write'));
const budget = new SimulationBudget({ ...FORMAL_PLAN, initialPerBound: 1, mutationsPerCell: 0, maxReplays: 1, maxSimulations: 3 });
const run = evaluateCandidate(data, item.candidate, budget);
assert.equal(run.summary.recordingDigest, item.observed.recordingDigest);
assert.equal(run.summary.observationDigest, item.observed.observationDigest);
assert.equal(run.summary.stableDigest, item.observed.stableDigest);
assert.equal(replayEvidence(data, run, budget).success, true);
JS
```

這是已保存案例的重建入口，沒有在本次正式搜尋結束後執行更多候選。跨版本重建應先核對結果索引中的產品、資料及工具 digest。

## 目前是否朝目標前進

工程目標有可查核的進展：實作已涵蓋原本的讀寫、故障、重播／分支、重試及快照變更，並保留既有案例。這輪只用固定上限校準已知風險，完成後結束本次查核，避免把工程工作延伸成無限搜測。

若目標是正式比較模型能力，現有證據只能作探索性工程案例。[T-0455](https://github.com/fallrising/desk/blob/main/tasks/T-0455-model-challenge-specs/task.md)交付的是七套規格與共同評測條件；[共同評測文件](https://github.com/fallrising/specs/blob/0f0f4dcf471c1f7ccc381ceeb5eda99c609e98e5/docs/model-challenge-evaluation.md)仍標為 draft。它要求場次開始前固定範圍、起點、整套配置、主預算、修復額度與裁判。

現有 M1/M2 是 Claude 的既有開發成果；M2 的 Codex run 是事後證據整理；M3 是 Codex 多 agent 承接已有 M1/M2。範圍、起點、配置與投入不同，精確主動時間及實際費用未知，公開案例與公開的 M3 大方向也不是隔離保留題。里程碑耗時與 40／54／67 個測試數都不能用來排序模型。

## 是否需要重開實驗

保留現有 repo、結果與失敗紀錄，作為參考實作與試跑證據。若要回答模型或整套開發系統的優劣，另開乾淨、受控的比較場次，先選定一種問題：

| 比較問題 | 共同起點 | 可歸因的結果 |
| --- | --- | --- |
| 從零完成固定里程碑 | 同一規格、素材、空白／共同骨架 | 固定配置下的完整交付能力 |
| 在既有產品做相同變更 | 同一 M2 commit、同一 M3 變更包 | 固定配置下的增量變更與回歸能力 |

場次啟動前至少鎖定：比較單一模型或含 agent／工具的整套配置；同一提示、基底與允許依賴；等牆鐘或等實際費用的一個主預算；修復額度；獨立裁判與預先封存的允許範圍保留案例；完整、可核對的起訖及投入紀錄。已有解答的上下文、M3 實作與本輪搜尋結果不應混入宣稱未見解答的場次。

本輪沒有啟動上述正式對照，也不把舊結果追溯補記成公平比較。新的場次條件需先具體定稿，再開始計時或執行。
