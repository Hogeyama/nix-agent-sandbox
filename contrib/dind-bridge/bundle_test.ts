import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { createServer as httpServer, request } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDindBridge } from "./build.ts";

const { closeServer, gatewayRequest, listen } = await import(
  join(import.meta.dir, "../../src/docker/embed/dind-bridge-protocol.mjs")
);

// The release runs this file under Node.js, not Bun; test what ships.
const found = Bun.which("node");
if (!found) throw new Error("node is required for these tests");
const NODE: string = found;

let dir: string;
let bundle: string;
let version: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nas-dind-bridge-bundle-"));
  bundle = join(dir, "dind-bridge");
  version = await buildDindBridge(bundle);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function port(server: Server): number {
  return (server.address() as { port: number }).port;
}
async function freePort(): Promise<number> {
  const reservation = createServer();
  await listen(reservation, { host: "127.0.0.1", port: 0 });
  const value = port(reservation);
  await closeServer(reservation);
  return value;
}
async function run(args: string[]) {
  const proc = Bun.spawn([NODE, bundle, ...args], {
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
function ping(apiPort: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: apiPort, path: "/_ping", agent: false },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve(text));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
function startServe(socket: string, dockerPort: number, apiPort: number) {
  const proc = Bun.spawn(
    [
      NODE,
      bundle,
      "serve",
      "--socket",
      socket,
      "--docker-host",
      `tcp://127.0.0.1:${dockerPort}`,
      "--api",
      `tcp://127.0.0.1:${apiPort}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const ready = (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    return new TextDecoder().decode(value);
  })();
  return { proc, ready };
}

test("the bundle reports the version it was built from", async () => {
  expect(version).toBe(
    (await readFile(join(import.meta.dir, "VERSION"), "utf8")).trim(),
  );
  expect(await run(["--version"])).toEqual({
    code: 0,
    stdout: `dind-bridge ${version}\n`,
    stderr: "",
  });
  expect(
    (await readFile(bundle, "utf8")).startsWith("#!/usr/bin/env node\n"),
  ).toBe(true);
});

test("env-file rejects an API address off the loopback", async () => {
  const result = await run([
    "env-file",
    "--socket",
    "/run/x/bridge.sock",
    "--api",
    "tcp://0.0.0.0:2375",
  ]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("must be tcp://127.0.0.1:PORT");
});

test("under Node.js, serve and ensure carry the Docker API end to end", async () => {
  const work = await mkdtemp(join(tmpdir(), "nas-dind-bridge-e2e-"));
  const socket = join(work, "bridge.sock");
  const docker = httpServer((_req, res) => res.end("OK"));
  let serve: ReturnType<typeof startServe> | undefined;
  let relayPid: number | undefined;
  try {
    await listen(docker, { host: "127.0.0.1", port: 0 });
    // What a container restart leaves behind: files where sockets go.
    await writeFile(socket, "stale");
    await writeFile(`${socket}.api`, "stale");
    const serveApi = await freePort();
    serve = startServe(socket, port(docker), serveApi);
    expect(await serve.ready).toBe("ready\n");
    expect(await ping(serveApi)).toBe("OK");
    expect((await readFile(join(work, "base-netns"), "utf8")).trim()).toBe(
      await readlink("/proc/self/ns/net"),
    );

    const second = startServe(socket, port(docker), await freePort());
    expect(await second.proc.exited).not.toBe(0);
    expect(await new Response(second.proc.stderr).text()).toContain(
      "another serve is running",
    );
    expect(await ping(serveApi)).toBe("OK");

    // A relay in this namespace, as the env file would start in a sandbox.
    const relayApi = await freePort();
    const instance = `t${crypto.randomUUID().slice(0, 8)}`;
    const ensured = await run([
      "ensure",
      "--socket",
      socket,
      "--instance",
      instance,
      "--api",
      `tcp://127.0.0.1:${relayApi}`,
    ]);
    expect(ensured).toMatchObject({
      code: 0,
      stdout: `tcp://127.0.0.1:${relayApi}\n`,
    });
    expect(await ping(relayApi)).toBe("OK");
    const ns = (await readlink("/proc/self/ns/net")).replace(/[^0-9]/g, "");
    const { socket: status, response } = await gatewayRequest(
      `\0dind-bridge-${process.getuid?.()}-${instance}-${ns}`,
      { kind: "status" },
    );
    status.destroy();
    relayPid = response.pid;
    expect(
      existsSync(`/tmp/dind-bridge-${process.getuid?.()}-${instance}-${ns}`),
    ).toBe(false);
  } finally {
    if (relayPid) process.kill(relayPid, "SIGTERM");
    serve?.proc.kill("SIGTERM");
    await serve?.proc.exited;
    await closeServer(docker);
    await rm(work, { recursive: true, force: true });
  }
});
