# Plan

1. Add an owned, bounded pattern expander and integrate at secrets.load.
2. Test URL forms, standalone and embedded base64, all 76-column phases,
   allocation failure and budget enforcement; exercise CLI consumers with decoys.
3. Update README with the precise supported formats and remaining limits.
4. Run Zig tests/build, CLI regression tests, formatter/lint/type checks and
   the final repository suite once. Review changes and resolve actual defects.
5. Commit and push the current branch to its configured origin.

Constraints: preserve original file validation and fail-closed callers; keep
changes local to contrib/sumi; follow test-policy and security-constraints.
