# Network SSRF Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent direct-IP and DNS-rebinding requests from making the shared mitmproxy connect to private, loopback, link-local, unspecified, or CGNAT destinations.

**Architecture:** Move the TypeScript numeric-address policy into a focused `ip_policy.ts` module and validate it against a shared JSON boundary corpus. Mirror the explicit policy in the Python addon, then use an asynchronous mitmproxy `server_connect` hook to resolve once, filter denied candidates, preserve SNI, and pin the first allowed IP before opening the socket.

**Tech Stack:** Bun 1.x, TypeScript 6 strict mode, `bun:test`, Python 3 `unittest`/`asyncio`/`ipaddress`, mitmproxy 11, Docker CLI.

## Global Constraints

- Read and follow `test-policy` (`skills/test-policy/SKILL.md`) before editing or reviewing tests; use its Bun-equivalent conventions where its command examples still mention Deno.
- Read and enforce `security-constraints` (`skills/security-constraints/SKILL.md`), especially N1: container-to-host service access remains limited to explicitly mounted Unix sockets.
- Tests import repository modules through relative paths; do not introduce import maps.
- Do not add a runtime dependency. In particular, do not use Bun's current `node:net.BlockList`, which returns incorrect subnet results in this environment.
- Keep `blocked-private-ip` as the broker-visible reason for every denied numeric address.
- Denied ranges are not configurable. Use exactly the IPv4 and IPv6 ranges listed in the approved spec.
- IPv4-mapped IPv6 addresses delegate to the IPv4 policy; mapped public IPv4 addresses remain allowed by this predicate.
- DNS resolution, timeout, malformed/empty results, and all-denied results fail closed. Never fall back from a pinned IP to the original hostname.
- When DNS returns mixed candidates, discard denied IPs and pin the first allowed IP in resolver order.
- Preserve the original hostname for HTTP Host and upstream TLS SNI.
- Docker tests use random names and paths, skip when Docker or bind mounts are unavailable, clean up in `finally`, and never touch `nas-proxy-shared`.
- Update `docs/todo/security.md` only after focused and project-wide verification succeeds.

---

## File Map

- Create `src/network/ip_policy.ts`: numeric IPv4/IPv6 parsing and the TypeScript denied-address predicate.
- Create `src/network/ip_policy_test.ts`: shared-corpus and parser-spelling unit tests.
- Create `src/network/denied_ip_policy_cases.json`: language-neutral expected results at every policy boundary.
- Modify `src/network/protocol.ts`: delegate numeric-address rejection to `isDeniedIpAddress` and remove the old partial predicates.
- Modify `src/network/protocol_edges_test.ts`: retain broker-facing reason assertions and add mapped-address assertions.
- Modify `src/docker/mitmproxy/nas_addon.py`: explicit Python IP policy plus DNS resolution, filtering, SNI preservation, and pinning.
- Modify `src/docker/mitmproxy/nas_addon_mask_test.py`: Python policy and async hook unit tests; rename is intentionally avoided to keep the existing Bun wrapper stable.
- Modify `src/docker/mitmproxy/nas_addon_test.ts`: broaden the wrapper test name from mask-only to addon helpers.
- Create `src/docker/mitmproxy/nas_addon_integration_test.ts`: real mitmproxy 11 test proving an allowed hostname resolving to the host gateway cannot reach a host listener.
- Modify `docs/todo/security.md`: mark H5 and H6 complete and remove them from the actionable P0 list after verification.

---

### Task 1: Harden the TypeScript IP predicate

**Files:**
- Create: `src/network/denied_ip_policy_cases.json`
- Create: `src/network/ip_policy.ts`
- Create: `src/network/ip_policy_test.ts`
- Modify: `src/network/protocol.ts`
- Modify: `src/network/protocol_edges_test.ts`

**Interfaces:**
- Consumes: `node:net.isIP(address: string): 0 | 4 | 6` for address-family classification only.
- Produces: `isDeniedIpAddress(address: string): boolean`, consumed by `denyReasonForTarget` and Task 2's shared test corpus.

