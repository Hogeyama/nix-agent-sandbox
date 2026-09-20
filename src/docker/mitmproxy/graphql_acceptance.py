"""Run requests through the addon's selection and inspection, end to end.

`graphql_acceptance_test.ts` resolves a config with the host resolver, hands
the document (as the host would write it) and a list of requests to this
script, and checks what comes back. Each request goes the way the addon's
request hook takes it: classify the body under the scope budget, build the
truth table under each candidate's own limits with one per-request GraphQL
memo, select, and — when a rule owns the request — inspect the body against
that rule's acceptance conditions with the same memo.

Prints one JSON object on stdout: {"valid": bool, "results": [...]}.
"""

import base64
import json
import sys

import nas_addon


def run_case(document: dict, case: dict) -> dict:
    host = case["host"]
    port = case["port"]
    method = case["method"]
    path = case["path"]
    body = base64.b64decode(case["bodyBase64"], validate=True)
    scope = nas_addon._select_scope(document, host, port)
    limits = (
        scope.get("limits", nas_addon._LIMIT_CEILINGS)
        if scope is not None
        else document["defaults"]["limits"]
    )
    body_kind, parsed, body_diagnostic = (
        nas_addon._classify_body_with_diagnostic(body, limits["maxBodyBytes"], True)
    )
    memo: dict = {}
    truths, diagnostics = nas_addon._body_truth_and_diagnostics(
        document, host, port, method, path, body_kind, len(body), parsed,
        body_diagnostic, memo,
    )
    decision = nas_addon._decide(
        document, host, port, method, path, truths, "http"
    )
    result = {
        "name": case["name"],
        "action": decision["action"],
        "reason": decision["reason"],
        "ruleId": decision["ruleId"],
        "diagnostic": diagnostics.get(decision["ruleId"]),
        "inspection": None,
        "findings": [],
    }
    rule = decision["rule"]
    if rule is not None:
        patterns = nas_addon._build_mask_patterns(case.get("maskValues", []))
        inspection, _rewritten, reason, findings = nas_addon._inspect_body(
            rule, body, parsed, patterns, memo,
            nas_addon._has_query_string(path),
        )
        result["inspection"] = [inspection, reason]
        result["findings"] = findings
    return result


def main() -> int:
    document = json.loads(sys.argv[1])
    cases = json.loads(sys.argv[2])
    if not nas_addon._is_valid_authz_document(document):
        print(json.dumps({"valid": False, "results": []}))
        return 0
    results = [run_case(document, case) for case in cases]
    print(json.dumps({"valid": True, "results": results}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
