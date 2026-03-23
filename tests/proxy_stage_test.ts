/**
 * ProxyStage unit テスト（Docker 不要）
 *
 * skip 判定, replaceNetwork, parseDindContainerName を検証する。
 * Envoy コンテナ起動の integration テストは proxy_stage_integration_test.ts を参照。
 */

import { assertEquals } from "@std/assert";
import {
  parseDindContainerName,
  ProxyStage,
  replaceNetwork,
} from "../src/stages/proxy.ts";
import { DEFAULT_DBUS_CONFIG } from "../src/config/types.ts";
import { createContext } from "../src/pipeline/context.ts";
import type { Config, Profile } from "../src/config/types.ts";
import type { ExecutionContext } from "../src/pipeline/context.ts";

const DEFAULT_PROMPT = {
  enable: false,
  denylist: [] as string[],
  timeoutSeconds: 300,
  defaultScope: "host-port" as const,
  notify: "auto" as const,
};

function makeProfile(
  overrides: Partial<Omit<Profile, "network">> & {
    network?: Partial<Profile["network"]> & {
      prompt?: Partial<Profile["network"]["prompt"]>;
    };
  } = {},
): Profile {
  const networkOverrides = overrides.network ?? {};
  const { network: _ignored, ...rest } = overrides;
  const network: Profile["network"] = {
    allowlist: networkOverrides.allowlist
      ? [...networkOverrides.allowlist]
      : [],
    prompt: {
      ...DEFAULT_PROMPT,
      ...(networkOverrides.prompt ?? {}),
    },
  };
  return {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    network,
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    extraMounts: [],
    env: [],
    ...rest,
  };
}

function makeConfig(profile: Profile): Config {
  return { profiles: { default: profile } };
}

function makeCtx(profile: Profile): ExecutionContext {
  return createContext(makeConfig(profile), profile, "default", "/tmp");
}

Deno.test("ProxyStage: skip when allowlist and prompt are disabled", async () => {
  const profile = makeProfile();
  const ctx = makeCtx(profile);
  const stage = new ProxyStage();
  const result = await stage.execute(ctx);
  assertEquals(result, ctx);
});

Deno.test("replaceNetwork: replaces existing --network", () => {
  const args = ["--rm", "--network", "old-net", "-v", "/tmp:/tmp"];
  const result = replaceNetwork(args, "new-net");
  assertEquals(result, ["--rm", "--network", "new-net", "-v", "/tmp:/tmp"]);
});

Deno.test("replaceNetwork: appends when no --network", () => {
  const args = ["--rm", "-v", "/tmp:/tmp"];
  const result = replaceNetwork(args, "new-net");
  assertEquals(result, ["--rm", "-v", "/tmp:/tmp", "--network", "new-net"]);
});

Deno.test("parseDindContainerName: extracts from DOCKER_HOST", () => {
  const name = parseDindContainerName({
    DOCKER_HOST: "tcp://nas-dind-abc12345:2375",
  });
  assertEquals(name, "nas-dind-abc12345");
});

Deno.test("parseDindContainerName: prefers explicit env var", () => {
  const name = parseDindContainerName({
    NAS_DIND_CONTAINER_NAME: "nas-dind-explicit",
    DOCKER_HOST: "tcp://nas-dind-abc12345:2375",
  });
  assertEquals(name, "nas-dind-explicit");
});

Deno.test("parseDindContainerName: returns null for invalid format", () => {
  const name = parseDindContainerName({
    DOCKER_HOST: "unix:///var/run/docker.sock",
  });
  assertEquals(name, null);
});
