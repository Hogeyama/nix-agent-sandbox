import { containsIdentifier, maskNonCode } from "../lib/pkl_source.ts";

export const NIX_EXTRA_PACKAGES_MIGRATION =
  "nix.extraPackages is no longer supported. Define packages in .envrc or " +
  "a devShell, and run direnv allow on the host.";

export const CLOUD_CONFIG_MOUNT_MIGRATION =
  "gcloud.mountConfig and aws.mountConfig are no longer supported. They bound " +
  "the whole credential directory read-write, so the agent could read every " +
  "profile it held and rewrite the host's configuration. Inject the credential " +
  "where it is used instead — secrets plus a network scope for API calls, or a " +
  "hostexec rule for the CLI — or bind the one path you need through " +
  'extraMounts with mode = "ro".';

export const GPG_FORWARD_AGENT_MIGRATION =
  "gpg.forwardAgent is no longer supported. Forwarding the agent socket let " +
  "the agent sign and decrypt with every key the host holds, with no prompt " +
  "per use. Delegate the operation itself with a hostexec rule whose match " +
  'pins argv0 = "gpg" and the argument shape you want to allow.';

/** 廃止した識別子と、その移行案内。 */
const RETIRED_IDENTIFIERS: readonly (readonly [string, string])[] = [
  ["extraPackages", NIX_EXTRA_PACKAGES_MIGRATION],
  ["mountConfig", CLOUD_CONFIG_MOUNT_MIGRATION],
  ["forwardAgent", GPG_FORWARD_AGENT_MIGRATION],
];

export function retiredSourceErrors(
  source: string,
  fileName: string,
): string[] {
  return maskNonCode(source)
    .split("\n")
    .flatMap((line, index) =>
      RETIRED_IDENTIFIERS.filter(([identifier]) =>
        containsIdentifier(line, identifier),
      ).map(([, migration]) => `${fileName}:${index + 1}: ${migration}`),
    );
}

/**
 * 廃止した設定を持つプロファイルのセクションと、その既定値の綴り。
 *
 * `isInert` が真を返す値だけを落とす。既定値のまま書かれた設定は、消しても
 * 挙動が変わらないので移行を止める理由がない。真に有効化していた設定は、
 * 黙って無効化すると「移行したのに動く」という誤解を生むため落とさない。
 */
const RETIRED_SECTIONS: readonly {
  readonly section: string;
  readonly keys: readonly string[];
  readonly isInert: (value: unknown) => boolean;
  readonly migration: string;
}[] = [
  {
    section: "nix",
    keys: ["extraPackages", "extra-packages"],
    isInert: (value) => Array.isArray(value) && value.length === 0,
    migration: NIX_EXTRA_PACKAGES_MIGRATION,
  },
  {
    section: "gcloud",
    keys: ["mountConfig", "mount-config"],
    isInert: (value) => value === false,
    migration: CLOUD_CONFIG_MOUNT_MIGRATION,
  },
  {
    section: "aws",
    keys: ["mountConfig", "mount-config"],
    isInert: (value) => value === false,
    migration: CLOUD_CONFIG_MOUNT_MIGRATION,
  },
  {
    section: "gpg",
    keys: ["forwardAgent", "forward-agent"],
    isInert: (value) => value === false,
    migration: GPG_FORWARD_AGENT_MIGRATION,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * hostexec ルールの `fallback` を落とす。
 *
 * このフィールドはどの値でも挙動を変えなかった（不一致の要求は常にコンテナ
 * 実行へのフォールバック応答になる）。値にかかわらず落としても挙動は同じなので、
 * 他の廃止設定のように移行を止めない。残すと Schema に無いプロパティになり、
 * 生成した Pkl が評価できない。
 */
function dropHostExecRuleFallback(
  profile: Record<string, unknown>,
): Record<string, unknown> {
  const hostexec = profile.hostexec;
  if (!isRecord(hostexec) || !Array.isArray(hostexec.rules)) return profile;
  if (!hostexec.rules.some((rule) => isRecord(rule) && "fallback" in rule)) {
    return profile;
  }
  const rules = hostexec.rules.map((rule) => {
    if (!isRecord(rule) || !("fallback" in rule)) return rule;
    const { fallback: _dropped, ...rest } = rule;
    return rest;
  });
  return { ...profile, hostexec: { ...hostexec, rules } };
}

/**
 * 旧 YAML/Nix 設定から、廃止した設定を落とす。
 *
 * 空になったセクションはセクションごと落とす。`gcloud`/`aws`/`gpg` は
 * 廃止した設定しか持たないため、殻だけ残すと Schema に無いクラスを参照する
 * Pkl ができあがる。
 */
export function normalizeRetiredSettings(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  if (!isRecord(raw.profiles)) return raw;
  const profiles = Object.fromEntries(
    Object.entries(raw.profiles).map(([name, profile]) => {
      if (!isRecord(profile)) return [name, profile];
      let next = profile;
      for (const { section, keys, isInert, migration } of RETIRED_SECTIONS) {
        const current = next[section];
        if (!isRecord(current)) continue;
        const stripped = { ...current };
        for (const key of keys) {
          if (!(key in stripped)) continue;
          if (!isInert(stripped[key])) {
            throw new Error(`profile "${name}": ${migration}`);
          }
          delete stripped[key];
        }
        if (Object.keys(stripped).length === 0) {
          next = { ...next };
          delete next[section];
        } else {
          next = { ...next, [section]: stripped };
        }
      }
      return [name, dropHostExecRuleFallback(next)];
    }),
  );
  return { ...raw, profiles };
}
