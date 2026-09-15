# Dev Container 起動・接続経路 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Linux + Docker + VS Code で、nas が管理する Claude Code 用コンテナを起動・再接続・終了できるようにする。

**Architecture:** 既存パイプラインの最終起動計画を Docker と Compose で共有する。独立した supervisor がパイプラインの Effect Scope を保持し、ホスト専用の登録情報と制御 socket を使って init/up/status/down を管理する。コンテナの環境適用は通常 CLI と同じ direnv ランチャーへ集約する。

**Tech Stack:** Bun、TypeScript、Effect、Bash、Docker Compose v2、Linux の flock / setsid。Compose ファイルは JSON。YAML パッケージは追加しない。

状態: 実装計画のレビュー待ち。

## Global Constraints

- 仕様: [承認済み設計](../specs/2026-09-15-devcontainer-design.md)。目的と根拠は [元の構想](../../todo/devcontainers.md)。
- 実装者とレビュアーは `AGENTS.md`、`skills/effect-separation/SKILL.md` と `references/domain-service.md`、`skills/security-constraints/SKILL.md`、`skills/test-policy/SKILL.md` を読む。
- stage は純粋な計算、stage-facing service 呼び出し、結果返却だけを行う。
- domain から stage を import しない。パイプライン全体の組み立ては application 側に置く。
- ホスト専用ディレクトリは 0700、記録・Compose は 0600 とする。
- 状態遷移は `preparing → starting → ready → stopping → stopped`、失敗は `failed`。
- 起動全体の既定期限は 120 秒。ready 後の作業時間にこの期限を適用しない。
- 初版は DinD 無効・Nix 無効・Claude profile のみ。ホスト HOME 全体、SSH / GPG 転送、クラウド認証設定の共有は拒否。
- workspace は canonical path で固定し、profile に worktree 作成があれば拒否する。
- `shutdownAction` は `none`。明示的な `down` で終了し、認証・履歴・VS Code キャッシュは残す。
- 生の秘密、承認用 socket、ホスト Docker socket はコンテナへ渡さない。設定改変時や不明な Docker 指定は拒否する。
- 通常 CLI の挙動を維持する。Dev Container の制約を通常 CLI に適用しない。
- 実装対象は現在の worktree。元 checkout の未コミット変更には触れない。
- unit は `bun run test:unit`。ユーザーの AGENTS.md に従い、全実装の最後に `bun run test` を一度実行する。NAS 内の skip とホストでの実行結果を区別する。
- ファイルがないことだけを確かめる形式的な RED は作らない。入力・状態・終了順序に対する意味のある期待値を固定する。

## 読者と順序

この計画の読者は、設計を承認した保守者と、タスク単位で実装・レビューする担当者。
最初に接続契約の成立条件を押さえ、起動計画、設定の所有、実構成検査、環境、寿命、
CLI の順で結合する。最後に利用手順を実際の検証結果へ合わせる。
下記の契約はタスク間の引き継ぎに使い、別名の型や API を個別に導入しない。

## ファイル構成と依存関係

| Task | 主なファイル | 成果物 | 前提 |
| --- | --- | --- | --- |
| 1 | `tests/devcontainer_contract_e2e_test.ts`、検証記録 | Dev Containers の接続契約を実測する試験 | なし |
| 2 | `src/stages/launch/plan.ts`、`compose.ts` | 最終計画と Compose の純粋な変換 | なし |
| 3 | `src/domain/devcontainer/{types,policy,store,service}.ts` | 保護された登録・専用 state・設定生成 | なし |
| 4 | `src/docker/launch_inspection.ts`、`src/stages/launch/inspection.ts` | 外側からの実構成照合 | 2 |
| 5 | `src/docker/embed/devcontainer-*.sh`、既存 entrypoint | 初期化完了と共通環境の再適用 | 2、3 |
| 6 | `src/stages/launch/compose_session_service.ts`、`src/devcontainer/runtime.ts` | Compose コンテナと Scope の寿命 | 2–5 |
| 7 | `src/cli/devcontainer.ts`、`src/domain/devcontainer/supervisor.ts` | 利用者の init/up/status/down と通常 CLI 分岐 | 3、6 |
| 8 | `tests/devcontainer_e2e_test.ts`、`docs/devcontainer.md` | 結合・拒否試験、利用手順、全体レビュー | 1–7 |

