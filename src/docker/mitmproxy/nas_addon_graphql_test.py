"""Unit tests for the vendored graphql-core dependency of nas_addon.py.

Run via nas_addon_test.ts, which sets PYTHONPATH to the mitmproxy stub.
Direct invocation:
    PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_graphql_test.py
"""

import json
import os
import unittest
import uuid

import nas_addon  # noqa: F401 -- inserts ./vendor into sys.path on import

import graphql


class VendoredGraphqlTest(unittest.TestCase):
    def test_graphql_resolves_from_the_vendored_tree(self):
        # The addon must parse with the vendored graphql-core, not with
        # whatever a site-packages install of the proxy image happens to
        # carry. Both the runtime dir layout and this repository keep the
        # library next to nas_addon.py under ./vendor.
        self.assertEqual(
            os.path.dirname(graphql.__file__),
            os.path.join(
                os.path.dirname(os.path.abspath(nas_addon.__file__)),
                "vendor",
                "graphql",
            ),
        )
        self.assertEqual(graphql.version, "3.2.11")

    def test_parse_returns_a_document(self):
        document = graphql.parse("query { repository { name } }")
        self.assertEqual(document.kind, "document")

    def test_max_tokens_overflow_raises_graphql_error(self):
        # parse(source, max_tokens=N) is the per-rule parse budget for the
        # graphql body condition. Overrunning it must surface as GraphQLError
        # so the addon can classify the document as unparseable rather than
        # crash on an unhandled exception type.
        with self.assertRaises(graphql.GraphQLError):
            graphql.parse(
                "query { a b c d e f g h i j k l m n o p }", max_tokens=5
            )


# The expectations below are fixed from the spec, not from either
# implementation, and src/network/authz/graphql_test.ts holds the same table
# for the TypeScript reference. A parity test alone would pass if both sides
# were wrong in the same way.

LIMITS = {"maxNodes": 10_000, "maxDepth": 16}


def facts(text, limits=LIMITS, variables=nas_addon._NO_GRAPHQL_VARIABLES):
    return nas_addon._parse_graphql_facts(text, limits, variables)


def documents(value, ats, limits=LIMITS):
    """The positions of `ats` that yield facts, like buildGraphqlDocuments."""
    built = {}
    for at in ats:
        _target, found = nas_addon._graphql_facts_at(value, at, limits, None)
        if found is not None:
            built[at] = found
    return built


