# Dev Container Extra Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Apply patched-superpowers, with implementers dispatched through `claude -p`. Steps use checkbox syntax for tracking.

**Goal:** `extraAgents` を含む Dev Container で Claude/Codex の両 IDE 拡張と追加 CLI を使えるようにする。Copilot は追加 CLI のみ。

**Architecture:** 起動引数を拡張ごとに保存し、IDE の状態準備とホスト CLI の配置を組み合わせる。既存の provision と認証処理を再利用し、準備が揃った最後のタスクで profile の制限を解除する。

**Tech Stack:** Bun、TypeScript、Effect、Bash、Docker Compose、VS Code Dev Containers。

**Spec:** [承認済み設計](../specs/2026-09-27-devcontainer-extra-agents-design.md)

## 実施順序

| タスク | 利用者に関係する目的 | この時点でできること |
| --- | --- | --- |
| 1. 起動引数の分離 | Codex のオプションが Claude に渡らないようにする | 単独 IDE の既存動作を保ったまま、両ラッパーを呼べる |
| 2. 状態と CLI の準備 | 同じエージェントを IDE と CLI から使えるようにする | 両方の状態と追加 CLI を組み合わせられる |
| 3. 設定生成と利用案内 | extraAgents のあるプロファイルを受け付ける | init/up と生成設定までつながり、今回の機能が利用可能になる |

各タスクを実装・検証・コミットして、独立したレビューに通す。
Task 3 まで extraAgents の拒否は残すため、途中のコミットで未完成の経路を公開しない。

## Global Constraints

- 実装者とレビュアーは spec と `AGENTS.md`、`skills/effect-separation/SKILL.md`、その `references/domain-service.md`、`skills/security-constraints/SKILL.md`、`skills/test-policy/SKILL.md`、`skills/post-change-checks/SKILL.md` を読む。追加の事前資料はユーザー指定なし。
- ドキュメント担当は `skills/reader-decision-writing/SKILL.md`、`docs-site/AGENTS.md`、`docs-site/editorial/pages.md` の該当ページの目的を読む。コミットは `skills/git-commit/SKILL.md` に従う。
- 主エージェントは引き続き Claude または Codex。追加分には Claude/Codex/Copilot を指定できる。重複の拒否は既存の profile 検証を使う。
- `agentArgs` は主エージェント専用。追加 IDE 拡張にも追加 CLI にも渡さない。主専用の guide 起動引数・記録設定を追加分へ転用しない。
- Codex の IDE と CLI が同じ `~/.codex` を使うため、Dev Container の Codex は主・追加とも passthrough。明示的 injected を拒否する。通常 CLI の既定 injected は維持する。
- IDE 拡張は同梱 CLI を使う。追加分のホスト CLI も RO mount するが、IDE の fallback に使わない。
- Claude の private root と dummy credentials、protectSettings、HostExec/proxy/mask の境界を維持する。stage 内に primitive I/O を追加しない。
- 引数ファイルは root 所有、0644、原子的更新。空文字、空白、改行、shell metacharacter を保持する。
- 登録形式の version は既存の 1 を維持する。新フィールドが無い旧登録は主エージェントだけの IDE 集合として読む。
- 追加 CLI のホストバイナリ欠如は警告する。Claude/Codex の IDE 拡張まで利用不能とは表示しない。
- 実装者は `claude -p` を使い、再委譲と自己起動のレビュアーを禁止する。レビューは controller が別途担当させる。必要な承認を迂回する CLI オプションを足さない。
- コンパイル不能を作るためだけの RED は行わない。既存動作と利用者向けの契約を検証する。
- 実装着手時に作業ツリーを確認し、他の変更を巻き込まない。baseline の結果は対象コミットと作業ツリーに対応するものを使う。

## Review Focus

