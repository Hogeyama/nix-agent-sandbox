"""
nas_addon.py — mitmproxy addon for nas network authorization.

Intercepts HTTP/HTTPS requests, extracts session credentials from
Proxy-Authorization, queries the per-session broker UDS for authorization
decisions, and inspects request bodies against the rule the broker named.
"""

import base64
import hashlib
import itertools
import json
import math
import os
import re
import socket
import sys
import time
import urllib.parse
from typing import Optional

from mitmproxy import connection, http

NETWORK_DIR = "/nas-network"
SESSIONS_DIR = os.path.join(NETWORK_DIR, "sessions")
BROKERS_DIR = os.path.join(NETWORK_DIR, "brokers")
AUTHZ_DIR = os.path.join(NETWORK_DIR, "authz")

REQUEST_POLICY_BLOCK_BODY = b"blocked: request policy"

# Contract version of the resolved authorization document. A document that
# does not carry exactly this version is rejected whole: the host writes it
# and the addon re-validates it, so a mismatch means the two halves of the
# session were built from different releases.
AUTHZ_CONTRACT_VERSION = 3

# A violation finding quotes the offending node. The depth and byte ceilings
# keep that quote readable and stop a finding from growing into a copy of the
# request body. Depth and width bound how much of the node is walked and
# EXCERPT_MASK_BUDGET how much text is scanned for secrets, because the
# offending node is attacker-controlled and may be nearly the whole body:
# bounding only the printed result would leave the work unbounded.
EXCERPT_MAX_DEPTH = 3
EXCERPT_MAX_WIDTH = 16
EXCERPT_MASK_BUDGET = 4096
EXCERPT_MAX_BYTES = 512
EXCERPT_ELIDED = "..."

# Ceiling on how many distinct violation findings one acceptance condition
# keeps. Grouping violations by their value does not bound the list on its
# own: the value is a string out of the request body, so a body carrying a
# fresh value at every node yields a fresh finding at every node, each one
# paying for an excerpt. Violations past the ceiling are counted but not
# retained, and the count is reported as one further finding, so the totals
# stay honest while the work and the memory stay bounded.
#
# The allowance is per condition rather than one shared across the whole body
# inspection, because a finding is what an approval is keyed by: a retained
# finding names (condition, value) and a dropped one names neither. Sharing
# one allowance lets the first condition spend it and leaves every later
# condition's violations unapprovable — the request would be refused with no
# way for the operator to let it through. The memory stays bounded because
# the number of conditions comes from the resolved document, not from the
# request.
MAX_FINDINGS_PER_EXPECT = 64

# Ceilings on the two body-derived fields of a finding that are otherwise
# unbounded. The offending value is a discriminator string out of the request
# body and the pointer is assembled from object keys out of the same body, so
# either can be as large as the body itself. They travel to the approval UI
# and the audit log, so their size cannot be the attacker's to choose.
#
# The value is also half of what an approval is keyed by, so cutting it must
# not make two distinct values look alike: a cut value carries a digest of the
# whole one, which keeps distinct values distinct. The rendering is longer than
# the ceiling, so no value short enough to be kept whole can ever collide with
# a cut one.
FINDING_VALUE_MAX_CHARS = 256
FINDING_VALUE_DIGEST_CHARS = 16
FINDING_POINTER_MAX_CHARS = 1024

# Placeholder reason on an inspection that ends in "review". It never reaches
# the broker: whoever settles the review replaces it with what happened.
REASON_VIOLATIONS_REVIEW = "violations-review"

FINDING_SCHEMA_MISMATCH = "schema-mismatch"
FINDING_UNEXPECTED_BODY = "unexpected-body"
FINDING_BODY_UNAVAILABLE = "body-unavailable"
FINDING_INSPECTION_INCOMPLETE = "inspection-incomplete"
FINDING_FINDINGS_TRUNCATED = "findings-truncated"

# `deny` beats `review` beats `allow`. The consequence of a rule whose
# acceptance conditions were violated is the strictest consequence among the
# conditions that were actually violated.
VIOLATION_SEVERITY = {"allow": 0, "review": 1, "deny": 2}

# The rule ID a scope's `fallback` produces. `$` is outside the rule key
# syntax, so a user-written ID can never collide with it.
FALLBACK_RULE_KEY = "$fallback"

# A real rule ID, a scope's `<scope>.$fallback`, or the bare `$fallback`
# that a request belonging to no scope carries.
_SAFE_RULE_ID = re.compile(
    r"(?:[a-z][a-z0-9._-]{0,63}(?:\.\$fallback)?|\$fallback)\Z"
)
_RULE_KEY = re.compile(r"[a-z][a-z0-9._-]{0,63}\Z")
_SAFE_SESSION_LABEL = re.compile(r"[A-Za-z0-9._-]{1,64}\Z")

_DOCUMENT_KEYS = frozenset((
    "contractVersion",
    "fallback",
    "defaults",
    "scopes",
))
_SCOPE_KEYS = frozenset((
    "name",
    "targets",
    "fallback",
    "fallbackRuleId",
    "limits",
    "secrets",
    "inject",
    "audit",
    "rules",
))
_RULE_KEYS = frozenset((
    "id",
    "key",
    "precedes",
    "match",
    "onMatch",
    "onIndeterminate",
    "expect",
    "limits",
    "secrets",
    "inject",
    "audit",
))
_MATCH_KEYS = frozenset((
    "methods", "paths", "bodyFormat", "equals", "oneOf",
))
_PATH_KEYS = frozenset(("source", "segments", "trailingDoubleStar"))
_TARGET_KEYS = frozenset(("source", "host", "port"))
_LIMIT_KEYS = frozenset((
    "maxBodyBytes",
    "maxDepth",
    "maxNodes",
    "maxSelectorExpansions",
))
_EXPECT_KEYS = {
    "emptyBody": frozenset(("kind", "onViolation")),
    "jsonRoot": frozenset(("kind", "onViolation", "rootType")),
    "unionShape": frozenset((
        "kind",
        "onViolation",
        "at",
        "exclude",
        "discriminator",
        "allowed",
    )),
}
_LIMIT_CEILINGS = {
    "maxBodyBytes": 33_554_432,
    "maxDepth": 64,
    "maxNodes": 200_000,
    "maxSelectorExpansions": 1_000_000,
}
_ACTIONS = frozenset(("allow", "review", "deny"))
_BODY_FORMATS = frozenset(("none", "json", "opaque"))
_VIOLATION_ACTIONS = frozenset(("deny", "review", "allow"))

# A decimal integer with more digits cannot fit in JavaScript's finite
# IEEE-754 Number range, regardless of its leading digits.
_MAX_JS_FINITE_INTEGER_DIGITS = 309

# --- request masking -------------------------------------------------------
# Pattern expansion mirrors src/network/mask_patterns.ts (broker-side
# reviewContext masking). Keep both implementations in sync.

MASK_REPLACEMENT = b"****"
B64_MIN_PATTERN_LEN = 8