- [ ] **Step 1: Add the shared boundary corpus**

Create `src/network/denied_ip_policy_cases.json` with the complete policy boundary set:

```json
[
  { "address": "0.0.0.0", "denied": true },
  { "address": "0.255.255.255", "denied": true },
  { "address": "1.0.0.0", "denied": false },
  { "address": "9.255.255.255", "denied": false },
  { "address": "10.0.0.0", "denied": true },
  { "address": "10.255.255.255", "denied": true },
  { "address": "11.0.0.0", "denied": false },
  { "address": "100.63.255.255", "denied": false },
  { "address": "100.64.0.0", "denied": true },
  { "address": "100.127.255.255", "denied": true },
  { "address": "100.128.0.0", "denied": false },
  { "address": "126.255.255.255", "denied": false },
  { "address": "127.0.0.0", "denied": true },
  { "address": "127.255.255.255", "denied": true },
  { "address": "128.0.0.0", "denied": false },
  { "address": "169.253.255.255", "denied": false },
  { "address": "169.254.0.0", "denied": true },
  { "address": "169.254.255.255", "denied": true },
  { "address": "169.255.0.0", "denied": false },
  { "address": "172.15.255.255", "denied": false },
  { "address": "172.16.0.0", "denied": true },
  { "address": "172.31.255.255", "denied": true },
  { "address": "172.32.0.0", "denied": false },
  { "address": "192.167.255.255", "denied": false },
  { "address": "192.168.0.0", "denied": true },
  { "address": "192.168.255.255", "denied": true },
  { "address": "192.169.0.0", "denied": false },
  { "address": "8.8.8.8", "denied": false },
  { "address": "::", "denied": true },
  { "address": "::1", "denied": true },
  { "address": "::2", "denied": false },
  { "address": "fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "denied": false },
  { "address": "fc00::", "denied": true },
  { "address": "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "denied": true },
  { "address": "fe00::", "denied": false },
  { "address": "fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "denied": false },
  { "address": "fe80::", "denied": true },
  { "address": "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "denied": true },
  { "address": "fec0::", "denied": false },
  { "address": "2001:4860:4860::8888", "denied": false },
  { "address": "::ffff:0.0.0.0", "denied": true },
  { "address": "::ffff:10.0.0.1", "denied": true },
  { "address": "::ffff:100.64.0.1", "denied": true },
  { "address": "::ffff:127.0.0.1", "denied": true },
  { "address": "0:0:0:0:0:ffff:a9fe:1", "denied": true },
  { "address": "::ffff:192.168.1.1", "denied": true },
  { "address": "::ffff:8.8.8.8", "denied": false },
  { "address": "0:0:0:0:0:ffff:808:808", "denied": false }
]
```

- [ ] **Step 2: Write the failing TypeScript policy tests**

Create `src/network/ip_policy_test.ts`:

```typescript
import { expect, test } from "bun:test";
import cases from "./denied_ip_policy_cases.json";
import { isDeniedIpAddress } from "./ip_policy.ts";

for (const { address, denied } of cases) {
  test(`isDeniedIpAddress: ${address} => ${denied}`, () => {
    expect(isDeniedIpAddress(address)).toEqual(denied);
  });
}

test("isDeniedIpAddress: equivalent compressed IPv6 forms", () => {
  expect(isDeniedIpAddress("fc00:0:0:0:0:0:0:1")).toEqual(true);
  expect(isDeniedIpAddress("fe80:0000::1")).toEqual(true);
  expect(isDeniedIpAddress("2001:4860:4860:0:0:0:0:8888")).toEqual(false);
});

test("isDeniedIpAddress: hostnames and malformed values are not numeric", () => {
  expect(isDeniedIpAddress("example.com")).toEqual(false);
  expect(isDeniedIpAddress("1.2.3.999")).toEqual(false);
  expect(isDeniedIpAddress("1::2::3")).toEqual(false);
});
```

Append broker-facing mapped-address checks to
`src/network/protocol_edges_test.ts`:

```typescript
test("denyReasonForTarget: IPv4-mapped private IPv6 is blocked", () => {
  expect(
    denyReasonForTarget({ host: "::ffff:127.0.0.1", port: 80 }),
  ).toEqual("blocked-private-ip");
  expect(
    denyReasonForTarget({ host: "::ffff:100.64.0.1", port: 80 }),
  ).toEqual("blocked-private-ip");
});

test("denyReasonForTarget: IPv4-mapped public IPv6 is allowed", () => {
  expect(denyReasonForTarget({ host: "::ffff:8.8.8.8", port: 53 })).toEqual(
    null,
  );
});
```

- [ ] **Step 3: Run the tests and confirm RED**

Run:

```bash
bun test src/network/ip_policy_test.ts src/network/protocol_edges_test.ts
```

Expected: FAIL because `src/network/ip_policy.ts` and
`isDeniedIpAddress` do not exist, or because the old predicate allows at least
`0.0.0.0`, `100.64.0.1`, `::`, and IPv4-mapped private addresses.

- [ ] **Step 4: Implement the focused TypeScript policy module**

Create `src/network/ip_policy.ts`:

```typescript
import { isIP } from "node:net";

type Ipv4Octets = readonly [number, number, number, number];

export function isDeniedIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = parseIpv4(address);
    return octets !== null && isDeniedIpv4(octets);
  }
  if (version !== 6) return false;

  const words = parseIpv6(address);
  if (words === null) return false;

  const mapped = mappedIpv4(words);
  if (mapped !== null) return isDeniedIpv4(mapped);

  const allZero = words.every((word) => word === 0);
  if (allZero) return true;
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  if (loopback) return true;
  if ((words[0] & 0xfe00) === 0xfc00) return true;
  if ((words[0] & 0xffc0) === 0xfe80) return true;
  return false;
}

function parseIpv4(address: string): Ipv4Octets | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  if (
    octets.some(
      (part) => !Number.isInteger(part) || part < 0 || part > 255,
    )
  ) {
    return null;
  }
  return octets as unknown as Ipv4Octets;
}

function isDeniedIpv4([a, b]: Ipv4Octets): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
}

function parseIpv6(address: string): number[] | null {
  const withoutZone = address.split("%", 1)[0];
  if (withoutZone.indexOf("::") !== withoutZone.lastIndexOf("::")) return null;

  const halves = withoutZone.split("::");
  const left = parseIpv6Half(halves[0]);
  const right = parseIpv6Half(halves[1] ?? "");
  if (left === null || right === null) return null;

  if (halves.length === 1) return left.length === 8 ? left : null;
  const omitted = 8 - left.length - right.length;
  if (omitted < 1) return null;
  return [...left, ...Array<number>(omitted).fill(0), ...right];
}

function parseIpv6Half(half: string): number[] | null {
  if (half === "") return [];
  const tokens = half.split(":");
  const words: number[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.includes(".")) {
      if (index !== tokens.length - 1) return null;
      const octets = parseIpv4(token);
      if (octets === null) return null;
      words.push((octets[0] << 8) | octets[1]);
      words.push((octets[2] << 8) | octets[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
    words.push(Number.parseInt(token, 16));
  }
  return words;
}

function mappedIpv4(words: readonly number[]): Ipv4Octets | null {
  if (
    words.length !== 8 ||
    !words.slice(0, 5).every((word) => word === 0) ||
    words[5] !== 0xffff
  ) {
    return null;
  }
  return [
    words[6] >> 8,
    words[6] & 0xff,
    words[7] >> 8,
    words[7] & 0xff,
  ];
}
```

Modify `src/network/protocol.ts` to import and use the new predicate:

```typescript
import { isIP } from "node:net";
import { isDeniedIpAddress } from "./ip_policy.ts";

export function denyReasonForTarget(target: NormalizedTarget): string | null {
  const host = normalizeHost(target.host);
  if (host === "localhost") return "blocked-special-host";
  if (isIP(host) !== 0 && isDeniedIpAddress(host)) {
    return "blocked-private-ip";
  }
  return null;
}
```

