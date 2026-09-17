# Progress: 2026-09-17 devcontainer simplification

implementation-base: be1cb34d

Task 0: complete (commit be1cb34d — contract measurement recorded)

design-decision: 分離プロセスはパイプラインの Effect Scope（proxy / hostexec broker /
maskfs / port_bind）を保持するため残す → D3 の「常駐 supervisor を全削除」は却下。
削除するのは制御プロトコル・世代管理・状態機械・2 回リトライ・常駐 probe ループ。
根拠と適用範囲は plan の D3 節に追記済み。

Task 1-5: complete（死にコード削除 / lifecycle.ts 再実装 / supervisor・service 削除と
CLI 差し替え / compose_session_service の常駐 probe 削除 / 検証・設計書更新）

line-delta: production +694 -2955（net -2261）、test +329 -2509（net -2180）。

design-decision: profile 検証は `validateDevcontainerProfile` 一箇所に集約し、
`init` と `up` の入口で呼ぶ。起動後の Docker inspect による実構成再検査は削除
（同じ Compose 定義から Docker が起動する以上、同じ入力を二度読むだけ）。

design-decision: `store.ts` は削除ではなく縮小（パス解決・JSON 入出力・flock・
workspace の正規化・入力ロード）→ D2 の「store.ts を削除」は部分適用。
硬化 I/O（O_NOFOLLOW / nlink / fsync / サイズ制限）と StoreOps Tag は削除する。
