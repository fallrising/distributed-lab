# ADR-0001 M1 技術設計

- 狀態：已審查（第二版複核結論為「同意，附修改」，三項修改已併入本版）。
- 需求依據：fallrising/specs `products/distributed-lab/`。起點是 `1bea9352af2c72b82e9e303c503182928314df59`；實作以批准 PR 合併後的 SHA 為準。
- desk 卡：T-0453。
- 範圍：M1 的 8 條 AC：AC-RUL-01～04、AC-EXP-01～03、AC-QLT-01。M2、M3 只用來檢查本設計有沒有把路堵死。

本文件只記技術選擇。需求與數值不抄寫，引用 REQ／AC 編號與 `data/scenarios.yaml` 的鍵名。

## D1 語言與執行環境

TypeScript，Node.js ≥ 22.18，使用原生 type stripping。`tsconfig` 開 `erasableSyntaxOnly`，所以不能用 enum、namespace 或 parameter property。測試用內建的 `node:test`。依賴只有兩個：`yaml` 讀情境資料，`typescript` 只做型別檢查。

理由：M2 的畫面（AC-EXP-04）可以直接在瀏覽器跑同一套模擬。不用建置，乾淨環境只要 `npm ci && npm test`。

## D2 決定性

整個模擬是單一行程的離散事件模擬，時間是整數 tick。

- 不讀牆鐘，也不用未記錄的亂數。`test/unit/determinism.test.ts` 掃描 `src/`，出現以下任一字詞就失敗：`Date`、`Math.random`、`performance`、`process.hrtime`、`setTimeout`、`setInterval`、`crypto`。
  - 唯一例外是 `src/checker/clock.ts`。那是檢查器的時間預算介面，不屬於模擬。
- 所有非決定性的選擇都經過 `Chooser.choose(kind, options)`，結果寫進選擇日誌。選擇有三種，對應 `replay_case.recorded_choices`：訊息延遲、同一步驟內的先後、節點處理先後。
- 選擇的來源是策略，可以是 `min` 延遲、`max` 延遲，或以種子驅動的 splitmix64。
- 使用者操作與故障事件是實驗的輸入腳本，也會被記錄。
- 不依賴插入順序。凡需要迭代的集合都先排序（節點依設定順序，訊息依 id）。比較觀察時用鍵排序的正規化 JSON。
- 重播用 `ReplayChooser`：只從選擇日誌取值；要的種類或選項和記錄不符就丟例外。

## D3 一個 tick 的步驟

在 tick `t` 依序執行：

1. **外部事件。** 排在 `t` 的客戶端操作與故障控制，依腳本順序套用。手動模式的 `deliver(id)` 在這一步立即交付，並由收件節點處理。
2. **自動交付。** 交付到期的訊息，先後由 Chooser 決定。
3. **節點計時器。** 處理選舉逾時、心跳、閘道重送，先後由 Chooser 決定。
4. **客戶端計時器。** 處理嘗試逾時與重送，先後由 Chooser 決定。

在 `t` 送出的訊息，最早在 `t+1` 交付。自動模式下，延遲由 Chooser 在 `[1, 傳遞上限]` 內選；腳本沒指定時用 `default_delivery_delay_ticks`。

手動模式（`fault_trace.delivery_mode`）下訊息一律保持待送，直到使用者處理。`delay(id, at)` 只設定最早可交付時刻，不會自行交付。

「在 tick `t` 分支」指的是完成 `t` 的四個步驟之後。

## D4 網路與故障

網路由端點組成，端點包括節點與客戶端。

- 每則訊息有固定 id（`msg-<n>`）、來源、目的地與內容。複製出來的訊息另有 `originId`。
- 客戶端與節點之間的可達性另外設定，例如 `minority_client_reachable`。
- `heal` 同時恢復節點之間與客戶端的可達性（`client_reachable_after_heal`）。

