"""Inspect a body with the shipped policy and print the messages that follow.

`message_parity_test.ts` hands over a request body, gets back the exact
review query and outcome report the addon would send, and runs the broker's
validators over them. By default the body is inspected under the shipped
policy's `anthropic.messages` rule; an optional third argument names another
resolved document, rule and route (`{document, ruleId, host, path}`) so that
findings from other kinds of acceptance condition travel the same way. The broker refuses a message it does not recognize
field for field, and the addon treats a refusal as a request it may not
forward, so a drift between the two shapes is a dead session — one that no
test on either side alone would notice.
"""

import json
import pathlib
import sys

import nas_addon

_FIXTURE = (
    pathlib.Path(__file__).resolve().parents[2]
    / "network" / "fixtures" / "authz" / "resolved-document.json"
)


def main() -> int:
    body = sys.argv[1].encode("utf-8")
    mask_values = json.loads(sys.argv[2])
    if len(sys.argv) > 3:
        target = json.loads(sys.argv[3])
    else:
        target = {
            "document": json.loads(_FIXTURE.read_text()),
            "ruleId": "anthropic.messages",
            "host": "api.anthropic.com",
            "path": "/v1/messages",
        }
    document = target["document"]
    host = target["host"]
    path = target["path"]
    if not nas_addon._is_valid_authz_document(document):
        print("INVALID-DOCUMENT", file=sys.stderr)
        return 1
    rule = next(
        rule
        for scope in document["scopes"]
        for rule in scope["rules"]
        if rule["id"] == target["ruleId"]
    )
    patterns = nas_addon._build_mask_patterns(mask_values)
    # One memo per request, shared by selection and inspection, as the
    # request hook does.
    graphql_memo: dict = {}
    parsed = json.loads(body)
    result, _rewritten, reason, findings = nas_addon._inspect_body(
        rule, body, parsed, patterns, graphql_memo,
        nas_addon._has_query_string(path),
    )
    review_context = {
        "path": path,
        "contentType": "application/json",
        "bodySize": len(body),
    }
    body_truth = nas_addon._body_truth_table(
        document, host, 443, "POST", path, "json", len(body), parsed,
        graphql_memo,
    )
    # The outcome is reported with whatever the review settled on; an approval
    # is the case that carries findings and a success reason at once.
    print(json.dumps({
        "result": result,
        "reason": reason,
        "authorize": nas_addon._authorize_message(
            "req-parity", "sess_parity", host, 443,
            "POST", "http", body_truth, review_context,
            {"state": "disabled"},
        ),
        "review": nas_addon._violation_review_message(
            "req-parity", "sess_parity", rule["id"],
            host, 443, "POST", review_context, findings,
        ),
        "outcome": nas_addon._request_policy_outcome_message(
            "req-parity", "sess_parity", rule["id"],
            "rewrite" if result == "review" else result,
            "violations-approved" if result == "review" else reason,
            findings,
        ),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