Delete the old `isDeniedIpv4` and `isDeniedIpv6` functions from
`src/network/protocol.ts`.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run:

```bash
bun test src/network/ip_policy_test.ts src/network/protocol_test.ts src/network/protocol_edges_test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit the TypeScript hardening**

```bash
git add src/network/denied_ip_policy_cases.json src/network/ip_policy.ts src/network/ip_policy_test.ts src/network/protocol.ts src/network/protocol_edges_test.ts
git commit -m "fix(network): harden denied IP predicate"
```

---

### Task 2: Mirror the IP policy at the Python connection boundary

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon.py`
- Modify: `src/docker/mitmproxy/nas_addon_mask_test.py`
- Modify: `src/docker/mitmproxy/nas_addon_test.ts`

**Interfaces:**
- Consumes: `src/network/denied_ip_policy_cases.json` as the shared expected-result corpus.
- Produces: `_is_denied_ip(address: str) -> bool`, consumed by Task 3's `server_connect` hook.

- [ ] **Step 1: Write the failing Python parity test**

Add these imports and test class to
`src/docker/mitmproxy/nas_addon_mask_test.py`:

```python
import json
from pathlib import Path


class DeniedIpPolicyTest(unittest.TestCase):
    def test_matches_shared_policy_cases(self):
        cases_path = (
            Path(__file__).resolve().parents[2]
            / "network"
            / "denied_ip_policy_cases.json"
        )
        cases = json.loads(cases_path.read_text())
        for case in cases:
            with self.subTest(address=case["address"]):
                self.assertEqual(
                    nas_addon._is_denied_ip(case["address"]),
                    case["denied"],
                )

    def test_hostname_and_malformed_value_are_not_ip_addresses(self):
        self.assertFalse(nas_addon._is_denied_ip("example.com"))
        self.assertFalse(nas_addon._is_denied_ip("1.2.3.999"))
```

Change the Bun wrapper test name in `nas_addon_test.ts` without changing its
execution mechanics:

```typescript
test.skipIf(!python3)("nas_addon helpers (python unittest)", async () => {
```

- [ ] **Step 2: Run the wrapper and confirm RED**

Run:

```bash
bun test src/docker/mitmproxy/nas_addon_test.ts
```

Expected: FAIL with `AttributeError: module 'nas_addon' has no attribute '_is_denied_ip'`.

- [ ] **Step 3: Implement the explicit Python policy**

Add the import, network constants, and predicate near the top of
`src/docker/mitmproxy/nas_addon.py`:

```python
import ipaddress

DENIED_IPV4_NETWORKS = tuple(
    ipaddress.ip_network(cidr)
    for cidr in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.168.0.0/16",
    )
)
DENIED_IPV6_NETWORKS = tuple(
    ipaddress.ip_network(cidr)
    for cidr in ("::/128", "::1/128", "fc00::/7", "fe80::/10")
)


def _parse_ip(address: str):
    try:
        return ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return None


def _is_denied_ip(address: str) -> bool:
    parsed = _parse_ip(address)
    if parsed is None:
        return False
    if isinstance(parsed, ipaddress.IPv6Address) and parsed.ipv4_mapped:
        parsed = parsed.ipv4_mapped
    networks = (
        DENIED_IPV4_NETWORKS
        if isinstance(parsed, ipaddress.IPv4Address)
        else DENIED_IPV6_NETWORKS
    )
    return any(parsed in network for network in networks)
```

- [ ] **Step 4: Run the Python wrapper and confirm GREEN**

Run:

```bash
bun test src/docker/mitmproxy/nas_addon_test.ts
```

Expected: PASS, including every shared policy subtest.

- [ ] **Step 5: Commit the Python policy**

```bash
git add src/docker/mitmproxy/nas_addon.py src/docker/mitmproxy/nas_addon_mask_test.py src/docker/mitmproxy/nas_addon_test.ts
git commit -m "fix(network): enforce denied IPs in proxy addon"
```

---