新規 `src/domain/devcontainer.ts` と既存 `src/stages/launch.ts` の barrel 経由で外部へ公開する。
テストは実装の隣に置き、複数モジュールを貫くものを `tests/` に置く。

## 共通データ契約

Task 3 の `src/domain/devcontainer/types.ts` で定義する。登録情報と公開 status を分ける。

```ts
export type DevcontainerPhase =
  | "preparing" | "starting" | "ready"
  | "stopping" | "stopped" | "failed";

export interface DevcontainerRegistration {
  readonly version: 1;
  readonly workspaceId: string;
  readonly workspace: string;
  readonly profileName: string;
  readonly fingerprint: string;
  readonly configPath: string;
  readonly composePath: string;
  readonly stateRoot: string;
  readonly command: readonly string[];
}

export interface DevcontainerStatus {
  readonly workspaceId: string;
  readonly profileName: string;
  readonly phase: DevcontainerPhase;
  readonly sessionId: string | null;
  readonly containerId: string | null;
  readonly diagnostic: string | null;
}

export interface DevcontainerSessionRecord {
  readonly version: 1;
  readonly workspaceId: string;
  readonly fingerprint: string;
  readonly sessionId: string;
  readonly containerId: string | null;
  readonly phase: DevcontainerPhase;
  readonly controlSocket: string;
  readonly diagnostic: string | null;
}

export interface DevcontainerPaths {
  readonly registrationDir: string;
  readonly registrationFile: string;
  readonly composeFile: string;
  readonly operationLock: string;
  readonly claudeDir: string;
  readonly claudeJson: string;
  readonly vscodeDir: string;
}
```

`command` は `resolveNasCommand()` の `{execPath, prefix}` を配列化したもの。
コンパイル版と `bun run main.ts` の両方を維持し、shell 文字列へ連結しない。
session record は内部専用で、公開 status に socket・PID・env を混ぜない。
UDS は短い runtime パスに置き、Linux のパス長上限を検査する。

## Task 1: 接続契約の試験を作る

**Files:** Create `tests/devcontainer_contract_e2e_test.ts`、`docs/superpowers/research/2026-09-15-devcontainer-contract.md`。

**Consumes:** Docker Compose v2、Dev Containers CLI、VS Code、ローカルの既存イメージ。
**Produces:** 「initializeCommand 内で先に起動した Compose サービスに接続できる」という契約の試験結果。

- [ ] Step 1: `command -v` と各 CLI の version で利用可能性を記録する。この NAS 環境で `code` と `devcontainer` が見つからないことは確認済み。未実行は未実行のまま記録する。
- [ ] Step 2: テストの一時ディレクトリに Compose と devcontainer.json を作る。project 名は UUID から生成し、`initializeCommand` にマーカー作成と `docker compose up -d` を行うテスト専用スクリプトを指定する。
- [ ] Step 3: `devcontainer up --workspace-folder <tmp> --config <tmp>/.devcontainer/devcontainer.json` を実行し、次の期待値を検査する。

```ts
expect(initializedBeforeAttach).toBe(true);
expect(attachedContainerId).toBe(createdContainerId);
expect(secondAttachContainerId).toBe(createdContainerId);
expect(remoteIdentity).toEqual({ uid: 1000, home: "/home/nas-test" });
```

4 変数は fixture の marker、Dev Containers の JSON 出力、Docker inspect、
`devcontainer exec` 内の `id -u` / HOME 出力から取得する。remote user はイメージ内に
事前に存在する fixture を使い、root のまま成功させない。

- [ ] Step 4: 実行前に作られたコンテナにも `customizations.vscode.extensions` と settings が適用されるかを VS Code で確認する。CLI が起動できたことだけで拡張適用を確認済みにしない。
- [ ] Step 5: ファイルローカルの `dockerAvailable`、`composeAvailable`、`devcontainerAvailable`、`fixtureImageAvailable` をそれぞれ判定し、`test.skipIf` に渡す。`finally` で fixture 自身のコンテナとファイルを回収する。

Run: `bun test tests/devcontainer_contract_e2e_test.ts`。期待: 契約試験 pass、能力がなければ理由付き skip。
契約が否定された場合は後続の接続実装を確定せず、具体的な差と代案を設計へ戻す。
能力不足だけなら独立した Task 2–5 の実装は進め、実機確認待ちを ledger に残す。

- [ ] Step 6: `git-commit` に従って試験と実測記録をコミットする。

## Task 2: 最終起動計画と Compose を分離する

