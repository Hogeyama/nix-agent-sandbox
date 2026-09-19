# Dev Container の Codex 対応 設計

状態: 2026-09-20 設計。実装・実機検証はまだ行っていない。

## この設計で決めること

[Dev Container 起動・接続経路の設計](2026-09-15-devcontainer-design.md) が
Claude Code だけに提供した経路を、OpenAI Codex の VS Code 拡張
(`openai.chatgpt`) にも開く。`nas devcontainer init --profile codex` で
Codex 用の `.devcontainer/devcontainer.json` を生成し、既存の
`up` / `status` / `down` がそのまま使えるようにする。

Copilot 拡張、JetBrains 系 IDE、devcontainer 以外の接続方式は今回も範囲外。
`init` の `--profile` 既定値は `claude` のままとする。
Codex 拡張の実機接続確認が済むまでは「接続確認済み」と記載しない。

## 前提として確認した拡張の挙動

対象: `openai.chatgpt-26.908.40401-linux-x64` (ローカルに導入済みのものを
`out/extension.js` で実読して確認)。

- 拡張は `chatgpt.cliExecutable` が設定されていればそのパスを、なければ
  同梱バイナリ `<ext>/bin/<platform>/codex` を `spawn(executable, args,
  {stdio: pipe, env})` で直接起動する。シェルは介さない。
- 実際の呼び出し形は
  `codex -c features.code_mode_host=true app-server --analytics-default-enabled`。
  つまり拡張が使うのは TUI ではなく app-server である。
- spawn 時の env は拡張ホストの `process.env` に、拡張が
  `PATH` 末尾への同梱 bin ディレクトリ追加・`RUST_LOG`・
  `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`・(検出できれば) `CODEX_HOME` を
  上乗せしたもの。
- `CODEX_HOME` は `$SHELL -l -i` で `${CODEX_HOME:-$HOME/.codex}` を
  評価して解決する。nas のコンテナでは login shell が
  `/etc/profile.d/nas.sh` 経由で `nas_devcontainer_apply` を実行するため、
  この probe でも環境適用は走る。

`claudeCode.claudeProcessWrapper` は「拡張の同梱 CLI を包む wrapper」契約だが、
`chatgpt.cliExecutable` は「executable そのものの差し替え」で、拡張は
実バイナリのパスを wrapper に渡さない。wrapper が実 codex を自分で解決する
必要がある。

## 利用者の操作

1. `nas devcontainer init --profile codex` を実行する。
   生成する設定と共有範囲を表示する。`agentArgs` のうち IDE 経路に
   渡せないものがあれば、このとき警告する。
2. `nas devcontainer up` で起動を確認する。
3. VS Code の Reopen in Container で接続し、Codex 拡張で認証する。
   認証情報は共有されたホストの `~/.codex` を使う。
4. 終了は `nas devcontainer down`。Claude 経路と同じ。

## Codex 起動経路

コンテナに新設する `/usr/local/bin/nas-devcontainer-codex`
(`src/docker/embed/devcontainer-codex.sh`) が wrapper になる。
`devcontainer.json` の `chatgpt.cliExecutable` にこのパスを書く。

wrapper の処理順:

1. 実 codex を解決する。候補は拡張の同梱バイナリのみ。拡張は
   cliExecutable を spawn する際に起動中ビルドの同梱 bin ディレクトリを
   PATH 末尾へ足すので、まず PATH 上で `*/openai.chatgpt-*/bin/*` に
   合う末尾側のエントリを使う (glob より正確: 更新で残った旧版や
   別 channel のディレクトリを拾わない)。PATH で見つからなければ
   `$HOME/.vscode-server/extensions/openai.chatgpt-*/bin/*/codex` を
   glob し、実行可能なものを拡張 dir 名のバージョンでソートした末尾
   (最新) を使う。見つからなければ非ゼロで終了して stderr に理由を
   出す (ホストバイナリは mount しないため fallback は存在しない)。
2. `/usr/local/lib/nas/devcontainer-env.sh` を source して
   `nas_devcontainer_apply` を実行する。apply は PATH を baseline に
   再設定するため、拡張が末尾へ足した同梱 bin ディレクトリは失われる。
   拡張が同梱 `codex-code-mode-host` や `codex-path` の helper を
   PATH 経由で解決する可能性に備え、1 で選んだバイナリのディレクトリを
   PATH 末尾へ再追加する。
3. `/usr/local/lib/nas/devcontainer/agent-args.sh` を source し、
   `exec <codex> -c shell_environment_policy.inherit=all
   "${NAS_AGENT_ARGS[@]}" "$@"` する。
   `shell_environment_policy.inherit=all` は terminal 経路の
   `configureCodex` が `agentCommand` に焼いているのと同じ契約で、
   codex が spawn する shell へ NAS の環境 (hostexec socket、
   mask wrapper 用 PATH など) を伝えるために必要。`-c` は global
   option なので拡張が渡す `-c features.code_mode_host=true` より前に
   置いても有効で、app-server にも届く。

