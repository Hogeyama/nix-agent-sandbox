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


if __name__ == "__main__":
    unittest.main()