| 控制 | 語義（對應 `fault_controls`） |
| --- | --- |
| `delay(id, at)` | 把最早交付時刻設為 `at`，內容不變 |
| `drop(id)` | 移除這則待送訊息，不回滾任何邏輯操作 |
| `duplicate(id)` | 新增一則內容相同的待送訊息，`originId` 指向原訊息 |
| `deliver(id)` | 手動交付；先交付延後的訊息就形成重排 |
| `partition(groups, directions)` | 跨群組的待送訊息立即丟棄；之後新送的在送出時丟棄 |
| `heal()` | 只恢復後續傳遞，已丟棄的訊息不復活 |
| `crash(node)` | 清掉揮發狀態；傳向它的待送訊息和新訊息都丟棄。崩潰前已由它送出的訊息仍在網路中照常交付 |
| `restart(node)` | 只從穩定儲存重建 |
| `pause()`／`resume()` | 暫停時 `advance` 會被拒絕；讀日誌不推進時間 |
| `advance(n \| toTick)` | 推進虛擬時間 |

`fault_trace` 的三個別名 `m-one`、`m-two`、`m-three` 在實驗開始時一次綁定，各自對應不同的訊息。綁定時依方向找實際的待送訊息；數量不夠就建立診斷訊息。節點收到診斷訊息不處理，日誌會標 `diagnostic: true`（`message_binding`）。

## D5 共識：Raft 型 leader 複製

規格不指定演算法。選 Raft 型，是因為「自述角色」與「領導世代」能直接對上 M2 的教學畫面（`teaching_fixture`）。

### 狀態

- 穩定儲存是 `currentTerm`、`votedFor`、`log`；M3 再加 `snapshot`。
- 揮發狀態是其餘一切：角色、`commitIndex`、`lastApplied`、狀態機、閘道表、計時器。
- 節點物件只有 `stable` 與 `volatile` 兩個欄位。`crash` 會把 `volatile` 設為 null，`restart` 只從 `stable` 重建。

### 必守規則

這些規則都要有單元測試，測試會刻意複製、重排 AppendEntries 與 RequestVote。

1. 先寫穩定儲存，才回 ack 或投票；投票前要先持久化 `currentTerm` 和 `votedFor`。leader 先寫入自己的日誌，才送出複製。
2. follower 只在任期衝突時截斷日誌；收到已經相符的項目時不截斷。
3. ack 回報的是 `prevLogIndex + entries.length`，不是 follower 自己的日誌長度。
4. leader 的 `matchIndex` 只增不減，`nextIndex` 不低於 1。
5. 回覆的任期和自己目前的任期不同就忽略；看到更高的任期就轉為 follower。
6. follower 的 `commitIndex` 取 `min(leaderCommit, 這次收到的最後一筆新項目)`，而且不倒退。
7. 只用多數 match 提交**本任期**的項目（Raft §5.4.2）。
8. 以下四種情況重設選舉計時器：收到目前 leader 的 AppendEntries、投出票、自己成為候選者、從 leader 或候選者轉為 follower。

### 不做的事

- **新任期不附加 no-op。** 讀取走日誌（D6），所以本任期任何一筆客戶端項目被提交時，前面的項目也一併提交。不加 no-op，在沒有客戶端操作的期間各節點日誌就保持一致，選舉不會因為「候選者日誌較舊」而失敗。
- **不做 check-quorum，也不做 pre-vote。** 少數側的舊 leader 會繼續自述 leader，這正是 `teaching_fixture` 要展示的情形。安全性不靠這兩者。

### 計時器

計時器固定、各節點不同，寫在實驗設定裡，會進重播資料，不用亂數。心跳間隔為 1，閘道重送間隔為 4。

| 節點 | A | C | D | E | B |
| --- | --- | --- | --- | --- | --- |
| 選舉逾時 | 4 | 7 | 14 | 19 | 25 |

### 時限推導

以下推導 `partition_case`，傳遞延遲在 1 到 2 之間。在同一 tick 內，交付先於計時器。

**無誤觸選舉。** 穩定時心跳每 tick 一次，收到心跳的最大間隔是 1 + (2 − 1) = 2。最小逾時是 4，所以不會誤觸選舉。

**初次選舉。**

