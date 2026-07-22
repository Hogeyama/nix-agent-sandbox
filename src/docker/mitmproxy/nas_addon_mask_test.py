"""Unit tests for the mask helpers in nas_addon.py.

Run via nas_addon_test.ts, which sets PYTHONPATH to the mitmproxy stub.
Direct invocation:
    PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py
"""

import asyncio
import base64
import io
import json
import socket
import unittest
from contextlib import redirect_stderr
from pathlib import Path

import nas_addon


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

    def test_strips_ipv6_zone_identifier_before_policy_check(self):
        self.assertTrue(nas_addon._is_denied_ip("fe80::1%eth0"))
        self.assertFalse(
            nas_addon._is_denied_ip("2001:4860:4860::8888%eth0")
        )
        self.assertTrue(nas_addon._is_denied_ip("::ffff:127.0.0.1%lo"))


class ServerConnectTest(unittest.TestCase):
    def run_hook(self, answers, host="rebind.test", port=443, sni=None):
        async def resolver(_host, _port, **_kwargs):
            return [addrinfo(address, port) for address in answers]

        addon = nas_addon.NasAddon(resolver=resolver, dns_timeout=0.1)
        data = FakeServerConnectData((host, port), sni)
        asyncio.run(addon.server_connect(data))
        return data

    def test_missing_server_address_fails_closed(self):
        addon = nas_addon.NasAddon(dns_timeout=0.1)
        data = FakeServerConnectData(None)
        asyncio.run(addon.server_connect(data))
        self.assertIn("missing upstream address", data.server.error)

    def test_direct_public_ip_skips_dns(self):
        called = False

        async def resolver(_host, _port, **_kwargs):
            nonlocal called
            called = True
            return []

        addon = nas_addon.NasAddon(resolver=resolver, dns_timeout=0.1)
        data = FakeServerConnectData(("8.8.8.8", 53))
        asyncio.run(addon.server_connect(data))
        self.assertFalse(called)
        self.assertEqual(data.server.address, ("8.8.8.8", 53))
        self.assertIsNone(data.server.error)

    def test_pins_first_allowed_address_and_preserves_hostname_as_sni(self):
        data = self.run_hook(["8.8.8.8", "1.1.1.1"])
        self.assertEqual(data.server.address, ("8.8.8.8", 443))
        self.assertEqual(data.server.sni, "rebind.test")
        self.assertIsNone(data.server.error)

    def test_preserves_pre_existing_sni(self):
        data = self.run_hook(["8.8.8.8"], sni="existing.test")
        self.assertEqual(data.server.sni, "existing.test")

    def test_resolver_is_called_once_per_hostname_connection(self):
        calls = []

        async def resolver(host, port, **kwargs):
            calls.append((host, port, kwargs))
            return [addrinfo("8.8.8.8", port)]

        addon = nas_addon.NasAddon(resolver=resolver, dns_timeout=0.1)
        data = FakeServerConnectData(("once.test", 8443))
        asyncio.run(addon.server_connect(data))
        self.assertEqual(
            calls,
            [("once.test", 8443, {"type": socket.SOCK_STREAM})],
        )

    def test_empty_resolution_result_fails_closed(self):
        data = self.run_hook([])
        self.assertIn("no usable addresses", data.server.error)
        self.assertEqual(data.server.address, ("rebind.test", 443))

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

    def test_direct_denial_log_includes_exact_policy_range(self):
        addon = nas_addon.NasAddon(dns_timeout=0.1)
        data = FakeServerConnectData(("::ffff:127.0.0.1", 80))
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            asyncio.run(addon.server_connect(data))
        self.assertIn("::ffff:127.0.0.1:80", stderr.getvalue())
        self.assertIn("127.0.0.0/8", stderr.getvalue())

    def test_resolved_denial_log_includes_logical_host_and_policy_range(self):
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            self.run_hook(["127.0.0.1"], host="logical.test")
        self.assertIn("127.0.0.1 for logical.test:443", stderr.getvalue())
        self.assertIn("127.0.0.0/8", stderr.getvalue())

    def test_resolution_error_fails_closed(self):
        async def resolver(_host, _port, **_kwargs):
            raise socket.gaierror("not found")

        addon = nas_addon.NasAddon(resolver=resolver, dns_timeout=0.1)
        data = FakeServerConnectData(("missing.test", 80))
        asyncio.run(addon.server_connect(data))
        self.assertIn("DNS resolution failed", data.server.error)

    def test_malformed_resolution_answer_fails_closed(self):
        async def resolver(_host, _port, **_kwargs):
            return [(socket.AF_INET,)]

        addon = nas_addon.NasAddon(resolver=resolver, dns_timeout=0.1)
        data = FakeServerConnectData(("malformed.test", 80))
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


