"""Unit tests for the mask helpers in nas_addon.py.

Run via nas_addon_test.ts, which sets PYTHONPATH to the mitmproxy stub.
Direct invocation:
    PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py
"""

import base64
import copy
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
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

    def __init__(
        self,
        path="/",
        headers=None,
        content=b"",
        method="GET",
        host="example.com",
        port=443,
    ):
        self.path = path
        self.method = method
        self.host = host
        self.port = port
        self.pretty_url = f"https://{host}:{port}{path}"
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


class FakeClientConnection:
    def __init__(self, connection_id="client-test"):
        self.id = connection_id


class FakeResponse:
    def __init__(self, status_code, content, headers=None):
        self.status_code = status_code
        self.content = content
        self.headers = headers or {}


class FakeFlow:
    def __init__(self, request):
        self.request = request
        self.client_conn = FakeClientConnection()
        self.response = None
        self.killed = False

    def kill(self):
        self.killed = True


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


class ResolvedReviewRulesContractTest(unittest.TestCase):
    def setUp(self):
        fixture_path = (
            Path(__file__).resolve().parents[2]
            / "network"
            / "fixtures"
            / "resolved_review_rules"
            / "anthropic-v1.json"
        )
        self.fixture = json.loads(fixture_path.read_text())
        self.temp_dir = tempfile.TemporaryDirectory()
        self.rules_dir_patch = patch.object(
            nas_addon, "REVIEW_RULES_DIR", self.temp_dir.name
        )
        self.rules_dir_patch.start()
        nas_addon._review_rules_cache.clear()

    def tearDown(self):
        self.rules_dir_patch.stop()
        self.temp_dir.cleanup()
        nas_addon._review_rules_cache.clear()

    def _path(self, session_id="sess-contract"):
        return Path(self.temp_dir.name) / f"{session_id}.json"

    def _write(self, value, session_id="sess-contract"):
        path = self._path(session_id)
        path.write_text(json.dumps(value))
        return path

    def _load(self, session_id="sess-contract"):
        return nas_addon._load_review_rules(session_id)

    def assert_invalid(self, document):
        nas_addon._review_rules_cache.clear()
        self._write(document)
        loaded = self._load()
        invalid = getattr(nas_addon, "_INVALID_REVIEW_RULES", None)
        self.assertIs(loaded, invalid)

    def test_accepts_shared_anthropic_v1_fixture(self):
        self._write(self.fixture)

        self.assertEqual(self._load(), self.fixture)

    def test_rejects_non_v1_and_non_document_roots(self):
        cases = [
            ("top-level list", self.fixture["rules"]),
            ("missing version", {"rules": self.fixture["rules"]}),
            (
                "unknown version",
                {**self.fixture, "contractVersion": 2},
            ),
            (
                "boolean version",
                {**self.fixture, "contractVersion": True},
            ),
            (
                "missing rules",
                {"contractVersion": 1},
            ),
            (
                "non-list rules",
                {"contractVersion": 1, "rules": {}},
            ),
        ]
        for name, document in cases:
            with self.subTest(name=name):
                self.assert_invalid(document)

    def test_rejects_unknown_document_rule_handler_and_ast_keys(self):
        cases = []

        document = copy.deepcopy(self.fixture)
        document["unknown"] = "SECRET-document"
        cases.append(("document", document))

        document = copy.deepcopy(self.fixture)
        document["rules"][0]["unknown"] = "SECRET-rule"
        cases.append(("rule", document))

        document = copy.deepcopy(self.fixture)
        document["rules"][0]["requestPolicy"]["unknown"] = "SECRET-policy"
        cases.append(("handler", document))

        document = copy.deepcopy(self.fixture)
        document["rules"][0]["requestPolicy"]["taggedUnions"][0]["unknown"] = (
            "SECRET-tagged"
        )
        cases.append(("tagged union", document))

        document = copy.deepcopy(self.fixture)
        document["rules"][0]["requestPolicy"]["encodedFields"][0]["unknown"] = (
            "SECRET-encoded"
        )
        cases.append(("encoded field", document))

        for name, document in cases:
            with self.subTest(name=name):
                self.assert_invalid(document)

    def test_rejects_malformed_rule_ids_and_primitive_fields(self):
        cases = [
            ("empty ID", "id", ""),
            ("uppercase ID", "id", "Anthropic.rule"),
            ("bad ID character", "id", "anthropic/rule"),
            ("overlong ID", "id", "a" + ("0" * 64)),
            ("non-string ID", "id", 1),
            ("null ID", "id", None),
            ("unknown action", "action", "permit"),
            ("non-boolean audit", "audit", 1),
            ("empty method", "method", ""),
            ("non-string host", "host", 1),
            ("query-bearing exact path", "path", "/v1/messages?x=1"),
        ]
        for name, field, value in cases:
            with self.subTest(name=name):
                document = copy.deepcopy(self.fixture)
                document["rules"][0][field] = value
                self.assert_invalid(document)

    def test_rejects_unknown_kinds_and_illegal_rule_policy_combinations(self):
        cases = []

        document = copy.deepcopy(self.fixture)
        document["rules"][0]["requestPolicy"] = {"kind": "graphql"}
        cases.append(("graphql", document))

        document = copy.deepcopy(self.fixture)
        document["rules"][0]["requestPolicy"] = {"kind": "future"}
        cases.append(("unknown kind", document))

        document = copy.deepcopy(self.fixture)
        document["rules"][0]["action"] = "deny"
        cases.append(("deny policy", document))

        document = copy.deepcopy(self.fixture)
        document["rules"][0]["pathPrefix"] = "/v1"
        cases.append(("path and prefix", document))

        document = copy.deepcopy(self.fixture)
        document["rules"][2]["method"] = "POST"
        cases.append(("bodyless non-GET", document))

        document = copy.deepcopy(self.fixture)
        document["rules"][0]["method"] = "GET"
        cases.append(("json non-POST", document))

        for name, document in cases:
            with self.subTest(name=name):
                self.assert_invalid(document)

    def test_rejects_policy_rules_without_every_exact_match_field(self):
        for field in ("id", "method", "host", "path"):
            with self.subTest(field=field):
                document = copy.deepcopy(self.fixture)
                del document["rules"][0][field]
                self.assert_invalid(document)

        invalid_hosts = [
            "*.anthropic.com",
            "api.anthropic.com:443",
            " api.anthropic.com",
        ]
        for host in invalid_hosts:
            with self.subTest(host=host):
                document = copy.deepcopy(self.fixture)
                document["rules"][0]["host"] = host
                self.assert_invalid(document)

    def test_exact_policy_hosts_use_ascii_only_case_insensitive_matching(self):
        document = copy.deepcopy(self.fixture)
        document["rules"][0]["host"] = "API.Anthropic.COM"
        self._write(document)
        self.assertEqual(self._load(), document)

        non_ascii_hosts = [
            "api.K.example",
            "api.ſ.example",
            "api.İ.example",
            "api.é.example",
            "api.例.example",
        ]
        for host in non_ascii_hosts:
            with self.subTest(host=host):
                document = copy.deepcopy(self.fixture)
                document["rules"][0]["host"] = host
                self.assert_invalid(document)

    def test_rejects_invalid_json_limits_including_python_booleans(self):
        maximums = {
            "maxBodyBytes": 33_554_432,
            "maxDepth": 64,
            "maxNodes": 200_000,
            "maxDecodedBytes": 33_554_432,
        }
        for field, maximum in maximums.items():
            values = (
                True,
                False,
                0,
                -1,
                1.5,
                str(maximum),
                maximum + 1,
            )
            for value in values:
                with self.subTest(field=field, value=value):
                    document = copy.deepcopy(self.fixture)
                    document["rules"][0]["requestPolicy"][field] = value
                    self.assert_invalid(document)

    def test_rejects_malformed_json_policy_children(self):
        mutations = [
            (
                "tagged unions not list",
                lambda policy: policy.__setitem__("taggedUnions", {}),
            ),
            (
                "tagged union not object",
                lambda policy: policy.__setitem__("taggedUnions", ["bad"]),
            ),
            (
                "bad selector escape",
                lambda policy: policy["taggedUnions"][0].__setitem__(
                    "at", "/bad/~2"
                ),
            ),
            (
                "embedded selector wildcard",
                lambda policy: policy["taggedUnions"][0].__setitem__(
                    "at", "/bad/prefix*"
                ),
            ),
            (
                "empty discriminator",
                lambda policy: policy["taggedUnions"][0].__setitem__(
                    "discriminator", ""
                ),
            ),
            (
                "allowed tags not list",
                lambda policy: policy["taggedUnions"][0].__setitem__(
                    "allowedTags", "text"
                ),
            ),
            (
                "empty allowed tags",
                lambda policy: policy["taggedUnions"][0].__setitem__(
                    "allowedTags", []
                ),
            ),
            (
                "non-string allowed tag",
                lambda policy: policy["taggedUnions"][0].__setitem__(
                    "allowedTags", ["text", 1]
                ),
            ),
            (
                "encoded fields not list",
                lambda policy: policy.__setitem__("encodedFields", {}),
            ),
            (
                "encoded field not object",
                lambda policy: policy.__setitem__("encodedFields", ["bad"]),
            ),
            (
                "unknown encoding",
                lambda policy: policy["encodedFields"][0].__setitem__(
                    "encoding", "base64url"
                ),
            ),
            (
                "non-string encoded field",
                lambda policy: policy["encodedFields"][0].__setitem__(
                    "dataField", 1
                ),
            ),
        ]
        for name, mutate in mutations:
            with self.subTest(name=name):
                document = copy.deepcopy(self.fixture)
                mutate(document["rules"][0]["requestPolicy"])
                self.assert_invalid(document)

    def test_selector_grammar_accepts_producer_literal_segments(self):
        selectors = [
            "/$schema",
            "/foo|bar",
            r"/\d+",
            "/(.*)",
            "/filter[?(@.x)]",
            "/script:mask(*)",
        ]
        for selector in selectors:
            with self.subTest(selector=selector):
                nas_addon._review_rules_cache.clear()
                document = copy.deepcopy(self.fixture)
                document["rules"][0]["requestPolicy"]["taggedUnions"][0][
                    "at"
                ] = selector
                document["rules"][0]["requestPolicy"]["encodedFields"][0][
                    "at"
                ] = selector
                self._write(document)
                self.assertEqual(self._load(), document)

    def test_selector_grammar_rejects_producer_partial_wildcards_and_escapes(
        self,
    ):
        selectors = [
            "/foo*bar",
            "/foo**bar",
            "/***",
            "/prefix*",
            "/*suffix",
            "/foo~2bar",
            "/foo~",
        ]
        for selector in selectors:
            with self.subTest(selector=selector):
                document = copy.deepcopy(self.fixture)
                document["rules"][0]["requestPolicy"]["taggedUnions"][0][
                    "at"
                ] = selector
                self.assert_invalid(document)

    def test_missing_unreadable_and_malformed_files_are_silent_invalid_states(
        self,
    ):
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            missing = self._load("sess-missing")

            self._path("sess-malformed").write_text(
                '{"contractVersion": "SECRET-malformed"'
            )
            malformed = self._load("sess-malformed")

            self._write(self.fixture, "sess-unreadable")
            with patch(
                "builtins.open",
                side_effect=PermissionError("SECRET-unreadable"),
            ):
                unreadable = self._load("sess-unreadable")

        invalid = getattr(nas_addon, "_INVALID_REVIEW_RULES", None)
        self.assertIs(missing, invalid)
        self.assertIs(malformed, invalid)
        self.assertIs(unreadable, invalid)
        self.assertEqual(stderr.getvalue(), "")

    def test_unexpected_decoder_exception_is_a_silent_invalid_state(self):
        self._write(self.fixture)
        stderr = io.StringIO()

        with patch.object(
            json,
            "load",
            side_effect=RuntimeError("SECRET-decoder-detail"),
        ), redirect_stderr(stderr):
            loaded = self._load()

        self.assertIs(
            loaded,
            getattr(nas_addon, "_INVALID_REVIEW_RULES", None),
        )
        self.assertEqual(stderr.getvalue(), "")

    def test_caches_valid_and_invalid_states_until_mtime_changes(self):
        path = self._write(self.fixture)
        valid = self._load()
        with patch("builtins.open", side_effect=AssertionError("re-read")):
            self.assertIs(self._load(), valid)

        old_mtime = path.stat().st_mtime_ns
        path.write_text('{"contractVersion": 1, "rules": "invalid"}')
        os.utime(
            path,
            ns=(old_mtime + 1_000_000, old_mtime + 1_000_000),
        )
        invalid = self._load()
        self.assertIs(
            invalid,
            getattr(nas_addon, "_INVALID_REVIEW_RULES", None),
        )
        with patch("builtins.open", side_effect=AssertionError("re-read")):
            self.assertIs(self._load(), invalid)


