"""Unit tests for the mask helpers in nas_addon.py.

Run via nas_addon_test.ts, which sets PYTHONPATH to the mitmproxy stub.
Direct invocation:
    PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_mask_test.py
"""

import base64
import contextlib
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

_FIXTURE_PATH = (
    Path(__file__).resolve().parents[2]
    / "network"
    / "fixtures"
    / "authz"
    / "anthropic-v1.json"
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


class SafeRuleLabelTest(unittest.TestCase):
    """Rule IDs printed to stderr are re-checked against the ID syntax.

    Both pseudo IDs are real identities — an approval is remembered against
    one — so a log line that names them has to print them, not "invalid".
    """

    def test_prints_a_rule_id_and_both_pseudo_ids(self):
        for rule_id in ("github.repos.read", "github.$fallback", "$fallback"):
            with self.subTest(rule_id):
                self.assertEqual(nas_addon._safe_rule_label(rule_id), rule_id)

    def test_replaces_anything_outside_the_syntax(self):
        for rule_id in (
            "Github.Repos",
            "github repos",
            "github.$fallback.extra",
            "$other",
            "",
            None,
            42,
        ):
            with self.subTest(rule_id):
                self.assertEqual(nas_addon._safe_rule_label(rule_id), "invalid")


class AuthzDocumentContractTest(unittest.TestCase):
    """The addon re-validates the document the host wrote.

    Anything unrecognised invalidates the document whole rather than the one
    rule that carries it: a document the addon only half understands is a
    document whose selection it cannot reproduce, and reproducing it is what
    the rule-ID cross-check depends on."""

    def setUp(self):
        self.fixture = json.loads(_FIXTURE_PATH.read_text())
        self.temp_dir = tempfile.TemporaryDirectory()
        self.dir_patch = patch.object(
            nas_addon, "AUTHZ_DIR", self.temp_dir.name
        )
        self.dir_patch.start()
        nas_addon._authz_cache.clear()

    def tearDown(self):
        self.dir_patch.stop()
        self.temp_dir.cleanup()
        nas_addon._authz_cache.clear()

    def _path(self, session_id="sess-contract"):
        return Path(self.temp_dir.name) / f"{session_id}.json"

    def _write(self, value, session_id="sess-contract"):
        path = self._path(session_id)
        path.write_text(json.dumps(value))
        return path

    def _load(self, session_id="sess-contract"):
        return nas_addon._load_authz_document(session_id)

    def assert_invalid(self, document):
        nas_addon._authz_cache.clear()
        self._write(document)
        self.assertIs(self._load(), nas_addon._INVALID_AUTHZ_DOCUMENT)

    def _scope(self, document=None):
        return (document or self.fixture)["scopes"][0]

    def _messages_rule(self, document):
        return next(
            rule
            for rule in document["scopes"][0]["rules"]
            if rule["key"] == "messages"
        )

    def test_accepts_the_shared_anthropic_fixture(self):
        self._write(self.fixture)

        self.assertEqual(self._load(), self.fixture)

    def test_rejects_a_root_that_is_not_this_contract(self):
        cases = [
            ("top-level list", self.fixture["scopes"]),
            (
                "missing version",
                {k: v for k, v in self.fixture.items()
                 if k != "contractVersion"},
            ),
            ("older version", {**self.fixture, "contractVersion": 1}),
            ("newer version", {**self.fixture, "contractVersion": 3}),
            ("boolean version", {**self.fixture, "contractVersion": True}),
            (
                "missing scopes",
                {k: v for k, v in self.fixture.items() if k != "scopes"},
            ),
            ("non-list scopes", {**self.fixture, "scopes": {}}),
            ("allow as network fallback", {**self.fixture, "fallback": "allow"}),
            (
                "missing defaults",
                {k: v for k, v in self.fixture.items() if k != "defaults"},
            ),
        ]
        for name, document in cases:
            with self.subTest(name=name):
                self.assert_invalid(document)

    def test_rejects_a_key_the_addon_does_not_understand(self):
        cases = []

        document = copy.deepcopy(self.fixture)
        document["unknown"] = "SECRET-document"
        cases.append(("document", document))

        document = copy.deepcopy(self.fixture)
        self._scope(document)["unknown"] = "SECRET-scope"
        cases.append(("scope", document))

        document = copy.deepcopy(self.fixture)
        self._messages_rule(document)["unknown"] = "SECRET-rule"
        cases.append(("rule", document))

        document = copy.deepcopy(self.fixture)
        self._messages_rule(document)["match"]["unknown"] = "SECRET-match"
        cases.append(("match", document))

        document = copy.deepcopy(self.fixture)
        self._messages_rule(document)["expect"][0]["unknown"] = "SECRET-expect"
        cases.append(("acceptance condition", document))

        document = copy.deepcopy(self.fixture)
        self._scope(document)["targets"][0]["unknown"] = "SECRET-target"
        cases.append(("target", document))

        for name, document in cases:
            with self.subTest(name=name):
                self.assert_invalid(document)

    def test_rejects_a_rule_ID_that_does_not_name_its_own_scope_and_key(self):
        cases = [
            ("empty key", "key", ""),
            ("uppercase key", "key", "Messages"),
            ("bad key character", "key", "messages/create"),
            ("overlong key", "key", "a" + ("0" * 64)),
            ("non-string key", "key", 1),
            ("ID from another scope", "id", "other.messages"),
            ("ID that is only the key", "id", "messages"),
            ("non-string ID", "id", 1),
            ("unknown onMatch", "onMatch", "permit"),
            ("unknown onIndeterminate", "onIndeterminate", "allow"),
            ("unknown audit", "audit", "sometimes"),
        ]
        for name, field, value in cases:
            with self.subTest(name=name):
                document = copy.deepcopy(self.fixture)
                self._messages_rule(document)[field] = value
                self.assert_invalid(document)

    def test_rejects_a_precedence_edge_that_names_nothing(self):
        # 存在しないキーを黙って捨てると優先の辺が 1 本消える。消えた辺は
        # 「広い allow が狭い deny を追い越す」形になりうるので、辺を落とす
        # くらいならドキュメントごと拒否する。
        for precedes in (["absent"], ["messages"], "bootstrap", [1]):
            with self.subTest(precedes=precedes):
                document = copy.deepcopy(self.fixture)
                self._messages_rule(document)["precedes"] = precedes
                self.assert_invalid(document)

    def test_rejects_a_scope_whose_fallback_ID_or_targets_are_malformed(self):
        cases = [
            ("unknown fallback", "fallback", "permit"),
            ("empty name", "name", ""),
            ("mismatched fallback ID", "fallbackRuleId", "other.$fallback"),
            ("plain fallback ID", "fallbackRuleId", "anthropic.fallback"),
            ("no targets", "targets", []),
            ("non-list targets", "targets", {}),
        ]
        for name, field, value in cases:
            with self.subTest(name=name):
                document = copy.deepcopy(self.fixture)
                self._scope(document)[field] = value
                self.assert_invalid(document)

    def test_rejects_a_target_that_is_not_a_host_pattern_and_port(self):
        cases = [
            ("unknown host kind", {"kind": "regex", "pattern": ".*"}),
            ("empty exact host", {"kind": "exact", "host": ""}),
            ("exact host carrying a suffix", {"kind": "exact", "suffix": "x"}),
            ("non-object host", "api.anthropic.com"),
        ]
        for name, host in cases:
            with self.subTest(name=name):
                document = copy.deepcopy(self.fixture)
                self._scope(document)["targets"][0]["host"] = host
                self.assert_invalid(document)

        for port in (0, -1, 65_536, True, "443", 1.5):
            with self.subTest(port=port):
                document = copy.deepcopy(self.fixture)
                self._scope(document)["targets"][0]["port"] = port
                self.assert_invalid(document)

    def test_rejects_a_limit_above_its_ceiling_including_python_booleans(self):
        ceilings = {
            "maxBodyBytes": 33_554_432,
            "maxDepth": 64,
            "maxNodes": 200_000,
            "maxSelectorExpansions": 1_000_000,
        }
        for field, ceiling in ceilings.items():
            for value in (True, False, 0, -1, 1.5, str(ceiling), ceiling + 1):
                with self.subTest(field=field, value=value):
                    document = copy.deepcopy(self.fixture)
                    self._messages_rule(document)["limits"][field] = value
                    self.assert_invalid(document)

    def test_rejects_a_body_condition_or_path_pattern_it_cannot_evaluate(self):
        mutations = [
            (
                "unknown body format",
                lambda rule: rule["match"].__setitem__("bodyFormat", "yaml"),
            ),
            (
                "no path pattern",
                lambda rule: rule["match"].__setitem__("paths", []),
            ),
            (
                "non-list methods",
                lambda rule: rule["match"].__setitem__("methods", "POST"),
            ),
            (
                "empty method",
                lambda rule: rule["match"].__setitem__("methods", [""]),
            ),
            (
                "unknown segment kind",
                lambda rule: rule["match"]["paths"][0]["segments"][0]
                .__setitem__("kind", "regex"),
            ),
            (
                "non-string segment value",
                lambda rule: rule["match"]["paths"][0]["segments"][1]
                .__setitem__("values", [1]),
            ),
            (
                "non-boolean trailing star",
                lambda rule: rule["match"]["paths"][0]
                .__setitem__("trailingDoubleStar", "yes"),
            ),
        ]
        for name, mutate in mutations:
            with self.subTest(name=name):
                document = copy.deepcopy(self.fixture)
                mutate(self._messages_rule(document))
                self.assert_invalid(document)

    def test_rejects_an_acceptance_condition_it_cannot_run(self):
        mutations = [
            (
                "unknown kind",
                lambda expects: expects[0].__setitem__("kind", "graphql"),
            ),
            (
                "review is not implemented yet",
                lambda expects: expects[0].__setitem__(
                    "onViolation", "review"
                ),
            ),
            (
                "unknown consequence",
                lambda expects: expects[0].__setitem__("onViolation", "skip"),
            ),
            (
                "bad selector escape",
                lambda expects: expects[0].__setitem__("at", "/bad/~2"),
            ),
            (
                "embedded selector wildcard",
                lambda expects: expects[0].__setitem__("at", "/bad/prefix*"),
            ),
            # `*` を含むセグメントは _parse_selector がリテラル扱いするため、
            # 通すと受理条件が 0 ノードに一致して何も検査しなくなる
            # (fail-closed の制御が fail-open に転ぶ)。文字種によらず弾く。
            (
                "selector wildcard after punctuation",
                lambda expects: expects[0].__setitem__(
                    "at", "/messages/*/content:*"
                ),
            ),
            (
                "selector wildcard with non-ASCII",
                lambda expects: expects[0].__setitem__(
                    "at", "/messages/\u5185\u5bb9*"
                ),
            ),
            (
                "bad exclude selector",
                lambda expects: expects[0].__setitem__("exclude", ["/a*b"]),
            ),
            (
                "empty discriminator",
                lambda expects: expects[0].__setitem__("discriminator", ""),
            ),
            (
                "allowed not a list",
                lambda expects: expects[0].__setitem__("allowed", "text"),
            ),
            (
                "empty allowed",
                lambda expects: expects[0].__setitem__("allowed", []),
            ),
            (
                "non-string allowed tag",
                lambda expects: expects[0].__setitem__(
                    "allowed", ["text", 1]
                ),
            ),
            (
                "unknown root type",
                lambda expects: expects.__setitem__(
                    0,
                    {"kind": "jsonRoot", "onViolation": "deny",
                     "rootType": "scalar"},
                ),
            ),
        ]
        for name, mutate in mutations:
            with self.subTest(name=name):
                document = copy.deepcopy(self.fixture)
                mutate(self._messages_rule(document)["expect"])
                self.assert_invalid(document)

    def test_rejects_a_json_shaped_condition_on_a_rule_that_never_parses(self):
        # format が "json" でないルールに UnionShape / JsonRoot を置くと、
        # 検査は決して走らないのに設定は検査したつもりでいる。
        for body_format in (None, "none", "opaque"):
            with self.subTest(body_format=body_format):
                document = copy.deepcopy(self.fixture)
                self._messages_rule(document)["match"]["bodyFormat"] = (
                    body_format
                )
                self.assert_invalid(document)

    def test_accepts_literal_selector_segments_that_look_like_expressions(
        self,
    ):
        """式に見えるテキストはリテラルとして受け入れる (injection しない)。
        ただし `*` を含むものは別扱いで、上の rejects テストが押さえる。"""
        for selector in ("/$schema", "/foo|bar", r"/\d+", "/filter[?(@.x)]"):
            with self.subTest(selector=selector):
                nas_addon._authz_cache.clear()
                document = copy.deepcopy(self.fixture)
                self._messages_rule(document)["expect"][0]["at"] = selector
                self._write(document)
                self.assertEqual(self._load(), document)

    def test_rejects_a_secret_disposition_or_inject_it_cannot_honour(self):
        cases = [
            (
                "unknown disposition",
                lambda scope: scope.__setitem__("secrets", {"t": "hide"}),
            ),
            (
                "non-list inject",
                lambda scope: scope.__setitem__("inject", {}),
            ),
            (
                "inject without a header name",
                lambda scope: scope.__setitem__(
                    "inject", [{"name": "", "value": "literal:x"}]
                ),
            ),
            (
                "inject without a value",
                lambda scope: scope.__setitem__(
                    "inject", [{"name": "Authorization"}]
                ),
            ),
        ]
        for name, mutate in cases:
            with self.subTest(name=name):
                document = copy.deepcopy(self.fixture)
                mutate(self._scope(document))
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

        invalid = nas_addon._INVALID_AUTHZ_DOCUMENT
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

        self.assertIs(loaded, nas_addon._INVALID_AUTHZ_DOCUMENT)
        self.assertEqual(stderr.getvalue(), "")

    def test_caches_valid_and_invalid_states_until_mtime_changes(self):
        path = self._write(self.fixture)
        valid = self._load()
        with patch("builtins.open", side_effect=AssertionError("re-read")):
            self.assertIs(self._load(), valid)

        old_mtime = path.stat().st_mtime_ns
        path.write_text('{"contractVersion": 2, "scopes": "invalid"}')
        os.utime(
            path,
            ns=(old_mtime + 1_000_000, old_mtime + 1_000_000),
        )
        invalid = self._load()
        self.assertIs(invalid, nas_addon._INVALID_AUTHZ_DOCUMENT)
        with patch("builtins.open", side_effect=AssertionError("re-read")):
            self.assertIs(self._load(), invalid)


class ClassifyBodyTest(unittest.TestCase):
    """A body that is not there and a body that is there and empty are two
    different requests.

    Every `format` asks the body to exist, so an absent body satisfies none of
    them and the request falls through to a rule that asks for no body. An
    empty body satisfies `"opaque"` and `"none"`. mitmproxy reports `b""` for
    both, so the classification reads the framing headers instead."""

    def _classify(self, body, carries_body):
        return nas_addon._classify_body(body, 1024, carries_body)

    def test_no_framing_and_no_bytes_is_an_absent_body(self):
        self.assertEqual(self._classify(b"", False), ("absent", None))

    def test_declared_framing_and_no_bytes_is_an_empty_body(self):
        self.assertEqual(self._classify(b"", True), ("empty", None))

    def test_bytes_without_framing_still_count_as_a_body(self):
        self.assertEqual(self._classify(b'{"a":1}', False), ("json", {"a": 1}))

    def test_an_unreadable_body_stays_binary(self):
        self.assertEqual(self._classify(None, False), ("binary", None))

    def test_content_length_zero_declares_a_body(self):
        request = FakeRequest(headers=[("content-length", "0")])
        self.assertTrue(nas_addon._request_carries_body(request))

    def test_chunked_transfer_encoding_declares_a_body(self):
        request = FakeRequest(headers=[("transfer-encoding", "chunked")])
        self.assertTrue(nas_addon._request_carries_body(request))

    def test_a_request_without_framing_headers_declares_no_body(self):
        request = FakeRequest(headers=[("accept", "*/*")])
        self.assertFalse(nas_addon._request_carries_body(request))


class SelectionTest(unittest.TestCase):
    """The addon reproduces the host's selection on the host's document.

    Both sides run this; a divergence fails the request closed, so the two
    have to agree on every axis the host resolved."""

    def _document(self, scopes, fallback="deny"):
        return {
            "contractVersion": 2,
            "fallback": fallback,
            "defaults": {
                "limits": dict(_DEFAULT_LIMITS),
                "secrets": {"*": "mask"},
                "audit": "always",
            },
            "scopes": scopes,
        }

    def _scope(self, name, targets, rules=(), fallback="deny"):
        return {
            "name": name,
            "targets": list(targets),
            "fallback": fallback,
            "fallbackRuleId": f"{name}.$fallback",
            "limits": dict(_DEFAULT_LIMITS),
            "secrets": {},
            "inject": [],
            "audit": "always",
            "rules": list(rules),
        }

    def _exact(self, host, port=None):
        return {
            "source": host,
            "host": {"kind": "exact", "host": host},
            "port": port,
        }

    def _suffix(self, suffix, port=None):
        return {
            "source": f"*.{suffix}",
            "host": {"kind": "suffix", "suffix": suffix},
            "port": port,
        }

    def test_paths_are_compared_without_normalization(self):
        rule = _rule(key="messages", paths=["/v1/messages"])
        document = self._document([
            self._scope("api", [self._exact("api.anthropic.com")], [rule]),
        ])
        cases = [
            ("/v1/messages", "api.messages"),
            # クエリは選択に参加しない。
            ("/v1/messages?beta=true", "api.messages"),
            # 末尾スラッシュ・連続スラッシュ・パーセント符号化のいずれも
            # 正規化しないので、別のパスとして fallback に落ちる。
            ("/v1/messages/", "api.$fallback"),
            ("/v1//messages", "api.$fallback"),
            ("/v1/%6dessages", "api.$fallback"),
        ]
        for path, rule_id in cases:
            with self.subTest(path=path):
                decision = nas_addon._decide(
                    document, "api.anthropic.com", 443, "POST", path, "absent"
                )
                self.assertEqual(decision["ruleId"], rule_id)

    def test_method_and_trailing_double_star_narrow_the_candidates(self):
        rule = _rule(key="items", paths=["/api/v1/**"], scope="wide")
        rule["match"]["methods"] = ["GET"]
        document = self._document([
            self._scope(
                "wide", [self._suffix("example.com")], [rule], fallback="deny"
            ),
        ])

        def decide(method, host, path):
            return nas_addon._decide(
                document, host, 443, method, path, "absent"
            )["ruleId"]

        self.assertEqual(decide("GET", "sub.example.com", "/api/v1/items"),
                         "wide.items")
        self.assertEqual(decide("GET", "sub.example.com", "/api/v1"),
                         "wide.items")
        self.assertEqual(decide("POST", "sub.example.com", "/api/v1/items"),
                         "wide.$fallback")
        self.assertEqual(decide("GET", "sub.example.com", "/api/v10/items"),
                         "wide.$fallback")
        # サフィックスは真の部分ドメインだけに一致する。
        self.assertEqual(decide("GET", "example.com", "/api/v1/items"),
                         "$fallback")

    def test_the_narrowest_matching_scope_owns_the_target(self):
        document = self._document([
            # ドキュメントはターゲットの特異度の降順で届く。
            self._scope("exact", [self._exact("api.example.com")],
                        fallback="allow"),
            self._scope("wide", [self._suffix("example.com")],
                        fallback="deny"),
        ])
        self.assertEqual(
            nas_addon._decide(
                document, "api.example.com", 443, "GET", "/", "absent"
            )["action"],
            "allow",
        )
        self.assertEqual(
            nas_addon._decide(
                document, "other.example.com", 443, "GET", "/", "absent"
            )["action"],
            "deny",
        )

    def test_a_port_bound_target_does_not_claim_other_ports(self):
        document = self._document([
            self._scope("tls", [self._exact("api.example.com", 443)],
                        fallback="allow"),
        ], fallback="review")
        self.assertEqual(
            nas_addon._decide(
                document, "api.example.com", 443, "GET", "/", "absent"
            )["action"],
            "allow",
        )
        self.assertEqual(
            nas_addon._decide(
                document, "api.example.com", 80, "GET", "/", "absent"
            )["action"],
            "review",
        )

    def test_candidates_are_ordered_by_precedence_not_declaration(self):
        # 宣言順は broad が先。broad は json、narrow は none を要求するので、
        # 空ボディで broad を先に評価すると判定不能で打ち切られて deny に
        # なる。precedes が narrow を先に立てるからこそ allow になる。
        broad = _rule(key="broad", paths=["/v1/ping"], body_format="json")
        narrow = _rule(key="narrow", paths=["/v1/ping"], body_format="none")
        narrow["precedes"] = ["broad"]
        document = self._document([
            self._scope("api", [self._exact("api.example.com")],
                        [broad, narrow]),
        ])
        decision = nas_addon._decide(
            document, "api.example.com", 443, "POST", "/v1/ping", "empty"
        )
        self.assertEqual(
            (decision["ruleId"], decision["action"], decision["reason"]),
            ("api.narrow", "allow", "rule"),
        )

    def test_only_this_request_s_candidates_take_part_in_the_order(self):
        # broad と narrow の相対順序は、この 2 本だけで決まらなければ
        # ならない。候補になれない 3 本目が並べ替えに口を出すと、
        # 無関係なルールを 1 本足すだけで deny と allow が入れ替わる。
        broad = _rule(key="broad", paths=["/v1/ping"], body_format="json")
        narrow = _rule(key="narrow", paths=["/v1/ping"], body_format="none")
        narrow["precedes"] = ["broad"]
        unrelated = _rule(key="unrelated", paths=["/v1/other"])
        unrelated["precedes"] = ["narrow"]
        document = self._document([
            self._scope(
                "api",
                [self._exact("api.example.com")],
                [unrelated, broad, narrow],
            ),
        ])
        decision = nas_addon._decide(
            document, "api.example.com", 443, "POST", "/v1/ping", "empty"
        )
        self.assertEqual(decision["ruleId"], "api.narrow")

    def test_an_indeterminate_body_stops_the_walk_at_that_candidate(self):
        # 壊れたボディを送れば狭いルールを回避できる、という抜け道を塞ぐ。
        narrow = _rule(key="narrow", paths=["/v1/ping"], body_format="json")
        narrow["precedes"] = ["broad"]
        narrow["onIndeterminate"] = "deny"
        broad = _rule(key="broad", paths=["/v1/ping"])
        broad["onMatch"] = "allow"
        document = self._document([
            self._scope("api", [self._exact("api.example.com")],
                        [narrow, broad], fallback="allow"),
        ])
        decision = nas_addon._decide(
            document, "api.example.com", 443, "POST", "/v1/ping", "binary"
        )
        self.assertEqual(
            (decision["action"], decision["reason"], decision["ruleId"]),
            ("deny", "indeterminate", "api.narrow"),
        )

    def test_a_cyclic_precedence_denies_rather_than_guessing(self):
        a = _rule(key="a", paths=["/x"])
        b = _rule(key="b", paths=["/x"])
        a["precedes"] = ["b"]
        b["precedes"] = ["a"]
        a["onMatch"] = "allow"
        b["onMatch"] = "allow"
        document = self._document([
            self._scope("api", [self._exact("api.example.com")], [a, b],
                        fallback="allow"),
        ])
        decision = nas_addon._decide(
            document, "api.example.com", 443, "POST", "/x", "absent"
        )
        self.assertEqual(
            (decision["action"], decision["reason"]),
            ("deny", "unorderable-candidates"),
        )

    def test_body_format_is_three_valued(self):
        evaluate = nas_addon._evaluate_body_format
        self.assertEqual(evaluate(None, "absent"), "true")
        self.assertEqual(evaluate("none", "absent"), "false")
        self.assertEqual(evaluate("none", "empty"), "true")
        self.assertEqual(evaluate("none", "json"), "false")
        self.assertEqual(evaluate("opaque", "binary"), "true")
        self.assertEqual(evaluate("opaque", "absent"), "false")
        self.assertEqual(evaluate("json", "json"), "true")
        # 0 バイトも壊れたボディも「偽」ではなく判定不能である。
        self.assertEqual(evaluate("json", "empty"), "indeterminate")
        self.assertEqual(evaluate("json", "binary"), "indeterminate")


class RuleBudgetSelectionTest(unittest.TestCase):
    """The chosen rule's own `maxBodyBytes` settles its body condition.

    Classification runs before selection, so it can only spend the scope's
    budget. A rule that asked for a smaller one never had its body read within
    the budget it declared, and a body it could not read cannot make its
    `json` condition true."""

    def _document(self, rule, scope_budget=None):
        scope_limits = dict(_DEFAULT_LIMITS)
        if scope_budget is not None:
            scope_limits["maxBodyBytes"] = scope_budget
        document = _flow_document([rule])
        document["scopes"][0]["limits"] = scope_limits
        return document

    def _decide(self, rule, body_kind, body_size, scope_budget=None):
        return nas_addon._decide_under_rule_budget(
            self._document(rule, scope_budget),
            "api.example.com", 443, "POST", "/v1/messages",
            body_kind, body_size,
        )

    def _budgeted(self, max_body_bytes, **overrides):
        rule = _messages_rule(**overrides)
        rule["limits"] = dict(rule["limits"], maxBodyBytes=max_body_bytes)
        return rule

    def test_a_body_over_the_rules_budget_is_indeterminate(self):
        decision, body_kind = self._decide(self._budgeted(16), "json", 4096)

        self.assertEqual(
            (decision["action"], decision["reason"], decision["ruleId"]),
            ("deny", "indeterminate", "api.messages"),
        )
        self.assertEqual(body_kind, "binary")
        self.assertIsNone(decision["rule"])

    def test_a_body_within_the_rules_budget_matches(self):
        decision, body_kind = self._decide(self._budgeted(4096), "json", 16)

        self.assertEqual(
            (decision["action"], decision["reason"], decision["ruleId"]),
            ("allow", "rule", "api.messages"),
        )
        self.assertEqual(body_kind, "json")

    def test_the_budget_moves_the_verdict_and_not_the_rule(self):
        """A tighter budget only turns a `json` condition from true to
        indeterminate. Every other condition keeps its value, and both truth
        values stop the walk at the same candidate, so the rule whose budget
        was applied stays the rule the re-run names."""
        opaque = self._budgeted(16)
        opaque["match"]["bodyFormat"] = "opaque"
        decision, body_kind = self._decide(opaque, "json", 4096)

        self.assertEqual(
            (decision["action"], decision["reason"], decision["ruleId"]),
            ("allow", "rule", "api.messages"),
        )
        self.assertEqual(body_kind, "binary")

    def test_a_body_that_could_not_be_read_has_no_size_to_compare(self):
        decision, body_kind = self._decide(self._budgeted(16), "binary", None)

        self.assertEqual(decision["reason"], "indeterminate")
        self.assertEqual(body_kind, "binary")

    def test_a_rule_cannot_widen_the_budget_its_scope_spent(self):
        """The scope's budget is the one that was actually spent on the parse.
        Raising `maxBodyBytes` on the rule does not get the body re-read, so a
        body the scope refused to parse stays unparsed."""
        decision, body_kind = self._decide(
            self._budgeted(4096), "binary", 1024, scope_budget=16
        )

        self.assertEqual(decision["reason"], "indeterminate")
        self.assertEqual(body_kind, "binary")


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


_DEFAULT_LIMITS = {
    "maxBodyBytes": 33_554_432,
    "maxDepth": 64,
    "maxNodes": 200_000,
    "maxSelectorExpansions": 1_000_000,
}


# The expansion ceiling moved out of the addon and into each rule's limits,
# so a test that wants a small budget sets the default the helpers build rules
# from rather than patching a module constant.
_EXPANSION_CEILING = [1_000_000]


@contextlib.contextmanager
def _expansion_ceiling(value):
    previous = _EXPANSION_CEILING[0]
    _EXPANSION_CEILING[0] = value
    try:
        yield
    finally:
        _EXPANSION_CEILING[0] = previous


def _rule(
    expects=(), body_format=None, key="messages", paths=None, scope="api",
    **limits,
):
    """A resolved rule, in the shape the host writes and the addon re-checks."""
    budget = dict(_DEFAULT_LIMITS)
    budget["maxSelectorExpansions"] = _EXPANSION_CEILING[0]
    budget.update(limits)
    return {
        "id": f"{scope}.{key}",
        "key": key,
        "precedes": [],
        "match": {
            "methods": ["POST"],
            "paths": [_path_pattern(pattern) for pattern in (paths or ["/v1/messages"])],
            "bodyFormat": body_format,
        },
        "onMatch": "allow",
        "onIndeterminate": "deny",
        "expect": list(expects),
        "limits": budget,
        "secrets": {},
        "inject": [],
        "audit": "always",
    }


def _path_pattern(source):
    segments = []
    trailing = False
    for token in source.split("/"):
        if token == "**":
            trailing = True
            continue
        if token == "*":
            segments.append({"kind": "all"})
        else:
            segments.append({"kind": "finite", "values": [token]})
    return {
        "source": source,
        "segments": segments,
        "trailingDoubleStar": trailing,
    }


def _union_shape(guard, on_violation="deny"):
    """Translate the old guard spelling into an acceptance condition."""
    return {
        "kind": "unionShape",
        "onViolation": on_violation,
        "at": guard["at"],
        "exclude": list(guard.get("exclude") or []),
        "discriminator": guard["discriminator"],
        "allowed": list(guard["allowedTags"]),
    }


def _json_policy(guards=(), **limits):
    """A rule that reads the body as JSON and requires an object at the root.

    The old JSON policy hard-coded "the root must be an object"; that is now
    an ordinary acceptance condition, so it is spelled out here."""
    return _rule(
        expects=[_union_shape(guard) for guard in guards]
        + [{"kind": "jsonRoot", "onViolation": "deny", "rootType": "object"}],
        body_format="json",
        **limits,
    )


def _bodyless_policy():
    """A rule that refuses a body, the way the old bodyless policy did."""
    return _rule(expects=[{"kind": "emptyBody", "onViolation": "deny"}])


def _execute_request_policy(rule, body, patterns):
    """Classify the body, apply the rule's body condition, then inspect.

    The addon does these in two places — selection reads the classification,
    inspection reads the tree — so a test that only called the inspector
    would miss the half of the outcome that selection decides. A body that
    cannot be parsed no longer reaches inspection at all: it makes the body
    condition indeterminate, and the rule's `onIndeterminate` (deny here)
    settles it."""
    if body is None:
        return "block", None, "body-unavailable"
    limits = rule["limits"]
    # The caller handed a body over, so the request declared one: these cases
    # are about what the body contains, not about whether it is there.
    kind, parsed = nas_addon._classify_body(
        body, limits["maxBodyBytes"], True
    )
    truth = nas_addon._evaluate_body_format(rule["match"]["bodyFormat"], kind)
    if truth == "indeterminate":
        over_budget = len(body) > limits["maxBodyBytes"]
        return "block", None, (
            "resource-limit" if over_budget else "invalid-json"
        )
    if truth == "false":
        return "block", None, "unexpected-body"
    return nas_addon._inspect_body(rule, body, parsed, patterns)


def _validate_tagged_unions(root, guards, patterns, budget):
    """Evaluate guard-shaped acceptance conditions and return the findings."""
    _severity, findings = nas_addon._evaluate_expects(
        [_union_shape(guard) for guard in guards], b"{}", root, patterns,
        budget,
    )
    return findings


class RequestPolicyBodylessEngineTest(unittest.TestCase):
    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["SECRET123"])

    def _run(self, body):
        return _execute_request_policy(_bodyless_policy(), body, self.patterns)

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
        return _execute_request_policy(
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
        policy = _json_policy(guards=guards)
        return _execute_request_policy(
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
        fixture = json.loads(_FIXTURE_PATH.read_text())
        assert nas_addon._is_valid_authz_document(fixture)
        cls.rule = next(
            rule
            for scope in fixture["scopes"]
            for rule in scope["rules"]
            if rule["id"] == "anthropic.messages"
        )
        assert cls.rule["match"]["bodyFormat"] == "json"

    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["SECRET123"])

    def _run(self, body_obj):
        return _execute_request_policy(
            self.rule, json.dumps(body_obj).encode("utf-8"), self.patterns
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

    def test_a_secret_inside_a_base64_payload_is_still_masked(self):
        """base64 blob の中の秘密は、blob を復号せずにマスク層が捕まえる。

        マスクのパターン集合は秘密ごとに base64 の確定部分文字列を含むので、
        運び手を宣言して復号する仕組み (旧 encodedFields) は要らない。代償は
        出力が正常な blob でなく壊れた blob になることで、それが起きるのは
        秘密が漏れかけたときだけである。"""
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
        self.assertNotEqual(data, blob)
        self.assertNotIn(b"SECRET123", out)


class RequestPolicySelectorArrayIndexTest(unittest.TestCase):
    """Literal segments follow JSON Pointer semantics: a literal that is a
    valid array index descends into a list. Without this the selector matches
    nothing and the guard silently fails open."""

    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["SECRET123"])

    def _run(self, body_obj, at, tags=("text",)):
        policy = _json_policy(guards=[{
            "at": at, "discriminator": "type", "allowedTags": list(tags),
        }])
        return _execute_request_policy(
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


def _tagged_union(at, tags=("text",), exclude=None):
    guard = {"at": at, "discriminator": "type", "allowedTags": list(tags)}
    if exclude is not None:
        guard["exclude"] = list(exclude)
    return guard


def _selector_budget():
    """The shared budget a rule's body inspection draws on. Read the
    expansion ceiling at call time so `_expansion_ceiling` still takes
    effect."""
    return nas_addon._SelectorBudget(_EXPANSION_CEILING[0])


class RequestPolicySelectorExpansionBoundTest(unittest.TestCase):
    """Selector evaluation memoizes (JSON Pointer, segment-index) states, so
    multiple `**` segments cannot multiply the work done per node, and the
    expansion ceiling is one allowance for the whole body inspection rather
    than one per walk, so the number of guards cannot multiply it either."""

    def _collect(self, document, selector):
        segments = nas_addon._parse_selector(selector)
        budget = _selector_budget()
        matches = nas_addon._collect_selector_matches(
            document, segments, budget
        )
        return segments, matches, budget.spent_expansions

    def _walk_cost(self, document, selector):
        _segments, _matches, expansions = self._collect(document, selector)
        return expansions

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
                # Each (pointer, segment-index) state is expanded at most
                # once, and a pointer addresses one position in the document.
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
                    [(pointer, id(node)) for pointer, node in matches],
                    [(pointer, id(node)) for pointer, node in baseline],
                )

    def test_successive_guards_draw_on_one_shared_budget(self):
        # Neither guard's walk reaches the ceiling on its own, so a fresh
        # allowance per guard would let both finish and the body would pass.
        # They spend from one allowance, so the second guard runs out.
        document = {"content": [{"type": "text"}],
                    "system": [{"type": "text"}]}
        ceiling = 4
        for selector in ("/content/*", "/system/*"):
            self.assertLessEqual(
                self._walk_cost(document, selector), ceiling
            )
        guards = [_tagged_union("/content/*"), _tagged_union("/system/*")]
        patterns = nas_addon._build_mask_patterns(["SECRET123"])
        with _expansion_ceiling(ceiling):
            for guard in guards:
                with self.subTest(guard=guard["at"]):
                    self.assertEqual(
                        _validate_tagged_unions(
                            document, [guard], patterns, _selector_budget()
                        ),
                        [],
                    )
            findings = _validate_tagged_unions(
                document, guards, patterns, _selector_budget()
            )
        self.assertEqual(
            [f["kind"] for f in findings], ["inspection-incomplete"]
        )
        # The finding names the guard whose walk ran out, not the first one.
        self.assertEqual(findings[0]["at"], "/system/*")
        self.assertEqual(findings[0]["pointer"], "/system")

    def test_exclude_and_at_walks_of_one_guard_share_the_budget(self):
        # The exclude walk is the expensive one here; the `at` walk that
        # follows it inherits what is left rather than starting over.
        document = {"content": [{"type": "text"}],
                    "system": [{"type": "text"}]}
        ceiling = 8
        for selector in ("/system/**", "/content/*"):
            self.assertLessEqual(
                self._walk_cost(document, selector), ceiling
            )
        guard = _tagged_union("/content/*", exclude=["/system/**"])
        with _expansion_ceiling(ceiling):
            findings = _validate_tagged_unions(
                document, [guard], nas_addon._build_mask_patterns([]),
                _selector_budget(),
            )
        self.assertEqual(
            [f["kind"] for f in findings], ["inspection-incomplete"]
        )
        self.assertEqual(findings[0]["at"], "/content/*")
        self.assertEqual(findings[0]["pointer"], "/content")

    def test_shared_budget_exhaustion_blocks_the_request(self):
        # End to end: an inspection that ran out is not a pass, whichever
        # guard happened to spend the last of the budget.
        document = {"content": [{"type": "text"}],
                    "system": [{"type": "text"}]}
        # 2 歩は 1 本目の走査で使い切る。2 本目が同じ残量から引くからこそ、
        # 「どちらの受理条件が最後の 1 歩を使ったか」に関わらず未完了になる。
        policy = _json_policy(
            guards=[
                _tagged_union("/content/*"), _tagged_union("/system/*"),
            ],
            maxSelectorExpansions=2,
        )
        self.assertEqual(
            _execute_request_policy(
                policy,
                json.dumps(document).encode("utf-8"),
                nas_addon._build_mask_patterns(["SECRET123"]),
            ),
            ("block", None, "resource-limit"),
        )

    def test_bounded_traversal_keeps_guard_semantics(self):
        document = {"content": [
            {"type": "text", "content": [{"type": "future"}]},
        ]}
        policy = _json_policy(guards=[{
            "at": "/**/**/content/*",
            "discriminator": "type",
            "allowedTags": ["text"],
        }])
        self.assertEqual(
            _execute_request_policy(
                policy,
                json.dumps(document).encode("utf-8"),
                nas_addon._build_mask_patterns(["SECRET123"]),
            ),
            ("block", None, "schema-mismatch"),
        )


class RequestPolicySelectorExcludeTest(unittest.TestCase):
    """`exclude` cuts a whole subtree out of the selector walk, so nothing
    inside it is inspected. This is what lets one `/**/content/*` guard
    replace an enumeration of the positions a content block may appear in."""

    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["SECRET123"])

    def _run(self, body_obj, at, exclude=None, tags=("text",)):
        return _execute_request_policy(
            _json_policy(guards=[_tagged_union(at, tags, exclude)]),
            json.dumps(body_obj).encode("utf-8"),
            self.patterns,
        )

    def _tool_schema_body(self):
        # `/**/content/*` also reaches a JSON Schema below tools[], whose
        # {"type": "string"} is not a content block.
        return {
            "tools": [
                {"input_schema": {"properties": {"content": {
                    "type": "string",
                }}}}
            ],
            "messages": [{"content": [{"type": "text"}]}],
        }

    def test_body_that_only_violates_inside_the_exclusion_passes(self):
        result, _out, reason = self._run(
            self._tool_schema_body(), "/**/content/*", exclude=["/tools/**"]
        )
        self.assertEqual((result, reason), ("pass", "recognized-json"))

    def test_the_same_body_without_exclude_still_blocks(self):
        self.assertEqual(
            self._run(self._tool_schema_body(), "/**/content/*"),
            ("block", None, "schema-mismatch"),
        )

    def test_violation_outside_the_exclusion_still_blocks(self):
        body = self._tool_schema_body()
        body["messages"] = [{"content": [{"type": "future"}]}]
        self.assertEqual(
            self._run(body, "/**/content/*", exclude=["/tools/**"]),
            ("block", None, "schema-mismatch"),
        )

    def test_excluded_node_is_cut_together_with_its_descendants(self):
        # "/tools" addresses the array itself; its elements go with it.
        result, _out, reason = self._run(
            self._tool_schema_body(), "/**/content/*", exclude=["/tools"]
        )
        self.assertEqual((result, reason), ("pass", "recognized-json"))

    def test_exclusion_does_not_hide_an_equal_value_elsewhere(self):
        # Python hands out one shared object for small ints, so a walk that
        # remembers where it has been by object identity would treat the
        # second 1 as already visited and let it through unchecked.
        body = {"tools": {"content": [1]}, "messages": {"content": [1]}}
        self.assertEqual(
            self._run(body, "/*/content/*", exclude=["/tools/content/*"]),
            ("block", None, "schema-mismatch"),
        )

    def test_exclude_selector_supports_wildcards(self):
        body = {"a": {"content": [{"type": "future"}]},
                "b": {"content": [{"type": "text"}]}}
        result, _out, reason = self._run(
            body, "/**/content/*", exclude=["/*/content/0"]
        )
        self.assertEqual((result, reason), ("pass", "recognized-json"))


