"""Replay a selection matrix through the addon and print one line per case.

`decide_parity_test.ts` resolves a config, hands the resolved document and
its own answers to this script, and compares. The two implementations of
selection have to agree case for case: the addon reproduces the host's choice
and refuses the request when the two disagree, so a divergence here is a
divergence that would show up as a dead session rather than as a wrong
answer — and a divergence the other way, where both sides are wrong in the
same way, is what the matrix is meant to catch.
"""

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
    for host, port, method, path, body_kind in cases:
        decision = nas_addon._decide(
            document, host, port, method, path, body_kind
        )
        lines.append("|".join([
            host,
            str(port),
            method,
            path,
            body_kind,
            decision["action"],
            decision["reason"],
            decision["ruleId"],
        ]))
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