class ReviewRuleMatchTest(unittest.TestCase):
    def test_exact_path_strips_only_the_query(self):
        rule = {
            "method": "POST",
            "host": "api.anthropic.com",
            "path": "/v1/messages",
        }
        cases = [
            ("/v1/messages", True),
            ("/v1/messages?beta=true", True),
            ("/v1/messages/", False),
            ("/v1//messages", False),
            ("/v1/%6dessages", False),
        ]
        for path, expected in cases:
            with self.subTest(path=path):
                self.assertEqual(
                    nas_addon._match_review_rule(
                        rule, "post", "API.ANTHROPIC.COM", path
                    ),
                    expected,
                )

    def test_path_prefix_method_and_host_matching_remain_segment_aware(self):
        rule = {
            "method": "GET",
            "host": "*.example.com",
            "pathPrefix": "/api/v1",
        }
        self.assertTrue(
            nas_addon._match_review_rule(
                rule, "get", "sub.example.com", "/api/v1/items?x=1"
            )
        )
        self.assertFalse(
            nas_addon._match_review_rule(
                rule, "POST", "sub.example.com", "/api/v1/items"
            )
        )
        self.assertFalse(
            nas_addon._match_review_rule(
                rule, "GET", "example.net", "/api/v1/items"
            )
        )
        self.assertFalse(
            nas_addon._match_review_rule(
                rule, "GET", "sub.example.com", "/api/v10/items"
            )
        )

    def test_trailing_dot_rule_hosts_match_exact_and_wildcard_targets(self):
        cases = [
            ("api.example.com.", "api.example.com", True),
            ("api.example.com.", "API.EXAMPLE.COM.", True),
            ("*.example.com.", "sub.example.com", True),
            ("*.example.com.", "example.com.", True),
            ("*.example.com.", "example.net", False),
        ]
        for pattern, host, expected in cases:
            with self.subTest(pattern=pattern, host=host):
                self.assertEqual(
                    nas_addon._match_review_rule(
                        {"host": pattern},
                        "GET",
                        host,
                        "/",
                    ),
                    expected,
                )


