"""Unit tests for the mask helpers in nas_addon.py.

Run via nas_addon_test.ts, which sets PYTHONPATH to the mitmproxy stub.
Direct invocation:
    PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py
"""

import base64
import socket
import unittest
from unittest.mock import patch

import nas_addon


class BuildMaskPatternsTest(unittest.TestCase):
    def test_includes_raw_value(self):
        patterns = nas_addon._build_mask_patterns(["s3cret-value"])
        self.assertIn(b"s3cret-value", patterns)

    def test_includes_percent_encoded_variants(self):
        patterns = nas_addon._build_mask_patterns(["p@ss w+rd"])
        self.assertIn(b"p%40ss%20w%2Brd", patterns)  # quote(value, safe="")
        self.assertIn(b"p%40ss+w%2Brd", patterns)    # quote_plus(value)

    def test_base64_detected_at_all_embedding_offsets(self):
        secret = b"s3cret-value-long"
        patterns = nas_addon._build_mask_patterns([secret.decode()])
        for offset in range(3):
            stream = b"A" * offset + secret + b"BC"
            encoded = base64.b64encode(stream)
            self.assertTrue(
                any(p in encoded for p in patterns),
                f"offset {offset}: no pattern found in {encoded!r}",
            )

    def test_short_secret_has_no_base64_patterns(self):
        patterns = nas_addon._build_mask_patterns(["abcd"])
        self.assertEqual(patterns, [b"abcd"])

    def test_sorted_longest_first(self):
        patterns = nas_addon._build_mask_patterns(
            ["shortpw1", "much-longer-secret"]
        )
        lengths = [len(p) for p in patterns]
        self.assertEqual(lengths, sorted(lengths, reverse=True))


class MaskBytesTest(unittest.TestCase):
    def test_replaces_all_occurrences(self):
        patterns = nas_addon._build_mask_patterns(["s3cret-value"])
        self.assertEqual(
            nas_addon._mask_bytes(b"a=s3cret-value&b=s3cret-value", patterns),
            b"a=****&b=****",
        )

    def test_longest_pattern_wins(self):
        patterns = nas_addon._build_mask_patterns(
            ["s3cret", "s3cret-extended"]
        )
        self.assertEqual(
            nas_addon._mask_bytes(b"x=s3cret-extended", patterns),
            b"x=****",
        )

    def test_masks_base64_encoded_body(self):
        secret = "s3cret-value-long"
        patterns = nas_addon._build_mask_patterns([secret])
        body = base64.b64encode(secret.encode())
        masked = nas_addon._mask_bytes(body, patterns)
        self.assertNotIn(secret.encode(), masked)
        self.assertIn(b"****", masked)


class FakeHeaders:
    """mitmproxy の Headers (multidict) の最小フェイク。同名ヘッダーの
    重複を保持し、get_all/set_all で全件を走査・書き換えできるようにする。"""

    def __init__(self, items=None):
        # items: [(name, value), ...] で重複ヘッダーを表現する。
        self._items = list(items) if items is not None else []

    def keys(self):
        seen = []
        for name, _ in self._items:
            if name not in seen:
                seen.append(name)
        return seen

    def get_all(self, name):
        return [value for key, value in self._items if key == name]

    def set_all(self, name, values):
        new_items = []
        inserted = False
        for key, value in self._items:
            if key != name:
                new_items.append((key, value))
            elif not inserted:
                new_items.extend((name, v) for v in values)
                inserted = True
        if not inserted:
            new_items.extend((name, v) for v in values)
        self._items = new_items

    def get(self, name, default=None):
        for key, value in self._items:
            if key == name:
                return value
        return default

    def __contains__(self, name):
        return any(key == name for key, _ in self._items)

    def __getitem__(self, name):
        for key, value in self._items:
            if key == name:
                return value
        raise KeyError(name)

    def __setitem__(self, name, value):
        self.set_all(name, [value])

    def __delitem__(self, name):
        self._items = [(key, value) for key, value in self._items if key != name]


class FakeRequest:
    """flow.request の最小フェイク。headers は FakeHeaders (multidict) で
    代用する。dict を渡した場合は (name, value) ペアの列に変換する。"""

    def __init__(self, path="/", headers=None, content=b""):
        self.path = path
        if headers is None:
            self.headers = FakeHeaders()
        elif isinstance(headers, FakeHeaders):
            self.headers = headers
        elif isinstance(headers, dict):
            self.headers = FakeHeaders(list(headers.items()))
        else:
            self.headers = FakeHeaders(list(headers))
        self._content = content
        self.raw_content = content
        self._host = None
        self.port = None
        self.method = None
        self.pretty_url = None

    @property
    def content(self):
        return self._content

    @content.setter
    def content(self, value):
        self._content = value

    @property
    def host(self):
        return self._host

    @host.setter
    def host(self, value):
        self._host = value
        # Mimic mitmproxy's real Request.host setter, which also
        # overwrites the "Host" header as a side effect. nas_addon.py's
        # IP-pinning logic relies on this to justify restoring the
        # original Host header after pinning — this fake must reproduce
        # it or the restore logic couldn't be exercised.
        self.headers["Host"] = value