class ParseGraphqlFactsTest(unittest.TestCase):
    def test_anonymous_shorthand_is_a_query(self):
        result = facts("{ a }")
        self.assertEqual(result["operations"], ["query"])
        self.assertEqual(result["rootFields"], ["a"])

    def test_mutation_and_subscription_kinds(self):
        result = facts("mutation M { a } subscription S { b }")
        self.assertEqual(result["operations"], ["mutation", "subscription"])

    def test_root_fragments_expand_into_root_fields(self):
        result = facts(
            "query { viewer ...f ... on Query { rateLimit } } "
            "fragment f on Query { repository { name } }"
        )
        self.assertEqual(
            result["rootFields"], ["viewer", "repository", "rateLimit"]
        )

    def test_resolves_string_literals_and_variables(self):
        result = facts(
            "query ($o: String!) { repository(owner: $o, first: 10) "
            "{ name } }",
            variables={"o": "my-org"},
        )
        self.assertEqual(result["argumentValues"], {"owner": ["my-org"]})
        self.assertEqual(result["unresolvedArguments"], ["first"])

    def test_missing_or_non_string_variables_are_unresolved(self):
        result = facts("{ a(o: $o, n: $n, m: $m) }", variables={"n": 42})
        self.assertEqual(result["argumentValues"], {})
        self.assertEqual(result["unresolvedArguments"], ["o", "n", "m"])

    def test_collects_directive_and_fragment_arguments(self):
        result = facts(
            'query { a @include(if: $show) ...f } '
            'fragment f on Q { b(owner: "me") }',
            variables={"show": True},
        )
        self.assertEqual(result["argumentValues"], {"owner": ["me"]})
        self.assertEqual(result["unresolvedArguments"], ["if"])

    WITH_DEFAULT = (
        'query ($o: String = "my-org") { repository(owner: $o) { name } }'
    )

    def test_absent_variable_resolves_to_the_operation_default(self):
        for variables in (
            nas_addon._NO_GRAPHQL_VARIABLES, None, {}, {"other": "x"},
        ):
            with self.subTest(variables=variables):
                result = facts(self.WITH_DEFAULT, variables=variables)
                self.assertEqual(
                    result["argumentValues"], {"owner": ["my-org"]}
                )
                self.assertEqual(result["unresolvedArguments"], [])

    def test_provided_variable_wins_over_the_default(self):
        result = facts(self.WITH_DEFAULT, variables={"o": "other"})
        self.assertEqual(result["argumentValues"], {"owner": ["other"]})
        self.assertEqual(result["unresolvedArguments"], [])

    def test_explicit_null_or_non_string_does_not_fall_back_to_default(self):
        for provided in (None, 42):
            with self.subTest(provided=provided):
                result = facts(self.WITH_DEFAULT, variables={"o": provided})
                self.assertEqual(result["argumentValues"], {})
                self.assertEqual(result["unresolvedArguments"], ["owner"])

    def test_non_object_variables_do_not_fall_back_to_default(self):
        # Some servers re-parse a string `variables` as JSON, so resolving
        # the default "my-org" would disagree with the executed "other-org".
        for variables in (
            '{"o":"other-org"}', "", [], [{"o": "my-org"}], 42, 0,
            True, False,
        ):
            with self.subTest(variables=variables):
                result = facts(self.WITH_DEFAULT, variables=variables)
                self.assertEqual(result["argumentValues"], {})
                self.assertEqual(result["unresolvedArguments"], ["owner"])

    def test_non_object_variables_leave_string_literals_resolved(self):
        result = facts(
            'query ($o: String = "my-org") { a(owner: "lit", o: $o) }',
            variables='{"o":"x"}',
        )
        self.assertEqual(result["argumentValues"], {"owner": ["lit"]})
        self.assertEqual(result["unresolvedArguments"], ["o"])

    def test_non_string_default_is_unresolved(self):
        result = facts(
            'query ($n: Int = 10, $e: E = FOO, $z: String = null, '
            '$l: [String] = ["a"]) { a(n: $n, e: $e, z: $z, l: $l) }'
        )
        self.assertEqual(result["argumentValues"], {})
        self.assertEqual(result["unresolvedArguments"], ["n", "e", "z", "l"])

    def test_an_operation_declaring_a_variable_twice_is_unparseable(self):
        for text in (
            'query ($o: String = "my-org", $o: String = "evil") '
            "{ r(owner: $o) }",
            'query ($o: String = "my-org", $o: String) { r(owner: $o) }',
            "query A { a } query B ($o: String, $o: Int) { b }",
        ):
            with self.subTest(text=text):
                self.assertIsNone(facts(text))
        # Separate operations declaring the same name is valid.
        self.assertIsNotNone(
            facts('query A ($o: String = "a") { a } query B ($o: String) { b }')
        )

    def test_shared_fragment_collects_every_operations_default(self):
        result = facts(
            'query A ($o: String = "a") { ...f } '
            'query B ($o: String = "b") { viewer { ...f } } '
            "fragment f on Query { repository(owner: $o) { name } }"
        )
        self.assertEqual(result["argumentValues"], {"owner": ["a", "b"]})
        self.assertEqual(result["unresolvedArguments"], [])

    def test_shared_fragment_reached_without_a_default_is_also_unresolved(
        self,
    ):
        result = facts(
            'query A ($o: String = "a") { ...f } '
            "query B ($o: String) { ...g } "
            "fragment g on Query { ...f } "
            "fragment f on Query { repository(owner: $o) { name } }"
        )
        self.assertEqual(result["argumentValues"], {"owner": ["a"]})
        self.assertEqual(result["unresolvedArguments"], ["owner"])

    def test_unreachable_fragment_resolves_from_variables_only(self):
        text = (
            'query ($o: String = "a") { viewer } '
            "fragment f on Query { repository(owner: $o) }"
        )
        bare = facts(text)
        self.assertEqual(bare["argumentValues"], {})
        self.assertEqual(bare["unresolvedArguments"], ["owner"])
        provided = facts(text, variables={"o": "v"})
        self.assertEqual(provided["argumentValues"], {"owner": ["v"]})
        self.assertEqual(provided["unresolvedArguments"], [])

    def test_fragment_expansion_over_max_nodes_is_unparseable(self):
        # 20 operations each reach a fragment with 20 arguments, so the
        # expansion is 20 * (1 + 20) = 420, more than the token count.
        text = "query { ...f } " * 20 + (
            "fragment f on Q { " + "a(x: 1) " * 20 + "}"
        )
        self.assertIsNotNone(facts(text, {"maxNodes": 420, "maxDepth": 16}))
        self.assertIsNone(facts(text, {"maxNodes": 419, "maxDepth": 16}))

    def test_distinct_spread_targets_are_charged(self):
        # A visit to f costs 1 + 0 + 20 and one to each g costs 1, so 41 per
        # operation and 820 for 20 of them.
        spreads = " ".join(f"...g{i}" for i in range(20))
        targets = " ".join(f"fragment g{i} on Q {{ a }}" for i in range(20))
        text = (
            "query { ...f } " * 20
            + "fragment f on Q { " + spreads + " } " + targets
        )
        self.assertIsNotNone(facts(text, {"maxNodes": 820, "maxDepth": 16}))
        self.assertIsNone(facts(text, {"maxNodes": 819, "maxDepth": 16}))

    def test_a_repeated_spread_is_one_edge(self):
        # f spreads g 200 times but has one edge, so a visit to f costs
        # 1 + 0 + 1 and one to g costs 1 + 20: 23 per operation, 920 for 40.
        # Charging (or walking) each repetition would move the boundary.
        text = (
            "query { ...f } " * 40
            + "fragment f on Q { " + "...g " * 200 + "} "
            + "fragment g on Q { " + "a(x: 1) " * 20 + "}"
        )
        self.assertIsNotNone(facts(text, {"maxNodes": 920, "maxDepth": 16}))
        self.assertIsNone(facts(text, {"maxNodes": 919, "maxDepth": 16}))

    def test_depth_counts_selection_sets_objects_and_lists_from_root(self):
        # SelectionSet + ObjectValue + ListValue is depth 3. A document at
        # the limit passes and one below it fails; the TypeScript side
        # counts the same way.
        text = "{ f(x: {a: [1]}) }"
        self.assertIsNotNone(facts(text, {"maxNodes": 10_000, "maxDepth": 3}))
        self.assertIsNone(facts(text, {"maxNodes": 10_000, "maxDepth": 2}))
        self.assertIsNotNone(
            facts("query { a { b } }", {"maxNodes": 10_000, "maxDepth": 2})
        )

    def test_unparseable_documents_yield_none(self):
        cases = [
            ("syntax error", "query {", LIMITS),
            ("token budget", "{ a }", {"maxNodes": 1, "maxDepth": 16}),
            (
                "depth",
                "query { a { b } }",
                {"maxNodes": 10_000, "maxDepth": 1},
            ),
            ("fragments only", "fragment f on T { a }", LIMITS),
            ("undefined fragment", "query { ...missing }", LIMITS),
            (
                "duplicate fragment name",
                "query { ...f } fragment f on Q { a } fragment f on Q { b }",
                LIMITS,
            ),
            (
                "unused duplicate fragment name",
                "query { a } fragment f on Q { a } fragment f on Q { a }",
                LIMITS,
            ),
            (
                "spread cycle",
                "query { ...a } fragment a on T { ...b } "
                "fragment b on T { ...a }",
                LIMITS,
            ),
        ]
        for name, text, limits in cases:
            with self.subTest(name):
                self.assertIsNone(facts(text, limits))

    def test_parser_recursion_is_unparseable(self):
        # graphql-core parses by recursive descent, so nesting far below
        # the token budget can exhaust the interpreter stack before maxDepth
        # is ever measured. That must read as unparseable, not crash.
        text = "{ " + "a { " * 5000 + "b" + " }" * 5000 + " }"
        self.assertIsNone(
            facts(text, {"maxNodes": 200_000, "maxDepth": 100_000})
        )

    def test_memo_is_keyed_by_text_and_token_budget(self):
        memo = {}
        text = "{ a(o: $o) }"
        nas_addon._parse_graphql_facts(text, LIMITS, {"o": "x"}, memo)
        nas_addon._parse_graphql_facts(text, LIMITS, {"o": "y"}, memo)
        self.assertEqual(list(memo), [(text, LIMITS["maxNodes"])])
        # Depth and variables are applied per lookup, not cached.
        self.assertIsNone(
            nas_addon._parse_graphql_facts(
                text, {"maxNodes": LIMITS["maxNodes"], "maxDepth": 0},
                {"o": "x"}, memo,
            )
        )
        self.assertEqual(
            nas_addon._parse_graphql_facts(text, LIMITS, {"o": "y"}, memo)[
                "argumentValues"
            ],
            {"o": ["y"]},
        )
        nas_addon._parse_graphql_facts(
            text, {"maxNodes": 1, "maxDepth": 16}, None, memo
        )
        self.assertEqual(len(memo), 2)