**Files:** Create `src/stages/launch/plan.ts`、`compose.ts`、`compose_test.ts`。Modify `stage.ts`、`stage_test.ts`、`src/stages/launch.ts`、`src/pipeline/state.ts`、`container_plan.ts`、`container_plan_test.ts`、`src/stages/mount/stage.ts` と対応テスト。

**Consumes:** `StageInput & Pick<PipelineState, "container">`。
**Produces:** 下記の公開関数。`ComposeDocument` は service `agent`、external network、name を持つ JSON の型として同じ `compose.ts` で定義する。

```ts
export function finalizeLaunchPlan(
  input: StageInput & Pick<PipelineState, "container">,
  extraArgs?: readonly string[],
): { readonly containerName: string; readonly container: ContainerPlan };

export function compileCompose(
  container: ContainerPlan,
  containerName: string,
  projectName: string,
): ComposeDocument;

export function serializeCompose(document: ComposeDocument): string;
```

- [ ] Step 1: `buildLaunchContainerPlan` の引数・管理 label 合成を `finalizeLaunchPlan` へ移す。`planLaunch` はそれを呼び、既存の `compileLaunchOpts` とログ出力を維持する。
- [ ] Step 2: `ContainerPlan` / `ContainerPatch` に任意の `shmSize: string` を加える。merge は指定時のみ置換し、MountStage の `--shm-size 2g` をこのフィールドへ移す。CLI compiler は元と同じ引数を生成する。
- [ ] Step 3: Compose 変換に以下を固定する。

```json
{
  "name": "nas-devcontainer-example",
  "services": {
    "agent": {
      "image": "nas-sandbox",
      "container_name": "nas-agent-sess_example",
      "working_dir": "/work/project",
      "command": ["/usr/local/bin/nas-devcontainer-idle"],
      "restart": "no",
      "logging": { "driver": "none" },
      "volumes": [{
        "type": "bind", "source": "/work/project", "target": "/work/project",
        "read_only": false, "bind": { "create_host_path": false }
      }],
      "networks": { "session": { "aliases": ["agent"] } },
      "environment": { "VALUE": "literal $$HOME\nsecond line" }
    }
  },
  "networks": { "session": { "external": true, "name": "nas-session-example" } }
}
```

この例の値は fixture 用。実装は確定計画から全 mount、env、extraHosts、label を写す。
env のキーは補間せず、値と他の文字列値の `$` を `$$` にする。
`NAS_ENV_OPS` は既存の `encodeDynamicEnvOps` の結果を使う。
network 未設定・container mode・残った `extraRunArgs` は明示エラーにする。
agent 起動引数は待機コマンドへ付加せず、Task 5 の専用ランチャー設定へ保存する。

- [ ] Step 4: テストで空文字、改行、`$HOME`、`${VAR}`、空白を含むパス、RO mount、alias、extraHosts、shmSize、管理 label、未知オプション拒否を固定する。

```ts
test("serializes literal dollar signs without changing environment keys", () => {
  const plan = {
    ...emptyContainerPlan("nas-sandbox", "/work"),
    network: { mode: "network" as const, name: "nas-test" },
    env: { static: { VALUE: "$HOME\n${MISSING}" }, dynamicOps: [] },
  };
  const doc = compileCompose(plan, "nas-agent-test", "nas-test");
  expect(JSON.parse(serializeCompose(doc)).services.agent.environment.VALUE)
    .toBe("$$HOME\n$${MISSING}");
});
```

Run: `bun test src/stages/launch/stage_test.ts src/stages/launch/compose_test.ts src/pipeline/container_plan_test.ts src/stages/mount/stage_test.ts`。期待: 既存 CLI の回帰を含め全件 pass。
- [ ] Step 5: 変更をコミットし、Task 2 の範囲を reviewer に渡す。

## Task 3: 登録情報と専用 state を管理する

**Files:** Create `src/domain/devcontainer.ts`、`src/domain/devcontainer/types.ts`、`policy.ts`、`policy_test.ts`、`store.ts`、`store_test.ts`、`config.ts`、`config_test.ts`、`service.ts`、`service_test.ts`。

**Consumes:** `Profile`、canonical workspace、`HostEnv`、`resolveNasCommand()`、既存の `loadConfig({ startDir })`。
**Produces:** 登録 CRUD と公開 status。`DevcontainerService` の初期メソッドは `init(workspace, profileName)` と `status(workspace)`。Task 7 で up/down を接続する。

