# Config Migration Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every removed network-config identifier diagnostic point to one current, public GitHub migration guide.

**Architecture:** Keep legacy identifier detection and its identifier-specific short hints in `src/network/authz/validate.ts`. Replace the internal spec reference with one canonical public URL, document every recognized identifier in a new scope-based migration guide, and turn the obsolete intermediate guide into a redirect.

**Tech Stack:** Bun, TypeScript, Pkl configuration, Markdown

## Global Constraints

- The canonical diagnostic URL is exactly `https://github.com/Hogeyama/nix-agent-sandbox/blob/develop/docs/migration/network-scopes.md#legacy-identifier-mapping`.
- Every identifier recognized by `detectLegacyIdentifiers` uses that same URL.
- Diagnostics must not expose a `docs/superpowers/` path.
- Preserve the source file, line number, removed identifier, and short replacement hint in each diagnostic.
- Do not stage or modify the user's unrelated `.nas/config.pkl` `filter = false` change.

---

### Task 1: Publish and enforce canonical migration guidance

**Files:**
- Create: `docs/migration/network-scopes.md`
- Modify: `docs/migration/network-review-rules.md`
- Modify: `src/network/authz/validate.ts:1053-1054`
- Test: `src/network/authz/validate_test.ts:1264-1284`

**Interfaces:**
- Consumes: `detectLegacyIdentifiers(source: string, fileName: string): readonly Diagnostic[]`
- Produces: a stable diagnostic URL and a guide whose `legacy-identifier-mapping` heading covers all 12 entries in `LEGACY_IDENTIFIERS`

- [ ] **Step 1: Write the failing diagnostic-contract test**

Extend the existing `12 個の廃止識別子をすべて名指しする` test so every emitted message must contain the public URL and must not contain an internal spec path:

```typescript
const migrationGuideUrl =
  "https://github.com/Hogeyama/nix-agent-sandbox/blob/develop/docs/migration/network-scopes.md#legacy-identifier-mapping";

for (const identifier of removed) {
  const found = detectLegacyIdentifiers(`x = ${identifier}`, "c.pkl");
  expect(found.map((diagnostic) => diagnostic.severity)).toEqual(["error"]);
  expect(found[0]?.message).toContain(identifier);
  expect(found[0]?.message).toContain(migrationGuideUrl);
  expect(found[0]?.message).not.toContain("docs/superpowers/");
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun test src/network/authz/validate_test.ts --test-name-pattern "12 個の廃止識別子"
```

Expected: FAIL because the message still contains the old `docs/superpowers/specs/...#移行` reference and does not contain the GitHub URL.

- [ ] **Step 3: Point diagnostics at the canonical public guide**

Replace `SPEC_REFERENCE` in `src/network/authz/validate.ts` with:

```typescript
const MIGRATION_GUIDE_URL =
  "https://github.com/Hogeyama/nix-agent-sandbox/blob/develop/docs/migration/network-scopes.md#legacy-identifier-mapping";
```

Use `MIGRATION_GUIDE_URL` in the existing `対応表:` line. Do not change identifier detection or the identifier-specific hints.

- [ ] **Step 4: Write the canonical current migration guide**

Create `docs/migration/network-scopes.md` with:

- a short statement that current network authorization uses `network.scopes`, `Rule`, the top-level `secrets` registry, and per-scope/per-rule `inject`;
- a `## Legacy Identifier Mapping` heading so GitHub generates the `#legacy-identifier-mapping` anchor;
- one row for each of `reviewRules`, `ReviewRule`, `credentials`, `CredentialRule`, `CredentialValSpec`, `BodylessRequestPolicy`, `JsonRequestPolicy`, `TaggedUnionGuard`, `anthropicV1`, `anthropicJsonPolicy`, `MaskValueConfig`, and `pendingDefaultScope`;
- current Pkl examples for a basic scope, a secret registry entry plus injected header, JSON/empty-body matching and expectations, and `presets.anthropic.v1`;
- an explicit note that unmatched requests use the scope or network `fallback` and that approval scope is derived from the matched rule rather than configured with `pendingDefaultScope`.

Replace `docs/migration/network-review-rules.md` with a short note that the document described an intermediate schema and a Markdown link to `network-scopes.md`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
bun test src/network/authz/validate_test.ts src/config/load_integration_test.ts
```

Expected: all tests pass, including legacy identifier detection and pre-Pkl load diagnostics.

- [ ] **Step 6: Run standard post-change checks**

Run in order:

```bash
bun run fmt
bun run lint
bun run check
bun test
git diff --check
```

Expected: all commands exit 0; the test summary reports 0 failures.

- [ ] **Step 7: Commit only the migration guidance fix**

Stage exactly:

```bash
git add docs/migration/network-scopes.md docs/migration/network-review-rules.md src/network/authz/validate.ts src/network/authz/validate_test.ts
```

Commit as:

```text
fix(config): link legacy errors to public migration guidance

Installed binaries cannot rely on an internal design-spec path, and the old
migration document leads through a configuration model that has since been
removed. Give every legacy identifier one stable, current guide that remains
actionable outside a source checkout.
```
