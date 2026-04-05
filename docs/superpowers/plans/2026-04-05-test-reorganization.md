# Test Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all unit and integration tests from `tests/` to co-located files next to their source code, leaving only E2E tests in `tests/`.

**Architecture:** Each test file in `tests/` is moved to sit next to its source module in `src/`. Unit tests become `*_test.ts`, integration tests become `*_integration_test.ts`. Imports are rewritten from `../src/foo/bar.ts` to relative paths from the new location. Multi-file merges concatenate test bodies into a single destination file.

**Tech Stack:** Deno, TypeScript

**Spec:** `docs/superpowers/specs/2026-04-05-test-reorganization-design.md`

---

## Import Rewriting Rules

Every moved test file needs its imports updated. The rules are:

1. **Bare specifiers** (`@std/assert`, `@std/path`, etc.) — keep as-is
2. **Self-imports** (the module under test) — rewrite from `../src/<path>` to relative path from destination. E.g., `../src/stages/dind.ts` → `./dind.ts` when destination is `src/stages/`
3. **Cross-module imports** — resolve relative to destination directory. E.g., `../src/config/types.ts` from `tests/` → `../config/types.ts` when destination is `src/stages/`

**General formula:** strip `../src/` prefix, then compute relative path from destination directory to target.

---

## Task 1: Unit Tests — Group 1 (stages: nix_detect, launch, dind)

**Files:**
- Move: `tests/nix_detect_stage_test.ts` → `src/stages/nix_detect_test.ts`
- Move: `tests/launch_stage_test.ts` → `src/stages/launch_test.ts`
- Move: `tests/dind_stage_test.ts` → `src/stages/dind_test.ts`

**Import rewriting** (same for all three — destination is `src/stages/`):
- `../src/stages/X.ts` → `./X.ts`
- `../src/config/types.ts` → `../config/types.ts`
- `../src/pipeline/types.ts` → `../pipeline/types.ts`

- [ ] **Step 1: Copy `tests/nix_detect_stage_test.ts` to `src/stages/nix_detect_test.ts`** with rewritten imports
- [ ] **Step 2: Copy `tests/launch_stage_test.ts` to `src/stages/launch_test.ts`** with rewritten imports
- [ ] **Step 3: Copy `tests/dind_stage_test.ts` to `src/stages/dind_test.ts`** with rewritten imports
- [ ] **Step 4: Verify all three pass**

Run: `deno test src/stages/nix_detect_test.ts src/stages/launch_test.ts src/stages/dind_test.ts`
Expected: all tests pass (7 + 4 + 7 = 18 tests), no `--allow-all` needed

- [ ] **Step 5: Delete originals**

```bash
rm tests/nix_detect_stage_test.ts tests/launch_stage_test.ts tests/dind_stage_test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/stages/nix_detect_test.ts src/stages/launch_test.ts src/stages/dind_test.ts
git add tests/nix_detect_stage_test.ts tests/launch_stage_test.ts tests/dind_stage_test.ts
git commit -m "refactor(test): move nix_detect, launch, dind unit tests to src/stages/"
```

---

## Task 2: Unit Tests — Group 2 (stages: proxy, hostexec)

**Files:**
- Move: `tests/proxy_stage_test.ts` → `src/stages/proxy_test.ts`
- Move: `tests/hostexec_stage_test.ts` → `src/stages/hostexec_test.ts`

**Import rewriting** (destination is `src/stages/`):
- `../src/stages/X.ts` → `./X.ts`
- `../src/config/types.ts` → `../config/types.ts`
- `../src/pipeline/types.ts` → `../pipeline/types.ts`
- `../src/docker/client.ts` → `../docker/client.ts`

- [ ] **Step 1: Copy `tests/proxy_stage_test.ts` to `src/stages/proxy_test.ts`** with rewritten imports
- [ ] **Step 2: Copy `tests/hostexec_stage_test.ts` to `src/stages/hostexec_test.ts`** with rewritten imports
- [ ] **Step 3: Verify both pass**

Run: `deno test src/stages/proxy_test.ts src/stages/hostexec_test.ts`
Expected: all tests pass (16 + 7 = 23 tests)

- [ ] **Step 4: Delete originals and commit**

```bash
rm tests/proxy_stage_test.ts tests/hostexec_stage_test.ts
git add -A src/stages/proxy_test.ts src/stages/hostexec_test.ts tests/proxy_stage_test.ts tests/hostexec_stage_test.ts
git commit -m "refactor(test): move proxy, hostexec unit tests to src/stages/"
```

