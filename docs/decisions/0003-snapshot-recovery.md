# ADR-0003 M3 技術設計：快照、壓縮與落後節點恢復

- 狀態：已由作者以外的 agent 審查；第一版要求修改，第二版複核同意合併。
- desk 卡：T-0457（認領 PR desk#441 已合併）。
- 需求依據：fallrising/specs `products/distributed-lab/`，commit `0f0f4dcf471c1f7ccc381ceeb5eda99c609e98e5`，與 `data/SOURCE.json` 相同。
- 基準：distributed-lab `0173f96feb89e65d3f35b647301e6f6acf9627a0`。延續 ADR-0001、ADR-0002，只記本次新增或改變的技術選擇。
- 範圍：AC-RUL-07、AC-RUL-08、AC-QLT-04；原 M1、M2 的測試全部保留為回歸。數值、案例、預期只讀 `data/scenarios.yaml`，不修改副本。

## S1 全域日誌索引與穩定儲存

日誌壓縮後仍沿用原來的全域索引，不重新從 1 編號。穩定儲存新增：

```ts
interface Snapshot {
  readonly lastIncludedIndex: number;
  readonly lastIncludedTerm: number;
  readonly kv: Readonly<Record<string, string>>;
  readonly applied: Readonly<Record<string, { readonly intent: string; readonly result: string }>>;
  readonly effects: readonly string[];
}
// StableStorage 原有 currentTerm、votedFor、log 不變；新增：
// logStartIndex: number（初始 1）；logBaseTerm: number（初始 0）；
// snapshot: Snapshot | null（初始 null）。
```

- `logStartIndex` 是 `stable.log[0]` 的全域索引；陣列項目 `i` 的全域索引是 `logStartIndex + i`，最後索引是 `logStartIndex + log.length - 1`。
- `compactedThrough = logStartIndex - 1`。`logBaseTerm` 穩定保存這個已壓縮邊界的任期；只要已壓縮，穩定快照必須涵蓋這個區段。
- **拍快照與壓縮分開**：最新快照邊界可以大於 `compactedThrough`，因為已拍快照的日誌尚未必刪除。不能直接把 `snapshot.lastIncludedIndex` 當作陣列 offset。
- 存取項目、截斷、傳送尾段、apply、提議去重、投票的新舊比較與多數提交都使用全域索引。
- `termAt(0)` 是 0；`termAt(logStartIndex - 1)` 從 `logBaseTerm` 取；保留日誌範圍內從陣列取 term。其餘已壓縮位置的 term 不可猜測。
- `takeSnapshot` 不修改 `logStartIndex` 或 `logBaseTerm`。例如先壓縮到 5，再套用到 8 並拍新快照、尚未再壓縮時，最新快照邊界是 8，但仍要能用保留下來的 `logBaseTerm` 回覆／送出 `prevLogIndex = 5`。只保存最新快照的任期會遺失這個較早的實際壓縮邊界，因此不足。
- 空尾段的最後索引／任期取快照邊界；未壓縮但已拍快照時，仍以實際尾段的最後項目為準。

`NodeStatus` 保持既有欄位，`commitIndex`、`lastApplied` 仍是全域進度，`logLength` 仍是實際保留的詳細項目數。沒有快照的既有教學畫面與錄製不增加狀態欄位。測試需要的快照內容由既有 `Experiment.nodeStable()` 觀察，不把本地儲存觀察宣稱為新讀取結果。

## S2 拍快照、壓縮與重啟

`RaftNode.takeSnapshot(): Snapshot` 在節點存活時，對目前 `lastApplied` 建立深拷貝的完整狀態機快照。只有已提交並已套用的前綴可以入快照；不接受任意使用者提供的 index 或 KV。邊界必須大於 0 且不超過 `commitIndex`，其 term 必須可由本機日誌／既有快照確認。

快照一起保存 KV、完整的 `(clientId, requestId) → {intent, result}` 去重表，以及現有 `effects` 觀察序列。去重表在實驗生命期內不淘汰；`effects` 是測試「邏輯效果只一次」的觀察資料，也須跨恢復保留，不用它作共識決策。只保存 KV 而不保存去重會令舊紅寫入在藍之後重新生效，所以不是可接受的壓縮。

