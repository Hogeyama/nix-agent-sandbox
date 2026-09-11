# bwrap Backend Implementation Plan

Status: 保留（2026-09-12、ユーザー判断）。専用 Docker と Testcontainers の基本動作は実証できたが、現在の用途では導入・保守コストに見合う効果が明確でないため、検討をここで終了する。実装には進まない。再開時は起動速度・セットアップ負担などの導入効果を評価し、要件と設計を見直す。以下の本文は検討時点の記録として残す。

> **前提変更・実行保留:** ホスト環境の継承と、セッション専用 Docker による承認不要の Testcontainers 実行が必要。本文の Ubuntu rootfs 配布、Nix/devShell・DinD 非対応はこの用途を満たさないため再設計対象。32–45 コミットは新要件の見積りとして使用しない。[成立性の再検討](../notes/2026-09-11-bwrap-testcontainers-feasibility.md)を参照。

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` with `patched-superpowers` to implement this plan task-by-task. Steps use checkbox syntax for tracking. この計画は保留中のため実行しない。再開時は導入効果・要件・設計を見直し、計画を更新してから適用する。

**Goal:** Docker なしで実際のエージェント、追加シェル、proxy、port relay を利用できる、明示選択の bwrap バックエンドを追加する。

**Architecture:** 配布 Ubuntu rootfs と隔離 netns を使い、通信は公開 Unix socket に限定する。Bun owner とホスト側 native bridge が寿命・PTY を所有し、隔離内 supervisor が agent・追加シェル・relay を同じ制約下で起動する。Docker の既存経路は既定として保持する。

**Tech Stack:** Bun/TypeScript、Effect、Pkl、bubblewrap 0.11.2、配布 tar.gz/libarchive、Linux namespaces/seccomp、Unix sockets、既存ネイティブ実装と同じ Zig 0.15。Nix/Docker は CI のビルドに利用可能だが、利用ホストの必須依存にしない。

**Spec:** [bwrap バックエンドの段階導入](../specs/2026-09-11-bwrap-backend-design.md)

**実行準備:** [長期実行前の懸念と試行案](../notes/2026-09-11-bwrap-execution-risks.md)。ホスト検証経路、途中再開、要件別完了判定は未確定。現段階で全工程の一括実行へは進まない。

## Global Constraints

- Docker バックエンドを既定のまま保ち、Linux 向けに明示選択の bwrap バックエンドを追加する。
- `docker.enable = true` は bwrap では起動前エラーにする。Docker に自動フォールバックしない。
- 初期検証基準の bwrap は 0.11.2 とする。
- ホストの `/`、home 全体、`/run` 全体を bind しない。
- dtach は GPL-2.0-or-later の外部ホストコマンドとして維持し、guardian へコードを取り込まない。配布物は component ごとにライセンス・対応ソース条件を満たす。
- nas と bwrap バックエンドは Nix/Docker なしで取得・起動・運用できる。runtime は配布 archive から取得する。エージェント内の Nix/devShell 構築は初期版では非対応とする。選択した profile の `nix.enable = false` を要求する。
- `--cap-drop ALL` を明示し、NoNewPrivs と実効・許可・継承・ambient capability の状態を子と追加シェルで検査する。
- seccomp profile 未生成・読込失敗時は起動を拒否する。
- stage は pure planner と stage-facing service の呼び出しだけを行う。I/O、起動、cleanup は service が所有する。
- 実装者とレビュアーは `AGENTS.md`、`skills/security-constraints/SKILL.md`、`skills/effect-separation/SKILL.md`（L2 は `references/domain-service.md` も）、`skills/test-policy/SKILL.md` を読む。
- native build は既存 flake の Zig 0.15 を利用する。独自のバージョン追従を追加しない。
- 各タスクを意味のある単位でレビュー・コミットする。コミットは `git-commit` に従い、diff 外の判断理由を記録する。
- 現在の worktree は `.worktrees/bwrap-assessment`、ブランチは `docs/bwrap-assessment`、検討基準は `6b152b9b`。実装前にリベースする方針はユーザー確認済み。リベース後に baseline を再取得し、最初の実装前の HEAD を `implementation-base` に記録する。

## 分割と完了の扱い

Task 1 は G1/G2/G3a（offline runtime）を判定する独立した実証タスク。後続実装に依存する G3b は Task 10 で判定する。Task 1 合格後に Task 2 で候補 rootfs の配布ライセンス条件を整え、Task 3 で配布物の取得・展開（G0）を実装し、G0/G1/G2/G3a と候補 rootfs の配布条件確認前に Task 4–9 の実装へ進まない。
Task 4–9 は一つの実験的バックエンドを構成し、個別にマージしても bwrap を利用可能と告知しない。Task 10 で公開条件を確認する。
実証によって rootfs・seccomp・supervisor の契約が変わる場合、spec とこの plan を改訂して再レビューする。未検証を成功扱いして実装を進めない。

## コミット数と実装タスクの粒度

以下の Task 1–10 は工程の大項目であり、1 項目を 1 コミット・1 implementer に割り当てる粒度ではない。
実装の初期見積りは **32–45 コミット（中心は約 40）**。レビュー修正を個別コミットにする作業中の履歴は **40–55 程度**を見込む。
この数は文書コミットを含まず、実証で設計が成立した場合の概算。未知の host ABI/seccomp/FUSE 問題で増える可能性がある。

| 大項目 | 想定コミット数 | 分割する責務・挙動 |
| --- | ---: | --- |
| Task 1: rootfs とホスト実証 | 3–4 | 固定 runtime ビルド、namespace/ABI probe、FUSE/seccomp 実証、必要な互換修正 |
| Task 2: ライセンス・配布条件 | 2–3 | inventory と対応ソース収集、表示・配布検証、release gate |
| Task 3: 取得・展開・cache | 4–5 | manifest 検証、取得の中断処理、安全展開、cache 競合/参照管理、host bundle |
| Task 4: 設定・起動前検証 | 2–3 | schema/既定値、互換性検証、CLI 副作用前の分岐 |
| Task 5: 共通実行意図・argv | 3–4 | backend 固有型の分離、argv compiler、runtime mount/env/launcher、Docker 回帰 |
| Task 6: proxy/CA | 3–4 | local proxy の Unix 上流、service 側 bwrap/addon、共有 CA 初期化、認証・通信回帰 |
| Task 7: supervisor/guardian | 7–10 | native build/IPC、agent 起動、PTY/追加 shell、resize/signal/backpressure、host bridge、子孫回収、owner 死亡、identity/回復、bundle/障害試験 |
| Task 8: pipeline/host 連携 | 3–5 | Docker 不使用経路、hostexec/mask mount、maskfs preflight、relay 起動・再起動、統合回帰 |
| Task 9: CLI/UI | 3–4 | registry の互換読み込み、一覧/停止、追加 shell、混在時の cleanup |
| Task 10: 受入・公開 | 2–3 | host E2E/障害受入、利用ガイド、最終配布検証と公開条件 |
| **合計** | **32–45** | レビュー修正による追加コミットは別枠 |

テストだけ・型だけを切り出して件数を増やさず、一つの挙動変更とその検証を同じコミットに含める。
実装着手時は直近の大項目をこの責務単位の task brief に分割し、各 brief に対象ファイル・入出力・完了条件を確定する。
`subagent-driven-development` とコミットごとのレビューは、その分割した単位で回す。特に Task 7 全体を一人の implementer に一括で渡さない。
最初の host probe が不成立なら、残りの約 40 コミットを機械的に進めず spec と見積りへ戻る。

## 境界の共通契約

新規 `src/bwrap/types.ts` に backend の入力と識別子を置く。既存の `MountSpec`、`EnvPlan`、`CommandSpec` は `src/pipeline/state.ts` から再利用する。
以下は実装時に維持する型契約であり、Docker の `extraRunArgs` を受け取らない。

```ts
import type { CommandSpec, EnvPlan, MountSpec } from "../pipeline/state.ts";