---

## Task 3: Unit Tests — Group 3 (independent: hostexec/match, config/load, lib/ttl_lru_cache)

**Files:**
- Move: `tests/hostexec_match_test.ts` → `src/hostexec/match_test.ts`
- Move: `tests/merge_test.ts` → `src/config/load_test.ts`
- Move: `tests/ttl_lru_cache_test.ts` → `src/lib/ttl_lru_cache_test.ts`

**Import rewriting:**
- `hostexec_match_test.ts` (dest `src/hostexec/`): `../src/hostexec/match.ts` → `./match.ts`
- `merge_test.ts` (dest `src/config/`): `../src/config/load.ts` → `./load.ts`, `../src/config/types.ts` → `./types.ts`
- `ttl_lru_cache_test.ts` (dest `src/lib/`): `../src/lib/ttl_lru_cache.ts` → `./ttl_lru_cache.ts`

- [ ] **Step 1: Copy all three files** with rewritten imports
- [ ] **Step 2: Verify all three pass**

Run: `deno test src/hostexec/match_test.ts src/config/load_test.ts src/lib/ttl_lru_cache_test.ts`
Expected: all pass (14 + 25 + 11 = 50 tests)

- [ ] **Step 3: Delete originals and commit**

```bash
rm tests/hostexec_match_test.ts tests/merge_test.ts tests/ttl_lru_cache_test.ts
git add -A src/hostexec/match_test.ts src/config/load_test.ts src/lib/ttl_lru_cache_test.ts tests/hostexec_match_test.ts tests/merge_test.ts tests/ttl_lru_cache_test.ts
git commit -m "refactor(test): move hostexec/match, config/load, lib/ttl_lru_cache unit tests"
```

---

## Task 4: Unit Tests — Group 4 (3→1 merge: config/validate)

**Files:**
- Move+merge: `tests/hostexec_config_test.ts` + `tests/validate_test.ts` + `tests/config_test.ts` → `src/config/validate_test.ts`

This is a **3-file merge**. The agent must:
1. Read all three source files completely
2. Collect all unique imports (deduplicate)
3. Check for naming conflicts in helper functions/constants across files
4. Concatenate all `Deno.test()` blocks into a single file
5. Rewrite imports: `../src/config/X.ts` → `./X.ts`, `../src/config/schema.ts` → `./schema.ts`

- [ ] **Step 1: Read all three test files and identify imports, helpers, and potential conflicts**
- [ ] **Step 2: Create `src/config/validate_test.ts`** with merged content, deduplicated imports, rewritten paths
- [ ] **Step 3: Verify it passes**

Run: `deno test src/config/validate_test.ts`
Expected: all pass (16 + 53 + 59 = 128 tests)

- [ ] **Step 4: Delete originals and commit**

```bash
rm tests/hostexec_config_test.ts tests/validate_test.ts tests/config_test.ts
git add -A src/config/validate_test.ts tests/hostexec_config_test.ts tests/validate_test.ts tests/config_test.ts
git commit -m "refactor(test): merge hostexec_config, validate, config tests into src/config/validate_test.ts"
```

---

## Task 5: Unit Tests — Group 5 (2→1 merge: cli)

**Files:**
- Move+merge: `tests/cli_worktree_override_test.ts` + `tests/cli_parse_test.ts` → `src/cli_test.ts`

Same merge process as Task 4. Destination is `src/` (top level).
- `../src/cli.ts` → `./cli.ts`
- `../src/config/types.ts` → `./config/types.ts`

- [ ] **Step 1: Read both test files and identify imports, helpers, conflicts**
- [ ] **Step 2: Create `src/cli_test.ts`** with merged content
- [ ] **Step 3: Verify it passes**

Run: `deno test src/cli_test.ts`
Expected: all pass (10 + 22 = 32 tests)

- [ ] **Step 4: Delete originals and commit**

```bash
rm tests/cli_worktree_override_test.ts tests/cli_parse_test.ts
git add -A src/cli_test.ts tests/cli_worktree_override_test.ts tests/cli_parse_test.ts
git commit -m "refactor(test): merge cli_worktree_override, cli_parse tests into src/cli_test.ts"
```

---

## Task 6: Unit Tests — Group 6 (independent: network/protocol, pipeline/types, pipeline/pipeline, container_clean)