class RequestPolicyViolationFindingTest(unittest.TestCase):
    """Every violation is collected, not just the first, and each one is
    reported with enough detail to be reviewed on its own."""

    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["SECRET123"])

    def _findings(self, body_obj, guards):
        parsed = json.loads(json.dumps(body_obj))
        return _validate_tagged_unions(
            parsed, guards, self.patterns, _selector_budget()
        )

    def test_valid_body_produces_no_findings(self):
        self.assertEqual(
            self._findings(
                {"content": [{"type": "text"}]},
                [_tagged_union("/**/content/*")],
            ),
            [],
        )

    def test_every_guard_is_evaluated_not_only_the_first(self):
        findings = self._findings(
            {"content": [{"type": "future"}],
             "system": [{"type": "legacy"}]},
            [_tagged_union("/**/content/*"), _tagged_union("/**/system/*")],
        )
        self.assertEqual(
            [(f["at"], f["value"]) for f in findings],
            [("/**/content/*", "future"), ("/**/system/*", "legacy")],
        )

    def test_distinct_unknown_tags_are_separate_findings(self):
        findings = self._findings(
            {"content": [{"type": "future"}, {"type": "legacy"}]},
            [_tagged_union("/**/content/*")],
        )
        self.assertEqual(
            [(f["value"], f["pointer"], f["count"]) for f in findings],
            [("future", "/content/0", 1), ("legacy", "/content/1", 1)],
        )

    def test_repeated_unknown_tag_is_one_finding_with_a_count(self):
        findings = self._findings(
            {"content": [{"type": "future"}, {"type": "future"}]},
            [_tagged_union("/**/content/*")],
        )
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["count"], 2)
        self.assertEqual(findings[0]["pointer"], "/content/0")

    def test_finding_names_the_acceptance_condition_and_its_selector(self):
        findings = self._findings(
            {"content": [{"type": "future"}]},
            [_tagged_union("/**/content/*")],
        )
        self.assertEqual(findings[0]["expect"], 0)
        self.assertEqual(findings[0]["expectKind"], "unionShape")
        self.assertEqual(findings[0]["at"], "/**/content/*")
        self.assertEqual(findings[0]["kind"], "schema-mismatch")

    def test_pointer_escapes_reserved_characters(self):
        findings = self._findings(
            {"a/b": {"c~d": [{"type": "future"}]}},
            [_tagged_union("/a~1b/c~0d/*")],
        )
        self.assertEqual(findings[0]["pointer"], "/a~1b/c~0d/0")

    def test_pointer_masks_a_secret_used_as_an_object_key(self):
        findings = self._findings(
            {"k-SECRET123": {"content": [{"type": "future"}]}},
            [_tagged_union("/**/content/*")],
        )
        self.assertEqual(findings[0]["pointer"], "/k-****/content/0")

    def test_pointer_masks_a_secret_that_pointer_escaping_would_hide(self):
        # The key holds the secret across characters a pointer escapes, so in
        # the raw pointer the secret is spelled "SEC~1RET~012" and masking the
        # pointer as one flat string would not match it at all.
        patterns = nas_addon._build_mask_patterns(["SEC/RET~12"])
        parsed = json.loads(json.dumps(
            {"k-SEC/RET~12": {"content": [{"type": "future"}]}}
        ))
        findings = _validate_tagged_unions(
            parsed, [_tagged_union("/**/content/*")], patterns,
            _selector_budget(),
        )
        # Masked, and still a pointer: separators and escaping intact.
        self.assertEqual(findings[0]["pointer"], "/k-****/content/0")

    def test_pointer_masks_a_secret_that_spans_a_separator(self):
        # The secret is split across two keys, so in the pointer it is spelled
        # with the "/" that separates them. Masking token by token never sees
        # it; the two tokens have to collapse into one masked token.
        patterns = nas_addon._build_mask_patterns(["aws/key123"])
        parsed = json.loads(json.dumps(
            {"aws": {"key123": {"content": [{"type": "future"}]}}}
        ))
        findings = _validate_tagged_unions(
            parsed, [_tagged_union("/**/content/*")], patterns,
            _selector_budget(),
        )
        self.assertEqual(findings[0]["pointer"], "/****/content/0")

    def test_pointer_masks_a_secret_spanning_an_escaped_token(self):
        # Both hard cases at once: the secret spans the separator between two
        # keys, and each key holds a character the pointer escapes. It matches
        # neither the raw pointer ("a~0b/c~1d") nor any single token.
        patterns = nas_addon._build_mask_patterns(["a~b/c/d"])
        parsed = json.loads(json.dumps(
            {"a~b": {"c/d": {"content": [{"type": "future"}]}}}
        ))
        findings = _validate_tagged_unions(
            parsed, [_tagged_union("/**/content/*")], patterns,
            _selector_budget(),
        )
        self.assertEqual(findings[0]["pointer"], "/****/content/0")

    def test_pointer_masking_leaves_untouched_tokens_escaped(self):
        # Only the tokens the secret covered may collapse. The rest keep their
        # own separators and their own "~0"/"~1" escaping.
        patterns = nas_addon._build_mask_patterns(["aws/key123"])
        parsed = json.loads(json.dumps(
            {"aws": {"key123": {"x/y": {"z~w": [{"type": "future"}]}}}}
        ))
        findings = _validate_tagged_unions(
            parsed, [_tagged_union("/**/z~0w/*")], patterns,
            _selector_budget(),
        )
        self.assertEqual(findings[0]["pointer"], "/****/x~1y/z~0w/0")

    def test_node_without_a_tag_has_no_value(self):
        findings = self._findings(
            {"content": [{"text": "hi"}, "bare-string", {"type": 1}]},
            [_tagged_union("/**/content/*")],
        )
        self.assertEqual(len(findings), 1)
        self.assertIsNone(findings[0]["value"])
        self.assertEqual(findings[0]["count"], 3)

    def test_excerpt_covers_the_violating_node_only(self):
        findings = self._findings(
            {"other": "sibling-value",
             "content": [{"type": "future", "text": "hi"}]},
            [_tagged_union("/**/content/*")],
        )
        self.assertEqual(
            findings[0]["excerpt"], '{"type":"future","text":"hi"}'
        )

    def test_reported_value_masks_secrets(self):
        findings = self._findings(
            {"content": [{"type": "tag-SECRET123"}]},
            [_tagged_union("/**/content/*")],
        )
        self.assertEqual(findings[0]["value"], "tag-****")

    def test_excerpt_masks_secrets(self):
        findings = self._findings(
            {"content": [{"type": "future", "text": "x SECRET123 y"}]},
            [_tagged_union("/**/content/*")],
        )
        self.assertNotIn("SECRET123", findings[0]["excerpt"])
        self.assertIn("****", findings[0]["excerpt"])

    def test_excerpt_masks_secrets_that_json_escaping_would_hide(self):
        # json.dumps escapes quotes, backslashes and newlines, and the mask
        # patterns hold the raw secret bytes. A secret masked only after
        # serialization would no longer match and would be printed verbatim.
        for secret in ('ab"cd-efgh', "ab\\cd-efgh", "line1\nline2-efgh"):
            with self.subTest(secret=secret):
                patterns = nas_addon._build_mask_patterns([secret])
                parsed = json.loads(json.dumps(
                    {"content": [{"type": "future", "text": f"x{secret}y"}]}
                ))
                findings = _validate_tagged_unions(
                    parsed, [_tagged_union("/**/content/*")], patterns,
                    _selector_budget(),
                )
                excerpt = findings[0]["excerpt"]
                self.assertNotIn(secret, excerpt)
                self.assertNotIn(json.dumps(secret)[1:-1], excerpt)
                self.assertIn("****", excerpt)

    def test_excerpt_masks_a_secret_spelled_as_a_number(self):
        patterns = nas_addon._build_mask_patterns(["31415926535"])
        parsed = json.loads(json.dumps(
            {"content": [{"type": "future", "pin": 31415926535}]}
        ))
        findings = _validate_tagged_unions(
            parsed, [_tagged_union("/**/content/*")], patterns,
            _selector_budget(),
        )
        self.assertNotIn("31415926535", findings[0]["excerpt"])
        self.assertIn("****", findings[0]["excerpt"])

    def test_excerpt_masks_a_secret_used_as_an_object_key(self):
        findings = self._findings(
            {"content": [{"type": "future", "k-SECRET123": "v"}]},
            [_tagged_union("/**/content/*")],
        )
        self.assertNotIn("SECRET123", findings[0]["excerpt"])
        self.assertIn("****", findings[0]["excerpt"])

    def test_excerpt_is_cut_off_by_depth(self):
        deep = {"type": "future"}
        for _ in range(nas_addon.EXCERPT_MAX_DEPTH + 2):
            deep = {"nested": deep}
        findings = self._findings(
            {"content": [deep]}, [_tagged_union("/**/content/*")]
        )
        self.assertNotIn("future", findings[0]["excerpt"])
        self.assertIn(nas_addon.EXCERPT_ELIDED, findings[0]["excerpt"])

    def test_excerpt_is_cut_off_by_bytes(self):
        text = "x" * (nas_addon.EXCERPT_MAX_BYTES + 100)
        self.assertLess(len(text), nas_addon.EXCERPT_MASK_BUDGET)
        findings = self._findings(
            {"content": [{"type": "future", "text": text}]},
            [_tagged_union("/**/content/*")],
        )
        excerpt = findings[0]["excerpt"]
        self.assertLessEqual(
            len(excerpt.encode("utf-8")),
            nas_addon.EXCERPT_MAX_BYTES + len(nas_addon.EXCERPT_ELIDED),
        )
        self.assertTrue(excerpt.endswith(nas_addon.EXCERPT_ELIDED))

    def test_excerpt_is_cut_off_by_width(self):
        wide = {"type": "future"}
        wide.update({f"k{i}": i for i in range(nas_addon.EXCERPT_MAX_WIDTH)})
        findings = self._findings(
            {"content": [wide]}, [_tagged_union("/**/content/*")]
        )
        excerpt = findings[0]["excerpt"]
        self.assertIn('"type":"future"', excerpt)
        self.assertIn(nas_addon.EXCERPT_ELIDED, excerpt)
        self.assertIn('"k0"', excerpt)
        first_dropped = f'"k{nas_addon.EXCERPT_MAX_WIDTH - 1}"'
        self.assertNotIn(first_dropped, excerpt)

    def test_excerpt_elides_a_scalar_too_large_to_scan(self):
        findings = self._findings(
            {"content": [{
                "type": "future",
                "text": "x" * (nas_addon.EXCERPT_MASK_BUDGET + 1),
            }]},
            [_tagged_union("/**/content/*")],
        )
        excerpt = findings[0]["excerpt"]
        self.assertEqual(
            excerpt, '{"type":"future","text":"%s"}' % nas_addon.EXCERPT_ELIDED
        )

    def test_excerpt_scan_work_is_bounded_by_the_budget(self):
        # The violating node is attacker-controlled and can hold most of the
        # body. Masking scans its text once per pattern, so the excerpt must
        # bound how much text it scans, not only how much it prints.
        huge = {"type": "future",
                "items": [{"note": "y" * 1_000} for _ in range(5_000)],
                "blob": "z" * 1_000_000}
        scanned = []
        real_mask_bytes = nas_addon._mask_bytes

        def counting_mask_bytes(data, patterns):
            scanned.append(len(data))
            return real_mask_bytes(data, patterns)

        with patch.object(nas_addon, "_mask_bytes", counting_mask_bytes):
            findings = self._findings(
                {"content": [huge]}, [_tagged_union("/**/content/*")]
            )
        self.assertLessEqual(sum(scanned), 8 * nas_addon.EXCERPT_MASK_BUDGET)
        # Bounded, but still recognizable as the node that violated.
        self.assertIn('"type":"future"', findings[0]["excerpt"])


