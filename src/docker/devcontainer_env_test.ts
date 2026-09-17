import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createDirenvLauncherFixture } from "./direnv_exec_fixture.ts";

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
    for (const name of ["exec", "claude", "idle"]) {
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
nas_devcontainer_capture "$OPS" '' --guide 'two words'
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
nas_devcontainer_capture '' '' '' 'two words' '$(false)'
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
    expect(saved).not.toContain("credential");
    expect(saved).not.toContain("NAS_UPSTREAM_PROXY");
    const args = await shell(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Bash expansion is intentional.
      'source "$ARGS"; printf "%s\\0" "${NAS_AGENT_ARGS[@]}"',
      { ARGS: path.join(root, "state/agent-args.sh") },
    );
    expect(args.stdout.split("\0")).toEqual(["", "two words", "$(false)", ""]);
  });
});

test("Claude wrapper preserves bundled executable, literal argv, streams and exit status", async () => {
  await fixture(async (root, library) => {
    const payload = path.join(root, "bundled-cli");
    await writeFile(
      payload,
      `#!${process.execPath}
process.stdout.write(JSON.stringify(process.argv.slice(2))); process.stderr.write("diagnostic"); process.exit(23);
`,
      { mode: 0o755 },
    );
    const setup = await shell(
      `source "$LIBRARY"; nas_devcontainer_capture "" "" "" "two words" '$(false)'`,
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
        payload,
        "--resume",
        "chat id",
        "",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(code).toBe(23);
    expect(JSON.parse(stdout)).toEqual([
      "",
      "two words",
      "$(false)",
      "--resume",
      "chat id",
      "",
    ]);
    expect(stderr).toBe("diagnostic");
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
        'source "$LIBRARY"; nas_devcontainer_capture "" ""',
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
      'source "$LIBRARY"; nas_devcontainer_capture "" ""',
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
      'source "$LIBRARY"; nas_devcontainer_capture "" ""',
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
