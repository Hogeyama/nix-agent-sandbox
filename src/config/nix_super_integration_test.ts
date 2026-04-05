/**
 * Integration tests: Nix ローカル設定が関数の場合に super でグローバル設定を受け取れる
 *
 * nix コマンドが必要。
 */

import { assertEquals } from "@std/assert";
import * as path from "@std/path";
import { loadConfig } from "./load.ts";

/** 一時ディレクトリにグローバル(YAML) + ローカル(Nix) を配置してテスト */
async function withNixLocalConfig(
  globalYaml: string,
  localNix: string,
  fn: (localDir: string, globalPath: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-nix-super-" });
  const localDir = path.join(tmpDir, "local");
  await Deno.mkdir(localDir, { recursive: true });
  try {
    const globalPath = path.join(tmpDir, "global.yml");
    await Deno.writeTextFile(globalPath, globalYaml);
    await Deno.writeTextFile(
      path.join(localDir, ".agent-sandbox.nix"),
      localNix,
    );
    await fn(localDir, globalPath);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

Deno.test({
  name: "nix super: function local config receives global as super",
  async fn() {
    const globalYaml = `
profiles:
  dev:
    agent: claude
    network:
      allowlist:
        - "api.github.com"
`;
    // Nix 関数: super を受け取って allowlist に追加する
    const localNix = `
super: {
  profiles = super.profiles // {
    dev = super.profiles.dev // {
      network = super.profiles.dev.network // {
        allowlist = super.profiles.dev.network.allowlist ++ ["extra.example.com"];
      };
    };
  };
}
`;
    await withNixLocalConfig(
      globalYaml,
      localNix,
      async (localDir, globalPath) => {
        const config = await loadConfig({
          startDir: localDir,
          globalConfigPath: globalPath,
        });
        assertEquals(config.profiles.dev.agent, "claude");
        assertEquals(config.profiles.dev.network.allowlist, [
          "api.github.com",
          "extra.example.com",
        ]);
      },
    );
  },
});

Deno.test({
  name: "nix super: non-function local config uses normal merge",
  async fn() {
    const globalYaml = `
profiles:
  dev:
    agent: claude
    network:
      allowlist:
        - "api.github.com"
`;
    // 通常の attrset（関数ではない）
    const localNix = `
{
  profiles = {
    dev = {
      network = {
        allowlist = ["only.local.com"];
      };
    };
  };
}
`;
    await withNixLocalConfig(
      globalYaml,
      localNix,
      async (localDir, globalPath) => {
        const config = await loadConfig({
          startDir: localDir,
          globalConfigPath: globalPath,
        });
        // 通常マージ: local の allowlist が global を置き換える
        assertEquals(config.profiles.dev.agent, "claude"); // from global
        assertEquals(config.profiles.dev.network.allowlist, ["only.local.com"]);
      },
    );
  },
});

Deno.test({
  name: "nix super: function can add new profiles while keeping global ones",
  async fn() {
    const globalYaml = `
default: dev
profiles:
  dev:
    agent: claude
`;
    const localNix = `
super: {
  default = super.default;
  profiles = super.profiles // {
    local-only = {
      agent = "copilot";
    };
  };
}
`;
    await withNixLocalConfig(
      globalYaml,
      localNix,
      async (localDir, globalPath) => {
        const config = await loadConfig({
          startDir: localDir,
          globalConfigPath: globalPath,
        });
        assertEquals(config.default, "dev");
        assertEquals(config.profiles.dev.agent, "claude");
        assertEquals(config.profiles["local-only"].agent, "copilot");
      },
    );
  },
});

Deno.test({
  name: "nix super: function with no global config gets empty attrset",
  async fn() {
    const tmpDir = await Deno.makeTempDir({
      prefix: "nas-nix-super-noglobal-",
    });
    try {
      // グローバル設定なし、ローカルのみ関数
      const localNix = `
super: {
  profiles = (super.profiles or {}) // {
    dev = {
      agent = "claude";
    };
  };
}
`;
      await Deno.writeTextFile(
        path.join(tmpDir, ".agent-sandbox.nix"),
        localNix,
      );
      const config = await loadConfig({
        startDir: tmpDir,
        globalConfigPath: null,
      });
      assertEquals(config.profiles.dev.agent, "claude");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "nix super: handles config and temp paths with spaces",
  async fn() {
    const rootDir = await Deno.makeTempDir({ prefix: "nas-nix-super-space-" });
    try {
      const baseDir = path.join(rootDir, "dir with spaces");
      const localDir = path.join(baseDir, "local config");
      const tmpDir = path.join(baseDir, "tmp dir");
      await Deno.mkdir(localDir, { recursive: true });
      await Deno.mkdir(tmpDir, { recursive: true });

      const globalPath = path.join(baseDir, "global config.yml");
      await Deno.writeTextFile(
        globalPath,
        `
profiles:
  dev:
    agent: claude
`,
      );
      await Deno.writeTextFile(
        path.join(localDir, ".agent-sandbox.nix"),
        `
super: {
  profiles = super.profiles // {
    dev = super.profiles.dev // {
      agent-args = ["--from-space-path"];
    };
  };
}
`,
      );

      const previousTmpDir = Deno.env.get("TMPDIR");
      Deno.env.set("TMPDIR", tmpDir);
      try {
        const config = await loadConfig({
          startDir: localDir,
          globalConfigPath: globalPath,
        });
        assertEquals(config.profiles.dev.agent, "claude");
        assertEquals(config.profiles.dev.agentArgs, ["--from-space-path"]);
      } finally {
        if (previousTmpDir !== undefined) {
          Deno.env.set("TMPDIR", previousTmpDir);
        } else {
          Deno.env.delete("TMPDIR");
        }
      }
    } finally {
      await Deno.remove(rootDir, { recursive: true });
    }
  },
});
