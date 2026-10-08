import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { closeServer, listen } = await import(
  join(import.meta.dir, "../../../src/docker/embed/dind-bridge-protocol.mjs")
);
const { renderEnvFile, shellQuote } = await import(
  join(import.meta.dir, "env_file.mjs")
);

// The snippet runs under whatever shell Claude Code picked, so both must be
// here; a missing one would silently narrow what this file proves.
const SHELLS = ["bash", "zsh"].map((name) => {
  const path = Bun.which(name);
  if (!path) throw new Error(`${name} is required for these tests`);
  return path;
});

let dir: string;
let log: string;
let fakeNode: string;
let namespace: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nas-dind-bridge-env-"));
  log = join(dir, "calls.log");
  fakeNode = join(dir, "fake-node");
  // Stands in for `node dind-bridge ensure`: records its arguments.
  await writeFile(
    fakeNode,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LOG"\nexit "${FAKE_EXIT:-0}"\n',
  );
  await chmod(fakeNode, 0o755);
  namespace = await readlink("/proc/self/ns/net");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function snippet(base: string | undefined, name = "snippet.sh") {
  const baseNetnsFile = join(dir, `${name}.base`);
  await rm(baseNetnsFile, { force: true });
  if (base !== undefined) await writeFile(baseNetnsFile, `${base}\n`);
  const file = join(dir, name);
  await writeFile(
    file,
    renderEnvFile({
      version: "test",
      node: fakeNode,
      script: "/opt/dind-bridge/dind-bridge",
      socket: "/run/dind-bridge/bridge.sock",
      api: "tcp://127.0.0.1:2375",
      instance: "default",
      namePrefix: "dbtest",
      baseNetnsFile,
    }),
  );
  return file;
}

async function source(
  shell: string,
  file: string,
  { flags = [] as string[], exit = "0" } = {},
) {
  await rm(log, { force: true });
  const proc = Bun.spawn(
    [shell, ...flags, "-c", `. ${shellQuote(file)}; echo done`],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH, LOG: log, FAKE_EXIT: exit },
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const calls = await readFile(log, "utf8").catch(() => "");
  return { code, stdout, stderr, calls: calls.split("\n").filter(Boolean) };
}

for (const shell of SHELLS) {
  const label = shell.split("/").pop();

  test(`${label}: without serve's record it warns and starts nothing`, async () => {
    const result = await source(shell, await snippet(undefined));
    expect(result).toMatchObject({ code: 0, stdout: "done\n", calls: [] });
    expect(result.stderr).toContain("serve is not running");
  });

  test(`${label}: in serve's own namespace it does nothing`, async () => {
    const result = await source(shell, await snippet(namespace));
    expect(result).toEqual({
      code: 0,
      stdout: "done\n",
      stderr: "",
      calls: [],
    });
  });

  test(`${label}: in another namespace it ensures the relay silently`, async () => {
    const result = await source(shell, await snippet("net:[1]"));
    expect(result).toMatchObject({ code: 0, stdout: "done\n", stderr: "" });
    expect(result.calls).toEqual([
      "/opt/dind-bridge/dind-bridge ensure --socket /run/dind-bridge/bridge.sock --instance default --name-prefix dbtest --api tcp://127.0.0.1:2375",
    ]);
  });

  test(`${label}: a live relay is found without starting a process`, async () => {
    const digits = namespace.replace(/[^0-9]/g, "");
    const relay = createServer((client) => client.destroy());
    await listen(relay, `\0dbtest-${process.getuid?.()}-default-${digits}`);
    try {
      const result = await source(shell, await snippet("net:[1]"));
      expect(result).toEqual({
        code: 0,
        stdout: "done\n",
        stderr: "",
        calls: [],
      });
    } finally {
      await closeServer(relay);
    }
  });

  test(`${label}: a failed ensure warns and the command still runs`, async () => {
    const result = await source(shell, await snippet("net:[1]"), {
      exit: "1",
    });
    expect(result).toMatchObject({ code: 0, stdout: "done\n" });
    expect(result.calls).toHaveLength(1);
    expect(result.stderr).toContain("relay unavailable");
  });

  test(`${label}: unset variables are fatal nowhere in the snippet`, async () => {
    const flags = label === "zsh" ? ["-o", "nounset"] : ["-u"];
    for (const base of [undefined, namespace, "net:[1]"]) {
      const result = await source(shell, await snippet(base), { flags });
      expect(result.stdout).toBe("done\n");
      expect(result.stderr).not.toMatch(/unbound|parameter not set/);
    }
  });

  test(`${label}: the snippet leaves no variables behind`, async () => {
    const file = await snippet("net:[1]");
    const proc = Bun.spawn(
      [
        shell,
        "-c",
        `. ${shellQuote(file)}; set | grep -c '^dind_bridge_' || true`,
      ],
      { stdout: "pipe", env: { PATH: process.env.PATH, LOG: log } },
    );
    expect((await new Response(proc.stdout).text()).trim()).toBe("0");
  });
}

test("values are quoted for the shell", async () => {
  expect(shellQuote("it's $HOME")).toBe(`'it'\\''s $HOME'`);
  const text = renderEnvFile({
    version: "test",
    node: "/n o/node",
    script: "/s'cript",
    socket: "/run/x",
    api: "tcp://127.0.0.1:2375",
    instance: "default",
    namePrefix: "dind-bridge",
    publishIp: "0.0.0.0",
    baseNetnsFile: "/run/base-netns",
  });
  expect(text).toContain(`'/n o/node' '/s'\\''cript' 'ensure'`);
  expect(text).toContain(`'--publish-ip' '0.0.0.0'`);
});
