"""Replay a selection matrix through the addon and print one line per case.

`decide_parity_test.ts` resolves a config, hands the resolved document and
its own answers to this script, and compares. The two implementations of
selection have to agree case for case: the addon reproduces the host's choice
and refuses the request when the two disagree, so a divergence here is a
divergence that would show up as a dead session rather than as a wrong
answer — and a divergence the other way, where both sides are wrong in the
same way, is what the matrix is meant to catch.
"""

import base64
import json
import sys

import nas_addon


def main() -> int:
    document = json.loads(sys.argv[1])
    cases = json.loads(sys.argv[2])
    if not nas_addon._is_valid_authz_document(document):
        print("INVALID-DOCUMENT")
        return 1
    lines = []
    for case in cases:
        name = case["name"]
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
        body_kind, parsed_body = nas_addon._classify_body(
            body, limits["maxBodyBytes"], case["carriesBody"]
        )
        body_size = len(body)
        body_truth = nas_addon._body_truth_table(
            document, host, port, method, path, body_kind,
            body_size, parsed_body,
        )
        decision = nas_addon._decide(
            document, host, port, method, path, body_truth
        )
        line = [
            host,
            str(port),
            method,
            path,
            body_kind,
            decision["action"],
            decision["reason"],
            decision["ruleId"],
        ]
        line.insert(0, name)
        lines.append("|".join(line))
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
