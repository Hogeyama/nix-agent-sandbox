# Codex Code Mode Host Mount Design

## Problem

Codex standalone releases install `codex` and `codex-code-mode-host` as
sibling executables. nas currently resolves and bind-mounts only `codex` into
the sandbox at `/usr/local/bin/codex`.

When Code Mode is enabled, Codex resolves its host executable relative to the
mounted CLI location and tries to spawn
`/usr/local/bin/codex-code-mode-host`. Because nas does not mount that sibling,
Codex reports that Code Mode is unavailable even though the host installation
contains the matching executable.

## Scope

- Detect a `codex-code-mode-host` executable beside the resolved host-side
  `codex` executable.
- Carry the detected path in `CodexProbes` so host inspection remains in
  `resolveCodexProbes()` and `configureCodex()` remains pure.
- Bind-mount the detected executable read-only at
  `/usr/local/bin/codex-code-mode-host`.
- Preserve existing behavior when the sibling executable is absent: mount only
  `codex` and do not change the user's Codex feature configuration.
- Add regression coverage for both sibling-present and sibling-absent cases.

## Design

`resolveCodexProbes()` will first resolve `codex` through `PATH` and symlinks,
as it does today. If that succeeds, it will look for
`codex-code-mode-host` in the resolved executable's parent directory. The
probe will return that real path only when it identifies an executable file;
otherwise it will return `null`.

`configureCodex()` will consume the new nullable probe field. When present, it
will append a read-only Docker bind mount from the host path to
`/usr/local/bin/codex-code-mode-host`. No independent `PATH` lookup will be
performed for the helper, keeping it coupled to the selected Codex release.

This remains within the repository's agent architecture: filesystem effects
stay in the probe resolver, while Docker argument construction stays pure.

## Error Handling and Compatibility

An absent, unreadable, non-file, or non-executable sibling is treated as an
unavailable helper and produces a `null` probe value. nas will not fail the
whole Codex launch and will not modify `[features]` in the mounted Codex
configuration. This preserves compatibility with Codex distributions that do
not ship Code Mode.

The new `CodexProbes` field is required at TypeScript call sites, making test
fixtures and other producers explicitly describe helper availability.

## Testing

Pure configurator tests will verify that:

- a detected helper adds the exact read-only container mount;
- a missing helper adds no helper mount;
- existing Docker arguments remain intact.

Probe integration tests will use temporary fake executables to verify that:

- a sibling helper beside the resolved Codex executable is detected;
- a missing sibling returns `null`;
- a non-executable sibling returns `null`.

The focused agent test file will be run during the red/green cycle, followed by
the repository's standard formatting, linting, type-checking, and unit tests.

## Why — なぜこのアプローチを選んだか

Codex 本体の実体パスを基準に sibling を探すことで、standalone 配布の構造に
沿いつつ、本体と helper のバージョンを確実に一致させられる。既存の probe /
pure configurator 分離も維持でき、変更範囲が小さい。

## Why Not — なぜ他の案を選ばなかったか

- **helper を `PATH` から独立検索する案** — Codex 本体とは異なるリリースの
  helper を選ぶ可能性があり、プロトコル互換性を保証できない。
- **Codex の `bin/` ディレクトリ全体をマウントする案** —
  `/usr/local/bin` の既存内容との衝突範囲が広く、今回必要な単一 executable の
  追加に対して過剰。
- **helper がない場合に Code Mode を自動無効化する案** — ユーザー設定を nas
  が暗黙に変更し、インストール不備を見えなくするため採用しない。
