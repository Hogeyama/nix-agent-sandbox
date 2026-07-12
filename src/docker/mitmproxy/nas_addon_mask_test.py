"""Unit tests for the mask helpers in nas_addon.py.

Run via nas_addon_test.ts, which sets PYTHONPATH to the mitmproxy stub.
Direct invocation:
    PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py
"""

import base64
import unittest

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


if __name__ == "__main__":
    unittest.main()
