"""Inspect a body with the shipped policy and print the messages that follow.

`message_parity_test.ts` hands over a request body, gets back the exact
review query and outcome report the addon would send, and runs the broker's
validators over them. The broker refuses a message it does not recognize
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
    / "network" / "fixtures" / "authz" / "anthropic-v1.json"
)


def main() -> int:
    body = sys.argv[1].encode("utf-8")
    mask_values = json.loads(sys.argv[2])
    document = json.loads(_FIXTURE.read_text())
    if not nas_addon._is_valid_authz_document(document):
        print("INVALID-DOCUMENT", file=sys.stderr)
        return 1
    rule = next(
        rule
        for scope in document["scopes"]
        for rule in scope["rules"]
        if rule["id"] == "anthropic.messages"
    )
    patterns = nas_addon._build_mask_patterns(mask_values)
    result, _rewritten, reason, findings = nas_addon._inspect_body(
        rule, body, json.loads(body), patterns
    )
    review_context = {
        "path": "/v1/messages",
        "contentType": "application/json",
        "bodySize": len(body),
    }
    body_truth = nas_addon._body_truth_table(
        document, "api.anthropic.com", 443, "POST", "/v1/messages",
        "json", len(body),
    )
    # The outcome is reported with whatever the review settled on; an approval
    # is the case that carries findings and a success reason at once.
    print(json.dumps({
        "result": result,
        "reason": reason,
        "authorize": nas_addon._authorize_message(
            "req-parity", "sess_parity", "api.anthropic.com", 443,
            "POST", body_truth, review_context,
        ),
        "review": nas_addon._violation_review_message(
            "req-parity", "sess_parity", rule["id"],
            "api.anthropic.com", 443, "POST", review_context, findings,
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
