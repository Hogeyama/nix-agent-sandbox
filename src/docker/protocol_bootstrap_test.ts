import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the actual entrypoint descriptor setup and direnv finish program.
// The direnv fixture models its syscall.Exec handoff (preserves inherited FDs).
test("entrypoint and direnv setup cannot consume or print protocol bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nas-acp-bootstrap-"));
  try {
    const entry = await readFile(
      new URL("./embed/entrypoint.sh", import.meta.url),
      "utf8",
    );
    const runner = (
      await readFile(new URL("./embed/direnv-exec.sh", import.meta.url), "utf8")
    )
      .replaceAll("/usr/bin/direnv", join(dir, "direnv"))
      .replaceAll(
        "/usr/local/libexec/nas-direnv-bootstrap",
        join(dir, "bootstrap"),
      );
    await writeFile(join(dir, "runner"), runner);
    await writeFile(
      join(dir, "direnv"),
      '#!/bin/bash\nif [ "$1" = status ]; then echo \'{"state":{"foundRC":{"path":"/workspace/.envrc","allowed":0}}}\'; else shift 2; echo direnv-setup; read -r ignored && exit 91; exec "$@"; fi\n',
      { mode: 0o700 },
    );
    await writeFile(
      join(dir, "bootstrap"),
      "#!/bin/bash\necho direnv-bootstrap\n",
      { mode: 0o700 },
    );
    await writeFile(join(dir, "ops"), "echo dynamic-env-setup\n");
    const program = `${entry.split("NAS_SHELL_MODE=false")[0]}\necho entrypoint-setup\nread -r ignored && exit 92\nexec /bin/bash "$1" "$2" "$3" "" /bin/cat\n`;
    const child = spawn(
      "bash",
      ["-c", program, "fixture", join(dir, "runner"), dir, join(dir, "ops")],
      {
        env: {
          ...process.env,
          NAS_EXECUTION_MODE: "acp",
          NAS_REAL_BASH: "/bin/bash",
          NAS_DIRENV_ENABLED: "true",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const exited = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    child.stdin.end('{"jsonrpc":"2.0","id":1}\n');
    expect(await exited).toBe(0);
    expect(Buffer.concat(stdout).toString()).toBe('{"jsonrpc":"2.0","id":1}\n');
    expect(Buffer.concat(stderr).toString()).toContain(
      "entrypoint-setup\ndirenv-bootstrap\ndirenv-setup\ndynamic-env-setup\n",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