- [ ] Step 1: `policy.ts` に `validateDevcontainerProfile(profile: Profile): readonly string[]` を定義する。agent が claude 以外、DinD、`nix.enable !== false`、worktree、GPG、AWS/gcloud の共有を設定キー付きで拒否する。許可外 fallback を持つネットワーク構成も拒否し、proxy を必須にする。
- [ ] Step 2: path policy に mount の canonical source と保護領域の祖先・子孫関係を渡す。文字列 prefix で `/home/a` と `/home/ab` を混同しない。別名の共有で管理領域・HOME・認証・Docker socket が露出する場合と、保護 target を上書きする場合を拒否する。
- [ ] Step 3: Task 3 の store は D1 のファイル操作と D2 の登録操作を分ける。state path は `XDG_STATE_HOME` または `~/.local/state` 配下、runtime は `resolveRuntimeSubdir` を使う。入力パスの symlink、通常ファイル以外、所有者不一致、過大な記録を拒否する。
- [ ] Step 4: operation lock は固定 inode の `flock` で保持し、ロックファイルを unlink しない。最初の init、停止後の再 init、up/down が同じ workspace lock を使える API にする。異常終了によるロック解除を実ファイルで試験する。
- [ ] Step 5: `init` の順序を固定する。

```text
canonicalize workspace → acquire operation lock → validate ownership
→ loadConfig (既存 trust の後に評価) → resolve/validate profile
→ prepare dedicated state → generate managed devcontainer config
→ fingerprint exact inputs → atomically publish registration
```

生成途中で失敗した場合は今回作成したものだけ回収する。既存 `.devcontainer`、
登録外ファイル、symlink は残してエラーにする。再 init は停止確認・旧所有記録の
一致を条件に nas 自身の生成設定を更新する。

- [ ] Step 6: `config.ts` の `renderDevcontainerConfig(registration, remoteUser)` は次の契約を出す。

```ts
return {
  name: "nas",
  initializeCommand: [...registration.command, "devcontainer", "up",
    "--workspace", registration.workspace],
  dockerComposeFile: [registration.composePath],
  service: "agent",
  workspaceFolder: registration.workspace,
  remoteUser,
  updateRemoteUserUID: false,
  overrideCommand: false,
  userEnvProbe: "loginInteractiveShell",
  shutdownAction: "none",
  customizations: { vscode: {
    extensions: ["anthropic.claude-code"],
    settings: {
      "claudeCode.claudeProcessWrapper": "/usr/local/bin/nas-devcontainer-claude",
      "remote.autoForwardPorts": false,
    },
  } },
};
```

Git/SSH 資格情報転送を停止する設定は対象 Dev Containers 版のサポート箇所で確認して
同時に生成・検証する。未確認のキーを推測して保護済みとはしない。

- [ ] Step 7: 指紋には所有 config の bytes、trust 対象ファイル、解決済み profile、nas の版と埋め込み asset hash、UID/GID、生成物の版を含める。秘密の解決値を含めない。検証前に環境 keyCmd/valCmd 等を実行しない。
- [ ] Step 8: tmpdir と Fake で新規・再実行・第三者ファイル拒否・中途失敗・0600/0700・同時 init・改変・symlink・境界パスを試験する。

```ts
expect(validateDevcontainerProfile({ ...profile, nix: { enable: "auto", mountSocket: false } }))
  .toContain("nix.enable must be false for devcontainer sessions");
expect(afterRejectedInit).toEqual(beforeRejectedInit);
expect(publicStatus).not.toHaveProperty("controlSocket");
```

`profile` は通常設定型を満たす fixture、before/after は既存ディレクトリ全ファイルの bytes とする。

Run: `bun test src/domain/devcontainer/policy_test.ts src/domain/devcontainer/store_test.ts src/domain/devcontainer/config_test.ts src/domain/devcontainer/service_test.ts`。期待: 全件 pass、unit から Docker 起動なし。
- [ ] Step 9: コミットしてレビューする。

## Task 4: 実際の Docker 構成を照合する

**Files:** Create `src/docker/launch_inspection.ts`、`launch_inspection_test.ts`、`launch_inspection_integration_test.ts`、`src/stages/launch/inspection.ts`、`inspection_test.ts`。Modify `src/services/docker.ts`。

**Consumes:** 確定 `ContainerPlan`、Docker inspect の JSON、Dev Container 固有の許可済み設定。
**Produces:** `DockerService.inspectLaunch(id)` と `compareLaunchInspection(expected, actual): readonly string[]`。

