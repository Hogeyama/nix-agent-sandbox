import { expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

async function shell(script: string, env: Record<string, string>) {
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

// Inside a nas sandbox namespace the bash on PATH is nas's own wrapper, which
// bridges the session's real DinD; copying it would test the live installation.
function bashInterposed(bash: string): boolean {
  const probe = Bun.spawnSync([bash, "-c", 'printf %s "$DOCKER_HOST"'], {
    env: { ...process.env, DOCKER_HOST: "nas-test-probe" },
    stderr: "pipe",
  });
  return (
    probe.stdout.toString() !== "nas-test-probe" || probe.stderr.length > 0
  );
}
const wrapperTest = test.skipIf(bashInterposed(Bun.which("bash")!));

// Execute the shipped installer, relocating its image paths into a fixture.
async function wrapperFixture(
  masked: boolean,
  bridged: boolean,
  run: (
    root: string,
    wrapper: string,
    env: Record<string, string>,
  ) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), "nas-bash-bridge-"));
  const realBash = Bun.which("bash")!;
  try {
    const systemBash = path.join(root, "system-bash");
    await copyFile(realBash, systemBash);
    const source = await readFile(
      new URL("./embed/entrypoint.sh", import.meta.url),
      "utf8",
    );
    const block = source
      .slice(
        source.indexOf("# --- bash override ---"),
        source.indexOf("# Both launches load"),
      )
      .replaceAll("/tmp/nas-bash-override", `${root}/override`)
      .replaceAll("/bin/bash", systemBash)
      .replaceAll(
        "/usr/local/bin/bun /usr/local/lib/nas/dind-bridge.mjs",
        `"${root}/bridge"`,
      )
      // Keep the real readlink, so the wrapper's PATH handling is exercised.
      .replaceAll(
        "readlink /proc/self/ns/net",
        `readlink "${root}/netns/$NAS_TEST_NETNS"`,
      )
      // Model the fake mask broker's availability without live sockets.
      // Real socket checks and masking are covered by mask_filter_integration_test.
      .replaceAll(
        '[ ! -S "$nas_mask_socket_path" ]',
        '[ ! -f "$nas_mask_socket_path" ]',
      );
    await mkdir(path.join(root, "netns"));
    for (const name of ["net:[base]", "net:[inner]", "net:[deeper]"])
      await symlink(name, path.join(root, "netns", name));
    const marker = path.join(root, "calls");
    await writeFile(
      path.join(root, "bridge"),
      `#!${realBash}
printf 'bridge:%s\\n' "$SUMI_SUPERVISED" >> "$NAS_TEST_CALLS"
shift
while [ "$1" != -- ]; do
  if [ "$1" = --argv0 ]; then argv0=$2; fi
  shift 2
done
shift
export NAS_DIND_BRIDGE_NETNS="$NAS_TEST_NETNS"
program=$1; shift
exec -a "$argv0" "$program" "$@"
`,
      { mode: 0o755 },
    );
    await writeFile(
      path.join(root, "filter"),
      `#!${realBash}
printf 'mask\\n' >> "$NAS_TEST_CALLS"
shift
while [ "$1" != -- ]; do
  if [ "$1" = --argv0 ]; then argv0=$2; fi
  shift 2
done
shift
export SUMI_SUPERVISED=1
program=$1; shift
exec -a "$argv0" "$program" "$@"
`,
      { mode: 0o755 },
    );
    const socket = path.join(root, "mask.sock");
    if (masked) {
      await writeFile(socket, "fake mask broker available");
    }
    const env = {
      NAS_TEST_NETNS: "net:[base]",
      NAS_TEST_CALLS: marker,
      NAS_MASK_FILTER: masked ? path.join(root, "filter") : "",
      NAS_MASK_SOCKET: masked ? socket : "",
      NAS_DIND_BRIDGE: bridged ? "1" : "",
      NAS_DIND_BASE_NETNS: "net:[base]",
      NAS_ENV_OPS_FILE: path.join(root, "ops"),
      HOSTEXEC_PATH_PREFIX: "",
      SUMI_SUPERVISED: "",
      NAS_DIND_BRIDGE_NETNS: "",
    };
    expect(
      await shell(`set -euo pipefail\nnas_debug() { :; }\n${block}`, env),
    ).toMatchObject({ code: 0 });
    await run(root, path.join(root, "override/bash"), env);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const masked of [false, true]) {
  for (const bridged of [false, true]) {
    wrapperTest(
      `Bash keeps argv and exit status: mask=${masked}, DinD=${bridged}`,
      async () => {
        await wrapperFixture(masked, bridged, async (root, wrapper, env) => {
          const result = await shell(
            '"$NAS_TEST_WRAPPER" -c \'printf "%s|%s|%s" "$0" "$1" "$2"; exit 37\' requested-argv0 "space arg" \'$(false)\'',
            { ...env, NAS_TEST_WRAPPER: wrapper },
          );
          expect(result).toMatchObject({
            code: 37,
            stdout: "requested-argv0|space arg|$(false)",
          });
          expect(
            await readFile(path.join(root, "calls"), "utf8").catch(() => ""),
          ).toBe(masked ? "mask\n" : "");
        });
      },
    );
  }
}

