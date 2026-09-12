import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { createDirenvLauncherFixture } from "./direnv_exec_fixture.ts";

const direnv = Bun.which("direnv");
const jq = Bun.which("jq");
const integrationAvailable = direnv !== null && jq !== null;

interface CacheFixture {
  root: string;
  workspace: string;
  config: string;
  launcher: string;
  opsFile: string;
  evaluations: string;
  hooks: string;
  env: Record<string, string>;
}

async function runProcess(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
) {
  const proc = Bun.spawn(argv, {
    cwd,
    env,
    stdin: "ignore",
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

async function withCacheFixture(run: (fixture: CacheFixture) => Promise<void>) {
  const root = await mkdtemp(
    path.join(process.env.NAS_DIND_SHARED_TMP || "/tmp", "nas-direnv-cache-"),
  );
  try {
    const workspace = path.join(root, "workspace with spaces");
    const home = path.join(root, "home with spaces");
    const fakeBin = path.join(root, "fake-bin");
    const fakeStore = path.join(root, "fake-store");
    const evaluationTemp = path.join(root, "evaluation-temp");
    const config = path.join(root, "config");
    const data = path.join(root, "data");
    const cache = path.join(root, "cache");
    await Promise.all(
      [
        workspace,
        home,
        fakeBin,
        fakeStore,
        evaluationTemp,
        config,
        data,
        cache,
      ].map((dir) => mkdir(dir, { recursive: true })),
    );
    const evaluations = path.join(root, "evaluations");
    const hooks = path.join(root, "hooks");
    const opsFile = path.join(root, "env-ops.sh");
    await writeFile(opsFile, "");
    await writeFile(
      path.join(fakeBin, "nix"),
      `#!/usr/bin/env bash
set -euo pipefail
while [[ \${1:-} == --no-warn-dirty || \${1:-} == --extra-experimental-features ]]; do
  if [[ $1 == --extra-experimental-features ]]; then shift 2; else shift; fi
done
case "\${1:-}" in
  --version)
    printf 'nix (Nix) 2.34.8\\n'
    ;;
  print-dev-env)
    shift
    profile=
    while (($#)); do
      if [[ $1 == --profile ]]; then profile=$2; shift 2; else shift; fi
    done
    printf 'evaluation\\n' >> "$FAKE_NIX_EVALUATIONS"
    count=$(wc -l < "$FAKE_NIX_EVALUATIONS")
    target="$FAKE_NIX_STORE/profile-$count"
    mkdir -p "$target"
    ln -s "$target" "$profile"
    printf 'export NAS_FAKE_NIX_VALUE=%q\\n' "evaluation-$count"
    printf 'echo hook >> %q\\n' "$FAKE_SHELL_HOOKS"
    ;;
  build)
    shift
    out=
    target=
    while (($#)); do
      if [[ $1 == --out-link ]]; then out=$2; shift 2; else target=$1; shift; fi
    done
    mkdir -p "$(dirname "$out")"
    if [[ -L $target ]]; then target=$(readlink -f "$target"); fi
    ln -s "$target" "$out"
    ;;
  flake)
    printf '{"path":"/nix/store/nas-direnv-test-input"}\\n'
    ;;
  *)
    printf 'unexpected fake nix invocation: %q\\n' "$*" >&2
    exit 97
    ;;
esac
`,
      { mode: 0o755 },
    );
    await chmod(path.join(fakeBin, "nix"), 0o755);
    const env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      XDG_CACHE_HOME: cache,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      NAS_DIRENV_ENABLED: "true",
      NAS_REAL_BASH: "/bin/bash",
      DIRENV_LOG_FORMAT: "%s",
      FAKE_NIX_EVALUATIONS: evaluations,
      FAKE_NIX_STORE: fakeStore,
      FAKE_SHELL_HOOKS: hooks,
    } as Record<string, string>;
    // The repository may itself run inside nix develop. Its NIX_BUILD_TOP is
    // not part of the fake environment and nix-direnv would correctly treat a
    // value shaped like nix-shell.* as disposable evaluation state.
    delete env.NIX_BUILD_TOP;
    env.TMPDIR = evaluationTemp;
    env.TMP = evaluationTemp;
    env.TEMP = evaluationTemp;
    env.TEMPDIR = evaluationTemp;
    const launcher = await createDirenvLauncherFixture(root, direnv!, jq!);
    await run({
      root,
      workspace,
      config,
      launcher,
      opsFile,
      evaluations,
      hooks,
      env,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function approve(fixture: CacheFixture) {
  const result = await runProcess(
    [direnv!, "allow", path.join(fixture.workspace, ".envrc")],
    fixture.workspace,
    fixture.env,
  );
  expect(result.exitCode).toBe(0);
}

function launch(
  fixture: CacheFixture,
  options: {
    workspace?: string;
    env?: Record<string, string>;
    command?: string[];
  } = {},
) {
  const workspace = options.workspace ?? fixture.workspace;
  return runProcess(
    [
      "/bin/bash",
      fixture.launcher,
      workspace,
      fixture.opsFile,
      "",
      ...(options.command ?? [
        "/bin/bash",
        "-c",
        `printf "%s" "\${NAS_FAKE_NIX_VALUE:-missing}"`,
      ]),
    ],
    workspace,
    { ...fixture.env, ...options.env },
  );
}

async function evaluationCount(fixture: CacheFixture): Promise<number> {
  if (!(await Bun.file(fixture.evaluations).exists())) return 0;
  return (await readFile(fixture.evaluations, "utf8"))
    .split("\n")
    .filter(Boolean).length;
}

test.skipIf(!integrationAvailable)(
  "reuses the packaged nix-direnv cache across launcher processes",
  async () => {
    await withCacheFixture(async (fixture) => {
      const direnvConfig = path.join(fixture.config, "direnv");
      const libraryDir = path.join(direnvConfig, "lib");
      const installedLibrary = path.join(libraryDir, "nas-nix-direnv.sh");
      const userLibrary = path.join(libraryDir, "user.sh");
      const userDirenvrc = path.join(direnvConfig, "direnvrc");
      await mkdir(libraryDir, { recursive: true });
      await writeFile(userLibrary, "export USER_DIRENV_LIBRARY=preserved\n");
      await writeFile(userDirenvrc, "export USER_DIRENVRC=preserved\n");
      const hostProfile = path.join(
        fixture.workspace,
        ".direnv",
        "flake-profile",
      );
      await mkdir(path.dirname(hostProfile), { recursive: true });
      await writeFile(hostProfile, "host-profile\n");
      await writeFile(path.join(fixture.workspace, "flake.nix"), "{}\n");
      await writeFile(path.join(fixture.workspace, ".envrc"), "use flake\n");
      await approve(fixture);

      const first = await launch(fixture);
      const firstLibraryMtime = (await stat(installedLibrary)).mtimeMs;
      const second = await launch(fixture);
      const secondLibraryMtime = (await stat(installedLibrary)).mtimeMs;

      expect(first.exitCode).toBe(0);
      expect(first.stdout).toBe("evaluation-1");
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toBe("evaluation-1");
      expect(second.stderr).toContain("Using cached dev shell");
      expect(await evaluationCount(fixture)).toBe(1);
      expect(secondLibraryMtime).toBe(firstLibraryMtime);
      expect(await readFile(userLibrary, "utf8")).toBe(
        "export USER_DIRENV_LIBRARY=preserved\n",
      );
      expect(await readFile(userDirenvrc, "utf8")).toBe(
        "export USER_DIRENVRC=preserved\n",
      );
      expect(await readFile(hostProfile, "utf8")).toBe("host-profile\n");
      expect(await readFile(installedLibrary, "utf8")).toContain(
        "NAS_NIX_DIRENV_LIBRARY_LOADED",
      );
      expect((await readFile(fixture.hooks, "utf8")).split("\n")).toEqual([
        "hook",
        "hook",
        "",
      ]);
    });
  },
);

test.skipIf(!integrationAvailable)(
  "loads a plain RC when Nix is absent from PATH",
  async () => {
    await withCacheFixture(async (fixture) => {
      await writeFile(
        path.join(fixture.workspace, ".envrc"),
        "export NAS_PLAIN_RC=loaded\n",
      );
      await approve(fixture);

      const result = await launch(fixture, {
        env: { PATH: "/usr/bin:/bin" },
        command: ["/bin/bash", "-c", 'printf %s "$NAS_PLAIN_RC"'],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("loaded");
      expect(await evaluationCount(fixture)).toBe(0);
    });
  },
);

test.skipIf(!integrationAvailable)(
  "isolates the lowercase layout variable by worktree and HOME",
  async () => {
    await withCacheFixture(async (fixture) => {
      const customLayout = path.join(fixture.root, "shared custom layout");
      const envrc = "use flake\n";
      await writeFile(path.join(fixture.workspace, "flake.nix"), "{}\n");
      await writeFile(path.join(fixture.workspace, ".envrc"), envrc);
      fixture.env.direnv_layout_dir = customLayout;
      await approve(fixture);

      const first = await launch(fixture);
      const cached = await launch(fixture);
      expect(first.stdout).toBe("evaluation-1");
      expect(cached.stdout).toBe("evaluation-1");

      const otherWorkspace = path.join(fixture.root, "other worktree");
      await mkdir(otherWorkspace);
      await writeFile(path.join(otherWorkspace, "flake.nix"), "{}\n");
      await writeFile(path.join(otherWorkspace, ".envrc"), envrc);
      const approvedOther = await runProcess(
        [direnv!, "allow", path.join(otherWorkspace, ".envrc")],
        otherWorkspace,
        fixture.env,
      );
      expect(approvedOther.exitCode).toBe(0);
      const otherWorktree = await launch(fixture, {
        workspace: otherWorkspace,
      });
      expect(otherWorktree.stdout).toBe("evaluation-2");

      const otherHome = path.join(fixture.root, "other home");
      await mkdir(otherHome);
      const isolatedHome = await launch(fixture, {
        env: { HOME: otherHome },
      });
      expect(isolatedHome.stdout).toBe("evaluation-3");
      expect(await evaluationCount(fixture)).toBe(3);

      const namespaces = await readdir(path.join(customLayout, "nas"));
      expect(namespaces).toHaveLength(3);
      expect(
        namespaces.every(
          (namespace) =>
            namespace.startsWith("nix-direnv-3.2.0-home-") &&
            namespace.includes("-worktree-"),
        ),
      ).toBe(true);
    });
  },
);