class AddressesFromAddrinfoTest(unittest.TestCase):
    def test_filters_unsupported_families(self):
        results = [
            (socket.AF_UNIX, socket.SOCK_STREAM, 0, "", ("ignored", 443)),
            addrinfo("8.8.8.8", 443),
        ]
        self.assertEqual(
            nas_addon._addresses_from_addrinfo(results),
            ["8.8.8.8"],
        )

    def test_filters_non_stream_socket_types(self):
        results = [
            (socket.AF_INET, socket.SOCK_DGRAM, 0, "", ("1.1.1.1", 443)),
            (socket.AF_INET, 0, 0, "", ("8.8.8.8", 443)),
        ]
        self.assertEqual(
            nas_addon._addresses_from_addrinfo(results),
            ["8.8.8.8"],
        )

    def test_normalizes_and_deduplicates_in_resolver_order(self):
        results = [
            addrinfo("2001:4860:4860:0:0:0:0:8888", 443),
            addrinfo("2001:4860:4860::8888", 443),
            addrinfo("8.8.8.8", 443),
            addrinfo("8.8.8.8", 443),
        ]
        self.assertEqual(
            nas_addon._addresses_from_addrinfo(results),
            ["2001:4860:4860::8888", "8.8.8.8"],
        )


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

    @property
    def content(self):
        return self._content

    @content.setter
    def content(self, value):
        self._content = value


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


class TestAnthropicRouting(unittest.TestCase):
    def test_is_anthropic_host(self):
        self.assertTrue(nas_addon._is_anthropic_host("api.anthropic.com"))
        self.assertTrue(nas_addon._is_anthropic_host("API.ANTHROPIC.COM"))
        self.assertFalse(nas_addon._is_anthropic_host("example.com"))
        self.assertFalse(nas_addon._is_anthropic_host("evil-anthropic.com"))

    def test_known_json_endpoints(self):
        self.assertEqual(nas_addon._anthropic_json_endpoint("POST", "/v1/messages"), "messages")
        self.assertEqual(nas_addon._anthropic_json_endpoint("POST", "/v1/messages/count_tokens"), "messages")
        self.assertEqual(nas_addon._anthropic_json_endpoint("POST", "/v1/messages?beta=true"), "messages")
        self.assertEqual(nas_addon._anthropic_json_endpoint("POST", "/v1/messages/"), "messages")

    def test_unknown_endpoints_return_none(self):
        self.assertIsNone(nas_addon._anthropic_json_endpoint("POST", "/v1/files"))
        self.assertIsNone(nas_addon._anthropic_json_endpoint("GET", "/v1/messages"))
        self.assertIsNone(nas_addon._anthropic_json_endpoint("POST", "/v1/models"))


class TestSchemaMask(unittest.TestCase):
    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["SECRET123"])

    def _mask(self, obj):
        import json
        return nas_addon._schema_mask_json(json.dumps(obj).encode("utf-8"), self.patterns)

    def test_masks_text_block(self):
        body, blocked = self._mask({"model": "m", "messages": [
            {"role": "user", "content": [{"type": "text", "text": "key is SECRET123 ok"}]}]})
        self.assertFalse(blocked)
        self.assertIn(b"****", body)
        self.assertNotIn(b"SECRET123", body)

    def test_masks_system_string(self):
        body, blocked = self._mask({"model": "m", "system": "token SECRET123",
            "messages": [{"role": "user", "content": "hi"}]})
        self.assertFalse(blocked)
        self.assertNotIn(b"SECRET123", body)

    def test_masks_base64_blob(self):
        import base64, json
        blob = base64.b64encode(b"prefix SECRET123 suffix").decode()
        body, blocked = self._mask({"model": "m", "messages": [{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": blob}}]}]})
        self.assertFalse(blocked)
        parsed = json.loads(body)
        decoded = base64.b64decode(parsed["messages"][0]["content"][0]["source"]["data"])
        self.assertNotIn(b"SECRET123", decoded)

    def test_masks_nested_tool_result(self):
        body, blocked = self._mask({"model": "m", "messages": [{"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "t1",
             "content": [{"type": "text", "text": "out SECRET123"}]}]}]})
        self.assertFalse(blocked)
        self.assertNotIn(b"SECRET123", body)

    def test_unknown_block_type_blocks(self):
        body, blocked = self._mask({"model": "m", "messages": [{"role": "user", "content": [
            {"type": "quantum_payload", "data": "x"}]}]})
        self.assertTrue(blocked)
        self.assertIsNone(body)

    def test_unknown_toplevel_field_passes(self):
        body, blocked = self._mask({"model": "m", "future_param": {"nested": "SECRET123"},
            "messages": [{"role": "user", "content": "hi"}]})
        self.assertFalse(blocked)
        self.assertNotIn(b"SECRET123", body)

    def test_tools_type_not_block_checked(self):
        body, blocked = self._mask({"model": "m",
            "tools": [{"type": "bash_20250124", "name": "bash"}],
            "messages": [{"role": "user", "content": "hi"}]})
        self.assertFalse(blocked)

    def test_no_secret_returns_unchanged(self):
        body, blocked = self._mask({"model": "m", "messages": [{"role": "user", "content": "clean"}]})
        self.assertFalse(blocked)
        self.assertIsNone(body)

    def test_unparseable_body_blocks(self):
        body, blocked = nas_addon._schema_mask_json(b"{not json", self.patterns)
        self.assertTrue(blocked)
        self.assertIsNone(body)

    def test_empty_body_passthrough(self):
        body, blocked = nas_addon._schema_mask_json(b"", self.patterns)
        self.assertFalse(blocked)
        self.assertIsNone(body)


if __name__ == "__main__":
    unittest.main()