- [ ] Step 1: 既存 `DockerContainerDetails` はそのままにし、別の `DockerLaunchInspection` 型を定義する。id、imageId、running、config.user、entrypoint、command、mount、env、networkMode、networks、privileged、capAdd/capDrop、securityOpt、labels を必須にする。
- [ ] Step 2: `docker inspect` の decode を純粋関数にする。欠落・型不正を拒否し、環境値をエラーに含めない。DockerService の Live/Fake に同じメソッドを追加する。
- [ ] Step 3: 比較は予期した bind mount の source/target/RO、network、実 image ID、特権設定、必要な label/env を扱う。余分な mount/network/権限と entrypoint 差し替えも拒否する。配列順によらず意味を比較する。
- [ ] Step 4: fixture の一項目ずつを変更する table test を作る。

```ts
expect(compareLaunchInspection(expected, matchingActual)).toEqual([]);
expect(compareLaunchInspection(expected, extraWritableHostMount))
  .toContain("unexpected mount");
expect(compareLaunchInspection(expected, privilegedActual))
  .toContain("privileged container is not allowed");
expect(compareLaunchInspection(expected, wrongEnvironment).join(" "))
  .not.toContain(secretSentinel);
```

matchingActual は完全な inspect fixture。他の fixture は mount/privilege/env の一項目だけを
変え、テストが複数の理由で偶然通らないようにする。

- [ ] Step 5: 実 Compose の `config` 出力と起動後 inspect で Task 2 のドル記号・mount を照合する integration test を追加する。Docker/Compose/利用可能イメージを別々に判定し、全て一意の名前で finally 回収する。

Run: `bun test src/docker/launch_inspection_test.ts src/stages/launch/inspection_test.ts`。期待: 全件 pass。
Integration: `bun test src/docker/launch_inspection_integration_test.ts`。期待: pass または理由付き skip。
- [ ] Step 6: コミットしてレビューする。

## Task 5: 再接続できる環境と専用 Claude state を作る

**Files:** Create `src/docker/embed/devcontainer-env.sh`、`devcontainer-exec.sh`、`devcontainer-idle.sh`、`devcontainer-claude.sh`、`src/docker/devcontainer_env_test.ts`、`devcontainer_entrypoint_integration_test.ts`、`src/agents/claude_test.ts`。Modify `src/docker/embed/entrypoint.sh`、`Dockerfile`、`src/docker/client.ts`、`src/agents/{types,registry,claude}.ts`、`src/stages/mount/stage.ts` と対応テスト。

**Consumes:** Task 3 の専用 state paths、Task 2 の確定 agent 引数、既存 `nas-direnv-exec`。
**Produces:** root 初期化後の非 root 待機、環境再適用、拡張用ランチャー。

- [ ] Step 1: agent 設定入力に任意の Claude state paths を追加する。通常 CLI は未指定で既存動作。IDE は専用 `.claude` ディレクトリと `.claude.json` を mount し、ホストの同名ファイルを選ばない。VS Code キャッシュと `.devcontainer` の RO mount を構造化して追加する。既存 agent 試験は `src/agents/agents_integration_test.ts` にあるため、純粋な `configureClaude` の新規回帰試験は `src/agents/claude_test.ts` に置く。
- [ ] Step 2: entrypoint の通常初期化を維持し、Dev Container モードでのみ、direnv 適用前の環境 baseline と操作ファイルを root 所有の固定ディレクトリへ保存する。環境キーは明示的に選び、代理認証 secret を持ち込まない。
- [ ] Step 3: proxy/CA/PATH/SHELL/HOME/USER、GIT_CONFIG_*、JAVA_TOOL_OPTIONS、NAS の必要な実行変数と dynamicOps 対象キーを保存する。未設定だったキーは unset の指示として保存する。値は Bash の `%q` で引用し、ファイルを source しても値を実行しないことを試験する。
- [ ] Step 4: `/etc/profile.d/nas.sh` と `nas-devcontainer-exec` は共通の環境処理を呼ぶ。毎回 baseline へ戻してから direnv と env 操作を適用するため、再接続でも prefix/suffix は一度になる。既存の `nas-direnv-exec` に出力専用モードを加える場合は通常 exec モードを回帰試験する。
- [ ] Step 5: `nas-devcontainer-idle` は初期化成功を通知して待機し、TERM/INT で終了する。通知前の失敗を成功に変換しない。Task 6 は marker に加えて非 root exec の環境・UID と socket を確認する。
- [ ] Step 6: `nas-devcontainer-claude` は第一引数の同梱実行ファイルを保持し、引数を配列として専用ランチャーへ渡す。