class AnthropicRoutingTest(unittest.TestCase):
    def test_is_anthropic_host(self):
        self.assertTrue(nas_addon._is_anthropic_host("api.anthropic.com"))
        self.assertTrue(nas_addon._is_anthropic_host("API.ANTHROPIC.COM"))
        self.assertFalse(nas_addon._is_anthropic_host("example.com"))
        self.assertFalse(nas_addon._is_anthropic_host("evil-anthropic.com"))

    def test_known_bodyless_get_endpoints_ignore_query(self):
        paths = [
            "/api/claude_cli/bootstrap",
            "/api/claude_code_penguin_mode",
            "/api/claude_code/policy_limits",
            "/api/claude_code/settings",
            "/mcp-registry/v0/servers",
            "/v1/code/triggers",
            "/v1/mcp_servers",
        ]
        for path in paths:
            with self.subTest(path=path):
                self.assertEqual(
                    nas_addon._classify_anthropic_endpoint(
                        "GET", f"{path}?test=value"
                    ),
                    ("bodyless-pass", path),
                )

    def test_known_schema_endpoints_ignore_query_and_method_case(self):
        cases = [
            ("POST", "/v1/messages?beta=true", "/v1/messages"),
            (
                "post",
                "/v1/messages/count_tokens?beta=true",
                "/v1/messages/count_tokens",
            ),
        ]
        for method, path, route in cases:
            with self.subTest(method=method, path=path):
                self.assertEqual(
                    nas_addon._classify_anthropic_endpoint(method, path),
                    ("schema-mask", route),
                )

    def test_unrecognized_method_and_path_combinations_block(self):
        cases = [
            (
                "POST",
                "/api/claude_code/metrics",
                "/api/claude_code/metrics",
            ),
            (
                "POST",
                "/api/event_logging/v2/batch",
                "/api/event_logging/v2/batch",
            ),
            ("POST", "/api/eval/sdk-secret", "/api/eval/:id"),
            ("POST", "/v1/files", "/v1/files"),
            ("GET", "/v1/files", "/v1/files"),
            ("GET", "/api/claude_code/settings/", "unknown"),
            ("GET", "/api/claude_code/settings/child", "unknown"),
            ("GET", "/api%2Fclaude_code%2Fsettings", "unknown"),
            ("GET", "//api/claude_code/settings", "unknown"),
            (
                "HEAD",
                "/api/claude_code/settings",
                "/api/claude_code/settings",
            ),
            ("POST", "/v1/messages/", "unknown"),
        ]
        for method, path, route in cases:
            with self.subTest(method=method, path=path):
                self.assertEqual(
                    nas_addon._classify_anthropic_endpoint(method, path),
                    ("block", route),
                )

    def test_block_reason_is_specific_only_for_files_route(self):
        self.assertEqual(
            nas_addon._block_reason_for_route("/v1/files"),
            "file-upload-blocked",
        )
        other_blocked_routes = [
            "/api/claude_code/metrics",
            "/api/event_logging/v2/batch",
            "/api/eval/:id",
            "/api/claude_code/settings",
            "unknown",
        ]
        for route in other_blocked_routes:
            with self.subTest(route=route):
                self.assertEqual(
                    nas_addon._block_reason_for_route(route),
                    "unknown-endpoint",
                )

    def test_files_descendant_blocks_with_specific_reason(self):
        endpoint_class, route = nas_addon._classify_anthropic_endpoint(
            "POST", "/v1/files/child"
        )
        self.assertEqual((endpoint_class, route), ("block", "/v1/files"))
        self.assertEqual(
            nas_addon._block_reason_for_route(route),
            "file-upload-blocked",
        )