1. A 在 4 參選。拉票最遲 6 到達，其他節點投票並重設計時器。
2. C 最早要到 12 才逾時（5 + 7），所以 A 最遲在 8 當選，早於任何其他節點逾時。
3. A 在分割（10）之前就是 leader，這也滿足 M2 的教學前置條件。

**分割後的重設時間。** 設 `r_x` 為多數側節點 x 最後一次重設計時器的時刻，則 `r_x ∈ [5, 9]`：

- 最早是 5：A 最遲 8 當選，第一個心跳以延遲 2 送達時已被分割丟棄，這時最後一次重設就是投票時。
- 最晚是 9：8 送出、延遲 1 的心跳。

**C 先參選。**

- C 最遲在 9 + 7 = 16 參選。
- D 最早在 5 + 14 = 19 逾時。C 的拉票最遲 18 到達，D 會先投票並重設，保留 1 tick 餘裕；E 最早 24 逾時，更寬。
- 因此 C 參選時沒有別的候選者，也就不會分票。

**完成時刻。** 第一版的反例來自 no-op 只複製到部分節點；本版不加 no-op，分割前的日誌都是空的，C 不會因為日誌較舊而被拒。C 是 `majority-new` 的閘道，當選後立即提議：

| 步驟 | 最遲時刻 |
| --- | --- |
| C 當選 | 20 |
| C 提交 | 24 |
| 客戶端收到回覆 | 26 |

26 不晚於 `complete_by: 30`。

**限制。** 這個推導只涵蓋 `partition_case` 的條件：分割前沒有客戶端寫入。一般情況下，多數側可能需要先選出日誌較新的節點。M1 不承諾比資料更強的時限。M2 的活性窗口（40 到 60 tick）另外驗證；必要時加入「被拒候選者提名日誌最新的節點」的機制，那會是另一份 ADR。

**證據不只靠推導：**

- 固定兩個邊界排程測試，在本設計下必須通過：
  - 第一版審查的反例排程。
  - 零餘裕排程：A 在 8 當選；它的第一個心跳以延遲 1 到 C，到 D 的那份被分割丟棄。於是 D 的最後重設是 5，C 是 9；C 在 16 參選。D 的逾時若是 13，C 的拉票恰好在 D 逾時的那個 tick 到達。
- AC-RUL-03、AC-RUL-04、AC-EXP-03 各跑以下策略，全部必須達到期限：
  - `min` 延遲
  - `max` 延遲
  - 依目的地固定 1 或 2 的全部 32 種組合
  - 種子 5105 加另外 200 個固定種子
- 這是抽樣證據，不是窮舉證明，回報時照實寫。

## D6 讀取走日誌

讀取和寫入一樣是日誌項目，提交並套用後才回覆。不做 leader 本地讀取，也不做 lease 讀取。

這樣少數側的舊 leader 永遠拿不到多數，`minority_stale_read_probe` 只會停在未確認，或逾時變成不可用。

## D7 客戶端、閘道與請求身分

- 客戶端把 `(clientId, requestId, 操作)` 送到指定的節點（`via`），這個節點就是閘道。
- 閘道把請求留在閘道表，直到自己看到結果為止。即使閘道本身是 leader、直接提議了，也照樣保留。
  - 已知 leader 時轉給它；自己是 leader 時直接提議。
  - leader 不明時先保留，不轉送。
  - 得知新 leader 或自己當選時立即重轉，之後每 4 tick 重轉一次。
- leader 收到轉來的請求，若自己的日誌已有同一 `(clientId, requestId)`、**是本任期的項目**、而且還沒提交，就不再附加。舊任期的同一請求照樣附加，狀態機會去重。否則新 leader 只繼承舊任期項目時，沒有本任期項目可以帶動提交，會永遠卡住（M2 `liveness_case`、`counterfactual_case` 都可能遇到）。
- 回覆有兩條路，客戶端以先到者為邏輯操作的結果，後到的只記為重複回覆：
  - leader 套用某項目時，若客戶端可達，就直接回覆客戶端。
  - 閘道自己套用到該項目時，也回覆客戶端，作為備援。
  - 兩條路的回覆都來自狀態機，不是本地讀取。
