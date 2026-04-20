/**
 * HostExec Stage (EffectStage)
 *
 * ホスト上のコマンド実行を仲介する HostExecBroker を起動し、
 * エージェントコンテナ内からラッパースクリプト経由でアクセスできるようにする。
 */

import * as path from "node:path";
import { Effect, type Scope } from "effect";
import {
  DEFAULT_HOSTEXEC_CONFIG,
  type HostExecRule,
} from "../../config/types.ts";
import {
  INTERCEPT_LIB_CONTAINER_PATH,
  resolveInterceptLibPath,
} from "../../hostexec/intercept_path.ts";
import {
  isBareCommandHostExecArgv0,
  isRelativeHostExecArgv0,
} from "../../hostexec/match.ts";
import {
  type HostExecRuntimePaths,
  hostExecBrokerSocketPath,
  hostExecSessionBrokerDir,
} from "../../hostexec/registry.ts";
import { resolveNotifyBackend } from "../../lib/notify_utils.ts";
import { mergeContainerPlan } from "../../pipeline/container_plan.ts";
import type { Stage } from "../../pipeline/stage_builder.ts";
import type {
  ContainerPlan,
  HostExecState,
  MountSpec,
  PipelineState,
  WorkspaceState,
} from "../../pipeline/state.ts";
import type { HostEnv, StageInput, StageResult } from "../../pipeline/types.ts";
import { HostExecBrokerService } from "./broker_service.ts";
import { HostExecSetupService } from "./setup_service.ts";

const WRAPPER_DIR = "/opt/nas/hostexec/bin";
const SESSION_TMP_ROOT = "/tmp/nas-hostexec";

/**
 * Allowed prefixes for absolute `argv0` values in hostexec rules.
 *
 * These are the only container paths where nas is permitted to shadow a
 * binary with the hostexec wrapper (either via LD_PRELOAD intercept or as a
 * fallback bind-mount). Paths under system-sensitive directories like
 * `/etc`, `/bin`, `/lib`, `/var`, `/root`, etc. must never be targetable
 * from repo config.
 *
 * `CONTAINER_HOME_LOCAL_BIN_PREFIX` is a suffix under the dynamic per-user
 * container home (`/home/<user>/.local/bin`), matched by suffix check.
 */
const ABSOLUTE_ARGV0_ALLOWED_PREFIXES = [
  "/usr/bin/",
  "/usr/local/bin/",
] as const;
const ABSOLUTE_ARGV0_ALLOWED_OPT_PATTERN = /^\/opt\/[^/]+\/bin\//;
const CONTAINER_HOME_LOCAL_BIN_SUFFIX = "/.local/bin/";

/**
 * Validate that an absolute `argv0` in a hostexec rule points at a safe
 * container path. Throws with a descriptive error on rejection.
 *
 * Exported for tests.
 */
export function validateAbsoluteArgv0(ruleId: string, argv0: string): void {
  // Reject exactly "/" or any trailing slash (non-file targets).
  if (argv0 === "/" || argv0.endsWith("/")) {
    throw new Error(
      `hostexec rule ${JSON.stringify(ruleId)}: argv0 ${JSON.stringify(argv0)} is not a file path. ` +
        `Absolute argv0 must be a file under one of: /usr/bin/*, /usr/local/bin/*, /opt/*/bin/*, /home/<user>/.local/bin/*`,
    );
  }
  // Reject any ".." segments to prevent traversal-based prefix bypass.
  const segments = argv0.split("/");
  if (segments.includes("..") || segments.includes(".")) {
    throw new Error(
      `hostexec rule ${JSON.stringify(ruleId)}: argv0 ${JSON.stringify(argv0)} must not contain '.' or '..' segments. ` +
        `Absolute argv0 must be a file under one of: /usr/bin/*, /usr/local/bin/*, /opt/*/bin/*, /home/<user>/.local/bin/*`,
    );
  }
  for (const prefix of ABSOLUTE_ARGV0_ALLOWED_PREFIXES) {
    if (argv0.startsWith(prefix) && argv0.length > prefix.length) return;
  }
  if (ABSOLUTE_ARGV0_ALLOWED_OPT_PATTERN.test(argv0)) return;
  // Allow /home/<user>/.local/bin/<file>
  if (argv0.startsWith("/home/")) {
    const idx = argv0.indexOf(CONTAINER_HOME_LOCAL_BIN_SUFFIX, "/home/".length);
    // ensure the suffix appears directly after the user segment: /home/<user>/.local/bin/...
    if (idx > 0) {
      const afterHome = argv0.slice("/home/".length);
      const userSeg = afterHome.split("/", 1)[0];
      const expected = `/home/${userSeg}${CONTAINER_HOME_LOCAL_BIN_SUFFIX}`;
      if (
        userSeg.length > 0 &&
        argv0.startsWith(expected) &&
        argv0.length > expected.length
      ) {
        return;
      }
    }
  }
  throw new Error(
    `hostexec rule ${JSON.stringify(ruleId)}: absolute argv0 ${JSON.stringify(argv0)} targets a disallowed container path. ` +
      `Allowed prefixes: /usr/bin/*, /usr/local/bin/*, /opt/*/bin/*, /home/<user>/.local/bin/*`,
  );
}