class RequestPolicyAllowedViolationTest(unittest.TestCase):
    """A violation that was let through has to say so in the outcome.

    `onViolation = "allow"` is the one setting that lets a request the rule
    itself calls wrong reach the network, which is why a rule that uses it
    cannot also turn its audit off. The record it leaves is the only trace
    that the violation happened, so nothing else the inspection did may
    overwrite the reason that names it."""

    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["SECRET123"])

    def _rule_allowing_violations(self):
        return _rule(
            expects=[_union_shape(
                _tagged_union("/content/*"), on_violation="allow"
            )],
            body_format="json",
        )

    def _inspect(self, body):
        return nas_addon._inspect_body(
            self._rule_allowing_violations(),
            body,
            json.loads(body),
            self.patterns,
        )

    def test_an_allowed_violation_is_reported_when_nothing_is_masked(self):
        result, rewritten, reason = self._inspect(
            b'{"content":[{"type":"future"}]}'
        )
        self.assertEqual((result, rewritten), ("pass", None))
        self.assertEqual(reason, "violations-allowed")

    def test_an_allowed_violation_survives_the_body_being_masked(self):
        result, rewritten, reason = self._inspect(
            b'{"content":[{"type":"future","note":"SECRET123"}]}'
        )
        self.assertEqual(result, "rewrite")
        self.assertEqual(
            rewritten, b'{"content":[{"type":"future","note":"****"}]}'
        )
        self.assertEqual(reason, "violations-allowed")

    def test_a_masked_body_with_no_violation_still_reports_the_rewrite(self):
        result, _rewritten, reason = self._inspect(
            b'{"content":[{"type":"text","note":"SECRET123"}]}'
        )
        self.assertEqual((result, reason), ("rewrite", "masked-json"))