class GraphqlDocumentsTest(unittest.TestCase):
    def test_only_string_positions_yield_documents(self):
        built = documents(
            {"query": "{ a }", "other": 42, "nested": {"doc": "{ b }"}},
            ["/query", "/other", "/nested/doc", "/missing"],
        )
        self.assertEqual(sorted(built), ["/nested/doc", "/query"])
        self.assertEqual(built["/query"]["rootFields"], ["a"])
        self.assertEqual(built["/nested/doc"]["rootFields"], ["b"])

    def test_unparseable_positions_yield_no_document(self):
        built = documents(
            {
                "fragOnly": "fragment f on T { a }",
                "missing": "query { ...missing }",
                "cyclic": "query { ...a } fragment a on T { ...b } "
                "fragment b on T { ...a }",
                "deep": "query { a { b { c } } }",
                "good": "{ a }",
            },
            ["/fragOnly", "/missing", "/cyclic", "/deep", "/good"],
            {"maxNodes": 10_000, "maxDepth": 2},
        )
        self.assertEqual(list(built), ["/good"])

    def test_non_graphql_string_yields_no_document(self):
        self.assertEqual(documents({"query": "not graphql {"}, ["/query"]), {})

    def test_variables_come_from_the_sibling_of_at(self):
        body = {
            "query": "{ a(o: $o) }",
            "variables": {"o": "top"},
            "batch": [{"query": "{ a(o: $o) }", "variables": {"o": "item"}}],
        }
        built = documents(body, ["/query", "/batch/0/query"])
        self.assertEqual(built["/query"]["argumentValues"], {"o": ["top"]})
        self.assertEqual(
            built["/batch/0/query"]["argumentValues"], {"o": ["item"]}
        )

    def test_document_at_root_has_no_variables(self):
        built = documents("{ a(o: $o) }", [""])
        self.assertEqual(built[""]["unresolvedArguments"], ["o"])


