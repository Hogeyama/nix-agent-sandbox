import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDindBridge } from "./build.ts";

// The README's layout: a rootless DinD sidecar on an internal network, and a
// separate agent container that shares only its Docker socket through a
// volume. The agent stands in for a Dev Container with Node.js; `unshare`
// stands in for Claude Code's sandbox, which gives each command fresh
// network and PID namespaces.
const agentImage =
  process.env.DIND_BRIDGE_TEST_NODE_IMAGE ?? "node:22-bookworm-slim";
const dindImage = "docker:dind-rootless";
// Static, so its `ip` also runs in the agent image.
const serviceImage = "busybox:1.37-musl";

async function run(argv: string[], stdin?: Blob) {
  const proc = Bun.spawn(argv, {
    stdin: stdin ?? "ignore",
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
async function available(argv: string[]) {
  return run(argv)
    .then((result) => result.code === 0)
    .catch(() => false);
}
const dockerAvailable =
  Bun.which("docker") !== null && (await available(["docker", "info"]));
const missingImage = dockerAvailable
  ? (
      await Promise.all(
        [agentImage, dindImage, serviceImage].map(async (image) =>
          (await available(["docker", "image", "inspect", image]))
            ? undefined
            : image,
        ),
      )
    ).find(Boolean)
  : undefined;
const skipReason = !dockerAvailable
  ? "Docker unavailable"
  : missingImage
    ? `${missingImage} unavailable`
    : "";

const probe = `
import { request } from "node:http";
const [api] = process.env.DOCKER_HOST.slice("tcp://".length).split(":").reverse();
function docker(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: Number(api), path, method,
      headers: body ? { "content-type": "application/json" } : {}, agent: false }, (res) => {
      let text = ""; res.on("data", (chunk) => text += chunk);
      res.on("error", reject); res.on("end", () => {
        if (res.statusCode >= 300) reject(new Error(path + ": " + res.statusCode + " " + text));
        else { try { resolve(text ? JSON.parse(text) : undefined); } catch { resolve(text); } }
      });
    });
    req.on("error", reject); req.end(body && JSON.stringify(body));
  });
}
const label = process.argv[2];
const created = await docker("POST", "/containers/create", {
  Image: "${serviceImage}", Cmd: ["sh", "-c", "mkdir -p /www; printf bridged > /www/index.html; exec httpd -f -p 80 -h /www"],
  ExposedPorts: { "80/tcp": {} }, HostConfig: { PortBindings: { "80/tcp": [{ HostPort: "0" }] } },
});
try {
  await docker("POST", "/containers/" + created.Id + "/start");
  const info = await docker("GET", "/containers/" + created.Id + "/json");
  const port = info.NetworkSettings.Ports["80/tcp"][0].HostPort;
  let body;
  for (let i = 0; i < 50 && body !== "bridged"; i++) {
    try { body = await fetch("http://127.0.0.1:" + port).then((r) => r.text()); } catch {}
    if (body !== "bridged") await new Promise((r) => setTimeout(r, 100));
  }
  if (body !== "bridged") throw new Error("published port did not reach its container");
  console.log(label + " PASS published port " + port);
  await docker("POST", "/containers/" + created.Id + "/stop?t=0");
  let reachable = true;
  try { await fetch("http://127.0.0.1:" + port); } catch { reachable = false; }
  if (reachable) throw new Error("stopped container's port still reachable");
  console.log(label + " PASS stopped port closed");
} finally {
  await docker("DELETE", "/containers/" + created.Id + "?force=true");
}
`;

// Fresh network and PID namespaces with loopback up, like one Bash command
// in Claude Code's sandbox (bwrap brings loopback up; unshare does not).
const inside = `set -eu
sandbox() {
  unshare --user --map-root-user --net --pid --fork --mount --mount-proc \\
    sh -c '/probe/busybox ip link set lo up && exec "$@"' sh "$@"
}
B=/opt/dind-bridge/dind-bridge
S=/tmp/dind-bridge/bridge.sock
mkdir -m 700 /tmp/dind-bridge
"$B" env-file --socket "$S" --api tcp://127.0.0.1:2375 --publish-ip 0.0.0.0 > /tmp/env.sh
mkfifo -m 600 /tmp/ready
"$B" serve --socket "$S" --docker-host unix:///var/run/dind/docker.sock \\
  --publish-host dind --publish-ip 0.0.0.0 --api tcp://127.0.0.1:2375 > /tmp/ready &
read -r ready < /tmp/ready
[ "$ready" = ready ]
echo "PASS serve ready"
# The agent's own namespace: serve's relay answers on the same DOCKER_HOST.
node /probe/probe.mjs BASE
# Without the env file, nothing in a fresh namespace answers.
sandbox node -e 'fetch("http://127.0.0.1:2375/_ping").then(() => process.exit(1), () => console.log("PASS bare sandbox refused"))'
# The env file starts the namespace's relay and prints nothing.
sandbox sh -c '. /tmp/env.sh > /tmp/env.out 2>&1; node /probe/probe.mjs SANDBOX'
[ ! -s /tmp/env.out ] && echo "PASS env file silent"
# The relay went with the namespace.
for cmdline in /proc/[0-9]*/cmdline; do
  if tr '\\0' ' ' < "$cmdline" 2>/dev/null | grep -q -e ' relay --socket'; then
    echo "relay outlived its namespace" >&2; exit 1
  fi
done
echo "PASS relay ended with its namespace"
`;

test.skipIf(Boolean(skipReason))(
  `dind-bridge carries Docker from a rootless DinD sidecar into fresh namespaces${skipReason ? ` (${skipReason})` : ""}`,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "nas-dind-bridge-int-"));
    const name = `dind-bridge-test-${crypto.randomUUID().slice(0, 8)}`;
    const network = `${name}-net`;
    const volume = `${name}-run`;
    const agent = `${name}-agent`;
    try {
      await chmod(directory, 0o755);
      await buildDindBridge(join(directory, "dind-bridge"));
      await writeFile(join(directory, "probe.mjs"), probe);
      await writeFile(join(directory, "inside.sh"), inside);
      // A static busybox for `ip`, which the agent image lacks.
      const holder = await run(["docker", "create", serviceImage]);
      expect(holder.code, holder.stderr).toBe(0);
      const copied = await run([
        "docker",
        "cp",
        `${holder.stdout.trim()}:/bin/busybox`,
        join(directory, "busybox"),
      ]);
      await run(["docker", "rm", holder.stdout.trim()]);
      expect(copied.code, copied.stderr).toBe(0);
      expect(
        (await run(["docker", "network", "create", "--internal", network]))
          .code,
      ).toBe(0);
      // A tmpfs owned by the rootless user: the image has no such directory
      // to copy ownership from, and sockets need nothing to survive a restart.
      expect(
        (
          await run([
            "docker",
            "volume",
            "create",
            "--driver",
            "local",
            "--opt",
            "type=tmpfs",
            "--opt",
            "device=tmpfs",
            "--opt",
            "o=uid=1000,gid=1000,mode=0700",
            volume,
          ])
        ).code,
      ).toBe(0);
      const dind = await run([
        "docker",
        "run",
        "-d",
        "--name",
        name,
        "--privileged",
        "--network",
        network,
        "--network-alias",
        "dind",
        "--mount",
        `type=volume,src=${volume},dst=/run/user/1000`,
        dindImage,
        "dockerd",
        "--host=unix:///run/user/1000/docker.sock",
      ]);
      expect(dind.code, dind.stderr).toBe(0);
      let ready = false;
      for (let attempt = 0; attempt < 90 && !ready; attempt++) {
        ready = await available([
          "docker",
          "exec",
          name,
          "docker",
          "-H",
          "unix:///run/user/1000/docker.sock",
          "info",
        ]);
        if (!ready) await Bun.sleep(1000);
      }
      expect(ready, "rootless DinD did not become ready").toBe(true);
      const image = Bun.spawn(["docker", "save", serviceImage], {
        stdout: "pipe",
      });
      const loaded = await run(
        [
          "docker",
          "exec",
          "-i",
          name,
          "docker",
          "-H",
          "unix:///run/user/1000/docker.sock",
          "load",
        ],
        await new Response(image.stdout).blob(),
      );
      expect(loaded.code, loaded.stderr).toBe(0);
      const result = await run([
        "docker",
        "run",
        "--name",
        agent,
        "--init",
        "--user",
        "1000:1000",
        "--network",
        network,
        // unshare needs user namespaces, as Claude Code's bwrap does.
        "--security-opt",
        "seccomp=unconfined",
        "--security-opt",
        "apparmor=unconfined",
        // Docker's masked /proc paths forbid mounting a fresh /proc.
        "--security-opt",
        "systempaths=unconfined",
        "-e",
        "DOCKER_HOST=tcp://127.0.0.1:2375",
        "--mount",
        `type=volume,src=${volume},dst=/var/run/dind,readonly`,
        "--mount",
        `type=bind,src=${directory},dst=/probe,readonly`,
        "--mount",
        `type=bind,src=${directory},dst=/opt/dind-bridge,readonly`,
        agentImage,
        "bash",
        "/probe/inside.sh",
      ]);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.code, output).toBe(0);
      for (const line of [
        "PASS serve ready",
        "BASE PASS published port",
        "BASE PASS stopped port closed",
        "PASS bare sandbox refused",
        "SANDBOX PASS published port",
        "SANDBOX PASS stopped port closed",
        "PASS env file silent",
        "PASS relay ended with its namespace",
      ])
        expect(result.stdout, output).toContain(line);
    } finally {
      await run(["docker", "rm", "-fv", agent]).catch(() => {});
      await run(["docker", "rm", "-fv", name]).catch(() => {});
      await run(["docker", "volume", "rm", volume]).catch(() => {});
      await run(["docker", "network", "rm", network]).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  },
  300_000,
);
