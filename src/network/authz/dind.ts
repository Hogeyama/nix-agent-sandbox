import type { AuthzConfig, ScopeConfig } from "./config.ts";
import { type ResolveOutcome, resolveAuthzConfig } from "./resolve.ts";
import type { Diagnostic } from "./validate.ts";

/** DinD has its own policy: never inherit agent scopes or review decisions. */
export function resolveDindAuthzConfig(
  profile: Pick<AuthzConfig, "secrets" | "mask"> & {
    docker: { networkScopes?: Readonly<Record<string, ScopeConfig>> };
  },
): ResolveOutcome {
  const scopes = profile.docker.networkScopes ?? {};
  const diagnostics: Diagnostic[] = [];
  const rejectReview = (value: unknown, field: string) => {
    if (value === "review") {
      diagnostics.push({
        severity: "error",
        message: `docker.networkScopes.${field}: review is not supported for DinD`,
      });
    }
  };
  for (const [name, scope] of Object.entries(scopes)) {
    rejectReview(scope.fallback, `${name}.fallback`);
    for (const [key, rule] of Object.entries(scope.rules ?? {})) {
      const prefix = `${name}.rules.${key}`;
      rejectReview(rule.onMatch, `${prefix}.onMatch`);
      rejectReview(rule.onIndeterminate, `${prefix}.onIndeterminate`);
      for (const [index, expect] of (rule.expect ?? []).entries()) {
        rejectReview(
          expect.onViolation,
          `${prefix}.expect[${index}].onViolation`,
        );
      }
    }
  }
  const result = resolveAuthzConfig({
    secrets: profile.secrets,
    mask: profile.mask,
    network: { scopes, fallback: "deny" },
  });
  return {
    document: diagnostics.length > 0 ? null : result.document,
    diagnostics: [
      ...diagnostics,
      ...result.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        message: `docker.networkScopes: ${diagnostic.message.replaceAll(
          "network.defaults.secrets",
          "docker.networkScopes.<scope>.secrets",
        )}`,
      })),
    ],
  };
}
