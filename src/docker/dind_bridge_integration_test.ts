import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bwrapSeccompProfile } from "../stages/bwrap/seccomp_profile.ts";
import { agentPrivilegeRunArgs } from "../stages/launch/hardening.ts";
import { DIND_PUBLISH_IP } from "./dind.ts";

const sandboxImage =
  process.env.NAS_DIND_BRIDGE_TEST_IMAGE ?? "nas-sandbox:latest";
const dindImage = "docker:dind-rootless";
const serviceImage = "busybox:1.37";

async function run(argv: string[]) {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
async function available(argv: string[]) {
  return run(argv)
    .then((result) => result.code === 0)
    .catch(() => false);
}
const dockerAvailable =
  Bun.which("docker") !== null && (await available(["docker", "info"]));
const sandboxImageAvailable =
  dockerAvailable &&
  (await available(["docker", "image", "inspect", sandboxImage]));
const dindImageAvailable =
  dockerAvailable &&
  (await available(["docker", "image", "inspect", dindImage]));
const serviceImageAvailable =
  dockerAvailable &&
  (await available(["docker", "image", "inspect", serviceImage]));
const bwrapAvailable =
  sandboxImageAvailable &&
  (await available([
    "docker",
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    "1000:1000",
    "--security-opt",
    "seccomp=unconfined",
    "--security-opt",
    "apparmor=unconfined",
    "--entrypoint",
    "bwrap",
    sandboxImage,
    "--unshare-user",
    "--unshare-net",
    "--bind",
    "/",
    "/",
    "--dev-bind",
    "/dev",
    "/dev",
    "--",
    "/bin/true",
  ]));
const skipReason = !dockerAvailable
  ? "Docker unavailable"
  : !sandboxImageAvailable
    ? `${sandboxImage} unavailable`
    : !dindImageAvailable
      ? `${dindImage} unavailable`
      : !serviceImageAvailable
        ? `${serviceImage} unavailable`
        : !bwrapAvailable
          ? "unprivileged bwrap namespaces unavailable"
          : "";

const probe = `
import { request } from "node:http";
import { readlinkSync } from "node:fs";
const currentNamespace = readlinkSync("/proc/self/ns/net");
if (process.env.NAS_TEST_OUTER_NETNS) {
  if (currentNamespace === process.env.NAS_TEST_OUTER_NETNS || process.env.DOCKER_HOST === process.env.NAS_TEST_OUTER_DOCKER_HOST) throw new Error("nested namespace reused outer relay");
  const inherited = await fetch("http://127.0.0.1:" + process.env.NAS_TEST_OUTER_PORT).then(r => r.text());
  if (inherited !== "bridged") throw new Error("nested namespace did not mirror existing published port");
}
function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: process.env.DOCKER_HOST.slice(7), path, method,
      headers: body ? { "content-type": "application/json" } : {}, agent: false }, (res) => {
      let text = ""; res.on("data", (chunk) => text += chunk);
      res.on("error", reject); res.on("end", () => {
        if (res.statusCode >= 300) reject(new Error(path + ": " + text));
        else { try { resolve(text ? JSON.parse(text) : undefined); } catch { resolve(text); } }
      });
    });
    req.on("error", reject); req.end(body && JSON.stringify(body));
  });
}
const service = (hostConfig) => api("POST", "/containers/create", {
  Image: "busybox:1.37", Cmd: ["sh", "-c", "mkdir -p /www; printf bridged > /www/index.html; exec httpd -f -p 80 -h /www"],
  ExposedPorts: { "80/tcp": {} }, HostConfig: { PortBindings: { "80/tcp": [{ HostPort: "0" }] }, ...hostConfig }
});
async function serve(id) {
  await api("POST", "/containers/" + id + "/start");
  const info = await api("GET", "/containers/" + id + "/json");
  const port = info.NetworkSettings.Ports["80/tcp"][0].HostPort;
  let result;
  for (let i = 0; i < 50; i++) {
    try { result = await fetch("http://127.0.0.1:" + port).then(r => r.text()); if (result === "bridged") break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (result !== "bridged") throw new Error("published HTTP port did not reach its container");
  return port;
}
const created = await service({});
try {
  const port = await serve(created.Id);
  console.log("PASS isolated mapped HTTP port " + port);
  if (!process.env.NAS_TEST_OUTER_NETNS) {
    // Compose and Testcontainers networks are user-defined bridges.
    const network = await api("POST", "/networks/create", { Name: "probe-" + process.pid + "-" + Date.now() });
    const attached = await service({ NetworkMode: network.Id });
    try { console.log("PASS user-defined network port " + await serve(attached.Id)); }
    finally {
      await api("DELETE", "/containers/" + attached.Id + "?force=true");
      await api("DELETE", "/networks/" + network.Id);
    }
  }
  if (!process.env.NAS_TEST_OUTER_NETNS) {
    const nested = Bun.spawn(["bwrap", "--unshare-user", "--unshare-net", "--bind", "/", "/", "--dev-bind", "/dev", "/dev", "--", "/bin/bash", "-c", "/usr/local/bin/bun /probe/probe.mjs"], {
      env: { ...process.env, NAS_TEST_OUTER_NETNS: currentNamespace, NAS_TEST_OUTER_DOCKER_HOST: process.env.DOCKER_HOST, NAS_TEST_OUTER_PORT: String(port) },
      stdout: "pipe", stderr: "pipe",
    });
    const [status, output, error] = await Promise.all([nested.exited, new Response(nested.stdout).text(), new Response(nested.stderr).text()]);
    if (status !== 0) throw new Error("nested namespace failed: " + output + error);
    if (await fetch("http://127.0.0.1:" + port).then(r => r.text()) !== "bridged") throw new Error("nested teardown closed outer listener");
    await api("GET", "/containers/" + created.Id + "/json");
    console.log("PASS nested actual network namespace with independent relay");
  }
  await api("POST", "/containers/" + created.Id + "/stop?t=0");
  try { await fetch("http://127.0.0.1:" + port); throw new Error("stopped listener remains reachable"); }
  catch (error) { if (error.message === "stopped listener remains reachable") throw error; }
  console.log("PASS stopped forwarding closed");
} finally { await api("DELETE", "/containers/" + created.Id + "?force=true"); }
`;

// Images must already exist: capability checks never pull images or widen the
// tested agent's network. The fixture loads its service image into dedicated DinD.
test.skipIf(Boolean(skipReason))(
  `rootless DinD bridge crosses bwrap network isolation and closes stopped ports${skipReason ? ` (${skipReason})` : ""}`,
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "nas-dind-bridge-integration-"),
    );
    const name = `nas-dind-bridge-${crypto.randomUUID()}`;
    const agent = `${name}-agent`;
    const network = `${name}-net`;
    try {
      await chmod(directory, 0o755);
      await writeFile(join(directory, "seccomp.json"), bwrapSeccompProfile());
      await writeFile(join(directory, "probe.mjs"), probe);
      await writeFile(
        join(directory, "inside.sh"),
        `set -eu
/usr/local/bin/bun -e 'const r=await fetch("http://127.0.0.1:2375/_ping"); if(await r.text()!=="OK")process.exit(1);console.log("PASS outer API")'
bwrap --unshare-user --unshare-net --bind / / --dev-bind /dev /dev -- /usr/local/bin/bun -e 'try {await fetch("http://127.0.0.1:2375/_ping");process.exit(1)}catch{console.log("PASS direct isolated API refused")}'
/bin/bash -c '/usr/local/bin/bun /probe/probe.mjs' | sed 's/^/BASE /'
bwrap --unshare-user --unshare-net --bind / / --dev-bind /dev /dev -- /bin/bash -c '/usr/local/bin/bun /probe/probe.mjs'
`,
      );
      const createdNetwork = await run([
        "docker",
        "network",
        "create",
        "--internal",
        network,
      ]);
      expect(createdNetwork.code, createdNetwork.stderr).toBe(0);
      const dind = await run([
        "docker",
        "run",
        "-d",
        "--name",
        name,
        "--privileged",
        "--init",
        "-e",
        "DOCKER_TLS_CERTDIR=",
        "-e",
        "DOCKERD_ROOTLESS_ROOTLESSKIT_FLAGS=-p 127.0.0.1:2375:2375/tcp",
        dindImage,
        "dockerd",
        "--host=unix:///run/user/1000/docker.sock",
        "--host=tcp://127.0.0.1:2375",
        `--ip=${DIND_PUBLISH_IP}`,
        `--default-network-opt=bridge=com.docker.network.bridge.host_binding_ipv4=${DIND_PUBLISH_IP}`,
      ]);
      expect(dind.code, dind.stderr).toBe(0);
      let ready = false;
      for (let attempt = 0; attempt < 90; attempt++) {
        if (
          await available([
            "docker",
            "exec",
            name,
            "docker",
            "-H",
            "tcp://127.0.0.1:2375",
            "info",
          ])
        ) {
          ready = true;
          break;
        }
        await Bun.sleep(1000);
      }
      expect(ready, "dedicated rootless DinD did not become ready").toBe(true);
      expect(
        (await run(["docker", "network", "connect", network, name])).code,
      ).toBe(0);
      expect(
        (await run(["docker", "network", "disconnect", "bridge", name])).code,
      ).toBe(0);
      const archive = join(directory, "service.tar");
      expect(
        (await run(["docker", "save", "-o", archive, serviceImage])).code,
      ).toBe(0);
      expect(
        (await run(["docker", "cp", archive, `${name}:/tmp/service.tar`])).code,
      ).toBe(0);
      const loaded = await run([
        "docker",
        "exec",
        name,
        "docker",
        "-H",
        "tcp://127.0.0.1:2375",
        "load",
        "-i",
        "/tmp/service.tar",
      ]);
      expect(loaded.code, loaded.stderr).toBe(0);
      const args = [
        "docker",
        "run",
        "--name",
        agent,
        "--init",
        "--network",
        `container:${name}`,
        ...agentPrivilegeRunArgs(),
      ];
      args.push(
        "--security-opt",
        "apparmor=unconfined",
        "--security-opt",
        `seccomp=${join(directory, "seccomp.json")}`,
      );
      for (const value of [
        "NAS_UID=1000",
        "NAS_GID=1000",
        "NAS_USER=agent",
        "WORKSPACE=/probe",
        "NAS_DIND_BRIDGE=1",
        "DOCKER_HOST=tcp://127.0.0.1:2375",
      ])
        args.push("-e", value);
      args.push("--mount", `type=bind,src=${directory},dst=/probe,readonly`);
      for (const file of [
        "entrypoint.sh",
        "dind-bridge.mjs",
        "dind-bridge-runtime.mjs",
        "dind-bridge-protocol.mjs",
      ]) {
        const target =
          file === "entrypoint.sh"
            ? "/entrypoint.sh"
            : `/usr/local/lib/nas/${file}`;
        args.push(
          "--mount",
          `type=bind,src=${join(import.meta.dir, "embed", file)},dst=${target},readonly`,
        );
      }
      args.push(
        "--entrypoint",
        "/bin/bash",
        sandboxImage,
        "/entrypoint.sh",
        "/bin/bash",
        "/probe/inside.sh",
      );
      const result = await run(args);
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("PASS direct isolated API refused");
      // The gateway's namespace sees published ports on 127.0.0.1 too.
      expect(result.stdout).toContain("BASE PASS isolated mapped HTTP port");
      expect(result.stdout).toContain("PASS isolated mapped HTTP port");
      expect(result.stdout).toContain("PASS user-defined network port");
      expect(result.stdout).toContain("PASS stopped forwarding closed");
      expect(result.stdout).toContain(
        "PASS nested actual network namespace with independent relay",
      );
    } finally {
      await run(["docker", "rm", "-fv", agent]).catch(() => {});
      await run(["docker", "rm", "-fv", name]).catch(() => {});
      await run(["docker", "network", "rm", network]).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  },
  180_000,
);