`RaftNode.compact(): void` 只能刪除穩定快照涵蓋的詳細前綴：

- 沒有快照、節點已停止，或邊界不能核對時拒絕，不虛構成功。
- 刪除索引不大於 `snapshot.lastIncludedIndex` 的項目，將 `logStartIndex` 移到該邊界之後，並將 `logBaseTerm` 設為 `snapshot.lastIncludedTerm`；保留後面的尾段。
- 拍快照本身不刪日誌；再次對已壓縮邊界 compact 是冪等操作，不改 KV、去重、term、投票或揮發提交進度。
- 不減少全域 `commitIndex`／`lastApplied`，不把詳細日誌項目數當作提交索引。

`restart(now)` 只由穩定儲存重建：有快照時將 `commitIndex`、`lastApplied` 設為快照邊界，深拷貝其 KV、去重表及 effects；無快照時沿用原本初始狀態。保留尾段不因存在於穩定日誌就擅自套用，後續仍依 leader 的 commit 證據套用。`currentTerm`、`votedFor`、快照與日誌在 crash/restart 前後保留；角色、閘道與計時器仍是揮發狀態。

## S3 透過原網路安裝快照

在原本 `Payload` 加入：

```ts
// InstallSnapshot: { type, term, leaderId, snapshot: Snapshot }
// InstallSnapshotReply: { type, term, lastIncludedIndex, success: boolean }
// AppendEntriesReply 的失敗回覆可另帶 nextIndexHint?: number。
```

快照走同一個訊息佇列、Chooser 延遲、分割、丟棄、複製與交付控制，不直接把 leader 的物件指派給 follower。送出時的內容是穩定、無共享可變 Map 的快照值，之後新拍快照或改狀態機不能改寫在途訊息。

leader 發心跳／複製時，如果 follower 的 `nextIndex < logStartIndex`，詳細前綴已不存在，改送當時的完整穩定快照；否則沿用 AppendEntries。快照無分塊，因為本實驗的有限資料不需要傳輸層分塊。回覆丟失就由既有心跳再傳，沒有額外牆鐘或亂數。

### follower 的安裝規則

1. `term` 較舊時拒絕，不改資料；較新時先沿用原規則持久化 term 並清投票。有效任期的 leader 訊息使節點轉為 follower、重設選舉計時器並認得該 leader，與 AppendEntries 一致。
2. `snapshot.lastIncludedIndex <= lastApplied` 時，該前綴已套用，快照不得回退 KV、去重、快照、log 或進度。可成功回覆**這次請求的邊界**，不回覆本機更大的索引，不因此對客戶端回覆。
3. 邊界較新時，只有本地同索引的 term 等於 `lastIncludedTerm` 才保留邊界之後的日誌尾段；不匹配則丟棄全部本地未提交尾段。這時邊界大於已套用的提交進度，不會刪已提交內容。
4. 原子地先保存快照及保留尾段、設 `logStartIndex = lastIncludedIndex + 1` 與 `logBaseTerm = lastIncludedTerm`，再恢復 KV／去重／effects 及全域提交、套用進度，最後回覆精確邊界。不能先 ack 再保存。
5. 不從安裝快照直接發出 `ClientReply`。新的讀取仍須經原 D6 的日誌提交；原請求重試仍經閘道重送／日誌套用，從去重表取原結果。

leader 只接受自己當前任期的成功 `InstallSnapshotReply`，`matchIndex` 及 `nextIndex` 只前進到回覆精確證明的邊界／下一筆；過時或重複回覆不能倒退。`matchIndex` 不能由失敗回覆的 hint 提升。之後接回 AppendEntries 傳尾段並使用原本「只以多數提交本任期項目」的規則。

### 壓縮後的 AppendEntries 邊界

