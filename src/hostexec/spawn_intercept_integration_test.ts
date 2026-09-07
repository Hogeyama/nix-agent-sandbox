import { expect, test } from "bun:test";
import { chmod, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  resolveGatewayTestArtifacts,
  startGatewayTestHarness,
} from "./gateway_test_harness.ts";

const artifacts = await resolveGatewayTestArtifacts();
const python = Bun.which("python3");
const available = Boolean(
  python &&
    artifacts.clientPath &&
    artifacts.gatewayPath &&
    artifacts.interceptLibPath,
);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const chdirActionsAvailable =
  Boolean(python) &&
  (await Bun.spawn(
    [
      python!,
      "-c",
      "import ctypes, sys; c = ctypes.CDLL(None); sys.exit(not all(hasattr(c, name) for name in ['posix_spawn_file_actions_addchdir_np', 'posix_spawn_file_actions_addfchdir_np']))",
    ],
    { stdout: "ignore", stderr: "ignore" },
  ).exited) === 0;

// ctypes calls the libc PATH-search entry points directly; os.execvpe would
// search PATH in Python and only exercise execve, hiding this regression.
const launcher = `
import ctypes, os, sys
mode, command = sys.argv[1:3]
args = [command, *sys.argv[3:]]
if mode in ("execvp", "execvpe"):
    libc = ctypes.CDLL(None, use_errno=True)
    argv = (ctypes.c_char_p * (len(args) + 1))(*[os.fsencode(a) for a in args], None)
    if mode == "execvp":
        libc.execvp(os.fsencode(command), argv)
    else:
        env = [os.fsencode(k + "=" + v) for k, v in os.environ.items()]
        envp = (ctypes.c_char_p * (len(env) + 1))(*env, None)
        libc.execvpe(os.fsencode(command), argv, envp)
    raise OSError(ctypes.get_errno(), "exec failed")
pid = getattr(os, mode)(command, args, os.environ)
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
`;

// glibc's public spawn.h structure. Python does not expose the GNU chdir
// actions, so call them through ctypes; all test clients here use glibc.
const chdirLauncher = `
import ctypes, errno, os, sys
c = ctypes.CDLL(None)
class Actions(ctypes.Structure):
    _fields_ = [("allocated", ctypes.c_int), ("used", ctypes.c_int), ("actions", ctypes.c_void_p), ("pad", ctypes.c_int * 16)]
actions = Actions()
assert c.posix_spawn_file_actions_init(ctypes.byref(actions)) == 0
mode, parent, child, command = sys.argv[1:5]
os.chdir(parent)
fd = None
try:
    if mode == "chdir":
        rc = c.posix_spawn_file_actions_addchdir_np(ctypes.byref(actions), os.fsencode(child))
    else:
        fd = os.open(child, os.O_RDONLY | os.O_DIRECTORY)
        rc = c.posix_spawn_file_actions_addfchdir_np(ctypes.byref(actions), fd)
    assert rc == 0
    argv = (ctypes.c_char_p * 2)(os.fsencode(command), None)
    # PATH used for selection belongs to the parent, while the child must
    # receive precisely this separate environment after choosing the command.
    envp = (ctypes.c_char_p * 2)(b"PATH=/not-the-parent-path", None)
    pid = ctypes.c_int()
    rc = c.posix_spawnp(ctypes.byref(pid), os.fsencode(command), ctypes.byref(actions), None, argv, envp)
    if command == "nas-nonexistent-unrelated-command":
        assert rc == errno.ENOENT, rc
        sys.exit(0)
    assert rc == 0, rc
    sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid.value, 0)[1]))
finally:
    if fd is not None: os.close(fd)
    c.posix_spawn_file_actions_destroy(ctypes.byref(actions))
`;

for (const mode of ["chdir", "fchdir"]) {
  for (const interceptedLocation of ["parent", "child"]) {
    test.skipIf(!available || !chdirActionsAvailable)(
      `posix_spawnp: ${mode} selects the child cwd executable (${interceptedLocation} intercepted)`,
      async () => {
        const harness = await startGatewayTestHarness({
          artifacts,
          decide: (request) => ({
            type: "start",
            spec: {
              argv0: "/bin/echo",
              args: ["host"],
              cwd: request.cwd,
              env: {},
            },
          }),
        });
        try {
          const parent = harness.wrapperDir;
          const child = harness.realDir;
          await writeFile(
            path.join(parent, "hostexec"),
            "#!/bin/sh\necho wrong-parent\n",
            { mode: 0o755 },
          );
          await writeFile(
            path.join(child, "hostexec"),
            '#!/bin/sh\nprintf "child %s\\n" "$PATH"\n',
            { mode: 0o755 },
          );
          const result = await harness.runShell(
            `${quote(python!)} -c ${quote(chdirLauncher)} ${mode} ${quote(parent)} ${quote(child)} hostexec`,
            {
              interceptedPath: path.join(
                interceptedLocation === "parent" ? parent : child,
                "hostexec",
              ),
              pathEnv: mode === "chdir" ? ".:/bin:/usr/bin" : ":/bin:/usr/bin",
            },
          );
          expect(result).toEqual({
            exitCode: 0,
            stdout:
              interceptedLocation === "parent"
                ? "child /not-the-parent-path\n"
                : "host\n",
            stderr: "",
          });
          expect(harness.requests).toHaveLength(
            interceptedLocation === "parent" ? 0 : 1,
          );
          if (interceptedLocation === "child") {
            expect(harness.requests[0].argv0).toBe(
              path.join(child, "hostexec"),
            );
            expect(harness.requests[0].cwd).toBe(child);
          }
          const missing = await harness.runShell(
            `${quote(python!)} -c ${quote(chdirLauncher)} ${mode} ${quote(parent)} ${quote(child)} nas-nonexistent-unrelated-command`,
            {
              interceptedPath: path.join(parent, "hostexec"),
              pathEnv: ".:/bin:/usr/bin",
            },
          );
          expect(missing.exitCode).toBe(0);
        } finally {
          await harness.close();
        }
      },
    );
  }
}