```bash
#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -lt 1 ]; then
  echo 'nas-devcontainer-claude: bundled executable is required' >&2
  exit 64
fi
binary=$1
shift
source /usr/local/lib/nas/devcontainer/agent-args.sh
exec /usr/local/bin/nas-devcontainer-exec "$binary" "${NAS_AGENT_ARGS[@]}" "$@"
```

`agent-args.sh` は root 所有で `declare -a NAS_AGENT_ARGS=(...)` を安全に生成したもの。
設定された guide 引数・profile.agentArgs はこれに一度だけ含める。
拡張が同梱実行ファイルを渡さないプラットフォームは初版で明示エラーにする。

- [ ] Step 7: 偽の CLI が argv を JSON 化する fixture で、空文字・空白・`$(...)` の文字列、終了コード 23、signal、stdout/stderr を検査する。環境 fixture は direnv 未承認、再実行二回、二重 prefix 不在、環境取得時の余分な stdout 不在を確認する。
- [ ] Step 8: Dockerfile の COPY/chmod と `src/docker/client.ts` の `EMBEDDED_ASSET_GROUPS` に全新規 asset を追加する。asset の変更で image hash が変わることを確認する。

Run: `bun test src/docker/devcontainer_env_test.ts src/docker/direnv_exec_test.ts src/agents/claude_test.ts src/stages/mount/stage_test.ts`。期待: 全件 pass。
Integration: `bun test src/docker/devcontainer_entrypoint_integration_test.ts`。期待: 非 root readiness と再入場が pass、ビルド不能環境は理由付き skip。
- [ ] Step 9: コミットしてレビューする。

## Task 6: Compose セッションの Scope を保持する

**Files:** Create `src/stages/launch/compose_stage.ts`、`compose_session_service.ts`、`compose_session_service_test.ts`、`src/devcontainer/runtime.ts`。Modify `src/stages/launch.ts`、`src/pipeline/types.ts`、`src/cli.ts`、`src/cli_test.ts`。Extract common setup to `src/pipeline/cli_builder.ts`、`live.ts`。

**Consumes:** 最終計画、登録・世代、Task 4 の検査、Task 5 の readiness。
**Produces:** パイプラインの scoped 実行と `ComposeSessionService.serve`。

```ts
export interface ComposeSessionRequest {
  readonly registration: DevcontainerRegistration;
  readonly sessionId: string;
  readonly containerName: string;
  readonly container: ContainerPlan;
}

export interface ComposeSessionServiceApi {
  // この Effect は ready で戻らず、終了要求または故障まで生存する。
  readonly serve: (request: ComposeSessionRequest) =>
    Effect.Effect<void, Error, Scope.Scope>;
}
```

- [ ] Step 1: 現在の `createCliPipelineBuilder` の LaunchStage 直前までを `createPreparationPipelineBuilder` に抽出する。通常 CLI は最後に既存 LaunchStage、IDE は ComposeStage を追加する。全 stage の順序を既存テストで固定する。
- [ ] Step 2: Live Layer の組み立てを共有し、domain へ import しない。`src/devcontainer/runtime.ts` が probe 解決、共有 builder、専用 state、ComposeStage を結合する。
- [ ] Step 3: ComposeSessionService 内で plan の検証、Compose の原子的保存、起動、readiness、実構成検査を行う。D2 の判断は Ops Tag 経由で D1 操作を呼び、Docker や filesystem をインラインで混ぜない。
- [ ] Step 4: 準備完了部分だけに残り時間を渡す。ready の通知を保存した後は終了要求・コンテナ停止/置換・必要な broker 故障を待つ。単に ready 後に `Effect.never` へ入って監視を省略しない。
- [ ] Step 5: 最終 stage が登録するコンテナ teardown は、先行 stage の broker/network finalizer より先に実行する。inspect で世代と ID を照合してから stop/rm。Compose project 全体や名前だけを根拠に削除しない。
- [ ] Step 6: Fake Ops の記録で順序を固定する。

```ts
expect(events).toEqual([
  "validate", "publish-compose", "start", "inspect", "probe-user",
  "ready", "stop-request", "stop-container", "remove-container",
  "release-brokers", "stopped",
]);
```