`nas-devcontainer-exec` は使わず apply を直接呼ぶのは、PATH 再追加を
apply の後に挟むためである (exec すると制御が戻らない)。

`entrypoint.sh` の devcontainer 分岐と `agent-args.sh` の capture は
agent 非依存なので変更しない。

## agentArgs の扱い

IDE 経路で codex が受ける argv は app-server 起動であり、TUI 専用フラグ
(`--yolo` など) をそのまま渡すと起動自体が失敗し得る。
そこで codex の devcontainer 経路では、profile の `agentArgs` から
`-c key=value` / `--config key=value` のペアだけを残し、それ以外は
起動引数から外す。

- フィルタは純粋関数として `src/domain/devcontainer/` に置き、
  `{ kept, dropped }` を返す。
- 除外される引数は `init` の出力で警告する (profile は up のたびに
  読み直されるため、init 後に profile を編集して追加した不正な引数は
  runtime のログにだけ残る点は許容する)。
- フィルタの適用点は `finalizeDevcontainerPlan` (Compose 経路のみ)。
  通常 CLI 経路の `finalizeLaunchPlan` は従来どおり全件を渡す。

## Observability

現状 codex の OTLP trace 設定は `buildAgentObservabilityContainerPatch` が
`command.agentCommand` に `-c otel.trace_exporter=...` を挿して注入する。
しかし Compose 経路は `agentCommand` を捨て `extraArgs` だけを使うため、
そのままでは devcontainer の codex に届かない。

`createObservabilityStage` に devcontainer かどうかのフラグを deps 経由で
渡し (`devcontainerMounts` の有無で判定)、codex + devcontainer のときは
`-c` ペアを `command.extraArgs` の先頭に挿す。これで
`NAS_AGENT_ARGS` 経由で app-server 起動 argv に届き、agentArgs
フィルタの `-c` ペア許可とも整合する。

## 生成設定と共有範囲

`renderDevcontainerConfig` は agent を受け取り、`customizations.vscode`
を分岐させる:

- claude: `extensions: ["anthropic.claude-code"]` +
  `claudeCode.claudeProcessWrapper = /usr/local/bin/nas-devcontainer-claude`
  (現行どおり)
- codex: `extensions: ["openai.chatgpt"]` +
  `chatgpt.cliExecutable = /usr/local/bin/nas-devcontainer-codex`

`validateDevcontainerProfile` は `agent` に `claude` / `codex` を許可し、
`copilot` は引き続き拒否する。

`describeDevcontainerSharing` の credentials 項目を agent 別にする。
codex は `host ~/.codex, read-write; kept on the host after down`。

ホスト側の状態準備として `ensureDevcontainerCodexState(hostHome)` を追加し、
`~/.codex` を存在しなければ 0700 で作る (Compose の bind は
`create_host_path: false` のため、初回 `up` 前に実在が必要)。
claude の `ensureDevcontainerClaudeState` に相当する。

`configureCodex` に devcontainer 用の分岐 (`codexState`) を追加し、
probe 結果の有無に関わらず structured `mounts` で `~/.codex` を RW に渡す。
`profile.agentState.protectSettings` が立っていれば
`CODEX_SETTINGS_FILES` (`config.toml`) を RO で上乗せする。
ホストの codex バイナリは mount しない (wrapper は拡張同梱バイナリのみを
解決する)。

`DevcontainerMountInput` は現在 `ClaudeStatePaths` を継承しているが、
`vscodeDir` に加えて agent 別の state (claude の `{claudeDir, claudeJson}`、
codex の `{codexDir}`) を optional で持つ形に変える。`AgentConfigInput` にも
`codexState` を追加し、mount stage から `configureAgent` へ渡す。

`Dockerfile` に `devcontainer-codex.sh` の COPY と chmod を追加する。

`devcontainer_args.ts` の `init` 既定 profile は `claude` のまま。
`--profile` には既存の profile 解決を使う。

## リスクと受け入れ条件

- `chatgpt.cliExecutable` は OpenAI が "development only" と明記しており、
  拡張の更新で契約が変わり得る。公式に用意された唯一の hook であり、
  このリスクは利用手順と disclosure に明記して受け入れる。
- 同梱バイナリの glob は拡張内部レイアウト (`bin/<platform>/codex`) に
  依存する。レイアウトが変われば起動時に明示的に失敗する。
  黙って別挙動にはしない。
- `PATH` の baseline リセットで拡張が足した同梱 bin ディレクトリが
  消える点は wrapper が再追加して吸収する。
- Codex 拡張の認証・通信に必要な外向き宛先は実機で確認してから
  利用手順に反映する。未確認の宛先を広く許可しない (既存 spec の方針)。

## 実装境界