test.skipIf(!available || !chdirActionsAvailable)(
  "posix_spawnp: chdir rechecks a PATH alias that pointed at the parent target",
  async () => {
    const harness = await startGatewayTestHarness({ artifacts });
    try {
      const installed = path.join(harness.wrapperDir, "hostexec");
      await writeFile(installed, "#!/bin/sh\necho wrong-parent\n", {
        mode: 0o755,
      });
      await symlink(installed, path.join(harness.wrapperDir, "hx"));
      await writeFile(
        path.join(harness.realDir, "hx"),
        "#!/bin/sh\necho child\n",
        { mode: 0o755 },
      );
      const result = await harness.runShell(
        `${quote(python!)} -c ${quote(chdirLauncher)} chdir ${quote(harness.wrapperDir)} ${quote(harness.realDir)} hx`,
        {
          interceptedPath: installed,
          pathEnv: ".:/bin:/usr/bin",
        },
      );
      expect(result).toEqual({ exitCode: 0, stdout: "child\n", stderr: "" });
      expect(harness.requests).toHaveLength(0);
    } finally {
      await harness.close();
    }
  },
);

for (const decision of ["fallback", "error"] as const) {
  test.skipIf(!available || !chdirActionsAvailable)(
    `posix_spawnp: child PATH selection preserves ${decision}`,
    async () => {
      const harness = await startGatewayTestHarness({
        artifacts,
        decide: () =>
          decision === "fallback"
            ? { type: "fallback" }
            : { type: "error", message: "denied" },
      });
      try {
        const installed = path.join(harness.realDir, "hostexec");
        await writeFile(installed, "#!/bin/sh\necho child\n", { mode: 0o755 });
        const result = await harness.runShell(
          `${quote(python!)} -c ${quote(chdirLauncher)} chdir ${quote(harness.wrapperDir)} ${quote(harness.realDir)} hostexec`,
          {
            interceptedPath: installed,
            pathEnv: ".:/bin:/usr/bin",
          },
        );
        expect(result.exitCode).toBe(decision === "fallback" ? 0 : 1);
        expect(result.stdout).toBe(decision === "fallback" ? "child\n" : "");
        expect(harness.requests).toHaveLength(1);
        expect(harness.requests[0].argv0).toBe(installed);
      } finally {
        await harness.close();
      }
    },
  );
}

test.skipIf(!available)(
  "ordinary wrapper arguments cannot select the private spawn mode",
  async () => {
    const harness = await startGatewayTestHarness({ artifacts });
    try {
      const result = await harness.runBareShell(
        "intercepted-no-read --nas-intercept-spawn fake-socket fake-session /bin/echo bypass",
      );
      expect(result.exitCode).toBe(0);
      expect(harness.requests).toHaveLength(1);
      expect(path.basename(harness.requests[0].argv0)).toBe(
        "intercepted-no-read",
      );
      expect(harness.requests[0].args).toEqual([
        "--nas-intercept-spawn",
        "fake-socket",
        "fake-session",
        "/bin/echo",
        "bypass",
      ]);
    } finally {
      await harness.close();
    }
  },
);

