# H5+H6: IP 拒否リスト修正 + DNS リバインディング防御 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `isDeniedIpv4/6` predicate bugs (H6) and add post-resolve IP recheck with pinning in the mitmproxy addon (H5) to close the DNS rebinding attack surface.

**Architecture:** H6 is a pure-function fix in `src/network/protocol.ts` with comprehensive unit tests. H5 adds `_is_denied_ip` + `_resolve_and_pin` to `src/docker/mitmproxy/nas_addon.py`, invoked between broker-allow and upstream connection. Both use the same denied-CIDR list (TS hand-rolled, Python `ipaddress` stdlib) kept in sync via identical test cases and code comments.

**Tech Stack:** TypeScript (Bun test), Python 3 (unittest, `ipaddress` stdlib, `socket.getaddrinfo`)

## Global Constraints

- Runtime: Bun (not Deno, not Node)
- Test framework: `bun:test` for TS, `unittest` for Python (run via `nas_addon_test.ts` harness)
- Python addon tests use `testdata/mitmproxy_stub` PYTHONPATH — no real mitmproxy import
- Keep TS/Python denied-CIDR lists in sync — same test cases in both, "keep in sync" comment
- fail-closed: unparseable IPs and DNS failures are denied
- Coding style: test-policy skill (Bun), effect-separation skill (stage architecture)

---

### Task 1: Fix `isDeniedIpv4` — add `0.0.0.0/8` and CGNAT

**Files:**
- Modify: `src/network/protocol.ts:335-349` (`isDeniedIpv4`)
- Test: `src/network/protocol_test.ts`

**Interfaces:**
- Consumes: nothing new (internal function)
- Produces: `isDeniedIpv4(host: string): boolean` — now also blocks `0.0.0.0/8` and `100.64.0.0/10`

- [ ] **Step 1: Write failing tests for the new CIDR ranges**

Add to `src/network/protocol_test.ts`:

```typescript
test("denyReasonForTarget: blocks 0.0.0.0/8 (this-network)", () => {
  expect(denyReasonForTarget({ host: "0.0.0.0", port: 80 })).toEqual(
    "blocked-private-ip",
  );
  expect(denyReasonForTarget({ host: "0.255.255.255", port: 80 })).toEqual(
    "blocked-private-ip",
  );
});

test("denyReasonForTarget: blocks CGNAT 100.64.0.0/10", () => {
  expect(denyReasonForTarget({ host: "100.64.0.0", port: 80 })).toEqual(
    "blocked-private-ip",
  );
  expect(denyReasonForTarget({ host: "100.64.0.1", port: 80 })).toEqual(
    "blocked-private-ip",
  );
  expect(denyReasonForTarget({ host: "100.127.255.255", port: 80 })).toEqual(
    "blocked-private-ip",
  );
  // Just outside CGNAT range
  expect(denyReasonForTarget({ host: "100.128.0.0", port: 80 })).toEqual(null);
  expect(denyReasonForTarget({ host: "100.63.255.255", port: 80 })).toEqual(
    null,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/network/protocol_test.ts`
Expected: 2 new tests FAIL (0.0.0.0 and 100.64.x.x currently pass through)

- [ ] **Step 3: Fix `isDeniedIpv4`**

In `src/network/protocol.ts`, replace the `isDeniedIpv4` function:

```typescript
function isDeniedIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this" network
  if (a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/network/protocol_test.ts`
Expected: ALL PASS (existing tests still pass, new tests now pass)

- [ ] **Step 5: Commit**

```bash
git add src/network/protocol.ts src/network/protocol_test.ts
git commit -m "fix(network): block 0.0.0.0/8 and CGNAT 100.64.0.0/10 in isDeniedIpv4"
```

---

### Task 2: Rewrite `isDeniedIpv6` — full expansion + IPv4-mapped delegation

**Files:**
- Modify: `src/network/protocol.ts:351-363` (`isDeniedIpv6`)
- Test: `src/network/protocol_test.ts`

**Interfaces:**
- Consumes: `isDeniedIpv4(host: string): boolean` (from Task 1)
- Produces: `isDeniedIpv6(host: string): boolean` — now handles `::`, non-compressed `::1`, IPv4-mapped addresses

- [ ] **Step 1: Write failing tests for IPv6 edge cases**

Add to `src/network/protocol_test.ts`:

```typescript
test("denyReasonForTarget: blocks :: (unspecified)", () => {
  expect(denyReasonForTarget({ host: "::", port: 80 })).toEqual(
    "blocked-private-ip",
  );
});

test("denyReasonForTarget: blocks ::1 in non-compressed forms", () => {
  expect(
    denyReasonForTarget({ host: "0:0:0:0:0:0:0:1", port: 80 }),
  ).toEqual("blocked-private-ip");
  expect(
    denyReasonForTarget({ host: "0000:0000:0000:0000:0000:0000:0000:0001", port: 80 }),
  ).toEqual("blocked-private-ip");
});

test("denyReasonForTarget: blocks IPv4-mapped IPv6 addresses", () => {
  expect(
    denyReasonForTarget({ host: "::ffff:127.0.0.1", port: 80 }),
  ).toEqual("blocked-private-ip");
  expect(
    denyReasonForTarget({ host: "::ffff:169.254.1.1", port: 80 }),
  ).toEqual("blocked-private-ip");
  expect(
    denyReasonForTarget({ host: "::ffff:10.0.0.1", port: 80 }),
  ).toEqual("blocked-private-ip");
  expect(
    denyReasonForTarget({ host: "::ffff:192.168.0.1", port: 80 }),
  ).toEqual("blocked-private-ip");
  expect(
    denyReasonForTarget({ host: "::ffff:100.64.0.1", port: 80 }),
  ).toEqual("blocked-private-ip");
  // Public IPv4-mapped should pass
  expect(
    denyReasonForTarget({ host: "::ffff:8.8.8.8", port: 80 }),
  ).toEqual(null);
});

test("denyReasonForTarget: blocks ULA in non-compressed forms", () => {
  expect(
    denyReasonForTarget({ host: "fc00:0:0:0:0:0:0:1", port: 80 }),
  ).toEqual("blocked-private-ip");
  expect(
    denyReasonForTarget({ host: "fd12:3456:789a::1", port: 80 }),
  ).toEqual("blocked-private-ip");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/network/protocol_test.ts`
Expected: FAIL on `::`, `0:0:0:0:0:0:0:1`, `::ffff:*` cases

- [ ] **Step 3: Implement `expandIpv6` helper and rewrite `isDeniedIpv6`**

In `src/network/protocol.ts`, replace `isDeniedIpv6`:

```typescript
function expandIpv6(host: string): number[] | null {
  const normalized = host.toLowerCase();

  // Handle IPv4-mapped (::ffff:a.b.c.d)
  const v4MappedMatch = normalized.match(
    /^([\da-f:]+):(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
  );
  if (v4MappedMatch) {
    const prefix = v4MappedMatch[1];
    const v4Part = v4MappedMatch[2];
    const v4Octets = v4Part.split(".").map(Number);
    if (
      v4Octets.length !== 4 ||
      v4Octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)
    ) {
      return null;
    }
    const prefixHextets = expandIpv6Pure(prefix + ":0:0");
    if (!prefixHextets) return null;
    // Replace last two hextets with IPv4 octets
    prefixHextets[6] = (v4Octets[0] << 8) | v4Octets[1];
    prefixHextets[7] = (v4Octets[2] << 8) | v4Octets[3];
    return prefixHextets;
  }

  return expandIpv6Pure(normalized);
}

function expandIpv6Pure(addr: string): number[] | null {
  if (addr.includes("::")) {
    const [left, right] = addr.split("::");
    const leftParts = left ? left.split(":") : [];
    const rightParts = right ? right.split(":") : [];
    const missing = 8 - leftParts.length - rightParts.length;
    if (missing < 0) return null;
    const allParts = [
      ...leftParts,
      ...Array(missing).fill("0"),
      ...rightParts,
    ];
    if (allParts.length !== 8) return null;
    return allParts.map((p) => Number.parseInt(p, 16));
  }
  const parts = addr.split(":");
  if (parts.length !== 8) return null;
  return parts.map((p) => Number.parseInt(p, 16));
}

function isDeniedIpv6(host: string): boolean {
  const hextets = expandIpv6(host.toLowerCase());
  if (!hextets || hextets.some((h) => Number.isNaN(h) || h < 0 || h > 0xffff)) {
    return false;
  }

  // Check for IPv4-mapped (::ffff:x.x.x.x) — delegate to isDeniedIpv4
  if (
    hextets[0] === 0 &&
    hextets[1] === 0 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0xffff
  ) {
    const a = (hextets[6] >> 8) & 0xff;
    const b = hextets[6] & 0xff;
    const c = (hextets[7] >> 8) & 0xff;
    const d = hextets[7] & 0xff;
    return isDeniedIpv4(`${a}.${b}.${c}.${d}`);
  }

  // :: (all zeros = unspecified)
  if (hextets.every((h) => h === 0)) return true;
  // ::1 (loopback)
  if (hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1) return true;
  // fc00::/7 (ULA)
  if ((hextets[0] & 0xfe00) === 0xfc00) return true;
  // fe80::/10 (link-local)
  if ((hextets[0] & 0xffc0) === 0xfe80) return true;

  return false;
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `bun test src/network/protocol_test.ts`
Expected: ALL PASS (all existing tests + all new IPv6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/network/protocol.ts src/network/protocol_test.ts
git commit -m "fix(network): rewrite isDeniedIpv6 with full expansion and IPv4-mapped delegation"
```