- `prevLogIndex` 在保留範圍內，或恰為實際壓縮邊界 `compactedThrough`（由 `logBaseTerm` 驗證）時，才做原本的 term 比較與追加。
- `prevLogIndex < compactedThrough` 時，不能把已刪除的位置當成空陣列重建，亦不能用本機較長的進度假造 ack。拒絕並回 `nextIndexHint = logStartIndex`，讓 leader 以可比對的邊界重試。
- leader 可依 hint 調整 `nextIndex`（不超過自己的最後索引加一，且不低於已知 `matchIndex + 1`），但這不是複製成功證據。一般拒絕仍依原本回退規則。
- 保留邊界之後的重複／重排 AppendEntries 仍只在 term 衝突時截斷；不得截斷已提交前綴。成功 ack 仍精確為本次請求的 `prevLogIndex + entries.length`，不回本機整個尾段長度。
- leader 送舊快照之後收到較新成功 AppendEntries／snapshot ack，再收到舊拒絕或 ack，不能倒退進度。所有回覆仍先核對任期。

## S4 可重播的外部操作與情境驅動

`ScriptEvent` 增加 `{tick, type: 'take-snapshot', node}` 與 `{tick, type: 'compact', node}`，在 tick 步驟 1 執行。它們照舊記 external 及 effect（成功／拒絕、節點、快照邊界或保留長度），重播用同一腳本，不從觀察者直接改 node。安裝快照只是原訊息交付的 effect，錄製仍只有 config、script、choice log；反事實分支保留分支點之前的快照／壓縮事件與全部可見前綴。

`runSnapshotCase(data, strategy, {compaction?: boolean, retryVia?: string} = {})` 讀 `snapshot_case` 逐 stage 執行；`compaction` 預設 true，false 依 `snapshot_equivalence.variants.without_compaction.omit_stages` 略過 snapshot／compress。以明確支援的資料 action 分派，遇到未知 action 失敗，不默默跳過。

回傳測試觀察契約：

```ts
{
  experiment: Experiment;
  stages: { id: string; start: number; end: number; ok: boolean }[];
  stageStates: Record<string, {
    stable: Record<string, StableStorage>;
    statuses: NodeStatus[];
    values: Record<string, Record<string, string | undefined>>;
  }>;
  retryTick: number;
}
```

`stageStates` 在每個 stage 結束時深拷貝（值欄只收本情境涉及的鍵），不能在回傳時把歷史 stage 全指向最後狀態。stage IDs 取資料的 `id`，另加 `retry-original`、`new-read-after-retry` 兩個檢查階段；未開始的 stage 不偽造成功，失敗 stage 保留 `ok: false` 並停止後續依賴階段。

- 所有 stage 起點是前一 stage 結束的下一 tick。`start` 到 `end` 的完成期限只取 `snapshot_case.completion_bound_per_stage_ticks`（目前資料為 40），不能另加未記錄的 settle 時間或重置起算點。同步外部控制動作可以在自己的起始 tick 結束；要求結果的階段必須在期限內成功後才進下一階段。
- isolate 用資料指定 E 與其他四個節點的分割。兩次寫入各等客戶端取得資料的要求結果後再進下一階段，未指定 via 時沿用第一個可達存活節點。
- snapshot stage 的等待也算自己的期限：等資料指定的全部 members 都已套用 `covers_confirmed_requests`、KV 符合資料期待後，才各排一次 take-snapshot。不能只因 leader 已回覆就替還沒套用的 follower 拍出不存在的狀態；不能等候無上限。
- compress 對資料指定 members 執行 compact，核對 covered requests 不再保留於詳細前綴，快照中的去重記錄仍在。
- crash/restart 僅對資料指定 B，保存各 stage 的穩定／揮發觀察。B 重啟後即能從穩定快照重建；尾段何時追上仍由網路複製決定。
- rejoin 只注入 heal 並立即完成，不先等 E 追上。下一 tick 就依資料經 E 發起新的 recovery_read；這筆請求必須透過正常提交才讀到資料指定值，不能先 settle 再送來掩蓋恢復中的舊讀風險。
- recovery_read 的成功條件是「已取得該請求的回覆，且 E 已套用到該次新讀取的提交前綴、KV 符合資料」。leader 的回覆若先到而 E 尚未套用，仍在同一個 stage 的原期限內繼續推進；不是立刻判失敗，也不另起等待窗口。到原 deadline 仍不滿足整個條件時才記 stage 失敗，不能延長觀察偷算成功。
- 原請求重試預設經重啟後的 B（資料沒有指定 via），`retryVia` 僅作同條件額外測試。等重送之後的那次 attempt 收到實際 `ClientReply`，結果等於原結果；不能看到原 `outcome` 已完成就直接結束。隨後用新 request 經 E 讀取，確認較新值沒有回退。