class AnthropicOutcomeHelperTest(unittest.TestCase):
    def test_addon_starts_with_no_aggregated_block_counts(self):
        self.assertEqual(nas_addon.NasAddon()._anthropic_block_counts, {})

    def test_bodyless_request_requires_available_empty_body(self):
        self.assertEqual(
            nas_addon._plan_bodyless_anthropic_request(b""),
            ("bodyless-pass", "known-bodyless-endpoint"),
        )
        self.assertEqual(
            nas_addon._plan_bodyless_anthropic_request(b"x"),
            ("block", "unexpected-body"),
        )
        self.assertEqual(
            nas_addon._plan_bodyless_anthropic_request(None),
            ("block", "body-unavailable"),
        )

    def test_block_log_cadence_is_powers_of_two(self):
        self.assertEqual(
            [
                count
                for count in range(1, 10)
                if nas_addon._should_emit_block_log(count)
            ],
            [1, 2, 4, 8],
        )

    def test_unsupported_methods_use_only_the_closed_other_label(self):
        self.assertEqual(nas_addon._safe_anthropic_method("GET"), "GET")
        self.assertEqual(nas_addon._safe_anthropic_method("POST"), "POST")
        self.assertEqual(nas_addon._safe_anthropic_method("get"), "GET")
        self.assertEqual(nas_addon._safe_anthropic_method("post"), "POST")
        self.assertEqual(nas_addon._safe_anthropic_method("HEAD"), "OTHER")
        self.assertEqual(nas_addon._safe_anthropic_method("PUT"), "OTHER")
        self.assertEqual(
            nas_addon._safe_anthropic_method("CUSTOM-SECRET123"),
            "OTHER",
        )

    def test_outcome_report_contains_only_closed_fields(self):
        with patch.object(
            nas_addon,
            "_query_broker",
            return_value={
                "version": 1,
                "type": "egress_outcome_recorded",
                "requestId": "req-safe",
            },
        ) as query:
            nas_addon._report_egress_outcome(
                "/safe/broker.sock",
                "req-safe",
                "sess-safe",
                "POST",
                "/v1/files",
                "block",
                "file-upload-blocked",
            )

        query.assert_called_once_with(
            "/safe/broker.sock",
            {
                "version": 1,
                "type": "egress_outcome",
                "requestId": "req-safe",
                "sessionId": "sess-safe",
                "method": "POST",
                "route": "/v1/files",
                "action": "block",
                "reason": "file-upload-blocked",
            },
        )

    def test_outcome_report_failure_emits_only_constant_error(self):
        stderr = io.StringIO()
        with patch.object(
            nas_addon,
            "_query_broker",
            side_effect=RuntimeError("SECRET123 /raw/private-path"),
        ), redirect_stderr(stderr):
            nas_addon._report_egress_outcome(
                "/safe/broker.sock",
                "req-safe",
                "sess-safe",
                "GET",
                "unknown",
                "block",
                "unknown-endpoint",
            )

        self.assertEqual(
            stderr.getvalue(),
            "[nas-addon] egress outcome audit unavailable\n",
        )

    def test_outcome_report_non_ack_emits_only_constant_error(self):
        stderr = io.StringIO()
        with patch.object(
            nas_addon,
            "_query_broker",
            return_value={
                "decision": "deny",
                "reason": "broker-unavailable: SECRET123 /raw/private-path",
            },
        ), redirect_stderr(stderr):
            nas_addon._report_egress_outcome(
                "/safe/broker.sock",
                "req-safe",
                "sess-safe",
                "GET",
                "unknown",
                "block",
                "unknown-endpoint",
            )

        self.assertEqual(
            stderr.getvalue(),
            "[nas-addon] egress outcome audit unavailable\n",
        )