---

### Task 3: Add `_is_denied_ip` to `nas_addon.py` with unit tests

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon.py` (add `_is_denied_ip` function near top)
- Modify: `src/docker/mitmproxy/nas_addon_mask_test.py` (add test class)

**Interfaces:**
- Consumes: nothing (standalone function)
- Produces: `_is_denied_ip(ip_str: str) -> bool` — mirrors TS `isDeniedIpv4` + `isDeniedIpv6` logic

- [ ] **Step 1: Write the unit tests first**

Add to the end of `src/docker/mitmproxy/nas_addon_mask_test.py` (before `if __name__`):

```python
class IsDeniedIpTest(unittest.TestCase):
    """Tests for _is_denied_ip — mirrors protocol_test.ts deny cases."""

    # --- IPv4 denied ---
    def test_blocks_this_network(self):
        self.assertTrue(nas_addon._is_denied_ip("0.0.0.0"))
        self.assertTrue(nas_addon._is_denied_ip("0.255.255.255"))

    def test_blocks_loopback(self):
        self.assertTrue(nas_addon._is_denied_ip("127.0.0.1"))
        self.assertTrue(nas_addon._is_denied_ip("127.255.255.255"))

    def test_blocks_rfc1918(self):
        self.assertTrue(nas_addon._is_denied_ip("10.0.0.1"))
        self.assertTrue(nas_addon._is_denied_ip("172.16.0.1"))
        self.assertTrue(nas_addon._is_denied_ip("172.31.255.255"))
        self.assertTrue(nas_addon._is_denied_ip("192.168.1.1"))

    def test_blocks_link_local(self):
        self.assertTrue(nas_addon._is_denied_ip("169.254.0.1"))
        self.assertTrue(nas_addon._is_denied_ip("169.254.255.255"))

    def test_blocks_cgnat(self):
        self.assertTrue(nas_addon._is_denied_ip("100.64.0.0"))
        self.assertTrue(nas_addon._is_denied_ip("100.64.0.1"))
        self.assertTrue(nas_addon._is_denied_ip("100.127.255.255"))

    def test_allows_public_ipv4(self):
        self.assertFalse(nas_addon._is_denied_ip("8.8.8.8"))
        self.assertFalse(nas_addon._is_denied_ip("1.1.1.1"))
        self.assertFalse(nas_addon._is_denied_ip("100.128.0.0"))
        self.assertFalse(nas_addon._is_denied_ip("172.32.0.1"))

    # --- IPv6 denied ---
    def test_blocks_unspecified(self):
        self.assertTrue(nas_addon._is_denied_ip("::"))

    def test_blocks_loopback_v6(self):
        self.assertTrue(nas_addon._is_denied_ip("::1"))

    def test_blocks_ula(self):
        self.assertTrue(nas_addon._is_denied_ip("fc00::1"))
        self.assertTrue(nas_addon._is_denied_ip("fd00::1"))
        self.assertTrue(nas_addon._is_denied_ip("fdff::1"))

    def test_blocks_link_local_v6(self):
        self.assertTrue(nas_addon._is_denied_ip("fe80::1"))
        self.assertTrue(nas_addon._is_denied_ip("febf::1"))

    def test_blocks_ipv4_mapped(self):
        self.assertTrue(nas_addon._is_denied_ip("::ffff:127.0.0.1"))
        self.assertTrue(nas_addon._is_denied_ip("::ffff:10.0.0.1"))
        self.assertTrue(nas_addon._is_denied_ip("::ffff:169.254.1.1"))
        self.assertTrue(nas_addon._is_denied_ip("::ffff:192.168.0.1"))
        self.assertTrue(nas_addon._is_denied_ip("::ffff:100.64.0.1"))

    def test_allows_public_ipv6(self):
        self.assertFalse(nas_addon._is_denied_ip("2001:4860:4860::8888"))
        self.assertFalse(nas_addon._is_denied_ip("2606:4700::1111"))

    def test_allows_public_ipv4_mapped(self):
        self.assertFalse(nas_addon._is_denied_ip("::ffff:8.8.8.8"))

    # --- Edge cases ---
    def test_unparseable_is_denied(self):
        self.assertTrue(nas_addon._is_denied_ip("not-an-ip"))
        self.assertTrue(nas_addon._is_denied_ip(""))
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src/docker/mitmproxy && PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py -v`
Expected: FAIL — `AttributeError: module 'nas_addon' has no attribute '_is_denied_ip'`

- [ ] **Step 3: Implement `_is_denied_ip` in `nas_addon.py`**

Add after the existing `import` block (around line 17), before `NETWORK_DIR`:

```python
import ipaddress

