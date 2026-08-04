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
            # `*` を含むセグメントは _parse_selector がリテラル扱いするため、
            # 通すと guard が 0 ノードにマッチして何も検査しなくなる
            # (fail-closed の制御が fail-open に転ぶ)。文字種によらず弾く。
            (
                "selector wildcard after punctuation",
                lambda policy: policy["taggedUnions"][0].__setitem__(
                    "at", "/messages/*/content:*"
                ),
            ),
            (
                "selector wildcard after whitespace",
                lambda policy: policy["taggedUnions"][0].__setitem__(
                    "at", "/messages/*/con tent*"
                ),
            ),
            (
                "selector wildcard with non-ASCII",
                lambda policy: policy["taggedUnions"][0].__setitem__(
                    "at", "/messages/\u5185\u5bb9*"
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
        """式に見えるテキストはリテラルとして受け入れる (injection しない)。
        ただし `*` を含むものは別扱いで、下の rejects テストが押さえる。"""
        selectors = [
            "/$schema",
            "/foo|bar",
            r"/\d+",
            "/filter[?(@.x)]",
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

    def test_rejects_empty_matcher_fields(self):
        """空文字は TS 側 (validateRule) も弾く。片方だけが通すと、
        ドキュメント全体が無効になってセッション中の全リクエストが 403 に
        なるので、両者の条件を一致させておく。"""
        for field in ("method", "host", "path", "pathPrefix"):
            with self.subTest(field=field):
                document = copy.deepcopy(self.fixture)
                rule = document["rules"][0]
                rule.pop("path", None)
                rule.pop("pathPrefix", None)
                rule.pop("requestPolicy", None)
                rule[field] = ""
                self.assert_invalid(document)

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
            # `*` を含む式に見えるテキストは、リテラル扱いすると guard が
            # 0 ノードにマッチして何も検査しなくなる。受け入れてはならない。
            "/(.*)",
            "/script:mask(*)",
            "/messages/*/content:*",
            "/messages/\u5185\u5bb9*",
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


class RequestPolicyOutcomeReportTest(unittest.TestCase):
    def test_addon_starts_with_no_aggregated_block_counts(self):
        self.assertEqual(nas_addon.NasAddon()._request_policy_block_counts, {})

    def test_block_log_cadence_is_powers_of_two(self):
        self.assertEqual(
            [
                count
                for count in range(1, 10)
                if nas_addon._should_emit_block_log(count)
            ],
            [1, 2, 4, 8],
        )

    def test_method_label_is_a_closed_set(self):
        for method in ("GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"):
            with self.subTest(method=method):
                self.assertEqual(
                    nas_addon._safe_method_label(method.lower()), method
                )
        for method in ("CUSTOM-SECRET123", "", "GET /private", "gEt\n"):
            with self.subTest(method=method):
                self.assertEqual(nas_addon._safe_method_label(method), "OTHER")

    def test_outcome_report_contains_only_closed_fields(self):
        with patch.object(
            nas_addon,
            "_query_broker",
            return_value={
                "version": 1,
                "type": "request_policy_outcome_recorded",
                "requestId": "req-safe",
            },
        ) as query:
            nas_addon._report_request_policy_outcome(
                "/safe/broker.sock",
                "req-safe",
                "sess-safe",
                "anthropic.messages.create",
                "block",
                "schema-mismatch",
            )

        query.assert_called_once_with(
            "/safe/broker.sock",
            {
                "version": 1,
                "type": "request_policy_outcome",
                "requestId": "req-safe",
                "sessionId": "sess-safe",
                "ruleId": "anthropic.messages.create",
                "result": "block",
                "reason": "schema-mismatch",
            },
        )

    def test_outcome_report_failure_emits_only_constant_error(self):
        stderr = io.StringIO()
        with patch.object(
            nas_addon,
            "_query_broker",
            side_effect=RuntimeError("SECRET123 /raw/private-path"),
        ), redirect_stderr(stderr):
            nas_addon._report_request_policy_outcome(
                "/safe/broker.sock",
                "req-safe",
                "sess-safe",
                "anthropic.bodyless.settings",
                "block",
                "unexpected-body",
            )

        self.assertEqual(
            stderr.getvalue(),
            "[nas-addon] request policy outcome audit unavailable\n",
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
            nas_addon._report_request_policy_outcome(
                "/safe/broker.sock",
                "req-safe",
                "sess-safe",
                "anthropic.bodyless.settings",
                "pass",
                "empty-body",
            )

        self.assertEqual(
            stderr.getvalue(),
            "[nas-addon] request policy outcome audit unavailable\n",
        )


def _make_stub_flow(path="/", headers=None, content=b""):
    """Minimal stub flow builder matching the FakeFlow/FakeRequest/FakeHeaders
    shapes used by ApplyRequestMaskingTest above."""
    return FakeFlow(FakeRequest(path=path, headers=headers, content=content))


class MaskUrlAndHeadersTest(unittest.TestCase):
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


_DEFAULT_JSON_LIMITS = {
    "maxBodyBytes": 33_554_432,
    "maxDepth": 64,
    "maxNodes": 200_000,
    "maxDecodedBytes": 33_554_432,
}


def _json_policy(**overrides):
    policy = {
        "kind": "json",
        **_DEFAULT_JSON_LIMITS,
        "taggedUnions": [],
        "encodedFields": [],
    }
    policy.update(overrides)
    return policy


class RequestPolicyBodylessEngineTest(unittest.TestCase):
    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["SECRET123"])

    def _run(self, body):
        return nas_addon._execute_request_policy(
            {"kind": "bodyless"}, body, self.patterns
        )

    def test_empty_body_passes(self):
        self.assertEqual(self._run(b""), ("pass", None, "empty-body"))

    def test_non_empty_body_blocks_as_unexpected(self):
        self.assertEqual(self._run(b"x"), ("block", None, "unexpected-body"))

    def test_unavailable_body_blocks(self):
        self.assertEqual(self._run(None), ("block", None, "body-unavailable"))


class RequestPolicyJsonParseTest(unittest.TestCase):
    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["SECRET123"])

    def _run(self, body, **overrides):
        return nas_addon._execute_request_policy(
            _json_policy(**overrides), body, self.patterns
        )

    def test_unavailable_body_blocks(self):
        self.assertEqual(self._run(None), ("block", None, "body-unavailable"))

    def test_empty_body_is_invalid_json(self):
        self.assertEqual(self._run(b""), ("block", None, "invalid-json"))

    def test_malformed_body_is_invalid_json(self):
        self.assertEqual(
            self._run(b"{not json"), ("block", None, "invalid-json")
        )

    def test_duplicate_members_are_invalid_json(self):
        self.assertEqual(
            self._run(b'{"a":1,"a":2}'), ("block", None, "invalid-json")
        )

    def test_scalar_root_is_schema_mismatch(self):
        self.assertEqual(
            self._run(b'"hello"'), ("block", None, "schema-mismatch")
        )

    def test_array_root_is_schema_mismatch(self):
        self.assertEqual(self._run(b"[]"), ("block", None, "schema-mismatch"))

    def test_unchanged_object_passes(self):
        self.assertEqual(
            self._run(b'{"a":"clean","b":1}'),
            ("pass", None, "recognized-json"),
        )

    def test_changed_object_is_masked(self):
        result, out, reason = self._run(b'{"a":"SECRET123"}')
        self.assertEqual((result, reason), ("rewrite", "masked-json"))
        self.assertIsNotNone(out)
        self.assertNotIn(b"SECRET123", out)
        self.assertEqual(json.loads(out), {"a": "****"})

    def test_object_keys_are_masked(self):
        result, out, reason = self._run(b'{"SECRET123":"v"}')
        self.assertEqual((result, reason), ("rewrite", "masked-json"))
        self.assertNotIn(b"SECRET123", out)
        self.assertEqual(json.loads(out), {"****": "v"})

    def test_nested_values_are_masked(self):
        result, out, _reason = self._run(
            b'{"a":{"b":["x","SECRET123"]}}'
        )
        self.assertEqual(result, "rewrite")
        self.assertEqual(json.loads(out), {"a": {"b": ["x", "****"]}})

    def test_serialization_is_compact_and_deterministic(self):
        _r, out, _reason = self._run(b'{"a": "SECRET123", "b": 1}')
        self.assertEqual(out, b'{"a":"****","b":1}')

    def test_non_standard_constants_are_invalid_json(self):
        # NaN / Infinity / -Infinity are not RFC 8259 JSON. Accepting them
        # would let the rewrite path re-emit a body no strict parser accepts.
        for literal in (b"NaN", b"Infinity", b"-Infinity"):
            with self.subTest(literal=literal, position="top-level"):
                self.assertEqual(
                    self._run(b'{"a":' + literal + b"}"),
                    ("block", None, "invalid-json"),
                )
            with self.subTest(literal=literal, position="nested"):
                self.assertEqual(
                    self._run(
                        b'{"a":{"b":[1,' + literal + b']},"c":"SECRET123"}'
                    ),
                    ("block", None, "invalid-json"),
                )

    def test_numbers_that_merely_look_like_constants_still_parse(self):
        result, _out, reason = self._run(
            b'{"NaN":"Infinity","a":1e308,"b":-1.5,"c":0}'
        )
        self.assertEqual((result, reason), ("pass", "recognized-json"))

    def test_body_over_byte_limit_is_resource_limit(self):
        self.assertEqual(
            self._run(b'{"a":"bb"}', maxBodyBytes=4),
            ("block", None, "resource-limit"),
        )


class RequestPolicyTaggedUnionTest(unittest.TestCase):
    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["SECRET123"])

    def _run(self, body_obj, guards):
        policy = _json_policy(taggedUnions=guards)
        return nas_addon._execute_request_policy(
            policy, json.dumps(body_obj).encode("utf-8"), self.patterns
        )

    def _content_guard(self, tags, at="/messages/*/content/*"):
        return [{"at": at, "discriminator": "type", "allowedTags": tags}]

    def test_allowed_tag_in_star_path_passes(self):
        result, _out, reason = self._run(
            {"messages": [{"content": [{"type": "text", "text": "hi"}]}]},
            self._content_guard(["text", "image"]),
        )
        self.assertEqual((result, reason), ("pass", "recognized-json"))

    def test_unknown_tag_is_schema_mismatch(self):
        self.assertEqual(
            self._run(
                {"messages": [{"content": [{"type": "future"}]}]},
                self._content_guard(["text"]),
            ),
            ("block", None, "schema-mismatch"),
        )

    def test_missing_discriminator_is_schema_mismatch(self):
        self.assertEqual(
            self._run(
                {"messages": [{"content": [{"text": "hi"}]}]},
                self._content_guard(["text"]),
            ),
            ("block", None, "schema-mismatch"),
        )

    def test_non_string_discriminator_is_schema_mismatch(self):
        self.assertEqual(
            self._run(
                {"messages": [{"content": [{"type": 1}]}]},
                self._content_guard(["text"]),
            ),
            ("block", None, "schema-mismatch"),
        )

    def test_non_object_matched_node_is_schema_mismatch(self):
        self.assertEqual(
            self._run(
                {"messages": [{"content": ["bare-string"]}]},
                self._content_guard(["text"]),
            ),
            ("block", None, "schema-mismatch"),
        )

    def test_absent_optional_path_passes(self):
        result, _out, reason = self._run(
            {"messages": [{"role": "user"}]},
            self._content_guard(["text"]),
        )
        self.assertEqual((result, reason), ("pass", "recognized-json"))

    def test_content_as_scalar_string_does_not_match_star(self):
        result, _out, reason = self._run(
            {"messages": [{"content": "plain"}]},
            self._content_guard(["text"]),
        )
        self.assertEqual((result, reason), ("pass", "recognized-json"))

    def test_double_star_matches_zero_and_many_descendants(self):
        body = {
            "messages": [
                {
                    "content": [
                        {
                            "type": "tool_result",
                            "content": [{"type": "future"}],
                        }
                    ]
                }
            ]
        }
        # /**/content/* reaches both the top content block (tool_result, ok)
        # and the nested content block (future, rejected).
        self.assertEqual(
            self._run(body, self._content_guard(
                ["tool_result"], at="/**/content/*"
            )),
            ("block", None, "schema-mismatch"),
        )

    def test_double_star_zero_descendants_matches_root_child(self):
        # /**/content/* with content directly under the object root.
        self.assertEqual(
            self._run(
                {"content": [{"type": "future"}]},
                self._content_guard(["text"], at="/**/content/*"),
            ),
            ("block", None, "schema-mismatch"),
        )

    def test_tilde_escaped_literal_segments_match(self):
        # "~1" -> "/", "~0" -> "~"
        self.assertEqual(
            self._run(
                {"a/b": [{"type": "future"}]},
                self._content_guard(["text"], at="/a~1b/*"),
            ),
            ("block", None, "schema-mismatch"),
        )
        self.assertEqual(
            self._run(
                {"a~b": [{"type": "future"}]},
                self._content_guard(["text"], at="/a~0b/*"),
            ),
            ("block", None, "schema-mismatch"),
        )

    def test_overlapping_guards_each_validate_matched_nodes(self):
        body = {"content": [{"type": "text"}], "system": [{"type": "future"}]}
        guards = [
            {"at": "/**/content/*", "discriminator": "type",
             "allowedTags": ["text"]},
            {"at": "/**/system/*", "discriminator": "type",
             "allowedTags": ["text"]},
        ]
        self.assertEqual(
            self._run(body, guards), ("block", None, "schema-mismatch")
        )

    def test_masking_still_applies_after_valid_guard(self):
        result, out, reason = self._run(
            {"messages": [{"content": [
                {"type": "text", "text": "x SECRET123"}]}]},
            self._content_guard(["text"]),
        )
        self.assertEqual((result, reason), ("rewrite", "masked-json"))
        self.assertNotIn(b"SECRET123", out)


class ShippedAnthropicPolicyTest(unittest.TestCase):
    """回帰: 出荷している anthropic@1 ポリシーが Claude Code の**実際の**
    リクエスト形状を通すこと。

    合成ボディだけで検査していたせいで、`/**/content/*` が
    `tools[].input_schema.properties.content` にまで届き、Write ツールの JSON
    Schema (`{"type": "string"}`) がタグ検査に掛かって schema-mismatch → 403
    になる事故を見逃していた。ここではポリシーを手で書かず、addon が実際に
    読む解決済みドキュメント (fixture) から取り出して使う。
    """

    @classmethod
    def setUpClass(cls):
        fixture_path = (
            Path(__file__).resolve().parents[2]
            / "network"
            / "fixtures"
            / "resolved_review_rules"
            / "anthropic-v1.json"
        )
        fixture = json.loads(fixture_path.read_text())
        rule = next(
            r
            for r in fixture["rules"]
            if r["id"] == "anthropic.messages.create"
        )
        cls.policy = rule["requestPolicy"]
        assert cls.policy["kind"] == "json"

    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["SECRET123"])

    def _run(self, body_obj):
        return nas_addon._execute_request_policy(
            self.policy, json.dumps(body_obj).encode("utf-8"), self.patterns
        )

    def _claude_code_body(self, **overrides):
        """Claude Code が /v1/messages に送る形状。system 配列・tools 配列・
        tool_result のネストした content をすべて含む。"""
        body = {
            "model": "claude-opus-4-20250514",
            "max_tokens": 8192,
            "system": [
                {"type": "text", "text": "You are Claude Code."},
                {"type": "text", "text": "# CLAUDE.md\nproject rules"},
            ],
            "tools": [
                {
                    "name": "Write",
                    "description": "Writes a file to the local filesystem.",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "file_path": {"type": "string"},
                            # ここが `/**/content/*` に食われていた。
                            "content": {
                                "type": "string",
                                "description": "The content to write",
                            },
                        },
                        "required": ["file_path", "content"],
                    },
                },
                {
                    "name": "Bash",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "command": {"type": "string"},
                            "content": {"type": "array"},
                        },
                    },
                },
            ],
            "messages": [
                {
                    "role": "user",
                    "content": [{"type": "text", "text": "list the files"}],
                },
                {
                    "role": "assistant",
                    "content": [
                        {"type": "thinking", "thinking": "use Bash"},
                        {
                            "type": "tool_use",
                            "id": "toolu_1",
                            "name": "Bash",
                            "input": {"command": "ls"},
                        },
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_1",
                            "content": [{"type": "text", "text": "a.txt"}],
                        }
                    ],
                },
            ],
        }
        body.update(overrides)
        return body

    def test_realistic_request_with_tool_schemas_passes(self):
        result, out, reason = self._run(self._claude_code_body())

        self.assertEqual((result, reason), ("pass", "recognized-json"))
        self.assertIsNone(out)

    def test_secrets_in_a_realistic_request_are_masked(self):
        body = self._claude_code_body()
        body["messages"][0]["content"][0]["text"] = "token is SECRET123"

        result, out, reason = self._run(body)

        self.assertEqual((result, reason), ("rewrite", "masked-json"))
        self.assertNotIn(b"SECRET123", out)

    def test_unknown_tag_under_messages_blocks(self):
        body = self._claude_code_body()
        body["messages"][0]["content"].append({"type": "future_block"})

        self.assertEqual(
            self._run(body), ("block", None, "schema-mismatch")
        )

    def test_unknown_tag_nested_in_tool_result_blocks(self):
        body = self._claude_code_body()
        body["messages"][2]["content"][0]["content"].append(
            {"type": "future_block"}
        )

        self.assertEqual(
            self._run(body), ("block", None, "schema-mismatch")
        )

    def test_unknown_tag_in_system_blocks(self):
        body = self._claude_code_body()
        body["system"].append({"type": "future_block"})

        self.assertEqual(
            self._run(body), ("block", None, "schema-mismatch")
        )

    def test_unknown_tag_in_a_document_content_source_blocks(self):
        """`**` を捨てた分、content block がネストしうる場所は数え上げになる。
        `document` の `source.type = "content"` は content block の配列を持つ
        ので、そこも fail-closed の網に入っていること。"""
        body = self._claude_code_body()
        body["messages"][0]["content"].append(
            {
                "type": "document",
                "source": {
                    "type": "content",
                    "content": [{"type": "future_block"}],
                },
            }
        )

        self.assertEqual(
            self._run(body), ("block", None, "schema-mismatch")
        )

    def test_unknown_tag_in_a_document_source_nested_in_tool_result_blocks(self):
        body = self._claude_code_body()
        body["messages"][2]["content"][0]["content"].append(
            {
                "type": "document",
                "source": {
                    "type": "content",
                    "content": [{"type": "future_block"}],
                },
            }
        )

        self.assertEqual(
            self._run(body), ("block", None, "schema-mismatch")
        )

    def test_well_formed_document_content_source_passes(self):
        body = self._claude_code_body()
        body["messages"][0]["content"].append(
            {
                "type": "document",
                "source": {
                    "type": "content",
                    "content": [{"type": "text", "text": "chapter 1"}],
                },
            }
        )

        result, _out, reason = self._run(body)

        self.assertEqual((result, reason), ("pass", "recognized-json"))

    def test_base64_payload_in_a_realistic_request_is_masked(self):
        """encodedFields の `/**` は絞っていない。運び手はどこにでも現れうる
        ので、ネストした tool_result の中でも復号→マスク→再エンコードされる。"""
        blob = base64.b64encode(b"leaked SECRET123 here").decode("ascii")
        body = self._claude_code_body()
        body["messages"][2]["content"][0]["content"].append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": blob,
                },
            }
        )

        result, out, reason = self._run(body)

        self.assertEqual((result, reason), ("rewrite", "masked-json"))
        rewritten = json.loads(out)
        data = rewritten["messages"][2]["content"][0]["content"][1][
            "source"
        ]["data"]
        self.assertNotIn(b"SECRET123", base64.b64decode(data))


