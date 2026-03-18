import { assertEquals } from "@std/assert";
import * as path from "@std/path";
import type { Config, Profile } from "../src/config/types.ts";
import { createContext } from "../src/pipeline/context.ts";
import { HostExecStage } from "../src/stages/hostexec.ts";

function makeProfile(): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    network: {
      allowlist: [],
      prompt: {
        enable: false,
        timeoutSeconds: 300,
        defaultScope: "host-port",
        notify: "off",
      },
    },
    dbus: {
      session: {
        enable: false,
        see: [],
        talk: [],
        own: [],
        calls: [],
        broadcasts: [],
      },
    },
    extraMounts: [],
    env: [],
    hostexec: {
      prompt: {
        enable: true,
        timeoutSeconds: 300,
        defaultScope: "capability",
        notify: "off",
      },
      subcommand: {
        prefixOptionsWithValue: {},
      },
      secrets: {
        token: { from: "env:TOKEN", required: false },
      },
      rules: [{
        id: "git-readonly",
        match: { argv0: "git", subcommands: ["pull"] },
        cwd: { mode: "workspace-or-session-tmp", allow: [] },
        env: { GITHUB_TOKEN: "secret:token" },
        inheritEnv: { mode: "minimal", keys: [] },
        approval: "prompt",
        fallback: "container",
      }],
    },
  };
}

Deno.test("HostExecStage: injects wrapper path and socket mounts", async () => {
  const runtimeRoot = path.join(
    "/tmp",
    `nas-he-${crypto.randomUUID().slice(0, 8)}`,
  );
  await Deno.mkdir(runtimeRoot, { recursive: true });
  const originalRuntimeDir = Deno.env.get("XDG_RUNTIME_DIR");
  Deno.env.set("XDG_RUNTIME_DIR", runtimeRoot);
  const profile = makeProfile();
  const config: Config = { profiles: { default: profile } };
  const ctx = createContext(config, profile, "default", Deno.cwd());
  const stage = new HostExecStage();
  const result = await stage.execute(ctx);
  try {
    assertEquals(result.hostexecBrokerSocket !== undefined, true);
    assertEquals(result.hostexecRuntimeDir !== undefined, true);
    assertEquals(result.hostexecSessionTmpDir?.includes(ctx.sessionId), true);
    assertEquals(
      result.envVars["NAS_HOSTEXEC_SOCKET"],
      result.hostexecBrokerSocket,
    );
    assertEquals(
      result.envVars["PATH"].startsWith("/opt/nas/hostexec/bin:"),
      true,
    );
    assertEquals(
      result.dockerArgs.some((arg) => arg.includes("/opt/nas/hostexec/bin")),
      true,
    );
    const wrapperMount = result.dockerArgs.find((arg) =>
      arg.includes("/opt/nas/hostexec/bin")
    );
    if (!wrapperMount) {
      throw new Error("wrapper mount not found");
    }
    const hostWrapperBin = wrapperMount.split(":")[0];
    const gitLink = await Deno.readLink(path.join(hostWrapperBin, "git"));
    assertEquals(gitLink, "hostexec-wrapper.py");
    const wrapperScript = await Deno.readTextFile(
      path.join(hostWrapperBin, "hostexec-wrapper.py"),
    );
    assertEquals(
      wrapperScript.includes("select.select([fd], [], [], 0)"),
      true,
    );
    assertEquals(wrapperScript.includes("sys.stdin.buffer.read()"), false);
  } finally {
    await stage.teardown(result);
    if (originalRuntimeDir !== undefined) {
      Deno.env.set("XDG_RUNTIME_DIR", originalRuntimeDir);
    } else {
      Deno.env.delete("XDG_RUNTIME_DIR");
    }
    await Deno.remove(runtimeRoot, { recursive: true }).catch(() => {});
  }
});
