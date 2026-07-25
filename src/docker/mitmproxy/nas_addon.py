"""
nas_addon.py — mitmproxy addon for nas network authorization.

Intercepts HTTP/HTTPS requests, extracts session credentials from
Proxy-Authorization, queries the per-session broker UDS for authorization
decisions, and evaluates review rules for request body inspection.
"""

import base64
import hashlib
import json
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
REVIEW_RULES_DIR = os.path.join(NETWORK_DIR, "review-rules")

BODY_PREVIEW_MAX = 1024
REQUEST_POLICY_BLOCK_BODY = b"blocked: request policy"

_SAFE_RULE_ID = re.compile(r"[a-z][a-z0-9._-]{0,63}\Z")
_SAFE_SESSION_LABEL = re.compile(r"[A-Za-z0-9._-]{1,64}\Z")
_PARTIAL_SELECTOR_WILDCARD = re.compile(
    r"[a-z0-9_.~-]*\*+[a-z0-9_.~-]*\Z",
    re.IGNORECASE | re.ASCII,
)
_DOCUMENT_KEYS = frozenset(("contractVersion", "rules"))
_RULE_KEYS = frozenset((
    "id",
    "method",
    "host",
    "path",
    "pathPrefix",
    "action",
    "audit",
    "requestPolicy",
))
_BODYLESS_POLICY_KEYS = frozenset(("kind",))
_JSON_POLICY_KEYS = frozenset((
    "kind",
    "maxBodyBytes",
    "maxDepth",
    "maxNodes",
    "maxDecodedBytes",
    "taggedUnions",
    "encodedFields",
))
_TAGGED_UNION_KEYS = frozenset((
    "at",
    "discriminator",
    "allowedTags",
))
_ENCODED_FIELD_KEYS = frozenset((
    "at",
    "whenField",
    "whenEquals",
    "dataField",
    "encoding",
))
_JSON_LIMITS = {
    "maxBodyBytes": 33_554_432,
    "maxDepth": 64,
    "maxNodes": 200_000,
    "maxDecodedBytes": 33_554_432,
}

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


_registry_cache: dict[str, tuple[float, dict]] = {}
_INVALID_REVIEW_RULES = object()
_review_rules_cache: dict[str, tuple[Optional[int], object]] = {}
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


def _is_non_empty_string(value: object) -> bool:
    return isinstance(value, str) and len(value) > 0


def _is_exact_non_port_host(value: object) -> bool:
    if not isinstance(value, str) or value != value.strip():
        return False
    host = value[:-1] if value.endswith(".") else value
    if len(host) == 0 or len(host) > 253:
        return False
    labels = host.split(".")
    return all(
        len(label) <= 63
        and re.fullmatch(
            r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?",
            label,
            re.IGNORECASE | re.ASCII,
        ) is not None
        for label in labels
    )


def _is_valid_selector(value: object) -> bool:
    if not isinstance(value, str) or not value.startswith("/"):
        return False
    for segment in value[1:].split("/"):
        if re.search(r"~(?:[^01]|\Z)", segment):
            return False
        if (
            segment not in ("*", "**")
            and _PARTIAL_SELECTOR_WILDCARD.fullmatch(segment)
        ):
            return False
    return True


def _is_valid_tagged_union(value: object) -> bool:
    if not _has_exact_keys(value, _TAGGED_UNION_KEYS):
        return False
    allowed_tags = value["allowedTags"]
    return (
        _is_valid_selector(value["at"])
        and _is_non_empty_string(value["discriminator"])
        and isinstance(allowed_tags, list)
        and len(allowed_tags) > 0
        and all(_is_non_empty_string(tag) for tag in allowed_tags)
    )


def _is_valid_encoded_field(value: object) -> bool:
    if not _has_exact_keys(value, _ENCODED_FIELD_KEYS):
        return False
    return (
        _is_valid_selector(value["at"])
        and _is_non_empty_string(value["whenField"])
        and _is_non_empty_string(value["whenEquals"])
        and _is_non_empty_string(value["dataField"])
        and value["encoding"] == "base64"
    )


