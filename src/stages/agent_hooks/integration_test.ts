import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  type AgentHookOptions,
  buildAgentHookSettings,
  type HookAgent,
} from "./settings.ts";

async function run(argv: string[], stdin?: string) {
  const child = Bun.spawn(argv, {
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

const image = "alpine:3.20";
const dockerAvailable =
  Bun.which("docker") !== null &&
  (await run(["docker", "info"])
    .then((r) => r.code === 0)
    .catch(() => false));
const imageAvailable =
  dockerAvailable &&
  (await run(["docker", "image", "inspect", image]).then((r) => r.code === 0));
const skipReason = !dockerAvailable
  ? "Docker unavailable"
  : !imageAvailable
    ? `local ${image} unavailable`
    : "";

async function startup(
  before = "",
  after = "",
  flags = "NAS_SHELL_MODE=false\nNAS_AGENT_HOOKS=1",
  options: AgentHookOptions = { lifecycle: true },
) {
  const entrypoint = await readFile(
    new URL("../../docker/embed/entrypoint.sh", import.meta.url),
    "utf8",
  );
  const block = entrypoint.slice(
    entrypoint.indexOf("# --- NAS agent hooks ---"),
    entrypoint.indexOf("# --- CA 証明書のインストール ---"),
  );
  const assets = (["claude", "codex", "copilot"] as HookAgent[])
    .map(
      (
        agent,
      ) => `cat > /opt/nas/agent-hooks/${agent}.${agent === "codex" ? "toml" : "json"} <<'NAS_TEST_SETTINGS'
${buildAgentHookSettings(agent, options)}NAS_TEST_SETTINGS
`,
    )
    .join("");
  const script = `set -eu
mkdir -p /opt/nas/agent-hooks
${assets}
chown -R 1000:1000 /opt/nas/agent-hooks
${flags}
${before}
${block}
${after.replaceAll("NAS_TEST_RESTART", block)}
echo startup-complete
`;
  const name = `nas-agent-hooks-${crypto.randomUUID()}`;
  try {
    return await run(
      [
        "docker",
        "run",
        "--rm",
        "--name",
        name,
        "--network",
        "none",
        "-i",
        image,
        "sh",
        "-s",
      ],
      script,
    );
  } finally {
    await run(["docker", "rm", "-f", name]);
  }
}

test.skipIf(!imageAvailable)(
  `Copilot masking rejects unsupported or unknown versions before startup (${skipReason || "Docker"})`,
  async () => {
    for (const version of ["1.0.34", "1.0.87", "unknown", "1.0.88", "1.1.0"]) {
      const result = await startup(
        `mkdir -p /usr/local/bin
cat > /usr/local/bin/copilot <<'NAS_TEST_COPILOT'
#!/bin/sh
echo 'GitHub Copilot CLI ${version}.'
NAS_TEST_COPILOT
chmod 755 /usr/local/bin/copilot`,
        "",
        "NAS_SHELL_MODE=false\nNAS_AGENT_HOOKS=1\nNAS_MASK_SOCKET=/run/mask.sock",
        { lifecycle: false, maskSocketPath: "/run/mask.sock" },
      );
      const supported = version === "1.0.88" || version === "1.1.0";
      expect(result.code === 0, result.stderr).toBe(supported);
      if (!supported) {
        expect(result.stderr).toContain(
          "sumi hooks require Copilot CLI >= 1.0.88",
        );
        expect(result.stdout).not.toContain("startup-complete");
      }
    }
  },
  30_000,
);

test.skipIf(!imageAvailable)(
  `startup installs root-owned policy, preserves sumi settings and supports restart (${skipReason || "Docker"})`,
  async () => {
    const result = await startup(
      "mkdir -p /etc/claude-code/managed-settings.d\necho sumi > /etc/claude-code/managed-settings.d/50-nas-sumi.json",
      `test "$(cat /etc/claude-code/managed-settings.d/50-nas-sumi.json)" = sumi
for file in /etc/codex/requirements.toml /etc/claude-code/managed-settings.d/60-nas-hooks.json /etc/github-copilot/policy.d/60-nas-hooks.json; do
  test "$(stat -c '%u:%g:%a' "$file")" = 0:0:644
  su -s /bin/sh nobody -c "cat $file >/dev/null"
  if su -s /bin/sh nobody -c "echo changed >> $file"; then exit 1; fi
done
test "$(stat -c %u /opt/nas/agent-hooks/copilot.json)" = 1000
NAS_TEST_RESTART`,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("startup-complete");
  },
  30_000,
);

for (const existing of [
  "echo existing > /etc/codex/requirements.toml",
  "ln -s /missing /etc/codex/requirements.toml",
]) {
  test.skipIf(!imageAvailable)(
    `existing Codex policy fails startup (${existing}; ${skipReason || "Docker"})`,
    async () => {
      const result = await startup(`mkdir -p /etc/codex\n${existing}`);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(
        "/etc/codex/requirements.toml already exists",
      );
      expect(result.stderr).toContain("hook.enable = false");
      expect(result.stdout).not.toContain("startup-complete");
    },
    30_000,
  );
}

test.skipIf(!imageAvailable)(
  `disabled hooks and shell attachment leave existing policy untouched (${skipReason || "Docker"})`,
  async () => {
    for (const flags of [
      "NAS_SHELL_MODE=false\nNAS_AGENT_HOOKS=",
      "NAS_SHELL_MODE=true\nNAS_AGENT_HOOKS=1",
    ]) {
      const result = await startup(
        "mkdir -p /etc/codex\necho existing > /etc/codex/requirements.toml",
        'test "$(cat /etc/codex/requirements.toml)" = existing\ntest ! -e /etc/github-copilot/policy.d/60-nas-hooks.json',
        flags,
      );
      expect(result.code, result.stderr).toBe(0);
    }
  },
  30_000,
);