# Denied IP networks — mirrors src/network/protocol.ts isDeniedIpv4/isDeniedIpv6.
# Keep both implementations in sync. Changes here require a matching update in
# protocol.ts (and vice versa).
_DENIED_IPV4_NETWORKS = [
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
]

_DENIED_IPV6_NETWORKS = [
    ipaddress.ip_network("::/128"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]


def _is_denied_ip(ip_str: str) -> bool:
    """Check if an IP address falls within a denied network range.
    Fail-closed: unparseable addresses are treated as denied."""
    try:
        addr = ipaddress.ip_address(ip_str)
    except ValueError:
        return True
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    if isinstance(addr, ipaddress.IPv4Address):
        return any(addr in net for net in _DENIED_IPV4_NETWORKS)
    return any(addr in net for net in _DENIED_IPV6_NETWORKS)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src/docker/mitmproxy && PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py -v`
Expected: ALL PASS

Also run the TS harness: `bun test src/docker/mitmproxy/nas_addon_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/docker/mitmproxy/nas_addon.py src/docker/mitmproxy/nas_addon_mask_test.py
git commit -m "feat(network): add _is_denied_ip to mitmproxy addon (H6 Python mirror)"
```

---

### Task 4: Add DNS resolve + denied-IP check + IP pinning to addon `request()`

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon.py` (add `_resolve_and_check`, modify `request()`)
- Modify: `src/docker/mitmproxy/nas_addon_mask_test.py` (add mock-based tests)

**Interfaces:**
- Consumes: `_is_denied_ip(ip_str: str) -> bool` (from Task 3)
- Produces: Modified `NasAddon.request()` that resolves host, checks IP, pins connection or returns 403

- [ ] **Step 1: Write failing tests for `_resolve_and_check`**

Add to `src/docker/mitmproxy/nas_addon_mask_test.py` (before `if __name__`):

```python
from unittest.mock import patch


class ResolveAndCheckTest(unittest.TestCase):
    """Tests for _resolve_and_check with mocked getaddrinfo."""

    def _fake_addrinfo(self, results):
        """Return a mock getaddrinfo that yields the given IP strings."""
        return lambda host, port, *a, **kw: [
            (2, 1, 6, "", (ip, port)) for ip in results
        ]

    @patch("nas_addon.socket.getaddrinfo")
    def test_returns_first_allowed_ip(self, mock_gai):
        mock_gai.side_effect = self._fake_addrinfo(["8.8.8.8", "8.8.4.4"])
        result = nas_addon._resolve_and_check("dns.google", 443)
        self.assertEqual(result, "8.8.8.8")

    @patch("nas_addon.socket.getaddrinfo")
    def test_returns_none_when_any_ip_is_denied(self, mock_gai):
        mock_gai.side_effect = self._fake_addrinfo(["8.8.8.8", "127.0.0.1"])
        result = nas_addon._resolve_and_check("evil.example", 443)
        self.assertIsNone(result)

    @patch("nas_addon.socket.getaddrinfo")
    def test_returns_none_when_all_ips_denied(self, mock_gai):
        mock_gai.side_effect = self._fake_addrinfo(["10.0.0.1", "192.168.1.1"])
        result = nas_addon._resolve_and_check("internal.corp", 80)
        self.assertIsNone(result)

    @patch("nas_addon.socket.getaddrinfo")
    def test_returns_none_on_dns_failure(self, mock_gai):
        mock_gai.side_effect = socket.gaierror("Name or service not known")
        result = nas_addon._resolve_and_check("nonexistent.invalid", 443)
        self.assertIsNone(result)

    @patch("nas_addon.socket.getaddrinfo")
    def test_returns_none_on_empty_result(self, mock_gai):
        mock_gai.return_value = []
        result = nas_addon._resolve_and_check("empty.example", 443)
        self.assertIsNone(result)

    @patch("nas_addon.socket.getaddrinfo")
    def test_ipv4_mapped_denied(self, mock_gai):
        mock_gai.side_effect = self._fake_addrinfo(["::ffff:169.254.1.1"])
        result = nas_addon._resolve_and_check("rebind.attacker", 443)
        self.assertIsNone(result)
```

Also add `import socket` at the top of the test file if not present.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src/docker/mitmproxy && PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py ResolveAndCheckTest -v`
Expected: FAIL — `AttributeError: module 'nas_addon' has no attribute '_resolve_and_check'`

- [ ] **Step 3: Implement `_resolve_and_check`**

Add to `src/docker/mitmproxy/nas_addon.py` after `_is_denied_ip`:

```python
def _resolve_and_check(host: str, port: int) -> Optional[str]:
    """Resolve host via DNS and check all resulting IPs against denied networks.
    Returns the first IP if ALL are allowed, None if any is denied or resolution fails.
    Fail-closed: DNS failure or empty results return None."""
    try:
        results = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, OSError):
        return None
    if not results:
        return None

    ips = []
    for family, socktype, proto, canonname, sockaddr in results:
        ip = sockaddr[0]
        if ip not in ips:
            ips.append(ip)

    for ip in ips:
        if _is_denied_ip(ip):
            return None

    return ips[0]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src/docker/mitmproxy && PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py ResolveAndCheckTest -v`
Expected: ALL PASS

- [ ] **Step 5: Integrate into `NasAddon.request()` — add IP check + pinning after broker allow**

In `src/docker/mitmproxy/nas_addon.py`, in the `request()` method, add the following block **immediately after** the `if decision.get("decision") != "allow":` check (after line 409, before the mask section):

```python
        # H5: DNS rebinding defense — resolve host, check all IPs against
        # denied networks, and pin the connection to the checked IP.
        # This runs after broker-allow but before upstream connection.
        if not _is_ip_literal(host):
            pinned_ip = _resolve_and_check(host, port)
            if pinned_ip is None:
                print(
                    f"[nas-addon] DENIED-RESOLVE: {host}:{port} resolved to "
                    f"denied IP or DNS failed (rebinding defense)",
                    file=sys.stderr,
                )
                flow.response = http.Response.make(
                    403, b"blocked: resolved IP is in denied range"
                )
                return
            # Pin upstream connection to the resolved IP.
            # Host header stays as the original hostname for TLS SNI.
            flow.request.host = pinned_ip