class RequestPolicySelectorArrayIndexTest(unittest.TestCase):
    """Literal segments follow JSON Pointer semantics: a literal that is a
    valid array index descends into a list. Without this the selector matches
    nothing and the guard silently fails open."""

    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["SECRET123"])

    def _run(self, body_obj, at, tags=("text",)):
        policy = _json_policy(taggedUnions=[{
            "at": at, "discriminator": "type", "allowedTags": list(tags),
        }])
        return nas_addon._execute_request_policy(
            policy, json.dumps(body_obj).encode("utf-8"), self.patterns
        )

    def test_index_selector_no_longer_fails_open(self):
        # The exact reviewer-reported fail-open: this selector is accepted by
        # the contract validator, so it must not silently match nothing.
        self.assertTrue(nas_addon._is_valid_selector("/messages/0/content/*"))
        self.assertEqual(
            self._run(
                {"messages": [{"content": [{"type": "UNKNOWN_TAG"}]}]},
                "/messages/0/content/*",
            ),
            ("block", None, "schema-mismatch"),
        )

    def test_index_selects_only_the_addressed_element(self):
        body = {"messages": [
            {"content": [{"type": "text"}]},
            {"content": [{"type": "future"}]},
        ]}
        result, _out, reason = self._run(body, "/messages/0/content/*")
        self.assertEqual((result, reason), ("pass", "recognized-json"))
        self.assertEqual(
            self._run(body, "/messages/1/content/*"),
            ("block", None, "schema-mismatch"),
        )

    def test_out_of_range_index_matches_nothing(self):
        result, _out, reason = self._run(
            {"messages": [{"content": [{"type": "future"}]}]},
            "/messages/7/content/*",
        )
        self.assertEqual((result, reason), ("pass", "recognized-json"))

    def test_leading_zero_index_does_not_address_a_list(self):
        result, _out, reason = self._run(
            {"messages": [{"content": [{"type": "future"}]}]},
            "/messages/01/content/*",
        )
        self.assertEqual((result, reason), ("pass", "recognized-json"))

    def test_dash_token_does_not_address_a_list(self):
        # JSON Pointer "-" means "after the last element"; it can never
        # address an existing member.
        result, _out, reason = self._run(
            {"messages": [{"content": [{"type": "future"}]}]},
            "/messages/-/content/*",
        )
        self.assertEqual((result, reason), ("pass", "recognized-json"))

    def test_non_numeric_and_signed_literals_do_not_address_a_list(self):
        body = {"messages": [{"content": [{"type": "future"}]}]}
        for at in (
            "/messages/x/content/*",
            "/messages/+0/content/*",
            "/messages/-1/content/*",
            "/messages/0_0/content/*",
            "/messages/ 0/content/*",
        ):
            with self.subTest(at=at):
                result, _out, reason = self._run(body, at)
                self.assertEqual(
                    (result, reason), ("pass", "recognized-json")
                )

    def test_object_key_named_like_an_index_still_matches_by_key(self):
        self.assertEqual(
            self._run(
                {"messages": {"0": {"content": [{"type": "future"}]}}},
                "/messages/0/content/*",
            ),
            ("block", None, "schema-mismatch"),
        )

    def test_index_matches_a_scalar_element_as_schema_mismatch(self):
        # /messages/0 addresses the string itself, which is not an object.
        self.assertEqual(
            self._run({"messages": ["plain"]}, "/messages/0"),
            ("block", None, "schema-mismatch"),
        )


