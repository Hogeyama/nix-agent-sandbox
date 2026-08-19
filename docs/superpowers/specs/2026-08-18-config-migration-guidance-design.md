# Config Migration Guidance Design

## Problem

The pre-evaluation legacy-identifier diagnostic currently sends users to an
internal design specification. That document explains design history rather
than providing a stable, task-oriented migration procedure. The existing
`docs/migration/network-review-rules.md` guide also targets an intermediate
configuration model that has itself been removed.

## Design

Create `docs/migration/network-scopes.md` as the canonical migration guide for
the current scope-based network configuration. It will contain a mapping for
every identifier recognized by `detectLegacyIdentifiers`, including
`MaskValueConfig`, and show the current replacement syntax.

Every legacy-identifier diagnostic will link to the same public URL:

`https://github.com/Hogeyama/nix-agent-sandbox/blob/develop/docs/migration/network-scopes.md#legacy-identifier-mapping`

The existing `docs/migration/network-review-rules.md` file will become a short
redirect to the canonical guide so that its obsolete instructions cannot send
users toward another removed configuration model.

## Error Behavior

The diagnostic retains its source file, line number, removed identifier, and
short replacement hint. Only the final guidance reference changes from an
internal design document to the public migration guide.

## Testing

- Assert that every recognized legacy identifier emits the canonical GitHub
  migration URL.
- Assert that legacy diagnostics no longer expose a `docs/superpowers/` path.
- Retain the existing load integration test that proves diagnostics replace
  Pkl's unhelpful unresolved-reference error.

## Why

A single public guide gives users one durable entry point and keeps operational
migration instructions separate from design history. Using the GitHub URL also
makes the diagnostic useful outside a source checkout, including packaged and
compiled installations.

## Why Not

- Reusing `network-review-rules.md` as the canonical filename would preserve a
  misleading name for a migration whose destination is now `network.scopes`.
- Linking each identifier to a different document would make guidance harder
  to keep consistent and would complicate the diagnostic table.
- Linking to a repository-relative path would not be actionable when `nas` is
  installed without the repository documentation.