export type BwrapPlan = {
  readonly rootfs: string;
  readonly workDir: string;
  readonly mounts: readonly MountSpec[];
  readonly env: EnvPlan;
  readonly command: CommandSpec;
  readonly seccompPath: string;
  readonly proxySocket: string;
};
export type SandboxIdentity = {
  readonly backend: "bwrap";
  readonly sessionId: string;
  readonly bootId: string;
  readonly pid: number;
  readonly startTimeTicks: string;
  readonly ownerSocket: string;
};
export type SandboxPhase =
  | "starting" | "running" | "stopping" | "exited" | "failed";
```

`startTimeTicks` は桁落ちを避ける文字列。raw PID を外部コマンドの対象にする API を提供しない。
`BwrapPlan` の env は秘密のない許可済みデータのみ。seccompPath はホスト側入力で、子への argv にホスト秘密パスを埋め込まない。

## Task 1: ホストで rootfs と隔離の成立性を実証する

**Files:** Create `packaging/bwrap/Dockerfile`, `packaging/bwrap/runtime-lock.json`, `scripts/build_bwrap_runtime.sh`, `scripts/bwrap/probe.sh`, `docs/superpowers/notes/2026-09-11-bwrap-host-probes.md`; Modify `.github/workflows/release.yml`。

**Consumes:** 既存 Dockerfile のツール一覧、runtime の固定依存、spec G1/G2/G3a。
**Produces:** version/arch 別の rootfs tar.gz と manifest 候補、および各 probe の host/version/command/exit code を記載した結果。

- [ ] Dockerfile の各パッケージを「runtime 必須／既存 host 連携／Docker 専用」に対応づけ、必須 CLI と Bash/Bun/CA、固定 Python/mitmproxy 環境を派生 Dockerfile にまとめる。base digest、Bun、Python 依存を runtime-lock.json に固定し、rootfs を flatten/normalize して tar.gz にする。ENV/ENTRYPOINT は launcher 設定へ明示移植する。`/bin/sh`、`/bin/bash`、`/usr/local/bin/bun` の解決先と ELF loader を実行確認する。
- [ ] 対応する各 agent と code-mode helper の配布形態を列挙する。Nix 以外から得たバイナリについても `--version` と ELF loader/依存を検査し、rootfs の互換 loader は実証した配布形態に限定する。任意バイナリの closure 自動解決は追加しない。
- [ ] `probe.sh` は `set -eu`、専用 `mktemp -d` と EXIT trap を使い、秘密のない synthetic workspace だけを mount する。以下の隔離を共通引数にする。

```bash
bwrap --unshare-user --unshare-pid --unshare-net --unshare-ipc \
  --unshare-uts --cap-drop ALL --die-with-parent --new-session \
  --ro-bind "$probe_rootfs" / \
  --proc /proc --dev /dev --tmpfs /tmp --clearenv \
  --setenv PATH /bin:/usr/bin:/usr/local/bin \
  /bin/sh -c 'id; cat /proc/self/status; cat /proc/net/route'