- 狀態機以 `(clientId, requestId)` 去重，記錄意圖與結果。重複的項目只回原結果，不改資料。這是 M1 必需的，因為 `counterfactual_case` 會重送。
- 同一身分但意圖不同時，回「請求識別衝突」。只是一次比較；不做比較就會回錯的原結果。M2 的 AC-RUL-05／06 測試不在本輪。
- 客戶端每次嘗試有逾時，預設 20 tick。逾時記為「不可用」，邏輯操作仍未完成。
  - 情境要求時（`retry_same_request_if_unavailable`），客戶端以同一請求重送。
  - 逾時後才到的回覆，仍算原邏輯操作的結果。

**情境驅動。** 循序情境（`baseline_case`、`durability_case`）的每一步 `via` 第一個可達的存活成員，在前一步完成後的下一個 tick 送出。`partition_case` 依資料指定的 `via` 與 `invoke` 送出。`minority_stale_read_probe` 在 `majority-new` 完成後的下一個 tick 送出；送出時刻寫進腳本，重播時沿用。

## D8 操作歷史

一個邏輯操作是 `{client, requestId, action, key, value?, invoke, attempts[], outcome}`：

- `invoke` 是第一次嘗試的時刻。
- `attempts` 記錄每次傳輸嘗試的送出時刻與結果：回覆、不可用，或沒有結果。
- `outcome` 只有兩種：
  - `{status: '已完成', complete, result}`
  - `{status: '未完成'}`

「不可用」永遠不會成為 `outcome`。分析時，未完成的操作可以納入，也可以不納入。

## D9 線性一致性檢查器

**做法。** 先依鍵分開。單鍵讀寫可以逐鍵判定，各鍵獨立。每個鍵用 Wing–Gong／Lowe 型的深度優先搜尋，以「已線性化集合 + 目前值」做記憶化。

- 未完成的寫入可以在呼叫之後任何位置生效，也可以永不生效。
- 未完成的讀取不影響狀態，直接略過。

**結果型別。** 結果互斥，對應 `analysis_outcomes`：

| 型別 | 內容 |
| --- | --- |
| `合法` | `witness`：序列，並標出納入了哪些未完成寫入 |
| `非法` | `reason` |
| `未判定` | `cause`：`時間預算用盡` 或 `資源預算用盡` |
| `未驗證` | 沒有執行 |

**跨鍵彙總。** 任一鍵非法，整體就非法。否則任一鍵未判定，整體就未判定。其餘情況才算合法。

**預算。**

- 資源預算是探索狀態數的上限。
- 時間預算用注入的時鐘介面 `src/checker/clock.ts`。
- AC 測試只用狀態數預算，因為時間預算可能讓結果在不同執行間翻轉。時間預算由假時鐘單元測試覆蓋。

**判定「案例是否通過」。** 這和「歷史是否合法」是兩件事：

- 案例通過的意思是判定等於資料的期望。
- 彙總報告分四欄：通過、失敗、未判定、未驗證。只有「判定等於期望」才進通過欄。「未判定」和「未驗證」各自列出並保留原因，不計入通過。

**非法原因。** 原因是結構化的：

- 卡住的前綴，以及每個候選操作無法排入的理由。
- 若有讀取違反即時先後，另外指出它，以及它必須排在後面的已完成寫入。以 `illegal_stale_read` 為例，是「r-absent 必須在 w-red 之後」；以 `illegal_reverted_value` 為例，是「r-old 必須在 w-blue 之後，且沒有更新的紅」。

## D10 日誌

日誌只能附加。每筆項目的欄位如下，涵蓋 `fault_trace.required_log_context`：

| 欄位 | 內容 |
| --- | --- |
| `tick`、`seq` | 虛擬時間與順序 |
| `kind` | `external`（外部操作）或 `effect`（可見後果） |
| `action` | 例如 `deliver`、`drop`、`partition-drop`、`crash-drop`、`client-invoke`、`client-reply` |
| `target` | 作用的對象 |
| `messageRelation` | 例如 `originId`、`diagnostic` |
| `outcome` | 傳遞或丟棄的結果 |
| `requestRef` | 對應的客戶端請求 |
| `nodeStatus` | 節點自述的角色、任期、提交進度 |