class RequestPolicyFindingCapTest(unittest.TestCase):
    """Violations are grouped by a value taken from the request body, so a
    body that spends a fresh value at every node produces a fresh finding at
    every node. The retained list is capped; the counts are not."""

    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["SECRET123"])

    def _findings(self, tags, cap=4):
        parsed = json.loads(json.dumps(
            {"content": [{"type": tag} for tag in tags]}
        ))
        with patch.object(nas_addon, "MAX_RETAINED_FINDINGS", cap):
            return _validate_tagged_unions(
                parsed, [_tagged_union("/**/content/*")], self.patterns,
                _selector_budget(),
            )

    def test_no_truncation_marker_when_the_cap_is_not_reached(self):
        findings = self._findings(["a", "b", "c", "d"])
        self.assertEqual(
            [f["kind"] for f in findings], ["schema-mismatch"] * 4
        )

    def test_distinct_violations_past_the_cap_are_not_retained(self):
        findings = self._findings(["a", "b", "c", "d", "e", "f"])
        self.assertEqual(
            [f["value"] for f in findings if f["kind"] == "schema-mismatch"],
            ["a", "b", "c", "d"],
        )

    def test_a_finding_reports_that_retention_was_capped(self):
        findings = self._findings(["a", "b", "c", "d", "e", "f"])
        truncated = findings[-1]
        self.assertEqual(truncated["kind"], "findings-truncated")
        self.assertEqual(truncated["count"], 2)
        self.assertIsNone(truncated["value"])
        self.assertIsNone(truncated["excerpt"])

    def test_counts_stay_truthful_past_the_cap(self):
        # "a" repeats after the cap is full: it is already retained, so it
        # keeps counting. "e" and "f" are new and only add to the total.
        tags = ["a", "b", "c", "d", "e", "a", "a", "f", "f"]
        findings = self._findings(tags)
        self.assertEqual(
            [(f["value"], f["count"]) for f in findings],
            [("a", 3), ("b", 1), ("c", 1), ("d", 1), (None, 3)],
        )
        self.assertEqual(sum(f["count"] for f in findings), len(tags))

    def test_a_capped_body_still_blocks_on_the_shape_mismatch(self):
        body = {"content": [{"type": "a%d" % i} for i in range(200)]}
        with patch.object(nas_addon, "MAX_RETAINED_FINDINGS", 4):
            self.assertEqual(
                _execute_request_policy(
                    _json_policy(guards=[
                        _tagged_union("/**/content/*"),
                    ]),
                    json.dumps(body).encode("utf-8"),
                    self.patterns,
                ),
                ("block", None, "schema-mismatch"),
            )

    def test_excerpts_are_not_built_past_the_cap(self):
        # The excerpt is the expensive part of a finding. Capping the list
        # only bounds the memory; it has to bound the work as well.
        built = []
        real_excerpt = nas_addon._violation_excerpt

        def counting_excerpt(node, patterns):
            built.append(node)
            return real_excerpt(node, patterns)

        with patch.object(nas_addon, "_violation_excerpt", counting_excerpt):
            self._findings(["a%d" % i for i in range(500)])
        self.assertEqual(len(built), 4)

    def _capped_and_truncated_walk(self):
        # Eight distinct violations against a cap of two, and a sibling array
        # wide enough that the walk runs out of expansions before it finishes.
        body = {"content": [{"type": "a%d" % i} for i in range(8)],
                "extra": ["x"] * 40}
        with patch.object(nas_addon, "MAX_RETAINED_FINDINGS", 2), \
                _expansion_ceiling(20):
            return body, _validate_tagged_unions(
                json.loads(json.dumps(body)),
                [_tagged_union("/**/content/*")], self.patterns,
                _selector_budget(),
            )

    def test_incomplete_inspection_is_recorded_even_with_the_cap_full(self):
        # The cap bounds how many violations are described. It must not bound
        # the record that the walk was truncated: that record is the only
        # thing saying subtrees went uninspected, and dropping it would turn a
        # capped inspection into one that looks complete.
        _body, findings = self._capped_and_truncated_walk()
        self.assertEqual(
            [f["kind"] for f in findings],
            ["schema-mismatch", "schema-mismatch",
             "inspection-incomplete", "findings-truncated"],
        )

    def test_incomplete_inspection_still_wins_the_reason_when_capped(self):
        _body, findings = self._capped_and_truncated_walk()
        self.assertEqual(
            nas_addon._findings_block_reason(findings), "resource-limit"
        )

    def test_a_capped_and_truncated_walk_blocks_on_the_resource_limit(self):
        body, _findings = self._capped_and_truncated_walk()
        with patch.object(nas_addon, "MAX_RETAINED_FINDINGS", 2), \
                _expansion_ceiling(20):
            self.assertEqual(
                _execute_request_policy(
                    _json_policy(guards=[
                        _tagged_union("/**/content/*"),
                    ]),
                    json.dumps(body).encode("utf-8"),
                    self.patterns,
                ),
                ("block", None, "resource-limit"),
            )

    def test_the_cap_is_shared_across_checks(self):
        # One allowance for the whole body inspection, not one per check. The
        # first check fills it, so the second check's violations have to land
        # in the truncated record rather than disappear from the totals.
        body = {"content": [{"type": "a"}, {"type": "b"}],
                "system": [{"type": "c"}, {"type": "d"}, {"type": "c"}]}
        with patch.object(nas_addon, "MAX_RETAINED_FINDINGS", 2):
            findings = _validate_tagged_unions(
                json.loads(json.dumps(body)),
                [_tagged_union("/**/content/*"),
                 _tagged_union("/**/system/*")],
                self.patterns, _selector_budget(),
            )
        self.assertEqual(
            [(f["at"], f["value"], f["count"]) for f in findings],
            [("/**/content/*", "a", 1), ("/**/content/*", "b", 1),
             ("", None, 3)],
        )
        self.assertEqual(findings[-1]["kind"], "findings-truncated")
        self.assertEqual(sum(f["count"] for f in findings), 5)


