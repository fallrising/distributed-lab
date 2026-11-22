# distributed-lab

可重播的虛擬 KV 叢集實驗室：在虛擬時間中讀寫資料、施加故障、查看日誌、重播與反事實分支，並由線性一致性檢查器判定歷史合法、非法或未判定。

- 業務規格：[fallrising/specs `products/distributed-lab/`](https://github.com/fallrising/specs/tree/main/products/distributed-lab)
- desk 卡：T-0453（M1）、T-0456（M2）、T-0457（M3）
- 技術設計：[ADR-0001](docs/decisions/0001-technical-design.md)、[ADR-0002](docs/decisions/0002-m2-retry-liveness-teaching.md)、[ADR-0003](docs/decisions/0003-snapshot-recovery.md)

## 啟動

需要 Node.js ≥ 22.18。

```sh
npm ci
npm test
```

M3 的 `runSnapshotCase(data, strategy)` 依固定情境逐階段執行：隔離 E、兩次確認寫入、ABCD 拍快照與壓縮、B 崩潰重啟、E 恢復後的新讀取，以及原請求重試。傳入 `{ compaction: false }` 會依資料省略快照與壓縮，供配對比較。觀察包含各階段的起訖、節點穩定儲存與可見狀態；結果不以畫面上的 leader 數量判定。

腳本操作 `take-snapshot` 與 `compact` 分開記錄，透過原網路傳送的快照保存 KV、請求意圖及原結果。資料副本固定於 `data/SOURCE.json` 指定版本；驗證範圍與限制見 [M3 證據索引](docs/verification/m3.md)。