### Task 3: Resolve, filter, and pin upstream DNS answers

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon.py`
- Modify: `src/docker/mitmproxy/nas_addon_mask_test.py`
- Create: `src/docker/mitmproxy/nas_addon_integration_test.ts`

**Interfaces:**
- Consumes: `_parse_ip(address: str)` and `_is_denied_ip(address: str)` from Task 2.
- Produces: `NasAddon.server_connect(data)`, an async mitmproxy 11 hook that either sets `data.server.error` or pins `data.server.address` to an allowed IP.

- [ ] **Step 1: Write failing async unit tests for the connection hook**

Add these helpers and tests to
`src/docker/mitmproxy/nas_addon_mask_test.py`:

```python
import asyncio
import socket


def addrinfo(address, port):
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    sockaddr = (
        (address, port, 0, 0)
        if family == socket.AF_INET6
        else (address, port)
    )
    return (family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sockaddr)


class FakeServer:
    def __init__(self, address, sni=None):
        self.address = address
        self.sni = sni
        self.error = None


class FakeServerConnectData:
    def __init__(self, address, sni=None):
        self.server = FakeServer(address, sni)


class ServerConnectTest(unittest.TestCase):
    def run_hook(self, answers, host="rebind.test", port=443, sni=None):
        async def resolver(_host, _port, **_kwargs):
            return [addrinfo(address, port) for address in answers]

        addon = nas_addon.NasAddon(resolver=resolver, dns_timeout=0.1)
        data = FakeServerConnectData((host, port), sni)
        asyncio.run(addon.server_connect(data))
        return data

    def test_pins_first_allowed_address_and_preserves_hostname_as_sni(self):
        data = self.run_hook(["8.8.8.8", "1.1.1.1"])
        self.assertEqual(data.server.address, ("8.8.8.8", 443))
        self.assertEqual(data.server.sni, "rebind.test")
        self.assertIsNone(data.server.error)

    def test_discards_denied_candidates_before_pinning(self):
        data = self.run_hook(["127.0.0.1", "8.8.8.8", "8.8.8.8"])
        self.assertEqual(data.server.address, ("8.8.8.8", 443))
        self.assertIsNone(data.server.error)

    def test_all_denied_answers_fail_closed(self):
        data = self.run_hook(["127.0.0.1", "::1"])
        self.assertIn("denied", data.server.error)
        self.assertEqual(data.server.address, ("rebind.test", 443))

    def test_direct_denied_ip_fails_without_dns(self):
        called = False

        async def resolver(_host, _port, **_kwargs):
            nonlocal called
            called = True
            return []

        addon = nas_addon.NasAddon(resolver=resolver, dns_timeout=0.1)
        data = FakeServerConnectData(("::ffff:127.0.0.1", 80))
        asyncio.run(addon.server_connect(data))
        self.assertFalse(called)
        self.assertIn("denied", data.server.error)

    def test_resolution_error_fails_closed(self):
        async def resolver(_host, _port, **_kwargs):
            raise socket.gaierror("not found")

        addon = nas_addon.NasAddon(resolver=resolver, dns_timeout=0.1)
        data = FakeServerConnectData(("missing.test", 80))
        asyncio.run(addon.server_connect(data))
        self.assertIn("DNS resolution failed", data.server.error)

    def test_resolution_timeout_fails_closed(self):
        async def resolver(_host, _port, **_kwargs):
            await asyncio.sleep(1)
            return []

        addon = nas_addon.NasAddon(resolver=resolver, dns_timeout=0.001)
        data = FakeServerConnectData(("slow.test", 80))
        asyncio.run(addon.server_connect(data))
        self.assertIn("DNS resolution timed out", data.server.error)
