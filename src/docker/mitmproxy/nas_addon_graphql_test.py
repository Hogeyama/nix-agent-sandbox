"""Unit tests for the vendored graphql-core dependency of nas_addon.py.

Run via nas_addon_test.ts, which sets PYTHONPATH to the mitmproxy stub.
Direct invocation:
    PYTHONPATH=testdata/mitmproxy_stub python3 nas_addon_graphql_test.py
"""

import os
import unittest

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

    def test_absent_root_fields_do_not_constrain(self):
        condition = {"at": "/query", "operations": ["query"],
                     "rootFields": None, "arguments": {}}
        self.assertEqual(
            nas_addon._evaluate_graphql(
                condition, {"query": "{ anything }"}, LIMITS, {}
            ),
            "true",
        )


if __name__ == "__main__":
    unittest.main()