for (const mode of ["execvp", "execvpe", "posix_spawnp"]) {
  test.skipIf(!available)(
    `installed hostexec: ${mode} resolves the first PATH executable before interception`,
    async () => {
      const harness = await startGatewayTestHarness({
        artifacts,
        decide: (request) => ({
          type: "start",
          spec: {
            argv0: "/bin/echo",
            args: ["host"],
            cwd: request.cwd,
            env: {},
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
        const run = `${quote(python!)} -c ${quote(launcher)} ${mode} hostexec /bin/echo local`;
        const result = await harness.runShell(run, {
          interceptedPath: installed,
        });
        expect(result).toEqual({ exitCode: 0, stdout: "host\n", stderr: "" });
        expect(harness.requests.at(-1)?.argv0).toBe(installed);
        await writeFile(
          path.join(harness.realDir, "hostexec"),
          "#!/bin/sh\necho shadow\n",
          { mode: 0o755 },
        );
        const shadow = await harness.runShell(run, {
          interceptedPath: installed,
          pathEnv: `${harness.realDir}:${harness.wrapperDir}:${process.env.PATH}`,
        });
        expect(shadow.stdout).toBe("shadow\n");
        expect(harness.requests).toHaveLength(1);
        // A non-executable earlier candidate must not hide the installed one.
        await chmod(path.join(harness.realDir, "hostexec"), 0o644);
        const skipped = await harness.runShell(run, {
          interceptedPath: installed,
          pathEnv: `${harness.realDir}:${harness.wrapperDir}:${process.env.PATH}`,
        });
        expect(skipped.stdout).toBe("host\n");
        expect(harness.requests).toHaveLength(2);
      } finally {
        await harness.close();
      }
    },
  );
}

test.skipIf(!available)(
  "installed hostexec: spawned host command receives the file-action stdin",
  async () => {
    const harness = await startGatewayTestHarness({
      artifacts,
      decide: (request) => ({
        type: "start",
        spec: { argv0: "/bin/cat", args: [], cwd: request.cwd, env: {} },
      }),
    });
    try {
      const installed = path.join(harness.wrapperDir, "hostexec");
      await writeFile(
        installed,
        await readFile(new URL("./hostexec", import.meta.url)),
        { mode: 0o755 },
      );
      const input = path.join(harness.rootDir, "spawn-input");
      await writeFile(input, "child input\n");
      const code = `
import os, sys
actions = [(os.POSIX_SPAWN_OPEN, 0, ${JSON.stringify(input)}, os.O_RDONLY, 0)]
pid = os.posix_spawn(${JSON.stringify(installed)}, ["hostexec", "cat"], os.environ, file_actions=actions)
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
`;
      const result = await harness.runShell(
        `${quote(python!)} -c ${quote(code)}`,
        { interceptedPath: installed },
      );
      expect(result).toEqual({
        exitCode: 0,
        stdout: "child input\n",
        stderr: "",
      });
      expect(harness.requests[0].stdinMode).toBe("fd");
    } finally {
      await harness.close();
    }
  },
);

test.skipIf(!available)(
  "installed hostexec: spawned command fails closed without parent broker metadata",
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
      const result = await harness.runShell(
        `${quote(python!)} -c ${quote(launcher)} posix_spawn ${quote(installed)} /bin/echo forbidden`,
        { interceptedPath: installed, socketPath: null },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("broker environment is incomplete");
      expect(harness.requests).toHaveLength(0);
    } finally {
      await harness.close();
    }
  },
);

test.skipIf(!available)(
  "installed hostexec: posix_spawn falls back to local help",
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
      const result = await harness.runShell(
        `${quote(python!)} -c ${quote(launcher)} posix_spawn ${quote(installed)} --help`,
        { interceptedPath: installed },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("usage: hostexec");
      expect(harness.requests).toHaveLength(1);
    } finally {
      await harness.close();
    }
  },
);

for (const decision of ["fallback", "start", "error"] as const) {
  test.skipIf(!available)(
    `installed hostexec: posix_spawn ${decision} preserves spawn state and denial`,
    async () => {
      const harness = await startGatewayTestHarness({
        artifacts,
        decide: (request) =>
          decision === "start"
            ? {
                type: "start",
                spec: {
                  argv0: "/bin/echo",
                  args: ["host"],
                  cwd: request.cwd,
                  env: {},
                },
              }
            : decision === "error"
              ? { type: "error", message: "denied" }
              : { type: "fallback" },
      });
      try {
        const installed = path.join(harness.wrapperDir, "hostexec");
        await writeFile(
          installed,
          await readFile(new URL("./hostexec", import.meta.url)),
          { mode: 0o755 },
        );
        const output = path.join(harness.rootDir, "spawn-output");
        const code = `
import os, sys
env = {"PATH": os.environ["PATH"], "SPAWN_MARKER": "child-only"}
args = [${JSON.stringify(installed)}, ${JSON.stringify(python)}, "-c", "import os; print(os.environ['SPAWN_MARKER'], os.getpid() == os.getpgrp())"]
actions = [(os.POSIX_SPAWN_OPEN, 1, ${JSON.stringify(output)}, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)]
pid = os.posix_spawn(args[0], args, env, file_actions=actions, setpgroup=0)
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
`;
        const result = await harness.runShell(
          `${quote(python!)} -c ${quote(code)}`,
          { interceptedPath: installed },
        );
        expect(result.exitCode).toBe(decision === "error" ? 1 : 0);
        expect(result.stdout).toBe("");
        expect(await readFile(output, "utf8")).toBe(
          decision === "start"
            ? "host\n"
            : decision === "fallback"
              ? "child-only True\n"
              : "",
        );
        expect(harness.requests).toHaveLength(1);
      } finally {
        await harness.close();
      }
    },
  );
}