for (const masked of [false, true]) {
  for (const supervised of [false, true]) {
    wrapperTest(
      `namespace change starts bridge inside existing masking: mask=${masked}, supervised=${supervised}`,
      async () => {
        await wrapperFixture(masked, true, async (root, wrapper, env) => {
          const result = await shell(
            '"$NAS_TEST_WRAPPER" -c \'"$NAS_TEST_WRAPPER" -c "printf nested"; exit 23\'',
            {
              ...env,
              NAS_TEST_NETNS: "net:[inner]",
              SUMI_SUPERVISED: supervised ? "1" : "",
              NAS_TEST_WRAPPER: wrapper,
            },
          );
          expect(result).toMatchObject({ code: 23, stdout: "nested" });
          const shouldMask = masked && !supervised;
          const inherited = shouldMask || supervised ? "1" : "";
          expect(await readFile(path.join(root, "calls"), "utf8")).toBe(
            `${shouldMask ? "mask\n" : ""}bridge:${inherited}\nbridge:${inherited}\n`,
          );
        });
      },
    );
  }
}

wrapperTest(
  "a further namespace change starts another bridge even under inherited sumi",
  async () => {
    await wrapperFixture(true, true, async (root, wrapper, env) => {
      const result = await shell(
        '"$NAS_TEST_WRAPPER" -c \'NAS_TEST_NETNS="net:[deeper]" "$NAS_TEST_WRAPPER" -c "printf deeper"\'',
        { ...env, NAS_TEST_NETNS: "net:[inner]", NAS_TEST_WRAPPER: wrapper },
      );
      expect(result).toMatchObject({ code: 0, stdout: "deeper" });
      expect(await readFile(path.join(root, "calls"), "utf8")).toBe(
        "mask\nbridge:1\nbridge:1\n",
      );
    });
  },
);

wrapperTest(
  "installed bridge remains active when inherited activation variables are cleared",
  async () => {
    await wrapperFixture(false, true, async (root, wrapper, env) => {
      const result = await shell(
        'unset NAS_DIND_BRIDGE NAS_DIND_BASE_NETNS; "$NAS_TEST_WRAPPER" -c "printf bridged"',
        { ...env, NAS_TEST_NETNS: "net:[inner]", NAS_TEST_WRAPPER: wrapper },
      );
      expect(result).toMatchObject({ code: 0, stdout: "bridged" });
      expect(await readFile(path.join(root, "calls"), "utf8")).toBe(
        "bridge:\n",
      );
    });
  },
);