def _nested_content_document(depth, breadth):
    if depth == 0:
        return {"type": "text"}
    return {
        "content": [
            _nested_content_document(depth - 1, breadth)
            for _ in range(breadth)
        ]
    }


def _count_json_nodes(node):
    total = 1
    for child in nas_addon._json_children(node):
        total += _count_json_nodes(child)
    return total


class RequestPolicySelectorExpansionBoundTest(unittest.TestCase):
    """Selector evaluation memoizes (node, segment-index) states, so multiple
    `**` segments cannot multiply the work done per node."""

    def _collect(self, document, selector):
        segments = nas_addon._parse_selector(selector)
        matches: list = []
        expansions = nas_addon._collect_selector_matches(
            document, segments, matches, set()
        )
        return segments, matches, expansions

    def test_repeated_double_star_expansion_stays_bounded(self):
        document = _nested_content_document(6, 3)
        nodes = _count_json_nodes(document)
        self.assertGreater(nodes, 2000)
        for selector in ("/**/content/*", "/**/**/content/*",
                         "/**/**/**/content/*"):
            with self.subTest(selector=selector):
                segments, matches, expansions = self._collect(
                    document, selector
                )
                self.assertIsInstance(
                    expansions, int, "expansion count is not reported"
                )
                # Each (node, segment-index) state is expanded at most once.
                self.assertLessEqual(expansions, nodes * (len(segments) + 1))

    def test_repeated_double_star_matches_are_unchanged(self):
        document = _nested_content_document(4, 3)
        _segments, baseline, _expansions = self._collect(
            document, "/**/content/*"
        )
        for selector in ("/**/**/content/*", "/**/**/**/content/*"):
            with self.subTest(selector=selector):
                _segments, matches, _expansions = self._collect(
                    document, selector
                )
                self.assertEqual(
                    [id(node) for node in matches],
                    [id(node) for node in baseline],
                )

    def test_bounded_traversal_keeps_guard_semantics(self):
        document = {"content": [
            {"type": "text", "content": [{"type": "future"}]},
        ]}
        policy = _json_policy(taggedUnions=[{
            "at": "/**/**/content/*",
            "discriminator": "type",
            "allowedTags": ["text"],
        }])
        self.assertEqual(
            nas_addon._execute_request_policy(
                policy,
                json.dumps(document).encode("utf-8"),
                nas_addon._build_mask_patterns(["SECRET123"]),
            ),
            ("block", None, "schema-mismatch"),
        )