追加ケース: start/readiness/inspect の各失敗、起動期限、broker 故障、SIGTERM、
同名別 ID、stop 失敗、rm 失敗。回収失敗を元の失敗と共に残し、stopped を記録しない。
後続 finalizer の実行と回収未完了の記録を両方検査する。

Run: `bun test src/cli_test.ts src/stages/launch/compose_session_service_test.ts`。期待: 通常 CLI の stage 順序と全失敗分岐が pass。
- [ ] Step 7: コミットしてレビューする。

## Task 7: 常駐プロセスと CLI を接続する

**Files:** Create `src/domain/devcontainer/supervisor.ts`、`supervisor_test.ts`、`supervisor_integration_test.ts`、`src/cli/devcontainer.ts`、`devcontainer_args.ts`、`devcontainer_args_test.ts`、`devcontainer_test.ts`。Modify domain `service.ts` とテスト、`src/cli.ts`、`src/cli/usage.ts`。

**Consumes:** 登録 API、`src/devcontainer/runtime.ts`、`resolveNasCommand()`。
**Produces:** 下記の引数と公開 API。

```ts
export type DevcontainerCommand =
  | { readonly action: "init"; readonly workspace: string; readonly profile: string }
  | { readonly action: "up" | "down" | "status";
      readonly workspace: string; readonly json: boolean };

export function parseDevcontainerArgs(
  args: readonly string[], cwd: string,
): DevcontainerCommand;
```

- [ ] Step 1: 不明オプション、値の欠落、複数 action、未対応の agent 引数を拒否する。`--workspace` は全 action で利用可能、`--profile` は init のみとする。

```ts
expect(parseDevcontainerArgs(["init", "--profile", "claude"], "/work"))
  .toEqual({ action: "init", workspace: "/work", profile: "claude" });
expect(() => parseDevcontainerArgs(["up", "--profile", "other"], "/work"))
  .toThrow("--profile is only supported by init");
```

- [ ] Step 2: up は operation lock 内で指紋・生存世代を確認する。ready は制御 socket の challenge 応答と inspect を再検査して返す。starting は同じ世代の準備を期限付きで待つ。
- [ ] Step 3: 新規 supervisor は `setsid` と argv 配列で起動する。独立の lifetime lock を保持し、operation lock を引き継いで deadlock させない。親 NAS_SESSION_ID をそのまま継承せず新しい世代を発行する。
- [ ] Step 4: 内部 `_supervise` 入口は所有登録を再検証する。短い private UDS を作り、version/workspace/session を照合した `status` と `stop` のみ受ける。コンテナにはこの socket も親ディレクトリも渡さない。PID だけで生存判定・kill をしない。
- [ ] Step 5: down は同じ operation lock を取得し、対応する世代へ停止要求を送り完了を待つ。不在時は lifetime lock が解放済みであることを確認して、所有 ID に限り孤児を回収する。Docker 不在時は failed と回収未完了を残す。
- [ ] Step 6: 常駐プロセスの SIGINT/SIGTERM は Effect の interruption へ渡して finalizer を待つ。ログは 0600 で世代ごとに保持し、例外の生 env/Compose 全文を出さない。
- [ ] Step 7: `runDevcontainerCommand` は domain client と結果表示だけを行う。内部 supervisor 入口の application dispatch は `src/devcontainer/runtime.ts` に委譲し、domain から stage へ依存させない。
- [ ] Step 8: `nas container clean` の現行処理は主に未使用 sidecar を回収するので、まず regression test で active な IDE コンテナが参照する network/sidecar を残すことを固定する。判定に必要な所有 label が不足する場合だけ既存判定を拡張する。
- [ ] Step 9: 同時 up が一つの session/container を返すこと、親終了後の生存、down 二回、起動中 down、stale socket、PID 再利用、別世代、Docker 不在を試験する。実プロセス試験は finally で自分の子・socket・fixture を回収する。

Run: `bun test src/cli/devcontainer_args_test.ts src/cli/devcontainer_test.ts src/domain/devcontainer/service_test.ts src/domain/devcontainer/supervisor_test.ts src/container_clean_test.ts`。期待: 全件 pass。
Integration: `bun test src/domain/devcontainer/supervisor_integration_test.ts`。期待: 切り離し・終了・競合が pass。
- [ ] Step 10: コミットしてレビューする。

## Task 8: 利用者の操作と拒否動作を通す

