import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { DEFAULT_HOSTEXEC_CONFIG } from "../config/types.ts";
import {
  HostExecBrokerService,
  HostExecBrokerServiceLive,
} from "../stages/hostexec/broker_service.ts";
import {
  resolveGatewayTestArtifacts,
  startGatewayTestHarness,
} from "./gateway_test_harness.ts";
import { resolveHostExecRuntimePaths } from "./registry.ts";

const artifacts = await resolveGatewayTestArtifacts();
const available = Boolean(
  artifacts.gatewayPath && artifacts.interceptLibPath && Bun.which("bash"),
);

test.skipIf(!available)(
  "installed hostexec: real broker and gateway execute the approved payload",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nas-hi-"));
    try {
      const paths = await resolveHostExecRuntimePaths(root);
      const bin = path.join(root, "bin");
      await mkdir(bin);
      const installed = path.join(bin, "hostexec");
      await writeFile(
        installed,
        await readFile(new URL("./hostexec", import.meta.url)),
        { mode: 0o755 },
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* HostExecBrokerService;
            yield* Effect.acquireRelease(
              service.start({
                paths,
                sessionId: "installed",
                execSocketPath: path.join(root, "external.sock"),
                internalSocketPath: path.join(root, "internal.sock"),
                controlSocketPath: path.join(root, "control.sock"),
                gatewayBinaryPath: artifacts.gatewayPath!,
                profileName: "test",
                workspaceRoot: root,
                sessionTmpDir: root,
                installedScriptPath: installed,
                notify: "off",
                hostexec: {
                  ...structuredClone(DEFAULT_HOSTEXEC_CONFIG),
                  installScript: true,
                  rules: [
                    {
                      id: "hostexec",
                      match: { argv0: "hostexec" },
                      cwd: { mode: "workspace-only", allow: [] },
                      env: {},
                      inheritEnv: { mode: "minimal", keys: [] },
                      approval: "allow",
                      fallback: "deny",
                    },
                  ],
                },
              }),
              (handle) => handle.close().pipe(Effect.orDie),
            );
            yield* Effect.tryPromise(async () => {
              const childEnv = { ...process.env };
              for (const key of Object.keys(childEnv)) {
                if (key.startsWith("NAS_HOSTEXEC_") || key === "LD_PRELOAD")
                  delete childEnv[key];
              }
              const child = Bun.spawn(
                [
                  Bun.which("bash")!,
                  "-c",
                  "hostexec -- printf '%s|%s' 'two words' ''",
                ],
                {
                  cwd: root,
                  env: {
                    ...childEnv,
                    PATH: `${bin}:${process.env.PATH ?? ""}`,
                    LD_PRELOAD: artifacts.interceptLibPath!,
                    NAS_HOSTEXEC_INTERCEPT_PATHS: installed,
                    NAS_HOSTEXEC_SOCKET: path.join(root, "external.sock"),
                    NAS_HOSTEXEC_SESSION_ID: "installed",
                    NAS_HOSTEXEC_WRAPPER_DIR: bin,
                  },
                  stdout: "pipe",
                  stderr: "pipe",
                  stdin: "ignore",
                },
              );
              const [code, stdout, stderr] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
              ]);
              expect({ code, stdout, stderr }).toEqual({
                code: 0,
                stdout: "two words|",
                stderr: "",
              });
            });
          }),
        ).pipe(Effect.provide(HostExecBrokerServiceLive)),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!available)(
  "installed hostexec: PATH invocation reaches gateway and preserves payload argv",
  async () => {
    const harness = await startGatewayTestHarness({
      artifacts,
      decide: (request) => ({
        type: "start",
        spec: {
          argv0: "/bin/sh",
          args: ["-c", 'printf "%s\\n" "$@"', "host", ...request.args],
          cwd: request.cwd,
          env: { PATH: process.env.PATH ?? "" },
        },
      }),
    });
    try {
      const installed = path.join(harness.wrapperDir, "hostexec");
      await writeFile(
        installed,
        await readFile(new URL("./hostexec", import.meta.url)),
        { mode: 0o755 },
      );
      const result = await harness.runShell(
        "hostexec -- printf 'two words' ''",
        { interceptedPath: installed },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("--\nprintf\ntwo words\n\n");
      expect(harness.requests).toHaveLength(1);
      expect(harness.requests[0].argv0).toBe(installed);
      expect(harness.requests[0].args).toEqual([
        "--",
        "printf",
        "two words",
        "",
      ]);
    } finally {
      await harness.close();
    }
  },
);

test.skipIf(!available)(
  "installed hostexec: unmatched request runs canonical fallback and local usage",
  async () => {
    const harness = await startGatewayTestHarness({
      artifacts,
      decide: () => ({ type: "fallback" }),
    });
    try {
      const installed = path.join(harness.wrapperDir, "hostexec");
      await writeFile(
        installed,
        await readFile(new URL("./hostexec", import.meta.url)),
        { mode: 0o755 },
      );
      const options = { interceptedPath: installed };
      const fallback = await harness.runShell(
        "hostexec -- printf '%s' 'local payload'",
        options,
      );
      expect(fallback.exitCode).toBe(0);
      expect(fallback.stdout).toBe("local payload");
      expect(fallback.stderr).toContain("container");
      const help = await harness.runShell("hostexec --help", options);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain("usage: hostexec");
      const empty = await harness.runShell("hostexec --", options);
      expect(empty.exitCode).toBe(64);
    } finally {
      await harness.close();
    }
  },
);