_BASE64_FIELD = {
    "at": "/**",
    "whenField": "type",
    "whenEquals": "base64",
    "dataField": "data",
    "encoding": "base64",
}


class RequestPolicyEncodedFieldTest(unittest.TestCase):
    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["SECRET123"])

    def _run(self, body_obj, patterns=None, **overrides):
        policy = _json_policy(encodedFields=[_BASE64_FIELD], **overrides)
        return nas_addon._execute_request_policy(
            policy,
            json.dumps(body_obj).encode("utf-8"),
            self.patterns if patterns is None else patterns,
        )

    def _source(self, data):
        return {"source": {"type": "base64", "data": data}}

    def test_non_matching_discriminator_is_a_no_op(self):
        # type != "base64" so the rule does nothing; the value is then an
        # ordinary string and stays untouched because it holds no secret.
        result, _out, reason = self._run(
            {"source": {"type": "url", "data": "not!base64!"}}
        )
        self.assertEqual((result, reason), ("pass", "recognized-json"))

    def test_non_object_selector_matches_are_skipped(self):
        # "/**" also selects scalars and lists; they must not block.
        result, _out, reason = self._run(
            {"a": "plain", "b": [1, 2], "c": None}
        )
        self.assertEqual((result, reason), ("pass", "recognized-json"))

    def test_matching_rule_requires_string_data_field(self):
        result, out, reason = self._run(self._source(123))
        self.assertEqual(result, "block")
        self.assertIsNone(out)
        self.assertEqual(reason, "schema-mismatch")

    def test_matching_rule_requires_present_data_field(self):
        result, _out, reason = self._run({"source": {"type": "base64"}})
        self.assertEqual((result, reason), ("block", "schema-mismatch"))

    def test_clean_base64_is_unchanged_and_passes(self):
        blob = base64.b64encode(b"clean payload bytes").decode("ascii")
        result, out, reason = self._run(self._source(blob))
        self.assertEqual((result, out, reason), ("pass", None, "recognized-json"))

    def test_secret_inside_base64_is_masked_and_re_encoded(self):
        blob = base64.b64encode(b"prefix SECRET123 suffix").decode("ascii")
        result, out, reason = self._run(self._source(blob))
        self.assertEqual((result, reason), ("rewrite", "masked-json"))
        parsed = json.loads(out)
        decoded = base64.b64decode(parsed["source"]["data"])
        self.assertNotIn(b"SECRET123", decoded)
        self.assertIn(b"****", decoded)
        self.assertEqual(decoded, b"prefix **** suffix")

    def test_invalid_base64_alphabet_blocks(self):
        self.assertEqual(
            self._run(self._source("not!valid!base64!")),
            ("block", None, "encoded-decode-failed"),
        )

    def test_invalid_base64_padding_blocks(self):
        self.assertEqual(
            self._run(self._source("YWJjZA")),
            ("block", None, "encoded-decode-failed"),
        )

    def test_whitespace_and_line_wrapped_base64_block(self):
        raw = base64.b64encode(b"x" * 90).decode("ascii")
        for variant in (
            f"{raw[:40]}\n{raw[40:]}",
            f"{raw[:40]} {raw[40:]}",
            f" {raw}",
            f"{raw}\n",
            f"{raw[:40]}\r\n{raw[40:]}",
        ):
            with self.subTest(variant=repr(variant[:12])):
                self.assertEqual(
                    self._run(self._source(variant)),
                    ("block", None, "encoded-decode-failed"),
                )

    def test_non_canonical_trailing_bits_block(self):
        # "YR==" decodes to b"a" but canonically re-encodes to "YQ==".
        self.assertEqual(
            self._run(self._source("YR==")),
            ("block", None, "encoded-decode-failed"),
        )

    def test_cumulative_decoded_budget_is_enforced(self):
        blob = base64.b64encode(b"y" * 60).decode("ascii")
        body = {"a": self._source(blob), "b": self._source(blob)}
        # Each field decodes to 60 bytes; 120 total.
        self.assertEqual(
            self._run(body, maxDecodedBytes=119),
            ("block", None, "resource-limit"),
        )
        result, _out, reason = self._run(body, maxDecodedBytes=120)
        self.assertEqual((result, reason), ("pass", "recognized-json"))

    def test_consumed_data_is_not_masked_a_second_time_as_text(self):
        # The base64 TEXT itself contains the secret, but the decoded bytes
        # do not. Because the field was consumed by the encoded-field rule it
        # must not be masked again as an ordinary string.
        blob = base64.b64encode(b"hello world payload").decode("ascii")
        secret = blob[:10]
        patterns = nas_addon._build_mask_patterns([secret])
        result, out, reason = self._run(self._source(blob), patterns=patterns)
        self.assertEqual((result, out, reason), ("pass", None, "recognized-json"))

    def test_unconsumed_sibling_strings_are_still_masked(self):
        blob = base64.b64encode(b"clean").decode("ascii")
        body = {"source": {"type": "base64", "data": blob,
                           "note": "SECRET123"}}
        result, out, reason = self._run(body)
        self.assertEqual((result, reason), ("rewrite", "masked-json"))
        parsed = json.loads(out)
        self.assertEqual(parsed["source"]["note"], "****")
        self.assertEqual(parsed["source"]["data"], blob)


