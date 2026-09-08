import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { shellEscape } from "../dtach/client.ts";
import { computeEmbedHash } from "./client.ts";

const launcherPath = fileURLToPath(
  new URL("./embed/direnv-exec.sh", import.meta.url),
);
const direnvAvailable = Bun.which("direnv") !== null;
const jqAvailable = Bun.which("jq") !== null;
const integrationAvailable = direnvAvailable && jqAvailable;

interface Fixture {
  root: string;
  workspace: string;
  opsFile: string;
  env: Record<string, string | undefined>;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const root = await mkdtemp(
    path.join(process.env.NAS_DIND_SHARED_TMP || tmpdir(), "nas-direnv-exec-"),
  );
  try {
    const workspace = path.join(root, "workspace");
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    const config = path.join(root, "config");
    const cache = path.join(root, "cache");
    await Promise.all(
      [workspace, home, data, config, cache].map((dir) =>
        mkdir(dir, { recursive: true }),
      ),
    );
    const opsFile = path.join(root, "env-ops.sh");
    await writeFile(opsFile, "");
    const env = {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: data,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
      NAS_DIRENV_ENABLED: "true",
      NAS_REAL_BASH: "/bin/bash",
      NAS_BASH_OVERRIDE: "/mask-wrapper/bin",
      HOSTEXEC_PATH_PREFIX: "/host wrapper's/bin",
      DIRENV_LOG_FORMAT: "",
    };
    await run({ root, workspace, opsFile, env });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runProcess(
  argv: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  stdin?: string,
) {
  const proc = Bun.spawn(argv, {
    cwd,
    env,
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function terminalAvailable(): Promise<boolean> {
  const script = Bun.which("script");
  if (!script) return false;
  const probe = await runProcess(
    [
      script,
      "-qef",
      "-E",
      "never",
      "-c",
      "test -t 0 && test -t 1",
      "/dev/null",
    ],
    process.cwd(),
    { ...process.env, SHELL: "/bin/sh" },
  );
  return probe.exitCode === 0;
}

const hasTerminal = await terminalAvailable();

function launch(
  fixture: Fixture,
  command: string[],
  options: {
    workspace?: string;
    opsFile?: string;
    pathPrefix?: string;
    env?: Record<string, string>;
  } = {},
) {
  const workspace = options.workspace ?? fixture.workspace;
  return runProcess(
    [
      "bash",
      launcherPath,
      workspace,
      options.opsFile ?? fixture.opsFile,
      options.pathPrefix ?? "",
      ...command,
    ],
    workspace,
    { ...fixture.env, ...options.env },
  );
}

async function approve(fixture: Fixture, workspace = fixture.workspace) {
  const result = await runProcess(
    ["direnv", "allow", path.join(workspace, ".envrc")],
    workspace,
    fixture.env,
  );
  expect(result.exitCode).toBe(0);
}

async function deny(fixture: Fixture, workspace = fixture.workspace) {
  const result = await runProcess(
    ["direnv", "deny", path.join(workspace, ".envrc")],
    workspace,
    fixture.env,
  );
  expect(result.exitCode).toBe(0);
}

test.skipIf(!integrationAvailable)(
  "requires approval, rejects changed and denied RCs, and scopes approval by path",
  async () => {
    await withFixture(async (fixture) => {
      const rcPath = path.join(fixture.workspace, ".envrc");
      const rcMarker = path.join(fixture.workspace, "rc-ran");
      const payloadMarker = path.join(fixture.workspace, "payload-ran");
      const initialRc = `printf evaluated > "$PWD/rc-ran"
export NAS_DIRENV_TEST_VALUE=loaded
`;
      await writeFile(rcPath, initialRc);
      const payload = [
        "/bin/bash",
        "-c",
        `printf payload > "$1"; printf %s "\${NAS_DIRENV_TEST_VALUE:-missing}"`,
        "nas-payload",
        payloadMarker,
      ];

      const unapproved = await launch(fixture, payload);
      expect(unapproved.exitCode).not.toBe(0);
      expect(unapproved.stderr).toContain("direnv allow");
      expect(unapproved.stderr).toContain(rcPath);
      expect(await Bun.file(rcMarker).exists()).toBe(false);
      expect(await Bun.file(payloadMarker).exists()).toBe(false);

      await approve(fixture);
      const allowed = await launch(fixture, payload);
      expect(allowed.exitCode).toBe(0);
      expect(allowed.stdout).toBe("loaded");
      expect(await readFile(rcMarker, "utf8")).toBe("evaluated");
      expect(await readFile(payloadMarker, "utf8")).toBe("payload");

      await rm(rcMarker, { force: true });
      await rm(payloadMarker, { force: true });
      const changedRc = `${initialRc}export NAS_DIRENV_CHANGED=yes
`;
      await writeFile(rcPath, changedRc);
      const changed = await launch(fixture, payload);
      expect(changed.exitCode).not.toBe(0);
      expect(changed.stderr).toContain("direnv allow");
      expect(await Bun.file(rcMarker).exists()).toBe(false);
      expect(await Bun.file(payloadMarker).exists()).toBe(false);

      await approve(fixture);
      await deny(fixture);
      const denied = await launch(fixture, payload);
      expect(denied.exitCode).not.toBe(0);
      expect(denied.stderr).toContain("direnv allow");
      expect(await Bun.file(payloadMarker).exists()).toBe(false);

      const otherWorkspace = path.join(fixture.root, "other-workspace");
      await mkdir(otherWorkspace);
      const otherRcPath = path.join(otherWorkspace, ".envrc");
      await writeFile(otherRcPath, changedRc);
      const other = await launch(fixture, ["/bin/true"], {
        workspace: otherWorkspace,
      });
      expect(other.exitCode).not.toBe(0);
      expect(other.stderr).toContain(otherRcPath);
    });
  },
);

test.skipIf(!integrationAvailable)(
  "launches without an RC and rejects an approved RC that exits",
  async () => {
    await withFixture(async (fixture) => {
      const noRc = await launch(fixture, ["/bin/bash", "-c", "printf no-rc"]);
      expect(noRc.exitCode).toBe(0);
      expect(noRc.stdout).toBe("no-rc");

      const payloadMarker = path.join(fixture.workspace, "payload-ran");
      await writeFile(path.join(fixture.workspace, ".envrc"), "exit 23\n");
      await approve(fixture);
      const failingRc = await launch(
        fixture,
        ["/bin/bash", "-c", `printf payload > "$PAYLOAD_MARKER"`],
        { env: { PAYLOAD_MARKER: payloadMarker } },
      );
      expect(failingRc.exitCode).not.toBe(0);
      expect(await Bun.file(payloadMarker).exists()).toBe(false);
    });
  },
);

test.skipIf(!integrationAvailable)(
  "discards inherited direnv state before evaluating the approved RC",
  async () => {
    await withFixture(async (fixture) => {
      await writeFile(
        path.join(fixture.workspace, ".envrc"),
        "export NAS_DIRENV_TEST_VALUE=loaded\n",
      );
      await approve(fixture);

      const result = await launch(
        fixture,
        ["/bin/bash", "-c", 'printf %s "$NAS_DIRENV_TEST_VALUE"'],
        { env: { DIRENV_DIFF: "not-valid-direnv-state" } },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("loaded");
    });
  },
);

test.skipIf(!integrationAvailable)(
  "applies env operations and restores the wrapper PATH prefix after the RC",
  async () => {
    await withFixture(async (fixture) => {
      await writeFile(
        path.join(fixture.workspace, ".envrc"),
        `export PATH=/direnv-only
export NAS_DIRENV_TEST_VALUE=loaded
`,
      );
      await approve(fixture);
      await writeFile(
        fixture.opsFile,
        `export NAS_DIRENV_TEST_VALUE="before-\${NAS_DIRENV_TEST_VALUE}-after"\n`,
      );

      const result = await launch(
        fixture,
        [
          "/bin/bash",
          "-c",
          'printf "%s\\n%s" "$NAS_DIRENV_TEST_VALUE" "$PATH"',
        ],
        { pathPrefix: "/wrapper/bin:" },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.split("\n")).toEqual([
        "before-loaded-after",
        "/wrapper/bin:/direnv-only",
      ]);
    });
  },
);

// Exercise the actual final dispatch without root setup. Docker cases below
// cover that setup and the setpriv boundary with the complete current image.
async function dispatch(
  fixture: Fixture,
  shell: boolean,
  command: string[],
  stdin?: string,
  terminal = false,
) {
  const entrypoint = await readFile(
    new URL("./embed/entrypoint.sh", import.meta.url),
    "utf8",
  );
  const marker = "# Both launches load the approved workspace environment";
  const start = entrypoint.indexOf(marker);
  expect(start).toBeGreaterThan(0);
  const script = `set -euo pipefail
nas_measure_start() { printf -v "$1" %s ""; }
nas_measure_done() { :; }
mktemp() { command mktemp "$TEST_ROOT/shell-rc.XXXXXX"; }
exec_nas() { exec "$@"; }
EXEC_PREFIX=()
AGENT_COMMAND=("$@")
${entrypoint.slice(start).replaceAll("/usr/local/bin/nas-direnv-exec", '"$TEST_LAUNCHER"')}`;
  const argv = [
    fixture.env.NAS_REAL_BASH!,
    "-c",
    script,
    "dispatch",
    ...command,
  ];
  return runProcess(
    // Give interactive bash its own PTY so its job control cannot stop a host
    // test runner that happens to share an inherited controlling terminal.
    // Input echo stays off so typed commands are not mistaken for output.
    terminal
      ? ["script", "-qef", "-E", "never", "-c", shellEscape(argv), "/dev/null"]
      : argv,
    fixture.workspace,
    {
      ...fixture.env,
      TEST_LAUNCHER: launcherPath,
      TEST_ROOT: fixture.root,
      WORKSPACE: fixture.workspace,
      NAS_ENV_OPS_FILE: fixture.opsFile,
      NAS_SHELL_MODE: String(shell),
      SHELL: "/bin/sh",
    },
    stdin,
  );
}

for (const shell of [false, true]) {
  test.skipIf(!integrationAvailable || (shell && !hasTerminal))(
    `entrypoint dispatch checks approval for ${shell ? "interactive shell" : "agent"}, preserves argv and env order`,
    async () => {
      await withFixture(async (fixture) => {
        const home = path.join(fixture.root, "home with ' quote");
        await mkdir(home);
        fixture.env.HOME = home;
        await writeFile(
          path.join(home, ".bashrc"),
          'export PATH=/bashrc/bin\nexport NAS_BASHRC_VALUE="$NAS_DIRENV_TEST_VALUE"\n',
        );
        await writeFile(
          path.join(fixture.workspace, ".envrc"),
          "export NAS_DIRENV_TEST_VALUE=loaded\nexport PATH=/direnv/bin:/usr/bin:/bin\n",
        );
        await writeFile(
          fixture.opsFile,
          `export NAS_DIRENV_TEST_VALUE="before-\${NAS_DIRENV_TEST_VALUE}-after"\n`,
        );
        const payload = `printf "RESULT:%s|%s|%s|%s\\n" "$NAS_DIRENV_TEST_VALUE" "$PATH" "\${NAS_BASHRC_VALUE:-agent}" "\${1:-shell}"; exit 37`;
        const command = [
          "/bin/bash",
          "-c",
          payload,
          "payload",
          "literal ' $() arg",
        ];
        const unapproved = await dispatch(
          fixture,
          shell,
          command,
          shell ? `${payload}\n` : undefined,
          shell,
        );
        expect(unapproved.exitCode).not.toBe(0);
        expect(unapproved.stdout).not.toContain("RESULT:");
        expect(shell ? unapproved.stdout : unapproved.stderr).toContain(
          "direnv allow",
        );
        await approve(fixture);
        const result = await dispatch(
          fixture,
          shell,
          command,
          shell ? `${payload}\n` : undefined,
          shell,
        );
        expect(result.exitCode).toBe(37);
        expect(result.stdout).toContain(
          `RESULT:before-loaded-after|/host wrapper's/bin:/mask-wrapper/bin:${shell ? "/bashrc/bin|before-loaded-after|shell" : "/direnv/bin:/usr/bin:/bin|agent|literal ' $() arg"}`,
        );
      });
    },
  );
}

async function currentNasImageAvailable(): Promise<boolean> {
  if (!Bun.which("docker")) return false;
  const result = await runProcess(
    [
      "docker",
      "image",
      "inspect",
      "nas-sandbox",
      "--format",
      '{{index .Config.Labels "nas.embed-hash"}}',
    ],
    process.cwd(),
    process.env,
  );
  if (result.exitCode !== 0) return false;
  return result.stdout.trim() === (await computeEmbedHash());
}
const currentNasImage = await currentNasImageAvailable();

// Use the shipped wrapper, relocating only its installed interpreter path.
// The test supervisor puts its child under pipes like nas-mask-filter does.
async function withMaskWrapper(fixture: Fixture, run: () => Promise<void>) {
  const entrypoint = await readFile(
    new URL("./embed/entrypoint.sh", import.meta.url),
    "utf8",
  );
  const body = entrypoint.match(
    /<< 'MASK_WRAPPER_BODY'\n([\s\S]*?)\nMASK_WRAPPER_BODY\n/,
  );
  if (!body) throw new Error("MASK_WRAPPER_BODY not found");
  const wrapperDir = path.join(fixture.root, "mask-wrapper");
  await mkdir(wrapperDir);
  const filter = path.join(wrapperDir, "filter");
  const marker = path.join(fixture.root, "supervised");
  const socket = path.join(fixture.root, "mask.sock");
  const realBash = fixture.env.NAS_REAL_BASH!;
  await writeFile(
    filter,
    `#!${realBash}
while [ "$1" != -- ]; do shift; done
shift
printf supervised >> "$TEST_SUPERVISED_MARKER"
NAS_MASK_SUPERVISED=1 "$@" 2>&1 | cat
exit \${PIPESTATUS[0]}
`,
    { mode: 0o755 },
  );
  const wrapper = path.join(wrapperDir, "bash");
  await writeFile(
    wrapper,
    `#!${realBash}
readonly nas_mask_filter_path=${shellEscape([filter])}
readonly nas_mask_socket_path=${shellEscape([socket])}
${body[1].replaceAll("/tmp/nas-bash-override/bash.real", realBash)}
`,
    { mode: 0o755 },
  );
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    Object.assign(fixture.env, {
      PATH: `${wrapperDir}:${fixture.env.PATH}`,
      NAS_BASH_OVERRIDE: wrapperDir,
      NAS_MASK_FILTER: filter,
      NAS_MASK_SOCKET: socket,
      NAS_MASK_SUPERVISED: undefined,
      TEST_SUPERVISED_MARKER: marker,
    });
    const probe = await runProcess(
      [wrapper, "-c", "printf wrapper-probe"],
      fixture.workspace,
      fixture.env,
    );
    expect(probe.exitCode).toBe(0);
    expect(probe.stdout).toBe("wrapper-probe");
    expect(await readFile(marker, "utf8")).toBe("supervised");
    await rm(marker);
    await run();
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

for (const shell of [false, true]) {
  for (const enabled of [false, true]) {
    test.skipIf(!hasTerminal || (enabled && !integrationAvailable))(
      `entrypoint preserves masked launch TTY: shell=${shell} direnv=${enabled}`,
      async () => {
        await withFixture(async (fixture) => {
          fixture.env.NAS_DIRENV_ENABLED = String(enabled);
          await withMaskWrapper(fixture, async () => {
            const payload =
              'test -t 0 && test -t 1 && test -t 2 || exit 91; printf "TTY-preserved\\n"; exit 37';
            const result = await dispatch(
              fixture,
              shell,
              [fixture.env.NAS_REAL_BASH!, "-c", payload],
              shell ? `${payload}\n` : undefined,
              true,
            );
            expect(result.exitCode).toBe(37);
            expect(result.stdout).toContain("TTY-preserved");
          });
        });
      },
    );
  }
}

async function makeApprovalReadable(directory: string): Promise<void> {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) await makeApprovalReadable(child);
    else await chmod(child, 0o644);
  }
}

for (const uid of [0, process.getuid?.() || 1000]) {
  for (const shell of [false, true]) {
    test.skipIf(!integrationAvailable || !currentNasImage || !hasTerminal)(
      `current nas image: uid=${uid} shell=${shell} enforces approval, read-only data and terminal ownership`,
      async () => {
        await withFixture(async (fixture) => {
          await chmod(fixture.root, 0o755);
          await chmod(fixture.workspace, 0o777);
          await writeFile(
            path.join(fixture.workspace, ".envrc"),
            'export NAS_RC_UID=$(id -u)\nprintf rc > "$PWD/rc-ran"\n',
          );
          // A legacy cache exists under the location previously used by nas.
          const flake = "{}\n";
          await writeFile(path.join(fixture.workspace, "flake.nix"), flake);
          const hash = new Bun.CryptoHasher("sha256")
            .update(flake)
            .digest("hex");
          const cache = path.join(
            fixture.root,
            "old-cache",
            "nas",
            "nix-dev-env",
          );
          await mkdir(cache, { recursive: true });
          await writeFile(
            path.join(cache, `${hash}.env`),
            "export NAS_POISON=sourced\n",
          );
          const dataDir = path.join(fixture.env.XDG_DATA_HOME!, "direnv");
          await mkdir(dataDir, { recursive: true });
          const payload = `test -t 0 && test -t 1 || exit 91; if touch "$HOME/.local/share/direnv/write-test" 2>/dev/null; then exit 92; fi; printf 'RESULT:%s:%s:%s:%s\\n' "$NAS_RC_UID" "$(id -u)" "$HOME" "\${NAS_POISON:-clean}"; printf payload > "$PWD/payload-ran"; exit 37`;
          for (const approved of [false, true]) {
            if (approved) await approve(fixture);
            await makeApprovalReadable(fixture.env.XDG_DATA_HOME!);
            const name = `nas-direnv-${crypto.randomUUID()}`;
            try {
              const argv = [
                "docker",
                "create",
                "--name",
                name,
                "--interactive",
                "--tty",
                "--network",
                "none",
                "-e",
                `NAS_UID=${uid}`,
                "-e",
                `NAS_GID=${uid}`,
                "-e",
                "NAS_USER=direnv-test",
                "-e",
                "NAS_DIRENV_ENABLED=true",
                "-e",
                "NAS_LOG_LEVEL=quiet",
                "-e",
                "NIX_ENABLED=true",
                "-e",
                `WORKSPACE=${fixture.workspace}`,
                "-w",
                fixture.workspace,
                "-v",
                `${fixture.workspace}:${fixture.workspace}`,
                "-v",
                `${dataDir}:/home/direnv-test/.local/share/direnv:ro`,
                "-v",
                `${path.join(fixture.root, "old-cache")}:/home/direnv-test/.cache:ro`,
                "nas-sandbox",
                ...(shell ? ["--shell"] : ["/bin/bash", "-c", payload]),
              ];
              const created = await runProcess(
                argv,
                fixture.workspace,
                process.env,
              );
              expect(created.exitCode).toBe(0);
              const inspected = await runProcess(
                ["docker", "inspect", name, "--format", "{{json .Mounts}}"],
                fixture.workspace,
                process.env,
              );
              expect(inspected.exitCode).toBe(0);
              const mounts = JSON.parse(inspected.stdout) as Array<{
                Source: string;
                RW: boolean;
              }>;
              expect(mounts.find((m) => m.Source === dataDir)?.RW).toBe(false);
              const result = await runProcess(
                [
                  "script",
                  "-qefc",
                  shellEscape([
                    "docker",
                    "start",
                    "--attach",
                    "--interactive",
                    name,
                  ]),
                  "/dev/null",
                ],
                fixture.workspace,
                { ...process.env, SHELL: "/bin/sh" },
                shell ? `${payload}\n` : undefined,
              );
              if (approved) {
                expect(result.exitCode).toBe(37);
                expect(result.stdout).toContain(
                  `RESULT:${uid}:${uid}:/home/direnv-test:clean`,
                );
                expect(
                  await readFile(
                    path.join(fixture.workspace, "payload-ran"),
                    "utf8",
                  ),
                ).toBe("payload");
              } else {
                expect(result.exitCode).not.toBe(0);
                expect(result.stdout + result.stderr).toContain("direnv allow");
                expect(
                  await Bun.file(
                    path.join(fixture.workspace, "payload-ran"),
                  ).exists(),
                ).toBe(false);
                expect(
                  await Bun.file(
                    path.join(fixture.workspace, "rc-ran"),
                  ).exists(),
                ).toBe(false);
              }
            } finally {
              await runProcess(
                ["docker", "rm", "--force", name],
                fixture.workspace,
                process.env,
              );
            }
          }
        });
      },
    );
  }
}