故障控制會先記一筆 `external`。它造成的每個後果各記一筆 `effect`，並以 `causeSeq` 指回那筆 `external`。

## D11 重播與反事實分支

**實驗。** 一個實驗由設定、外部事件腳本、選擇日誌三部分組成。實驗結束後三者都凍結（深度 `Object.freeze`）。

**重播。** 用同樣的設定與腳本，搭配 `ReplayChooser` 從頭跑。在 `replay_case.checkpoints` 用正規化 JSON 比較三項：

- 客戶端邏輯操作與結果
- 外部故障日誌
- 節點可見狀態

**分支：`branch(base, atTick, edits)`。**

1. 用 base 的選擇日誌重播到 `atTick` 結束，並驗證這段前綴與 base 完全相同。
2. 之後套用修改後的腳本，新的選擇由新的種子策略產生。
3. 分支自己的選擇日誌也凍結，所以分支本身也可以重播。

base 物件不會被改動。測試用深度比較確認這一點。

## D12 情境資料

- `data/scenarios.yaml` 是 specs 某個固定 commit 的原樣副本。
- `data/SOURCE.json` 記錄這份副本的來源：repo、commit、路徑、位元組長度、SHA-256。
- 單元測試核對 SHA-256。
- CI 另外從 `raw.githubusercontent.com` 依該 commit 下載原檔，逐位元組比對。specs 是公開 repo，CI 不需要憑證。
- 資料不改。數值或期望有問題時，開 `needs-owner` issue。

## D13 測試與 CI

- 每條 AC 一個檔案，放在 `test/ac/AC-XXX-NN.test.ts`，測試名稱以 AC 編號開頭。其他測試放在 `test/unit/`。
- CI 用 GitHub Actions 的 `ubuntu-latest` 與 Node 22，job 名稱是 `ci`，依序執行：
  1. `npm ci`
  2. 型別檢查
  3. 測試
  4. 資料來源比對
- 沒有慢測試；若多策略測試超過 2 分鐘，再改為分層。

## D14 對 M2、M3 的保留

| 後續需求 | 本設計的保留 |
| --- | --- |
| AC-RUL-05／06 重試 | 狀態機已以請求身分去重，歷史已把嘗試歸到邏輯操作 |
| AC-QLT-02／03 活性 | 計時器與傳遞上限已參數化，「不可用」與「未確認」已分開；一般化的選舉時限見 D5「限制」 |
| AC-EXP-04 教學畫面 | `nodeStatus` 已有自述角色、任期、連通群組；模擬可在瀏覽器跑 |
| AC-RUL-07／08、AC-QLT-04 快照 | 穩定儲存是獨立結構，可加 `snapshot`；去重表需要隨快照保存，M3 再做 |

## 審查紀錄

| 版本 | 結論 | 處理 |
| --- | --- | --- |
| 第一版 | 要求修改 | 1 個 blocker、2 個 major、5 個 minor |
| 第二版 | 同意，附修改 | 3 項：leader 端去重只限本任期項目、零餘裕排程固定測試並把 D 改為 14、轉為 follower 時重設計時器。都已併入本版 |

第一版審查意見在本版的處理：

| 審查意見 | 處理位置 |
| --- | --- |
| 1 時限推導 | D5：取消 no-op、改計時器、重新推導；固定反例測試、多策略測試 |
| 2 Raft 規則 | D5 必守規則 1–7 |
| 3 計時器重設與閘道 | D5 必守規則 8；D7 |
| 4 重送間隔與重複附加 | D7：leader 端依請求身分去重 |
| 5 故障語義 | D3、D4 |
| 6 決定性 | D2、D3、D11 |
| 7 檢查器 | D9 |
| 8 範圍與運作 | D1、D7「情境驅動」、D12、D5 多策略測試 |
