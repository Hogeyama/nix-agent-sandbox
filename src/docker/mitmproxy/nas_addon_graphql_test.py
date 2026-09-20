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


def occurrence(path, leaf, argument_values=None, unresolved=None):
    """One field occurrence, arguments empty by default."""
    return {
        "path": path,
        "leaf": leaf,
        "argumentValues": dict(argument_values or {}),
        "unresolvedArguments": list(unresolved or []),
    }


def paths(result):
    """Just the paths, for cases that do not look at arguments."""
    return [field["path"] for field in result["fields"]]


def doubling(levels, suffix, name="a"):
    """A chain whose every step spreads the next fragment twice: it parses,
    but expanding it doubles at each step. The last field is called `name`
    and carries `suffix` (arguments, directives).

    Expanding `levels` steps takes 1 + 2 + ... + 2^levels = 2^(levels+1) - 1
    spreads plus 2^levels occurrences of the last field off the stack."""
    steps = " ".join(
        "fragment f%d on T { ...f%d ...f%d }" % (i, i + 1, i + 1)
        for i in range(levels)
    )
    return "query { ...f0 } %s fragment f%d on T { %s%s }" % (
        steps, levels, name, suffix,
    )


class ParseGraphqlFactsTest(unittest.TestCase):
    def test_fragments_expand_at_their_use_in_document_order(self):
        result = facts(
            'query($o:String="my-org") { r:repository(owner:$o) { ...F } } '
            "fragment F on Repository { issues { nodes { body } } }"
        )
        self.assertEqual(result["fields"], [
            {"path": "/repository", "leaf": False,
             "argumentValues": {"owner": "my-org"},
             "unresolvedArguments": []},
            {"path": "/repository/issues", "leaf": False,
             "argumentValues": {}, "unresolvedArguments": []},
            {"path": "/repository/issues/nodes", "leaf": False,
             "argumentValues": {}, "unresolvedArguments": []},
            {"path": "/repository/issues/nodes/body", "leaf": True,
             "argumentValues": {}, "unresolvedArguments": []},
        ])

    def test_anonymous_shorthand_is_a_query(self):
        result = facts("{ a }")
        self.assertEqual(result["operations"], ["query"])
        self.assertEqual(result["fields"], [occurrence("/a", True)])

    def test_mutation_and_subscription_kinds(self):
        result = facts("mutation M { a } subscription S { b }")
        self.assertEqual(result["operations"], ["mutation", "subscription"])
        self.assertEqual(result["fields"], [
            occurrence("/a", True), occurrence("/b", True),
        ])

    def test_aliases_are_dropped_and_occurrences_are_kept_apart(self):
        # A5 / A9: an alias cannot make a field look allowed, and each
        # occurrence carries its own arguments.
        result = facts('{ safe: node(id: "a") { id } other: node(id: "b") '
                       "{ id } }")
        self.assertEqual(result["fields"], [
            occurrence("/node", False, {"id": "a"}),
            occurrence("/node/id", True),
            occurrence("/node", False, {"id": "b"}),
            occurrence("/node/id", True),
        ])

    def test_one_fragment_under_two_parents_yields_both_paths(self):
        # A6: treating a fragment name as "already expanded" loses the
        # second parent.
        result = facts(
            "{ safe { ...f } unsafe { ...f } } fragment f on T { body }"
        )
        self.assertEqual(
            paths(result), ["/safe", "/safe/body", "/unsafe", "/unsafe/body"]
        )

    def test_inline_fragment_types_are_not_path_elements(self):
        # A7: `... on Blob` is not a path element and both branches are
        # checked.
        result = facts(
            "{ object { ... on Blob { text } ... on Tree { entries } } }"
        )
        self.assertEqual(
            paths(result), ["/object", "/object/text", "/object/entries"]
        )

    def test_skip_and_include_do_not_remove_selections(self):
        result = facts(
            "query($c: Boolean!) { a @skip(if: $c) { b @include(if: $c) } "
            "... on Q @skip(if: $c) { c } ...f @include(if: $c) } "
            "fragment f on Q { d }"
        )
        self.assertEqual(paths(result), ["/a", "/a/b", "/c", "/d"])

    def test_a_trailing_typename_is_an_occurrence(self):
        # A11: introspection names get no automatic pass, so the facts do
        # not hide them either.
        result = facts("{ repository { __typename } }")
        self.assertEqual(result["fields"], [
            occurrence("/repository", False),
            occurrence("/repository/__typename", True),
        ])

    def test_an_unused_fragment_yields_no_occurrence(self):
        # A6 / A17: the harmless names of an unused fragment cannot offset a
        # violation in what is used.
        result = facts(
            "{ viewer } fragment f on Q "
            "{ starredRepositories { nodes { name } } }"
        )
        self.assertEqual(paths(result), ["/viewer"])

    def test_a_spread_chain_keeps_the_path_of_its_use(self):
        chain = " ".join(
            "fragment f%d on T { ...f%d }" % (i, i + 1) for i in range(20)
        )
        result = facts(
            "{ repository { ...f0 } } %s fragment f20 on T { body }" % chain
        )
        self.assertEqual(paths(result), ["/repository", "/repository/body"])

    def test_resolves_string_literals_and_variables(self):
        result = facts(
            "query ($o: String!) { repository(owner: $o, first: 10) "
            "{ name } }",
            variables={"o": "my-org"},
        )
        self.assertEqual(result["fields"], [
            occurrence("/repository", False, {"owner": "my-org"}, ["first"]),
            occurrence("/repository/name", True),
        ])

    def test_missing_or_non_string_variables_are_unresolved(self):
        result = facts("{ a(o: $o, n: $n, m: $m) }", variables={"n": 42})
        self.assertEqual(
            result["fields"], [occurrence("/a", True, {}, ["o", "n", "m"])]
        )

    def test_directive_arguments_are_not_field_arguments(self):
        # An argument condition hangs off a field path; `@include(if:)` has
        # no path, so it is nobody's argument.
        result = facts(
            'query { a @include(if: $show) ...f } '
            'fragment f on Q { b(owner: "me") }',
            variables={"show": True},
        )
        self.assertEqual(result["fields"], [
            occurrence("/a", True),
            occurrence("/b", True, {"owner": "me"}),
        ])

    def test_two_arguments_of_one_name_on_a_field_are_unparseable(self):
        # A8: which value would run is not something the check can decide.
        self.assertIsNone(facts('{ repository(owner: "a", owner: "b") }'))
        self.assertIsNone(facts('{ repository(owner: $o, owner: "b") }'))
        # The same name on two different fields is valid.
        self.assertIsNotNone(facts('{ a(owner: "x") b(owner: "y") }'))

    def test_dunder_proto_argument_name_is_ordinary(self):
        # `__proto__` is a legal GraphQL Name and request-controlled. Python
        # dicts have no special-cased `__proto__` key, so it is stored and
        # read back like any other argument name (unlike a naive TS object
        # literal, where a bracket assignment to "__proto__" is a no-op).
        result = facts('{ a(__proto__: "x", b: "y") }')
        self.assertEqual(
            result["fields"],
            [occurrence("/a", True, {"__proto__": "x", "b": "y"})],
        )
        # Duplicate detection does not special-case it either.
        self.assertIsNone(facts('{ a(__proto__: "x", __proto__: "y") }'))

    def test_an_unknown_directive_where_it_is_reached_is_unparseable(self):
        # A8: the meaning of an unknown directive is not guessed.
        cases = [
            ("operation", "query @cached { a }"),
            ("variable definition", "query ($o: String @tag) { a }"),
            ("field", "{ a @cached { b } }"),
            ("inline fragment", "{ a { ... on T @cached { b } } }"),
            ("fragment spread", "{ ...f @cached } fragment f on Q { a }"),
            ("fragment definition", "{ ...f } fragment f on Q @cached { a }"),
        ]
        for name, text in cases:
            with self.subTest(name):
                self.assertIsNone(facts(text))

    def test_an_unknown_directive_out_of_reach_does_not_matter(self):
        result = facts("{ a } fragment f on Q @cached { b @cached }")
        self.assertEqual(paths(result), ["/a"])

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
                    result["fields"][0],
                    occurrence("/repository", False, {"owner": "my-org"}),
                )

    def test_provided_variable_wins_over_the_default(self):
        result = facts(self.WITH_DEFAULT, variables={"o": "other"})
        self.assertEqual(
            result["fields"][0],
            occurrence("/repository", False, {"owner": "other"}),
        )

    def test_explicit_null_or_non_string_does_not_fall_back_to_default(self):
        for provided in (None, 42):
            with self.subTest(provided=provided):
                result = facts(self.WITH_DEFAULT, variables={"o": provided})
                self.assertEqual(
                    result["fields"][0],
                    occurrence("/repository", False, {}, ["owner"]),
                )

    def test_non_object_variables_do_not_fall_back_to_default(self):
        # Some servers re-parse a string `variables` as JSON, so resolving
        # the default "my-org" would disagree with the executed "other-org".
        for variables in (
            '{"o":"other-org"}', "", [], [{"o": "my-org"}], 42, 0,
            True, False,
        ):
            with self.subTest(variables=variables):
                result = facts(self.WITH_DEFAULT, variables=variables)
                self.assertEqual(
                    result["fields"][0],
                    occurrence("/repository", False, {}, ["owner"]),
                )

    def test_non_object_variables_leave_string_literals_resolved(self):
        result = facts(
            'query ($o: String = "my-org") { a(owner: "lit", o: $o) }',
            variables='{"o":"x"}',
        )
        self.assertEqual(
            result["fields"], [occurrence("/a", True, {"owner": "lit"}, ["o"])]
        )

    def test_non_string_default_is_unresolved(self):
        result = facts(
            'query ($n: Int = 10, $e: E = FOO, $z: String = null, '
            '$l: [String] = ["a"]) { a(n: $n, e: $e, z: $z, l: $l) }'
        )
        self.assertEqual(
            result["fields"],
            [occurrence("/a", True, {}, ["n", "e", "z", "l"])],
        )

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

    def test_a_shared_fragment_resolves_in_the_operation_of_its_use(self):
        # A10: each occurrence is resolved in the context of the operation
        # it sits in.
        result = facts(
            'query A ($o: String = "a") { ...f } '
            'query B ($o: String = "b") { viewer { ...f } } '
            "fragment f on Query { repository(owner: $o) { name } }"
        )
        self.assertEqual(result["fields"], [
            occurrence("/repository", False, {"owner": "a"}),
            occurrence("/repository/name", True),
            occurrence("/viewer", False),
            occurrence("/viewer/repository", False, {"owner": "b"}),
            occurrence("/viewer/repository/name", True),
        ])

    def test_only_the_occurrence_without_a_default_is_unresolved(self):
        result = facts(
            'query A ($o: String = "a") { ...f } '
            "query B ($o: String) { ...g } "
            "fragment g on Query { ...f } "
            "fragment f on Query { repository(owner: $o) }"
        )
        self.assertEqual(result["fields"], [
            occurrence("/repository", True, {"owner": "a"}),
            occurrence("/repository", True, {}, ["owner"]),
        ])

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

    def test_max_depth_applies_to_the_expanded_nesting(self):
        # The AST nests 2 deep in the operation and 2 in the fragment, but
        # expanding gives /a/b/c, 3 deep. Depth through fragments is bounded
        # neither by the token count nor by the AST nesting.
        text = "{ a { ...f } } fragment f on T { b { c } }"
        self.assertIsNotNone(facts(text, {"maxNodes": 10_000, "maxDepth": 3}))
        self.assertIsNone(facts(text, {"maxNodes": 10_000, "maxDepth": 2}))

    def test_doubling_spreads_are_charged_before_they_are_folded(self):
        # 8 levels of spreads (1 + 2 + ... + 2^8 = 511) and 2^8 fields is
        # 767. Treating a fragment name as expanded would make it 9 + 1.
        text = doubling(8, "")
        self.assertIsNotNone(facts(text, {"maxNodes": 767, "maxDepth": 16}))
        self.assertIsNone(facts(text, {"maxNodes": 766, "maxDepth": 16}))

    def test_each_evaluated_argument_occurrence_is_charged(self):
        # 767 plus the 2^8 argument occurrences is 1023.
        text = doubling(8, '(owner: "my-org")')
        self.assertIsNotNone(facts(text, {"maxNodes": 1023, "maxDepth": 16}))
        self.assertIsNone(facts(text, {"maxNodes": 1022, "maxDepth": 16}))

    def test_every_reached_directive_is_charged(self):
        # 4 levels take 2^5 - 1 = 31 spreads and 2^4 = 16 occurrences of the
        # last field off the stack. That field carries 4 @skip directives, so
        # one occurrence costs 1 (the selection) + 4 (the directives) = 5 and
        # the document costs 31 + 16 * 5 = 111. Without charging the
        # directives it would cost 31 + 16 = 47 and pass: the same field node
        # is walked 16 times, i.e. 64 directive scans, so at 1 charge per
        # visit a small body buys an unbounded number of scans.
        text = doubling(4, " @skip(if: true)" * 4)
        self.assertIsNotNone(facts(text, {"maxNodes": 111, "maxDepth": 16}))
        self.assertIsNone(facts(text, {"maxNodes": 110, "maxDepth": 16}))

    def test_the_stored_path_is_charged_per_64_bytes(self):
        # Same 31 spreads and 16 occurrences. A field name of 127 characters
        # makes the path "/" + 127 = 128 bytes, i.e. 128 // 64 = 2 units, so
        # one occurrence costs 1 + 2 = 3 and the document costs
        # 31 + 16 * 3 = 79. A Name is one token however long, so without the
        # charge the document would still cost 47 while building one huge
        # string per occurrence.
        long_name = doubling(4, "", "a" * 127)
        self.assertIsNotNone(
            facts(long_name, {"maxNodes": 79, "maxDepth": 16})
        )
        self.assertIsNone(facts(long_name, {"maxNodes": 78, "maxDepth": 16}))
        # A path under 64 bytes adds nothing: 6 levels of "a" still cost
        # (2^7 - 1) + 2^6 = 191, so the 767 / 1023 arithmetic above is
        # unchanged.
        short = doubling(6, "")
        self.assertIsNotNone(facts(short, {"maxNodes": 191, "maxDepth": 16}))
        self.assertIsNone(facts(short, {"maxNodes": 190, "maxDepth": 16}))

    def test_a_document_over_budget_yields_no_partial_fields(self):
        # A8 / A17: a document that parses is still unparseable as a whole
        # when it cannot be expanded; partial facts must not pass it.
        text = doubling(8, "")
        self.assertIsNone(facts(text, {"maxNodes": 200, "maxDepth": 16}))
        self.assertIsNotNone(facts(text, {"maxNodes": 10_000, "maxDepth": 16}))

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

    def test_memo_holds_the_parse_only_not_resolved_fields(self):
        memo = {}
        text = "{ a(o: $o) }"
        nas_addon._parse_graphql_facts(text, LIMITS, {"o": "x"}, memo)
        nas_addon._parse_graphql_facts(text, LIMITS, {"o": "y"}, memo)
        self.assertEqual(list(memo), [(text, LIMITS["maxNodes"])])
        # Depth, the expansion budget and the variables are applied per
        # lookup: the memo holds the parse, never a resolved field.
        self.assertIsNone(
            nas_addon._parse_graphql_facts(
                text, {"maxNodes": LIMITS["maxNodes"], "maxDepth": 0},
                {"o": "x"}, memo,
            )
        )
        self.assertEqual(
            nas_addon._parse_graphql_facts(text, LIMITS, {"o": "y"}, memo)[
                "fields"
            ],
            [occurrence("/a", True, {"o": "y"})],
        )
        self.assertEqual(
            nas_addon._parse_graphql_facts(text, LIMITS, None, memo)["fields"],
            [occurrence("/a", True, {}, ["o"])],
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
        self.assertEqual(paths(built["/query"]), ["/a"])
        self.assertEqual(paths(built["/nested/doc"]), ["/b"])

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
        self.assertEqual(
            built["/query"]["fields"][0]["argumentValues"], {"o": "top"}
        )
        self.assertEqual(
            built["/batch/0/query"]["fields"][0]["argumentValues"],
            {"o": "item"},
        )

    def test_missing_member_and_root_document_use_defaults(self):
        query = 'query ($o: String = "d") { a(o: $o) }'
        self.assertEqual(
            documents({"query": query}, ["/query"])["/query"]["fields"][0][
                "argumentValues"
            ],
            {"o": "d"},
        )
        self.assertEqual(
            documents({"query": query, "variables": "{}"}, ["/query"])[
                "/query"
            ]["fields"][0]["unresolvedArguments"],
            ["o"],
        )
        self.assertEqual(
            documents(query, [""])[""]["fields"][0]["argumentValues"],
            {"o": "d"},
        )

    def test_document_at_root_has_no_variables(self):
        built = documents("{ a(o: $o) }", [""])
        self.assertEqual(
            built[""]["fields"][0]["unresolvedArguments"], ["o"]
        )


class EvaluateGraphqlTest(unittest.TestCase):
    CONDITION = {
        "at": "/query",
        "operations": ["query"],
        "fieldPaths": [
            "/a",
            "/repository/name",
            "/repository/issues/nodes/body",
            "/viewer/id",
            "/rateLimit/remaining",
            "/organization/login",
        ],
        "fieldArguments": {
            "/repository": {"owner": ["my-org"]},
            "/organization": {"login": ["my-org"]},
        },
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
            documents({"query": query}, ["/query"])["/query"]["fields"][0][
                "argumentValues"
            ],
            {"o": "d"},
        )
        self.assertEqual(
            documents({"query": query, "variables": "{}"}, ["/query"])[
                "/query"
            ]["fields"][0]["unresolvedArguments"],
            ["o"],
        )
        self.assertEqual(
            documents(query, [""])[""]["fields"][0]["argumentValues"],
            {"o": "d"},
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

    def test_a_named_argument_must_be_on_the_occurrence(self):
        # The argument condition is not "where it appears": the field's own
        # occurrence has to carry it, so omitting `owner` is false, not a
        # vacuous pass.
        self.assertEqual(
            self.evaluate({"query": "{ repository { name } }"}), "false"
        )
        # A field that does not occur at all requires nothing.
        self.assertEqual(
            self.evaluate({"query": "{ viewer { id } }"}), "true"
        )
        # Another field's `owner` does not satisfy `/repository`'s.
        self.assertEqual(
            self.evaluate({
                "query": '{ viewer(owner: "my-org") { id } '
                "repository { name } }",
            }),
            "false",
        )

    def test_each_occurrence_is_judged_on_its_own(self):
        self.assertEqual(
            self.evaluate({
                "query": '{ a: repository(owner: "my-org") { name } '
                'b: repository(owner: "other-org") { name } }',
            }),
            "false",
        )

    def test_an_allowed_leaf_with_children_is_refused(self):
        # `/a` is a leaf of the condition, so `a { b }` fetches through it
        # rather than to it. A proper prefix is required to pass through.
        self.assertEqual(self.evaluate({"query": "{ a }"}), "true")
        self.assertEqual(self.evaluate({"query": "{ a { b } }"}), "false")

    def test_a_prefix_does_not_allow_its_other_children(self):
        self.assertEqual(
            self.evaluate({
                "query": '{ repository(owner: "my-org") { name } }',
            }),
            "true",
        )
        self.assertEqual(
            self.evaluate({
                "query": '{ repository(owner: "my-org") { stargazerCount } }',
            }),
            "false",
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
        # The operation kind and the path are both refused, but the scan
        # does not stop: an unresolved named argument still wins.
        self.assertEqual(
            self.evaluate({"query": "mutation { repository(owner: $o) }"}),
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

    def test_facts_without_an_operation_or_a_leaf_are_indeterminate(self):
        # Hand-written or pre-field-path facts must not read as an empty
        # set that satisfies everything: an empty `operations` would satisfy
        # two disjoint operation conditions at once, and a document with no
        # leaf constrains nothing.
        condition = {
            "at": "/query", "operations": ["query"],
            "fieldPaths": ["/a"], "fieldArguments": {},
        }
        for name, broken in (
            ("no operation", {"operations": [], "fields": [
                occurrence("/a", True)]}),
            ("no leaf", {"operations": ["query"], "fields": [
                occurrence("/a", False)]}),
            ("no fields", {"operations": ["query"], "fields": []}),
        ):
            with self.subTest(name=name):
                self.assertEqual(
                    nas_addon._graphql_satisfies(condition, broken),
                    "indeterminate",
                )

    def test_argument_and_field_names_are_looked_up_as_data(self):
        # `__proto__` and `constructor` are ordinary GraphQL Names. The
        # lookups must not find anything a mapping did not put there.
        condition = {
            "at": "/query", "operations": ["query"],
            "fieldPaths": ["/__proto__"],
            "fieldArguments": {"/__proto__": {"constructor": ["ok"]}},
        }
        satisfies = nas_addon._graphql_selection_satisfies
        self.assertEqual(
            satisfies(condition, {"operations": ["query"], "fields": [
                occurrence("/__proto__", True, {"constructor": "ok"})]}),
            "true",
        )
        self.assertEqual(
            satisfies(condition, {"operations": ["query"], "fields": [
                occurrence("/__proto__", True)]}),
            "false",
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
    """A resolved graphql condition. `fieldPaths` is required and non-empty,
    so the default allows a small tree instead of allowing everything."""
    condition = {
        "at": "/query",
        "operations": ["query"],
        "fieldPaths": ["/a/b/c", "/viewer/id", "/x/id", "/y/id", "/z/id"],
        "fieldArguments": {},
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
            fieldPaths=["/repository/id"],
            fieldArguments={
                "/repository": {"owner": ["my-org"]},
                "/user": {"login": ["my-org"]},
            },
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
        # Every GraphQL finding is a per-request identity now: no approval of
        # one of them can stand for another request.
        self.assertEqual([v[2] for v in values(findings)], ["<uuid>"] * 5)
        for finding in findings:
            self.assertEqual(
                (finding["at"], finding["pointer"]), ("/query", "/query"),
            )
        # The label names the refused fact: the operation kind, the refused
        # leaf paths in document order, then the arguments by reason. No
        # finding quotes document text, an alias, or an argument's value.
        self.assertEqual(
            [f["label"] for f in findings],
            [
                "operation:mutation",
                "fieldPath:/node/id",
                "fieldPath:/user/id",
                "fieldArgument:/repository@owner=(not-allowed)",
                "fieldArgument:/user@login=(unresolved)",
            ],
        )
        self.assertEqual([f["excerpt"] for f in findings], [None] * 5)
        self.assertNotIn("not-for-the-card", repr(findings))
        self.assertNotIn("other-org", repr(findings))

    def test_a_refused_prefix_does_not_end_the_scan(self):
        # Knowing the subtree is refused at its root is not a reason to stop:
        # the other leaves of the same document are still reported.
        expect = body_expect(graphql=graphql_condition(
            fieldPaths=["/keep/id"],
        ))
        _, findings = check(expect, {"query": (
            "{ keep { id } deny { one { id } two { id } } }"
        )})
        self.assertEqual([f["label"] for f in findings], [
            "fieldPath:/deny/one/id",
            "fieldPath:/deny/two/id",
        ])

    def test_the_three_argument_reasons_are_told_apart(self):
        expect = body_expect(graphql=graphql_condition(
            fieldPaths=["/miss/id", "/bad/id", "/unres/id"],
            fieldArguments={
                "/miss": {"owner": ["my-org"]},
                "/bad": {"owner": ["my-org"]},
                "/unres": {"owner": ["my-org"]},
            },
        ))
        _, findings = check(expect, {"query": (
            '{ miss { id } bad(owner: "other-org") { id }'
            " unres(owner: $o) { id } }"
        )})
        self.assertEqual([f["label"] for f in findings], [
            "fieldArgument:/miss@owner=(missing)",
            "fieldArgument:/bad@owner=(not-allowed)",
            "fieldArgument:/unres@owner=(unresolved)",
        ])
        self.assertEqual(len({f["value"] for f in findings}), 3)

    def test_facts_without_a_value_get_a_fresh_identity_per_request(self):
        # Approving one unanalysable document, or one unresolved argument,
        # says nothing about the next one; a fixed value would make every
        # later occurrence the same approval identity.
        expect = body_expect(graphql=graphql_condition(
            fieldPaths=["/repository/id"],
            fieldArguments={"/repository": {"owner": ["my-org"]}},
        ))
        for name, parsed, kind, label in (
            ("unanalysable", {"query": "query {"},
             "body-unavailable", "document:(unanalysable)"),
            ("unresolved", {"query": "{ repository(owner: $o) { id } }"},
             "schema-mismatch",
             "fieldArgument:/repository@owner=(unresolved)"),
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
                expect = body_expect(graphql=graphql_condition(
                    operations=allowed,
                    fieldPaths=[
                        "/deleteRepository/id", "/onEvent/id", "/viewer/id",
                    ],
                ))
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
            graphql=graphql_condition(
                fieldPaths=["/repository/id"],
                fieldArguments={"/repository": {"owner": ["my-org"]}},
            ),
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

    def test_a_refused_field_path_gets_a_fresh_identity_per_request(self):
        # A path says which fetch was refused, not which value: approving
        # one `node(id: "a")` says nothing about the next, and a fixed
        # `fieldPath:/node/id` would let one approval pass every later
        # request that walks it, whatever it reaches (spec A13).
        expect = body_expect(graphql=graphql_condition(
            fieldPaths=["/viewer/id"],
        ))
        _, first = check(expect, {"query": '{ node(id: "a") { id } }'})
        _, second = check(expect, {"query": '{ node(id: "b") { id } }'})
        for findings in (first, second):
            self.assertEqual(len(findings), 1)
            self.assertTrue(_is_uuid(findings[0]["value"]))
            self.assertEqual(
                (findings[0]["kind"], findings[0]["label"],
                 findings[0]["excerpt"], findings[0]["count"]),
                ("schema-mismatch", "fieldPath:/node/id", None, 1),
            )
        self.assertNotEqual(first[0]["value"], second[0]["value"])

        # Aliases of one path are one fact, and one UUID, per request.
        _, aliased = check(expect, {
            "query": '{ a: node(id: "a") { id } b: node(id: "b") { id } }',
        })
        self.assertEqual(
            [(f["label"], f["count"]) for f in aliased],
            [("fieldPath:/node/id", 1)],
        )

        # The path is the only request-derived text in a label, and it goes
        # through the same mask as every other label.
        patterns = nas_addon._build_mask_patterns(["s3cretfield"])
        _, masked = check(
            expect, {"query": "{ s3cretfield { id } }"}, patterns=patterns
        )
        self.assertEqual(masked[0]["label"], "fieldPath:/****/id")

    def test_a_refused_argument_never_names_the_value(self):
        # The old value-keyed `argument:owner=other-org` is gone: an argument
        # violation is a per-request identity whose label carries the reason
        # only, so the request's own strings stay off the approval card.
        expect = body_expect(graphql=graphql_condition(
            fieldPaths=["/repository/id"],
            fieldArguments={"/repository": {"owner": ["my-org"]}},
        ))
        query = '{ repository(owner: "other-org") { id } }'
        _, first = check(expect, {"query": query})
        _, second = check(expect, {"query": query})
        self.assertEqual(
            [f["label"] for f in first + second],
            ["fieldArgument:/repository@owner=(not-allowed)"] * 2,
        )
        self.assertTrue(_is_uuid(first[0]["value"]))
        self.assertNotEqual(first[0]["value"], second[0]["value"])
        self.assertNotIn("other-org", repr(first))

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

    def test_one_request_folds_each_argument_reason_into_one_finding(self):
        # Every occurrence is checked, and only the display is folded: one
        # finding per (path, argument, reason), whatever the alias.
        expect = body_expect(graphql=graphql_condition(
            fieldPaths=["/repository/id", "/user/id"],
            fieldArguments={
                "/repository": {"owner": ["my-org"]},
                "/user": {"login": ["my-org"]},
            },
        ))
        parsed = {"query": (
            "{ a: repository(owner: $x) { id } b: repository(owner: $y) { id }"
            " user(login: 3) { id } }"
        )}
        _, findings = check(expect, parsed)
        self.assertEqual(
            [(f["label"], f["count"]) for f in findings],
            [("fieldArgument:/repository@owner=(unresolved)", 1),
             ("fieldArgument:/user@login=(unresolved)", 1)],
        )
        self.assertEqual(len({f["value"] for f in findings}), 2)

        # One bad occurrence beside a good one is still a violation.
        _, mixed = check(expect, {"query": (
            '{ a: repository(owner: "my-org") { id }'
            ' b: repository(owner: "other-org") { id } }'
        )})
        self.assertEqual(
            [f["label"] for f in mixed],
            ["fieldArgument:/repository@owner=(not-allowed)"],
        )

    def test_a_field_named_like_the_marker_is_its_own_path(self):
        # A path and an argument reason cannot spell the same label: the
        # label is display text, and the identity is the UUID either way.
        expect = body_expect(graphql=graphql_condition(
            fieldPaths=["/repository/id"],
            fieldArguments={"/repository": {"owner": ["my-org"]}},
        ))
        _, literal = check(
            expect, {"query": '{ repository(owner: "(unresolved)") { id } }'}
        )
        _, unresolved = check(
            expect, {"query": "{ repository(owner: $o) { id } }"}
        )
        self.assertEqual(
            literal[0]["label"],
            "fieldArgument:/repository@owner=(not-allowed)",
        )
        self.assertEqual(
            unresolved[0]["label"],
            "fieldArgument:/repository@owner=(unresolved)",
        )
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
        expect = body_expect(graphql=graphql_condition(
            fieldPaths=["/viewer/id"],
        ))
        violated, findings = check(expect, {"query": "{ " + fields + " }"})
        self.assertTrue(violated)
        self.assertEqual(len(findings), nas_addon.MAX_FINDINGS_PER_EXPECT + 1)
        self.assertEqual(
            (findings[-1]["kind"], findings[-1]["count"]),
            ("findings-truncated", 5),
        )

    def test_selection_and_inspection_share_one_parse(self):
        condition = graphql_condition(
            fieldPaths=["/repository/id"],
            fieldArguments={"/repository": {"owner": ["my-org"]}},
        )
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
