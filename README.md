# distributed-lab

可重播的虛擬 KV 叢集實驗室：在虛擬時間中讀寫資料、施加故障、查看日誌、重播與反事實分支，並由線性一致性檢查器判定歷史合法、非法或未判定。

- 業務規格：[fallrising/specs `products/distributed-lab/`](https://github.com/fallrising/specs/tree/main/products/distributed-lab)
- desk 卡：T-0453（M1）

## 啟動

需要 Node.js ≥ 22.18。

```sh
npm ci
npm test
```