```

- [ ] **Step 2: Add the failing real-mitmproxy integration test**

Create `src/docker/mitmproxy/nas_addon_integration_test.ts`. The file must:

```typescript
import { expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import {
  dockerLogs,
  dockerRm,
  dockerRunDetached,
  dockerStop,
} from "../client.ts";
import { hashToken } from "../../network/protocol.ts";
import {
  brokerSocketPath,
  resolveNetworkRuntimePaths,
  sessionRegistryPath,
  writeSessionRegistry,
} from "../../network/registry.ts";

const SHARED_TMP = process.env.NAS_DIND_SHARED_TMP;
const canBindMount = SHARED_TMP !== undefined || !process.env.DOCKER_HOST;
const dockerAvailable = (() => {
  try {
    return Bun.spawnSync(["docker", "info"], {
      stdout: "ignore",
      stderr: "ignore",
    }).success;
  } catch {
    return false;
  }
})();

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitForTcp(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      });
      return;
    } catch {
      await Bun.sleep(50);
    }
  }
  throw new Error(`timed out waiting for proxy port ${port}`);
}

async function publishedPort(containerName: string): Promise<number> {
  const proc = Bun.spawn(["docker", "port", containerName, "8080/tcp"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(stderr.trim());
  const match = stdout.trim().match(/:(\d+)$/);
  if (!match) throw new Error(`unexpected docker port output: ${stdout}`);
  return Number(match[1]);
}

async function sendProxyRequest(
  proxyPort: number,
  targetUrl: string,
  credentials: string,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: proxyPort });
    socket.setTimeout(5_000, () => socket.destroy());
    socket.once("connect", () => {
      socket.write(
        [
          `GET ${targetUrl} HTTP/1.1`,
          `Host: ${new URL(targetUrl).host}`,
          `Proxy-Authorization: Basic ${btoa(credentials)}`,
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", () => {});
    socket.once("error", () => resolve());
    socket.once("close", () => resolve());
  });
}

test.skipIf(!dockerAvailable || !canBindMount)(
  "nas_addon: DNS resolving to host gateway is blocked before connect",
  async () => {
    const base = SHARED_TMP ?? "/tmp";
    const runtimeDir = await mkdtemp(path.join(base, "nas-addon-dns-"));
    const paths = await resolveNetworkRuntimePaths(runtimeDir);
    const sessionId = `sess_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const token = "integration-token";
    const socketPath = brokerSocketPath(paths, sessionId);
    const containerName = `nas-addon-test-${crypto.randomUUID().slice(0, 8)}`;
    let brokerRequests = 0;
    let hostConnections = 0;
    let targetPort = 0;

    const target = net.createServer((socket) => {
      hostConnections += 1;
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\nhost reached");
    });

    const broker = net.createServer((socket) => {
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString();
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(input.slice(0, newline));
        brokerRequests += 1;
        socket.end(
          `${JSON.stringify({
            version: 1,
            type: "decision",
            requestId: request.requestId,
            decision: "allow",
            reason: "integration-test",
          })}\n`,
        );
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        target.once("error", reject);
        target.listen(0, "0.0.0.0", resolve);
      });
      targetPort = (target.address() as AddressInfo).port;
      await chmod(runtimeDir, 0o755);
      await chmod(paths.caCertDir, 0o777);
      await chmod(paths.brokersDir, 0o755);
      await chmod(paths.reviewRulesDir, 0o755);
      await mkdir(path.dirname(socketPath), { recursive: true });
      await chmod(path.dirname(socketPath), 0o755);
      await copyFile(
        new URL("./nas_addon.py", import.meta.url).pathname,
        paths.addonScriptPath,
      );
      await writeFile(
        `${paths.reviewRulesDir}/${sessionId}.json`,
        "[]",
      );
      await writeSessionRegistry(paths, {
        version: 1,
        sessionId,
        tokenHash: await hashToken(token),
        brokerSocket: socketPath,
        profileName: "integration-test",
        createdAt: new Date().toISOString(),
        pid: process.pid,
      });
      await chmod(paths.sessionsDir, 0o755);
      await chmod(sessionRegistryPath(paths, sessionId), 0o644);
      await new Promise<void>((resolve, reject) => {
        broker.once("error", reject);
        broker.listen(socketPath, resolve);
      });
      await chmod(socketPath, 0o666);

      await dockerRunDetached({
        name: containerName,
        image: "mitmproxy/mitmproxy:11",
        args: ["--add-host=rebind.test:host-gateway"],
        envVars: {},
        mounts: [{ source: runtimeDir, target: "/nas-network", mode: "rw" }],
        publishedPorts: ["127.0.0.1::8080"],
        command: [
          "mitmdump",
          "--mode",
          "regular@8080",
          "--set",
          "connection_strategy=lazy",
          "--set",
          "confdir=/nas-network/mitmproxy-ca",
          "--ssl-insecure",
          "-s",
          "/nas-network/nas_addon.py",
        ],
      });
      const proxyPort = await publishedPort(containerName);
      await waitForTcp(proxyPort);

      await sendProxyRequest(
        proxyPort,
        `http://rebind.test:${targetPort}/`,
        `${sessionId}:${token}`,
      );
      await Bun.sleep(100);

      expect(brokerRequests).toEqual(1);
      expect(hostConnections).toEqual(0);
      expect(await dockerLogs(containerName)).toContain("DNS-BLOCKED");
    } finally {
      await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(containerName).catch(() => {});
      if (broker.listening) await closeServer(broker);
      if (target.listening) await closeServer(target);
      await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    }
  },
);
```

The three security assertions are mandatory: the broker saw the allow request,
the host TCP listener saw zero connections, and the addon logged the DNS block.

- [ ] **Step 3: Run unit and integration tests and confirm RED**

Run:

```bash
bun test src/docker/mitmproxy/nas_addon_test.ts
bun test src/docker/mitmproxy/nas_addon_integration_test.ts
```

Expected: the unit test FAILS because `NasAddon` does not accept a resolver or
define `server_connect`. With Docker available, the integration test also
FAILS because the current addon reaches the host listener; without Docker it
reports SKIP.

- [ ] **Step 4: Implement async DNS filtering and pinning**

Add `asyncio` and the resolver helper to `nas_addon.py`:

```python
import asyncio

