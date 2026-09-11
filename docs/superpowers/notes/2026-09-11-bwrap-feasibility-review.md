# bwrap 設計の実現可能性レビュー

対象コード: `6b152b9b`。対象は [spec](../specs/2026-09-11-bwrap-backend-design.md) と [plan](../plans/2026-09-11-bwrap-backend.md)。

2 名の独立 subagent に現行コードとの照合を依頼し、主担当が修正案を返して再検討した。
これはコード・設計のレビューであり、bwrap がホストで実動作したという証拠ではない。

## 指摘と採用した修正

| 論点 | 根拠 | 修正・判断 |
| --- | --- | --- |
| 実証ゲートが循環 | 初期 G3 の agent/mask 統合が Task 3/5/6 に依存 | offline G3a と統合 G3b に分割。最初は G1/G2/G3a、最終受入は全必須ゲート。 |
| Bun owner の FD 受信経路がない | `src/hostexec/client_integration_test.ts` に Node socket server の SCM_RIGHTS 非対応が明記されている | ホスト native bridge を追加。Bun は長さ付き stdio frame、native が SCM_RIGHTS/PTY/pidfd を処理する。 |
| native bridge の入力を信頼しすぎる | FD は隔離内 supervisor 由来 | 受信個数・PTY 型・ancillary を検査。制御 FD を子で明示 close。backpressure と親死亡も試験。 |
| Nix のホスト評価を既存機能と誤認 | 現行は `mount/stage.ts` の `/nix` 共有と隔離内 `direnv-exec.sh` | ホスト `.envrc`/shellHook 自動実行案を撤回し、agent 内 Nix/devShell は初期非対応。後述の必須条件を受け runtime 配布も Nix 不要に変更。 |
| 事前実現 devShell なら動く、も未証明 | 評価時の DB/cache 書込や daemon、GC roots が必要になり得る | 環境 snapshot importer を新規追加しない。plain direnv を隔離内で維持し、Nix が必要な実行の失敗は agent 起動を中断する。 |
| Docker 不使用検査の範囲が狭い | `src/cli.ts` の `resolveBuildProbes`、`ensureUiDaemon` は pipeline 前 | validation と backend 分岐を前へ移し、CLI 全体の fake docker 呼出 0 回を確認する。 |
| Bash/Bun だけでは agent の ABI を保証できない | `src/agents/claude.ts`、`codex.ts` は host binary を直接 mount | 配布形態ごとに loader/helper/依存を実証。最初に --version、最後に実処理と sibling helper 起動。 |
| allow_other 無し検証だけでは本体が変わらない | `maskfs_service.ts` は preflight と `--allow-other` を常に使用 | Task 8 に backend 別 preflight/argv を明記。Docker は従来動作を保持。 |
| addon と CA 並行起動の対象漏れ | `nas_addon.py` に固定パス、現行 mitmproxy は 11 | addon を Task 6 の変更対象へ。配布版 API 互換検証と Docker/bwrap 共通 CA lock を追加。 |
| owner SIGKILL で finalizer が動かない | Effect cleanup だけでは host 子プロセスと秘密 frame が残る | native bridge を guardian 兼用にし、秘密生成前の directory 所有と spawn 登録を保証。host 子孫終了後に directory を削除。bridge 自体の強制終了は次回起動前 recovery とし、生存 guardian と競合しない。 |

## Nix の代替案を壁打ちした結果

ホスト daemon の socket を明示公開すれば既存 devShell に近づけるが、daemon 側 build/fetch は隔離 netns の proxy 制御を通らない。
Unix socket であることだけではこの委譲を解決しない。初期版では公開せず、Nix/devShell が必要な利用者には Docker を案内する。

環境 snapshot をホストで生成して渡す案は、誰が何を承認するか、秘密 env、shellHook、更新検知、store の GC roots を新たに設計する必要がある。
既存の hostexec 機能を使うだけで完了するという説明を撤回し、別機能として扱う。

この縮小により最初の bwrap の用途は狭くなる。devShell 互換を初回から必須とするかは、spec のレビューで最も優先して判断したい点である。

## 実現性の評価と残るリスク

設計上は段階実装できる見込み。ただし起動引数の変換だけの変更ではなく、native bridge/supervisor と lifecycle/CLI/UI の統合が主要な実装量になる。
既存の Zig IPC/PTY 実装の再利用可能性は実装開始時に確認する。再利用を前提に工数を過小評価しない。

ホスト G1/G2/G3a は未実行。FUSE と distro/userns 制約、agent 配布形態の ABI、seccomp の実用プロファイルが不成立なら設計へ戻る。
G3b–G5 を通すまでは bwrap を利用可能と告知しない。optional な Chromium/seccomp は G6 に分離する。

## Nix なし利用とライセンス条件による再検討

ユーザーが「このツールは nix なしでも使える必要がある」と明示したため、Nix rootfs 必須案を撤回した。
2 名と再度検討し、CI で固定した Ubuntu runtime を flatten して tar.gz 配布する案を採用した。利用時は Nix/Docker 不要、CI のビルド手段とは区別する。

proxy の Python/mitmproxy も同じ rootfs へ入れ、agent とは別の service 側 bwrap で host network を使う。
agent の plan に host network が混入しないよう型/compiler を分け、CA private key、DNS snapshot、broker mount を分離する。
rootfs の取得・安全展開・cache と、rootfs より先に動く host bootstrap の ABI/配布を独立タスクにした。

さらに dtach の GPL 指摘を受け、上流 GPL-2.0-or-later を確認した。dtach は外部ホストコマンドを維持し guardian にコードを取り込まない。
ただし dtach を同梱しなくても rootfs と bundle の再配布義務は残る。inventory、表示、対応ソース・distro patch・build script の確保を独立タスクにし、最終 L1 ゲートを追加した。
apt 以外の Bun、Python wheel の内包 library、fonts、native bundle も対象にする。source archive は利用時ダウンロードを必須にせず、同じ release で提供する。

この変更で増える主要コストは配布パイプラインと継続保守。単なる bwrap argv 変換で済むという初期見積りには戻さない。

## 最終再レビュー

Nix 不要・配布ライセンス条件を反映した spec/plan を 2 名が再確認した。ゲート循環、native build の責務、runtime/proxy 境界、guardian 回収について重大な矛盾の指摘は残っていない。旧案の Nix store Bash 前提を配布 rootfs の実 Bash パスに訂正した。

これは文書の整合性・実装可能性の評価であり、ホスト受入試験や実際の配布物のライセンス確認を終えたという意味ではない。
