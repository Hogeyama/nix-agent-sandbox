# hostexec mask.filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** hostexec ブローカーがホスト実行したコマンドの stdout/stderr を `nas-mask-filter` Zig バイナリでマスクする。

**Architecture:** `HostExecBrokerOptions` に `maskFilter` オプションを追加し、`runResolved` でホストコマンドの stdout/stderr を `nas-mask-filter` プロセスにパイプしてからソケットへ送る。シークレットフレームファイルはコンテナにマウントされない `sessionBrokerDir` に配置する。

**Tech Stack:** Bun, Effect (サービス層), Zig binary (nas-mask-filter)

## Global Constraints

- テストは `test-policy` スキルに従う: Unit は `*_test.ts` でソース隣接、Integration は `*_integration_test.ts`
- `resolveMaskSecrets` / `encodeMaskSecrets` / `resolveMaskFilterBinPath` は既存のものを再利用
- `nas-mask-filter` バイナリの env var は `NAS_MASK_SECRETS_FILE`（フレームファイルのパス）

---

### Task 1: HostExecBroker に maskFilter オプションを追加し、出力をフィルタする

**Files:**
- Modify: `src/hostexec/broker.ts:49-62` (HostExecBrokerOptions), `src/hostexec/broker.ts:106-141` (constructor), `src/hostexec/broker.ts:678-760` (runResolved), `src/hostexec/broker.ts:769-783` (pipeStreamToSocket)
- Modify: `src/stages/hostexec/broker_service.ts` (HostExecBrokerConfig)
- Test: `src/hostexec/broker_integration_test.ts`

**Interfaces:**
- Consumes: `nas-mask-filter` binary (env `NAS_MASK_SECRETS_FILE` でフレームファイルを読む)
- Produces: `HostExecBrokerOptions.maskFilter?: { binaryPath: string; secretsFramePath: string }` — Task 2 の stage が設定する

- [ ] **Step 1: Write the failing integration test**

`src/hostexec/broker_integration_test.ts` の末尾に追加:

```typescript
test("HostExecBroker: masks secrets in streaming output when maskFilter configured", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );

  // Write a secrets frame file with "SUPERSECRET" as the secret
  const { encodeMaskSecrets } = await import(
    "../stages/maskfs/secrets_frame.ts"
  );
  const frame = encodeMaskSecrets(["SUPERSECRET"]);
  const secretsFramePath = path.join(runtimeDir, "mask-secrets.frame");
  await writeFile(secretsFramePath, frame);

  // Resolve the mask-filter binary
  const { resolveMaskFilterBinPath } = await import(
    "../stages/maskfs/mask_filter_path.ts"
  );
  const binaryPath = await resolveMaskFilterBinPath();
  if (!binaryPath) {
    console.warn("Skipping mask-filter test: binary not found");
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    return;
  }

  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "echo",
          match: { argv0: "echo" },
          cwd: { mode: "any", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "deny",
        },
      ],
    }),
    maskFilter: { binaryPath, secretsFramePath },
  });

  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await mkdir(`${runtimeDir}/tmp`, { recursive: true });
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const result = await sendStreamingRequest(
      execSocketPath,
      request(["hello SUPERSECRET world"], workspace, undefined, "echo"),
    );
    const stdout = collectStdout(result);
    expect(stdout).not.toContain("SUPERSECRET");
    expect(stdout).toContain("hello");
    expect(stdout).toContain("world");
    expect(result.exitCode).toBe(0);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: does not mask when maskFilter is not configured", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "echo",
          match: { argv0: "echo" },
          cwd: { mode: "any", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "deny",
        },
      ],
    }),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_test");
  const execSocketPath = hostExecExecSocketPath(paths, "sess_test");
  await mkdir(`${runtimeDir}/tmp`, { recursive: true });
  await broker.start(execSocketPath, controlSocketPath);
  try {
    const result = await sendStreamingRequest(
      execSocketPath,
      request(["hello SUPERSECRET world"], workspace, undefined, "echo"),
    );
    const stdout = collectStdout(result);
    expect(stdout).toContain("SUPERSECRET");
    expect(result.exitCode).toBe(0);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/hostexec/broker_integration_test.ts --test-name-pattern 'masks secrets'`
Expected: FAIL — `maskFilter` is not a recognized property of `HostExecBrokerOptions`

- [ ] **Step 3: Add `maskFilter` to `HostExecBrokerOptions` and store in constructor**

In `src/hostexec/broker.ts`, add to `HostExecBrokerOptions` interface (after `auditDir`):