| 場所 | 変更 |
| --- | --- |
| `src/docker/embed/devcontainer-codex.sh` | 新規 wrapper |
| `src/docker/embed/Dockerfile` | COPY + chmod 追加 |
| `src/domain/devcontainer/policy.ts` | codex 許可 |
| `src/domain/devcontainer/config.ts` | agent 別 customizations |
| `src/domain/devcontainer/disclosure.ts` | agent 別 credentials 表示 |
| `src/domain/devcontainer/` | agentArgs フィルタ純粋関数 (新規ファイル) |
| `src/stages/mount/mount_probes.ts` | `ensureDevcontainerCodexState` |
| `src/stages/mount/stage.ts` | `DevcontainerMountInput` 一般化 |
| `src/agents/types.ts` / `codex.ts` / `registry.ts` | `codexState` 入力と devcontainer 分岐 |
| `src/stages/observability/stage.ts` + `agents/observability.ts` | devcontainer 時は codex `-c` を extraArgs へ |
| `src/stages/launch/compose_stage.ts` | codex agentArgs フィルタ適用 |
| `src/devcontainer/runtime.ts` | agent 別 ensure 呼び出し |
| `src/domain/devcontainer/types.ts` / `src/cli/devcontainer.ts` | `init` 結果に除外 agentArgs を載せ、警告として表示 |
| `src/cli/usage.ts` | 使用例の補足 (任意) |

## 検証と完了条件

1. Unit: policy の受理/拒否、config の agent 分岐、disclosure、
   agentArgs フィルタ、`ensureDevcontainerCodexState`、mount plan の
   codexState 分岐、observability の devcontainer 分岐。
2. Integration: `devcontainer_entrypoint_integration_test` に codex
   wrapper の解決・env 適用・引数転送を追加する。
3. E2E: `tests/devcontainer_contract_e2e_test.ts` は agent 非依存の
   まま通ること。
4. 実機: バージョンを記録した VS Code / Dev Containers /
   `openai.chatgpt` で初回接続・認証・チャット・別ウィンドウ再接続・
   down 後再起動を確認する。`chatgpt.cliExecutable` が development only
   である旨と必要な通信宛先を利用手順へ記す。
5. 変更後チェック: format、lint、型検査、unit、最後に full suite を
   一度実行。Docker や実機条件による skip は成功と分けて記録する。

## Why — なぜこのアプローチを選んだか

`chatgpt.cliExecutable` に wrapper を置き、wrapper が拡張同梱の codex を
解決して exec する方式を選んだ。

決め手はプロトコル一致である。拡張は app-server を JSONL stdio で
話し、拡張と CLI のバージョンは別系統で動く (拡張 26.908.x に対し
ホストの CLI は 0.63.x 系になり得る)。同梱バイナリを選べば拡張が
想定する版と必ず一致する。PATH 経由でホスト codex を優先すると
古い app-server を新しい拡張に喋らせることになる。

またこの方式は host に codex CLI が無くても IDE 経路が成立し、
Claude 経路 (拡張同梱 CLI を wrapper が包む) と構造的に対称になる。
env 適用と `NAS_AGENT_ARGS` 注入も既存の `devcontainer-env.sh` /
`agent-args.sh` の仕組みをそのまま再利用できる。

## Why Not — なぜ他の案を選ばなかったか

- **ホストの codex バイナリを mount して使う案** — `configureCodex` が既に
  `/usr/local/bin/codex` に mount するため実装は最も小さいが、
  拡張と CLI の版ずれで app-server プロトコルが壊れるリスクがあり、
  ホストへの codex 導入が必須条件になる。レビュー判断で mount 自体を
  行わないこととした。
- **`cliExecutable` を差し替えず同梱バイナリをそのまま使う案** —
  `userEnvProbe` 経由で proxy 環境までは届く可能性があるが、
  `-c shell_environment_policy.inherit=all` と OTLP の `-c` を
  注入する手段が無く、hostexec・mask が効かない codex 子 shell が
  生まれる。`~/.codex/config.toml` に書く方式はホストのユーザ設定を
  書き換えることになり、`protectSettings` の RO overlay とも衝突する。
- **agentArgs を全件渡す案** — app-server が受けない TUI 専用フラグで
  起動が落ち、利用者からは拡張が無言で止まるだけに見える。
  `-c` ペアに限定することで、届く引数は確実に app-server へ効く。
- **agentArgs を全て捨てる案** — 最も安全だが `-c model=...` のような
  正当な設定上書きまで届かなくなり、profile との対称性も失う。

## 確認した資料

- [Dev Container 起動・接続経路の設計](2026-09-15-devcontainer-design.md):
  起動契約・共有範囲・実装境界の前提。
- [Codex IDE extension developer settings](https://learn.chatgpt.com/docs/developer-settings.md):
  `chatgpt.cliExecutable` の意味と "development only" の注意書き。
- `openai.chatgpt-26.908.40401-linux-x64/out/extension.js` (実読):
  spawn 形・引数・env の組み立て・CODEX_HOME 解決方法。
- `src/agents/observability.ts`・`src/stages/observability/stage.ts`:
  codex の `-c` 注入経路。
- `src/docker/embed/devcontainer-{env,exec,claude}.sh`・`entrypoint.sh`:
  env capture/apply と wrapper の既存契約。

外部資料の確認日: 2026-09-20。Codex 拡張での実機接続試験は未実施。