**Files:**
- Move: `tests/network_protocol_test.ts` → `src/network/protocol_test.ts`
- Move: `tests/pipeline_types_test.ts` → `src/pipeline/types_test.ts`
- Move: `tests/pipeline_v2_test.ts` → `src/pipeline/pipeline_test.ts`
- Move: `tests/container_clean_test.ts` → `src/container_clean_test.ts`

**Import rewriting per file:**
- `network_protocol_test.ts` (dest `src/network/`): `../src/network/protocol.ts` → `./protocol.ts`
- `pipeline_types_test.ts` (dest `src/pipeline/`): `../src/pipeline/types.ts` → `./types.ts`
- `pipeline_v2_test.ts` (dest `src/pipeline/`): `../src/pipeline/pipeline.ts` → `./pipeline.ts`
- `container_clean_test.ts` (dest `src/`): `../src/container_clean.ts` → `./container_clean.ts`

- [ ] **Step 1: Copy all four files** with rewritten imports
- [ ] **Step 2: Verify all four pass**

Run: `deno test src/network/protocol_test.ts src/pipeline/types_test.ts src/pipeline/pipeline_test.ts src/container_clean_test.ts`
Expected: all pass (10 + 15 + 25 + 12 = 62 tests)

- [ ] **Step 3: Delete originals and commit**

```bash
rm tests/network_protocol_test.ts tests/pipeline_types_test.ts tests/pipeline_v2_test.ts tests/container_clean_test.ts
git add -A src/network/protocol_test.ts src/pipeline/types_test.ts src/pipeline/pipeline_test.ts src/container_clean_test.ts tests/network_protocol_test.ts tests/pipeline_types_test.ts tests/pipeline_v2_test.ts tests/container_clean_test.ts
git commit -m "refactor(test): move network/protocol, pipeline/types, pipeline/pipeline, container_clean unit tests"
```

---

## Task 7: Unit Test Checkpoint

- [ ] **Step 1: Run full test suite to verify nothing broke**

Run: `deno test --allow-all src/ tests/`
Expected: 694 passed, 0 failed

- [ ] **Step 2: Run unit tests without permissions**

Run: `deno test src/`
Expected: all unit tests pass (313 tests), integration tests may fail due to missing permissions (this is expected and correct)

---

## Task 8: Integration Tests — Group A (stages + worktree)

**Files (10 files):**
- `tests/dbus_proxy_stage_test.ts` → `src/stages/dbus_proxy_integration_test.ts`
- `tests/mount_stage_test.ts` → `src/stages/mount_integration_test.ts`
- `tests/mount_validation_test.ts` → `src/stages/mount_validation_integration_test.ts`
- `tests/container_integration_test.ts` → `src/stages/launch_integration_test.ts`
- `tests/dind_stage_integration_test.ts` → `src/stages/dind_integration_test.ts`
- `tests/proxy_stage_integration_test.ts` → `src/stages/proxy_integration_test.ts`
- `tests/worktree_lifecycle_test.ts` → `src/stages/worktree_lifecycle_integration_test.ts`
- `tests/worktree_resolve_base_test.ts` → `src/stages/worktree_resolve_base_integration_test.ts`
- `tests/worktree_stage_test.ts` → `src/stages/worktree_stage_integration_test.ts`
- `tests/worktree_teardown_test.ts` → `src/stages/worktree_teardown_integration_test.ts`

**Import rewriting** (destination `src/stages/`):
- `../src/stages/X.ts` → `./X.ts`
- `../src/stages/worktree/X.ts` → `./worktree/X.ts`
- `../src/config/X.ts` → `../config/X.ts`
- `../src/pipeline/X.ts` → `../pipeline/X.ts`
- `../src/docker/X.ts` → `../docker/X.ts`

- [ ] **Step 1: Move all 10 files** with rewritten imports
- [ ] **Step 2: Verify all pass**

Run: `deno test --allow-all src/stages/*_integration_test.ts`
Expected: all pass

- [ ] **Step 3: Delete originals and commit**

