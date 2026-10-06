import { describe, expect, test } from "bun:test";
import type { ScopeConfig } from "./config.ts";
import { resolveDindAuthzConfig } from "./dind.ts";
import { decide } from "./resolve.ts";

const pull: ScopeConfig = {
  targets: ["registry.example.com:443"],
  rules: {
    pull: {
      match: { methods: ["GET", "HEAD"], paths: ["/v2/**"] },
      onMatch: "allow",
      expect: [{ kind: "emptyBody" }],
    },
  },
};

function resolve(scopes: Record<string, ScopeConfig> = {}) {
  return resolveDindAuthzConfig({ docker: { networkScopes: scopes } });
}

test("DinD has no implicit allowed destinations", () => {
  const document = resolve().document;
  expect(document).not.toBeNull();
  expect(
    decide(
      document!,
      { host: "api.anthropic.com", port: 443 },
      {
        method: "POST",
        path: "/v1/messages",
      },
    ).action,
  ).toBe("deny");
});

test("DinD allows the configured pull but denies push and other hosts", () => {
  const document = resolve({ registry: pull }).document!;
  expect(document).not.toBeNull();
  for (const [host, method, action] of [
    ["registry.example.com", "GET", "allow"],
    ["registry.example.com", "POST", "deny"],
    ["api.anthropic.com", "GET", "deny"],
  ] as const) {
    expect(
      decide(
        document,
        { host: host!, port: 443 },
        {
          method: method!,
          path: "/v2/library/alpine/manifests/latest",
        },
      ).action,
    ).toBe(action);
  }
});

describe("DinD review is a configuration error", () => {
  for (const [field, scope] of Object.entries({
    fallback: { ...pull, fallback: "review" },
    onMatch: {
      ...pull,
      rules: { pull: { ...pull.rules!.pull!, onMatch: "review" } },
    },
    onIndeterminate: {
      ...pull,
      rules: { pull: { ...pull.rules!.pull!, onIndeterminate: "review" } },
    },
    onViolation: {
      ...pull,
      rules: {
        pull: {
          ...pull.rules!.pull!,
          expect: [{ kind: "emptyBody", onViolation: "review" }],
        },
      },
    },
  } satisfies Record<string, ScopeConfig>)) {
    test(field, () => {
      const result = resolve({ registry: scope });
      expect(result.document).toBeNull();
      expect(
        result.diagnostics.some(
          (d) => d.message.includes(field) && d.message.includes("review"),
        ),
      ).toBe(true);
    });
  }
});

test("DinD supports explicit registry secret injection", () => {
  const result = resolveDindAuthzConfig({
    secrets: { registry: { from: "env:REGISTRY_TOKEN" } },
    docker: {
      networkScopes: {
        registry: {
          ...pull,
          secrets: { registry: "inject" },
          inject: [{ name: "Authorization", value: "secret:registry" }],
        },
      },
    },
  });
  expect(result.document).not.toBeNull();
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
});

test("DinD masking errors point to its own scope settings", () => {
  const result = resolveDindAuthzConfig({
    mask: { proxy: false },
    docker: { networkScopes: { registry: pull } },
  });
  expect(result.document).toBeNull();
  expect(result.diagnostics.map((d) => d.message).join("\n")).toContain(
    "docker.networkScopes.<scope>.secrets",
  );
  expect(result.diagnostics.map((d) => d.message).join("\n")).not.toContain(
    "network.defaults.secrets",
  );
  const fixed = resolveDindAuthzConfig({
    mask: { proxy: false },
    docker: {
      networkScopes: { registry: { ...pull, secrets: { "*": "ignore" } } },
    },
  });
  expect(fixed.document).not.toBeNull();
});
