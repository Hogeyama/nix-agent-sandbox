# strait Credential Overwrite Implementation Plan

> **For agentic workers:** Use subagent-driven-development to implement this plan and independently review the complete change.

**Goal:** Make the host choose upstream authentication independently of client-supplied tokens, with no sentinel substitution in request data.

**Architecture:** Keep srt's environment masking with `injectHosts: []`. Add a small library hook at its existing header mutation seam, and implement host-specific credential overwriting in strait's core. Policy still controls transport, alternate authentication channels, repositories, operations, and approvals.

**Tech Stack:** Bun, TypeScript, patched srt 0.0.77, Nix.

## Global Constraints

- Follow the approved spec at `docs/superpowers/specs/2026-10-04-strait-credential-overwrite-design.md`.
- Read `contrib/strait/DESIGN.md`, `contrib/strait/SECURITY.md`, `docs/architecture/threat-model.md`, `skills/security-constraints/SKILL.md`, and `skills/test-policy/SKILL.md` before changing the implementation.
- Secrets remain in the host process. Never put real credentials into policy decisions, review records, or client-facing errors.
- Preserve the one filterRequest boundary, TLS termination, exact host/443 restrictions, and approval isolation. Do not introduce another proxy.
- Override authentication even when the client omits the header. OAuth takes precedence over an API key for Anthropic.
- Missing host credentials never fall back to client credentials. Cookie, URL userinfo, and query access_token remain denied.
- Leave the preexisting untracked root `strait.json` untouched.
- User approved implementation and declined diffity. Use file links and chat for review.

## Task 1: Replace sentinel-based authentication with host-owned headers

This is one coordinated security change: the hook, policy, and disabled substitution must land together.

**Files:**

- Create `contrib/strait/src/core/credentials.ts` and adjacent tests.
- Modify `contrib/strait/src/core/main.ts`, `policy.ts`, affected policy tests, `selfcheck.ts`, and add patch capability tests.
- Modify `contrib/strait/patches/@anthropic-ai%2Fsandbox-runtime@0.0.77.patch`, dependency patch metadata where required, and `flake.nix` build markers.
- Modify `contrib/strait/tests/probe.sh`, `README.md`, `DESIGN.md`, and `SECURITY.md`.

**Interfaces:**

The credentials module owns a host-keyed header map and overwrites a Node outgoing-header object. Policy consumes only availability and header names, never actual credential values. The implementation may choose the exact type names, but the caller must not pass secret-bearing maps to `decide`.

- [ ] Add behavioral coverage before changing the existing behavior. Test fake, foreign, missing, and duplicated client headers; unrelated headers and bodies retain sentinel bytes. Use synthetic secrets throughout.
- [ ] Build the host-owned map: GitHub API Bearer from GH_TOKEN; GitHub git Basic from `x-access-token:GH_TOKEN`; Anthropic OAuth if present, otherwise API key; configured hosts use their header/scheme/env. Remove client Authorization and x-api-key, plus the configured credential header, before installing the selected value.

The central operation is assignment from host state, never string substitution:

```ts
delete headers.authorization;
delete headers["x-api-key"];
if (credential !== undefined) {
  delete headers[credential.header];
  headers[credential.header] = credential.value;
}
```

- [ ] Connect the operation through a narrow srt library hook at `buildCredentialInjector()` in `dist/sandbox/sandbox-manager.js`. Keep this hook out of user-controlled strait.json. Use a local TypeScript extension for the library-only callback if upstream declarations do not expose it. Guard callback failure with a generic error, never include secret-bearing values in diagnostics. The existing TLS path invokes this after policy and hop-by-hop stripping.
- [ ] Register every masked environment credential with `injectHosts: []`. Remove policy's sentinel identity matching and assignment plumbing; retain verification that masking actually occurred and retain hostexec output masking. No body substitution can have eligible pairs.
- [ ] Adjust credential policy to allow overwritable client auth irrespective of its value. Reject alternate auth channels and any supplied auth when the host has no configured credentials. Keep existing repository/method/GraphQL decisions and approval ordering.
- [ ] Make startup and Nix package validation fail if the overwrite hook patch is missing. Apply the patch to the local dependency using the package workflow and update its lock metadata when necessary. Do not change the dependency version.
- [ ] Exercise the actual patched forwarding path with a local upstream and fake credentials. Cover approval/deny, chunked body boundaries, GET bodies, and Connection naming the auth header. Clean up listeners and temporary files on failure. Tests depending on installed srt must explicitly identify that capability; missing the required patch must fail, not skip.

Expected observable contract:

```text
client Authorization: attacker       -> upstream Authorization: Bearer host-secret
client no Authorization               -> upstream Authorization: Bearer host-secret
client X-Echo: fake_value_test         -> upstream X-Echo: fake_value_test
client body: {"token":"fake_value_test"} -> same body bytes upstream
policy deny / unapproved request      -> no upstream request
missing host credential + client auth -> denied
```

- [ ] Update probe expectations from foreign-token rejection to host-owned authentication where configured. Keep negative tests for alternate authentication channels. Document header reflection as a remaining trust condition and remove the unconditional claim that the agent cannot obtain a real token.
- [ ] Run focused strait tests, TypeScript checks, and the Nix build. Inspect the complete diff, commit this cohesive change using git-commit, and write the implementation report with exact commands, outcomes, and remaining limitations.

## Controller verification and independent review

- [ ] Review the full implementation diff using the patched-superpowers code reviewer and rule configuration. Resolve concrete findings and rerun only the covering tests for fixes.
- [ ] Follow post-change-checks: formatting, lint, check, then root `bun run test` followed by `hostexec bun run test`, even if the first fails. Record environment-specific skips and failures.
- [ ] Report the result with file links and evidence. Do not start diffity. Obtain any remaining final review through chat.