wrapperTest(
  "a diagnostic inherited marker cannot bypass relay validation",
  async () => {
    await wrapperFixture(false, true, async (root, wrapper, env) => {
      const result = await shell(
        '"$NAS_TEST_WRAPPER" -c \'printf "%s" "$0"\'',
        {
          ...env,
          NAS_TEST_NETNS: "net:[inner]",
          NAS_DIND_BRIDGE_NETNS: "net:[inner]",
          NAS_TEST_WRAPPER: wrapper,
        },
      );
      expect(result).toMatchObject({ code: 0, stdout: wrapper });
      expect(await readFile(path.join(root, "calls"), "utf8")).toBe(
        "bridge:\n",
      );
    });
  },
);

wrapperTest(
  "a caller PATH without readlink still runs bridged Bash",
  async () => {
    await wrapperFixture(false, true, async (root, wrapper, env) => {
      const result = await shell(
        'PATH=/nonexistent "$NAS_TEST_WRAPPER" -c \'printf "%s" "$0"; exit 9\' kept',
        { ...env, NAS_TEST_NETNS: "net:[inner]", NAS_TEST_WRAPPER: wrapper },
      );
      expect(result).toMatchObject({ code: 9, stdout: "kept", stderr: "" });
      expect(await readFile(path.join(root, "calls"), "utf8")).toBe(
        "bridge:\n",
      );
    });
  },
);

wrapperTest(
  "an unidentifiable namespace runs Bash without the bridge",
  async () => {
    await wrapperFixture(false, true, async (root, wrapper, env) => {
      const result = await shell(
        '"$NAS_TEST_WRAPPER" -c \'printf "%s" "$0"; exit 9\' kept',
        { ...env, NAS_TEST_NETNS: "", NAS_TEST_WRAPPER: wrapper },
      );
      expect(result).toMatchObject({ code: 9, stdout: "kept" });
      expect(result.stderr).toContain("running without Docker access");
      expect(
        await readFile(path.join(root, "calls"), "utf8").catch(() => ""),
      ).toBe("");
    });
  },
);

wrapperTest(
  "namespace bridge receives the descriptors handed to Bash",
  async () => {
    await wrapperFixture(false, true, async (root, wrapper, env) => {
      await writeFile(
        path.join(root, "bridge"),
        `#!${Bun.which("bash")}
while [ "$1" != -- ]; do
  if [ "$1" = --fds ]; then printf '%s' "$2" > "$NAS_TEST_CALLS"; fi
  shift
done
`,
        { mode: 0o755 },
      );
      const result = await shell(
        'exec 3>/dev/null 7>/dev/null 12</dev/null; exec 7>&-; "$NAS_TEST_WRAPPER" -c :',
        { ...env, NAS_TEST_NETNS: "net:[inner]", NAS_TEST_WRAPPER: wrapper },
      );
      expect(result.code).toBe(0);
      expect(
        (await readFile(path.join(root, "calls"), "utf8")).split(",").sort(),
      ).toEqual(["12", "3"]);
    });
  },
);

wrapperTest(
  "relay initialization failure returns its failure without running Bash",
  async () => {
    await wrapperFixture(false, true, async (root, wrapper, env) => {
      await writeFile(path.join(root, "bridge"), "#!/bin/bash\nexit 53\n", {
        mode: 0o755,
      });
      const result = await shell(
        '"$NAS_TEST_WRAPPER" -c "printf should-not-run"',
        {
          ...env,
          NAS_TEST_NETNS: "net:[inner]",
          NAS_TEST_WRAPPER: wrapper,
        },
      );
      expect(result).toMatchObject({ code: 53, stdout: "" });
    });
  },
);