// ---------------------------------------------------------------------------
// HostExecPlan
// ---------------------------------------------------------------------------

export interface HostExecPlan {
  readonly directories: ReadonlyArray<{ path: string; mode: number }>;
  readonly files: ReadonlyArray<{
    path: string;
    content: string;
    mode: number;
  }>;
  readonly symlinks: ReadonlyArray<{ target: string; path: string }>;
  readonly mounts: readonly MountSpec[];
  readonly dockerArgs: string[];
  readonly envVars: Record<string, string>;
  readonly outputOverrides: Pick<StageResult, "hostexec">;
  readonly broker: {
    readonly socketPath: string;
    readonly paths: HostExecRuntimePaths;
    readonly sessionId: string;
    readonly profileName: string;
    readonly workspaceRoot: string;
    readonly sessionTmpDir: string;
    readonly hostexec: StageInput["profile"]["hostexec"];
    readonly notify: ReturnType<typeof resolveNotifyBackend>;
    readonly uiEnabled: boolean;
    readonly uiPort: number;
    readonly uiIdleTimeout: number;
    readonly auditDir: string | undefined;
    readonly agent: StageInput["profile"]["agent"];
  };
}

// ---------------------------------------------------------------------------
// EffectStage
// ---------------------------------------------------------------------------

type HostExecStageState = Pick<PipelineState, "workspace" | "container">;
type HostExecStageInput = StageInput & HostExecStageState;

export function createHostExecStage(
  shared: StageInput,
): Stage<
  "workspace" | "container",
  Pick<StageResult, "container" | "hostexec">,
  HostExecSetupService | HostExecBrokerService,
  unknown