DNS_TIMEOUT_SECONDS = 5.0


def _addresses_from_addrinfo(results) -> list[str]:
    addresses: list[str] = []
    seen: set[str] = set()
    for family, socktype, _proto, _canonname, sockaddr in results:
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        if socktype not in (0, socket.SOCK_STREAM):
            continue
        address = sockaddr[0]
        parsed = _parse_ip(address)
        if parsed is None:
            continue
        normalized = str(parsed)
        if normalized not in seen:
            seen.add(normalized)
            addresses.append(normalized)
    return addresses
```

Change `NasAddon.__init__` and add the hook:

```python
class NasAddon:
    def __init__(self, resolver=None, dns_timeout=DNS_TIMEOUT_SECONDS):
        self._resolver = resolver
        self._dns_timeout = dns_timeout
        self._connect_creds: dict[str, tuple[str, str]] = {}
        self._mask_values_cache: Optional[list[str]] = None
        self._mask_patterns_cache: list[bytes] = []

    async def server_connect(self, data) -> None:
        if not data.server.address:
            data.server.error = "nas: missing upstream address"
            return

        host, port = data.server.address
        parsed = _parse_ip(host)
        if parsed is not None:
            if _is_denied_ip(host):
                print(
                    f"[nas-addon] DNS-BLOCKED: denied direct IP {host}:{port}",
                    file=sys.stderr,
                )
                data.server.error = "nas: denied upstream IP"
            return

        resolver = self._resolver or asyncio.get_running_loop().getaddrinfo
        try:
            results = await asyncio.wait_for(
                resolver(host, port, type=socket.SOCK_STREAM),
                timeout=self._dns_timeout,
            )
        except asyncio.TimeoutError:
            data.server.error = "nas: DNS resolution timed out"
            return
        except Exception as exc:
            print(
                f"[nas-addon] DNS-BLOCKED: resolution failed for {host}:{port}: {exc}",
                file=sys.stderr,
            )
            data.server.error = "nas: DNS resolution failed"
            return

        addresses = _addresses_from_addrinfo(results)
        allowed: list[str] = []
        for address in addresses:
            if _is_denied_ip(address):
                print(
                    f"[nas-addon] DNS-BLOCKED: denied answer {address} for {host}:{port}",
                    file=sys.stderr,
                )
            else:
                allowed.append(address)

        if not addresses:
            data.server.error = "nas: DNS resolution returned no usable addresses"
            return
        if not allowed:
            data.server.error = "nas: all resolved upstream IPs were denied"
            return

        if data.server.sni is None:
            data.server.sni = host
        data.server.address = (allowed[0], port)