class RequestPolicyIncompleteInspectionTest(unittest.TestCase):
    """A walk that runs out of budget leaves subtrees uninspected. That is a
    violation, not a pass: the finding records which selector ran out and how
    far the walk got."""

    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["SECRET123"])
        self.body = {"messages": [{"content": [{"type": "text"}]}]}

    def _findings(self, guards):
        parsed = json.loads(json.dumps(self.body))
        return _validate_tagged_unions(
            parsed, guards, self.patterns, _selector_budget()
        )

    def test_expansion_budget_exhaustion_blocks_the_request(self):
        with _expansion_ceiling(3):
            self.assertEqual(
                _execute_request_policy(
                    _json_policy(guards=[
                        _tagged_union("/messages/*/content/*"),
                    ]),
                    json.dumps(self.body).encode("utf-8"),
                    self.patterns,
                ),
                ("block", None, "resource-limit"),
            )

    def test_finding_records_the_selector_and_the_last_pointer_reached(self):
        with _expansion_ceiling(3):
            findings = self._findings(
                [_tagged_union("/messages/*/content/*")]
            )
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["kind"], "inspection-incomplete")
        self.assertEqual(findings[0]["at"], "/messages/*/content/*")
        self.assertEqual(findings[0]["pointer"], "/messages/0/content")

    def test_exhausted_exclude_walk_names_the_exclude_selector(self):
        with _expansion_ceiling(1):
            findings = self._findings([_tagged_union(
                "/messages/*/content/*", exclude=["/messages/**"]
            )])
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["kind"], "inspection-incomplete")
        self.assertEqual(findings[0]["at"], "/messages/**")
        self.assertEqual(findings[0]["pointer"], "/messages")

    def test_incomplete_finding_masks_a_secret_in_the_last_pointer(self):
        parsed = json.loads(json.dumps(
            {"k-SECRET123": {"content": [{"type": "text"}]}}
        ))
        with _expansion_ceiling(3):
            findings = _validate_tagged_unions(
                parsed, [_tagged_union("/**/content/*")], self.patterns,
                _selector_budget(),
            )
        self.assertEqual(findings[0]["kind"], "inspection-incomplete")
        self.assertNotIn("SECRET123", findings[0]["pointer"])
        self.assertIn("****", findings[0]["pointer"])

    def test_incomplete_finding_masks_a_secret_spanning_a_separator(self):
        # The pointer a truncated walk reports is built the same way as a
        # mismatch's, so a secret split across two keys reaches it the same
        # way and has to be masked the same way.
        patterns = nas_addon._build_mask_patterns(["aws/key123"])
        parsed = json.loads(json.dumps(
            {"aws": {"key123": {"content": [{"type": "text"}]}}}
        ))
        with _expansion_ceiling(6):
            findings = _validate_tagged_unions(
                parsed, [_tagged_union("/**/content/*")], patterns,
                _selector_budget(),
            )
        self.assertEqual(findings[0]["kind"], "inspection-incomplete")
        self.assertEqual(findings[0]["pointer"], "/****/content")

    def test_violations_found_before_the_budget_ran_out_are_kept(self):
        body = {"content": [{"type": "future"}], "extra": ["x"] * 50}
        parsed = json.loads(json.dumps(body))
        with _expansion_ceiling(12):
            findings = _validate_tagged_unions(
                parsed, [_tagged_union("/**/content/*")], self.patterns,
                _selector_budget(),
            )
        self.assertEqual(
            [f["kind"] for f in findings],
            ["schema-mismatch", "inspection-incomplete"],
        )
        # An unfinished walk proved nothing about what it never reached, so
        # it outranks the mismatch it did find.
        self.assertEqual(
            nas_addon._findings_block_reason(findings), "resource-limit"
        )

    def test_incomplete_inspection_outranks_a_mismatch_in_the_reason(self):
        body = {"content": [{"type": "future"}], "extra": ["x"] * 50}
        with _expansion_ceiling(12):
            self.assertEqual(
                _execute_request_policy(
                    _json_policy(guards=[
                        _tagged_union("/**/content/*"),
                    ]),
                    json.dumps(body).encode("utf-8"),
                    self.patterns,
                ),
                ("block", None, "resource-limit"),
            )