```bash
rm tests/dbus_proxy_stage_test.ts tests/mount_stage_test.ts tests/mount_validation_test.ts tests/container_integration_test.ts tests/dind_stage_integration_test.ts tests/proxy_stage_integration_test.ts tests/worktree_lifecycle_test.ts tests/worktree_resolve_base_test.ts tests/worktree_stage_test.ts tests/worktree_teardown_test.ts
git add -A src/stages/*_integration_test.ts tests/dbus_proxy_stage_test.ts tests/mount_stage_test.ts tests/mount_validation_test.ts tests/container_integration_test.ts tests/dind_stage_integration_test.ts tests/proxy_stage_integration_test.ts tests/worktree_lifecycle_test.ts tests/worktree_resolve_base_test.ts tests/worktree_stage_test.ts tests/worktree_teardown_test.ts
git commit -m "refactor(test): move stage/worktree integration tests to src/stages/"
```

---

## Task 9: Integration Tests — Group B (config, hostexec, lib, audit)

**Files (8 files):**
- `tests/agents_test.ts` → `src/agents/agents_integration_test.ts`
- `tests/audit_store_test.ts` → `src/audit/store_integration_test.ts`
- `tests/config_loading_test.ts` → `src/config/load_integration_test.ts`
- `tests/nix_super_test.ts` → `src/config/nix_super_integration_test.ts`
- `tests/hostexec_broker_test.ts` → `src/hostexec/broker_integration_test.ts`
- `tests/hostexec_notify_test.ts` → `src/hostexec/notify_integration_test.ts`
- `tests/secret_store_test.ts` → `src/hostexec/secret_store_integration_test.ts`
- `tests/notify_utils_test.ts` → `src/lib/notify_utils_integration_test.ts`

**Import rewriting:** each file rewrites `../src/<dir>/X.ts` to `./<sibling>.ts` or `../<other_dir>/X.ts` as appropriate for its destination directory.

- [ ] **Step 1: Move all 8 files** with rewritten imports
- [ ] **Step 2: Verify all pass**

Run: `deno test --allow-all src/agents/agents_integration_test.ts src/audit/store_integration_test.ts src/config/load_integration_test.ts src/config/nix_super_integration_test.ts src/hostexec/broker_integration_test.ts src/hostexec/notify_integration_test.ts src/hostexec/secret_store_integration_test.ts src/lib/notify_utils_integration_test.ts`
Expected: all pass

- [ ] **Step 3: Delete originals and commit**

```bash
rm tests/agents_test.ts tests/audit_store_test.ts tests/config_loading_test.ts tests/nix_super_test.ts tests/hostexec_broker_test.ts tests/hostexec_notify_test.ts tests/secret_store_test.ts tests/notify_utils_test.ts
git add -A src/agents/agents_integration_test.ts src/audit/store_integration_test.ts src/config/load_integration_test.ts src/config/nix_super_integration_test.ts src/hostexec/broker_integration_test.ts src/hostexec/notify_integration_test.ts src/hostexec/secret_store_integration_test.ts src/lib/notify_utils_integration_test.ts tests/agents_test.ts tests/audit_store_test.ts tests/config_loading_test.ts tests/nix_super_test.ts tests/hostexec_broker_test.ts tests/hostexec_notify_test.ts tests/secret_store_test.ts tests/notify_utils_test.ts
git commit -m "refactor(test): move config/hostexec/lib/audit integration tests to src/"
```

---

## Task 10: Integration Tests — Group C (network, docker)

**Files (9 files):**
- `tests/docker_client_test.ts` → `src/docker/client_unit_integration_test.ts`
- `tests/docker_client_integration_test.ts` → `src/docker/client_integration_test.ts`
- `tests/client_compat_integration_test.ts` → `src/docker/client_compat_integration_test.ts`
- `tests/embed_hash_test.ts` → `src/docker/embed_hash_integration_test.ts`
- `tests/local_proxy_test.ts` → `src/docker/embed/local_proxy_integration_test.ts`
- `tests/network_auth_router_integration_test.ts` → `src/network/envoy_auth_router_integration_test.ts`
- `tests/network_broker_test.ts` → `src/network/broker_integration_test.ts`
- `tests/network_notify_test.ts` → `src/network/notify_integration_test.ts`
- `tests/network_registry_test.ts` → `src/network/registry_integration_test.ts`

**Note:** `tests/docker_client_test.ts` becomes `client_unit_integration_test.ts` (not `client_integration_test.ts`) to avoid collision with the other docker client test.

**Import rewriting:**
- Docker tests (dest `src/docker/`): `../src/docker/X.ts` → `./X.ts`
- Network tests (dest `src/network/`): `../src/network/X.ts` → `./X.ts`
- `local_proxy_test.ts` (dest `src/docker/embed/`): imports from `../src/docker/embed/` → `./`

