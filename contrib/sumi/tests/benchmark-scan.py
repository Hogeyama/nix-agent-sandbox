#!/usr/bin/env python3
"""Compare release builds on synthetic scans; never reads user credentials.

Build the base and candidate with `zig build -Doptimize=ReleaseFast`, then run:
  python3 tests/benchmark-scan.py /path/to/base/sumi /path/to/candidate/sumi
Each case checks identical exit status, diagnostics, settings and ownership.
Timings include process startup and use warm filesystem caches. No timing gate.
"""
import argparse
import json
from pathlib import Path
import statistics
import subprocess
import tempfile
import time


def positive(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be positive")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--files", type=positive, default=10000)
    parser.add_argument("--entries", type=positive, default=1000)
    parser.add_argument("--repeats", type=positive, default=5)
    args = parser.parse_args()
    binaries = [args.baseline.resolve(), args.candidate.resolve()]
    with tempfile.TemporaryDirectory(prefix="sumi-scan-benchmark-") as temporary:
        base = Path(temporary)
        root = base / "project"
        root.mkdir()
        secret_file = base / "secrets"
        secret_file.write_text("SyntheticBenchmarkToken9\n")
        paths = [root / f"file-{i:06}.txt" for i in range(args.files)]
        for path in paths:
            path.write_text("ordinary file content\n" * 16)
        settings = base / "settings.json"
        record = base / "settings.sumi-scan.json"
        entries = min(args.entries, args.files)
        for case in ("clean-unconfigured", "clean-with-owned-entries"):
            configured = paths[:entries] if case.endswith("owned-entries") else []
            original = {"sandbox": {"enabled": True, "credentials": {"files": [
                {"path": str(path), "mode": "mask", "injectHosts": []}
                for path in configured
            ]}}}
            ownership = {"credentialsFiles": list(map(str, configured))}
            timings = [[], []]
            expected = None
            for repeat in range(args.repeats + 1):
                # Warm both binaries once, then alternate which runs first.
                for index in ((0, 1) if repeat % 2 == 0 else (1, 0)):
                    settings.write_text(json.dumps(original))
                    record.write_text(json.dumps(ownership))
                    start = time.perf_counter()
                    result = subprocess.run([
                        str(binaries[index]), "scan", "--agent", "claude",
                        "--secrets-file", str(secret_file), "--root", str(root),
                        "--settings", str(settings),
                    ], capture_output=True, timeout=120, check=False)
                    elapsed = time.perf_counter() - start
                    if result.returncode != 0:
                        raise RuntimeError(f"{case}: scan failed: {result.stderr.decode()}")
                    actual = (result.stdout, result.stderr, settings.read_bytes(), record.read_bytes())
                    if expected is None:
                        expected = actual
                    elif actual != expected:
                        raise RuntimeError(f"{case}: baseline/candidate output mismatch")
                    if repeat:
                        timings[index].append(elapsed)
            before, after = map(statistics.median, timings)
            print(f"{case}: files={args.files}, entries={len(configured)}, "
                  f"median of {args.repeats}: baseline={before:.4f}s, "
                  f"candidate={after:.4f}s, speedup={before / after:.2f}x; outputs identical")


if __name__ == "__main__":
    main()