```

Retain the existing cache and credential fields exactly once in `__init__`;
the snippet replaces their current initialization rather than duplicating it.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run:

```bash
bun test src/docker/mitmproxy/nas_addon_test.ts
bun test src/docker/mitmproxy/nas_addon_integration_test.ts
```

Expected: Python unit tests PASS. The integration test PASSes when Docker and
bind mounts are available, otherwise it reports SKIP through the declared
guard.

- [ ] **Step 6: Re-run all network-focused tests**

Run:

```bash
bun test src/network/ip_policy_test.ts src/network/protocol_test.ts src/network/protocol_edges_test.ts src/network/broker_integration_test.ts src/docker/mitmproxy/nas_addon_test.ts
```

Expected: all tests PASS.

- [ ] **Step 7: Commit DNS pinning and integration coverage**

```bash
git add src/docker/mitmproxy/nas_addon.py src/docker/mitmproxy/nas_addon_mask_test.py src/docker/mitmproxy/nas_addon_integration_test.ts
git commit -m "fix(network): pin validated proxy DNS answers"
```

---

### Task 4: Record completion and run project-wide verification

**Files:**
- Modify: `docs/todo/security.md`

**Interfaces:**
- Consumes: passing commits and test evidence from Tasks 1-3.
- Produces: an actionable security backlog with H5/H6 removed from P0 and retained as completed audit history.

- [ ] **Step 1: Run formatting and inspect its changes**

Run:

```bash
bun run fmt
git diff --check
```

Expected: formatter exits 0 and `git diff --check` prints no errors. Review any
formatter edits and retain only formatting changes within this feature's files.

- [ ] **Step 2: Run lint and strict type checking**

Run:

```bash
bun run lint
bun run lint:composed-effects
bun run check
```

Expected: all three commands exit 0. `bun run check` repeats the standard lint
as part of the repository script and additionally passes all TypeScript checks.

- [ ] **Step 3: Run unit and integration verification**

Run:

```bash
bun run test:unit
bun test src/network/broker_integration_test.ts src/docker/mitmproxy/nas_addon_integration_test.ts
```

Expected: unit tests PASS. Broker integration PASSes. Addon integration PASSes
when Docker/bind mounts are available or reports SKIP only through its normal
availability guard.

- [ ] **Step 4: Update the security backlog using verified evidence**

Modify `docs/todo/security.md` as follows:

- remove H6 and H5 from the actionable P0 rows in `§0`;
- add H5/H6 to the verified-complete note with the implementation commit IDs;
- change both rows in `対応状況サマリ` to `✅ 解決`;
- state that H6 now uses structural TS parsing plus Python `ipaddress` parity
  tests;
- state that H5 resolves, filters, and pins in `server_connect`, with the
  Docker host-gateway integration test as evidence; and
- move or rewrite the former P0 descriptions as completed audit records so no
  unchecked action remains for H5/H6.

Use concrete file/test names and the actual commit IDs; do not claim Docker
PASS if the integration test skipped.

- [ ] **Step 5: Verify the documentation-only diff**

Run:

```bash
git diff --check
git diff -- docs/todo/security.md
```

Expected: no whitespace errors; the diff removes H5/H6 from actionable P0 and
preserves clear evidence of their resolution.

- [ ] **Step 6: Commit the verified backlog update**

```bash
git add docs/todo/security.md
git commit -m "docs: mark network SSRF gaps resolved"
```

- [ ] **Step 7: Capture the final branch evidence**

Run:

```bash
git status --short
git log --oneline --decorate -6
```

Expected: clean working tree and separate commits for the approved design,
TypeScript IP policy, Python IP policy, DNS pinning/integration, and backlog
update.