```typescript
/** If set, stdout/stderr of host commands are piped through nas-mask-filter. */
maskFilter?: { binaryPath: string; secretsFramePath: string };
```

Add a field to `HostExecBroker` class (after `notificationTasks`):

```typescript
private readonly maskFilter?: { binaryPath: string; secretsFramePath: string };
```

In the constructor body (after `this.secretStore = ...`):

```typescript
this.maskFilter = options.maskFilter;
```

- [ ] **Step 4: Modify `runResolved` to pipe through mask-filter**

Replace the `await Promise.all([...])` block in `runResolved` (lines 713-726) with:

```typescript
    const wrapStream = (
      stream: ReadableStream<Uint8Array>,
    ): ReadableStream<Uint8Array> => {
      if (!this.maskFilter) return stream;
      const filter = Bun.spawn([this.maskFilter.binaryPath], {
        stdin: stream,
        stdout: "pipe",
        stderr: "ignore",
        env: { NAS_MASK_SECRETS_FILE: this.maskFilter.secretsFramePath },
      });
      return filter.stdout as ReadableStream<Uint8Array>;
    };

    try {
      await Promise.all([
        pipeStreamToSocket(
          wrapStream(proc.stdout as ReadableStream<Uint8Array>),
          socket,
          request.requestId,
          1,
        ),
        pipeStreamToSocket(
          wrapStream(proc.stderr as ReadableStream<Uint8Array>),
          socket,
          request.requestId,
          2,
        ),
      ]);
    }
```

- [ ] **Step 5: Add `maskFilter` to `HostExecBrokerConfig` in broker_service.ts**

In `src/stages/hostexec/broker_service.ts`, add to `HostExecBrokerConfig` interface:

```typescript
readonly maskFilter?: { binaryPath: string; secretsFramePath: string };
```

In the Live implementation's `start` method, pass it through to `new HostExecBroker({...})`:

```typescript
maskFilter: config.maskFilter,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test src/hostexec/broker_integration_test.ts --test-name-pattern 'mask'`
Expected: PASS (both "masks secrets" and "does not mask" tests)

- [ ] **Step 7: Run full broker integration test suite for regressions**

Run: `bun test src/hostexec/broker_integration_test.ts`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/hostexec/broker.ts src/stages/hostexec/broker_service.ts src/hostexec/broker_integration_test.ts
git commit -m "feat(hostexec): pipe stdout/stderr through nas-mask-filter when mask.filter enabled"
```

---

### Task 2: hostexec stage で mask 設定を解決してブローカーに渡す

**Files:**
- Modify: `src/stages/hostexec/stage.ts:118-146` (HostExecPlan.broker), `src/stages/hostexec/stage.ts:207-371` (planHostExec), `src/stages/hostexec/stage.ts:396-416` (runHostExec)
- Test: `src/stages/hostexec/stage_test.ts` (既存テストがあれば追加、なければ新規作成)

**Interfaces:**
- Consumes: `resolveMaskSecrets` from `src/lib/mask_secrets.ts`, `encodeMaskSecrets` from `src/stages/maskfs/secrets_frame.ts`, `resolveMaskFilterBinPath` from `src/stages/maskfs/mask_filter_path.ts`
- Produces: `plan.broker.maskFilter` が Task 1 の `HostExecBrokerConfig.maskFilter` に渡る

- [ ] **Step 1: Write the failing unit test**

`src/stages/hostexec/stage_test.ts` を確認し（なければ作成）、`planHostExec` が mask 設定を broker config に含めることをテストする:

```typescript
import { expect, test } from "bun:test";
import { planHostExec } from "./stage.ts";
import type { StageInput } from "../../pipeline/types.ts";

test("planHostExec: includes maskFilter in broker config when mask.filter enabled", async () => {
  const input = {
    sessionId: "sess_test",
    profileName: "test",
    config: { ui: { enable: false, port: 0, idleTimeout: 0 } },
    profile: {
      agent: "claude",
      hostexec: {
        prompt: {
          enable: true,
          timeoutSeconds: 30,
          defaultScope: "capability" as const,
          notify: "off" as const,
        },
        secrets: {},
        rules: [
          {
            id: "git",
            match: { argv0: "git" },
            cwd: { mode: "any" as const, allow: [] },
            env: {},
            inheritEnv: { mode: "minimal" as const, keys: [] },
            approval: "allow" as const,
            fallback: "deny" as const,
          },
        ],
      },
      mask: {
        values: [{ source: "literal:TEST_SECRET" }],
        writePolicy: "readonly" as const,
        maskfs: false,
        proxy: false,
        filter: true,
      },
    },
    host: {
      env: new Map([["HOME", "/home/test"]]),
      uid: "1000",
    },
    probes: { auditDir: undefined },
  } as unknown as Parameters<typeof planHostExec>[0];

  const plan = await planHostExec(input, { interceptLibPath: null });
  expect(plan).not.toBeNull();
  expect(plan!.broker.maskFilter).toBeDefined();
  expect(plan!.broker.maskFilter!.binaryPath).toContain("nas-mask-filter");
  expect(plan!.broker.maskFilter!.secretsFramePath).toContain("mask-secrets");
});

