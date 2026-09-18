import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

const baseImage =
  process.env.NAS_DEVCONTAINER_CONTRACT_IMAGE ??
  "nas-devcontainer-contract:latest";
async function run(argv: string[]) {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
const dockerAvailable =
  Bun.which("docker") !== null &&
  (await run(["docker", "info"])
    .then((r) => r.code === 0)
    .catch(() => false));
const imageBuildable =
  dockerAvailable &&
  (await run(["docker", "image", "inspect", baseImage]).then(
    (r) => r.code === 0,
  ));

const skipReason = !dockerAvailable
  ? "Docker daemon unavailable"
  : !imageBuildable
    ? `local base image ${baseImage} unavailable; build the fixture on the host`
    : "";

test.skipIf(!imageBuildable)(
  `entrypoint prepares a non-root reusable IDE environment${!imageBuildable ? ` (${skipReason})` : ""}`,
  async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "nas-devcontainer-entrypoint-"),
    );
    const name = `nas-ide-entrypoint-${crypto.randomUUID()}`;
    const image = `${name}:test`;
    const workspace = path.join(root, "workspace");
    const command = [
      "/usr/local/bin/nas-devcontainer-idle",
      "",
      "space arg",
      "$(false)",
    ];
    try {
      await mkdir(workspace, { mode: 0o777 });
      for (const asset of [
        "entrypoint.sh",
        "direnv-exec.sh",
        "devcontainer-env.sh",
        "devcontainer-exec.sh",
        "devcontainer-idle.sh",
        "devcontainer-claude.sh",
      ]) {
        await writeFile(
          path.join(root, asset),
          await readFile(new URL(`./embed/${asset}`, import.meta.url)),
        );
      }
      await writeFile(
        path.join(root, "Dockerfile"),
        `FROM ${baseImage}\nCOPY entrypoint.sh /entrypoint.sh\nCOPY direnv-exec.sh /usr/local/bin/nas-direnv-exec\nCOPY devcontainer-env.sh /usr/local/lib/nas/devcontainer-env.sh\nCOPY devcontainer-exec.sh /usr/local/bin/nas-devcontainer-exec\nCOPY devcontainer-idle.sh /usr/local/bin/nas-devcontainer-idle\nCOPY devcontainer-claude.sh /usr/local/bin/nas-devcontainer-claude\nRUN chmod +x /entrypoint.sh /usr/local/bin/nas-*\nENTRYPOINT ["/entrypoint.sh"]\n`,
      );
      const build = await run(["docker", "build", "-t", image, root]);
      expect(build.code, build.stderr).toBe(0);
      const start = await run([
        "docker",
        "run",
        "-d",
        "--name",
        name,
        "--network",
        "none",
        "-v",
        `${workspace}:${workspace}`,
        "-w",
        workspace,
        "-e",
        "NAS_DEVCONTAINER=true",
        "-e",
        "NAS_DIRENV_ENABLED=true",
        "-e",
        "NAS_UPSTREAM_PROXY=http://proxy.invalid:3128",
        "-e",
        "NAS_UID=1000",
        "-e",
        "NAS_GID=1000",
        "-e",
        "NAS_USER=nas",
        "-e",
        `WORKSPACE=${workspace}`,
        "-e",
        "NAS_DEVCONTAINER_ENV_KEYS=TASK5_PREFIX",
        "-e",
        "NAS_ENV_OPS=__nas_pfx 'TASK5_PREFIX' 'prefix' ':'",
        "-e",
        "NAS_LOG_LEVEL=quiet",
        image,
        ...command,
      ]);
      expect(start.code, start.stderr).toBe(0);
      let ready = false;
      for (let i = 0; i < 100; i++) {
        const result = await run([
          "docker",
          "exec",
          "--user",
          "1000:1000",
          name,
          "test",
          "-f",
          "/run/nas-devcontainer/ready",
        ]);
        if (result.code === 0) {
          ready = true;
          break;
        }
        if (
          (
            await run(["docker", "inspect", "-f", "{{.State.Running}}", name])
          ).stdout.trim() !== "true"
        )
          break;
        await Bun.sleep(25);
      }
      expect(ready, (await run(["docker", "logs", name])).stderr).toBe(true);
      const probe = await run([
        "docker",
        "exec",
        "--user",
        "1000:1000",
        name,
        "/usr/local/bin/nas-devcontainer-exec",
        "/bin/bash",
        "-c",
        'printf "%s:%s:%s\\n" "$EUID" "$HOME" "$TASK5_PREFIX"; source /usr/local/lib/nas/devcontainer-env.sh; nas_devcontainer_apply; printf "%s\\n" "$TASK5_PREFIX"; stat -c "%u:%a" /usr/local/lib/nas/devcontainer/baseline.sh',
      ]);
      expect(probe.code, probe.stderr).toBe(0);
      expect(probe.stdout).toBe("1000:/home/nas:prefix\nprefix\n0:644\n");
      const login = await run([
        "docker",
        "exec",
        "--user",
        "1000:1000",
        name,
        "/bin/bash",
        "-lc",
        'printf "%s:%s" "$HOME" "$TASK5_PREFIX"',
      ]);
      expect(login.code, login.stderr).toBe(0);
      expect(login.stdout).toBe("/home/nas:prefix");
      expect(
        (
          await run([
            "docker",
            "exec",
            "--user",
            "1000:1000",
            name,
            "/usr/local/bin/nas-devcontainer-exec",
            "/bin/bash",
            "-c",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Bash expansion is intentional.
            'test "$http_proxy" = http://127.0.0.1:18080 && test -z "${NAS_UPSTREAM_PROXY:-}" && echo >/dev/tcp/127.0.0.1/18080',
          ])
        ).code,
      ).toBe(0);
      await writeFile(
        path.join(workspace, ".envrc"),
        "echo rc-output\nexport TASK5_PREFIX=from-rc\n",
      );
      const denied = await run([
        "docker",
        "exec",
        "--user",
        "1000:1000",
        name,
        "/usr/local/bin/nas-devcontainer-exec",
        "/bin/true",
      ]);
      expect(denied.code).not.toBe(0);
      expect(denied.stdout).toBe("");
      expect(denied.stderr).toContain("direnv allow");
      const allow = await run([
        "docker",
        "exec",
        "--user",
        "1000:1000",
        "-e",
        "HOME=/home/nas",
        name,
        "/usr/bin/direnv",
        "allow",
        `${workspace}/.envrc`,
      ]);
      expect(allow.code, allow.stderr).toBe(0);
      const loaded = await run([
        "docker",
        "exec",
        "--user",
        "1000:1000",
        name,
        "/usr/local/bin/nas-devcontainer-exec",
        "/bin/bash",
        "-lc",
        'printf "%s" "$TASK5_PREFIX"',
      ]);
      expect(loaded.code, loaded.stderr).toBe(0);
      expect(loaded.stdout).toBe("prefix:from-rc");
      await writeFile(path.join(workspace, ".envrc"), "exit 19\n");
      expect(
        (
          await run([
            "docker",
            "exec",
            "--user",
            "1000:1000",
            "-e",
            "HOME=/home/nas",
            name,
            "/usr/bin/direnv",
            "allow",
            `${workspace}/.envrc`,
          ])
        ).code,
      ).toBe(0);
      const failedRc = await run([
        "docker",
        "exec",
        "--user",
        "1000:1000",
        name,
        "/usr/local/bin/nas-devcontainer-exec",
        "/bin/true",
      ]);
      expect(failedRc.code).not.toBe(0);
      const saved = await run([
        "docker",
        "exec",
        "--user",
        "1000:1000",
        name,
        "/bin/bash",
        "-c",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Bash expansion is intentional.
        'source /usr/local/lib/nas/devcontainer/agent-args.sh; printf "%s\\0" "${NAS_AGENT_ARGS[@]}"',
      ]);
      expect(saved.stdout.split("\0")).toEqual([
        "",
        "space arg",
        "$(false)",
        "",
      ]);
      expect((await run(["docker", "stop", "-t", "2", name])).code).toBe(0);
      expect(
        (
          await run(["docker", "inspect", "-f", "{{.State.ExitCode}}", name])
        ).stdout.trim(),
      ).toBe("0");
    } finally {
      await run(["docker", "rm", "-f", name]);
      await run(["docker", "image", "rm", image]);
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