1. 主 Claude/主 Codex のどちらでも、空引数や `$(...)` を含む主用引数が他方の wrapper へ漏れないこと（Task 1）。
2. 追加 CLI のホストバイナリが無い場合も、IDE の状態 mount が残ること。Codex の IDE が古いホスト版を選ばないこと（Task 1/2）。
3. 新規 HOME と既存 HOME、protectSettings の有無で、両方の状態を壊さず mount できること（Task 2/3）。
4. 旧登録、IDE 集合の増減、追加分の並べ替え、Copilot だけの増減を区別すること（Task 3）。
5. `auth` の文字列指定と Mapping の両方で、追加 Codex の injected を拒否し、Claude の注入と Codex の共有表示が実構成と一致すること（Task 3）。

---

### Task 1: IDE ラッパーごとの起動引数

**Files:**

- Modify: `src/stages/launch/compose_stage.ts`
- Modify: `src/docker/embed/entrypoint.sh`
- Modify: `src/docker/embed/devcontainer-env.sh`
- Modify: `src/docker/embed/devcontainer-claude.sh`
- Modify: `src/docker/embed/devcontainer-codex.sh`
- Test: `src/stages/launch/compose_stage_test.ts`
- Test: `src/docker/devcontainer_env_test.ts`
- Test: `src/docker/devcontainer_entrypoint_integration_test.ts`

**Interfaces:**

- Consumes: `finalizeDevcontainerPlan(shared, container, options)` の `shared.profile.agent` と確定済み `command.extraArgs`。
- Produces: Compose の静的 env `NAS_DEVCONTAINER_PRIMARY_AGENT`（`claude` または `codex`）。
- Produces: `nas_devcontainer_capture OPS_FILE PATH_PREFIX PRIMARY_AGENT [ARG...]`。
- Produces: `/usr/local/lib/nas/devcontainer/claude-args.sh` と `codex-args.sh`。各ファイルは `declare -a NAS_AGENT_ARGS=(...)` を持ち、主だけが確定済み引数、他方は空配列。

- [ ] **Step 1: capture と wrapper の回帰ケースを既存 fixture に追加する。**

fixture のコピー対象へ `codex` を加える。fake bundled executable は argv を JSON 出力し、stderr に diagnostic、終了値23を返す既存の作り方を使う。
両方の主を表で検証し、主の配列は `['', 'two words', '$(false)', 'line\nbreak']`、拡張側は `['--resume', 'chat id', '']` を使う。
Codex の fake は `openai.chatgpt-test/bin/linux-x64/codex` 配下に置き、fixture の `HOME` と PATH から解決させる。

```ts
for (const primary of ["claude", "codex"] as const) {
  test(`wrappers isolate arguments when primary is ${primary}`, async () => {
    await fixture(async (root, library) => {
      const binDir = path.join(root, "extensions/openai.chatgpt-test/bin/linux-x64");
      await mkdir(binDir, { recursive: true });
      const payload = path.join(binDir, "codex");
      await writeFile(payload, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2))); process.stderr.write("diagnostic"); process.exit(23);\n`, { mode: 0o755 });
      const env = {
        HOME: root, PRIMARY: primary, LIBRARY: library,
        PATH: `${process.env.PATH}:${binDir}`,
        NAS_REAL_BASH: "/bin/bash", NAS_DIRENV_ENABLED: "false", WORKSPACE: root,
      };
      const setup = await shell(`source "$LIBRARY"
nas_devcontainer_capture "" "" "$PRIMARY" "" "two words" '$(false)' $'line\\nbreak'`, env);
      expect(setup.code).toBe(0);
      const profileArgs = ["", "two words", "$(false)", "line\nbreak"];
      const extensionArgs = ["--resume", "chat id", ""];
      for (const agent of ["claude", "codex"] as const) {
        const proc = Bun.spawn([
          path.join(root, `nas-devcontainer-${agent}`),
          ...(agent === "claude" ? [payload] : []), ...extensionArgs,
        ], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
        const [code, stdout, stderr] = await Promise.all([
          proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
        ]);
        expect(code).toBe(23);
        expect(stderr).toBe("diagnostic");
        expect(JSON.parse(stdout)).toEqual([
          ...(agent === "codex" ? ["-c", "shell_environment_policy.inherit=all"] : []),
          ...(primary === agent ? profileArgs : []), ...extensionArgs,
        ]);
      }
    });
  });
}
```

本物の Codex/Claude や VS Code は起動しない。ホスト版役の fake codex を PATH の先頭に置き、拡張版だけが実行されるケースも加える。

- [ ] **Step 2: primary を capture の明示的な引数にして、保存先を分ける。**

Compose の静的 env に `NAS_DEVCONTAINER_PRIMARY_AGENT: shared.profile.agent` を設定する。
entrypoint は direnv/env-ops 適用前の値を capture へ渡す。

```bash
nas_devcontainer_capture "$NAS_ENV_OPS_FILE" "$PATH_PREFIX" \
  "${NAS_DEVCONTAINER_PRIMARY_AGENT:-}" "${AGENT_COMMAND[@]:1}"