- [ ] **Step 1: Move all 9 files** with rewritten imports
- [ ] **Step 2: Verify all pass**

Run: `deno test --allow-all src/docker/*_integration_test.ts src/docker/embed/local_proxy_integration_test.ts src/network/*_integration_test.ts`
Expected: all pass

- [ ] **Step 3: Delete originals and commit**

```bash
rm tests/docker_client_test.ts tests/docker_client_integration_test.ts tests/client_compat_integration_test.ts tests/embed_hash_test.ts tests/local_proxy_test.ts tests/network_auth_router_integration_test.ts tests/network_broker_test.ts tests/network_notify_test.ts tests/network_registry_test.ts
git add -A src/docker/*_integration_test.ts src/docker/embed/local_proxy_integration_test.ts src/network/*_integration_test.ts tests/docker_client_test.ts tests/docker_client_integration_test.ts tests/client_compat_integration_test.ts tests/embed_hash_test.ts tests/local_proxy_test.ts tests/network_auth_router_integration_test.ts tests/network_broker_test.ts tests/network_notify_test.ts tests/network_registry_test.ts
git commit -m "refactor(test): move docker/network integration tests to src/"
```

---

## Task 11: Integration Tests — Group D (pipeline, ui)

**Files (3 files):**
- `tests/effects_test.ts` → `src/pipeline/effects_integration_test.ts`
- `tests/host_env_test.ts` → `src/pipeline/host_env_integration_test.ts`
- `tests/ui_api_test.ts` → `src/ui/routes/api_integration_test.ts`

**Import rewriting:**
- Pipeline tests (dest `src/pipeline/`): `../src/pipeline/X.ts` → `./X.ts`
- UI test (dest `src/ui/routes/`): `../src/ui/routes/api.ts` → `./api.ts`

- [ ] **Step 1: Move all 3 files** with rewritten imports
- [ ] **Step 2: Verify all pass**

Run: `deno test --allow-all src/pipeline/effects_integration_test.ts src/pipeline/host_env_integration_test.ts src/ui/routes/api_integration_test.ts`
Expected: all pass

- [ ] **Step 3: Delete originals and commit**

```bash
rm tests/effects_test.ts tests/host_env_test.ts tests/ui_api_test.ts
git add -A src/pipeline/effects_integration_test.ts src/pipeline/host_env_integration_test.ts src/ui/routes/api_integration_test.ts tests/effects_test.ts tests/host_env_test.ts tests/ui_api_test.ts
git commit -m "refactor(test): move pipeline/ui integration tests to src/"
```

---

## Task 12: Update deno.json Test Tasks

**File:** `deno.json`

Update the test tasks to reflect the new layout:

```json
"test": "deno test --allow-all src/ tests/",
"test:unit": "deno test src/",
"test:integration": "deno test --allow-all src/ tests/"
```

Key changes:
- `test` — explicitly scopes to `src/` and `tests/`
- `test:unit` — runs only `src/` without `--allow-all` (integration tests fail from missing permissions)
- `test:integration` — runs both `src/` (for `*_integration_test.ts`) and `tests/` (for E2E)

- [ ] **Step 1: Update `deno.json`**

Change the tasks section:
```
"test": "deno test --allow-all src/ tests/",
"test:unit": "deno test src/",
"test:integration": "deno test --allow-all src/ tests/"
```

- [ ] **Step 2: Commit**

```bash
git add deno.json
git commit -m "chore: update deno.json test tasks for co-located test layout"
```

---

## Task 13: Final Verification

- [ ] **Step 1: Verify `tests/` only contains E2E files**

```bash
ls tests/
```

Expected: only `cli_e2e_integration_test.ts` and `cli_integration_test.ts`

- [ ] **Step 2: Run full test suite**

Run: `deno test --allow-all src/ tests/`
Expected: **694 passed, 0 failed**

- [ ] **Step 3: Type check**

Run: `deno task check`
Expected: no type errors

- [ ] **Step 4: Format**

Run: `deno task fmt`

- [ ] **Step 5: Run unit tests without permissions**

Run: `deno test src/`
Expected: unit `*_test.ts` tests pass; `*_integration_test.ts` may fail (expected)

- [ ] **Step 6: Final commit if formatting changed anything**

```bash
git add -A && git commit -m "chore: fmt after test reorganization"
```