class SchemaMaskTest(unittest.TestCase):
    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["SECRET123"])

    def _mask(self, obj):
        import json
        return nas_addon._schema_mask_json(json.dumps(obj).encode("utf-8"), self.patterns)

    def test_masks_text_block(self):
        body, reason = self._mask({"model": "m", "messages": [
            {"role": "user", "content": [{"type": "text", "text": "key is SECRET123 ok"}]}]})
        self.assertIsNone(reason)
        self.assertIn(b"****", body)
        self.assertNotIn(b"SECRET123", body)

    def test_masks_system_string(self):
        body, reason = self._mask({"model": "m", "system": "token SECRET123",
            "messages": [{"role": "user", "content": "hi"}]})
        self.assertIsNone(reason)
        self.assertNotIn(b"SECRET123", body)

    def test_masks_base64_blob(self):
        import base64, json
        blob = base64.b64encode(b"prefix SECRET123 suffix").decode()
        body, reason = self._mask({"model": "m", "messages": [{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": blob}}]}]})
        self.assertIsNone(reason)
        parsed = json.loads(body)
        decoded = base64.b64decode(parsed["messages"][0]["content"][0]["source"]["data"])
        self.assertNotIn(b"SECRET123", decoded)

    def test_masks_nested_tool_result(self):
        body, reason = self._mask({"model": "m", "messages": [{"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "t1",
             "content": [{"type": "text", "text": "out SECRET123"}]}]}]})
        self.assertIsNone(reason)
        self.assertNotIn(b"SECRET123", body)

    def test_unknown_block_type_blocks(self):
        body, reason = self._mask({"model": "m", "messages": [{"role": "user", "content": [
            {"type": "quantum_payload", "data": "x"}]}]})
        self.assertEqual(reason, "schema-unknown")
        self.assertIsNone(body)

    def test_unknown_toplevel_field_passes(self):
        body, reason = self._mask({"model": "m", "future_param": {"nested": "SECRET123"},
            "messages": [{"role": "user", "content": "hi"}]})
        self.assertIsNone(reason)
        self.assertNotIn(b"SECRET123", body)

    def test_tools_type_not_block_checked(self):
        body, reason = self._mask({"model": "m",
            "tools": [{"type": "bash_20250124", "name": "bash"}],
            "messages": [{"role": "user", "content": "hi"}]})
        self.assertIsNone(reason)

    def test_no_secret_returns_unchanged(self):
        body, reason = self._mask({"model": "m", "messages": [{"role": "user", "content": "clean"}]})
        self.assertIsNone(reason)
        self.assertIsNone(body)

    def test_unparseable_body_blocks(self):
        body, reason = nas_addon._schema_mask_json(b"{not json", self.patterns)
        self.assertEqual(reason, "decode-failed")
        self.assertIsNone(body)

    def test_empty_body_is_decode_failure(self):
        body, reason = nas_addon._schema_mask_json(b"", self.patterns)
        self.assertEqual(reason, "decode-failed")
        self.assertIsNone(body)

    def test_lone_surrogate_encode_failure_fails_closed(self):
        # ensure_ascii=True (json.dumps のデフォルト) は lone surrogate を
        # "\ud800" として安全にエスケープするため、この body 構築自体は
        # 例外を起こさない。json.loads で lone surrogate 文字列に復元された
        # 後、SECRET123 のマスク発火で changed=True の経路に入り、最終の
        # json.dumps(..., ensure_ascii=False).encode("utf-8") が strict
        # UTF-8 エンコードで UnicodeEncodeError を送出する状況を再現する。
        body, reason = self._mask({
            "model": "m",
            "system": "\ud800",
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": "key is SECRET123 ok"}]}],
        })
        self.assertEqual(reason, "decode-failed")
        self.assertIsNone(body)

    def test_deeply_nested_body_fails_closed(self):
        # json.loads は深いネストで RecursionError を送出する。
        # RecursionError は ValueError の派生ではないため、
        # except (json.JSONDecodeError, ValueError) では捕捉されず
        # 関数がクラッシュ(fail-open)していた。あらゆる例外を
        # fail-closed に倒すことを検証する。
        deep = ("[" * 40000 + "]" * 40000).encode("utf-8")
        body, reason = nas_addon._schema_mask_json(deep, self.patterns)
        self.assertEqual(reason, "decode-failed")
        self.assertIsNone(body)

    def test_masks_secret_appearing_as_object_key(self):
        # A secret can appear as a JSON object KEY (not just a value), e.g.
        # inside a metadata dict. The legacy byte-level masking path masks
        # whole request bytes so this is covered there; the schema-walking
        # path must mask dict keys too, not just string values.
        body = self._mask_raw(
            b'{"model":"m","metadata":{"SECRET123":"v"},'
            b'"messages":[{"role":"user","content":"hi"}]}'
        )
        masked, reason = body
        self.assertIsNone(reason)
        self.assertIsNotNone(masked)
        self.assertIn(b"****", masked)
        self.assertNotIn(b"SECRET123", masked)

    def _mask_raw(self, raw_body: bytes):
        return nas_addon._schema_mask_json(raw_body, self.patterns)


class AnthropicPlanTest(unittest.TestCase):
    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["SECRET123"])

    def test_schema_planner_does_not_repeat_endpoint_routing(self):
        result = nas_addon._plan_anthropic_masking(
            b"{}", self.patterns
        )
        self.assertEqual(result, ("passthrough", None, "recognized-schema"))

    def test_undecodable_body_blocks(self):
        result = nas_addon._plan_anthropic_masking(None, self.patterns)
        self.assertEqual(result, ("block", None, "body-unavailable"))

    def test_secret_rewrites(self):
        import json
        body = json.dumps({"model": "m", "messages": [{"role": "user", "content": "SECRET123"}]}).encode()
        action, out, reason = nas_addon._plan_anthropic_masking(body, self.patterns)
        self.assertEqual((action, reason), ("rewrite", "recognized-schema"))
        self.assertNotIn(b"SECRET123", out)

    def test_clean_passthrough(self):
        import json
        body = json.dumps({"model": "m", "messages": [{"role": "user", "content": "clean"}]}).encode()
        result = nas_addon._plan_anthropic_masking(body, self.patterns)
        self.assertEqual(
            result,
            ("passthrough", None, "recognized-schema"),
        )

    def test_unknown_block_blocks(self):
        import json
        body = json.dumps({"model": "m", "messages": [
            {"role": "user", "content": [{"type": "quantum", "x": 1}]}]}).encode()
        result = nas_addon._plan_anthropic_masking(body, self.patterns)
        self.assertEqual(result, ("block", None, "schema-unknown"))

    def test_decode_failure_blocks_with_precise_reason(self):
        result = nas_addon._plan_anthropic_masking(
            b"{not json", self.patterns
        )
        self.assertEqual(result, ("block", None, "decode-failed"))

    def test_empty_body_blocks_with_decode_failure(self):
        result = nas_addon._plan_anthropic_masking(b"", self.patterns)
        self.assertEqual(result, ("block", None, "decode-failed"))

    def test_duplicate_json_members_fail_closed(self):
        body = b'{"prompt":"s3cret-value","prompt":"safe"}'

        result = nas_addon._plan_anthropic_masking(body, self.patterns)

        self.assertEqual(result, ("block", None, "decode-failed"))


def _make_stub_flow(path="/", headers=None, content=b""):
    """Minimal stub flow builder matching the FakeFlow/FakeRequest/FakeHeaders
    shapes used by ApplyRequestMaskingTest above."""
    return FakeFlow(FakeRequest(path=path, headers=headers, content=content))


class GateAndUrlHeaderTest(unittest.TestCase):
    def test_registry_gate(self):
        self.assertTrue(nas_addon._registry_anthropic_egress({"anthropicEgress": True}))
        self.assertFalse(nas_addon._registry_anthropic_egress({"anthropicEgress": False}))
        self.assertFalse(nas_addon._registry_anthropic_egress({}))
        self.assertFalse(nas_addon._registry_anthropic_egress(None))

    def test_mask_url_and_headers_not_body(self):
        patterns = nas_addon._build_mask_patterns(["SECRET123"])
        flow = _make_stub_flow(
            path="/v1/messages?k=SECRET123",
            headers={"x-custom": "SECRET123"},
            content=b'{"body":"SECRET123"}')
        nas_addon._mask_url_and_headers(flow, patterns)
        self.assertNotIn("SECRET123", flow.request.path)
        self.assertNotIn("SECRET123", flow.request.headers["x-custom"])
        self.assertIn(b"SECRET123", flow.request.content)  # body は触らない


_DEFAULT_REVIEW_RULES = object()


class AnthropicRequestFlowTest(unittest.TestCase):
    def setUp(self):
        self.session_id = "sess-test"
        self.token = "token-test"
        self.proxy_auth = "Basic " + base64.b64encode(
            f"{self.session_id}:{self.token}".encode()
        ).decode()
        self.registry = {
            "tokenHash": nas_addon._hash_token(self.token),
            "anthropicEgress": True,
        }

    def _run_request(
        self,
        *,
        method="GET",
        path="/api/claude_code/settings",
        content=b"",
        headers=None,
        host="api.anthropic.com",
        addon=None,
        outcome_failure=False,
        on_outcome=None,
        request_class=FakeRequest,
        review_rules=_DEFAULT_REVIEW_RULES,
        client_id="client-test",
    ):
        request_headers = list(headers or [])
        request_headers.append(("proxy-authorization", self.proxy_auth))
        flow = FakeFlow(request_class(
            path=path,
            headers=request_headers,
            content=content,
            method=method,
            host=host,
        ))
        flow.client_conn.id = client_id
        addon = addon or nas_addon.NasAddon()
        messages = []

        def query_broker(_socket_path, request):
            messages.append(json.loads(json.dumps(request)))
            if request["type"] == "authorize":
                return {
                    "decision": "allow",
                    "requestId": request["requestId"],
                    "reason": "review-rule",
                    "maskValues": ["SECRET123"],
                    "injectHeaders": [
                        {"name": "x-api-key", "value": "injected-value"}
                    ],
                }
            if on_outcome is not None:
                on_outcome(flow)
            if outcome_failure:
                raise RuntimeError("SECRET123 /raw/private-path")
            return {
                "version": 1,
                "type": "egress_outcome_recorded",
                "requestId": request["requestId"],
            }

        if review_rules is _DEFAULT_REVIEW_RULES:
            loaded_review_rules = {"contractVersion": 1, "rules": []}
        elif isinstance(review_rules, list):
            loaded_review_rules = {
                "contractVersion": 1,
                "rules": review_rules,
            }
        else:
            loaded_review_rules = review_rules

        stderr = io.StringIO()
        with patch.object(
            nas_addon, "_load_registry", return_value=self.registry
        ), patch.object(
            nas_addon,
            "_load_review_rules",
            return_value=loaded_review_rules,
        ), patch.object(
            nas_addon, "_generate_request_id", return_value="req-test"
        ), patch.object(
            nas_addon, "_query_broker", side_effect=query_broker
        ), patch.object(
            nas_addon.http.Response,
            "make",
            side_effect=lambda status, body=b"", response_headers=None: (
                FakeResponse(status, body, response_headers)
            ),
        ), redirect_stderr(stderr):
            addon.request(flow)

        return flow, messages, stderr.getvalue()

    def _outcomes(self, messages):
        return [m for m in messages if m["type"] == "egress_outcome"]

    def _run_connect(self, addon, client_id, *, authenticated):
        headers = {"proxy-authorization": self.proxy_auth} if authenticated else {}
        flow = FakeFlow(FakeRequest(
            headers=headers,
            host="api.anthropic.com",
        ))
        flow.client_conn.id = client_id
        stderr = io.StringIO()
        with patch.object(
            nas_addon, "_verify_creds", return_value=(
                self.registry if authenticated else None
            )
        ), patch.object(
            nas_addon.http.Response,
            "make",
            side_effect=lambda status, body=b"", response_headers=None: (
                FakeResponse(status, body, response_headers)
            ),
        ), redirect_stderr(stderr):
            addon.http_connect(flow)
        return flow

    def test_missing_credentials_log_uses_only_sanitized_request_fields(self):
        flow = FakeFlow(FakeRequest(
            path="/private/SECRET123?filename=SECRET123.txt",
            method="CUSTOM-SECRET123",
            host="api.anthropic.com",
        ))
        stderr = io.StringIO()

        with patch.object(
            nas_addon.http.Response,
            "make",
            side_effect=lambda status, body=b"", response_headers=None: (
                FakeResponse(status, body, response_headers)
            ),
        ), redirect_stderr(stderr):
            nas_addon.NasAddon().request(flow)

        self.assertEqual(flow.response.status_code, 407)
        self.assertNotIn("SECRET123", stderr.getvalue())
        self.assertIn("method=OTHER route=unknown", stderr.getvalue())

    def test_invalid_contract_blocks_before_broker_or_credential_injection(self):
        flow, messages, stderr = self._run_request(review_rules=None)

        self.assertEqual(flow.response.status_code, 403)
        self.assertEqual(flow.response.content, b"blocked: request policy")
        self.assertNotIn("x-api-key", flow.request.headers)
        self.assertEqual(messages, [])
        self.assertEqual(
            stderr,
            "[nas-addon] REQUEST-POLICY-CONTRACT-INVALID: "
            "session=sess-test\n",
        )

    def test_invalid_contract_log_sanitizes_untrusted_session_identifier(self):
        self.session_id = "sess-test\nSECRET-session"
        self.proxy_auth = "Basic " + base64.b64encode(
            f"{self.session_id}:{self.token}".encode()
        ).decode()

        flow, messages, stderr = self._run_request(review_rules=None)

        self.assertEqual(flow.response.status_code, 403)
        self.assertEqual(messages, [])
        self.assertEqual(
            stderr,
            "[nas-addon] REQUEST-POLICY-CONTRACT-INVALID: "
            "session=invalid\n",
        )
        self.assertNotIn("SECRET-session", stderr)

    def test_trailing_dot_policy_host_pre_match_includes_body_preview(self):
        body = b'{"messages":[]}'
        rule = {
            "id": "anthropic.messages.create",
            "method": "POST",
            "host": "api.anthropic.com.",
            "path": "/v1/messages",
            "action": "allow",
            "audit": True,
        }

        _flow, messages, _stderr = self._run_request(
            method="POST",
            path="/v1/messages",
            content=body,
            review_rules=[rule],
        )

        authorization = next(
            message
            for message in messages
            if message["type"] == "authorize"
        )
        self.assertEqual(
            authorization["reviewContext"],
            {
                "path": "/v1/messages",
                "contentType": None,
                "bodyPreview": body.decode(),
                "bodySize": len(body),
            },
        )

    def test_bodyless_known_get_allows_and_reports_once(self):
        flow, messages, _stderr = self._run_request()

        self.assertIsNone(flow.response)
        self.assertEqual(flow.request.headers["x-api-key"], "injected-value")
        outcomes = self._outcomes(messages)
        self.assertEqual(len(outcomes), 1)
        self.assertEqual(
            (outcomes[0]["method"], outcomes[0]["route"],
             outcomes[0]["action"], outcomes[0]["reason"]),
            (
                "GET",
                "/api/claude_code/settings",
                "bodyless-pass",
                "known-bodyless-endpoint",
            ),
        )

    def test_nonempty_known_get_blocks_with_fixed_response(self):
        flow, messages, _stderr = self._run_request(content=b"x")

        self.assertEqual(flow.response.status_code, 403)
        self.assertEqual(
            flow.response.content,
            b"blocked: Anthropic egress policy",
        )
        self.assertNotIn("x-api-key", flow.request.headers)
        outcomes = self._outcomes(messages)
        self.assertEqual(len(outcomes), 1)
        self.assertEqual(outcomes[0]["action"], "block")
        self.assertEqual(outcomes[0]["reason"], "unexpected-body")

    def test_unavailable_body_blocks_with_precise_outcome(self):
        flow, messages, _stderr = self._run_request(
            request_class=FakeUndecodableRequest
        )

        self.assertEqual(flow.response.status_code, 403)
        outcomes = self._outcomes(messages)
        self.assertEqual(len(outcomes), 1)
        self.assertEqual(
            (outcomes[0]["action"], outcomes[0]["reason"]),
            ("block", "body-unavailable"),
        )

    def test_matching_allow_rule_with_unavailable_body_blocks_once(self):
        flow, messages, _stderr = self._run_request(
            request_class=FakeUndecodableRequest,
            review_rules=[{
                "method": "GET",
                "host": "api.anthropic.com",
                "pathPrefix": "/api/claude_code/settings",
                "action": "allow",
            }],
        )

        self.assertEqual(flow.response.status_code, 403)
        self.assertEqual(
            flow.response.content,
            b"blocked: Anthropic egress policy",
        )
        outcomes = self._outcomes(messages)
        self.assertEqual(len(outcomes), 1)
        self.assertEqual(
            (outcomes[0]["action"], outcomes[0]["reason"]),
            ("block", "body-unavailable"),
        )

    def test_telemetry_and_files_block_with_sanitized_routes(self):
        cases = [
            (
                "/api/claude_code/metrics?value=SECRET123",
                "/api/claude_code/metrics",
                "unknown-endpoint",
            ),
            (
                "/v1/files/private-SECRET123-name",
                "/v1/files",
                "file-upload-blocked",
            ),
        ]
        for path, route, reason in cases:
            with self.subTest(path=path):
                flow, messages, stderr = self._run_request(
                    method="POST", path=path, content=b"SECRET123"
                )
                self.assertEqual(flow.response.status_code, 403)
                self.assertEqual(
                    flow.response.content,
                    b"blocked: Anthropic egress policy",
                )
                outcome = self._outcomes(messages)[0]
                self.assertEqual((outcome["route"], outcome["reason"]),
                                 (route, reason))
                self.assertNotIn("SECRET123", json.dumps(outcome))
                self.assertNotIn("SECRET123", stderr)

    def test_query_and_header_are_masked_before_logging_or_injection(self):
        observed_headers_at_outcome = []

        def observe(flow):
            observed_headers_at_outcome.append(
                "x-api-key" in flow.request.headers
            )

        flow, messages, stderr = self._run_request(
            path="/api/claude_code/settings?token=SECRET123",
            headers=[("x-note", "value=SECRET123")],
            on_outcome=observe,
        )

        self.assertEqual(
            flow.request.path,
            "/api/claude_code/settings?token=****",
        )
        self.assertEqual(flow.request.headers["x-note"], "value=****")
        self.assertNotIn("SECRET123", stderr)
        self.assertNotIn("SECRET123", json.dumps(self._outcomes(messages)))
        self.assertEqual(observed_headers_at_outcome, [False])
        self.assertEqual(flow.request.headers["x-api-key"], "injected-value")

    def test_unrecognized_query_value_never_enters_anthropic_logs(self):
        raw_query_value = "PRIVATE-NOT-A-MASK-VALUE"
        flow, messages, stderr = self._run_request(
            path=(
                "/api/claude_code/settings?filename="
                f"{raw_query_value}.txt"
            ),
        )

        self.assertIsNone(flow.response)
        self.assertIn(raw_query_value, flow.request.path)
        self.assertNotIn(raw_query_value, stderr)
        self.assertNotIn(raw_query_value, json.dumps(self._outcomes(messages)))

    def test_unknown_path_data_never_enters_stderr_or_outcome(self):
        flow, messages, stderr = self._run_request(
            method="POST",
            path="/private/SECRET123?filename=SECRET123.txt",
            headers=[("x-private", "SECRET123")],
            content=b"SECRET123",
        )

        self.assertEqual(flow.response.status_code, 403)
        outcome = self._outcomes(messages)[0]
        self.assertEqual(outcome["route"], "unknown")
        self.assertEqual(outcome["reason"], "unknown-endpoint")
        self.assertNotIn("SECRET123", json.dumps(outcome))
        self.assertNotIn("SECRET123", stderr)

    def test_schema_rewrite_masks_body_and_reports_schema_mask(self):
        body = json.dumps({
            "model": "m",
            "messages": [
                {"role": "user", "content": "token SECRET123"}
            ],
        }).encode()
        flow, messages, _stderr = self._run_request(
            method="POST", path="/v1/messages", content=body
        )

        self.assertIsNone(flow.response)
        self.assertNotIn(b"SECRET123", flow.request.content)
        self.assertIn(b"****", flow.request.content)
        outcome = self._outcomes(messages)[0]
        self.assertEqual(
            (outcome["action"], outcome["reason"]),
            ("schema-mask", "recognized-schema"),
        )

    def test_empty_schema_body_blocks_as_decode_failure(self):
        flow, messages, _stderr = self._run_request(
            method="POST", path="/v1/messages", content=b""
        )

        self.assertEqual(flow.response.status_code, 403)
        self.assertEqual(
            flow.response.content,
            b"blocked: Anthropic egress policy",
        )
        outcomes = self._outcomes(messages)
        self.assertEqual(len(outcomes), 1)
        self.assertEqual(
            (outcomes[0]["action"], outcomes[0]["reason"]),
            ("block", "decode-failed"),
        )

    def test_unknown_schema_block_reports_precise_reason(self):
        body = json.dumps({
            "messages": [{
                "role": "user",
                "content": [{"type": "future-block"}],
            }],
        }).encode()
        flow, messages, _stderr = self._run_request(
            method="POST", path="/v1/messages", content=body
        )

        self.assertEqual(flow.response.status_code, 403)
        outcomes = self._outcomes(messages)
        self.assertEqual(len(outcomes), 1)
        self.assertEqual(
            (outcomes[0]["action"], outcomes[0]["reason"]),
            ("block", "schema-unknown"),
        )

    def test_unsupported_methods_block_and_report_only_other(self):
        for method in ("HEAD", "PUT"):
            with self.subTest(method=method):
                flow, messages, stderr = self._run_request(method=method)
                self.assertEqual(flow.response.status_code, 403)
                outcomes = self._outcomes(messages)
                self.assertEqual(len(outcomes), 1)
                outcome = outcomes[0]
                self.assertEqual(outcome["method"], "OTHER")
                self.assertEqual(outcome["action"], "block")
                self.assertNotIn(method, json.dumps(outcome))
                self.assertNotIn(method, stderr)

    def test_outcome_failure_does_not_change_allow_or_block(self):
        allowed, allowed_messages, allowed_stderr = self._run_request(
            outcome_failure=True
        )
        blocked, blocked_messages, blocked_stderr = self._run_request(
            method="POST",
            path="/api/event_logging/v2/batch",
            outcome_failure=True,
        )

        self.assertIsNone(allowed.response)
        self.assertEqual(blocked.response.status_code, 403)
        self.assertEqual(len(self._outcomes(allowed_messages)), 1)
        self.assertEqual(len(self._outcomes(blocked_messages)), 1)
        self.assertIn(
            "[nas-addon] egress outcome audit unavailable",
            allowed_stderr,
        )
        self.assertIn(
            "[nas-addon] egress outcome audit unavailable",
            blocked_stderr,
        )
        self.assertNotIn("SECRET123", allowed_stderr + blocked_stderr)

    def test_repeated_blocks_log_only_at_power_of_two_counts(self):
        addon = nas_addon.NasAddon()
        stderr = ""
        outcome_count = 0
        for _ in range(9):
            _flow, messages, request_stderr = self._run_request(
                method="POST",
                path="/api/claude_code/metrics",
                addon=addon,
            )
            stderr += request_stderr
            outcome_count += len(self._outcomes(messages))

        block_lines = [
            line for line in stderr.splitlines()
            if line.startswith("[nas-addon] ANTHROPIC-BLOCKED:")
        ]
        self.assertEqual(outcome_count, 9)
        self.assertEqual(
            block_lines,
            [
                "[nas-addon] ANTHROPIC-BLOCKED: method=POST "
                "route=/api/claude_code/metrics action=block "
                f"reason=unknown-endpoint count={count}"
                for count in (1, 2, 4, 8)
            ],
        )

    def test_client_disconnect_prunes_only_its_session_block_counts(self):
        addon = nas_addon.NasAddon()
        self._run_request(
            method="POST",
            path="/api/claude_code/metrics",
            addon=addon,
            client_id="client-one",
        )
        unrelated_key = (
            "sess-unrelated",
            "POST",
            "/v1/files",
            "block",
            "file-upload-blocked",
        )
        addon._anthropic_block_counts[unrelated_key] = 7

        addon.client_disconnected(FakeClientConnection("client-one"))

        self.assertEqual(addon._anthropic_block_counts, {unrelated_key: 7})

    def test_shared_session_counts_remain_until_last_client_disconnects(self):
        addon = nas_addon.NasAddon()
        for client_id in ("client-one", "client-two"):
            self._run_request(
                method="POST",
                path="/api/claude_code/metrics",
                addon=addon,
                client_id=client_id,
            )
        self.assertEqual(len(addon._anthropic_block_counts), 1)

        addon.client_disconnected(FakeClientConnection("client-one"))
        self.assertEqual(len(addon._anthropic_block_counts), 1)

        addon.client_disconnected(FakeClientConnection("client-two"))
        self.assertEqual(addon._anthropic_block_counts, {})

    def test_authenticated_connect_keeps_session_active_before_inner_request(self):
        addon = nas_addon.NasAddon()
        self._run_request(
            method="POST",
            path="/api/claude_code/metrics",
            addon=addon,
            client_id="request-client",
        )
        connect_flow = self._run_connect(
            addon,
            "connect-client",
            authenticated=True,
        )
        self.assertIsNone(connect_flow.response)

        addon.client_disconnected(FakeClientConnection("request-client"))
        self.assertEqual(len(addon._anthropic_block_counts), 1)

        addon.client_disconnected(FakeClientConnection("connect-client"))
        self.assertEqual(addon._anthropic_block_counts, {})

    def test_failed_connect_does_not_keep_session_block_counts(self):
        addon = nas_addon.NasAddon()
        self._run_request(
            method="POST",
            path="/api/claude_code/metrics",
            addon=addon,
            client_id="request-client",
        )
        connect_flow = self._run_connect(
            addon,
            "failed-connect-client",
            authenticated=False,
        )
        self.assertEqual(connect_flow.response.status_code, 407)

        addon.client_disconnected(FakeClientConnection("request-client"))
        self.assertEqual(addon._anthropic_block_counts, {})

    def test_non_anthropic_request_keeps_generic_masking_without_outcome(self):
        flow, messages, _stderr = self._run_request(
            host="example.com",
            method="POST",
            path="/submit",
            content=b"value=SECRET123",
        )

        self.assertIsNone(flow.response)
        self.assertEqual(flow.request.content, b"value=****")
        self.assertEqual(self._outcomes(messages), [])


if __name__ == "__main__":
    unittest.main()