class EvaluateGraphqlTest(unittest.TestCase):
    CONDITION = {
        "at": "/query",
        "operations": ["query"],
        "rootFields": ["repository", "viewer", "rateLimit"],
        "arguments": {"owner": ["my-org"], "login": ["my-org"]},
    }

    def evaluate(self, value, limits=LIMITS):
        return nas_addon._evaluate_graphql(self.CONDITION, value, limits, {})

    def test_shorthand_is_judged_as_query(self):
        built = documents({"query": "{ a }"}, ["/query"])
        self.assertEqual(built["/query"]["operations"], ["query"])

    def test_mutation_is_false_under_query_only(self):
        self.assertEqual(
            self.evaluate({"query": "mutation { repository }"}), "false"
        )

    def test_node_through_root_fragment_is_false(self):
        self.assertEqual(
            self.evaluate({
                "query": 'query { ...f } fragment f on Query '
                '{ node(id: "abc") }',
            }),
            "false",
        )

    def test_variables_resolve_before_arguments_are_judged(self):
        query = "query ($o: String!) { repository(owner: $o) { name } }"
        self.assertEqual(
            self.evaluate({"query": query, "variables": {"o": "my-org"}}),
            "true",
        )
        self.assertEqual(
            self.evaluate({"query": query, "variables": {"o": "other-org"}}),
            "false",
        )

    def test_absent_variable_is_judged_by_the_operation_default(self):
        self.assertEqual(
            self.evaluate({
                "query": 'query ($o: String = "my-org") '
                "{ repository(owner: $o) { name } }",
            }),
            "true",
        )
        self.assertEqual(
            self.evaluate({
                "query": 'query ($o: String = "other-org") '
                "{ repository(owner: $o) { name } }",
            }),
            "false",
        )

    def test_null_variables_use_defaults_and_non_objects_are_indeterminate(
        self,
    ):
        query = (
            'query ($o: String = "my-org") { repository(owner: $o) { name } }'
        )
        self.assertEqual(
            self.evaluate({"query": query, "variables": None}), "true"
        )
        self.assertEqual(
            self.evaluate({"query": query, "variables": {}}), "true"
        )
        for variables in ('{"o":"other-org"}', [], 1, True):
            with self.subTest(variables=variables):
                self.assertEqual(
                    self.evaluate({"query": query, "variables": variables}),
                    "indeterminate",
                )

    def test_missing_member_and_root_document_use_defaults(self):
        query = 'query ($o: String = "d") { a(o: $o) }'
        self.assertEqual(
            documents({"query": query}, ["/query"])["/query"][
                "argumentValues"
            ],
            {"o": ["d"]},
        )
        self.assertEqual(
            documents({"query": query, "variables": "{}"}, ["/query"])[
                "/query"
            ]["unresolvedArguments"],
            ["o"],
        )
        self.assertEqual(
            documents(query, [""])[""]["argumentValues"], {"o": ["d"]}
        )

    def test_unresolved_named_argument_is_indeterminate(self):
        self.assertEqual(
            self.evaluate(
                {"query": "query ($o: String!) { repository(owner: $o) }"}
            ),
            "indeterminate",
        )
        self.assertEqual(
            self.evaluate({
                "query": "{ repository(owner: $o) }",
                "variables": {"o": 42},
            }),
            "indeterminate",
        )

    def test_unresolved_unnamed_argument_does_not_matter(self):
        self.assertEqual(
            self.evaluate({
                "query": '{ repository(owner: "my-org", first: 10) '
                "{ name } }",
            }),
            "true",
        )

    def test_document_without_arguments_satisfies_arguments(self):
        self.assertEqual(
            self.evaluate({"query": "{ repository { name } }"}), "true"
        )

    def test_unparseable_or_over_budget_is_indeterminate(self):
        self.assertEqual(
            self.evaluate({"query": "not graphql {"}), "indeterminate"
        )
        self.assertEqual(
            self.evaluate({"query": "{ a }"}, {"maxNodes": 1, "maxDepth": 16}),
            "indeterminate",
        )

    def test_missing_target_is_false_and_non_string_is_indeterminate(self):
        self.assertEqual(self.evaluate({"other": "{ a }"}), "false")
        self.assertEqual(self.evaluate({"query": 42}), "indeterminate")

    def test_unresolved_named_argument_beats_false(self):
        self.assertEqual(
            self.evaluate({"query": "mutation { node(owner: $o) }"}),
            "indeterminate",
        )

    def test_a_query_string_makes_the_condition_indeterminate(self):
        # Servers read the document and variables from the URL too, so the
        # body's document is not known to be what runs: `?query=mutation...`
        # beside a harmless body, or `?variables=...` overriding a default.
        # Indeterminate, not false: false would let such a request fall
        # through to a broader rule.
        for value in (
            {"query": "{ viewer { id } }"},
            {"query": "mutation { repository }"},
            {"other": "no document"},
        ):
            with self.subTest(value=value):
                truth, diagnostic = nas_addon._evaluate_graphql_with_diagnostic(
                    self.CONDITION, value, LIMITS, {}, True,
                )
                self.assertEqual(truth, "indeterminate")
                self.assertEqual(
                    diagnostic,
                    {"code": "graphql-query-string", "pointer": "/query"},
                )

    def test_any_non_empty_query_string_counts(self):
        for path, expected in (
            ("/graphql", False),
            ("/graphql?", False),
            ("/graphql?query=mutation%7Bx%7D", True),
            ("/graphql?variables[login]=x", True),
            ("/graphql?unrelated=1", True),
            ("/graphql?=", True),
        ):
            with self.subTest(path=path):
                self.assertEqual(nas_addon._has_query_string(path), expected)

    def test_a_query_string_leaves_other_body_conditions_alone(self):
        match = {"bodyFormat": "json", "equals": {"/tier": "gold"},
                 "oneOf": {}, "graphql": None}
        self.assertEqual(
            nas_addon._evaluate_body_match(
                match, "json", {"tier": "gold"}, LIMITS, {}, True,
            ),
            "true",
        )
        self.assertEqual(
            nas_addon._evaluate_body_match(
                match, "json", {"tier": "bronze"}, LIMITS, {}, True,
            ),
            "false",
        )
        with_graphql = {**match, "graphql": self.CONDITION}
        self.assertEqual(
            nas_addon._evaluate_body_match(
                with_graphql, "json",
                {"tier": "bronze", "query": "{ viewer { id } }"},
                LIMITS, {}, True,
            ),
            "indeterminate",
        )

    def test_absent_root_fields_do_not_constrain(self):
        condition = {"at": "/query", "operations": ["query"],
                     "rootFields": None, "arguments": {}}
        self.assertEqual(
            nas_addon._evaluate_graphql(
                condition, {"query": "{ anything }"}, LIMITS, {}
            ),
            "true",
        )