def _base64_confident_substrings(secret: bytes) -> set[bytes]:
    """truffleHog 方式: 3 バイトアライメントごとに、隣接バイトの影響を
    受けない「確定部分文字列」を生成する (標準 / URL-safe 両アルファベット)。
    短すぎるパターンは誤マスク防止のため捨てる。"""
    out: set[bytes] = set()
    for k in range(3):
        encoded = base64.b64encode(b"\x00" * k + secret).rstrip(b"=")
        start = -(-8 * k // 6)                # ceil(8k/6)
        end = (8 * (k + len(secret))) // 6    # floor(8(k+n)/6)
        candidate = encoded[start:end]
        if len(candidate) >= B64_MIN_PATTERN_LEN:
            out.add(candidate)
            out.add(candidate.replace(b"+", b"-").replace(b"/", b"_"))
    return out


def _build_mask_patterns(mask_values: list[str]) -> list[bytes]:
    """秘密値ごとに 生値 / percent-encoded (quote, quote_plus) / base64
    バリアントを展開し、長い順に返す (部分重複対策)。"""
    patterns: set[bytes] = set()
    for value in mask_values:
        if not value:
            continue
        raw = value.encode("utf-8")
        patterns.add(raw)
        patterns.add(urllib.parse.quote(value, safe="").encode("ascii"))
        patterns.add(urllib.parse.quote_plus(value).encode("ascii"))
        patterns.update(_base64_confident_substrings(raw))
    return sorted(patterns, key=len, reverse=True)


def _mask_bytes(data: bytes, patterns: list[bytes]) -> bytes:
    for pattern in patterns:
        data = data.replace(pattern, MASK_REPLACEMENT)
    return data


def _mask_url_and_headers(flow, patterns: list[bytes]) -> None:
    """URL パスとヘッダーから秘密値を **** に置換する（body は触らない）。"""
    if not patterns:
        return

    masked_path = _mask_bytes(
        flow.request.path.encode("utf-8", errors="surrogateescape"), patterns
    )
    flow.request.path = masked_path.decode("utf-8", errors="surrogateescape")

    # Headers is a multidict: item access does not reliably expose every
    # occurrence of a duplicated header name, so use get_all/set_all to
    # scan and rewrite all occurrences of each header name.
    seen = set()
    for name in list(flow.request.headers.keys()):
        if name in seen:
            continue
        seen.add(name)
        values = flow.request.headers.get_all(name)
        masked_values = [
            _mask_bytes(v.encode("utf-8", errors="surrogateescape"), patterns)
            .decode("utf-8", errors="surrogateescape")
            for v in values
        ]
        if masked_values != values:
            flow.request.headers.set_all(name, masked_values)


def _apply_request_masking(flow, patterns: list[bytes]) -> None:
    """allow されたリクエストの URL・ヘッダー・ボディから秘密値を **** に
    置換する。credential 注入 (injectHeaders) より前に呼ぶこと —
    逆順だと注入したばかりの本物の credential をマスクして壊す。"""
    if not patterns:
        return

    _mask_url_and_headers(flow, patterns)

    # .content は Content-Encoding 展開済みビュー。再代入で mitmproxy が
    # 再圧縮と Content-Length 更新を行う。展開できないエンコーディングは
    # ValueError になる — その場合 raw_content は圧縮済みバイト列なので
    # 生パターンのマッチは効かず、マスクできない。
    # fail-closed: 展開不能 = マスク不能 = 漏洩リスクなので blocked を返す。
    try:
        content = flow.request.content
    except ValueError:
        content = None
    if content is not None:
        if content:
            masked_content = _mask_bytes(content, patterns)
            if masked_content != content:
                flow.request.content = masked_content
    else:
        # content 展開失敗。blocked フラグを立てて呼び出し元で 403 にする。
        ce = flow.request.headers.get("content-encoding", "unknown")
        print(
            f"[nas-addon] MASK-BLOCKED: cannot decode content-encoding "
            f"'{ce}' for masking, blocking request to prevent secret leak",
            file=sys.stderr,
        )
        flow.mask_blocked = True


def _contains_forbidden(flow, patterns: list[bytes]) -> bool:
    """Whether a `forbid` secret appears anywhere in the outgoing request.

    Checked before anything is rewritten: masking would erase the very
    occurrence that has to stop the request. The same expansion masking uses
    is applied, so a value carried percent-encoded or inside a base64 blob is
    still recognised. Neither the value nor where it was found is logged.

    A body that cannot be decoded counts as containing the secret. Absence
    has to be proved, and an undecodable body proves nothing."""
    if not patterns:
        return False
    haystacks = [flow.request.path.encode("utf-8", errors="surrogateescape")]
    for name in list(flow.request.headers.keys()):
        for value in flow.request.headers.get_all(name):
            haystacks.append(value.encode("utf-8", errors="surrogateescape"))
    try:
        content = flow.request.content
    except ValueError:
        return True
    if content:
        haystacks.append(content)
    return any(
        pattern in haystack for haystack in haystacks for pattern in patterns
    )


_registry_cache: dict[str, tuple[float, dict]] = {}
_INVALID_AUTHZ_DOCUMENT = object()
_authz_cache: dict[str, tuple[Optional[int], object]] = {}
CACHE_TTL = 5.0


def _load_registry(session_id: str) -> Optional[dict]:
    now = time.monotonic()
    cached = _registry_cache.get(session_id)
    if cached and now - cached[0] < CACHE_TTL:
        return cached[1]
    path = os.path.join(SESSIONS_DIR, f"{session_id}.json")
    try:
        with open(path) as f:
            data = json.load(f)
        _registry_cache[session_id] = (now, data)
        return data
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _has_exact_keys(value: object, expected: frozenset[str]) -> bool:
    return isinstance(value, dict) and value.keys() == expected


def _has_keys_within(value: object, allowed: frozenset[str]) -> bool:
    """Accept a subset of `allowed`. The host omits optional fields rather
    than writing nulls, so an absent key is normal and an unknown key is not."""
    return isinstance(value, dict) and set(value.keys()).issubset(allowed)


def _is_non_empty_string(value: object) -> bool:
    return isinstance(value, str) and len(value) > 0


def _is_valid_selector(value: object) -> bool:
    if not isinstance(value, str) or not value.startswith("/"):
        return False
    for segment in value[1:].split("/"):
        if re.search(r"~(?:[^01]|\Z)", segment):
            return False
        # `*` を含むセグメントは `*` / `**` そのものでない限り拒否する。
        # 通すと _parse_selector が丸ごとリテラルとして扱い、guard が 0 ノード
        # にマッチして「何も検査せず pass」になる (fail-open)。
        if segment not in ("*", "**") and "*" in segment:
            return False
    return True


def _is_valid_json_pointer(value: object) -> bool:
    """Validate RFC 6901 syntax without interpreting literal `*` tokens."""
    if not isinstance(value, str):
        return False
    if value == "":
        return True
    if not value.startswith("/"):
        return False
    return re.search(r"~(?:[^01]|\Z)", value) is None


def _is_json_scalar(value: object) -> bool:
    if isinstance(value, (str, bool)):
        return True
    if type(value) is int:
        return math.isfinite(_javascript_number(value))
    return type(value) is float and math.isfinite(value)


def _is_observed_json_scalar(value: object) -> bool:
    """Recognize values JavaScript JSON.parse exposes as scalar numbers.

    Python's decoder produces infinity when a valid numeric exponent exceeds
    double precision. JavaScript does the same, so request values allow it even
    though expected contract values remain finite-only via _is_json_scalar.
    """
    return isinstance(value, (str, bool)) or type(value) in (int, float)


def _is_valid_value_conditions(equals: object, one_of: object) -> bool:
    return (
        isinstance(equals, dict)
        and all(
            _is_valid_json_pointer(pointer) and _is_json_scalar(expected)
            for pointer, expected in equals.items()
        )
        and isinstance(one_of, dict)
        and all(
            _is_valid_json_pointer(pointer)
            and isinstance(expected, list)
            and len(expected) > 0
            and all(_is_json_scalar(value) for value in expected)
            for pointer, expected in one_of.items()
        )
    )


def _is_valid_limits(value: object) -> bool:
    if not _has_exact_keys(value, _LIMIT_KEYS):
        return False
    for field, ceiling in _LIMIT_CEILINGS.items():
        limit = value[field]
        if type(limit) is not int or limit <= 0 or limit > ceiling:
            return False
    return True


def _is_valid_dispositions(value: object) -> bool:
    return isinstance(value, dict) and all(
        isinstance(name, str)
        and disposition in ("inject", "mask", "forbid", "ignore")
        for name, disposition in value.items()
    )


def _is_valid_inject(value: object) -> bool:
    return isinstance(value, list) and all(
        _has_exact_keys(entry, frozenset(("name", "value")))
        and _is_non_empty_string(entry["name"])
        and isinstance(entry["value"], str)
        for entry in value
    )


def _is_valid_expect(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    kind = value.get("kind")
    expected = _EXPECT_KEYS.get(kind) if isinstance(kind, str) else None
    if expected is None or not _has_exact_keys(value, expected):
        return False
    if value["onViolation"] not in _VIOLATION_ACTIONS:
        return False
    if kind == "emptyBody":
        return True
    if kind == "jsonRoot":
        return value["rootType"] in ("object", "array")
    allowed = value["allowed"]
    exclude = value["exclude"]
    return (
        _is_valid_selector(value["at"])
        and isinstance(exclude, list)
        and all(_is_valid_selector(pattern) for pattern in exclude)
        and _is_non_empty_string(value["discriminator"])
        and isinstance(allowed, list)
        and len(allowed) > 0
        and all(_is_non_empty_string(tag) for tag in allowed)
    )


def _is_valid_segment(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    kind = value.get("kind")
    if kind == "all":
        return value.keys() == frozenset(("kind",))
    if kind != "finite" or value.keys() != frozenset(("kind", "values")):
        return False
    values = value["values"]
    return isinstance(values, list) and all(
        isinstance(token, str) for token in values
    )


def _is_valid_path(value: object) -> bool:
    if not _has_exact_keys(value, _PATH_KEYS):
        return False
    segments = value["segments"]
    return (
        isinstance(value["source"], str)
        and type(value["trailingDoubleStar"]) is bool
        and isinstance(segments, list)
        and all(_is_valid_segment(segment) for segment in segments)
    )


def _is_valid_match(value: object) -> bool:
    if not _has_exact_keys(value, _MATCH_KEYS):
        return False
    methods = value["methods"]
    if methods is not None:
        if not isinstance(methods, list) or not all(
            _is_non_empty_string(method) for method in methods
        ):
            return False
    body_format = value["bodyFormat"]
    if body_format is not None and body_format not in _BODY_FORMATS:
        return False
    if not _is_valid_value_conditions(value["equals"], value["oneOf"]):
        return False
    if body_format != "json" and (value["equals"] or value["oneOf"]):
        return False
    paths = value["paths"]
    return (
        isinstance(paths, list)
        and len(paths) > 0
        and all(_is_valid_path(path) for path in paths)
    )


def _is_valid_rule(value: object, scope_name: str, keys: set[str]) -> bool:
    if not _has_keys_within(value, _RULE_KEYS):
        return False
    if not {"id", "key", "precedes", "match", "onMatch"}.issubset(value.keys()):
        return False
    key = value["key"]
    if not isinstance(key, str) or _RULE_KEY.fullmatch(key) is None:
        return False
    if value["id"] != f"{scope_name}.{key}":
        return False
    precedes = value["precedes"]
    # A rule may only be ordered against rules of its own scope. Selection
    # reads these keys, so a key naming nothing would silently drop an edge
    # and let a broad allow overtake a narrow deny.
    if not isinstance(precedes, list) or not all(
        isinstance(other, str) and other in keys and other != key
        for other in precedes
    ):
        return False
    if not _is_valid_match(value["match"]):
        return False
    if value["onMatch"] not in _ACTIONS:
        return False
    if value.get("onIndeterminate", "deny") not in ("review", "deny"):
        return False
    expect = value.get("expect", [])
    if not isinstance(expect, list) or not all(
        _is_valid_expect(item) for item in expect
    ):
        return False
    # UnionShape / JsonRoot は解析済みの JSON ツリーを前提にする。format が
    # "json" でないルールに置かれていたら、検査は決して走らないのに設定は
    # 検査したつもりでいる。
    if value["match"]["bodyFormat"] != "json" and any(
        item["kind"] != "emptyBody" for item in expect
    ):
        return False
    if not _is_valid_limits(value.get("limits", _LIMIT_CEILINGS)):
        return False
    if not _is_valid_dispositions(value.get("secrets", {})):
        return False
    if not _is_valid_inject(value.get("inject", [])):
        return False
    return value.get("audit", "always") in ("always", "aggregate", "off")


def _is_valid_target(value: object) -> bool:
    if not _has_exact_keys(value, _TARGET_KEYS):
        return False
    host = value["host"]
    port = value["port"]
    if port is not None and (type(port) is not int or not 0 < port <= 65535):
        return False
    if not isinstance(host, dict):
        return False
    if host.get("kind") == "exact":
        return host.keys() == frozenset(("kind", "host")) and _is_non_empty_string(
            host["host"]
        )
    if host.get("kind") == "suffix":
        return host.keys() == frozenset(
            ("kind", "suffix")
        ) and _is_non_empty_string(host["suffix"])
    return False


def _is_valid_scope(value: object) -> bool:
    if not _has_keys_within(value, _SCOPE_KEYS):
        return False
    if not {"name", "targets", "fallback", "fallbackRuleId", "rules"}.issubset(
        value.keys()
    ):
        return False
    name = value["name"]
    if not _is_non_empty_string(name):
        return False
    if value["fallbackRuleId"] != f"{name}.{FALLBACK_RULE_KEY}":
        return False
    if value["fallback"] not in _ACTIONS:
        return False
    targets = value["targets"]
    if (
        not isinstance(targets, list)
        or len(targets) == 0
        or not all(_is_valid_target(target) for target in targets)
    ):
        return False
    rules = value["rules"]
    if not isinstance(rules, list):
        return False
    keys = {
        rule["key"]
        for rule in rules
        if isinstance(rule, dict) and isinstance(rule.get("key"), str)
    }
    if len(keys) != len(rules):
        return False
    if not all(_is_valid_rule(rule, name, keys) for rule in rules):
        return False
    if not _is_valid_limits(value.get("limits", _LIMIT_CEILINGS)):
        return False
    if not _is_valid_dispositions(value.get("secrets", {})):
        return False
    if not _is_valid_inject(value.get("inject", [])):
        return False
    return value.get("audit", "always") in ("always", "aggregate", "off")


def _is_valid_authz_document(value: object) -> bool:
    """Re-validate the document the host wrote.

    The host resolves the config once and writes the result here; this side
    checks the result again before trusting it. Anything unrecognised
    invalidates the whole document rather than the one rule that carries it,
    because a document the addon only half understands is a document whose
    selection it cannot reproduce."""
    try:
        if not _has_exact_keys(value, _DOCUMENT_KEYS):
            return False
        if type(value["contractVersion"]) is not int:
            return False
        if value["contractVersion"] != AUTHZ_CONTRACT_VERSION:
            return False
        if value["fallback"] not in ("review", "deny"):
            return False
        defaults = value["defaults"]
        if not _has_exact_keys(defaults, frozenset(("limits", "secrets", "audit"))):
            return False
        if not _is_valid_limits(defaults["limits"]):
            return False
        if not _is_valid_dispositions(defaults["secrets"]):
            return False
        if defaults["audit"] not in ("always", "aggregate", "off"):
            return False
        scopes = value["scopes"]
        return isinstance(scopes, list) and all(
            _is_valid_scope(scope) for scope in scopes
        )
    except Exception:
        return False


def _load_authz_document(session_id: str) -> object:
    path = os.path.join(AUTHZ_DIR, f"{session_id}.json")
    try:
        mtime = os.stat(path).st_mtime_ns
    except OSError:
        mtime = None

    cached = _authz_cache.get(session_id)
    if cached and cached[0] == mtime:
        return cached[1]

    state: object = _INVALID_AUTHZ_DOCUMENT
    if mtime is not None:
        try:
            with open(path) as f:
                document = json.load(f)
            if _is_valid_authz_document(document):
                state = document
        except Exception:
            pass
    _authz_cache[session_id] = (mtime, state)
    return state


def _hash_token(token: str) -> str:
    digest = hashlib.sha256(token.encode()).hexdigest()
    return f"sha256:{digest}"


def _decode_proxy_auth(header: Optional[str]) -> Optional[tuple[str, str]]:
    if not header:
        return None
    if not header.lower().startswith("basic "):
        return None
    try:
        decoded = base64.b64decode(header[6:].strip()).decode()
        idx = decoded.index(":")
        if idx <= 0 or idx == len(decoded) - 1:
            return None
        return decoded[:idx], decoded[idx + 1:]
    except Exception:
        return None


def _query_broker(socket_path: str, request: dict) -> dict:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(10.0)
        sock.connect(socket_path)
        line = json.dumps(request) + "\n"
        sock.sendall(line.encode())
        data = b""
        while b"\n" not in data:
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
        if not data:
            return {"decision": "deny", "reason": "empty-broker-response"}
        return json.loads(data.decode().strip())
    except Exception as e:
        return {"decision": "deny", "reason": f"broker-unavailable: {e}"}
    finally:
        sock.close()


REQUEST_POLICY_AUDIT_UNAVAILABLE = (
    "[nas-addon] request policy outcome audit unavailable"
)

# Closed label set for logging an untrusted request method. Anything outside
# it becomes "OTHER" so attacker-controlled bytes never reach stderr.
_SAFE_METHOD_LABELS = frozenset((
    "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE",
    "CONNECT",
))


def _safe_method_label(method: str) -> str:
    normalized = method.upper() if isinstance(method, str) else ""
    if normalized in _SAFE_METHOD_LABELS:
        return normalized
    return "OTHER"


def _request_policy_outcome_message(
    request_id: str,
    session_id: str,
    rule_id: str,
    result: str,
    reason: str,
    findings: list[dict],
) -> dict:
    """The outcome report, as a value. See `_violation_review_message`."""
    return {
        "version": 1,
        "type": "request_policy_outcome",
        "requestId": request_id,
        "sessionId": session_id,
        "ruleId": rule_id,
        "result": result,
        "reason": reason,
        "findings": findings,
    }


def _report_request_policy_outcome(
    socket_path: str,
    request_id: str,
    session_id: str,
    rule_id: str,
    result: str,
    reason: str,
    findings: list[dict],
) -> None:
    """Report a sanitized request-policy outcome to the broker.

    Beyond the closed protocol fields, the findings go too: no host, method,
    path, query, header, filename, credential or mask value, and nothing from
    the body that has not been through the mask patterns and the ceilings in
    `_expect_finding`. An acknowledgement failure prints one constant line and
    never changes the computed result."""
    try:
        response = _query_broker(socket_path, _request_policy_outcome_message(
            request_id, session_id, rule_id, result, reason, findings,
        ))
        if not (
            response.get("version") == 1
            and response.get("type") == "request_policy_outcome_recorded"
            and response.get("requestId") == request_id
        ):
            print(REQUEST_POLICY_AUDIT_UNAVAILABLE, file=sys.stderr)
    except Exception:
        print(REQUEST_POLICY_AUDIT_UNAVAILABLE, file=sys.stderr)


def _settle_violation_review(
    socket_path: str,
    request_id: str,
    session_id: str,
    rule_id: str,
    host: str,
    port: int,
    method: str,
    review_context: dict,
    findings: list[dict],
) -> bool:
    """Ask the broker whether these violations may pass.

    The broker holds the approvals, not the addon: it answers from the set of
    violations already approved this session, or it puts a card in front of a
    person and waits. Anything other than a clear allow — a broker that is
    gone, a malformed answer, a person who said no — leaves the request
    refused, because the request has not been shown to be acceptable.

    This blocks the proxy while it waits, the same way the authorization query
    does, and gives up on the same 10 second ceiling. A person who takes
    longer does not lose the approval: the broker keeps the card, and the
    press lands in the approved set, so the next request carrying the same
    violation passes without asking. With the conversation history resent
    every turn, that next request is usually seconds away."""
    response = _query_broker(socket_path, _violation_review_message(
        request_id, session_id, rule_id, host, port, method,
        review_context, findings,
    ))
    return response.get("decision") == "allow"


def _violation_review_message(
    request_id: str,
    session_id: str,
    rule_id: str,
    host: str,
    port: int,
    method: str,
    review_context: dict,
    findings: list[dict],
) -> dict:
    """The review query, as a value.

    Built apart from the sending so that `message_parity_test.ts` can hand a
    real one to the broker's validator. The broker refuses a message it does
    not recognize field for field, and a refusal turns into a dead session
    rather than a wrong answer, so the two sides have to be compared
    somewhere that does not need the proxy running."""
    return {
        "version": 1,
        "type": "request_policy_review",
        "requestId": request_id,
        "sessionId": session_id,
        "ruleId": rule_id,
        "target": {"host": host, "port": port},
        "method": method,
        "findings": findings,
        "reviewContext": review_context,
    }


def _authorize_message(
    request_id: str,
    session_id: str,
    host: str,
    port: int,
    method: str,
    body_truth: dict[str, str],
    review_context: dict,
) -> dict:
    """Build the authorization message shared with the broker validator."""
    return {
        "version": 1,
        "type": "authorize",
        "requestId": request_id,
        "sessionId": session_id,
        "target": {"host": host, "port": port},
        "method": method,
        "requestKind": "forward",
        "observedAt": time.strftime(
            "%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()
        ),
        "bodyTruth": body_truth,
        "reviewContext": review_context,
    }


def _normalize_host(host: str) -> str:
    h = host.strip().lower()
    if h.startswith("[") and h.endswith("]"):
        h = h[1:-1]
    while h.endswith("."):
        h = h[:-1]
    return h


def _should_emit_block_log(count: int) -> bool:
    return count > 0 and (count & (count - 1)) == 0


# --- generic request-policy engine -----------------------------------------
# Pure dispatcher for validated bodyless/json request policies. Returns
# (result, rewritten_body_or_none, closed_reason). Every exception path
# blocks; no body, exception, or secret data is logged here.


class _PolicyBlock(Exception):
    """Internal control-flow signal carrying a closed block reason."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _mask_json_string(value: str, patterns: list[bytes]) -> tuple[str, bool]:
    masked = _mask_bytes(
        value.encode("utf-8", "surrogatepass"), patterns
    ).decode("utf-8", "surrogatepass")
    if masked != value:
        return masked, True
    return value, False


def _recursively_mask_json(node, patterns: list[bytes]) -> tuple[object, bool]:
    """Mask every string value and object key recursively. Raises
    _PolicyBlock (key-collision) before inserting a duplicate masked key."""
    if isinstance(node, dict):
        changed = False
        new_node: dict = {}
        for key, value in node.items():
            masked_key = key
            if isinstance(key, str):
                masked_key, key_changed = _mask_json_string(key, patterns)
                changed = changed or key_changed
            new_value, value_changed = _recursively_mask_json(value, patterns)
            changed = changed or value_changed
            if masked_key in new_node:
                raise _PolicyBlock("key-collision")
            new_node[masked_key] = new_value
        return new_node, changed
    if isinstance(node, list):
        changed = False
        new_list = []
        for item in node:
            new_item, item_changed = _recursively_mask_json(item, patterns)
            new_list.append(new_item)
            changed = changed or item_changed
        return new_list, changed
    if isinstance(node, str):
        return _mask_json_string(node, patterns)
    return node, False


def _json_children(node) -> list:
    if isinstance(node, dict):
        return list(node.values())
    if isinstance(node, list):
        return list(node)
    return []


def _json_members(node) -> list[tuple[str, object]]:
    """Children paired with the JSON Pointer token that addresses them."""
    if isinstance(node, dict):
        return list(node.items())
    if isinstance(node, list):
        return [(str(index), item) for index, item in enumerate(node)]
    return []


def _pointer_step(pointer: str, token: str) -> str:
    """Append one reference token to a JSON Pointer (RFC 6901 escaping)."""
    return pointer + "/" + token.replace("~", "~0").replace("/", "~1")


def _parse_selector(selector: str) -> list[tuple[str, Optional[str]]]:
    """Parse a validated restricted-pointer selector into segments.

    Literal segments use JSON Pointer unescaping (`~1` -> `/`, `~0` -> `~`,
    applied in that order). `*` and `**` are wildcards."""
    segments: list[tuple[str, Optional[str]]] = []
    for raw in selector[1:].split("/"):
        if raw == "*":
            segments.append(("*", None))
        elif raw == "**":
            segments.append(("**", None))
        else:
            segments.append(
                ("literal", raw.replace("~1", "/").replace("~0", "~"))
            )
    return segments


def _json_pointer_index(literal: str) -> Optional[int]:
    """Return the array index a literal segment addresses, else None.

    RFC 6901 array indices are ASCII digits with no leading zero (only "0"
    itself may start with a zero). The end-of-array token "-" is rejected on
    purpose: it only addresses the append position, never an existing member,
    so treating it as a match would be unsound."""
    if not literal or not literal.isascii() or not literal.isdigit():
        return None
    if len(literal) > 1 and literal[0] == "0":
        return None
    try:
        return int(literal)
    except ValueError:
        # Python limits decimal-to-int conversion length. Any index beyond
        # that limit cannot address an in-memory request array, so it is a
        # missing member rather than an evaluator failure.
        return None


class _SelectorBudget:
    """Expansion accounting for the body inspection of one rule.

    One instance is shared by every walk that inspection performs — each
    guard, each of its `exclude` patterns, each encoded-field selector — so
    the configured ceiling bounds the whole inspection rather than being
    handed out afresh per walk, which would multiply it by the number of
    walks the policy happens to contain.

    A walk that runs out of budget stops early, which leaves the remaining
    subtrees uninspected. `exhausted` records that, so the caller can report
    an incomplete inspection instead of mistaking a truncated walk for a
    clean one, and `last_pointer` says how far the walk got. Both are sticky:
    once the shared budget is gone, every later walk in the same inspection
    finds nothing and the pointer keeps naming where the money ran out."""

    def __init__(self, max_expansions: int) -> None:
        self.max_expansions = max_expansions
        self.spent_expansions = 0
        self.exhausted = False
        self.last_pointer = ""

    def charge(self, pointer: str) -> bool:
        """Charge one state expansion. Returns False once the expansion
        budget is used up."""
        if self.exhausted:
            return False
        self.last_pointer = pointer
        if self.spent_expansions >= self.max_expansions:
            self.exhausted = True
            return False
        self.spent_expansions += 1
        return True


def _collect_selector_matches(
    node, segments, budget: _SelectorBudget, excluded=frozenset()
) -> list[tuple[str, object]]:
    """Collect (JSON Pointer, node) for every node reached by the selector. A
    node is recorded at most once per selector even when several `**` routes
    reach it, and a node whose pointer is in `excluded` is cut away together
    with its whole subtree — the walk never descends past it.

    Each (pointer, segment-index) state is charged to `budget` and memoized,
    so it is expanded at most once: expanding a state is a pure function of
    that state. Without the memo a selector with several `**` segments
    re-expands the same subtree once per route and grows superlinearly in the
    number of `**`; the depth and node budgets alone do not bound it. The
    memo is keyed by pointer rather than by object identity because Python
    hands out one shared object for small ints and for interned strings, and
    two positions holding such a value are two nodes to inspect."""
    matches: list[tuple[str, object]] = []
    visited: set = set()

    def expand(current, pointer: str, index: int) -> None:
        state = (pointer, index)
        if state in visited:
            return
        visited.add(state)
        if not budget.charge(pointer):
            return
        if pointer in excluded:
            return
        if index == len(segments):
            matches.append((pointer, current))
            return
        kind, literal = segments[index]
        if kind == "**":
            # Zero descendants: the remainder may match at this very node.
            expand(current, pointer, index + 1)
            # One or more descendants: keep `**` active while descending.
            for token, child in _json_members(current):
                expand(child, _pointer_step(pointer, token), index)
            return
        if kind == "*":
            for token, child in _json_members(current):
                expand(child, _pointer_step(pointer, token), index + 1)
            return
        if isinstance(current, dict):
            if literal in current:
                expand(
                    current[literal],
                    _pointer_step(pointer, literal),
                    index + 1,
                )
            return
        if isinstance(current, list):
            array_index = _json_pointer_index(literal)
            if array_index is not None and array_index < len(current):
                expand(
                    current[array_index],
                    _pointer_step(pointer, str(array_index)),
                    index + 1,
                )

    expand(node, "", 0)
    return matches


def _scan_selector(
    root, selector: str, excludes: list, budget: _SelectorBudget
) -> tuple[list[tuple[str, object]], Optional[tuple[str, str]]]:
    """Walk `selector` over `root` with every `exclude` subtree cut away.

    Every walk here is charged to the caller's `budget`, which spans the whole
    body inspection rather than this one scan.

    Returns (matches, incomplete). `incomplete` is None when both the exclude
    walks and the selector walk finished; otherwise it is the (selector, last
    pointer reached) pair of the walk that ran out of budget. An exclude walk
    that ran out cannot be trusted to have found everything it should cut, so
    it reports incomplete rather than inspecting an under-excluded tree."""
    excluded: set = set()
    for pattern in excludes:
        found = _collect_selector_matches(
            root, _parse_selector(pattern), budget
        )
        if budget.exhausted:
            return [], (pattern, budget.last_pointer)
        excluded.update(pointer for pointer, _node in found)

    matches = _collect_selector_matches(
        root, _parse_selector(selector), budget, excluded
    )
    if budget.exhausted:
        return matches, (selector, budget.last_pointer)
    return matches, None


def _account_json(node, max_depth: int, max_nodes: int) -> None:
    """Traverse with explicit depth and node accounting. Raises _PolicyBlock
    ("resource-limit") as soon as either budget is exceeded. Depth is checked
    before descending, so recursion stays bounded by max_depth."""
    remaining = [max_nodes]

    def walk(current, depth: int) -> None:
        if depth > max_depth:
            raise _PolicyBlock("resource-limit")
        remaining[0] -= 1
        if remaining[0] < 0:
            raise _PolicyBlock("resource-limit")
        for child in _json_children(current):
            walk(child, depth + 1)

    walk(node, 1)


def _mask_scalar_for_excerpt(node, patterns: list[bytes], remaining: list):
    """Mask one JSON scalar before it is serialized into the excerpt.

    Masking has to happen on the scalar's own content, not on the serialized
    document: the patterns hold the raw secret bytes, and `json.dumps`
    escapes `"`, `\\`, newline and tab, so a secret containing any of those
    stops matching once it has been escaped and would be emitted verbatim.

    A non-string scalar is masked in the form it will be printed in and
    becomes a string when that changes anything, so a secret spelled as a
    bare number cannot slip through either. Otherwise it is returned as is,
    which keeps numbers and booleans printed as numbers and booleans.

    A scalar longer than the remaining mask budget is elided whole rather
    than cut down to fit: masking scans the text once per pattern, so the
    budget has to be checked before the scan, and cutting first could split
    a secret and leave the unmatched remainder in the excerpt."""
    text = node if isinstance(node, str) else json.dumps(node)
    if len(text) > remaining[0]:
        return EXCERPT_ELIDED
    remaining[0] -= len(text)
    masked, changed = _mask_json_string(text, patterns)
    if isinstance(node, str):
        return masked
    return masked if changed else node


def _prune_for_excerpt(node, depth: int, patterns: list[bytes], remaining):
    """Copy the node with secrets masked, and with subtrees past the depth
    limit, members past the width limit, and text past the mask budget
    replaced by an elision marker.

    Width matters as much as depth here: the violating node can be most of
    the request body, and a container is copied member by member."""
    if isinstance(node, (dict, list)) and depth <= 0:
        return EXCERPT_ELIDED
    if isinstance(node, dict):
        pruned = {
            _mask_scalar_for_excerpt(key, patterns, remaining):
                _prune_for_excerpt(value, depth - 1, patterns, remaining)
            for key, value in itertools.islice(
                node.items(), EXCERPT_MAX_WIDTH
            )
        }
        if len(node) > EXCERPT_MAX_WIDTH:
            pruned[EXCERPT_ELIDED] = EXCERPT_ELIDED
        return pruned
    if isinstance(node, list):
        pruned = [
            _prune_for_excerpt(item, depth - 1, patterns, remaining)
            for item in itertools.islice(node, EXCERPT_MAX_WIDTH)
        ]
        if len(node) > EXCERPT_MAX_WIDTH:
            pruned.append(EXCERPT_ELIDED)
        return pruned
    return _mask_scalar_for_excerpt(node, patterns, remaining)


def _violation_excerpt(node, patterns: list[bytes]) -> str:
    """Render the violating node on its own, with secrets masked and the text
    cut off by depth, width, and bytes.

    A finding travels to an approval UI and to the audit log, so it must
    carry enough to recognize the node and no more: never the surrounding
    body, and never an unmasked secret that happened to sit inside it."""
    try:
        text = json.dumps(
            _prune_for_excerpt(
                node, EXCERPT_MAX_DEPTH, patterns, [EXCERPT_MASK_BUDGET]
            ),
            ensure_ascii=False,
            separators=(",", ":"),
        )
    except Exception:
        return EXCERPT_ELIDED
    # Every scalar is already masked; this second pass only covers a secret
    # that spans the punctuation the serializer inserts between them.
    raw = _mask_bytes(text.encode("utf-8", "surrogatepass"), patterns)
    if len(raw) > EXCERPT_MAX_BYTES:
        # Cutting by bytes can split a character; "replace" keeps the excerpt
        # printable rather than raising on the truncated tail.
        cut = raw[:EXCERPT_MAX_BYTES].decode("utf-8", "replace")
        return cut + EXCERPT_ELIDED
    return raw.decode("utf-8", "replace")


def _mask_tracking_separators(
    data: bytes, separators: list[bool], pattern: bytes
) -> tuple[bytes, list[bool]]:
    """Replace `pattern` the way `_mask_bytes` does — left to right, no
    overlaps — while carrying a per-byte "this byte is a separator" flag
    through the substitution.

    The bytes a match consumes take their flags with them, so a secret that
    swallowed a separator leaves no separator behind, and the replacement
    itself is content rather than structure."""
    out = bytearray()
    out_separators: list[bool] = []
    start = 0
    while True:
        hit = data.find(pattern, start)
        if hit < 0:
            out += data[start:]
            out_separators.extend(separators[start:])
            return bytes(out), out_separators
        out += data[start:hit]
        out_separators.extend(separators[start:hit])
        out += MASK_REPLACEMENT
        out_separators.extend([False] * len(MASK_REPLACEMENT))
        start = hit + len(pattern)


def _mask_json_pointer(pointer: str, patterns: list[bytes]) -> str:
    """Mask secrets in a JSON Pointer without stopping it being one.

    A pointer is assembled from object keys taken from the request body, so a
    key that holds a secret would otherwise reach a finding verbatim. Masking
    the pointer as it is written does not work, for two reasons that pull in
    opposite directions. A secret containing `/` or `~` appears there only in
    its escaped spelling and never matches the pattern at all, so masking has
    to see the unescaped text. But the `/` separators and the `~0`/`~1`
    escapes are structure, not content, so a secret that spans a separator
    would be replaced together with the punctuation that makes the pointer
    parseable.

    Masking therefore runs once over the whole unescaped text — every token's
    literal content joined by the separators — with a flag per byte recording
    which bytes are separators. Whatever the substitution does to the content,
    the surviving flags still say where the tokens end, and re-escaping each
    one rebuilds a pointer that parses. A secret that ate a separator merges
    the tokens it spanned into a single masked token, which is the honest
    result: those two tokens were one secret.

    Masking token by token would leave exactly that case unmasked, which is
    why one pass over the joined text replaces it rather than following it."""
    if not pointer:
        return pointer
    data = bytearray()
    separators: list[bool] = []
    for index, token in enumerate(pointer[1:].split("/")):
        if index:
            data += b"/"
            separators.append(True)
        literal = token.replace("~1", "/").replace("~0", "~")
        encoded = literal.encode("utf-8", "surrogatepass")
        data += encoded
        separators.extend([False] * len(encoded))

    masked_data = bytes(data)
    for pattern in patterns:
        # An empty pattern would match at every position without consuming
        # anything; `_build_mask_patterns` drops empty secrets, and this keeps
        # a hand-built pattern list from hanging the walk.
        if not pattern:
            continue
        masked_data, separators = _mask_tracking_separators(
            masked_data, separators, pattern
        )

    masked = ""
    token_bytes = bytearray()
    for byte, is_separator in zip(masked_data, separators):
        if is_separator:
            masked = _pointer_step(
                masked, token_bytes.decode("utf-8", "surrogatepass")
            )
            token_bytes = bytearray()
        else:
            token_bytes.append(byte)
    return _pointer_step(
        masked, token_bytes.decode("utf-8", "surrogatepass")
    )


def _reject_non_standard_constant(_literal: str):
    """Reject NaN / Infinity / -Infinity.

    They are Python extensions, not RFC 8259 JSON. Accepting them would let
    the rewrite path re-serialize a body that strict parsers upstream would
    reject, so they are classified as malformed input."""
    raise _PolicyBlock("invalid-json")


def _reject_duplicate_members(pairs):
    parsed_object: dict = {}
    for key, value in pairs:
        if key in parsed_object:
            raise _PolicyBlock("invalid-json")
        parsed_object[key] = value
    return parsed_object


def _parse_javascript_integer(literal: str):
    """Parse a JSON integer without crossing Python's bigint digit limit.

    JavaScript parses every JSON number as an IEEE-754 Number. Any integer
    with more than 309 decimal digits is therefore infinite regardless of its
    leading digits. Shorter literals stay as bounded Python ints so ordinary
    request rewriting retains its existing spelling; numeric comparisons
    convert them to JavaScript Number precision in `_javascript_number`.
    """
    negative = literal.startswith("-")
    digits = literal[1:] if negative else literal
    if len(digits) > _MAX_JS_FINITE_INTEGER_DIGITS:
        return -math.inf if negative else math.inf
    return int(literal)


def _cut_finding_value(value: Optional[str]) -> Optional[str]:
    """Bound a masked offending value without merging two of them.

    The value identifies what an approval covers, so a plain cut would let a
    body choose a long value sharing its prefix with one the operator already
    approved and inherit that approval. Appending a digest of the whole value
    keeps the identity injective, and the rendering is longer than the ceiling
    so an uncut value can never spell one."""
    if value is None or len(value) <= FINDING_VALUE_MAX_CHARS:
        return value
    digest = hashlib.sha256(
        value.encode("utf-8", "surrogatepass")
    ).hexdigest()[:FINDING_VALUE_DIGEST_CHARS]
    return value[:FINDING_VALUE_MAX_CHARS] + EXCERPT_ELIDED + "#" + digest


def _cut_finding_pointer(pointer: str) -> str:
    """Bound a masked pointer. Unlike the value it is not part of any
    identity, so cutting it can only cost the reader precision about where the
    node was."""
    if len(pointer) <= FINDING_POINTER_MAX_CHARS:
        return pointer
    return pointer[:FINDING_POINTER_MAX_CHARS] + EXCERPT_ELIDED


def _expect_finding(
    expect_index: int, expect_kind: str, at: str, pointer: str,
    value: Optional[str], excerpt: Optional[str], kind: str,
    patterns: list[bytes], count: int = 1,
) -> dict:
    """Build one finding, masking the pointer and bounding it on the way in.

    The pointer is masked here rather than at the call sites so that every
    body-derived field on a finding — pointer, value, excerpt — is masked by
    the time the record exists, and a new call site cannot forget one. `at`
    needs no masking: it is the selector out of the rule, not body text.

    The same argument applies to size. The pointer and the value are built out
    of the body, so they are as large as the body lets them be; the finding
    leaves this process for an approval UI and an audit log, and both of those
    are the addon's to bound. Cutting here means no call site can produce an
    unbounded one.

    `expect` is the position of the acceptance condition inside the rule's
    `expect` list, which is what an approval is keyed by: approving a tag
    found by `/**/content/*` must not also approve the same tag found by
    `/system/*`."""
    return {
        "expect": expect_index,
        "expectKind": expect_kind,
        "at": at,
        "kind": kind,
        "pointer": _cut_finding_pointer(
            _mask_json_pointer(pointer, patterns)
        ),
        "value": _cut_finding_value(value),
        "excerpt": excerpt,
        "count": count,
    }


def _scan_union_shape(
    root, expect: dict, index: int, patterns: list[bytes],
    budget: _SelectorBudget,
) -> tuple[bool, Optional[tuple[str, str]], list[dict], int]:
    """Check every node the selector reaches.

    Returns (violated, incomplete, findings, dropped) where `findings` are
    this condition's own records and `dropped` counts the violations its
    allowance had no room to describe.

    A matched node must be an object whose discriminator is its own string
    property listed in `allowed`; any other shape is a violation. A selector
    matching zero nodes is not a violation.

    The walk does not stop at the first violation. An approver decides per
    violated value, so a truncated list would surface the next violation only
    after the previous one was approved, and the audit record would name one
    value out of many. Violations of the same condition with the same value
    are one finding with a count, which is the unit an approval applies to."""
    matches, incomplete = _scan_selector(
        root, expect["at"], expect.get("exclude") or [], budget
    )
    discriminator = expect["discriminator"]
    allowed = frozenset(expect["allowed"])
    by_value: dict = {}
    findings: list[dict] = []
    dropped = 0
    violated = False
    for pointer, node in matches:
        value = None
        if isinstance(node, dict):
            tag = node.get(discriminator)
            if isinstance(tag, str):
                if tag in allowed:
                    continue
                value = _mask_json_string(tag, patterns)[0]
            # A missing or non-string discriminator leaves no value to
            # approve, so those group together under the empty value.
        violated = True
        seen_finding = by_value.get(value)
        if seen_finding is not None:
            seen_finding["count"] += 1
            continue
        if len(findings) >= MAX_FINDINGS_PER_EXPECT:
            # Counted, but not recorded, and not entered into `by_value`
            # either: keeping the map bounded is what keeps the memory
            # bounded when every value is distinct.
            dropped += 1
            continue
        finding = _expect_finding(
            index, expect["kind"], expect["at"], pointer, value,
            _violation_excerpt(node, patterns), FINDING_SCHEMA_MISMATCH,
            patterns,
        )
        by_value[value] = finding
        findings.append(finding)
    return violated, incomplete, findings, dropped


def _evaluate_expects(
    expects: list, body: Optional[bytes], parsed, patterns: list[bytes],
    budget: _SelectorBudget,
) -> tuple[Optional[str], list[dict]]:
    """Evaluate every acceptance condition of a rule.

    Returns (severity, findings) where severity is the strictest
    `onViolation` among the conditions that were violated, or None when none
    were. The list is a conjunction and it does not short-circuit: an
    approver decides per violated value, so the findings have to be complete.

    An unfinished selector walk proved nothing about the subtrees it never
    reached, so it counts as a violation whose consequence is the strictest
    `onViolation` the rule declares anywhere — the walk cannot say which
    condition it would have failed, so it assumes the worst one on offer."""
    findings: list[dict] = []
    violated: list[str] = []
    incomplete: Optional[tuple[str, str]] = None

    for index, expect in enumerate(expects):
        kind = expect["kind"]
        if kind == "emptyBody":
            if body is None or len(body) != 0:
                violated.append(expect["onViolation"])
                # A body that could not be read is not a body proved empty.
                # It is reported as unreadable rather than as a body that was
                # present, because the two ask the operator to look at
                # different things.
                finding_kind = (
                    FINDING_BODY_UNAVAILABLE if body is None
                    else FINDING_UNEXPECTED_BODY
                )
                # One violation at most, so this condition cannot exhaust its
                # own allowance and never needs to check it.
                findings.append(_expect_finding(
                    index, kind, "", "", None, None, finding_kind, patterns,
                ))
            continue
        if kind == "jsonRoot":
            wanted = dict if expect["rootType"] == "object" else list
            if not isinstance(parsed, wanted):
                violated.append(expect["onViolation"])
                findings.append(_expect_finding(
                    index, kind, "", "", None, None,
                    FINDING_SCHEMA_MISMATCH, patterns,
                ))
            continue
        hit, incomplete, scanned, dropped = _scan_union_shape(
            parsed, expect, index, patterns, budget
        )
        findings.extend(scanned)
        if dropped:
            # No pointer, value or excerpt: this record stands for the
            # violations of this condition whose own records were never
            # built. Its count is what they add up to, so the totals across
            # the list still cover every violation. It names the condition it
            # belongs to, which is how the operator learns which one to
            # narrow — but it is not an approvable finding, because the
            # values it stands for were never kept.
            findings.append(_expect_finding(
                index, kind, expect["at"], "", None, None,
                FINDING_FINDINGS_TRUNCATED, patterns, count=dropped,
            ))
        if hit:
            violated.append(expect["onViolation"])
        if incomplete is not None:
            # Every remaining condition would walk a budget it cannot charge,
            # match nothing, and repeat the same incomplete finding.
            break

    if incomplete is not None:
        exhausted_selector, last_pointer = incomplete
        findings.append(_expect_finding(
            -1, "", exhausted_selector, last_pointer, None, None,
            FINDING_INSPECTION_INCOMPLETE, patterns,
        ))
        violated.extend(expect["onViolation"] for expect in expects)

    if not violated:
        return None, findings
    return max(violated, key=lambda action: VIOLATION_SEVERITY[action]), findings


def _findings_block_reason(findings: list[dict]) -> str:
    """An unfinished walk proved nothing about the subtrees it never reached,
    so it is reported as a resource limit rather than as a shape mismatch."""
    for finding in findings:
        if finding["kind"] == FINDING_INSPECTION_INCOMPLETE:
            return "resource-limit"
    for finding in findings:
        if finding["kind"] == FINDING_BODY_UNAVAILABLE:
            return "body-unavailable"
    for finding in findings:
        if finding["kind"] == FINDING_UNEXPECTED_BODY:
            return "unexpected-body"
    return "schema-mismatch"


def _request_carries_body(request) -> bool:
    """Whether the request declares that it carries a body at all.

    mitmproxy reports `b""` for a GET that carries no body and for a
    `Content-Length: 0` POST that carries an empty one; `raw_content` and
    `data.content` are `b""` in both cases too, so the bytes cannot tell the
    two apart. HTTP framing can: a request has a body exactly when it says so
    with `Content-Length` or `Transfer-Encoding`.

    Only the zero-byte case needs to ask. Bytes that arrived are a body
    whatever the headers claim."""
    headers = request.headers
    return "content-length" in headers or "transfer-encoding" in headers


def _classify_body(
    body: Optional[bytes], max_body_bytes: int, carries_body: bool
) -> tuple[str, object]:
    """Sort a body into the four kinds selection distinguishes.

    A body that cannot be read at all is reported as `binary` rather than
    `absent`. `absent` means the request carries no body, which makes every
    body condition false and lets a broader rule take the request; a body
    that exists but could not be decoded has proved nothing, so it has to
    reach a `json` condition as indeterminate.

    Zero bytes are `absent` or `empty` depending on the framing, and the two
    are not interchangeable: an absent body satisfies no `format`, while an
    empty one satisfies `"opaque"` and `"none"`. Collapsing both into `empty`
    would let a bodyless GET be taken by a rule whose condition is that the
    request carries something."""
    if body is None:
        return "binary", None
    if len(body) == 0:
        return ("empty" if carries_body else "absent"), None
    if len(body) > max_body_bytes:
        return "binary", None
    try:
        parsed = json.loads(
            body,
            object_pairs_hook=_reject_duplicate_members,
            parse_constant=_reject_non_standard_constant,
            parse_int=_parse_javascript_integer,
        )
    except Exception:
        return "binary", None
    return "json", parsed


def _inspect_body(
    rule: dict, body: Optional[bytes], parsed, patterns: list[bytes]
) -> tuple[str, Optional[bytes], str, list[dict]]:
    """Run a rule's acceptance conditions and secret masking over the body.

    Returns (result, rewritten_body_or_none, closed_reason, findings) where
    result is one of "pass", "rewrite", "block", or "review". Any unclassified
    exception blocks with "processing-failed": a body inspection that fell over
    has not shown the request to be acceptable.

    "review" is not an outcome. It says the strictest violated condition asks
    for a person, and the caller has to settle it with the broker before the
    request goes anywhere; the rewritten body comes back with it so that an
    approval does not have to redo the masking. Nothing below here can settle
    it, because the answer lives in the broker's approved set or in a human.

    The findings travel out with the result. The reason is a closed label — it
    says a shape did not match, never which condition or which value — so it
    is all the audit log can carry unless the findings leave with it."""
    findings: list[dict] = []
    expects = rule.get("expect", [])
    # `maxBodyBytes` is not read here. Selection precomputes every candidate's
    # truth under its own byte budget, and a tree only arrives here when the
    # chosen rule's budget paid for it.
    limits = rule.get("limits", _LIMIT_CEILINGS)
    # A rule that did not declare `format = "json"` never asked for the body
    # to be read as JSON, so it does not get the structural pass either — the
    # tree is only there because classification parses every body once.
    if rule["match"]["bodyFormat"] != "json":
        parsed = None
    if not expects and parsed is None:
        return "pass", None, "no-inspection", findings

    try:
        if parsed is not None:
            # Accounting runs first on purpose: it proves the tree is within
            # the depth and node budgets, which is what bounds the recursive
            # `**` selector traversal and the masking walk that follow.
            _account_json(parsed, limits["maxDepth"], limits["maxNodes"])
        # One budget for the whole inspection of this body. The expansion
        # ceiling is a resource ceiling for a rule, so every walk the rule
        # performs draws on the same allowance; allocating one per walk would
        # let the real ceiling grow with the number of acceptance conditions
        # and exclude patterns the rule happens to declare.
        budget = _SelectorBudget(limits["maxSelectorExpansions"])
        severity, findings = _evaluate_expects(
            expects, body, parsed, patterns, budget
        )
        if severity == "deny":
            raise _PolicyBlock(_findings_block_reason(findings))

        if parsed is None:
            # No JSON tree, so nothing to mask structurally. The byte-level
            # masking the caller applies covers this body.
            if severity == "review":
                return "review", None, REASON_VIOLATIONS_REVIEW, findings
            if severity == "allow":
                return "pass", None, "violations-allowed", findings
            if any(expect["kind"] == "emptyBody" for expect in expects):
                return "pass", None, "empty-body", findings
            return "pass", None, "no-inspection", findings
        masked, changed = _recursively_mask_json(parsed, patterns)
    except _PolicyBlock as exc:
        return "block", None, exc.reason, findings
    except Exception:
        return "block", None, "processing-failed", findings

    if not changed:
        if severity == "review":
            return "review", None, REASON_VIOLATIONS_REVIEW, findings
        return (
            "pass",
            None,
            "violations-allowed" if severity == "allow" else "recognized-json",
            findings,
        )
    try:
        serialized = json.dumps(
            masked, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
    except Exception:
        return "block", None, "serialization-failed", findings
    if severity == "review":
        return "review", serialized, REASON_VIOLATIONS_REVIEW, findings
    # Both are true of this body, and the outcome carries one reason: the
    # violation wins. A rule that sets `onViolation = "allow"` is required to
    # keep its audit on precisely so that letting a violation through leaves a
    # trace, and reporting the rewrite instead spends the only slot there is
    # on the fact that is already visible in the result field.
    return (
        "rewrite",
        serialized,
        "violations-allowed" if severity == "allow" else "masked-json",
        findings,
    )


# --- selection -------------------------------------------------------------
# Mirrors `decide` in src/network/authz/resolve.ts. The host resolves the
# config and the addon reproduces the same choice on the same document; the
# two are compared before the body is inspected, so a divergence fails closed
# instead of running a rule the broker never approved.


def _host_matches(pattern: dict, host: str) -> bool:
    if pattern["kind"] == "exact":
        return pattern["host"] == host
    suffix = pattern["suffix"]
    return host.endswith("." + suffix) and len(host) > len(suffix) + 1


def _scope_matches(scope: dict, host: str, port: int) -> bool:
    return any(
        _host_matches(target["host"], host)
        and (target["port"] is None or target["port"] == port)
        for target in scope["targets"]
    )


def _select_scope(document: dict, host: str, port: int) -> Optional[dict]:
    """Pick the one scope a target belongs to.

    Scopes arrive ordered narrowest first: the host sorts them by target
    specificity, and the config error check guarantees that any two scopes a
    single target matches are nested rather than merely overlapping. The
    matching scopes therefore form a chain, and the first one in document
    order is its narrowest member."""
    for scope in document["scopes"]:
        if _scope_matches(scope, host, port):
            return scope
    return None


def _segment_matches(segment: dict, token: str) -> bool:
    return segment["kind"] == "all" or token in segment["values"]


def _path_matches(pattern: dict, path: str) -> bool:
    """No normalization: no percent-decoding, no collapsing of repeated
    slashes, no stripping of a trailing slash. The leading `/` is kept as an
    empty leading token on both sides so the two splits line up."""
    tokens = path.split("/")
    segments = pattern["segments"]
    if pattern["trailingDoubleStar"]:
        if len(tokens) < len(segments):
            return False
    elif len(tokens) != len(segments):
        return False
    return all(
        _segment_matches(segment, tokens[index])
        for index, segment in enumerate(segments)
    )


def _path_for_selection(path: str) -> str:
    """The query string takes no part in selection."""
    query = path.find("?")
    return path if query == -1 else path[:query]


def _is_candidate(rule: dict, method: str, path: str) -> bool:
    methods = rule["match"]["methods"]
    if methods is not None and method not in methods:
        return False
    return any(_path_matches(pattern, path) for pattern in rule["match"]["paths"])


def _order_candidates(candidates: list) -> Optional[list]:
    """Order this request's candidates, and only this request's candidates.

    `precedes` names the rules a rule is evaluated before; it is a partial
    order, so a plain sort cannot express it. This is a topological sort of
    that order that prefers declaration order whenever the order does not
    decide, which is exactly the tie-break the design gives to candidates the
    specificity order leaves incomparable.

    Restricting the sort to the candidates is load-bearing. Ordering the whole
    scope first and filtering afterwards lets rules that cannot match this
    request take part in the tie-break between rules that can, so adding one
    unrelated rule reorders two others — and with evaluation stopping at the
    first indeterminate candidate, that reordering is observable as a deny
    turning into an allow.

    Returns None when the order has a cycle. The document is rejected for
    cycles before it is written, so this cannot happen; if it does, refusing
    to choose is the only safe answer, because falling back to declaration
    order would let a broad allow overtake a narrow deny."""
    # predecessors[j] = the candidates that must be evaluated before j.
    predecessors = [
        {
            earlier["key"]
            for earlier in candidates
            if earlier["key"] != rule["key"]
            and rule["key"] in earlier["precedes"]
        }
        for rule in candidates
    ]

    ordered: list = []
    emitted: set = set()
    while len(ordered) < len(candidates):
        for index, rule in enumerate(candidates):
            if rule["key"] in emitted:
                continue
            if predecessors[index].issubset(emitted):
                emitted.add(rule["key"])
                ordered.append(rule)
                break
        else:
            return None
    return ordered


def _evaluate_body_format(body_format: Optional[str], body_kind: str) -> str:
    """Three-valued evaluation of `match.body.format`.

    Indeterminate is not folded into false. Folding them would mean a broken
    body evades a condition: the rule that declares the condition would
    decline, and a broader rule would pick the request up."""
    if body_format is None:
        return "true"
    # A request with no body satisfies no format: every format asks the body
    # to exist. This is why a match with no body condition is wider than
    # "opaque".
    if body_kind == "absent":
        return "false"
    if body_format == "none":
        return "true" if body_kind == "empty" else "false"
    if body_format == "opaque":
        return "true"
    # "json": an empty body and a broken body are both unparseable, which is
    # indeterminate rather than false.
    return "true" if body_kind == "json" else "indeterminate"


_POINTER_MISSING = object()


def _resolve_json_pointer(root, pointer: str):
    if pointer == "":
        return root
    current = root
    for raw in pointer[1:].split("/"):
        token = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(current, list):
            index = _json_pointer_index(token)
            if index is None or index >= len(current):
                return _POINTER_MISSING
            current = current[index]
            continue
        if not isinstance(current, dict) or token not in current:
            return _POINTER_MISSING
        current = current[token]
    return current


def _scalars_equal(left, right) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is bool and type(right) is bool and left == right
    if isinstance(left, str) or isinstance(right, str):
        return type(left) is str and type(right) is str and left == right
    if type(left) not in (int, float) or type(right) not in (int, float):
        return False
    return _javascript_number(left) == _javascript_number(right)


def _javascript_number(value):
    """Convert a Python JSON number to JavaScript's IEEE-754 Number."""
    try:
        return float(value)
    except OverflowError:
        return math.inf if value > 0 else -math.inf


def _evaluate_pointer(root, pointer: str, expected: list) -> str:
    found = _resolve_json_pointer(root, pointer)
    if found is _POINTER_MISSING:
        return "false"
    if not _is_observed_json_scalar(found):
        return "indeterminate"
    return (
        "true"
        if any(_scalars_equal(found, value) for value in expected)
        else "false"
    )


def _evaluate_body_match(match: dict, body_kind: str, parsed_body) -> str:
    """Mirror TypeScript evaluateBody for the stage-3 Pointer vocabulary."""
    format_truth = _evaluate_body_format(match["bodyFormat"], body_kind)
    if format_truth != "true":
        return format_truth

    equals = match["equals"]
    one_of = match["oneOf"]
    if not equals and not one_of:
        return "true"
    if body_kind != "json":
        return "indeterminate"

    indeterminate = False
    determined_false = False
    conditions = itertools.chain(
        ((pointer, [value]) for pointer, value in equals.items()),
        one_of.items(),
    )
    for pointer, expected in conditions:
        truth = _evaluate_pointer(parsed_body, pointer, expected)
        if truth == "indeterminate":
            indeterminate = True
        elif truth == "false":
            determined_false = True

    # An uninspectable target stops candidate traversal even when another
    # condition is already false; otherwise a malformed body can evade a
    # more specific rule and fall through to a broader one.
    if indeterminate:
        return "indeterminate"
    return "false" if determined_false else "true"


def _body_truth_table(
    document: dict, host: str, port: int, method: str, path: str,
    body_kind: str, body_size: Optional[int], parsed_body=None,
) -> dict[str, str]:
    """Evaluate every candidate under that candidate's body byte budget."""
    scope = _select_scope(document, host, port)
    if scope is None:
        return {}
    candidates = [
        rule
        for rule in scope["rules"]
        if _is_candidate(rule, method, _path_for_selection(path))
    ]
    truths = {}
    for rule in candidates:
        candidate_kind = body_kind
        candidate_parsed = parsed_body
        max_body_bytes = rule.get("limits", _LIMIT_CEILINGS)["maxBodyBytes"]
        if body_size is not None and body_size > max_body_bytes:
            candidate_kind = "binary"
            candidate_parsed = None
        truths[rule["id"]] = _evaluate_body_match(
            rule["match"], candidate_kind, candidate_parsed
        )
    return truths


def _decide(document: dict, host: str, port: int, method: str,
            path: str, body_truth: dict[str, str]) -> dict:
    """Return {action, ruleId, reason, scope, rule} for one request."""
    scope = _select_scope(document, host, port)
    if scope is None:
        return {
            "action": document["fallback"],
            "ruleId": FALLBACK_RULE_KEY,
            "reason": "network-fallback",
            "scope": None,
            "rule": None,
        }

    candidates = [
        rule
        for rule in scope["rules"]
        if _is_candidate(rule, method, _path_for_selection(path))
    ]
    ordered = _order_candidates(candidates) if len(candidates) > 1 else candidates
    if ordered is None:
        return {
            "action": "deny",
            "ruleId": scope["fallbackRuleId"],
            "reason": "unorderable-candidates",
            "scope": scope,
            "rule": None,
        }

    for rule in ordered:
        truth = body_truth.get(rule["id"], "indeterminate")
        if truth == "false":
            continue
        if truth == "true":
            return {
                "action": rule["onMatch"],
                "ruleId": rule["id"],
                "reason": "rule",
                "scope": scope,
                "rule": rule,
            }
        # Evaluation stops here on purpose. Carrying on would let a broader
        # rule quietly cover for a narrower rule that could not be decided.
        return {
            "action": rule.get("onIndeterminate", "deny"),
            "ruleId": rule["id"],
            "reason": "indeterminate",
            "scope": scope,
            "rule": None,
        }

    return {
        "action": scope["fallback"],
        "ruleId": scope["fallbackRuleId"],
        "reason": "scope-fallback",
        "scope": scope,
        "rule": None,
    }

def _safe_session_label(session_id: str) -> str:
    if _SAFE_SESSION_LABEL.fullmatch(session_id):
        return session_id
    return "invalid"


def _safe_rule_label(rule_id: object) -> str:
    """Rule IDs reach the log from the broker response, so re-check the
    syntax the contract promises before printing one."""
    if isinstance(rule_id, str) and _SAFE_RULE_ID.fullmatch(rule_id):
        return rule_id
    return "invalid"


def _generate_request_id() -> str:
    return f"req_{os.urandom(6).hex()}"


def _verify_creds(session_id: str, token: str) -> Optional[dict]:
    registry = _load_registry(session_id)
    if not registry:
        return None
    token_hash = _hash_token(token)
    if token_hash != registry.get("tokenHash"):
        return None
    return registry


class NasAddon:
    def __init__(self):
        # CONNECT credentials keyed by client connection id.
        # For HTTPS, Proxy-Authorization is only on the CONNECT request,
        # not on inner requests after TLS decryption.
        self._connect_creds: dict[str, tuple[str, str]] = {}
        # mask_values is fixed for the whole session, so cache the derived
        # patterns instead of re-deriving raw + quote + quote_plus + base64
        # variants per secret on every allowed request.
        self._mask_values_cache: Optional[list[str]] = None
        self._mask_patterns_cache: list[bytes] = []
        self._forbid_values_cache: Optional[list[str]] = None
        self._forbid_patterns_cache: list[bytes] = []
        self._request_policy_block_counts: dict[tuple[str, ...], int] = {}
        self._client_sessions: dict[str, set[str]] = {}

    def _patterns_for(self, mask_values: list[str]) -> list[bytes]:
        if mask_values == self._mask_values_cache:
            return self._mask_patterns_cache
        patterns = _build_mask_patterns(mask_values)
        self._mask_values_cache = mask_values
        self._mask_patterns_cache = patterns
        return patterns

    def _forbid_patterns_for(self, forbid_values: list[str]) -> list[bytes]:
        if forbid_values == self._forbid_values_cache:
            return self._forbid_patterns_cache
        patterns = _build_mask_patterns(forbid_values)
        self._forbid_values_cache = forbid_values
        self._forbid_patterns_cache = patterns
        return patterns

    def http_connect(self, flow: http.HTTPFlow) -> None:
        proxy_auth = flow.request.headers.get("proxy-authorization", "")
        creds = _decode_proxy_auth(proxy_auth)
        if not creds:
            print(f"[nas-addon] CONNECT 407: missing creds, "
                  f"client={flow.client_conn.id}, "
                  f"target={flow.request.host}:{flow.request.port}",
                  file=sys.stderr)
            flow.response = http.Response.make(
                407, b"missing proxy credentials",
                {"Proxy-Authenticate": 'Basic realm="nas"'},
            )
            flow.kill()
            return

        session_id, token = creds
        if not _verify_creds(session_id, token):
            print(f"[nas-addon] CONNECT 407: invalid creds, "
                  f"client={flow.client_conn.id}, "
                  f"session={session_id}, "
                  f"target={flow.request.host}:{flow.request.port}",
                  file=sys.stderr)
            flow.response = http.Response.make(
                407, b"invalid proxy credentials",
                {"Proxy-Authenticate": 'Basic realm="nas"'},
            )
            flow.kill()
            return

        self._connect_creds[flow.client_conn.id] = creds
        self._client_sessions.setdefault(flow.client_conn.id, set()).add(
            session_id
        )

    def request(self, flow: http.HTTPFlow) -> None:
        # Try request header first (HTTP forward proxy),
        # fall back to stored CONNECT creds (HTTPS after MitM).
        proxy_auth = flow.request.headers.get("proxy-authorization", "")
        creds = _decode_proxy_auth(proxy_auth)
        cred_source = "header" if creds else None
        if not creds:
            creds = self._connect_creds.get(flow.client_conn.id)
            if creds:
                cred_source = "connect_cache"
        if not creds:
            # The request is unauthenticated, so every field on it is
            # attacker-controlled. Only the closed method label is safe to
            # log; the path is never logged because no resolved rule has
            # classified it at this point.
            print(f"[nas-addon] REQUEST 407: no creds found, "
                  f"client={flow.client_conn.id}, "
                  f"has_proxy_auth={bool(proxy_auth)}, "
                  f"method={_safe_method_label(flow.request.method)}",
                  file=sys.stderr)
            flow.response = http.Response.make(
                407, b"missing proxy credentials",
                {"Proxy-Authenticate": 'Basic realm="nas"'},
            )
            flow.kill()
            return

        session_id, token = creds
        registry = _load_registry(session_id)
        if not registry:
            flow.response = http.Response.make(403, b"stale-session")
            return

        token_hash = _hash_token(token)
        if token_hash != registry.get("tokenHash"):
            flow.response = http.Response.make(
                407, b"invalid proxy credentials",
                {"Proxy-Authenticate": 'Basic realm="nas"'},
            )
            return

        host = _normalize_host(flow.request.host)
        port = flow.request.port
        method = flow.request.method
        request_path = flow.request.path

        document = _load_authz_document(session_id)
        if (
            document is _INVALID_AUTHZ_DOCUMENT
            or not isinstance(document, dict)
        ):
            print(
                "[nas-addon] AUTHZ-CONTRACT-INVALID: "
                f"session={_safe_session_label(session_id)}",
                file=sys.stderr,
            )
            flow.response = http.Response.make(
                403,
                REQUEST_POLICY_BLOCK_BODY,
            )
            return

        self._client_sessions.setdefault(flow.client_conn.id, set()).add(
            session_id
        )

        # Parse once under the scope budget, then evaluate every candidate
        # under its own maxBodyBytes. Selection consumes the resulting leaf
        # truths in one pass; it does not choose a rule and re-run itself.
        scope = _select_scope(document, host, port)
        limits = (
            scope.get("limits", _LIMIT_CEILINGS)
            if scope is not None
            else document["defaults"]["limits"]
        )
        try:
            request_body = flow.request.content
        except ValueError:
            request_body = None
        body_kind, parsed_body = _classify_body(
            request_body,
            limits["maxBodyBytes"],
            _request_carries_body(flow.request),
        )

        body_size = None if request_body is None else len(request_body)
        body_truth = _body_truth_table(
            document, host, port, method, request_path, body_kind,
            body_size, parsed_body,
        )
        local = _decide(
            document, host, port, method, request_path, body_truth
        )
        selected_rule = local["rule"]
        if (
            selected_rule is not None
            and body_size is not None
            and body_size
            > selected_rule.get("limits", _LIMIT_CEILINGS)["maxBodyBytes"]
        ):
            # A conditionless/opaque rule can still own an over-budget body,
            # but its acceptance inspection may not reuse a tree that its own
            # budget did not pay for.
            parsed_body = None

        request_id = _generate_request_id()
        broker_socket = os.path.join(BROKERS_DIR, session_id, "sock")

        body_bytes = request_body or b""
        # What a person is told about the request, on both the authorization
        # card and the violation card. No slice of the body is on it: the
        # first kilobyte of a 100KB conversation shows nothing worth
        # deciding on, and what is worth deciding on — the node a condition
        # refused — arrives as a finding once the body has been inspected.
        review_context = {
            "path": request_path,
            "contentType": flow.request.headers.get("content-type"),
            "bodySize": len(body_bytes),
        }

        authorize_req = _authorize_message(
            request_id, session_id, host, port, method, body_truth,
            review_context,
        )

        decision = _query_broker(broker_socket, authorize_req)

        if decision.get("decision") != "allow":
            message = decision.get("message", decision.get("reason", "denied"))
            flow.response = http.Response.make(
                403, message.encode() if isinstance(message, str) else b"denied"
            )
            return

        # The broker names the rule it approved. Both sides ran the same
        # selection over the same document, so a disagreement means one of
        # them is working from something the other never saw. Executing
        # either side's answer at that point would run a rule nobody
        # authorized for this request.
        rule_id = decision.get("ruleId")
        if rule_id != local["ruleId"]:
            print(
                "[nas-addon] AUTHZ-RULE-MISMATCH: "
                f"session={_safe_session_label(session_id)} "
                f"broker={_safe_rule_label(rule_id)} "
                f"addon={_safe_rule_label(local['ruleId'])}",
                file=sys.stderr,
            )
            flow.response = http.Response.make(403, REQUEST_POLICY_BLOCK_BODY)
            return

        # Mask secrets out of the outgoing request (URL / headers / body)
        # before credential injection so injected headers stay intact.
        mask_values = decision.get("maskValues") or []
        patterns = self._patterns_for(mask_values) if mask_values else []

        # A `forbid` secret may not leave the sandbox at all, so its presence
        # is checked before anything is rewritten — masking would erase the
        # very occurrence that has to stop the request.
        forbid_values = decision.get("forbidValues") or []
        if forbid_values and _contains_forbidden(
            flow, self._forbid_patterns_for(forbid_values)
        ):
            print(
                "[nas-addon] FORBIDDEN-SECRET: "
                f"session={_safe_session_label(session_id)} "
                f"rule={_safe_rule_label(rule_id)}",
                file=sys.stderr,
            )
            flow.response = http.Response.make(403, REQUEST_POLICY_BLOCK_BODY)
            return

        # Inspection runs first, and only for a request a rule owns: a
        # fallback or an indeterminate match has no acceptance conditions.
        # Order is load-bearing here — mask the URL and headers before
        # anything can log them, inspect, apply the rewrite, report the
        # outcome, and block before any credential is injected, so a blocked
        # request never carries one.
        rule = local["rule"]
        if rule is not None:
            _mask_url_and_headers(flow, patterns)
            result, rewritten, reason, findings = _inspect_body(
                rule, request_body, parsed_body, patterns
            )
            if result == "review":
                # The rule asked for a person on these violations. The answer
                # decides the outcome, so it has to arrive before the body
                # does — and before any credential is injected below.
                if _settle_violation_review(
                    broker_socket, request_id, session_id, rule_id,
                    host, port, method, review_context, findings,
                ):
                    result = "rewrite" if rewritten is not None else "pass"
                    reason = "violations-approved"
                else:
                    result, rewritten, reason = (
                        "block", None, "violations-denied",
                    )
            if result == "rewrite" and rewritten is not None:
                flow.request.content = rewritten

            _report_request_policy_outcome(
                broker_socket,
                request_id,
                session_id,
                rule_id,
                result,
                reason,
                findings,
            )

            if result == "block":
                block_key = (session_id, rule_id, result, reason)
                count = self._request_policy_block_counts.get(block_key, 0) + 1
                self._request_policy_block_counts[block_key] = count
                if _should_emit_block_log(count):
                    print(
                        f"[nas-addon] REQUEST-POLICY-BLOCKED: "
                        f"session={_safe_session_label(session_id)} "
                        f"rule={_safe_rule_label(rule_id)} "
                        f"result={result} reason={reason} count={count}",
                        file=sys.stderr,
                    )
                flow.response = http.Response.make(
                    403, REQUEST_POLICY_BLOCK_BODY
                )
                return

        # Everything below this line is forwarded, so everything below this
        # line is masked. Masking is not a service inspection performs: a rule
        # that declares no `json` body condition never reads the tree, a rule
        # that reads it leaves numbers alone, and a fallback owns no rule at
        # all — yet all three put the body on the wire. Placing the one masking
        # call on the single path out makes "every forwarded body is masked" a
        # property of the control flow instead of a coincidence of which
        # branch ran. A structural rewrite above has already masked the tree;
        # this pass is idempotent over it and covers what it could not reach.
        _apply_request_masking(flow, patterns)
        if getattr(flow, "mask_blocked", False):
            flow.response = http.Response.make(
                403,
                b"blocked: cannot decode request body for secret masking",
            )
            return

        # Inject headers from the broker decision (overwrites existing).
        # These lines carry the request path, so they stay off for
        # rule-governed requests: those log only the closed outcome fields.
        inject_headers = decision.get("injectHeaders", [])
        for h in inject_headers:
            flow.request.headers[h["name"]] = h["value"]
            if rule is None:
                print(f"[nas-addon] INJECT: {h['name']} -> {host}:{port}{flow.request.path} "
                      f"(cred_source={cred_source})", file=sys.stderr)
        if not inject_headers and rule is None:
            print(f"[nas-addon] NO INJECT: no credentials matched for "
                  f"{host}:{port}{flow.request.path}", file=sys.stderr)

        if "proxy-authorization" in flow.request.headers:
            del flow.request.headers["proxy-authorization"]

    def client_disconnected(self, client: connection.Client) -> None:
        self._connect_creds.pop(client.id, None)
        disconnected_sessions = self._client_sessions.pop(client.id, set())
        active_sessions = {
            session_id
            for sessions in self._client_sessions.values()
            for session_id in sessions
        }
        inactive_sessions = disconnected_sessions - active_sessions
        if not inactive_sessions:
            return
        self._request_policy_block_counts = {
            key: count
            for key, count in self._request_policy_block_counts.items()
            if key[0] not in inactive_sessions
        }


addons = [NasAddon()]