**Files:** Create `tests/devcontainer_e2e_test.ts`、`docs/devcontainer.md`。Update `docs/todo/devcontainers.md` と Task 1 の実測記録。

**Consumes:** public CLI と全実装。
**Produces:** 起動・再接続・終了の実証、確認範囲を明記した利用手順。

- [ ] Step 1: 新規 workspace + 最小の trust 済み Claude profile で `init → up → status → up → down → down → up` を通す。最初の二回の up は同じ ID、down 後は新しい ID、専用 Claude state は保持されることを検査する。
- [ ] Step 2: 起動用設定の改変、余分な RW mount、direct network、privileged、古い socket、supervisor 強制終了、同名コンテナ置換を一件ずつ試す。拒否前に危険なコンテナを起動しない試験と、起動後検出・停止の試験を分ける。
- [ ] Step 3: コンテナ内の proxy env を外して許可外通信を試し、既存ネットワーク隔離が残ることを確認する。HostExec exec socket から承認操作ができず、秘密フレームが mount に存在しないことを確認する。
- [ ] Step 4: Task 1 の環境で Reopen、公式拡張のチャット・差分、ターミナル、複数ウィンドウ、再開、明示 down を確認する。CLI/拡張/VS Code の版と観測した UID/HOME/通信経路を記録する。認証は利用者の既存アカウントを無断で移さず専用 state で行う。
- [ ] Step 5: `reader-decision-writing` に従って `docs/devcontainer.md` を書く。読者の到達点は「対応条件を確かめ、初回起動して終了できる」。前提・専用 profile の例・init/up/Reopen・status/down・故障時の確認をこの順に載せる。Pkl の例は実際に schema で評価する。
- [ ] Step 6: 元の構想には実装済み範囲と利用手順へのリンクを追記し、未確認の Feature / IDE 保護を実装済みとしない。実機が未実行なら機能は実験的と明記する。
- [ ] Step 7: `post-change-checks` とユーザーの AGENTS.md に従って最後の検証を行う。

```bash
bun run fmt
bun run lint
bun run check
bun run test:unit
bun run test
git diff --check
```

fmt の無関係な変更をコミットしない。full suite は最後の一度にまとめる。
unit の pass 件数、integration/e2e の pass/skip、実機未実行を別々に報告する。
- [ ] Step 8: 全体レビューと修正後、patched-superpowers の Forgejo レビューへ進む。

## 進捗・レビュー運用

- [ ] 実装開始時の HEAD を progress ledger に `implementation-base: <実ハッシュ>` として記録する。既存の文書コミットをコードレビューの base にしない。
- [ ] `.superpowers/review-config.yml` がなければ patched-superpowers の template を作業用にコピーし、`.superpowers/.gitignore` を `*` にする。
- [ ] 各タスクは新規 implementer とルールベース reviewer で回す。レビューではこの計画の Global Constraints、承認済み spec、対象 diff を渡す。
- [ ] Critical/Warning は内容を検証して修正し、承認済みの設計判断と矛盾する指摘だけ根拠付きで ledger に記録する。
- [ ] 正当な修正は一件一コミット。コミットは `git-commit`、完了主張は `verification-before-completion` に従う。
- [ ] 全体レビューでは通常 CLI への回帰、終了時の順序、IDE 経由の設定改変、秘密の表示を特に追跡する。
- [ ] Forgejo の最終レビュー終了後に、実装済み機能・実測結果・残る制約をまとめる。

## 設計との対応を確認した結果

| 設計の要求 | 実装・検証タスク |
| --- | --- |
| init/up/status/down、複数ウィンドウ、明示終了 | 3、6、7、8 |
| 既存 Compose への接続と準備完了 | 1、4、5、6、8 |
| 最終計画、引数、label、補間、未対応指定の拒否 | 2、4 |
| ホスト専用生成物、RO 入口、指紋、同時起動 | 3、5、7 |
| Scope の保持、失敗時回収、別世代の保護 | 6、7、8 |
| direnv/env/PATH、同梱 CLI、guide | 5、8 |
| 専用認証・キャッシュ、Nix/DinD の明示拒否 | 3、5、8 |
| 実構成・通信・HostExec・秘密の隔離 | 3、4、6、8 |
| 通常 CLI の回帰防止 | 2、5、6、7、8 |
| 実測と未実施の区別、利用者の操作説明 | 1、8 |

計画作成時点では機能コードを変更していない。接続契約の実機試験も未実施。
