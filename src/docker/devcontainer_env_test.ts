import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createDirenvLauncherFixture } from "./direnv_exec_fixture.ts";

// Inside a nas sandbox namespace the bash on PATH is nas's own wrapper, which
// points DOCKER_HOST at that namespace's DinD relay.
function bashInterposed(): boolean {
  const probe = Bun.spawnSync(["bash", "-c", 'printf %s "$DOCKER_HOST"'], {
    env: { ...process.env, DOCKER_HOST: "nas-test-probe" },
    stderr: "pipe",
  });
  return (
    probe.stdout.toString() !== "nas-test-probe" || probe.stderr.length > 0
  );
}
const bashTest = test.skipIf(bashInterposed());

async function fixture(run: (root: string, library: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "nas-devcontainer-env-"));
  try {
    const launcher = await createDirenvLauncherFixture(
      root,
      "/bin/false",
      Bun.which("jq")!,
    );
    const library = path.join(root, "env.sh");
    await writeFile(
      library,
      (
        await readFile(
          new URL("./embed/devcontainer-env.sh", import.meta.url),
          "utf8",
        )
      )
        .replaceAll("/usr/local/lib/nas/devcontainer", `${root}/state`)
        .replaceAll("/usr/local/bin/nas-direnv-exec", launcher),
    );
    await mkdir(path.join(root, "state"));
    for (const name of ["exec", "claude", "codex", "idle"]) {
      const source = await readFile(
        new URL(`./embed/devcontainer-${name}.sh`, import.meta.url),
        "utf8",
      );
      await writeFile(
        path.join(root, `nas-devcontainer-${name}`),
        source
          .replaceAll("/usr/local/lib/nas/devcontainer-env.sh", library)
          .replaceAll("/usr/local/lib/nas/devcontainer", `${root}/state`)
          .replaceAll(
            "/usr/local/bin/nas-devcontainer-exec",
            `${root}/nas-devcontainer-exec`,
          )
          .replaceAll("/run/nas-devcontainer", `${root}/state`),
        { mode: 0o755 },
      );
    }
    await run(root, library);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function shell(script: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bash", "-c", script], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

for (const sameNamespace of [true, false]) {
  bashTest(
    `a login shell keeps its namespace's Docker relay: same namespace=${sameNamespace}`,
    async () => {
      await fixture(async (root, library) => {
        const relay = "unix:///tmp/nas-dind-1000-session-7/docker.sock";
        const result = await shell(
          `set -euo pipefail
source "$LIBRARY"
nas_devcontainer_capture '' '' claude
export DOCKER_HOST="$NAS_TEST_RELAY" TESTCONTAINERS_HOST_OVERRIDE=127.0.0.1
if [ "$NAS_TEST_SAME" = true ]; then
  export NAS_DIND_RELAY_NETNS="$(readlink /proc/self/ns/net)"
else
  export NAS_DIND_RELAY_NETNS="net:[0]"
fi
nas_devcontainer_apply
printf '%s' "$DOCKER_HOST"
`,
          {
            DOCKER_HOST: "unix:///run/nas-dind-bridge/docker.sock",
            NAS_TEST_RELAY: relay,
            NAS_TEST_SAME: String(sameNamespace),
            LIBRARY: library,
            NAS_REAL_BASH: "/bin/bash",
            NAS_DIRENV_ENABLED: "false",
            WORKSPACE: root,
          },
        );
        expect(result).toMatchObject({
          code: 0,
          stdout: sameNamespace
            ? relay
            : "unix:///run/nas-dind-bridge/docker.sock",
        });
      });
    },
  );
}

bashTest(
  "IDE baseline preserves the built-in DinD and Testcontainers environment",
  async () => {
    await fixture(async (root, library) => {
      const env = {
        DOCKER_HOST: "tcp://127.0.0.1:2375",
        NAS_DIND_BRIDGE: "1",
        NAS_DIND_SHARED_TMP: "/tmp/nas-shared",
        TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE: "/run/user/1000/docker.sock",
        TESTCONTAINERS_CONNECTION_MODE: "docker_host",
        TESTCONTAINERS_HOST_OVERRIDE: "127.0.0.1",
      };
      const result = await shell(
        `set -euo pipefail
source "$LIBRARY"
nas_devcontainer_capture '' '' claude
unset ${Object.keys(env).join(" ")}
nas_devcontainer_apply
printf '%s\\n' ${Object.keys(env)
          .map((key) => `"$${key}"`)
          .join(" ")}
`,
        {
          ...env,
          LIBRARY: library,
          NAS_REAL_BASH: "/bin/bash",
          NAS_DIRENV_ENABLED: "false",
          WORKSPACE: root,
        },
      );
      expect(result).toMatchObject({
        code: 0,
        stdout: `${Object.values(env).join("\n")}\n`,
      });
    });
  },
);

test("baseline resets unset dynamic keys and applies prefix exactly once on reentry", async () => {
  await fixture(async (root, library) => {
    const ops = path.join(root, "ops.sh");
    await writeFile(
      ops,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Bash expansion is intentional.
      'export NAS_TEST_PREFIX="prefix${NAS_TEST_PREFIX+:$NAS_TEST_PREFIX}"\n',
    );
    const result = await shell(
      `set -euo pipefail
source "$LIBRARY"
unset NAS_TEST_PREFIX
nas_devcontainer_capture "$OPS" '' claude --guide 'two words'
export NAS_TEST_PREFIX=stale
nas_devcontainer_apply
printf '%s\\n' "$NAS_TEST_PREFIX"
nas_devcontainer_apply
printf '%s\\n' "$NAS_TEST_PREFIX"
`,
      {
        LIBRARY: library,
        OPS: ops,
        NAS_REAL_BASH: "/bin/bash",
        NAS_DIRENV_ENABLED: "false",
        WORKSPACE: root,
        NAS_DEVCONTAINER_ENV_KEYS: "NAS_TEST_PREFIX",
      },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("prefix\nprefix\n");
  });
});
test("capture quotes literal values, preserves selected runtime, and excludes upstream authentication", async () => {
  await fixture(async (root, library) => {
    const literal = 'value $(touch /tmp/nas-must-not-run); "quotes"\nnext';
    const result = await shell(
      `set -euo pipefail
source "$LIBRARY"
nas_devcontainer_capture '' '' claude '' 'two words' '$(false)'
export JAVA_TOOL_OPTIONS=wrong NAS_HOSTEXEC_SOCKET=stale
nas_devcontainer_apply
printf '%s\\0%s' "$JAVA_TOOL_OPTIONS" "$NAS_HOSTEXEC_SOCKET"
`,
      {
        LIBRARY: library,
        NAS_REAL_BASH: "/bin/bash",
        NAS_DIRENV_ENABLED: "false",
        WORKSPACE: root,
        JAVA_TOOL_OPTIONS: literal,
        NAS_HOSTEXEC_SOCKET: "/run/nas/exec.sock",
        NAS_UPSTREAM_PROXY: "http://secret:credential@upstream",
      },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${literal}\0/run/nas/exec.sock`);
    const saved = await readFile(path.join(root, "state/baseline.sh"), "utf8");
    expect(saved).not.toContain("secret:credential@upstream");
    expect(saved).not.toContain("NAS_UPSTREAM_PROXY");
    const args = await shell(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Bash expansion is intentional.
      'source "$ARGS"; printf "%s\\0" "${NAS_AGENT_ARGS[@]}"',
      { ARGS: path.join(root, "state/claude-args.sh") },
    );
    expect(args.stdout.split("\0")).toEqual(["", "two words", "$(false)", ""]);
    const codexArgs = await shell(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Bash expansion is intentional.
      'source "$ARGS"; printf "%s\\0" "${NAS_AGENT_ARGS[@]}"',
      { ARGS: path.join(root, "state/codex-args.sh") },
    );
    expect(codexArgs.stdout.split("\0")).toEqual(["", ""]);
  });
});

test.each([
  "",
  "copilot",
])("capture rejects an invalid primary agent (%p)", async (primary) => {
  await fixture(async (root, library) => {
    const result = await shell(
      `source "$LIBRARY"; nas_devcontainer_capture "" "" "$PRIMARY" 'two words'`,
      {
        LIBRARY: library,
        PRIMARY: primary,
        NAS_REAL_BASH: "/bin/bash",
        NAS_DIRENV_ENABLED: "false",
        WORKSPACE: root,
      },
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Invalid Dev Container primary agent");
  });
});

for (const primary of ["claude", "codex"] as const) {
  test(`wrappers isolate arguments when primary is ${primary}`, async () => {
    await fixture(async (root, library) => {
      const binDir = path.join(
        root,
        "extensions/openai.chatgpt-test/bin/linux-x64",
      );
      await mkdir(binDir, { recursive: true });
      const payload = path.join(binDir, "codex");
      await writeFile(
        payload,
        `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2))); process.stderr.write("diagnostic"); process.exit(23);\n`,
        { mode: 0o755 },
      );
      const env = {
        HOME: root,
        PRIMARY: primary,
        LIBRARY: library,
        PATH: `${process.env.PATH}:${binDir}`,
        NAS_REAL_BASH: "/bin/bash",
        NAS_DIRENV_ENABLED: "false",
        WORKSPACE: root,
      };
      const setup = await shell(
        `source "$LIBRARY"
nas_devcontainer_capture "" "" "$PRIMARY" "" "two words" '$(false)' $'line\\nbreak'`,
        env,
      );
      expect(setup.code).toBe(0);
      const profileArgs = ["", "two words", "$(false)", "line\nbreak"];
      const extensionArgs = ["--resume", "chat id", ""];
      for (const agent of ["claude", "codex"] as const) {
        // Arrays cannot cross a process env boundary. A forged
        // NAS_AGENT_ARGS is a scalar; the wrapper must use the captured file.
        const proc = Bun.spawn(
          [
            path.join(root, `nas-devcontainer-${agent}`),
            ...(agent === "claude" ? [payload] : []),
            ...extensionArgs,
          ],
          {
            env: {
              ...process.env,
              ...env,
              NAS_AGENT_ARGS: "(--forged)",
              NAS_DEVCONTAINER_PRIMARY_AGENT:
                primary === "claude" ? "codex" : "claude",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [code, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        expect(code).toBe(23);
        expect(stderr).toBe("diagnostic");
        expect(JSON.parse(stdout)).toEqual([
          ...(agent === "codex"
            ? ["-c", "shell_environment_policy.inherit=all"]
            : []),
          ...(primary === agent ? profileArgs : []),
          ...extensionArgs,
        ]);
      }
    });
  });
}

test("codex wrapper selects the bundled CLI and its sibling helper ahead of host binaries", async () => {
  await fixture(async (root, library) => {
    // An extra Codex CLI puts both host binaries on the captured baseline
    // PATH. The IDE wrapper must prefer the extension CLI and its helper.
    const hostDir = path.join(root, "host-bin");
    await mkdir(hostDir, { recursive: true });
    await writeFile(
      path.join(hostDir, "codex"),
      "#!/bin/bash\nprintf host-codex; exit 97\n",
      { mode: 0o755 },
    );
    await writeFile(
      path.join(hostDir, "codex-code-mode-host"),
      "#!/bin/bash\nprintf host; exit 41\n",
      { mode: 0o755 },
    );
    const binDir = path.join(
      root,
      "extensions/openai.chatgpt-test/bin/linux-x64",
    );
    await mkdir(binDir, { recursive: true });
    await writeFile(
      path.join(binDir, "codex"),
      "#!/bin/bash\nexec codex-code-mode-host\n",
      { mode: 0o755 },
    );
    await writeFile(
      path.join(binDir, "codex-code-mode-host"),
      "#!/bin/bash\nprintf bundled; exit 23\n",
      { mode: 0o755 },
    );
    const capturedPath = `${hostDir}:${process.env.PATH}`;
    const setup = await shell(
      `source "$LIBRARY"; nas_devcontainer_capture "" "" codex`,
      {
        LIBRARY: library,
        PATH: capturedPath,
        NAS_REAL_BASH: "/bin/bash",
        NAS_DIRENV_ENABLED: "false",
        WORKSPACE: root,
      },
    );
    expect(setup.code).toBe(0);
    const proc = Bun.spawn(
      [path.join(root, "nas-devcontainer-codex"), "app-server"],
      {
        env: {
          ...process.env,
          HOME: root,
          PATH: `${capturedPath}:${binDir}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    expect(stdout).toBe("bundled");
    expect(code).toBe(23);
  });
});

test("Claude wrapper rejects missing bundled executable", async () => {
  await fixture(async (root) => {
    const proc = Bun.spawn([path.join(root, "nas-devcontainer-claude")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(64);
    expect(await new Response(proc.stderr).text()).toContain(
      "bundled executable is required",
    );
  });
});

test.skipIf(process.getuid?.() === 0)(
  "idle announces readiness after environment application and exits on TERM (requires non-root)",
  async () => {
    await fixture(async (root, library) => {
      const setup = await shell(
        'source "$LIBRARY"; nas_devcontainer_capture "" "" claude',
        {
          LIBRARY: library,
          NAS_REAL_BASH: "/bin/bash",
          NAS_DIRENV_ENABLED: "false",
          WORKSPACE: root,
        },
      );
      expect(setup.code).toBe(0);
      const proc = Bun.spawn(
        [
          path.join(root, "nas-devcontainer-exec"),
          path.join(root, "nas-devcontainer-idle"),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      try {
        for (
          let i = 0;
          i < 100 && !(await Bun.file(path.join(root, "state/ready")).exists());
          i++
        )
          await Bun.sleep(10);
        expect(await Bun.file(path.join(root, "state/ready")).text()).toBe(
          `${process.getuid!()}\n`,
        );
        proc.kill("SIGTERM");
        expect(await proc.exited).toBe(0);
      } finally {
        proc.kill("SIGKILL");
        await proc.exited;
      }
    });
  },
);
test("wrapper exec preserves payload signal handling", async () => {
  await fixture(async (root, library) => {
    const setup = await shell(
      'source "$LIBRARY"; nas_devcontainer_capture "" "" claude',
      {
        LIBRARY: library,
        NAS_REAL_BASH: "/bin/bash",
        NAS_DIRENV_ENABLED: "false",
        WORKSPACE: root,
      },
    );
    expect(setup.code).toBe(0);
    const proc = Bun.spawn(
      [
        path.join(root, "nas-devcontainer-claude"),
        "/bin/bash",
        "-c",
        'trap "exit 42" TERM; printf ready; while :; do sleep 0.01; done',
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      const reader = proc.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(
        "ready",
      );
      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(42);
      reader.releaseLock();
    } finally {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  });
});

test("failed environment approval cannot publish idle readiness", async () => {
  await fixture(async (root, library) => {
    const setup = await shell(
      'source "$LIBRARY"; nas_devcontainer_capture "" "" claude',
      {
        LIBRARY: library,
        NAS_REAL_BASH: "/bin/bash",
        NAS_DIRENV_ENABLED: "true",
        WORKSPACE: root,
      },
    );
    expect(setup.code).toBe(0);
    const proc = Bun.spawn(
      [
        path.join(root, "nas-devcontainer-exec"),
        path.join(root, "nas-devcontainer-idle"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stdout).text()).toBe("");
    expect(await new Response(proc.stderr).text()).toContain(
      "direnv status failed",
    );
    expect(await Bun.file(path.join(root, "state/ready")).exists()).toBe(false);
  });
});

test("IDE refuses readiness when local proxy startup fails while normal CLI keeps its warning", async () => {
  const source = await readFile(
    new URL("./embed/entrypoint.sh", import.meta.url),
    "utf8",
  );
  const block = source.slice(
    source.indexOf("# --- ローカル認証プロキシ ---"),
    source.indexOf("# Initial forwarding must"),
  );
  for (const ide of [false, true]) {
    const result = await shell(
      `set -euo pipefail
nas_measure_start() { printf -v "$1" %s now; }
nas_measure_done() { :; }
nas_info() { :; }
bun() { return 1; }
bash() { return 1; }
seq() { printf '500\\n'; }
sleep() { :; }
${block}
printf startup-succeeded
`,
      {
        NAS_DEVCONTAINER: String(ide),
        NAS_SHELL_MODE: "false",
        NAS_UPSTREAM_PROXY: "http://unreachable.invalid:3128",
      },
    );
    expect(result.code, result.stderr).toBe(ide ? 1 : 0);
    expect(result.stdout).toBe(ide ? "" : "startup-succeeded");
    expect(result.stderr).toContain("local proxy failed to start");
  }
});
