#!/usr/bin/env python3
"""Black-box encoding regressions; only public decoys and temporary files.

Run after `zig build` in contrib/sumi, optionally setting SUMI_BIN.
Uses Python's encoders as independent fixtures. No network or Claude required.
"""

import base64
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import unittest
from urllib.parse import quote, quote_plus


BINARY = Path(
    os.environ.get("SUMI_BIN", Path(__file__).resolve().parents[1] / "zig-out/bin/sumi")
).resolve()


class EncodedValues(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sumi-encoded-")
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.secrets = self.work / "secrets.txt"

    def protect(self, value):
        self.secrets.write_bytes(value + b"\n")

    def invoke(self, args, data=b"", status=0):
        result = subprocess.run(
            [str(BINARY), *args, "--secrets-file", str(self.secrets)],
            input=data,
            capture_output=True,
            timeout=30,
            cwd=self.work,
        )
        self.assertEqual(result.returncode, status, result.stderr.decode(errors="replace"))
        return result.stdout

    def filter(self, data):
        return self.invoke(["filter"], data)

    def masked(self, original, actual, minimum=8):
        self.assertEqual(len(actual), len(original))
        self.assertGreaterEqual(actual.count(b"*"), minimum)
        self.assertNotEqual(actual, original)
        # The filter only replaces bytes; it must not alter unrelated bytes.
        self.assertTrue(all(a == b or b == ord("*") for a, b in zip(original, actual)))

    def test_url_quote_variants_preserve_literal_case(self):
        value = "MixedCase /+%?=ÿ-decoy"
        self.protect(value.encode())
        variants = {quote(value), quote(value, safe=""), quote_plus(value)}
        variants |= {
            re.sub(r"%[0-9A-F]{2}", lambda match: match[0].lower(), value)
            for value in variants
        }
        for encoded in sorted(variants):
            with self.subTest(encoded=encoded):
                raw = encoded.encode()
                self.assertEqual(self.filter(b"before=" + raw + b";after"),
                                 b"before=" + b"*" * len(raw) + b";after")

    def test_standalone_short_base64_both_alphabets_and_padding(self):
        # Valid UTF-8 values of 4, 5 and 6 bytes, with '/' in standard base64.
        for value in ["ÿÿ".encode(), "ÿÿA".encode(), "ÿÿÿ".encode()]:
            self.protect(value)
            for encoder in [base64.b64encode, base64.urlsafe_b64encode]:
                padded = encoder(value)
                for encoded in {padded, padded.rstrip(b"=")}:
                    with self.subTest(value=value, encoded=encoded):
                        self.assertEqual(self.filter(encoded), b"*" * len(encoded))

    def test_embedded_base64_all_alignments_and_wrap_phases(self):
        # 57 prefix lengths cover all 3 byte alignments and all 19 quartets
        # in a 76-column line. The longer decoy crosses multiple wrap lines.
        for value in [b"Decoy7!", ("ÿ-MixedCase/Decoy_7429:" * 5).encode()]:
            self.protect(value)
            cases = []
            for prefix_len in range(57):
                raw = b"x" * prefix_len + value + b" tail"
                for encoder in [base64.b64encode, base64.urlsafe_b64encode]:
                    encoded = encoder(raw)
                    for newline in [b"", b"\n", b"\r\n"]:
                        wrapped = encoded if not newline else newline.join(
                            encoded[i:i + 76] for i in range(0, len(encoded), 76)
                        )
                        cases.append((prefix_len, encoder.__name__, newline, wrapped))
            delimiter = b"\n---case---\n"
            outputs = self.filter(delimiter.join(case[3] for case in cases)).split(delimiter)
            self.assertEqual(len(outputs), len(cases))
            for (prefix_len, alphabet, newline, original), actual in zip(cases, outputs):
                with self.subTest(length=len(value), offset=prefix_len,
                                  alphabet=alphabet, newline=newline):
                    self.masked(original, actual, max(8, len(base64.b64encode(value)) - 4))

    def test_short_embedded_base64_is_outside_supported_scope(self):
        self.protect(b"abcd")
        encoded = base64.b64encode(b"XabcdY")
        # No >=8-character confident substring exists, and this is not the
        # standalone encoding. Keep this limit visible in executable coverage.
        self.assertEqual(self.filter(encoded), encoded)

    def test_clean_output_is_unchanged(self):
        self.protect(b"UnrelatedDecoy_7429")
        clean = b"normal output\nhttps://example.test/a%2Fb?q=a+b\nYWJjZA==\n"
        self.assertEqual(self.filter(clean), clean)

    def test_streaming_mask_spans_read_boundaries(self):
        value = b"Boundary/Decoy_7429+value"
        self.protect(value)
        for encoded in [quote(value.decode(), safe="").encode(), base64.b64encode(value)]:
            for start in [65530, 65535, 65536]:
                with self.subTest(encoded=encoded, start=start):
                    data = b"." * start + encoded + b"." * 65536
                    self.assertEqual(self.filter(data),
                                     b"." * start + b"*" * len(encoded) + b"." * 65536)

    def test_success_hook_masks_encoded_response(self):
        value = b"Hook/Decoy_7429+value"
        self.protect(value)
        for encoded in [quote(value.decode(), safe=""), base64.b64encode(value).decode()]:
            with self.subTest(encoded=encoded):
                payload = {"hook_event_name": "PostToolUse", "tool_name": "Read",
                           "tool_response": {"stdout": encoded, "ok": True}}
                output = self.invoke(["hook", "--agent", "claude", "post-tool"],
                                     json.dumps(payload).encode())
                updated = json.loads(output)["hookSpecificOutput"]["updatedToolOutput"]
                if isinstance(updated, str):
                    updated = json.loads(updated)
                self.assertEqual(updated, {"stdout": "*" * len(encoded), "ok": True})

    def test_prompt_rejects_encoded_value_and_attachment(self):
        value = b"Prompt/Decoy_7429+value"
        self.protect(value)
        for encoded in [quote(value.decode(), safe=""), base64.b64encode(value).decode()]:
            (self.work / "encoded.txt").write_text(encoded)
            for prompt in ["inspect " + encoded, "inspect @encoded.txt"]:
                with self.subTest(encoded=encoded, prompt=prompt):
                    payload = {"prompt": prompt, "cwd": str(self.work)}
                    output = self.invoke(["hook", "--agent", "claude", "prompt"],
                                         json.dumps(payload).encode())
                    self.assertEqual(json.loads(output)["decision"], "block")

    def test_run_masks_both_streams_and_preserves_failure(self):
        value = b"Run/Decoy_7429+value"
        self.protect(value)
        stdout = quote(value.decode(), safe="").encode()
        stderr = base64.b64encode(value)
        command = ("printf %s " + shlex.quote(stdout.decode()) + "; printf %s "
                   + shlex.quote(stderr.decode()) + " >&2; exit 1")
        result = subprocess.run(
            [str(BINARY), "run", "--secrets-file", str(self.secrets),
             "--shell", "/bin/bash", command],
            capture_output=True, timeout=30, cwd=self.work,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b"*" * len(stdout))
        self.assertEqual(result.stderr, b"*" * len(stderr))

    def test_expansion_budget_failure_withholds_output_and_execution(self):
        # Under the original 16 MiB file limit, above the expanded-pattern
        # budget. Use a public decoy, and never print this large fixture.
        value = b"PublicBudgetDecoy_7429" * 50000
        self.protect(value)
        self.assertEqual(self.invoke(["filter"], b"must be withheld", status=1), b"")

        sentinel = self.work / "must-not-exist"
        result = subprocess.run(
            [str(BINARY), "run", "--secrets-file", str(self.secrets),
             "--shell", "/bin/bash", "touch must-not-exist; printf unmasked"],
            capture_output=True, timeout=30, cwd=self.work,
        )
        self.assertEqual(result.returncode, 121)
        self.assertEqual(result.stdout, b"")
        self.assertFalse(sentinel.exists())

        payload = {"hook_event_name": "PostToolUse", "tool_name": "Read",
                   "tool_response": {"stdout": "PublicBudgetPayload_7429"}}
        output = self.invoke(["hook", "--agent", "claude", "post-tool"],
                             json.dumps(payload).encode())
        updated = json.loads(output)["hookSpecificOutput"]["updatedToolOutput"]
        serialized = json.dumps(updated)
        self.assertNotIn("PublicBudgetPayload_7429", serialized)
        self.assertIn("withheld", serialized)


if __name__ == "__main__":
    if not BINARY.is_file() or not os.access(BINARY, os.X_OK):
        raise SystemExit(f"sumi not found at {BINARY}; run 'zig build' in contrib/sumi first")
    unittest.main(verbosity=2)