class RequestPolicyKeyCollisionTest(unittest.TestCase):
    def setUp(self):
        self.patterns = nas_addon._build_mask_patterns(["SECRET123"])

    def _run(self, raw_body, patterns=None):
        return _execute_request_policy(
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
        return _execute_request_policy(
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
            result = _execute_request_policy(
                _json_policy(guards=[_tagged_union("/**/content/*")]),
                self.body,
                self.patterns,
            )
        return result, stderr.getvalue()

    def test_traversal_exception_blocks_as_processing_failed(self):
        for target in (
            "_account_json",
            "_evaluate_expects",
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
            result = _execute_request_policy(
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
            result = _execute_request_policy(
                _json_policy(), self.body, self.patterns
            )
        self.assertEqual(result, ("block", None, "serialization-failed"))
        self.assertEqual(stderr.getvalue(), "")

    def test_empty_body_check_exception_blocks_as_processing_failed(self):
        class ExplodingBody:
            def __len__(self):
                raise RuntimeError("SECRET123 length detail")

        stderr = io.StringIO()
        with redirect_stderr(stderr):
            result = nas_addon._inspect_body(
                _bodyless_policy(), ExplodingBody(), None, self.patterns
            )
        self.assertEqual(result, ("block", None, "processing-failed"))
        self.assertEqual(stderr.getvalue(), "")

    def test_engine_emits_nothing_to_stderr_on_success(self):
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            _execute_request_policy(
                _json_policy(), self.body, self.patterns
            )
        self.assertEqual(stderr.getvalue(), "")


def _flow_document(rules=(), scope="api", targets=("api.example.com",),
                   fallback="deny", network_fallback="deny"):
    """A resolved document with one scope, in the shape the addon reads."""
    return {
        "contractVersion": 2,
        "fallback": network_fallback,
        "defaults": {
            "limits": dict(_DEFAULT_LIMITS),
            "secrets": {"*": "mask"},
            "audit": "always",
        },
        "scopes": [
            {
                "name": scope,
                "targets": [
                    {
                        "source": host,
                        "host": {"kind": "exact", "host": host},
                        "port": None,
                    }
                    for host in targets
                ],
                "fallback": fallback,
                "fallbackRuleId": f"{scope}.$fallback",
                "limits": dict(_DEFAULT_LIMITS),
                "secrets": {},
                "inject": [],
                "audit": "always",
                "rules": list(rules),
            }
        ],
    }


def _messages_rule(key="messages", **overrides):
    """A rule that reads /v1/messages as JSON, like the anthropic preset."""
    rule = _json_policy()
    rule["key"] = key
    rule["id"] = f"api.{key}"
    rule.update(overrides)
    return rule


def _models_rule(key="models", **overrides):
    """A rule that refuses a body on GET /v1/models."""
    rule = _bodyless_policy()
    rule["key"] = key
    rule["id"] = f"api.{key}"
    rule["match"]["methods"] = ["GET"]
    rule["match"]["paths"] = [_path_pattern("/v1/models")]
    rule.update(overrides)
    return rule


class RequestPolicyFlowTest(unittest.TestCase):
    """request() が、自分の選択と broker の答えが一致したときにだけ進むこと。

    addon と broker は同じドキュメントの上で同じ選択を再現する。食い違ったら、
    どちらかが相手の見ていないものを見ているということなので、どちらの答えで
    進んでも「誰も承認していないルール」を走らせることになる。"""

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
        document,
        rule_id="api.messages",
        method="POST",
        path="/v1/messages",
        host="api.example.com",
        content=b'{"text":"SECRET123"}',
        headers=None,
        request_class=FakeRequest,
        inject=True,
        addon=None,
        client_id="client-test",
        mask_values=("SECRET123",),
    ):
        """rule_id は broker が返す答え。addon の選択と食い違えば止まる。"""
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
                    "reason": "rule",
                    "maskValues": list(mask_values),
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
            "_load_authz_document",
            # document=None は「契約として読めないドキュメント」を表す。
            return_value=(
                nas_addon._INVALID_AUTHZ_DOCUMENT
                if document is None
                else document
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

    def test_the_rule_both_sides_chose_is_the_rule_that_runs(self):
        flow, messages, _stderr = self._run(
            document=_flow_document([_messages_rule()]),
            rule_id="api.messages",
        )

        self.assertIsNone(flow.response)
        self.assertEqual(flow.request.content, b'{"text":"****"}')
        self.assertEqual(
            [(m["ruleId"], m["result"], m["reason"])
             for m in self._outcomes(messages)],
            [("api.messages", "rewrite", "masked-json")],
        )

    def test_a_broker_answer_the_addon_did_not_reach_blocks(self):
        flow, messages, _stderr = self._run(
            document=_flow_document([_messages_rule()]),
            rule_id="api.$fallback",
        )

        self.assertEqual(flow.response.status_code, 403)
        self.assertEqual(
            flow.response.content, nas_addon.REQUEST_POLICY_BLOCK_BODY
        )
        self.assertIsNone(self._injected(flow))
        self.assertEqual(self._outcomes(messages), [])

    def test_an_unknown_broker_rule_id_blocks_before_injection(self):
        flow, messages, _stderr = self._run(
            document=_flow_document([_messages_rule()]),
            rule_id="api.not-in-document",
        )

        self.assertEqual(flow.response.status_code, 403)
        self.assertIsNone(self._injected(flow))
        self.assertEqual(self._outcomes(messages), [])

    def test_a_scope_fallback_keeps_generic_masking(self):
        flow, messages, _stderr = self._run(
            document=_flow_document(
                [], targets=("example.com",), fallback="allow"
            ),
            rule_id="api.$fallback",
            method="POST",
            path="/submit",
            host="example.com",
            content=b"value=SECRET123",
        )

        self.assertIsNone(flow.response)
        self.assertEqual(flow.request.content, b"value=****")
        self.assertEqual(self._outcomes(messages), [])
        self.assertEqual(self._injected(flow), "injected-value")

    def test_a_network_fallback_keeps_generic_masking(self):
        flow, messages, _stderr = self._run(
            document=_flow_document([], network_fallback="review"),
            rule_id="$fallback",
            method="POST",
            path="/submit",
            host="elsewhere.example",
            content=b"value=SECRET123",
        )

        self.assertIsNone(flow.response)
        self.assertEqual(flow.request.content, b"value=****")
        self.assertEqual(self._outcomes(messages), [])
        self.assertEqual(self._injected(flow), "injected-value")

    def test_a_rule_with_nothing_to_inspect_keeps_generic_masking(self):
        ordinary = _rule(key="ordinary", paths=["/submit"], scope="api")
        flow, messages, _stderr = self._run(
            document=_flow_document([ordinary], targets=("example.com",)),
            rule_id="api.ordinary",
            method="POST",
            path="/submit",
            host="example.com",
            content=b"value=SECRET123",
        )

        self.assertIsNone(flow.response)
        self.assertEqual(flow.request.content, b"value=****")
        self.assertEqual(
            [(m["result"], m["reason"]) for m in self._outcomes(messages)],
            [("pass", "no-inspection")],
        )
        self.assertEqual(self._injected(flow), "injected-value")

    def test_a_json_body_no_rule_reads_as_json_is_still_masked(self):
        """Masking does not depend on any rule having asked for the body.

        The rule declares no body condition, so nothing inspects the tree —
        but the body is still forwarded, so the secret in it still has to be
        replaced."""
        ordinary = _rule(key="ordinary", paths=["/submit"], scope="api")
        flow, messages, _stderr = self._run(
            document=_flow_document([ordinary], targets=("example.com",)),
            rule_id="api.ordinary",
            method="POST",
            path="/submit",
            host="example.com",
            content=b'{"value":"SECRET123"}',
        )

        self.assertIsNone(flow.response)
        self.assertEqual(flow.request.content, b'{"value":"****"}')
        self.assertEqual(
            [(m["result"], m["reason"]) for m in self._outcomes(messages)],
            [("pass", "no-inspection")],
        )
        self.assertEqual(self._injected(flow), "injected-value")

    def test_an_opaque_rule_masks_the_json_body_it_forwards(self):
        """`format = "opaque"` accepts the body without parsing it. The body
        still leaves the sandbox, so it still gets masked."""
        opaque = _rule(
            key="opaque", paths=["/submit"], scope="api", body_format="opaque"
        )
        flow, _messages, _stderr = self._run(
            document=_flow_document([opaque], targets=("example.com",)),
            rule_id="api.opaque",
            method="POST",
            path="/submit",
            host="example.com",
            content=b'{"value":"SECRET123"}',
        )

        self.assertIsNone(flow.response)
        self.assertEqual(flow.request.content, b'{"value":"****"}')

    def _opaque_over_broad_document(self):
        """`opaque` is narrower than a rule with no body condition, so it is
        evaluated first. Only a request that carries a body reaches its
        `allow`; anything else falls through to the broad `deny`."""
        opaque = _rule(
            key="opaque", paths=["/**"], scope="api", body_format="opaque"
        )
        opaque["match"]["methods"] = None
        opaque["precedes"] = ["all"]
        broad = _rule(key="all", paths=["/**"], scope="api")
        broad["match"]["methods"] = None
        broad["onMatch"] = "deny"
        return _flow_document([opaque, broad], targets=("example.com",))

    def test_a_bodyless_get_does_not_satisfy_an_opaque_rule(self):
        """A GET with no body is not a GET with an empty body. Reporting it as
        empty hands it to every rule written for requests that carry
        something."""
        flow, messages, _stderr = self._run(
            document=self._opaque_over_broad_document(),
            rule_id="api.all",
            method="GET",
            path="/v1/models",
            host="example.com",
            content=b"",
        )

        self.assertIsNone(flow.response)
        self.assertEqual(
            messages[0]["reviewContext"]["bodyKind"], "absent"
        )

    def test_a_declared_empty_body_does_satisfy_an_opaque_rule(self):
        """`Content-Length: 0` is a body that exists and is empty, which is
        what `opaque` accepts."""
        flow, messages, _stderr = self._run(
            document=self._opaque_over_broad_document(),
            rule_id="api.opaque",
            method="POST",
            path="/v1/models",
            host="example.com",
            headers=[("content-length", "0")],
            content=b"",
        )

        self.assertIsNone(flow.response)
        self.assertEqual(messages[0]["reviewContext"]["bodyKind"], "empty")

    def test_a_masked_body_still_reports_the_violation_it_let_through(self):
        """The rewrite and the allowed violation are both true of this
        request. The audit gets one reason, and it has to be the one that says
        a violation passed — that record is the reason the rule is allowed to
        pass one at all."""
        rule = _rule(
            key="messages",
            expects=[_union_shape(
                _tagged_union("/content/*"), on_violation="allow"
            )],
            body_format="json",
        )
        flow, messages, _stderr = self._run(
            document=_flow_document([rule]),
            rule_id="api.messages",
            content=b'{"content":[{"type":"future","note":"SECRET123"}]}',
        )

        self.assertIsNone(flow.response)
        self.assertEqual(
            flow.request.content,
            b'{"content":[{"type":"future","note":"****"}]}',
        )
        self.assertEqual(
            [(m["result"], m["reason"]) for m in self._outcomes(messages)],
            [("rewrite", "violations-allowed")],
        )

    def test_a_body_over_the_rules_budget_is_never_inspected(self):
        """The rule asked for bodies no larger than 16 bytes. A larger one was
        not read within that budget, so its `json` condition is indeterminate
        and the rule inspects nothing — the broker is told the body could not
        be parsed, and it decides on that."""
        rule = _messages_rule()
        rule["limits"] = dict(rule["limits"], maxBodyBytes=16)
        flow, messages, _stderr = self._run(
            document=_flow_document([rule]),
            rule_id="api.messages",
            content=b'{"text":"SECRET123","padding":"'
                    + b"x" * 64 + b'"}',
        )

        self.assertEqual(messages[0]["reviewContext"]["bodyKind"], "binary")
        self.assertEqual(self._outcomes(messages), [])
        self.assertNotIn(b"SECRET123", flow.request.content)

    def test_a_rule_that_refuses_a_body_masks_what_the_fallback_forwards(self):
        """`format = "none"` declines a request that carries a body, so the
        scope fallback takes it. No rule owns the body, and it is masked."""
        bodyless = _rule(
            key="bodyless", paths=["/submit"], scope="api", body_format="none"
        )
        flow, messages, _stderr = self._run(
            document=_flow_document(
                [bodyless], targets=("example.com",), fallback="allow"
            ),
            rule_id="api.$fallback",
            method="POST",
            path="/submit",
            host="example.com",
            content=b'{"value":"SECRET123"}',
        )

        self.assertIsNone(flow.response)
        self.assertEqual(flow.request.content, b'{"value":"****"}')
        self.assertEqual(self._outcomes(messages), [])

    def test_an_indeterminate_body_is_masked_when_it_is_forwarded(self):
        """A body a `json` rule could not parse leaves the rule unresolved, so
        no rule inspects it. If it is forwarded anyway, it is masked."""
        flow, messages, _stderr = self._run(
            document=_flow_document([_messages_rule()]),
            rule_id="api.messages",
            content=b"value=SECRET123",
        )

        self.assertIsNone(flow.response)
        self.assertEqual(flow.request.content, b"value=****")
        self.assertEqual(self._outcomes(messages), [])

    def test_a_secret_the_json_walk_cannot_reach_is_masked_on_the_wire(self):
        """The structural walk masks strings and keys, not numbers. A secret
        spelled as a number leaves the tree unchanged, so the byte pass is the
        only thing standing between it and the wire."""
        flow, _messages, _stderr = self._run(
            document=_flow_document([_messages_rule()]),
            rule_id="api.messages",
            content=b'{"pin":12345678}',
            mask_values=["12345678"],
        )

        self.assertIsNone(flow.response)
        self.assertNotIn(b"12345678", flow.request.content)

    def test_an_approved_review_still_runs_the_acceptance_conditions(self):
        flow, messages, _stderr = self._run(
            document=_flow_document([_messages_rule(onMatch="review")]),
            rule_id="api.messages",
        )

        self.assertIsNone(flow.response)
        self.assertEqual(flow.request.content, b'{"text":"****"}')
        self.assertEqual(
            [m["result"] for m in self._outcomes(messages)], ["rewrite"]
        )

    def test_a_violation_prevents_credential_injection(self):
        flow, messages, _stderr = self._run(
            document=_flow_document([_models_rule()]),
            rule_id="api.models",
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

    def test_pass_injects_credentials_after_the_inspection(self):
        flow, messages, _stderr = self._run(
            document=_flow_document([_models_rule()]),
            rule_id="api.models",
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

    def test_rewrite_injects_credentials_after_the_inspection(self):
        flow, _messages, _stderr = self._run(
            document=_flow_document([_messages_rule()]),
            rule_id="api.messages",
        )

        self.assertIsNone(flow.response)
        self.assertEqual(flow.request.content, b'{"text":"****"}')
        self.assertEqual(self._injected(flow), "injected-value")

    def test_outcome_carries_only_the_closed_field_set(self):
        _flow, messages, _stderr = self._run(
            document=_flow_document([_messages_rule()]),
            rule_id="api.messages",
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
        flow, messages, stderr = self._run(document=None)

        self.assertEqual(flow.response.status_code, 403)
        self.assertEqual(
            flow.response.content, nas_addon.REQUEST_POLICY_BLOCK_BODY
        )
        self.assertIsNone(self._injected(flow))
        self.assertEqual(messages, [])
        self.assertEqual(
            stderr,
            "[nas-addon] AUTHZ-CONTRACT-INVALID: session=sess-test\n",
        )

    def test_invalid_contract_log_sanitizes_untrusted_session_id(self):
        self.session_id = "sess-test\nSECRET-session"
        self.proxy_auth = "Basic " + base64.b64encode(
            f"{self.session_id}:{self.token}".encode()
        ).decode()

        flow, messages, stderr = self._run(document=None)

        self.assertEqual(flow.response.status_code, 403)
        self.assertEqual(messages, [])
        self.assertEqual(
            stderr,
            "[nas-addon] AUTHZ-CONTRACT-INVALID: session=invalid\n",
        )

    def test_rule_mismatch_log_sanitizes_the_broker_supplied_id(self):
        _flow, _messages, stderr = self._run(
            document=_flow_document([_messages_rule()]),
            rule_id="NOT A VALID ID\nSECRET-rule",
        )

        self.assertEqual(
            stderr,
            "[nas-addon] AUTHZ-RULE-MISMATCH: session=sess-test "
            "broker=invalid addon=api.messages\n",
        )

    def test_authorization_carries_a_bounded_preview_and_the_body_kind(self):
        body = b'{"text":"hello"}'

        _flow, messages, _stderr = self._run(
            document=_flow_document([_messages_rule()]),
            rule_id="api.messages",
            content=body,
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
                # broker はボディを見ないので、選択に効く事実だけを渡す。
                "bodyKind": "json",
            },
        )

    def test_query_and_header_are_masked_before_injection(self):
        flow, _messages, stderr = self._run(
            document=_flow_document([_messages_rule()]),
            rule_id="api.messages",
            path="/v1/messages?k=SECRET123",
            headers=[("x-custom", "SECRET123")],
        )

        self.assertEqual(flow.request.path, "/v1/messages?k=****")
        self.assertEqual(flow.request.headers["x-custom"], "****")
        self.assertEqual(self._injected(flow), "injected-value")
        self.assertNotIn("SECRET123", stderr)

    def test_a_rule_governed_request_never_logs_the_path_or_its_query(self):
        _flow, _messages, stderr = self._run(
            document=_flow_document([_messages_rule()]),
            rule_id="api.messages",
            path="/v1/messages?filename=PRIVATE-NOT-A-MASK-VALUE.txt",
        )

        self.assertNotIn("PRIVATE-NOT-A-MASK-VALUE", stderr)
        self.assertNotIn("/v1/messages", stderr)

    def test_outcome_failure_does_not_change_the_computed_result(self):
        document = _flow_document([_messages_rule()])

        def failing_broker(_socket_path, request):
            if request["type"] == "authorize":
                return {
                    "decision": "allow",
                    "requestId": request["requestId"],
                    "reason": "rule",
                    "ruleId": "api.messages",
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
            nas_addon, "_load_authz_document", return_value=document
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
                document=_flow_document([_models_rule()]),
                rule_id="api.models",
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
        self.assertIn("rule=api.models", emitted[0])
        self.assertIn("result=block reason=unexpected-body", emitted[0])

    def _block_once(self, addon, client_id):
        return self._run(
            document=_flow_document([_models_rule()]),
            rule_id="api.models",
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