async function gatewayStartup(
  mode: string,
  enabled = true,
  shellMode = false,
  existingRelay = false,
) {
  const root = await mkdtemp(path.join(tmpdir(), "nas-gateway-start-"));
  try {
    if (mode === "existing") {
      await mkdir(path.join(root, "gateway"));
      await writeFile(`${root}/gateway-netns`, "net:[original]\n");
      await writeFile(`${root}/gateway/bridge.sock`, "fake live gateway");
    }
    const source = await readFile(
      new URL("./embed/entrypoint.sh", import.meta.url),
      "utf8",
    );
    const block = source
      .slice(
        source.indexOf("# The gateway belongs"),
        source.indexOf("# --- エージェントコマンド ---"),
      )
      .replaceAll("/run/nas-dind-bridge", `${root}/gateway`)
      .replaceAll("[ ! -S ", "[ ! -f ")
      .replaceAll(
        "/usr/local/bin/bun /usr/local/lib/nas/dind-bridge.mjs",
        '"$NAS_TEST_GATEWAY"',
      );
    await writeFile(
      path.join(root, "serve"),
      `#!/bin/bash
printf '%s\\n' "$NAS_TEST_IDENTITY $*" > "$NAS_TEST_CALLS"
case "$NAS_TEST_MODE" in
 ready) printf 'ready\\n'; exec sleep 30 ;;
 failed) exit 1 ;;
 invalid) printf 'incorrect\\n'; exec sleep 30 ;;
esac
`,
      { mode: 0o755 },
    );
    const result = await shell(
      `set -euo pipefail
${
  existingRelay
    ? `coproc NAS_TEST_INITIAL { exec sleep 30; }
NAS_TEST_INITIAL_PROCESS=$NAS_TEST_INITIAL_PID
trap 'kill "$NAS_TEST_INITIAL_PROCESS" 2>/dev/null || true; wait "$NAS_TEST_INITIAL_PROCESS" 2>/dev/null || true' EXIT`
    : ""
}
install() { mkdir -p "\${@: -1}"; }
EXEC_PREFIX=(env NAS_TEST_IDENTITY=1000)
${block}
printf agent-started
if [ -n "\${NAS_DIND_GATEWAY_PROCESS:-}" ]; then
  kill "$NAS_DIND_GATEWAY_PROCESS" 2>/dev/null || true
  wait "$NAS_DIND_GATEWAY_PROCESS" 2>/dev/null || true
fi`,
      {
        NAS_DIND_BRIDGE: enabled ? "1" : "",
        NAS_SHELL_MODE: String(shellMode),
        NAS_UID: "1000",
        NAS_GID: "1000",
        NAS_TEST_MODE: mode,
        NAS_TEST_GATEWAY: path.join(root, "serve"),
        NAS_TEST_CALLS: path.join(root, "calls"),
      },
    );
    return {
      ...result,
      calls: await readFile(path.join(root, "calls"), "utf8").catch(() => ""),
      base: await readFile(`${root}/gateway-netns`, "utf8").catch(() => ""),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("gateway starts under agent identity with fixed session Docker endpoint before agent", async () => {
  const result = await gatewayStartup("ready");
  expect(result).toMatchObject({ code: 0, stdout: "agent-started" });
  expect(result.calls).toMatch(
    /^1000 serve --socket .*\/gateway\/bridge.sock --docker-host tcp:\/\/127\.0\.0\.1:2375\n$/,
  );
  expect(result.base).toMatch(/^net:\[\d+\]\n$/);
});

test("gateway readiness does not conflict with an already running port-relay coprocess", async () => {
  expect(await gatewayStartup("ready", true, false, true)).toMatchObject({
    code: 0,
    stdout: "agent-started",
    stderr: "",
  });
});

for (const mode of ["failed", "invalid"]) {
  test(`gateway ${mode} readiness prevents agent startup`, async () => {
    const result = await gatewayStartup(mode);
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("agent-started");
    expect(result.stderr).toContain("DinD bridge failed to initialize");
  });
}

test("disabled DinD skips gateway", async () => {
  expect(await gatewayStartup("failed", false)).toMatchObject({
    code: 0,
    stdout: "agent-started",
    calls: "",
    base: "",
  });
});

test("shell entrypoint fails when the original gateway is missing instead of starting another", async () => {
  const result = await gatewayStartup("ready", true, true);
  expect(result.code).not.toBe(0);
  expect(result.calls).toBe("");
  expect(result.stdout).not.toContain("agent-started");
});

test("shell entrypoint reuses the original gateway and saved namespace", async () => {
  expect(await gatewayStartup("existing", true, true)).toMatchObject({
    code: 0,
    stdout: "agent-started",
    calls: "",
    base: "net:[original]\n",
  });
});