```

- [ ] rootfs 内 Bun で loopback listener と client の往復を確認する。ホストに用意した TCP listener には接続できず、明示公開した Unix socket の sentinel server だけ接続できることを確認する。timeout を各接続に設定する。
- [ ] ホスト専用 directory に偽 secret と偽 control socket を置き、sandbox から不可視であることを確認する。rw workspace の子に ro config を重ね、上書き・unlink が拒否されることを確認する。
- [ ] 既存 maskfs を allow_other なしで起動し、同 UID の bwrap から masked view を読む。FUSE が使えなければ「未検証」と記録し、G2 合格にしない。
- [ ] seccomp の初期 profile をホストで検証する。Docker の現行 profile を基準に対象 architecture と syscall を列挙し、Bun 起動に必要な範囲を記録する。BPF のロード失敗は起動失敗とする。
- [ ] Ubuntu 24.04 と NixOS で G1/G2/G3a の結果を記録する。kernel、実 bwrap パス、バージョン、AppArmor 条件を添付する。設定変更が必要なホストでは自動緩和しない。
- [ ] 結果と rootfs の不足をレビューし、spec を修正する。合格した範囲をコミットする。

**Commands:** CI で `bash scripts/build_bwrap_runtime.sh`、対象ホストで `bash scripts/bwrap/probe.sh`。期待値は G1/G2/G3a の実証結果がすべて合格し、後続タスクで用いる runtime の依存と制限が確定すること。

## Task 2: 配布 inventory とライセンス条件を満たす

**Files:** Create `packaging/bwrap/license-policy.json`, `scripts/collect_bwrap_licenses.ts`, `scripts/check_bwrap_distribution.ts`; Modify `scripts/build_bwrap_runtime.sh`, `.github/workflows/release.yml`。

**Consumes:** Task 1 の固定 component と候補 binary archive。現在の nas/native bundle も inventory 対象に含める。
**Produces:** SBOM、LICENSES/NOTICE、binary/source 対応 manifest、必要な source/patch/build script archive、候補 rootfs の検証結果。L1 全体は後続 native binary を含め Task 10 で再確認する。

- [ ] apt だけでなく base image、Bun、Python wheel と内包 native library、フォント、bundle の全共有・静的 library を列挙する。version/architecture/digest/取得元/ライセンス/リンク形態を記録する。
- [ ] rootfs のパッケージ一覧から不要な Docker CLI/compose と未対応 GUI component を外す。dtach、host bwrap、fusermount3、agent 本体が archive に混入していないことを確認する。
- [ ] exact source package と distro patch をビルド時に確保する。上流 URL だけを保存して完了にしない。直接取得した package の対応 source とビルド用 script も同じ版で保存する。
- [ ] 第三者著作権・LICENSE/NOTICE を archive に残し、全体を MIT と表示しない。LGPL 等の library は採用するリンク方式での置換・再リンク要件も確認する。
- [ ] guardian/extractor に再利用するコードの出自をレビューし、dtach ソースの取り込みを防ぐ。未判定・非互換・必要資料不足の component は検証エラーにする。
- [ ] release に binary と同じ場所から取得できる source artifact と対応表を含める。source は利用時に自動取得しない。SBOM/source/表示が欠けた fixture に対して distribution checker が nonzero となることを確認する。
- [ ] x86_64/aarch64 ごとに checker を通し、公開ジョブが全検証完了を待つ依存関係にする。レビュー・コミットする。

**Commands:** CI で `bun scripts/collect_bwrap_licenses.ts`、`bun scripts/check_bwrap_distribution.ts`。期待値は全 binary の出自と必要な配布物が対応づき、未判定 0 件。法的条件を単純な SPDX 文字列一致だけで承認しない。

## Task 3: Nix/Docker 不要の取得・安全展開を実装する

**Files:** Create `src/bwrap/runtime_manifest.ts`, `src/bwrap/runtime_download_service.ts`, `src/bwrap/runtime_download_service_test.ts`, `src/bwrap/native/src/extract.zig`, `src/bwrap/native/build.zig`, `src/bwrap/runtime_extract_integration_test.ts`; Modify `flake.nix`, `.github/workflows/release.yml`。

**Consumes:** Task 1–2 の archive/manifest と配布条件、公式 release の HTTPS endpoint。
**Produces:** 検証済み digest cache の rootfs path とセッション中の参照 handle。このタスクでは Nix 不要の extractor を同梱し、guardian は Task 7 で追加する。

```ts
export type RuntimeManifest = {
  readonly formatVersion: 1;
  readonly nasVersion: string;
  readonly architecture: "x86_64-linux" | "aarch64-linux";
  readonly archiveName: string;
  readonly sha256: string;
  readonly compressedBytes: number;
  readonly maxUnpackedBytes: number;
  readonly maxEntries: number;
  readonly components: Readonly<Record<string, string>>;
};
```

- [ ] schema の型・サイズ・version/arch 一致を検証する。nas と同版の公式 release を使い latest を追わない。manifest の信頼元は nas と同じ release publisher として明記し、独立署名検証と混同しない。
- [ ] download service は digest ごとのロックを獲得し、圧縮サイズ上限以内で staging へ取得する。SHA-256 不一致、HTTP/timeout、切断で一時ファイルを消し、未検証 rootfs を返さない。
- [ ] bundled extractor を libarchive で実装する。絶対 entry/..、symlink 経由書込、外向き hardlink、device/FIFO/socket を拒否。所有者・mode を正規化し setuid/setgid と capability xattr を落とす。entry 数と展開サイズを制限する。
- [ ] 検証後だけ digest cache へ atomic rename。既存 cache の破損と同時取得を試験する。生存セッションが参照中の cache は GC しない。
- [ ] download service の pure validation と Fake transport は unit、libarchive とファイル展開は integration とする。malicious archive fixture は上記各脱出型、重複 path、truncated gzip、digest 不一致を含める。
- [ ] Nix/Docker を導入していない Ubuntu ホストで空 cache から取得・展開する。distro bwrap、release nas/extractor が rootfs 起動前に動き、/nix/store の不在をエラーにしないことを確認する（G0）。Nix ビルド由来の host ELF loader/RPATH が残る bundle は不合格。
- [ ] release.yml の x86_64/aarch64 両方に runtime と manifest/helper を含め、未検証 architecture はリリース対象から明示除外する。レビュー・コミットする。

**Commands:** `bun test src/bwrap/runtime_download_service_test.ts`、依存を同梱したホストで `bun test src/bwrap/runtime_extract_integration_test.ts`。空 cache の G0 は Nix/Docker の両方を呼び出す fake command が失敗する PATH でも実行する。公開前は候補 artifact を同じ manifest/HTTPS 形態のテスト配布元から取得し、先に本番 release を公開する循環を作らない。

## Task 4: backend の選択と起動前検証を導入する

**Files:** Modify `src/config/Schema.pkl`, `src/config/types.ts`, `src/config/validate.ts`, `src/config/templates/eval.pkl`, `src/cli.ts`; Create `src/config/validate_sandbox_test.ts`, `src/bwrap/types.ts`, `src/bwrap/compatibility.ts`, `src/bwrap/compatibility_test.ts`。

**Consumes:** Task 1 の対応機能一覧。
**Produces:** `sandbox.backend` の型と既定値、`validateBwrapCompatibility` の pure validation。対応 capability は起動時 probe の結果から渡す。

- [ ] Pkl → eval → TS の全経路で未指定が Docker となるケースを追加する。旧設定を変更せずロードできることを確認する。
- [ ] bwrap + DinD、profile の nix.enable=true/auto、Docker 固有設定、未合格 optional feature を個別エラーとして検証する。エラーには設定パスと Docker 選択方法を含める。
- [ ] Fake services の呼び出し記録で、不正設定時の CA/daemon/session 起動が 0 回であることを確認する。pipeline 前の `resolveBuildProbes` と `ensureUiDaemon` も検査対象にし、検証をその前へ移動する。
- [ ] valid bwrap でも Task 10 までは開発中の経路を一般利用者へ公開しない。未実装の backend を Docker に読み替えない。
- [ ] 次の分類表を fixture として使い、設定経路を実装・検証してコミットする。

| backend | docker.enable | 結果 |
| --- | --- | --- |
| 未指定 | false | 既存 Docker 経路 |
| docker | true | 既存 DinD 経路 |
| bwrap | true | 起動前エラー |
| bwrap | false | nix.enable=false のとき capability 検査へ |

**Commands:** `bun test src/config/validate_sandbox_test.ts src/bwrap/compatibility_test.ts`。Pkl 実行の検証は `src/config/pkl_integration_test.ts` に追加し、Pkl のある環境で別途実行する。

## Task 5: 共通実行意図と bwrap argv を分離する

**Files:** Modify `src/pipeline/state.ts`, `src/pipeline/container_plan.ts`, `src/stages/launch/stage.ts`, `src/stages/launch/container_launch_service.ts`; Create `src/bwrap/compile.ts`, `src/bwrap/compile_test.ts`, `src/bwrap/runtime_service.ts`。

**Consumes:** `BwrapPlan`、Task 3 で検証済みの rootfs と Task 1 の seccomp。
**Produces:** `compileBwrapArgs(plan: BwrapPlan): readonly string[]`。service が profile FD、socketpair、runtime mount の実体を解決し、planner は I/O しない。

- [ ] Docker 固有の image/network/extraRunArgs を backend の判別可能 union に分離する。既存 Docker argv テストが同じ結果になる形で段階移行する。
- [ ] bwrap argv に namespace、cap drop、clearenv、proc/dev/tmp、ro runtime、workspace、最後に保護ファイルを配置する。`--` 以降だけを supervisor コマンドにする。
- [ ] 任意文字を含む source/target/argv を shell 文字列へ連結せず配列として渡す。重複 mount の意図しない上書きと host root/home/runtime directory の公開を拒否する。
- [ ] env ops、CA/JVM、passwd/group、真の Bash と wrapper を runtime service で準備する。plain direnv は隔離内で実行し、失敗時は agent を起動しない。runtime cache の参照を acquire 時に確保し終了時に解放する。optional な Nix 由来 agent の閉包は別途 GC root を保持する。workspace の .envrc/shellHook はホスト側で評価しない。秘密ファイルと control socket を mount 候補に含めない。
- [ ] 次のような境界検証を実装する。`plan` は synthetic fixture とし、秘密の実値を使わない。

```ts
const args = compileBwrapArgs(plan);
expect(args).toContain("--unshare-net");
expect(args).toContain("--clearenv");
expect(args).not.toContain("--share-net");
expect(args).not.toContain("CAP_NET_ADMIN");
```

引数比較だけで隔離を証明した扱いにしない。Task 10 で実挙動を確認する。

- [ ] unit と Docker compile regression を実行し、レビュー・コミットする。

**Commands:** `bun test src/bwrap/compile_test.ts src/pipeline/container_plan_test.ts`、`bun run test:unit`。

## Task 6: proxy と CA を Docker から独立させる

**Files:** Modify `src/stages/proxy/stage.ts`, `src/stages/proxy/proxy_service.ts`, `src/stages/proxy/ca_service.ts`, `src/docker/embed/local-proxy.mjs`, `src/docker/mitmproxy/nas_addon.py`, `flake.nix`; Create `src/bwrap/proxy_service.ts`, `src/bwrap/proxy_integration_test.ts`。

**Consumes:** sessionId、既存 authz runtime paths と addon、配布 runtime の Python/mitmdump。
**Produces:** stage-facing service の acquire が返す `{ socketPath, caCertPath, close }`（close は Effect、複数回呼んでも安全）。

- [ ] 配布 mitmproxy の固定バージョンを記録し、現行 mitmproxy 11 用 addon の API 互換性を実行確認する。mitmdump の service rootfs 用起動引数を既存 proxy 設定と照合する。固定 `/nas-network` と Docker host 名を runtime path に置換し、addon 内の接続先も追跡する。
- [ ] Docker/bwrap 両方の CA 生成経路を同じロックに参加させ、初期化の競合を防ぐ。private key は host-only、公開 CA だけを agent 側 runtime に供給する。
- [ ] agent とは別型の `ProxyRuntimePlan` と別 compiler で service 側 bwrap を作り、host network と loopback listen の mitmdump を起動する。配布 rootfs は ro、CA/addon/broker は明示 mount、DNS は host resolv.conf 実体 snapshot、公開 trust bundle を渡す。host /run 全体を公開しない。Unix gateway もセッション単位で起動する。health check が通るまで endpoint を公開しない。各 acquire の直後に finalizer を登録する。
- [ ] local proxy に明示 Unix upstream を追加し、HTTP request の `socketPath` と CONNECT の `netConnect({ path })` を両方切り替える。Docker 用 TCP 経路は保持する。
- [ ] synthetic upstream と addon の実行試験で、許可 HTTP/CONNECT、deny、token 失効、upstream 切断、半閉鎖、認証ヘッダ非漏洩を確認する。
- [ ] Docker+bwrap の同時初回 CA 生成、および bwrap 二セッション同時起動と一方の終了で、他方の proxy と共有 CA が壊れないことを確認する。レビュー・コミットする。

**Commands:** `bun test src/stages/proxy/proxy_service_test.ts`、依存のあるホストで `bun test src/bwrap/proxy_integration_test.ts`。

## Task 7: supervisor と owner の寿命を実装する

**Files:** Create `src/bwrap/native/src/main.zig`, `src/bwrap/native/src/host_bridge.zig`, `src/bwrap/protocol.ts`, `src/bwrap/supervisor_integration_test.ts`, `src/domain/sandbox/service.ts`, `src/domain/sandbox/service_test.ts`, `src/domain/sandbox/types.ts`; Modify `src/bwrap/native/build.zig`, `flake.nix`, `.github/workflows/release.yml`。

**Consumes:** bwrap argv、proxy handle、`SandboxIdentity`。
**Produces:** L2 `SandboxService` の `start`, `openShell`, `stop`, `list`。Effect Tag/Live/Fake と plain-async adapter は domain-service 規約に従う。

- [ ] Zig helper を隔離内 supervisor として package する。native 部分に fork/exec、PTY、SCM_RIGHTS、child wait をまとめ、TypeScript で擬似 fork を作らない。ホスト用 bridge も同じ build に含め、Bun owner は framed stdio のみで接続する。
- [ ] socketpair protocol は version=1、requestId、`spawnShell`/`resize`/`signal`/`shutdown` と response の exit status に限定する。長さ上限 64 KiB、未知 version/op は拒否。argv は配列、env は allowlist。
- [ ] 隔離側の制御 FD は supervisor のみ保持する。spawnShell は固定の runtime launcher を起動し、外部から host executable/任意 FD を指定させない。PTY master だけを native bridge に返す。bridge は受信個数・PTY 型を検証し、未知 ancillary/余分な FD を close して拒否する。Bun owner には FD を渡さず typed data/control frame として転送し、backpressure を伝達する。
- [ ] bridge を bwrap の直接の親にし、owner 通信 EOF/死亡で全子を停止する。親死亡通知は cleanup handler が受ける SIGTERM とし、設定前後に親 PID を照合して race を塞ぐ。bridge 死亡時の bwrap 終了と owner 側 failed 遷移も試験する。制御 FD は子で明示 close し、/proc/self/fd の走査で agent と追加 shell へ漏れないことを確認する。
- [ ] bwrap の seccomp/NoNewPrivs/cap drop を supervisor が継承し、agent と追加 shell が fork/exec 後も同じ制約を持つことを `/proc/self/status` と拒否 syscall で検証する。
- [ ] owner は starting の記録後にリソースを獲得し、readiness 後だけ running とする。例外は failed とし逆順解放する。
- [ ] detach では生存、agent 終了/owner crash では全子終了、TERM → 5 秒 → KILL、relay 連続 3 回失敗で failure を実装する。reap 後に socket を削除する。
- [ ] `SandboxIdentity` の bootId/startTimeTicks 不一致で stop が kill を実行しない unit test と、pidfd を使う実停止の integration test を追加する。native helper が pidfd を先に取得してから identity を再検査し、確認後に pidfd 宛に signal を送る順序を固定する。pidfd を取得できない孤児は診断して kill を省略する。
- [ ] bridge を guardian として、専用 runtime directory を秘密生成より前に作成・FD 保持する。Task 6 のセッション専用 mitmproxy/gateway と Task 8 の FUSE 等の spawn を bridge の host-only API に接続する。spawn 登録前に owner へ成功を返さない。共有 daemon/CA は停止・削除せずセッション登録だけ解除する。
- [ ] owner に SIGKILL を送り、guardian の EOF/親死亡 handler が sandbox と host 子プロセスを停止/reap して frame/socket を消すことを確認する。guardian は必要に応じて subreaper で子孫を回収し、終了確認後に directory を削除する。bridge 自身の SIGKILL は次回起動前 recovery で処理し、生存 guardian の identity も確認して回収中の処理との競合を防ぐ。identity 不一致・削除不能では再開拒否と診断にする。即時cleanup保証と起動時回復を混同しない。
- [ ] broker/frame cleanup の失敗はログに残すが他の finalizer を止めない。各獲得地点で失敗を注入し漏れがないことを確認する。レビュー・コミットする。

**Commands:** native directory で `zig build test`、`bun test src/domain/sandbox/service_test.ts`、ホストで `bun test src/bwrap/supervisor_integration_test.ts`。

## Task 8: pipeline と既存 host 連携を接続する

**Files:** Modify `src/cli.ts`, `src/pipeline/types.ts`, `src/stages/launch/container_launch_service.ts`, `src/stages/port_bind/port_bind_service.ts`, `src/stages/mount/stage.ts`, `src/stages/hostexec/stage.ts`, `src/stages/maskfs/maskfs_service.ts`; Create `src/bwrap/pipeline_test.ts`。

**Consumes:** Tasks 4–7、既存 hostexec/mask/OTLP の handle。
**Produces:** bwrap 選択時に pipeline 内外を通じて Docker/Nix CLI を一度も起動しない標準経路。

- [ ] CLI の副作用前に backend を選択し、Docker 専用の `resolveBuildProbes` を bwrap で呼ばない。UI daemon の bwrap query が Docker 不在でも成立することを検査する。backend 選択後に pipeline を構成し、bwrap では DockerBuild/Dind/Docker proxy の acquire を行わない。
- [ ] 共通 mount/environment の計画を維持し、配布 runtime service と bwrap proxy service の出力を launch に渡す。stage 内に primitive I/O を増やさない。
- [ ] hostexec の exec socket と公開 wrapper、mask socket、maskfs view、OTLP socket のみを mount する。各 host-only sibling path の不可視を fixture にする。maskfs_service の allow_other preflight と `--allow-other` 引数は Docker の従来値を保ち、bwrap では Task 1 で実証した同 UID 用設定に分岐する。
- [ ] port relay を supervisor 起動へ接続し、再起動を `docker exec` から backend 操作へ分岐する。bind/forward の gateway と registry の外部契約を維持する。
- [ ] Fake DockerService を「呼び出すと失敗」の実装にして bwrap pipeline を実行する。CLI 起動試験では PATH 上の fake docker/nix に呼出記録を残させ、pre-pipeline と UI daemon を含め呼出 0 回を検査する。Docker backend 側も既存テストを実行する。
- [ ] plain direnv の隔離内実行と失敗時中断、動的 env ops、Bash wrapper の直接起動、mask broker 停止時の出力抑止をホストで確認する。レビュー・コミットする。

**Commands:** `bun test src/bwrap/pipeline_test.ts`、`bun run test:unit`。

## Task 9: CLI/UI の一覧・追加シェル・停止を接続する

**Files:** Modify `src/domain/launch/service.ts`, `src/domain/session/service.ts`, `src/domain/container/service.ts`, `src/domain/container/lifecycle_service.ts`, `src/stages/session_store/session_store_service.ts`, `src/cli/session.ts`, `src/ui/data.ts`; Extend adjacent `*_test.ts`。

**Consumes:** `SandboxService` と backend-aware registry。
**Produces:** Docker/bwrap 混在時に対象セッションだけを操作する domain API。

- [ ] 旧レコードは Docker と解釈し、新レコードには backend と identity を保存する。bwrap PID を containerName として保存しない。
- [ ] session list の backend 表示と owner lookup を追加する。bwrap セッションの追加 shell を `SandboxService.openShell` に渡し、dtach の TTY resize/signal/exit status をつなぐ。
- [ ] stop/clean の dispatch を backend で分け、Docker resource clean の既存動作を保持する。stale bwrap registry は identity 検査を通して処理する。
- [ ] 混在、旧レコード、存在しない owner、PID 再利用、他セッション終了禁止のケースを Fake Layer で確認する。
- [ ] ホストで UI から追加 shell を開き、CLI で detach/attach/stop し、双方の表示が一致することを確認する。レビュー・コミットする。

**Commands:** `bun test src/domain/launch/service_test.ts src/domain/session/service_test.ts src/domain/container/service_test.ts src/domain/container/lifecycle_service_test.ts`。

## Task 10: 受入試験と実験的 backend の公開

**Files:** Create `tests/bwrap_e2e_test.ts`; Modify `docs/todo/bwrap.md`, `docs/superpowers/notes/2026-09-11-bwrap-host-probes.md`; Modify `docs-site/src/content/docs/getting-started/installation.md`, `docs-site/src/content/docs/configuration/development.md`, `docs-site/src/content/docs/work/sessions.md`, `docs-site/src/content/docs/security/isolation.md`（先に `docs-site/AGENTS.md` を読む）。

**Consumes:** Tasks 1–9 と spec G0–G6 と L1。
**Produces:** 対応ホスト別の結果表、対応機能の確定値、公開設定と導入ガイド。

- [ ] host capability の skip predicate を設ける。bwrap が起動できない場合は理由を記録して skip し、対応ホストの受入実行では必須ゲート G0–G5 の skip が一つでもあれば合格としない。未対応の G6 は skip 理由と機能拒否を確認する。
- [ ] 対応表の実 agent と sibling helper を非 secret fixture workspace で起動し、hostexec 承認、マスク、許可/拒否 proxy、直接 egress 拒否、port bind/forward、追加 shell と停止までを連続実行する。
- [ ] secret/control socket 不可視、環境非漏洩、owner SIGKILL、失敗途中 cleanup を実証する。bridge SIGKILL 後は次回起動時 recovery と再開拒否を確認する。全残存 PID/socket/frame を session identity で検査する。
- [ ] optional integrations を個別実行し、未合格の機能は設定有効時に明示エラーとなることを確認する。
- [ ] G0–G5 と L1 合格後に bwrap の公開を有効化する。Docker が既定であることと未指定設定の回帰を確認する。
- [ ] 導入ガイドに Nix 不要であること、distro bwrap と既存 FUSE/dtach 依存、runtime 配布・cache 条件、実例、DinD と agent 内 Nix/devShell の非対応、plain direnv の実行範囲、未対応機能、診断方法を記載する。元メモの未検証断定を訂正し spec へリンクする。
- [ ] `bun run fmt`、`bun run lint`、`bun run check` を実行する。対応ホストで最後に `bun run test` を **1 回** 実行し、Docker 回帰と bwrap E2E の pass/skip/fail を分けて記録する。
- [ ] 起動性能を測るなら cold/warm、runtime cache が存在するか、proxy 起動を含むかを固定し、Docker と同条件で測る。合否に架空のミリ秒目標を使わない。
- [ ] Task 2 の inventory/checker を最終 native bundle と runtime に再実行し、必要な対応ソース・表示・リンク条件を確認する（L1）。全 architecture の成果物が揃うまで公開ジョブを実行しない。
- [ ] 全体コードレビュー、指摘修正、ユーザーレビューへ進む。既定 backend の変更はこのタスクに含めない。

## 今回の文書作成時に確認したこと

- 専用 worktree は作成済み。プロダクトコードは変更していない。
- bwrap 0.11.2 は存在するが、このコンテナ内では namespace 作成を拒否された。G0–G6 はホスト実証待ち。L1 も実際の配布 artifact 作成時に検証する。
- 初回の依存導入は tempdir の AccessDenied で失敗した。その後ユーザーが `bun i` を実行し、同 worktree で `bun run test:unit` を再実行した結果は **3475 pass / 9 skip / 0 fail**（221 files、11.90 秒）。skip は maskfs の実 FUSE 試験であり、ホスト実証の合格には数えない。
- 文書のリンク、spec/plan の整合、差分を検証して提出する。上記タスクのチェックボックスは実装完了を示すもので、文書を作っただけではチェックしない。