class FakeUndecodableRequest(FakeRequest):
    """Content-Encoding が未知で .content が ValueError を投げるケース。"""

    @property
    def content(self):
        raise ValueError("cannot decode")

    @content.setter
    def content(self, value):
        raise AssertionError("must not set .content on undecodable body")


class FakeFlow:
    def __init__(self, request):
        self.request = request


class ApplyRequestMaskingTest(unittest.TestCase):
    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["s3cret-value"])

    def test_masks_url_headers_and_body(self):
        flow = FakeFlow(FakeRequest(
            path="/upload?token=s3cret-value",
            headers={"x-note": "v=s3cret-value", "host": "example.com"},
            content=b"data=s3cret-value",
        ))
        nas_addon._apply_request_masking(flow, self.patterns)
        self.assertEqual(flow.request.path, "/upload?token=****")
        self.assertEqual(flow.request.headers["x-note"], "v=****")
        self.assertEqual(flow.request.headers["host"], "example.com")
        self.assertEqual(flow.request.content, b"data=****")

    def test_masks_duplicated_header_second_occurrence(self):
        flow = FakeFlow(FakeRequest(
            headers=FakeHeaders([
                ("x-note", "first"),
                ("x-note", "v=s3cret-value"),
                ("host", "example.com"),
            ]),
        ))
        nas_addon._apply_request_masking(flow, self.patterns)
        self.assertEqual(
            flow.request.headers.get_all("x-note"), ["first", "v=****"]
        )
        self.assertEqual(flow.request.headers["host"], "example.com")

    def test_preserves_non_utf8_byte_while_masking_path_and_header(self):
        # "\udcff" is how mitmproxy's surrogateescape decoding represents a
        # raw 0xff byte that isn't valid UTF-8; it must round-trip exactly,
        # not get corrupted into U+FFFD, wherever no mask pattern matched.
        flow = FakeFlow(FakeRequest(
            path="/p\udcff?token=s3cret-value",
            headers=FakeHeaders([("x-note", "v=s3cret-value\udcff")]),
        ))
        nas_addon._apply_request_masking(flow, self.patterns)
        self.assertEqual(flow.request.path, "/p\udcff?token=****")
        self.assertEqual(flow.request.headers["x-note"], "v=****\udcff")

    def test_masks_percent_encoded_secret_in_form_body(self):
        patterns = nas_addon._build_mask_patterns(["p@ss w+rd"])
        flow = FakeFlow(FakeRequest(content=b"password=p%40ss+w%2Brd"))
        nas_addon._apply_request_masking(flow, patterns)
        self.assertEqual(flow.request.content, b"password=****")

    def test_undecodable_body_sets_mask_blocked_flag(self):
        flow = FakeFlow(FakeUndecodableRequest(
            content=b"xx s3cret-value yy",
        ))
        nas_addon._apply_request_masking(flow, self.patterns)
        self.assertTrue(
            getattr(flow, "mask_blocked", False),
            "mask_blocked flag must be set when body cannot be decoded",
        )
        # raw_content must NOT be touched — masking compressed bytes is
        # unreliable so we block the request entirely instead.
        self.assertEqual(flow.request.raw_content, b"xx s3cret-value yy")

    def test_empty_body_untouched(self):
        flow = FakeFlow(FakeRequest(content=b""))
        nas_addon._apply_request_masking(flow, self.patterns)
        self.assertEqual(flow.request.content, b"")


class PatternsForCacheTest(unittest.TestCase):
    def test_caches_patterns_per_mask_values_identity(self):
        addon = nas_addon.NasAddon()
        first = addon._patterns_for(["s3cret-value"])
        second = addon._patterns_for(["s3cret-value"])
        self.assertIs(first, second)

        third = addon._patterns_for(["other-secret"])
        self.assertIsNot(first, third)
        self.assertIn(b"other-secret", third)


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


class RequestPinningTest(unittest.TestCase):
    """Integration test: request() pins flow.request.host to resolved IP.

    Exercises the full request() path (creds -> registry -> broker ->
    DNS-rebinding pin) with _query_broker, socket.getaddrinfo, and
    _load_registry mocked, driven through FakeFlow/FakeRequest.
    """

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
        # The Host header must be restored to the original hostname —
        # not left as the pinned IP that FakeRequest.host's setter
        # (mimicking mitmproxy) would otherwise overwrite it with.
        self.assertEqual(flow.request.headers["Host"], "example.com")

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
        # Host must never be pinned to a denied IP — the request is
        # blocked before pinning happens.
        self.assertEqual(flow.request.host, "evil.attacker.com")

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
        self.assertEqual(flow.request.headers["Host"], "8.8.8.8")


if __name__ == "__main__":
    unittest.main()