> {
  return {
    name: "HostExecStage",
    needs: ["workspace", "container"],

    run(
      input,
    ): Effect.Effect<
      Pick<StageResult, "container" | "hostexec">,
      unknown,
      Scope.Scope | HostExecSetupService | HostExecBrokerService
    > {
      const stageInput: HostExecStageInput = {
        ...shared,
        ...input,
      };
      return Effect.gen(function* () {
        const plan = yield* Effect.promise(() => planHostExec(stageInput));
        if (plan === null) {
          return {};
        }
        return yield* runHostExec(plan, stageInput);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Planner (pure)
// ---------------------------------------------------------------------------

/** Internal rule: route `nas hook` to the host via HostExec. */
const NAS_HOOK_RULE: HostExecRule = {
  id: "__nas_hook",
  match: { argv0: "nas", argRegex: "^hook\\b" },
  cwd: { mode: "any", allow: [] },
  env: {},
  inheritEnv: {
    mode: "minimal",
    keys: ["NAS_SESSION_ID", "NAS_SESSION_STORE_DIR", "XDG_RUNTIME_DIR"],
  },
  approval: "allow",
  fallback: "container",
};

export async function planHostExec(
  input: HostExecStageInput,
  opts?: { interceptLibPath?: string | null },
): Promise<HostExecPlan | null> {
  const interceptLibPath =
    opts?.interceptLibPath !== undefined
      ? opts.interceptLibPath
      : await resolveInterceptLibPath();
  const config =
    input.profile.hostexec ?? structuredClone(DEFAULT_HOSTEXEC_CONFIG);
  config.rules = [...config.rules, NAS_HOOK_RULE];
  // Reject absolute argv0 values that would bind-mount a wrapper over a
  // sensitive container path (e.g. /etc/passwd, /bin/sh). Validate before
  // any filesystem/mount planning so we fail fast with a clear error.
  for (const rule of config.rules) {
    if (path.isAbsolute(rule.match.argv0)) {
      validateAbsoluteArgv0(rule.id, rule.match.argv0);
    }
  }
  const workspace = resolveWorkspace(input);

  const runtimePaths = resolveHostExecRuntimePathsPure(input.host);
  const sessionBrokerDirPath = hostExecSessionBrokerDir(
    runtimePaths,
    input.sessionId,
  );
  const socketPath = hostExecBrokerSocketPath(runtimePaths, input.sessionId);
  const wrapperRoot = path.join(runtimePaths.wrappersDir, input.sessionId);
  const wrapperBinDir = path.join(wrapperRoot, "bin");
  const wrapperScript = path.join(wrapperBinDir, "hostexec-wrapper.py");
  const sessionTmpDir = path.join(wrapperRoot, "tmp");
  const containerSessionTmp = path.join(SESSION_TMP_ROOT, input.sessionId);

  const directories: HostExecPlan["directories"] = [
    { path: runtimePaths.runtimeDir, mode: 0o755 },
    { path: runtimePaths.sessionsDir, mode: 0o700 },
    { path: runtimePaths.pendingDir, mode: 0o700 },
    { path: runtimePaths.brokersDir, mode: 0o700 },
    { path: sessionBrokerDirPath, mode: 0o700 },
    { path: runtimePaths.wrappersDir, mode: 0o700 },
    { path: wrapperBinDir, mode: 0o755 },
    { path: sessionTmpDir, mode: 0o700 },
  ];

  const files: HostExecPlan["files"] = [
    { path: wrapperScript, content: buildWrapperScript(), mode: 0o755 },
  ];

  const symlinks: Array<{ target: string; path: string }> = [];
  const argv0Names = new Set(
    config.rules
      .map((rule) => rule.match.argv0)
      .filter(isBareCommandHostExecArgv0),
  );
  for (const argv0 of argv0Names) {
    symlinks.push({
      target: "hostexec-wrapper.py",
      path: path.join(wrapperBinDir, argv0),
    });
  }

  const relativeArgv0s = [
    ...new Set(
      config.rules
        .map((rule) => rule.match.argv0)
        .filter(isRelativeHostExecArgv0),
    ),
  ];

  const absoluteArgv0s = [
    ...new Set(
      config.rules
        .map((rule) => rule.match.argv0)
        .filter((argv0) => path.isAbsolute(argv0)),
    ),
  ];

  const workDir = workspace.workDir;
  const workspaceRoot = workspace.mountDir ?? workspace.workDir;
  const interceptPaths = [
    ...relativeArgv0s.map((a) => path.resolve(workDir, a)),
    ...absoluteArgv0s,
  ];

  const mounts: MountSpec[] = [];
  const dockerArgs = [
    "-v",
    addMount(mounts, wrapperBinDir, WRAPPER_DIR, true),
    "-v",
    addMount(mounts, sessionBrokerDirPath, sessionBrokerDirPath),
    "-v",
    addMount(mounts, sessionTmpDir, containerSessionTmp),
  ];

  const envVars: Record<string, string> = {
    NAS_HOSTEXEC_SOCKET: socketPath,
    NAS_HOSTEXEC_WRAPPER_DIR: WRAPPER_DIR,
    NAS_HOSTEXEC_SESSION_ID: input.sessionId,
    NAS_HOSTEXEC_SESSION_TMP: containerSessionTmp,
  };

  if (interceptPaths.length > 0 && interceptLibPath) {
    // LD_PRELOAD 方式: .so をマウントし、環境変数を設定
    const existingLdPreload = envVars.LD_PRELOAD;
    envVars.LD_PRELOAD = existingLdPreload
      ? `${INTERCEPT_LIB_CONTAINER_PATH}:${existingLdPreload}`
      : INTERCEPT_LIB_CONTAINER_PATH;
    envVars.NAS_HOSTEXEC_INTERCEPT_PATHS = interceptPaths.join("\n");
    dockerArgs.push(
      "-v",
      addMount(mounts, interceptLibPath, INTERCEPT_LIB_CONTAINER_PATH, true),
    );
  } else if (interceptPaths.length > 0) {
    // フォールバック: .so が見つからない場合は従来の bind mount 方式
    for (const argv0 of relativeArgv0s) {
      const target = path.resolve(workDir, argv0);
      dockerArgs.push("-v", addMount(mounts, wrapperScript, target, true));
    }
    for (const argv0 of absoluteArgv0s) {
      dockerArgs.push("-v", addMount(mounts, wrapperScript, argv0, true));
    }
  }

  return {
    directories,
    files,
    symlinks,
    mounts,
    dockerArgs,
    envVars,
    outputOverrides: {
      hostexec: {
        runtimeDir: runtimePaths.runtimeDir,
        brokerSocket: socketPath,
        sessionTmpDir: containerSessionTmp,
      } satisfies HostExecState,
    },
    broker: {
      socketPath,
      paths: runtimePaths,
      sessionId: input.sessionId,
      profileName: input.profileName,
      workspaceRoot,
      sessionTmpDir,
      hostexec: config,
      notify: resolveNotifyBackend(config.prompt.notify),
      uiEnabled: input.config.ui.enable,
      uiPort: input.config.ui.port,
      uiIdleTimeout: input.config.ui.idleTimeout,
      auditDir: input.probes.auditDir,
      agent: input.profile.agent,
    },
  };
}

// ---------------------------------------------------------------------------
// Effect runner
// ---------------------------------------------------------------------------

function runHostExec(
  plan: HostExecPlan,
  input: HostExecStageInput,
): Effect.Effect<
  Pick<StageResult, "container" | "hostexec">,
  unknown,
  Scope.Scope | HostExecSetupService | HostExecBrokerService
> {
  return Effect.gen(function* () {
    const setupService = yield* HostExecSetupService;
    const brokerService = yield* HostExecBrokerService;
    const container = buildContainerState(input, plan);

    yield* setupService.prepareWorkspace({
      directories: plan.directories,
      files: plan.files,
      symlinks: plan.symlinks,
    });

    const spec = plan.broker;

    yield* Effect.acquireRelease(
      brokerService.start({
        paths: spec.paths,
        sessionId: spec.sessionId,
        socketPath: spec.socketPath,
        profileName: spec.profileName,
        workspaceRoot: spec.workspaceRoot,
        sessionTmpDir: spec.sessionTmpDir,
        hostexec: spec.hostexec,
        notify: spec.notify,
        uiEnabled: spec.uiEnabled,
        uiPort: spec.uiPort,
        uiIdleTimeout: spec.uiIdleTimeout,
        auditDir: spec.auditDir,
        agent: spec.agent,
      }),
      (handle) => handle.close(),
    );

    return {
      ...plan.outputOverrides,
      container,
    };
  });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function resolveHostExecRuntimePathsPure(
  host: HostEnv,
): HostExecRuntimePaths {
  const xdg = host.env.get("XDG_RUNTIME_DIR");
  let runtimeDir: string;
  if (xdg && xdg.trim().length > 0) {
    runtimeDir = path.join(xdg, "nas", "hostexec");
  } else {
    const uid = host.uid ?? "unknown";
    runtimeDir = path.join("/tmp", `nas-${uid}`, "hostexec");
  }
  return {
    runtimeDir,
    sessionsDir: path.join(runtimeDir, "sessions"),
    pendingDir: path.join(runtimeDir, "pending"),
    brokersDir: path.join(runtimeDir, "brokers"),
    wrappersDir: path.join(runtimeDir, "wrappers"),
  };
}

function resolveWorkspace(input: {
  workspace: WorkspaceState;
}): WorkspaceState {
  return input.workspace;
}

function buildContainerState(
  input: { workspace: WorkspaceState; container: ContainerPlan },
  plan: HostExecPlan,
): ContainerPlan {
  const workspace = resolveWorkspace(input);
  return mergeContainerPlan(resolveContainerBase(input, workspace), {
    mounts: plan.mounts,
    env: { static: plan.envVars },
  });
}

function resolveContainerBase(
  input: { container: ContainerPlan },
  _workspace: WorkspaceState,
): ContainerPlan {
  return input.container;
}

function addMount(
  mounts: MountSpec[],
  source: string,
  target: string,
  readOnly = false,
): string {
  mounts.push(
    readOnly ? { source, target, readOnly: true } : { source, target },
  );
  return `${source}:${target}${readOnly ? ":ro" : ""}`;
}

function buildWrapperScript(): string {
  return `#!/usr/bin/env python3
import base64
import json
import os
import select
import shutil
import socket
import subprocess
import sys


def find_fallback_binary(argv0: str, wrapper_dir: str) -> str:
    if os.path.sep in argv0:
        argv0 = os.path.basename(argv0)
    path_value = os.environ.get("PATH", "")
    for directory in path_value.split(":"):
        if not directory:
            continue
        candidate = os.path.join(directory, argv0)
        if not os.path.isfile(candidate) or not os.access(candidate, os.X_OK):
            continue
        if os.path.realpath(candidate).startswith(os.path.realpath(wrapper_dir)):
            continue
        return candidate
    resolved = shutil.which(argv0)
    if resolved and not os.path.realpath(resolved).startswith(os.path.realpath(wrapper_dir)):
        return resolved
    raise FileNotFoundError(f"fallback binary not found: {argv0}")


def call_broker(payload: dict) -> dict:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(os.environ["NAS_HOSTEXEC_SOCKET"])
    try:
        sock.sendall((json.dumps(payload) + "\\n").encode())
        data = b""
        while not data.endswith(b"\\n"):
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
        if not data:
            raise RuntimeError("empty hostexec broker response")
        return json.loads(data.decode())
    finally:
        sock.close()

def read_available_stdin() -> bytes:
    fd = sys.stdin.fileno()
    chunks = []
    while True:
        ready, _, _ = select.select([fd], [], [], 0)
        if not ready:
            break
        chunk = os.read(fd, 65536)
        if not chunk:
            break
        chunks.append(chunk)
    return b"".join(chunks)


def main() -> int:
    argv0 = sys.argv[0]
    payload = {
        "version": 1,
        "type": "execute",
        "sessionId": os.environ.get("NAS_HOSTEXEC_SESSION_ID", ""),
        "requestId": f"req_{os.getpid()}_{os.urandom(4).hex()}",
        "argv0": argv0,
        "args": sys.argv[1:],
        "cwd": os.getcwd(),
        "tty": sys.stdin.isatty(),
    }
    if not sys.stdin.isatty():
        stdin_data = read_available_stdin()
        if stdin_data:
            payload["stdin"] = base64.b64encode(stdin_data).decode()

    response = call_broker(payload)
    if response["type"] == "fallback":
        if (not os.path.isabs(argv0)) and (os.path.sep in argv0):
            print(f"relative argv0 fallback is not supported: {argv0}", file=sys.stderr)
            return 1
        binary = find_fallback_binary(argv0, os.environ["NAS_HOSTEXEC_WRAPPER_DIR"])
        os.execv(binary, [binary, *sys.argv[1:]])
    if response["type"] == "error":
        print(response["message"], file=sys.stderr)
        return 1
    stdout_b64 = response.get("stdout", "")
    stderr_b64 = response.get("stderr", "")
    if stdout_b64:
        sys.stdout.buffer.write(base64.b64decode(stdout_b64))
        sys.stdout.flush()
    if stderr_b64:
        sys.stderr.buffer.write(base64.b64decode(stderr_b64))
        sys.stderr.flush()
    return int(response.get("exitCode", 0))


if __name__ == "__main__":
    raise SystemExit(main())
`;
}