class RequestPolicyKeyCollisionTest(unittest.TestCase):
    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["SECRET123"])

    def _run(self, raw_body, patterns=None):
        return nas_addon._execute_request_policy(
            _json_policy(),
            raw_body,
            self.patterns if patterns is None else patterns,
        )

    def test_masked_key_colliding_with_existing_key_blocks(self):
        self.assertEqual(
            self._run(b'{"SECRET123":"a","****":"b"}'),
            ("block", None, "key-collision"),
        )

    def test_two_distinct_secrets_masking_to_the_same_key_block(self):
        patterns = nas_addon._build_mask_patterns(["SECRET123", "TOKENXY"])
        self.assertEqual(
            self._run(b'{"SECRET123":"a","TOKENXY":"b"}', patterns=patterns),
            ("block", None, "key-collision"),
        )

    def test_nested_key_collision_blocks(self):
        self.assertEqual(
            self._run(b'{"outer":{"SECRET123":"a","****":"b"}}'),
            ("block", None, "key-collision"),
        )

    def test_distinct_masked_keys_do_not_collide(self):
        result, out, reason = self._run(b'{"aSECRET123b":"v","c":"w"}')
        self.assertEqual((result, reason), ("rewrite", "masked-json"))
        self.assertEqual(json.loads(out), {"a****b": "v", "c": "w"})


class RequestPolicyLimitBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["SECRET123"])

    def _run(self, raw_body, **overrides):
        return nas_addon._execute_request_policy(
            _json_policy(**overrides), raw_body, self.patterns
        )

    def test_body_bytes_at_limit_passes_and_over_limit_blocks(self):
        body = b'{"a":1}'
        self.assertEqual(len(body), 7)
        result, _out, reason = self._run(body, maxBodyBytes=7)
        self.assertEqual((result, reason), ("pass", "recognized-json"))
        self.assertEqual(
            self._run(body, maxBodyBytes=6),
            ("block", None, "resource-limit"),
        )

    def test_depth_at_limit_passes_and_over_limit_blocks(self):
        # root object is depth 1, its scalar member is depth 2.
        body = b'{"a":1}'
        result, _out, reason = self._run(body, maxDepth=2)
        self.assertEqual((result, reason), ("pass", "recognized-json"))
        self.assertEqual(
            self._run(body, maxDepth=1), ("block", None, "resource-limit")
        )

    def test_nested_depth_boundary(self):
        # root -> a -> b -> scalar == depth 4
        body = b'{"a":{"b":{"c":1}}}'
        result, _out, reason = self._run(body, maxDepth=4)
        self.assertEqual((result, reason), ("pass", "recognized-json"))
        self.assertEqual(
            self._run(body, maxDepth=3), ("block", None, "resource-limit")
        )

    def test_nodes_at_limit_passes_and_over_limit_blocks(self):
        # root + two scalars == 3 nodes
        body = b'{"a":1,"b":2}'
        result, _out, reason = self._run(body, maxNodes=3)
        self.assertEqual((result, reason), ("pass", "recognized-json"))
        self.assertEqual(
            self._run(body, maxNodes=2), ("block", None, "resource-limit")
        )

    def test_array_elements_count_as_nodes(self):
        # root + list + three elements == 5 nodes
        body = b'{"a":[1,2,3]}'
        result, _out, reason = self._run(body, maxNodes=5)
        self.assertEqual((result, reason), ("pass", "recognized-json"))
        self.assertEqual(
            self._run(body, maxNodes=4), ("block", None, "resource-limit")
        )

    def test_decoded_bytes_at_limit_passes_and_over_limit_blocks(self):
        blob = base64.b64encode(b"z" * 30).decode("ascii")
        body = json.dumps(
            {"source": {"type": "base64", "data": blob}}
        ).encode("utf-8")
        result, _out, reason = self._run(
            body, encodedFields=[_BASE64_FIELD], maxDecodedBytes=30
        )
        self.assertEqual((result, reason), ("pass", "recognized-json"))
        self.assertEqual(
            self._run(
                body, encodedFields=[_BASE64_FIELD], maxDecodedBytes=29
            ),
            ("block", None, "resource-limit"),
        )

    def test_deeply_nested_body_fails_closed(self):
        deep = ("[" * 40000 + "]" * 40000).encode("utf-8")
        result, out, reason = self._run(deep)
        self.assertEqual(result, "block")
        self.assertIsNone(out)
        self.assertIn(reason, ("invalid-json", "resource-limit"))

    def test_lone_surrogate_serialization_fails_closed(self):
        body = json.dumps(
            {"a": "\ud800", "b": "SECRET123"}
        ).encode("utf-8")
        self.assertEqual(
            self._run(body), ("block", None, "serialization-failed")
        )


class RequestPolicyInjectedExceptionTest(unittest.TestCase):
    """Every internal exception must block with a closed reason and must not
    leak exception text or body data to stderr."""

    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["SECRET123"])
        self.body = json.dumps(
            {"messages": [{"content": [{"type": "text",
                                        "text": "SECRET123"}]}]}
        ).encode("utf-8")

    def _run_with(self, target, **patch_kwargs):
        stderr = io.StringIO()
        with patch.object(
            nas_addon, target, **patch_kwargs
        ), redirect_stderr(stderr):
            result = nas_addon._execute_request_policy(
                _json_policy(encodedFields=[_BASE64_FIELD]),
                self.body,
                self.patterns,
            )
        return result, stderr.getvalue()

    def test_traversal_exception_blocks_as_processing_failed(self):
        for target in (
            "_account_json",
            "_validate_tagged_unions",
            "_process_encoded_fields",
            "_recursively_mask_json",
        ):
            with self.subTest(target=target):
                result, stderr = self._run_with(
                    target,
                    side_effect=RuntimeError(
                        "SECRET123 /raw/private-path leak"
                    ),
                )
                self.assertEqual(
                    result, ("block", None, "processing-failed")
                )
                self.assertEqual(stderr, "")

    def test_parser_exception_blocks_without_leaking(self):
        stderr = io.StringIO()
        with patch.object(
            nas_addon.json,
            "loads",
            side_effect=RuntimeError("SECRET123 parser detail"),
        ), redirect_stderr(stderr):
            result = nas_addon._execute_request_policy(
                _json_policy(), self.body, self.patterns
            )
        self.assertEqual(result, ("block", None, "invalid-json"))
        self.assertEqual(stderr.getvalue(), "")

    def test_serializer_exception_blocks_as_serialization_failed(self):
        stderr = io.StringIO()
        with patch.object(
            nas_addon.json,
            "dumps",
            side_effect=RuntimeError("SECRET123 serializer detail"),
        ), redirect_stderr(stderr):
            result = nas_addon._execute_request_policy(
                _json_policy(), self.body, self.patterns
            )
        self.assertEqual(result, ("block", None, "serialization-failed"))
        self.assertEqual(stderr.getvalue(), "")

    def test_bodyless_engine_exception_blocks_as_processing_failed(self):
        class ExplodingBody:
            def __len__(self):
                raise RuntimeError("SECRET123 length detail")

        stderr = io.StringIO()
        with redirect_stderr(stderr):
            result = nas_addon._execute_request_policy(
                {"kind": "bodyless"}, ExplodingBody(), self.patterns
            )
        self.assertEqual(result, ("block", None, "processing-failed"))
        self.assertEqual(stderr.getvalue(), "")

    def test_unknown_policy_kind_blocks(self):
        for policy in (
            {"kind": "graphql"},
            {"kind": "future"},
            {},
        ):
            with self.subTest(policy=policy):
                self.assertEqual(
                    nas_addon._execute_request_policy(
                        policy, b"{}", self.patterns
                    ),
                    ("block", None, "processing-failed"),
                )

    def test_engine_emits_nothing_to_stderr_on_success(self):
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            nas_addon._execute_request_policy(
                _json_policy(), self.body, self.patterns
            )
        self.assertEqual(stderr.getvalue(), "")


def _policy_rule(rule_id, **overrides):
    """許可 + JSON ポリシー付きの解決済みルール。"""
    rule = {
        "id": rule_id,
        "method": "POST",
        "host": "api.example.com",
        "path": "/v1/messages",
        "action": "allow",
        "audit": True,
        "requestPolicy": _json_policy(),
    }
    rule.update(overrides)
    return rule


def _bodyless_rule(rule_id, **overrides):
    rule = {
        "id": rule_id,
        "method": "GET",
        "host": "api.example.com",
        "path": "/v1/models",
        "action": "allow",
        "audit": True,
        "requestPolicy": {"kind": "bodyless"},
    }
    rule.update(overrides)
    return rule


