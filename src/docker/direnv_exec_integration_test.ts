import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
  const root = await mkdtemp(path.join(tmpdir(), "nas-direnv-exec-"));
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
) {
  const proc = Bun.spawn(argv, {
    cwd,
    env,
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