LIMITS = dict(nas_addon._LIMIT_CEILINGS)


def body_expect(**fields):
    expect = {
        "kind": "body",
        "onViolation": "review",
        "equals": {},
        "oneOf": {},
        "graphql": None,
    }
    expect.update(fields)
    return expect


def graphql_condition(**fields):
    condition = {
        "at": "/query",
        "operations": ["query"],
        "rootFields": None,
        "arguments": {},
    }
    condition.update(fields)
    return condition


def check(expect, parsed, limits=LIMITS, patterns=(), memo=None,
          query_string=False):
    return nas_addon._evaluate_body_expect(
        expect, 0, parsed, list(patterns), limits, memo, query_string
    )


def _is_uuid(value):
    try:
        return str(uuid.UUID(value)) == value
    except (TypeError, ValueError, AttributeError):
        return False


def values(findings):
    """(kind, at, value, count), with a per-occurrence UUID value shown as
    `<uuid>` so the fixed parts can be compared."""
    return [
        (f["kind"], f["at"],
         "<uuid>" if _is_uuid(f["value"]) else f["value"], f["count"])
        for f in findings
    ]


class BodyExpectTest(unittest.TestCase):
    def test_pointer_conditions_have_no_indeterminate_outcome(self):
        expect = body_expect(
            equals={"/a": "x"}, oneOf={"/b": ["y", "z"], "/c": [1]}
        )
        violated, findings = check(expect, {"a": "x", "b": "z", "c": 1})
        self.assertEqual((violated, findings), (False, []))

        violated, findings = check(expect, {"b": {"k": "v"}, "c": 2})
        self.assertTrue(violated)
        self.assertEqual(values(findings), [
            ("schema-mismatch", "/a", "/a=(missing)", 1),
            ("schema-mismatch", "/b", "/b=(not-scalar)", 1),
            ("schema-mismatch", "/c", "/c=2", 1),
        ])
        # Only a non-scalar target is quoted, and only masked and bounded.
        self.assertEqual(
            [f["excerpt"] is not None for f in findings], [False, True, False]
        )
        # A real value names itself, so none of these needs a label.
        self.assertEqual([f["label"] for f in findings], [None, None, None])

    def test_a_refused_scalar_keeps_its_json_type(self):
        # The value is an approval key: the string "true" and the boolean
        # true must not share one.
        expect = body_expect(equals={"/a": "x"})
        _, as_string = check(expect, {"a": "true"})
        _, as_bool = check(expect, {"a": True})
        self.assertEqual(values(as_string)[0][2], '/a="true"')
        self.assertEqual(values(as_bool)[0][2], "/a=true")

    def test_the_same_position_and_value_fold_into_a_count(self):
        expect = body_expect(equals={"/a": "x"}, oneOf={"/a": ["y"]})
        _, findings = check(expect, {"a": "z"})
        self.assertEqual(values(findings), [
            ("schema-mismatch", "/a", '/a="z"', 2),
        ])

    def test_a_refused_value_is_masked(self):
        patterns = nas_addon._build_mask_patterns(["s3cret-value"])
        _, findings = check(
            body_expect(equals={"/a": "x"}), {"a": "s3cret-value"},
            patterns=patterns,
        )
        self.assertEqual(values(findings)[0][2], '/a="****"')

    def test_each_pointer_is_its_own_approval_identity(self):
        # Every Pointer of one BodyExpect shares one expect position, so the
        # value is what keeps approving "other" at /model from approving
        # "other" at /owner, and one missing Pointer from covering another.
        expect = body_expect(
            equals={"/model": "m"}, oneOf={"/owner": ["o"], "/x": [1]}
        )
        _, refused = check(expect, {"model": "other", "owner": "other"})
        self.assertEqual([v[2] for v in values(refused)], [
            '/model="other"', '/owner="other"', "/x=(missing)",
        ])
        self.assertEqual({f["expect"] for f in refused}, {0})

        _, missing = check(expect, {"x": 1})
        self.assertEqual([v[2] for v in values(missing)], [
            "/model=(missing)", "/owner=(missing)",
        ])

        _, not_scalar = check(expect, {"model": [], "owner": {}, "x": 1})
        self.assertEqual([v[2] for v in values(not_scalar)], [
            "/model=(not-scalar)", "/owner=(not-scalar)",
        ])

    def test_a_long_pointer_leaves_the_refused_scalar_visible(self):
        # A scalar has no excerpt, so the value is all the approver sees of
        # it. Only the scalar is bounded; a Pointer from the rule, up to the
        # longest the document allows, cannot push it out of the value or
        # merge two Pointers.
        stem = "/" + "p" * (nas_addon.BODY_EXPECT_POINTER_MAX_CHARS - 2)
        expect = body_expect(equals={stem + "a": "x", stem + "b": "x"})
        _, findings = check(
            expect, {stem[1:] + "a": "other", stem[1:] + "b": "other"}
        )
        self.assertEqual([f["value"] for f in findings], [
            stem + 'a="other"', stem + 'b="other"',
        ])

        _, missing = check(expect, {})
        self.assertEqual([f["value"] for f in missing], [
            stem + "a=(missing)", stem + "b=(missing)",
        ])

    def test_a_long_scalar_is_bounded_on_its_own(self):
        long = "v" * (nas_addon.FINDING_VALUE_MAX_CHARS * 2)
        expect = body_expect(equals={"/a": "x"})
        _, findings = check(expect, {"a": long})
        self.assertEqual(
            findings[0]["value"],
            "/a=" + nas_addon._cut_finding_value(json.dumps(long)),
        )

    def test_graphql_findings_name_the_refused_fact_and_never_the_text(self):
        expect = body_expect(graphql=graphql_condition(
            rootFields=["repository"],
            arguments={"owner": ["my-org"], "login": ["my-org"]},
        ))
        parsed = {
            "query": (
                "# not-for-the-card\n"
                "mutation($o: String, $l: String) {"
                ' repository(owner: $o) { id } node(id: "x") { id }'
                " user(login: $l) { id } }"
            ),
            "variables": {"o": "other-org", "l": 7},
        }
        violated, findings = check(expect, parsed)
        self.assertTrue(violated)
        self.assertEqual([v[2] for v in values(findings)], [
            "<uuid>",
            "<uuid>",
            "<uuid>",
            "argument:owner=other-org",
            "<uuid>",
        ])
        for finding in findings:
            self.assertEqual(
                (finding["at"], finding["pointer"]), ("/query", "/query"),
            )
        # Only the facts whose values are UUIDs have a label, and it names
        # the refused fact. No finding quotes document text.
        self.assertEqual(
            [f["label"] for f in findings],
            ["operation:mutation", "rootField:node", "rootField:user", None,
             "argument:login=(unresolved)"],
        )
        self.assertEqual([f["excerpt"] for f in findings], [None] * 5)
        self.assertNotIn("not-for-the-card", repr(findings))

    def test_facts_without_a_value_get_a_fresh_identity_per_request(self):
        # Approving one unanalysable document, or one unresolved argument,
        # says nothing about the next one; a fixed value would make every
        # later occurrence the same approval identity.
        expect = body_expect(graphql=graphql_condition(
            arguments={"owner": ["my-org"]},
        ))
        for name, parsed, kind, label in (
            ("unanalysable", {"query": "query {"},
             "body-unavailable", "document:(unanalysable)"),
            ("unresolved", {"query": "{ repository(owner: $o) { id } }"},
             "schema-mismatch", "argument:owner=(unresolved)"),
        ):
            with self.subTest(name=name):
                _, first = check(expect, parsed)
                _, second = check(expect, parsed)
                self.assertEqual(len(first), 1)
                self.assertEqual(len(second), 1)
                self.assertTrue(_is_uuid(first[0]["value"]))
                self.assertTrue(_is_uuid(second[0]["value"]))
                self.assertNotEqual(first[0]["value"], second[0]["value"])
                self.assertEqual(
                    (first[0]["kind"], first[0]["label"], first[0]["excerpt"]),
                    (kind, label, None),
                )

    def test_a_refused_operation_gets_a_fresh_identity_per_request(self):
        # Approving one mutation says nothing about the next: a fixed
        # `operation:mutation` value would let one approval pass every later
        # mutation for the rest of the session.
        for kind, allowed, query in (
            ("mutation", ["query"], "mutation { deleteRepository { id } }"),
            ("subscription", ["query"], "subscription { onEvent { id } }"),
            ("query", ["mutation"], "{ viewer { id } }"),
        ):
            with self.subTest(kind=kind):
                expect = body_expect(
                    graphql=graphql_condition(operations=allowed),
                )
                _, first = check(expect, {"query": query})
                _, second = check(expect, {"query": query})
                self.assertEqual(len(first), 1)
                self.assertEqual(len(second), 1)
                self.assertTrue(_is_uuid(first[0]["value"]))
                self.assertTrue(_is_uuid(second[0]["value"]))
                self.assertNotEqual(first[0]["value"], second[0]["value"])
                self.assertEqual(
                    (first[0]["kind"], first[0]["label"],
                     first[0]["excerpt"], first[0]["count"]),
                    ("schema-mismatch", f"operation:{kind}", None, 1),
                )

    def test_a_query_string_is_one_violation_with_a_fresh_identity(self):
        # The server may run the URL's document or variables, so the body's
        # document is not analysed and nothing it says is reported: one
        # finding, whose approval covers this request only and which never
        # quotes the query string.
        expect = body_expect(
            equals={"/tier": "gold"},
            graphql=graphql_condition(arguments={"owner": ["my-org"]}),
        )
        for parsed in (
            {"tier": "gold", "query": "{ viewer { id } }"},
            {"tier": "gold", "query": "mutation { deleteRepository { id } }"},
            {"tier": "gold", "query": "query {"},
            {"tier": "gold"},
        ):
            with self.subTest(parsed=parsed):
                violated, first = check(expect, parsed, query_string=True)
                _, second = check(expect, parsed, query_string=True)
                self.assertTrue(violated)
                self.assertEqual(values(first), [
                    ("body-unavailable", "/query", "<uuid>", 1),
                ])
                self.assertEqual(
                    (first[0]["label"], first[0]["excerpt"]),
                    ("document:(query-string)", None),
                )
                self.assertNotEqual(first[0]["value"], second[0]["value"])
        # The other conditions of the same BodyExpect are still checked.
        _, findings = check(
            expect, {"tier": "bronze", "query": "{ viewer { id } }"},
            query_string=True,
        )
        self.assertEqual([v[2] for v in values(findings)], [
            '/tier="bronze"', "<uuid>",
        ])
        # A BodyExpect without a graphql condition does not look at the URL.
        self.assertEqual(
            check(body_expect(equals={"/tier": "gold"}), {"tier": "gold"},
                  query_string=True),
            (False, []),
        )

    def test_a_refused_root_field_gets_a_fresh_identity_per_request(self):
        # A root field is refused because what it reads is not visible in
        # the document: approving one `node(id:)` says nothing about the
        # next, so a fixed `rootField:node` would let one approval pass
        # every later one for the rest of the session.
        expect = body_expect(graphql=graphql_condition(rootFields=["viewer"]))
        _, first = check(expect, {"query": '{ node(id: "a") { id } }'})
        _, second = check(expect, {"query": '{ node(id: "b") { id } }'})
        for findings in (first, second):
            self.assertEqual(len(findings), 1)
            self.assertTrue(_is_uuid(findings[0]["value"]))
            self.assertEqual(
                (findings[0]["kind"], findings[0]["label"],
                 findings[0]["excerpt"], findings[0]["count"]),
                ("schema-mismatch", "rootField:node", None, 1),
            )
        self.assertNotEqual(first[0]["value"], second[0]["value"])

        # Aliases of one root field are one fact, and one UUID, per request.
        _, aliased = check(
            expect, {"query": '{ a: node(id: "a") { id } b: node(id: "b") { id } }'}
        )
        self.assertEqual(
            [(f["label"], f["count"]) for f in aliased],
            [("rootField:node", 1)],
        )

        # The label is masked like any other label.
        patterns = nas_addon._build_mask_patterns(["s3cretfield"])
        _, masked = check(
            expect, {"query": "{ s3cretfield { id } }"}, patterns=patterns
        )
        self.assertEqual(masked[0]["label"], "rootField:****")

    def test_a_refused_argument_value_stays_a_fixed_value(self):
        # A literal outside the set names the value the approver sees, so an
        # approval of it can be remembered.
        expect = body_expect(graphql=graphql_condition(
            arguments={"owner": ["my-org"]},
        ))
        query = '{ repository(owner: "other-org") { id } }'
        _, first = check(expect, {"query": query})
        _, second = check(expect, {"query": query})
        self.assertEqual(
            [(f["value"], f["label"]) for f in first + second],
            [("argument:owner=other-org", None)] * 2,
        )

    def test_one_request_folds_each_refused_operation_into_one_finding(self):
        expect = body_expect(graphql=graphql_condition())
        parsed = {"query": (
            "mutation a { x { id } } mutation b { y { id } }"
            " subscription c { z { id } }"
        ), "operationName": "a"}
        _, findings = check(expect, parsed)
        self.assertEqual(
            [f["label"] for f in findings],
            ["operation:mutation", "operation:subscription"],
        )
        self.assertEqual(len({f["value"] for f in findings}), 2)

    def test_one_request_folds_each_unresolved_argument_into_one_finding(self):
        expect = body_expect(graphql=graphql_condition(
            arguments={"owner": ["my-org"], "login": ["my-org"]},
        ))
        parsed = {"query": (
            "{ a: repository(owner: $x) { id } b: repository(owner: $y) { id }"
            " user(login: 3) { id } }"
        )}
        _, findings = check(expect, parsed)
        self.assertEqual(
            [(f["label"], f["count"]) for f in findings],
            [("argument:owner=(unresolved)", 1),
             ("argument:login=(unresolved)", 1)],
        )
        self.assertEqual(len({f["value"] for f in findings}), 2)

    def test_a_literal_spelled_like_the_unresolved_marker_is_its_own_value(self):
        expect = body_expect(graphql=graphql_condition(
            arguments={"owner": ["my-org"]},
        ))
        _, literal = check(
            expect, {"query": '{ repository(owner: "(unresolved)") { id } }'}
        )
        _, unresolved = check(
            expect, {"query": "{ repository(owner: $o) { id } }"}
        )
        self.assertEqual(literal[0]["value"], "argument:owner=(unresolved)")
        self.assertIsNone(literal[0]["label"])
        self.assertNotEqual(literal[0]["value"], unresolved[0]["value"])

    def test_a_document_that_cannot_be_analysed_is_one_violation(self):
        expect = body_expect(graphql=graphql_condition())
        for name, parsed in (
            ("missing", {}),
            ("not a string", {"query": {"text": "{ a }"}}),
            ("syntax", {"query": "query {"}),
            ("fragments only", {"query": "fragment f on Q { a }"}),
        ):
            with self.subTest(name=name):
                violated, findings = check(expect, parsed)
                self.assertTrue(violated)
                self.assertEqual(values(findings), [
                    ("body-unavailable", "/query", "<uuid>", 1),
                ])

    def test_the_document_is_analysed_under_the_rules_own_limits(self):
        expect = body_expect(graphql=graphql_condition())
        parsed = {"query": "{ a { b { c } } }"}
        self.assertEqual(check(expect, parsed), (False, []))
        _, findings = check(expect, parsed, limits={**LIMITS, "maxDepth": 2})
        self.assertEqual(values(findings), [
            ("body-unavailable", "/query", "<uuid>", 1),
        ])
        _, findings = check(expect, parsed, limits={**LIMITS, "maxNodes": 4})
        self.assertEqual(values(findings), [
            ("body-unavailable", "/query", "<uuid>", 1),
        ])

    def test_distinct_refused_values_are_capped_per_condition(self):
        fields = " ".join(
            f"f{n}: node{n}" for n in range(nas_addon.MAX_FINDINGS_PER_EXPECT + 5)
        )
        expect = body_expect(graphql=graphql_condition(rootFields=["viewer"]))
        violated, findings = check(expect, {"query": "{ " + fields + " }"})
        self.assertTrue(violated)
        self.assertEqual(len(findings), nas_addon.MAX_FINDINGS_PER_EXPECT + 1)
        self.assertEqual(
            (findings[-1]["kind"], findings[-1]["count"]),
            ("findings-truncated", 5),
        )

    def test_selection_and_inspection_share_one_parse(self):
        condition = graphql_condition(arguments={"owner": ["my-org"]})
        rule = {
            "match": {"bodyFormat": "json", "equals": {}, "oneOf": {},
                      "graphql": condition},
            "expect": [body_expect(graphql=condition)],
            "limits": LIMITS,
        }
        body = (
            b'{"query":"{ repository(owner: \\"my-org\\") { id } }"}'
        )
        _kind, parsed = nas_addon._classify_body(body, 1 << 20, True)
        memo = {}
        truth = nas_addon._evaluate_body_match(
            rule["match"], "json", parsed, LIMITS, memo
        )
        self.assertEqual(truth, "true")
        result = nas_addon._inspect_body(rule, body, parsed, [], memo)
        self.assertEqual(result[0], "pass")
        self.assertEqual(len(memo), 1)


if __name__ == "__main__":
    unittest.main()