def _is_valid_request_policy(value: object, method: str) -> bool:
    if not isinstance(value, dict):
        return False
    kind = value.get("kind")
    if kind == "bodyless":
        return (
            _has_exact_keys(value, _BODYLESS_POLICY_KEYS)
            and method.upper() == "GET"
        )
    if kind != "json" or not _has_exact_keys(value, _JSON_POLICY_KEYS):
        return False
    if method.upper() != "POST":
        return False
    for field, maximum in _JSON_LIMITS.items():
        limit = value[field]
        if (
            type(limit) is not int
            or limit <= 0
            or limit > maximum
        ):
            return False
    tagged_unions = value["taggedUnions"]
    encoded_fields = value["encodedFields"]
    return (
        isinstance(tagged_unions, list)
        and all(_is_valid_tagged_union(item) for item in tagged_unions)
        and isinstance(encoded_fields, list)
        and all(_is_valid_encoded_field(item) for item in encoded_fields)
    )


def _is_valid_resolved_rule(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    keys = value.keys()
    if not {"action", "audit"}.issubset(keys):
        return False
    if not set(keys).issubset(_RULE_KEYS):
        return False
    if value["action"] not in ("allow", "review", "deny"):
        return False
    if type(value["audit"]) is not bool:
        return False

    if "id" in value:
        rule_id = value["id"]
        if (
            not isinstance(rule_id, str)
            or _SAFE_RULE_ID.fullmatch(rule_id) is None
        ):
            return False
    for field in ("method", "host", "path", "pathPrefix"):
        if field in value and not _is_non_empty_string(value[field]):
            return False
    if "path" in value and "pathPrefix" in value:
        return False
    if "path" in value and "?" in value["path"]:
        return False

    policy = value.get("requestPolicy")
    if policy is None:
        return "requestPolicy" not in value
    if value["action"] == "deny":
        return False
    if not all(field in value for field in ("id", "method", "host", "path")):
        return False
    if not _is_exact_non_port_host(value["host"]):
        return False
    return _is_valid_request_policy(policy, value["method"])


def _is_valid_resolved_review_rules(value: object) -> bool:
    try:
        if not _has_exact_keys(value, _DOCUMENT_KEYS):
            return False
        if type(value["contractVersion"]) is not int:
            return False
        if value["contractVersion"] != 1:
            return False
        rules = value["rules"]
        return (
            isinstance(rules, list)
            and all(_is_valid_resolved_rule(rule) for rule in rules)
        )
    except Exception:
        return False


def _load_review_rules(session_id: str) -> object:
    path = os.path.join(REVIEW_RULES_DIR, f"{session_id}.json")
    try:
        mtime = os.stat(path).st_mtime_ns
    except OSError:
        mtime = None

    cached = _review_rules_cache.get(session_id)
    if cached and cached[0] == mtime:
        return cached[1]

    state: object = _INVALID_REVIEW_RULES
    if mtime is not None:
        try:
            with open(path) as f:
                document = json.load(f)
            if _is_valid_resolved_review_rules(document):
                state = document
        except Exception:
            pass
    _review_rules_cache[session_id] = (mtime, state)
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


def _report_request_policy_outcome(
    socket_path: str,
    request_id: str,
    session_id: str,
    rule_id: str,
    result: str,
    reason: str,
) -> None:
    """Report a sanitized request-policy outcome to the broker.

    Only the closed protocol fields are sent: no host, method, path, query,
    header, body, filename, credential, or mask value. An acknowledgement
    failure prints one constant line and never changes the computed result."""
    try:
        response = _query_broker(socket_path, {
            "version": 1,
            "type": "request_policy_outcome",
            "requestId": request_id,
            "sessionId": session_id,
            "ruleId": rule_id,
            "result": result,
            "reason": reason,
        })
        if not (
            response.get("version") == 1
            and response.get("type") == "request_policy_outcome_recorded"
            and response.get("requestId") == request_id
        ):
            print(REQUEST_POLICY_AUDIT_UNAVAILABLE, file=sys.stderr)
    except Exception:
        print(REQUEST_POLICY_AUDIT_UNAVAILABLE, file=sys.stderr)


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


def _recursively_mask_json(
    node, patterns: list[bytes], consumed: dict
) -> tuple[object, bool]:
    """Mask every string value and object key recursively, skipping encoded
    data already consumed by an encoded-field rule. Raises _PolicyBlock
    (key-collision) before inserting a duplicate masked key."""
    if isinstance(node, dict):
        changed = False
        new_node: dict = {}
        consumed_keys = consumed.get(id(node), frozenset())
        for key, value in node.items():
            masked_key = key
            if isinstance(key, str):
                masked_key, key_changed = _mask_json_string(key, patterns)
                changed = changed or key_changed
            if key in consumed_keys:
                new_value, value_changed = value, False
            else:
                new_value, value_changed = _recursively_mask_json(
                    value, patterns, consumed
                )
            changed = changed or value_changed
            if masked_key in new_node:
                raise _PolicyBlock("key-collision")
            new_node[masked_key] = new_value
        return new_node, changed
    if isinstance(node, list):
        changed = False
        new_list = []
        for item in node:
            new_item, item_changed = _recursively_mask_json(
                item, patterns, consumed
            )
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
    return int(literal)


def _collect_selector_matches(node, segments, matches: list, seen: set) -> int:
    """Collect every node reached by the selector. A node is recorded at most
    once per selector even when several `**` routes reach it.

    Returns how many (node, segment-index) states were expanded. Expanding a
    state is a pure function of that state, so each one is memoized and
    expanded at most once. Without this a selector with several `**` segments
    re-expands the same subtree once per route and grows superlinearly in the
    number of `**`; the depth and node budgets alone do not bound it."""
    expansions = [0]
    visited: set = set()

    def expand(current, index: int) -> None:
        state = (id(current), index)
        if state in visited:
            return
        visited.add(state)
        expansions[0] += 1
        if index == len(segments):
            if id(current) not in seen:
                seen.add(id(current))
                matches.append(current)
            return
        kind, literal = segments[index]
        if kind == "**":
            # Zero descendants: the remainder may match at this very node.
            expand(current, index + 1)
            # One or more descendants: keep `**` active while descending.
            for child in _json_children(current):
                expand(child, index)
            return
        if kind == "*":
            for child in _json_children(current):
                expand(child, index + 1)
            return
        if isinstance(current, dict):
            if literal in current:
                expand(current[literal], index + 1)
            return
        if isinstance(current, list):
            array_index = _json_pointer_index(literal)
            if array_index is not None and array_index < len(current):
                expand(current[array_index], index + 1)

    expand(node, 0)
    return expansions[0]


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


def _validate_tagged_unions(root, guards: list) -> None:
    """Validate every node matched by each guard. A matched node must be an
    object whose discriminator is its own string property listed in
    allowedTags. Any other shape blocks as schema-mismatch."""
    for guard in guards:
        segments = _parse_selector(guard["at"])
        matches: list = []
        _collect_selector_matches(root, segments, matches, set())
        discriminator = guard["discriminator"]
        allowed = frozenset(guard["allowedTags"])
        for node in matches:
            if not isinstance(node, dict):
                raise _PolicyBlock("schema-mismatch")
            tag = node.get(discriminator)
            if not isinstance(tag, str) or tag not in allowed:
                raise _PolicyBlock("schema-mismatch")


def _decode_strict_base64(value: str) -> bytes:
    """Decode strict standard base64 only.

    `validate=True` rejects any character outside the standard alphabet, so
    whitespace, line-wrapped MIME input, and the URL-safe alphabet all fail.
    The canonical round-trip check additionally rejects wrong padding and
    non-canonical trailing bits, and guarantees re-encoding is stable."""
    try:
        raw = value.encode("ascii")
        decoded = base64.b64decode(raw, validate=True)
        if base64.b64encode(decoded) != raw:
            raise ValueError("non-canonical base64")
        return decoded
    except Exception:
        raise _PolicyBlock("encoded-decode-failed")


def _process_encoded_fields(
    root, encoded_fields: list, patterns: list[bytes], max_decoded: int
) -> tuple[bool, dict]:
    """Decode, mask, and canonically re-encode every matching encoded field,
    mutating `root` in place. Returns (changed, consumed) where `consumed`
    maps a container's id() to the data fields that must not be masked a
    second time as ordinary strings."""
    changed = False
    consumed: dict = {}
    remaining = max_decoded
    for field in encoded_fields:
        if field["encoding"] != "base64":
            raise _PolicyBlock("encoded-decode-failed")
        segments = _parse_selector(field["at"])
        matches: list = []
        _collect_selector_matches(root, segments, matches, set())
        when_field = field["whenField"]
        when_equals = field["whenEquals"]
        data_field = field["dataField"]
        for node in matches:
            # "/**" also selects scalars and lists; only objects whose
            # discriminator matches carry an encoded payload.
            if not isinstance(node, dict):
                continue
            if node.get(when_field) != when_equals:
                continue
            data = node.get(data_field)
            if not isinstance(data, str):
                raise _PolicyBlock("schema-mismatch")
            decoded = _decode_strict_base64(data)
            remaining -= len(decoded)
            if remaining < 0:
                raise _PolicyBlock("resource-limit")
            masked_blob = _mask_bytes(decoded, patterns)
            if masked_blob != decoded:
                node[data_field] = base64.b64encode(
                    masked_blob
                ).decode("ascii")
                changed = True
            consumed.setdefault(id(node), set()).add(data_field)
    return changed, consumed


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


def _execute_json_policy(
    policy: dict, body: Optional[bytes], patterns: list[bytes]
) -> tuple[str, Optional[bytes], str]:
    if body is None:
        return "block", None, "body-unavailable"
    if len(body) > policy["maxBodyBytes"]:
        return "block", None, "resource-limit"
    try:
        parsed = json.loads(
            body,
            object_pairs_hook=_reject_duplicate_members,
            parse_constant=_reject_non_standard_constant,
        )
    except _PolicyBlock as exc:
        return "block", None, exc.reason
    except Exception:
        return "block", None, "invalid-json"
    if not isinstance(parsed, dict):
        return "block", None, "schema-mismatch"
    try:
        # Accounting runs first on purpose: it proves the tree is within the
        # depth and node budgets, which is what bounds the recursive `**`
        # selector traversal and the masking walk that follow.
        _account_json(parsed, policy["maxDepth"], policy["maxNodes"])
        _validate_tagged_unions(parsed, policy["taggedUnions"])
        encoded_changed, consumed = _process_encoded_fields(
            parsed,
            policy["encodedFields"],
            patterns,
            policy["maxDecodedBytes"],
        )
        masked, mask_changed = _recursively_mask_json(
            parsed, patterns, consumed
        )
        changed = encoded_changed or mask_changed
    except _PolicyBlock as exc:
        return "block", None, exc.reason
    except Exception:
        return "block", None, "processing-failed"
    if not changed:
        return "pass", None, "recognized-json"
    try:
        serialized = json.dumps(
            masked, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
    except Exception:
        return "block", None, "serialization-failed"
    return "rewrite", serialized, "masked-json"


def _execute_request_policy(
    policy: dict, body: Optional[bytes], patterns: list[bytes]
) -> tuple[str, Optional[bytes], str]:
    """Execute a validated request policy against the request body.

    Returns (result, rewritten_body_or_none, closed_reason) where result is
    one of "pass", "rewrite", or "block". Any unclassified exception blocks
    with "processing-failed"."""
    try:
        kind = policy.get("kind")
        if kind == "bodyless":
            if body is None:
                return "block", None, "body-unavailable"
            if len(body) != 0:
                return "block", None, "unexpected-body"
            return "pass", None, "empty-body"
        if kind == "json":
            return _execute_json_policy(policy, body, patterns)
        return "block", None, "processing-failed"
    except Exception:
        return "block", None, "processing-failed"


def _find_rule_by_id(rules: list, rule_id: str) -> Optional[dict]:
    """Resolve the broker's authoritative rule ID in the local document.

    Returns None when the ID names no rule, which means the broker and the
    addon disagree about the resolved document. The caller fails closed
    rather than falling back to a locally chosen rule: the broker approved
    one specific policy, and executing a different one would run a policy
    the operator never authorized for this request."""
    for rule in rules:
        if rule.get("id") == rule_id:
            return rule
    return None


def _match_host_pattern(host: str, pattern: str) -> bool:
    normalized = _normalize_host(host)
    normalized_pattern = _normalize_host(pattern)
    if normalized_pattern.startswith("*."):
        suffix = normalized_pattern[2:]
        return normalized == suffix or normalized.endswith(f".{suffix}")
    return normalized == normalized_pattern


def _matches_path_prefix(path: str, prefix: str) -> bool:
    if not path.startswith(prefix):
        return False
    if len(path) == len(prefix):
        return True
    if prefix.endswith("/"):
        return True
    nxt = path[len(prefix)]
    return nxt == "/" or nxt == "?"


def _match_review_rule(rule: dict, method: str, host: str, path: str) -> bool:
    if "method" in rule and rule["method"]:
        if rule["method"].upper() != method.upper():
            return False
    if "host" in rule and rule["host"]:
        if not _match_host_pattern(host, rule["host"]):
            return False
    if "path" in rule and rule["path"]:
        query_index = path.find("?")
        query_free_path = (
            path if query_index == -1 else path[:query_index]
        )
        if query_free_path != rule["path"]:
            return False
    if "pathPrefix" in rule and rule["pathPrefix"]:
        if not _matches_path_prefix(path, rule["pathPrefix"]):
            return False
    return True


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
        self._request_policy_block_counts: dict[tuple[str, ...], int] = {}
        self._client_sessions: dict[str, set[str]] = {}

    def _patterns_for(self, mask_values: list[str]) -> list[bytes]:
        if mask_values == self._mask_values_cache:
            return self._mask_patterns_cache
        patterns = _build_mask_patterns(mask_values)
        self._mask_values_cache = mask_values
        self._mask_patterns_cache = patterns
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

        review_document = _load_review_rules(session_id)
        if (
            review_document is _INVALID_REVIEW_RULES
            or not isinstance(review_document, dict)
        ):
            print(
                "[nas-addon] REQUEST-POLICY-CONTRACT-INVALID: "
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

        review_rules = review_document["rules"]
        # The local match only decides whether to attach a bounded body
        # preview to the authorization request. It must not decide the
        # verdict or which policy runs — the broker owns both, and letting
        # a local pre-match win would execute a policy the broker never
        # approved whenever the two documents disagree.
        preview_rule = None
        for rule in review_rules:
            if _match_review_rule(rule, method, host, request_path):
                preview_rule = rule
                break

        request_id = _generate_request_id()
        broker_socket = os.path.join(BROKERS_DIR, session_id, "sock")

        authorize_req = {
            "version": 1,
            "type": "authorize",
            "requestId": request_id,
            "sessionId": session_id,
            "target": {"host": host, "port": port},
            "method": method,
            "requestKind": "forward",
            "observedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        }

        # Always include path for credential matching (pathPrefix credentials
        # need the path even when no review rule matched).
        authorize_req["reviewContext"] = {
            "path": request_path,
            "contentType": None,
            "bodyPreview": None,
            "bodySize": 0,
        }

        request_body = None
        request_body_loaded = False
        if preview_rule:
            try:
                request_body = flow.request.content
            except ValueError:
                request_body = None
            request_body_loaded = True
            body_bytes = request_body or b""
            body_preview = None
            if body_bytes:
                try:
                    body_preview = body_bytes[:BODY_PREVIEW_MAX].decode("utf-8", errors="replace")
                except Exception:
                    body_preview = f"<binary {len(body_bytes)} bytes>"
            authorize_req["reviewContext"] = {
                "path": request_path,
                "contentType": flow.request.headers.get("content-type"),
                "bodyPreview": body_preview,
                "bodySize": len(body_bytes),
            }

        decision = _query_broker(broker_socket, authorize_req)

        if decision.get("decision") != "allow":
            message = decision.get("message", decision.get("reason", "denied"))
            flow.response = http.Response.make(
                403, message.encode() if isinstance(message, str) else b"denied"
            )
            return

        # Mask secrets out of the outgoing request (URL / headers / body)
        # before credential injection so injected headers stay intact.
        mask_values = decision.get("maskValues") or []
        patterns = self._patterns_for(mask_values) if mask_values else []

        # The broker names the rule it approved. Resolve it here rather than
        # reusing the local pre-match so a disagreement fails closed instead
        # of silently running a different policy.
        rule_id = decision.get("ruleId")
        policy = None
        if rule_id is not None:
            approved_rule = _find_rule_by_id(review_rules, rule_id)
            if approved_rule is None:
                print(
                    "[nas-addon] REQUEST-POLICY-RULE-UNKNOWN: "
                    f"session={_safe_session_label(session_id)} "
                    f"rule={_safe_rule_label(rule_id)}",
                    file=sys.stderr,
                )
                flow.response = http.Response.make(
                    403, REQUEST_POLICY_BLOCK_BODY
                )
                return
            policy = approved_rule.get("requestPolicy")

        if policy is None:
            # Ordinary rule (with or without an ID): byte-pattern masking
            # only, exactly as before request policies existed.
            if mask_values:
                _apply_request_masking(flow, patterns)
                if getattr(flow, "mask_blocked", False):
                    flow.response = http.Response.make(
                        403,
                        b"blocked: cannot decode request body for secret masking",
                    )
                    return
        else:
            # Order is load-bearing: mask the URL and headers before anything
            # can log them, execute the policy on the body, apply the rewrite,
            # report the outcome, and only then block or inject credentials —
            # so a blocked request never carries an injected credential.
            _mask_url_and_headers(flow, patterns)
            if request_body_loaded:
                body = request_body
            else:
                try:
                    body = flow.request.content
                except ValueError:
                    body = None

            result, rewritten, reason = _execute_request_policy(
                policy, body, patterns
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
            )

            if result == "block":
                kind = policy.get("kind")
                block_key = (session_id, rule_id, kind, result, reason)
                count = self._request_policy_block_counts.get(block_key, 0) + 1
                self._request_policy_block_counts[block_key] = count
                if _should_emit_block_log(count):
                    print(
                        f"[nas-addon] REQUEST-POLICY-BLOCKED: "
                        f"session={_safe_session_label(session_id)} "
                        f"rule={_safe_rule_label(rule_id)} kind={kind} "
                        f"result={result} reason={reason} count={count}",
                        file=sys.stderr,
                    )
                flow.response = http.Response.make(
                    403, REQUEST_POLICY_BLOCK_BODY
                )
                return

        # Inject credential headers from broker decision (overwrites existing).
        # These lines carry the request path, so they stay off for
        # policy-governed rules: those log only the closed outcome fields.
        inject_headers = decision.get("injectHeaders", [])
        for h in inject_headers:
            flow.request.headers[h["name"]] = h["value"]
            if policy is None:
                print(f"[nas-addon] INJECT: {h['name']} -> {host}:{port}{flow.request.path} "
                      f"(cred_source={cred_source})", file=sys.stderr)
        if (
            not inject_headers
            and decision.get("decision") == "allow"
            and policy is None
        ):
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