```

Also add the `_is_ip_literal` helper (after `_resolve_and_check`):

```python
def _is_ip_literal(host: str) -> bool:
    """Check if host is already an IP literal (skip resolution for these)."""
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False
```

- [ ] **Step 6: Run all addon tests to verify no regressions**

Run: `cd src/docker/mitmproxy && PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py -v`
Expected: ALL PASS

Also run TS harness: `bun test src/docker/mitmproxy/nas_addon_test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/docker/mitmproxy/nas_addon.py src/docker/mitmproxy/nas_addon_mask_test.py
git commit -m "feat(network): add DNS resolve + IP check + pinning to addon (H5 defense-in-depth)"
```

---

### Task 5: Integration smoke test — verify IP pinning works with mitmproxy

**Files:**
- Modify: `src/docker/mitmproxy/nas_addon_mask_test.py` (add request-flow integration test)

**Interfaces:**
- Consumes: Full `NasAddon.request()` flow with fake broker
- Produces: Test proving the request→resolve→pin→inject flow works end-to-end in Python

- [ ] **Step 1: Write an integration test exercising the full request path with a pinned IP**

Add to `src/docker/mitmproxy/nas_addon_mask_test.py`:

```python
class RequestPinningTest(unittest.TestCase):
    """Integration test: request() pins flow.request.host to resolved IP."""

    def _make_flow(self, host, port, path="/"):
        flow = FakeFlow(FakeRequest(path=path))
        flow.request.host = host
        flow.request.port = port
        flow.request.method = "GET"
        flow.request.pretty_url = f"https://{host}:{port}{path}"
        flow.client_conn = type("C", (), {"id": "test-client-1"})()
        flow.response = None
        return flow

    @patch("nas_addon._query_broker")
    @patch("nas_addon.socket.getaddrinfo")
    @patch("nas_addon._load_registry")
    def test_pins_host_to_resolved_ip(self, mock_reg, mock_gai, mock_broker):
        mock_reg.return_value = {"tokenHash": nas_addon._hash_token("tok")}
        mock_broker.return_value = {"decision": "allow"}
        mock_gai.return_value = [
            (2, 1, 6, "", ("93.184.216.34", 443)),
        ]

        addon = nas_addon.NasAddon()
        addon._connect_creds["test-client-1"] = ("sess1", "tok")

        flow = self._make_flow("example.com", 443)
        addon.request(flow)

        self.assertIsNone(flow.response)
        self.assertEqual(flow.request.host, "93.184.216.34")

    @patch("nas_addon._query_broker")
    @patch("nas_addon.socket.getaddrinfo")
    @patch("nas_addon._load_registry")
    def test_blocks_when_resolved_to_private(self, mock_reg, mock_gai, mock_broker):
        mock_reg.return_value = {"tokenHash": nas_addon._hash_token("tok")}
        mock_broker.return_value = {"decision": "allow"}
        mock_gai.return_value = [
            (2, 1, 6, "", ("169.254.169.254", 80)),
        ]

        addon = nas_addon.NasAddon()
        addon._connect_creds["test-client-1"] = ("sess1", "tok")

        flow = self._make_flow("evil.attacker.com", 80)
        addon.request(flow)

        self.assertIsNotNone(flow.response)
        self.assertEqual(flow.response.status_code, 403)

    @patch("nas_addon._query_broker")
    @patch("nas_addon._load_registry")
    def test_skips_resolve_for_ip_literal(self, mock_reg, mock_broker):
        mock_reg.return_value = {"tokenHash": nas_addon._hash_token("tok")}
        mock_broker.return_value = {"decision": "allow"}

        addon = nas_addon.NasAddon()
        addon._connect_creds["test-client-1"] = ("sess1", "tok")

        flow = self._make_flow("8.8.8.8", 443)
        addon.request(flow)

        # IP literal should not be resolved or pinned — host stays unchanged
        self.assertIsNone(flow.response)
        self.assertEqual(flow.request.host, "8.8.8.8")
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd src/docker/mitmproxy && PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py RequestPinningTest -v`
Expected: ALL PASS (if implementation in Task 4 is correct)

If tests fail, debug and fix. Common issues: `flow.request.host` attribute not present on FakeRequest, or broker path differences.

- [ ] **Step 3: Run full test suite**

Run: `bun test src/docker/mitmproxy/nas_addon_test.ts && bun test src/network/protocol_test.ts`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/docker/mitmproxy/nas_addon_mask_test.py
git commit -m "test(network): add integration tests for DNS rebinding defense pinning"
```

