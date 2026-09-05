---
title: 推奨設定
description: capability を必要最小限に保ち、承認と保存データを運用する
---

まず最小 profile を起点にし、必要な capability を一つずつ追加します。追加・変更した `.nas/*.pkl` は diff を確認してから [設定の基本](/nix-agent-sandbox/getting-started/configuration/) の `nas config trust` を実行してください。信頼済み repository であっても、agent が使える resource は設定どおりに広がります。

## mount と認証情報

- `extraMounts` は単一 file または小さい directory を `ro` で渡し、`rw` は host へ変更を残してよいものだけにします。実行ファイル、PATH directory、HostExec が読む設定を agent から writable にしません。
- cloud config mount、GPG agent、DBus、Nix socket は「コンテナ内で便利な設定」ではなく、対応する host credential / daemon を使う capability です。専用 profile と短命・最小権限 credential に分け、使わない profile では false にします。
- secret は named registry から host 側で解決します。生値を profile の通常 `env` や bind mount に置かないでください。HostExec 注入値を出力で伏せるには、同じ取得元を profile `secrets` と `mask.apply` にも登録します。
- `cmd:` source は host の `sh -c` を実行します。非実行の source で足りるなら `env:`、`file:`、`dotenv:`、`keyring:` を使い、必要な場合も review 済み trusted config 内の短く固定した最小 command に限ります。agent や repository が書き換えられる文字列・script を補間または実行せず、設定変更後は diff と `nas config trust` を確認します。

関連する具体的な設定は[追加マウント](../risks/#extra-mounts)、[cloud config mounts](../risks/#cloud-config-mounts)、[GPG agent](../risks/#gpg-agent)、[DBus](../risks/#dbus)を参照してください。

## HostExec と承認

- `argv0` は immutable な絶対 path を優先し、`argRegex`、`cwd`、`inheritEnv { mode = "minimal" }` を狭めます。shell、language runtime、package manager、editor、build runner の広い委譲は任意 code execution を運びます。
- `approval = "prompt"` と `--scope once` を基本にし、`allow` と capability reuse は実際に同じ narrow operation を繰り返すと確認してから選びます。pending の command、cwd、rule、scope を approval 前に読みます。
- `unsafe-inherit-all` は host の token を広く露出し得ます。必要な値だけ `inheritEnv.keys` または rule-scoped secret injection にします。
- relative `argv0` は workspace root を固定しません。現在の `workspace-only` は子 directory も許すため、workspace の wrapper は one-shot review 用と割り切るか、workspace 外の immutable な absolute wrapper を使います。
- `fallback = "deny"` を設定しても current runtime は per-rule fallback を切替えません。rule 不一致は fallback response になり、container command の成功も保証しません。HostExec を deny boundary の代替にしないでください。

[HostExec のリスク](../risks/#hostexec)と[相対 path recipe](/nix-agent-sandbox/recipes/relative-hostexec/)を必ず併読してください。

## network、UI、保存データ

- network scope は exact target、method、path、`expect` を最初に狭め、fallback は `deny` を基本にします。review approval の再利用は `once` から始めます。WebSocket は opening request だけを一度認可し、message ごとの review はしません。
- host loopback へ必要な port だけを forward し、service 自身にも認証を置きます。forward relay は service の access control を追加しません。
- UI は loopback でも shared host の untrusted local user に対する認証境界ではありません。browser profile、desktop notification、approval 操作、History / Audit を同じ host の trusted user だけに渡します。
- `requestBodyAudit` は例外的な調査でだけ使い、短い `retentionSeconds` と小さい `maxBodyBytes` / `maxTotalBytes` を設定します。body cleanup は `audit_log` metadata を削除しないため、audit DB 自体の access と lifecycle も host 側で管理します。
- Observability は prompt と tool content を保存し得ます。`enable = false` でも invocation history は残るため、保持期間を決め、無期限の `retention = null` は避けます。telemetry receiver が落ちると記録は欠け得るので、完全な監査証跡として扱いません。

[port forwarding](../risks/#port-forwarding)、[UI daemon](../risks/#ui-daemon)、[request-body audit](../risks/#request-body-audit)、[observability retention](../risks/#observability-retention) の各リスクも確認してください。

## sidecar と display の後始末

- `docker.shared` は使わず、古い profile に残っていれば削除します。DinD daemon と mutable state は session 専用ですが、public Docker Hub の `nas-registry-cache` は session 間で残ります。cache hit では新しい network approval が発生しないため、approval の有無を image の信頼確認にせず、必要なら digest を固定します。不要になった session sidecar は [運用の cleanup](/nix-agent-sandbox/operations/maintenance/) で対象を確認してから消します。
- xpra viewer に focus したときは keyboard と clipboard が agent application に届きます。表示中の agent を信頼できないなら display forwarding を有効にしません。
- `nas worktree clean` は active-session guard を持たず、`nas-*` 名の worktree と orphan `nas/*` branch を name-based に対象にします。agent/container が停止したことと対象 list を確認してから実行します。

## 関連ページ

- [機能別リスク](../risks/) — 既定値と resource の一覧
- [承認キューを操作する](/nix-agent-sandbox/operations/approvals/) — scope の実際の意味
- [Docker in Docker](/nix-agent-sandbox/features/docker/) — session state と永続 pull cache の扱い
- [X11 / xpra](/nix-agent-sandbox/features/display/) — input boundary