class RequestPolicyFlowTest(unittest.TestCase):
    """request() が broker の権威的な ruleId でポリシーを実行することの検証。

    ローカルの事前マッチはプレビュー選択のためだけに使ってよく、どのポリシーを
    実行するかを決めてはならない。決めてしまうと、broker が持つ解決済み
    ドキュメントとローカルの判断がずれたときに、承認されていないポリシーが
    実行されうる。"""

    def setUp(self):
        self.session_id = "sess-test"
        self.token = "token-test"
        self.proxy_auth = "Basic " + base64.b64encode(
            f"{self.session_id}:{self.token}".encode()
        ).decode()
        self.registry = {"tokenHash": nas_addon._hash_token(self.token)}

    def _run(
        self,
        *,
        rules,
        rule_id="messages",
        method="POST",
        path="/v1/messages",
        host="api.example.com",
        content=b'{"text":"SECRET123"}',
        headers=None,
        request_class=FakeRequest,
        inject=True,
        addon=None,
        client_id="client-test",
    ):
        """rule_id は broker が返す権威的な ID。省略記法として None で ID 無し。"""
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
                decision = {
                    "decision": "allow",
                    "requestId": request["requestId"],
                    "reason": "review-rule",
                    "maskValues": ["SECRET123"],
                }
                if rule_id is not None:
                    decision["ruleId"] = rule_id
                if inject:
                    decision["injectHeaders"] = [
                        {"name": "x-api-key", "value": "injected-value"}
                    ]
                return decision
            return {
                "version": 1,
                "type": "request_policy_outcome_recorded",
                "requestId": request["requestId"],
            }

        stderr = io.StringIO()
        with patch.object(
            nas_addon, "_load_registry", return_value=self.registry
        ), patch.object(
            nas_addon,
            "_load_review_rules",
            # rules=None は「契約として読めないドキュメント」を表す。
            return_value=(
                None
                if rules is None
                else {"contractVersion": 1, "rules": rules}
            ),
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
        return [
            m for m in messages if m["type"] == "request_policy_outcome"
        ]

    def _injected(self, flow):
        return flow.request.headers.get("x-api-key")

    def _run_connect(self, addon, client_id, *, authenticated):
        headers = (
            {"proxy-authorization": self.proxy_auth} if authenticated else {}
        )
        flow = FakeFlow(FakeRequest(headers=headers, host="api.example.com"))
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

    def test_broker_rule_id_beats_local_pre_match(self):
        # ローカルの first-match は bodyless (非空ボディを block) を選ぶが、
        # broker は JSON ポリシーの ID を返す。実行されるのは broker の方。
        local = _bodyless_rule(
            "local-first", method="POST", path="/v1/messages"
        )
        local["requestPolicy"] = {"kind": "bodyless"}
        flow, messages, _stderr = self._run(
            rules=[local, _policy_rule("broker-choice")],
            rule_id="broker-choice",
        )

        self.assertIsNone(flow.response)
        self.assertEqual(flow.request.content, b'{"text":"****"}')
        self.assertEqual(
            [(m["ruleId"], m["result"], m["reason"])
             for m in self._outcomes(messages)],
            [("broker-choice", "rewrite", "masked-json")],
        )

    def test_unknown_rule_id_blocks_before_injection(self):
        flow, messages, _stderr = self._run(
            rules=[_policy_rule("messages")],
            rule_id="not-in-document",
        )

        self.assertEqual(flow.response.status_code, 403)
        self.assertEqual(
            flow.response.content, nas_addon.REQUEST_POLICY_BLOCK_BODY
        )
        self.assertIsNone(self._injected(flow))
        self.assertEqual(self._outcomes(messages), [])

    def test_id_less_allow_keeps_generic_masking(self):
        flow, messages, _stderr = self._run(
            rules=[],
            rule_id=None,
            method="POST",
            path="/submit",
            host="example.com",
            content=b"value=SECRET123",
        )

        self.assertIsNone(flow.response)
        self.assertEqual(flow.request.content, b"value=****")
        self.assertEqual(self._outcomes(messages), [])
        self.assertEqual(self._injected(flow), "injected-value")

    def test_rule_without_policy_keeps_generic_masking(self):
        ordinary = {
            "id": "ordinary",
            "host": "example.com",
            "action": "allow",
            "audit": True,
        }
        flow, messages, _stderr = self._run(
            rules=[ordinary],
            rule_id="ordinary",
            method="POST",
            path="/submit",
            host="example.com",
            content=b"value=SECRET123",
        )

        self.assertIsNone(flow.response)
        self.assertEqual(flow.request.content, b"value=****")
        self.assertEqual(self._outcomes(messages), [])
        self.assertEqual(self._injected(flow), "injected-value")

    def test_approved_review_executes_policy(self):
        flow, messages, _stderr = self._run(
            rules=[_policy_rule("messages", action="review")],
            rule_id="messages",
        )

        self.assertIsNone(flow.response)
        self.assertEqual(flow.request.content, b'{"text":"****"}')
        self.assertEqual(
            [m["result"] for m in self._outcomes(messages)], ["rewrite"]
        )

    def test_policy_block_prevents_credential_injection(self):
        flow, messages, _stderr = self._run(
            rules=[_bodyless_rule("models")],
            rule_id="models",
            method="GET",
            path="/v1/models",
            content=b"unexpected",
        )

        self.assertEqual(flow.response.status_code, 403)
        self.assertEqual(
            flow.response.content, nas_addon.REQUEST_POLICY_BLOCK_BODY
        )
        self.assertIsNone(self._injected(flow))
        self.assertEqual(
            [(m["result"], m["reason"]) for m in self._outcomes(messages)],
            [("block", "unexpected-body")],
        )

    def test_pass_injects_credentials_after_policy(self):
        flow, messages, _stderr = self._run(
            rules=[_bodyless_rule("models")],
            rule_id="models",
            method="GET",
            path="/v1/models",
            content=b"",
        )

        self.assertIsNone(flow.response)
        self.assertEqual(self._injected(flow), "injected-value")
        self.assertEqual(
            [(m["result"], m["reason"]) for m in self._outcomes(messages)],
            [("pass", "empty-body")],
        )

    def test_rewrite_injects_credentials_after_policy(self):
        flow, _messages, _stderr = self._run(
            rules=[_policy_rule("messages")],
            rule_id="messages",
        )

        self.assertIsNone(flow.response)
        self.assertEqual(flow.request.content, b'{"text":"****"}')
        self.assertEqual(self._injected(flow), "injected-value")

    def test_outcome_carries_only_the_closed_field_set(self):
        _flow, messages, _stderr = self._run(
            rules=[_policy_rule("messages")],
            rule_id="messages",
        )

        outcome = self._outcomes(messages)[0]
        self.assertEqual(
            set(outcome),
            {
                "version",
                "type",
                "requestId",
                "sessionId",
                "ruleId",
                "result",
                "reason",
            },
        )
        self.assertEqual(outcome["sessionId"], self.session_id)
        self.assertEqual(outcome["requestId"], "req-test")

    def test_missing_credentials_log_uses_only_sanitized_request_fields(self):
        flow = FakeFlow(FakeRequest(
            path="/private/SECRET123?filename=SECRET123.txt",
            method="CUSTOM-SECRET123",
            host="api.example.com",
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
        self.assertIn("method=OTHER", stderr.getvalue())
        self.assertNotIn("SECRET123", stderr.getvalue())
        self.assertNotIn("/private/", stderr.getvalue())

    def test_invalid_contract_blocks_before_broker_or_injection(self):
        flow, messages, stderr = self._run(rules=None)

        self.assertEqual(flow.response.status_code, 403)
        self.assertEqual(
            flow.response.content, nas_addon.REQUEST_POLICY_BLOCK_BODY
        )
        self.assertIsNone(self._injected(flow))
        self.assertEqual(messages, [])
        self.assertEqual(
            stderr,
            "[nas-addon] REQUEST-POLICY-CONTRACT-INVALID: "
            "session=sess-test\n",
        )

    def test_invalid_contract_log_sanitizes_untrusted_session_id(self):
        self.session_id = "sess-test\nSECRET-session"
        self.proxy_auth = "Basic " + base64.b64encode(
            f"{self.session_id}:{self.token}".encode()
        ).decode()

        flow, messages, stderr = self._run(rules=None)

        self.assertEqual(flow.response.status_code, 403)
        self.assertEqual(messages, [])
        self.assertEqual(
            stderr,
            "[nas-addon] REQUEST-POLICY-CONTRACT-INVALID: "
            "session=invalid\n",
        )

    def test_unknown_rule_id_log_sanitizes_the_broker_supplied_id(self):
        _flow, _messages, stderr = self._run(
            rules=[_policy_rule("messages")],
            rule_id="NOT A VALID ID\nSECRET-rule",
        )

        self.assertEqual(
            stderr,
            "[nas-addon] REQUEST-POLICY-RULE-UNKNOWN: "
            "session=sess-test rule=invalid\n",
        )

    def test_pre_match_attaches_bounded_preview_for_trailing_dot_host(self):
        body = b'{"text":"hello"}'
        rule = _policy_rule("messages", host="api.example.com.")

        _flow, messages, _stderr = self._run(
            rules=[rule], rule_id="messages", content=body
        )

        authorization = next(
            message for message in messages if message["type"] == "authorize"
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

    def test_query_and_header_are_masked_before_injection(self):
        flow, _messages, stderr = self._run(
            rules=[_policy_rule("messages")],
            rule_id="messages",
            path="/v1/messages?k=SECRET123",
            headers=[("x-custom", "SECRET123")],
        )

        self.assertEqual(flow.request.path, "/v1/messages?k=****")
        self.assertEqual(flow.request.headers["x-custom"], "****")
        self.assertEqual(self._injected(flow), "injected-value")
        self.assertNotIn("SECRET123", stderr)

    def test_policy_request_never_logs_the_path_or_its_query(self):
        _flow, _messages, stderr = self._run(
            rules=[_policy_rule("messages")],
            rule_id="messages",
            path="/v1/messages?filename=PRIVATE-NOT-A-MASK-VALUE.txt",
        )

        self.assertNotIn("PRIVATE-NOT-A-MASK-VALUE", stderr)
        self.assertNotIn("/v1/messages", stderr)

    def test_outcome_failure_does_not_change_the_computed_result(self):
        rules = [_policy_rule("messages")]

        def failing_broker(_socket_path, request):
            if request["type"] == "authorize":
                return {
                    "decision": "allow",
                    "requestId": request["requestId"],
                    "reason": "review-rule",
                    "ruleId": "messages",
                    "maskValues": ["SECRET123"],
                }
            raise RuntimeError("SECRET123 /raw/private-path")

        flow = FakeFlow(FakeRequest(
            path="/v1/messages",
            headers=[("proxy-authorization", self.proxy_auth)],
            content=b'{"text":"SECRET123"}',
            method="POST",
            host="api.example.com",
        ))
        stderr = io.StringIO()
        with patch.object(
            nas_addon, "_load_registry", return_value=self.registry
        ), patch.object(
            nas_addon,
            "_load_review_rules",
            return_value={"contractVersion": 1, "rules": rules},
        ), patch.object(
            nas_addon, "_generate_request_id", return_value="req-test"
        ), patch.object(
            nas_addon, "_query_broker", side_effect=failing_broker
        ), patch.object(
            nas_addon.http.Response,
            "make",
            side_effect=lambda status, body=b"", response_headers=None: (
                FakeResponse(status, body, response_headers)
            ),
        ), redirect_stderr(stderr):
            nas_addon.NasAddon().request(flow)

        # 監査が届かなくても、計算済みの rewrite はそのまま通す。
        self.assertIsNone(flow.response)
        self.assertEqual(flow.request.content, b'{"text":"****"}')
        self.assertEqual(
            stderr.getvalue(),
            nas_addon.REQUEST_POLICY_AUDIT_UNAVAILABLE + "\n",
        )

    def test_repeated_blocks_log_only_at_power_of_two_counts(self):
        addon = nas_addon.NasAddon()
        lines = []
        for _ in range(5):
            _flow, _messages, stderr = self._run(
                rules=[_bodyless_rule("models")],
                rule_id="models",
                method="GET",
                path="/v1/models",
                content=b"unexpected",
                addon=addon,
            )
            lines.append(stderr)

        emitted = [line for line in lines if line]
        self.assertEqual(len(emitted), 3)  # count=1,2,4
        self.assertIn("count=1", emitted[0])
        self.assertIn("count=2", emitted[1])
        self.assertIn("count=4", emitted[2])
        self.assertIn("rule=models kind=bodyless", emitted[0])
        self.assertIn("result=block reason=unexpected-body", emitted[0])

    def _block_once(self, addon, client_id):
        return self._run(
            rules=[_bodyless_rule("models")],
            rule_id="models",
            method="GET",
            path="/v1/models",
            content=b"unexpected",
            addon=addon,
            client_id=client_id,
        )

    def test_client_disconnect_prunes_only_its_session_counts(self):
        addon = nas_addon.NasAddon()
        self._block_once(addon, "client-a")
        self.assertTrue(addon._request_policy_block_counts)

        addon.client_disconnected(FakeClientConnection("client-a"))

        self.assertEqual(addon._request_policy_block_counts, {})

    def test_shared_session_counts_remain_until_last_client_leaves(self):
        addon = nas_addon.NasAddon()
        self._block_once(addon, "client-a")
        self._block_once(addon, "client-b")

        addon.client_disconnected(FakeClientConnection("client-a"))

        # 同じセッションを client-b がまだ握っているので消してはならない。
        self.assertTrue(addon._request_policy_block_counts)

        addon.client_disconnected(FakeClientConnection("client-b"))

        self.assertEqual(addon._request_policy_block_counts, {})

    def test_authenticated_connect_keeps_the_session_active(self):
        addon = nas_addon.NasAddon()
        self._block_once(addon, "client-a")
        self._run_connect(addon, "client-b", authenticated=True)

        addon.client_disconnected(FakeClientConnection("client-a"))

        self.assertTrue(addon._request_policy_block_counts)

    def test_failed_connect_does_not_keep_session_counts(self):
        addon = nas_addon.NasAddon()
        self._block_once(addon, "client-a")
        self._run_connect(addon, "client-b", authenticated=False)

        addon.client_disconnected(FakeClientConnection("client-a"))

        self.assertEqual(addon._request_policy_block_counts, {})


if __name__ == "__main__":
    unittest.main()