```

capture 冒頭で第三引数を `case` により claude/codex に限定し、空値や未知値は stderr と非ゼロで拒否する。
既存 baseline と env-ops の保存を保ち、引数保存は次の形をエージェントごとに原子的に行う。

```bash
printf 'declare -a NAS_AGENT_ARGS=('
if [ "$nas_agent" = "$nas_primary" ] && [ "$#" -gt 0 ]; then
  printf ' %q' "$@"
fi
printf ' )\n'
```

各 wrapper は自分のファイルを source する。共通の古い `agent-args.sh` へ fallback しない。
起動時の env に偽の primary や NAS_AGENT_ARGS を渡しても、保存済みファイルの内容が使われることをテストする。

- [ ] **Step 3: 既存 fixture と実 Docker の接続点を更新し、単独起動の回帰を確認する。**

capture 呼び出しに primary を追加し、Compose fixture の省略されている `profile.agent` を明示する。
entrypoint integration の docker env にそれぞれの primary を追加し、引数ファイル名・mode と保存内容を確認する。
既存の環境復元、stdout 非汚染、signal、Codex 同梱版の選択試験を維持する。

```bash
bun test src/docker/devcontainer_env_test.ts src/stages/launch/compose_stage_test.ts
bun test src/docker/devcontainer_entrypoint_integration_test.ts
```

Expected: unit は PASS。integration は fixture image があれば PASS、無ければ理由付き skip。missing/unknown primary の unit ケースは非ゼロを確認する。

- [ ] **Step 4: 差分と結果を自己確認し、コミットして report を書く。**

コミット主題の候補: `fix(devcontainer): isolate launch arguments for each IDE agent`。
report に実行コマンド・結果・skip 理由を記載する。controller の task review 完了まで次へ進まない。

### Task 2: 複数の状態準備と追加 CLI の配置

**Files:**

- Create: `src/domain/devcontainer/agents.ts`, `src/domain/devcontainer/agents_test.ts`
- Modify: `src/domain/devcontainer.ts`
- Modify: `src/agents/types.ts`, `src/agents/registry.ts`, `src/agents/claude.ts`, `src/agents/codex.ts`
- Modify: `src/stages/mount/mount_probes.ts`, `src/stages/mount/stage.ts`
- Modify: `src/devcontainer/runtime.ts`
- Test: `src/agents/claude_test.ts`, `src/agents/codex_test.ts`, `src/stages/mount/mount_probes_test.ts`
- Test: `src/devcontainer/runtime_test.ts`（呼び出し fixture が必要な場合のみ更新）

**Interfaces:**

- Produces: `type DevcontainerIdeAgent = "claude" | "codex"`。
- Produces: `resolveDevcontainerIdeAgents(profile: Pick<Profile, "agent" | "extraAgents">): readonly DevcontainerIdeAgent[]`。claude、codex の固定順。
- Produces: `ensureDevcontainerAgentState(agents: readonly AgentType[], hostHome: string): Promise<DevcontainerAgentState>`。両 state member を同時に返せる。
- Produces: 共通の `AgentProvisionInput` と Claude/Codex の provision 入力の `claudeState?` / `codexState?`、`mountHostBinary?: boolean`。
- Default: `mountHostBinary` 未指定なら、従来と同じく IDE state 有りで false、無しで true。mount stage は主 IDE に false、追加分に true を明示する。

- [ ] **Step 1: IDE 集合の純粋関数と状態準備のケースを追加する。**

```ts
export function resolveDevcontainerIdeAgents(
  profile: Pick<Profile, "agent" | "extraAgents">,
): readonly DevcontainerIdeAgent[] {
  const present = new Set<AgentType>([profile.agent, ...profile.extraAgents]);
  return (["claude", "codex"] as const).filter((agent) => present.has(agent));
}
```

```ts
expect(resolveDevcontainerIdeAgents({
  agent: "codex", extraAgents: ["copilot", "claude"],
})).toEqual(["claude", "codex"]);
expect(resolveDevcontainerIdeAgents({
  agent: "claude", extraAgents: ["copilot"],
})).toEqual(["claude"]);
```

状態準備の既存 tmpdir テストを配列入力へ変更する。
両方の要求で両 state path が存在し、既存の marker/認証内容を上書きせず、Copilot だけの要求は空結果となることを確認する。
一方しか要求しない新規 HOME には他方のディレクトリを作らないことも確認する。

- [ ] **Step 2: state の有無とバイナリ mount の要否を分離する。**

Claude/Codex の provision が state 分岐の早期 return でバイナリ処理を飛ばさない構造にする。
IDE state は structured mounts として保ち、ホストバイナリも IDE 経路では structured mounts で追加する。通常 CLI の既存出力形は維持する。

```ts
const mountHostBinary = input.mountHostBinary ?? (input.codexState === undefined);
// Claude 側では claudeState を使う。
// codexState の状態 mount と設定 RO overlay を決めた後、
// mountHostBinary が true なら codex と検出済み code-mode-host を加える。
```

共通 registry から各 provision/configure へ state と flag を渡す。
Claude の private root と dummy credential は既存の順序と guard を維持する。
Codex の IDE state + dummy auth の既存拒否も維持する。

```ts
// src/agents/codex_test.ts の既存 input を使う。
const extra = provisionCodex({
  ...input,
  codexState: { codexDir: "/state:$x/codex" },
  mountHostBinary: true,
});
expect(extra.mounts).toContainEqual({
  source: "/host/codex", target: "/usr/local/bin/codex", readOnly: true,
});
expect(extra.mounts).toContainEqual({
  source: "/state:$x/codex", target: "/home/nas/.codex",
});
```

Claude も同じ利用者契約で確認する。protectSettings の両値、ホストバイナリ欠如、Codex 補助バイナリ、既存の CLI/ACP を対象にする。

- [ ] **Step 3: runtime と mount stage へ接続する。**

runtime は `resolveDevcontainerIdeAgents(options.profile)` を state ensure に渡す。
mount stage の主 configure は state と `mountHostBinary: devcontainer === undefined` を渡し、追加 provision は state と `mountHostBinary: true` を渡す。
各 provision は自分の agent に対応する state だけを使う。
Dev Container の追加 Claude/Codex のバイナリ欠如警告は「CLI は unavailable、IDE 拡張は bundled executable を使う」とする。Copilot/通常 CLI の警告は既存どおり。
extraAgents 拒否はまだ解除しない。両 state とバイナリの組み合わせは agent planner を直接テストし、mount stage 全体の受理テストは Task 3 で行う。

```bash
bun test src/domain/devcontainer/agents_test.ts src/agents/claude_test.ts src/agents/codex_test.ts src/stages/mount/mount_probes_test.ts src/stages/mount/stage_test.ts src/devcontainer/runtime_test.ts
```

Expected: PASS。通常 CLI の mount と起動コマンド、既存の単独 IDE mount が変わらない。

- [ ] **Step 4: コミットして report を書く。**

コミット主題の候補: `refactor(devcontainer): provision IDE state with optional host CLIs`。
新 interface と実際の検証結果を report に残し、task review を受ける。

### Task 3: extraAgents の受理・設定生成・利用案内

**Files:**

- Modify: `src/domain/devcontainer/{policy,config,types,store,lifecycle,disclosure,fixtures}.ts`
- Test: `src/domain/devcontainer/{policy,config,lifecycle,disclosure}_test.ts`
- Create: `src/domain/devcontainer/store_test.ts`
- Test: `src/stages/mount/stage_test.ts`, `src/stages/proxy/stage_test.ts`, `src/agents/credentials_test.ts`
- Update typed fixtures: `src/cli/devcontainer_test.ts`, `src/stages/launch/compose_stage_test.ts`, `src/stages/launch/compose_session_service_test.ts`
- Modify: `docs-site/src/content/docs/configuration/profiles.md`, `docs-site/src/content/docs/configuration/authentication.md`

**Interfaces:**

- Consumes: Task 2 の `DevcontainerIdeAgent` と `resolveDevcontainerIdeAgents`、複数 state、`mountHostBinary`。Task 1 の wrapper 引数分離。
- Produces: `DevcontainerRegistration.ideAgents: readonly DevcontainerIdeAgent[]`（新規作成・parse 後の登録では必須）。
- Produces: `renderDevcontainerConfig(registration: DevcontainerRegistration, remoteUser: string)`。IDE 集合は registration から読む。
- Preserves: registration `version: 1`、`agent` の旧互換、`DevcontainerInitResult` と CLI 出力の形。

- [ ] **Step 1: profile gate と認証の受け入れケースを更新する。**

extraAgents 一律拒否を外し、Codex injected 拒否の対象を主だけから IDE 集合全体へ広げる。
重複や主 Copilot、worktree の検証は既存経路を使う。

```ts
const profile = {
  ...devcontainerProfile(), agent: "claude" as const, extraAgents: ["codex" as const],
};
expect(validateDevcontainerProfile(profile)).toEqual([]);
for (const auth of ["injected", { codex: "injected" }] as const) {
  expect(validateDevcontainerProfile({
    ...profile, agentState: { protectSettings: false, auth },
  }).join("\n")).toContain("passthrough");
}
```

主 Codex + 追加 Claude/Copilot も受理する。
既存 credentials/proxy テストへ、主 Claude + 追加 Codex の Dev Container は Claude source だけ、通常 CLI は両 source、という回帰を追加する。

- [ ] **Step 2: 登録に IDE 集合を保存し、設定を合成する。**

```ts
// init の record に追加。
ideAgents: resolveDevcontainerIdeAgents(inputs.profile),
```

config は registration.ideAgents から extensions と settings を合成する。
設定キーは `claudeCode.claudeProcessWrapper` と `chatgpt.cliExecutable`、値は既存 wrapper path。
init の render 呼び出しは二引数に変更し、typed fixture へ ideAgents を明示する。

```ts
const config = renderDevcontainerConfig({
  ...registrationFixture(), ideAgents: ["claude", "codex"],
}, "nas");
expect(config.customizations.vscode).toEqual({
  extensions: ["anthropic.claude-code", "openai.chatgpt"],
  settings: {
    "claudeCode.claudeProcessWrapper": "/usr/local/bin/nas-devcontainer-claude",
    "chatgpt.cliExecutable": "/usr/local/bin/nas-devcontainer-codex",
  },
});
```

- [ ] **Step 3: parse と up の互換性・不一致を検証する。**

parse は新フィールド欠如を主だけの集合に補い、存在時は配列型、claude/codex、重複無し、主の包含を検証して固定順に正規化する。
欠如と null を区別し、空配列・未知値・重複・主の欠落は `DevcontainerError` にする。
既存の agent 欠如時 Claude の互換を保つ。

```ts
const { ideAgents: _ideAgents, ...legacy } = registrationFixture();
expect(parseDevcontainerRegistration(JSON.stringify(legacy)).ideAgents).toEqual(["claude"]);
for (const ideAgents of [null, [], ["copilot"], ["claude", "claude"], ["codex"]]) {
  expect(() => parseDevcontainerRegistration(JSON.stringify({
    ...legacy, ideAgents,
  }))).toThrow(DevcontainerError);
}
```

up は既存の主 agent 比較に加え、正規化済み ideAgents と最新 profile の IDE 集合を比較する。
増減は `down` → `init --profile ...` → `up` を案内して拒否する。順序だけの変更と Copilot だけの増減は受理する。
既存 lifecycle fixture の `loadInputs` と偽 `spawnServe` を用い、再 init が登録と生成 JSON の両方を更新してから up できるケースまで確認する。

- [ ] **Step 4: mount → Compose のつながりと共有表示を検証する。**

mount の既存 Fake Layer で両方の主従を試験する。
同一 target の重複無し、追加 CLI と state の存在、主ホスト CLI の不在、設定 RO、Claude dummy の順序を確認する。
得られた ContainerPlan を既存 `compileCompose(plan, containerName, projectName)` に渡し、volumes の source/target/read_only が保たれることを検証する。文字列に `:`/`$`/空白を含む state path も使う。

disclosure は全エージェントの状態と認証を表示する。
Claude の既存説明を共用し、追加 Codex でも共有と hook の注意を出す。
Copilot は状態がある場合の共有として説明し、token がその中にあるとは書かない。
追加 Claude/Codex は IDE と CLI、追加 Copilot は CLI と表示する。
単独エージェントの既存表示を保ち、protectSettings/auth の各組み合わせを既存テストへ加える。

```bash
bun test src/domain/devcontainer/ src/agents/credentials_test.ts src/stages/mount/stage_test.ts src/stages/proxy/stage_test.ts src/stages/launch/compose_stage_test.ts src/stages/launch/compose_session_service_test.ts src/cli/devcontainer_test.ts
```

Expected: PASS。`src/domain/devcontainer/` に Docker integration を新設した場合は、ディレクトリ指定を unit ファイル列挙に切り替える。

- [ ] **Step 5: 利用条件を既存ページへ反映し、機能をコミットする。**

profiles の「別のエージェントの併用」の Dev Container 未対応行を更新し、両 IDE、追加 CLI のホストバイナリ条件、agentArgs は主だけ、IDE 集合変更時の再 init を記す。
authentication の Codex Dev Container の例外が追加分にも適用されると明記する。
新しい設定項目や別ページは作らず、既存 Pkl 例をそのまま使う。例を変更した場合は記載位置に対応した schema 評価も行う。

```bash
bun run docs:build
git diff --check
```

コミット主題の候補: `feat(devcontainer): support extra agents in IDE sessions`。
report に全ケースの結果と実機未確認を記載し、task review を受ける。

## 全体の検証とレビュー

- [ ] 実装開始直前の HEAD を ledger の `implementation-base` に保存する。各タスクの base も dispatch 前に記録する。
- [ ] 各タスクの report と diff package を、patched-superpowers の `code-reviewer-prompt.md` と review-config に従う独立レビュアーへ渡す。妥当な critical/warning は `claude -p` に修正依頼し、1 finding 1 commit とする。
- [ ] 最終コードで `bun run fmt` → `bun run lint` → `bun run check` を順に実行する。ドキュメントを直した後は `bun run docs:build` と `git diff --check` も確認する。
- [ ] NAS の `bun run test` が完了してから、成否にかかわらず `hostexec bun run test` を実行する。両環境の結果・skip・Zig の cached compile と実 test run を分けて記録する。
- [ ] `/code-review high` で全体を確認し、correctness の指摘を修正する。Forgejo CLI は現時点で PATH に無いため、全体レビューまでに通常の許可された方法で用意する。利用不能ならその段階の blocker として報告する。
- [ ] `forgejow request-review implementation-base..HEAD` の PR で人間レビューを受ける。レビュー後に終了処理と必要な履歴整理を行う。
- [ ] 実際の VS Code 両拡張での接続・認証・会話は自動テストの成功から推定しない。実施できない場合は未確認として完了報告に残す。

この計画は人間レビュー待ち。承認後、各タスクを `claude -p` で順次実装する。
