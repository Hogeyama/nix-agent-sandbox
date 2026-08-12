# Forgejow Session Lifetime Design

## Goal

`forgejow request-review` が起動した Forgejo を、NAS 固有の仕組みに依存せず、
そのコマンドを実行した Coding Agent のセッション寿命に結び付ける。

次の性質を同時に満たす。

- NAS の TTY が切れても Forgejo 自身は `SIGHUP` を受けない。
- `docker stop`、Coding Agent の終了、または tool process の取消しで
  `forgejow request-review` が終了すると、Forgejo も終了する。
- `forgejow down` による明示停止を引き続き利用できる。
- Docker、NAS、systemd user service の存在を前提にしない。

## Architecture

`forgejow request-review` を、PR を作って終了するコマンドから、Forgejo の寿命を保持する
foreground lease process に変更する。

```text
Coding Agent tool process
└─ forgejow request-review       agent 側の session / TTY に残る
   └─ Forgejo                   専用 SID / PGID、controlling TTY なし
```

`request-review` は従来どおり Forgejo を起動して PR を作り、URL とログイン情報を出力する。
出力後は、自身が起動した Forgejo の PID を `wait` し、コマンドをrunning状態に保つ。
Coding Agent は初期出力を受け取った時点でレビューを案内でき、tool process はバックグラウンドの
実行セッションとして残る。

Forgejo は `setsid` で新しい session と process group に移し、stdin を `/dev/null`、
stdout/stderr を既存の `web.log` に接続する。これにより Coding Agent 側の TTY hangup は
Forgejoには届かず、Forgejo 16.0.2 の `SIGHUP` graceful restart と `KillParent()` の競合を
発火させない。

## Lifecycle

### Startup

`fj_boot_once` は起動前に `setsid` が利用可能か確認する。安全でない同一 session への
fallback は行わず、利用できなければ理由を表示して失敗する。

Forgejo を起動したら、PID ファイルを従来どおり保存する。health check に加え、起動した
プロセスが次の条件を満たすことを確認する。

- process group ID が Forgejo の PID と等しい。
- session ID が Forgejo の PID と等しい。
- controlling TTY がない。

分離に失敗した場合はそのプロセスを停止し、起動失敗として扱う。

### Lease

PR情報の出力後、`cmd_request_review` は cleanup trap を設定して Forgejo を `wait` する。
trap は少なくとも `HUP`、`INT`、`TERM`、`EXIT` を扱い、現在のPIDファイルが指すForgejoを
停止する。同じcleanupが複数回呼ばれても安全なように、既に停止済み・run directory削除済みを
正常系として扱う。

Forgejoが自発的に終了した場合は`wait`が解除され、`request-review`も終了する。
別プロセスから`forgejow down`が呼ばれた場合も、Forgejoの停止によって同じようにleaseが終了する。

`SIGKILL`はtrapできないため、lease processだけが`SIGKILL`された場合の同期終了は保証しない。
通常のCoding Agent終了、TTY hangup、NAS/container停止で送られるcatch可能なsignalを対象にする。

## Command Behavior

`request-review`はURL等を出力した後も終了しない。Coding Agentから実行する場合、呼出側は
長時間実行としてyieldされた初期出力を読み、その実行セッションを閉じずにレビューを続ける。
`patched-superpowers`のPhase 3にも、`request-review`を長時間実行として起動し、返された
session/job handleをレビュー完了まで保持する手順を明記する。長時間実行を明示する必要がある
Coding Agentでは、そのagentのbackground execution機能を使う。

その他の`fetch-comments`、`push`、`reply`、`resolve`、`down`は別のコマンドとして実行し、
既存のrun directoryとPIDファイルを共有する。CLI usageには`request-review`がForgejoの停止まで
待機することを明記する。

同じrepositoryに対する`request-review`の重複実行は既存インスタンスを再利用する。このForgejoは
二つ目のコマンドの直接の子ではないため、Bashの`wait`は使えない。再利用時だけPIDの生存を有限間隔で
監視し、同じsignal trapを保持する。いずれかのleaseが終了すると共有インスタンスを停止する。
現行のrepository単位でインスタンスを一つだけ持つモデルと整合する挙動として受容する。

## Error Handling

- `setsid`がなければ起動前に明示的に失敗する。
- 分離後のSID/PGID/TTY検証に失敗したらForgejoを停止し、review serverを公開しない。
- PR作成やsmoke testが失敗した場合も、起動済みForgejoをcleanupしてから非zeroで終了する。
- signal cleanupでは停止済みPIDをエラーにしない。
- PID再利用による別プロセス停止を避ける既存課題は本変更の対象外とする。今回の変更では
  現行のPIDファイルによるidentityモデルを維持する。

## Testing

既存の実Forgejo統合テスト`skills/patched-superpowers/scripts/test_forgejow.sh`を拡張する。
スタブではForgejo自身のsignal処理とprocess topologyを検証できないため、引き続き実サービスを使う。

検証項目:

1. 起動したForgejoのPID、PGID、SIDが一致し、TTYがない。
2. `request-review`がPR情報を出力した後も生存している。
3. `request-review`へ`SIGTERM`を送るとForgejoが終了する。
4. `request-review`のprocess groupへ`SIGHUP`を送ってもForgejoへ直接届かず、graceful restartを
   起こさずにcleanupされる。
5. `forgejow down`でForgejoを停止すると、待機中の`request-review`も終了する。
6. 各テストのcleanupはwaiterとForgejoの両方を停止し、一時directory削除後にプロセスを残さない。

現在のテストは`request-review`の完了出力をcommand substitutionで取得しているため、出力ファイルを
使った非同期起動に変更する。期待するPR情報が出るまで有限時間でpollし、無期限にhangしないようにする。

## Scope

この変更は`forgejow`の起動・待機・cleanup、その統合テスト、および`patched-superpowers`の
Phase 3にある起動手順の更新に限定する。
hostexec broker、NAS container lifecycle、systemd unit、Forgejo upstreamは変更しない。
調査用に追加済みのprocess diagnosticsは、設計上必須にはせず既存変更として扱う。

## Why — なぜこのアプローチを選んだか

`request-review`をforeground leaseにすると、Coding Agentが既に提供しているtool processの寿命を
そのまま利用できる。NASではcontainer停止に伴うhostexec/tool process終了、NAS外では各Coding
Agentのtool process終了が同じcleanup経路になる。環境検出やDocker API、agent別session hookを
追加せずに汎用性を保てる。

Forgejoだけを別sessionへ移すことで、lifecycle通知を受けるwaiterと、TTY由来`SIGHUP`から守る
serverの役割を分離できる。今回の事故原因に直接対応しつつ、変更範囲もskill内に閉じる。

## Why Not — なぜ他の案を選ばなかったか

- **Forgejoを単に`nohup`またはbackground起動する** — 起動シェル終了後にreparentされ、Coding
  Agentとの寿命の関係を失う。TTYとのSID/PGID関係も解消しない。
- **Docker containerを`docker wait`で監視する** — NAS sandbox内でしか成立せず、通常のCoding
  Agent環境で使えるskillという要件を満たさない。
- **hostexec brokerにmanaged process APIを追加する** — NASでは堅牢だがNAS外を解決せず、今回の
  skill修正に対して変更範囲が大きい。
- **`systemd-run --user`でtransient service化する** — systemd依存を増やしてもCoding Agent
  session終了との対応付けには別のwatcherが必要になる。
- **agent別session-end hookから`forgejow down`を呼ぶ** — hookの有無と仕様がagentごとに異なり、
  強制終了時にも保証できない。