---

### Task 6: Add sync comment + run full check suite

**Files:**
- Modify: `src/network/protocol.ts` (add sync comment to `isDeniedIpv4`)
- Modify: `src/docker/mitmproxy/nas_addon.py` (verify sync comment already added in Task 3)

**Interfaces:**
- Consumes: nothing new
- Produces: Cross-references between TS and Python implementations

- [ ] **Step 1: Add sync comment to TS `isDeniedIpv4`**

At the top of `isDeniedIpv4` in `src/network/protocol.ts`:

```typescript
// Denied IPv4 networks — keep in sync with _DENIED_IPV4_NETWORKS in
// src/docker/mitmproxy/nas_addon.py.
function isDeniedIpv4(host: string): boolean {
```

And at the top of `isDeniedIpv6`:

```typescript
// Denied IPv6 networks — keep in sync with _DENIED_IPV6_NETWORKS in
// src/docker/mitmproxy/nas_addon.py.
function isDeniedIpv6(host: string): boolean {
```

- [ ] **Step 2: Run full project checks**

Run: `bun run check && bun test src/network/protocol_test.ts && bun test src/docker/mitmproxy/nas_addon_test.ts`
Expected: type check PASS, all tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/network/protocol.ts
git commit -m "docs(network): add TS/Python sync comments for denied IP lists"
```