## S5 AC、回歸與審查證據

先建立 AC 測試再寫實作，每條 AC 一檔，固定資料期望不在測試改寫：

- `AC-RUL-07`：完整 stage 順序與各期限；E 隔離期間無新確認；ABCD 快照涵蓋已確認資料且真有刪除詳細前綴；B crash/restart 的穩定快照相同、揮發狀態由它重建；heal 後立即經 E 的新讀取與追上證據。
- `AC-RUL-08`：原請求的身分與意圖／結果留在 B 及恢復後 E 的去重表；壓縮與重啟後經 B 重試取得新傳輸回覆、只有一個邏輯操作且效果只一次；新讀取保持較新值。測試不能只斷言最後 KV。
- `AC-QLT-04`：同一策略下有／無壓縮依資料配對，依 `snapshot_equivalence.compare` 比較邏輯身分、已完成結果、新讀取值及最終已確認 KV；允許資料列出的事件細節差異。CI 同時執行全部原有 AC，涵蓋 `regression_cases` 的所有既有案例，未跑項不得算通過。

策略採固定可重播的 min、max、依目的地延遲及種子組合；測試範圍與抽樣量記於 PR，不把抽樣提升成窮舉證明。資料未宣告快照需自動觸發，所以本版只提供明確腳本操作，不偷偷在每次 apply 後壓縮。

另加有意義的對抗單元測試：壓縮邊界的投票／append／提交；先 compact 到 5，再 takeSnapshot 到 8 而未 compact，仍能以 `prevLogIndex = 5` 複製保留尾段且 crash/restart 後不遺失該邊界任期；快照深拷貝；未apply前綴不入快照；舊term與過時snapshot不回退；重排snapshot/append回覆；匹配／衝突尾段；再次crash/restart保留去重；快照流程錄製重播及快照前後的反事實分支。新增測試不得跳過原54個測試或放寬期限。

ADR 及共識／重播核心的 PR 由作者以外的 agent 審查並在 PR 留結論；`npm ci`、typecheck、完整測試、來源比對及 staged whitespace 均通過且 PR clean 後 squash 合併、回讀 main。

## S6 已知限制

不改固定成員、不處理磁碟損毀／多數穩定儲存永久遺失，不新增牆鐘或未記錄亂數。

ADR-0002 E3 的兩個未實測活性組態仍是既有限制：B 是唯一持有最新日誌的存活節點；存活的 C 被日誌更完整的 D/E 拒票而退避，可能錯過寫入期限。本次 snapshot_case 的回歸不能證明這兩者已解決；若找到期限違反，保留原失敗並另寫 ADR，不延長測試期限。

## 審查紀錄

| 版本 | 審查者 | 結論與處理 |
| --- | --- | --- |
| 第一版 | 非作者 `/root` | 要求修改：只保存最新 snapshot 的邊界任期，會在「先 compact、再 takeSnapshot、尚未再次 compact」時遺失實際壓縮邊界的 term。已新增穩定 `logBaseTerm`，明定 takeSnapshot 不改該值，compact/install 原子更新，並補上述對抗測試要求。另澄清 recovery_read 在同一 deadline 內等待回覆與 E 追上兩個條件，不因回覆先到就立即失敗。 |
| 第二版 | 非作者 `/root` | 同意合併：已核對獨立保存的 `logBaseTerm` 足以處理拍快照與壓縮邊界不同的情況；recovery_read 的兩個條件共用原 deadline，不放寬資料期限。 |