test("planHostExec: omits maskFilter when mask.filter disabled", async () => {
  const input = {
    sessionId: "sess_test",
    profileName: "test",
    config: { ui: { enable: false, port: 0, idleTimeout: 0 } },
    profile: {
      agent: "claude",
      hostexec: {
        prompt: {
          enable: true,
          timeoutSeconds: 30,
          defaultScope: "capability" as const,
          notify: "off" as const,
        },
        secrets: {},
        rules: [
          {
            id: "git",
            match: { argv0: "git" },
            cwd: { mode: "any" as const, allow: [] },
            env: {},
            inheritEnv: { mode: "minimal" as const, keys: [] },
            approval: "allow" as const,
            fallback: "deny" as const,
          },
        ],
      },
      mask: {
        values: [{ source: "literal:TEST_SECRET" }],
        writePolicy: "readonly" as const,
        maskfs: false,
        proxy: false,
        filter: false,
      },
    },
    host: {
      env: new Map([["HOME", "/home/test"]]),
      uid: "1000",
    },
    probes: { auditDir: undefined },
  } as unknown as Parameters<typeof planHostExec>[0];

  const plan = await planHostExec(input, { interceptLibPath: null });
  expect(plan).not.toBeNull();
  expect(plan!.broker.maskFilter).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/stages/hostexec/stage_test.ts`
Expected: FAIL — `maskFilter` not in broker output

- [ ] **Step 3: Add `maskFilter` to `HostExecPlan.broker` type**

In `src/stages/hostexec/stage.ts`, add to the `broker` field in `HostExecPlan` interface (after `agent`):

```typescript
readonly maskFilter?: { binaryPath: string; secretsFramePath: string };
```

- [ ] **Step 4: Resolve mask filter in `planHostExec` and include in broker config**

At the top of `src/stages/hostexec/stage.ts`, add imports:

```typescript
import { resolveMaskFilterBinPath } from "../../stages/maskfs/mask_filter_path.ts";
import { resolveMaskSecrets } from "../../lib/mask_secrets.ts";
import { encodeMaskSecrets } from "../../stages/maskfs/secrets_frame.ts";
```

In `planHostExec`, before the `return { directories, ... }` block (around line 340), add:

```typescript
  let maskFilter: { binaryPath: string; secretsFramePath: string } | undefined;
  const mask = input.profile.mask;
  if (mask?.filter && mask.values.length > 0) {
    const filterBinPath = await resolveMaskFilterBinPath();
    if (filterBinPath) {
      const env: Record<string, string | undefined> = {};
      for (const [k, v] of input.host.env) env[k] = v;
      const secrets = await resolveMaskSecrets(mask.values, env);
      if (secrets.length > 0) {
        const frame = encodeMaskSecrets(secrets);
        const framePath = path.join(sessionBrokerDirPath, "mask-secrets.frame");
        await mkdir(path.dirname(framePath), { recursive: true, mode: 0o700 });
        await writeFile(framePath, frame, { mode: 0o600 });
        maskFilter = { binaryPath: filterBinPath, secretsFramePath: framePath };
      }
    }
  }
```

Add `writeFile` to the existing `node:fs/promises` import at the top of the file.

Then in the return value, add `maskFilter` to the `broker` object:

```typescript
    broker: {
      // ... existing fields ...
      agent: input.profile.agent,
      maskFilter,
    },
```

- [ ] **Step 5: Pass `maskFilter` through in `runHostExec`**

In the `brokerService.start({...})` call in `runHostExec` (around line 399-414), add:

```typescript
maskFilter: spec.maskFilter,
```

- [ ] **Step 6: Run unit test to verify it passes**

Run: `bun test src/stages/hostexec/stage_test.ts`
Expected: PASS

- [ ] **Step 7: Run type check**

Run: `bun run check`
Expected: No type errors

- [ ] **Step 8: Commit**

```bash
git add src/stages/hostexec/stage.ts src/stages/hostexec/stage_test.ts
git commit -m "feat(hostexec): resolve mask secrets in hostexec stage and pass to broker"
```
