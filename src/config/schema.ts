/**
 * Zod schemas for .agent-sandbox.yml validation.
 *
 * Each schema accepts YAML raw structure (kebab-case) and transforms to Parsed types (camelCase).
 */

import { z } from "zod";
import {
  type ApprovalScope,
  normalizeHost,
  parseAllowlistEntry,
} from "../network/protocol.ts";
import type { EnvConfig, EnvMode, HostExecRule, Profile } from "./types.ts";
import {
  DEFAULT_AWS_CONFIG,
  DEFAULT_DBUS_SESSION_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_DOCKER_CONFIG,
  DEFAULT_GCLOUD_CONFIG,
  DEFAULT_GPG_CONFIG,
  DEFAULT_HOSTEXEC_CWD_CONFIG,
  DEFAULT_HOSTEXEC_INHERIT_ENV_CONFIG,
  DEFAULT_HOSTEXEC_PROMPT_CONFIG,
  DEFAULT_NETWORK_PROMPT_CONFIG,
  DEFAULT_NIX_CONFIG,
  DEFAULT_UI_CONFIG,
} from "./types.ts";
import { ConfigValidationError } from "./validate.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zodEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values, {
    errorMap: () => ({ message: `must be one of: ${values.join(", ")}` }),
  });
}

const nonEmptyString = z.string().refine(
  (s) => s.trim() !== "",
  { message: "must be a non-empty string" },
);

function parsePositiveInt(_fieldName: string) {
  return z.number()
    .refine(
      (n) => Number.isInteger(n) && n > 0,
      { message: "must be a positive integer" },
    );
}

// ---------------------------------------------------------------------------
// Host list validation (shared by allowlist / denylist)
// ---------------------------------------------------------------------------

function hostListSchema(fieldPath: string) {
  return z.array(
    z.string({ invalid_type_error: "must be a non-empty string" }),
    { invalid_type_error: `${fieldPath} must be a list` },
  ).default([]).superRefine((arr, ctx) => {
    for (const [i, entry] of arr.entries()) {
      if (typeof entry !== "string" || entry.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i],
          message: "must be a non-empty string",
        });
        continue;
      }
      let parsed: { host: string; port: number | null };
      try {
        parsed = parseAllowlistEntry(entry);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i],
          message: `("${entry}") is not a valid host or host:port entry`,
        });
        continue;
      }
      const domain = parsed.host.startsWith("*.")
        ? parsed.host.slice(2)
        : parsed.host;
      if (domain.includes("*")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i],
          message:
            `("${entry}") contains wildcard "*" in an invalid position; only "*.domain.com" prefix form is allowed`,
        });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Leaf schemas
// ---------------------------------------------------------------------------

export const worktreeSchema = z.object({
  base: z.string().default("origin/main"),
  "on-create": z.string().default(""),
}).transform((r) => ({
  base: r.base,
  onCreate: r["on-create"],
}));

export const nixSchema = z.object({
  enable: z.union([z.boolean(), z.literal("auto")])
    .default(DEFAULT_NIX_CONFIG.enable),
  "mount-socket": z.boolean().default(DEFAULT_NIX_CONFIG.mountSocket),
  "extra-packages": z.array(z.string()).default(
    DEFAULT_NIX_CONFIG.extraPackages,
  ),
}).default({}).transform((r) => ({
  enable: r.enable,
  mountSocket: r["mount-socket"],
  extraPackages: r["extra-packages"],
}));

export const dockerSchema = z.object({
  enable: z.boolean().default(DEFAULT_DOCKER_CONFIG.enable),
  shared: z.boolean().default(DEFAULT_DOCKER_CONFIG.shared),
}).default({});

export const gcloudSchema = z.object({
  "mount-config": z.boolean().default(DEFAULT_GCLOUD_CONFIG.mountConfig),
}).default({}).transform((r) => ({
  mountConfig: r["mount-config"],
}));

export const awsSchema = z.object({
  "mount-config": z.boolean().default(DEFAULT_AWS_CONFIG.mountConfig),
}).default({}).transform((r) => ({
  mountConfig: r["mount-config"],
}));

export const gpgSchema = z.object({
  "forward-agent": z.boolean().default(DEFAULT_GPG_CONFIG.forwardAgent),
}).default({}).transform((r) => ({
  forwardAgent: r["forward-agent"],
}));

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export const displaySchema = z.object({
  enable: z.boolean().default(DEFAULT_DISPLAY_CONFIG.enable),
}).default({});

// ---------------------------------------------------------------------------
// Extra mounts
// ---------------------------------------------------------------------------

const extraMountEntrySchema = z.object(
  {
    src: nonEmptyString,
    dst: nonEmptyString,
    mode: zodEnum(["ro", "rw"] as const).default("ro"),
  },
  { invalid_type_error: "must be an object" },
);

export const extraMountsSchema = z.array(
  extraMountEntrySchema,
  { invalid_type_error: "extra-mounts must be a list" },
).default([]);

// ---------------------------------------------------------------------------
// Env entries
// ---------------------------------------------------------------------------

const envEntrySchema = z.object(
  {
    key: z.string().optional(),
    key_cmd: z.string().optional(),
    val: z.string().optional(),
    val_cmd: z.string().optional(),
    mode: z.enum(["set", "prefix", "suffix"]).optional(),
    separator: z.string().optional(),
  },
  { invalid_type_error: "must be an object" },
).superRefine((entry, ctx) => {
  const hasKey = entry.key !== undefined;
  const hasKeyCmd = entry.key_cmd !== undefined;
  if (hasKey === hasKeyCmd) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must have exactly one of key or key_cmd",
    });
    return;
  }
  if (hasKey) {
    if (typeof entry.key !== "string" || entry.key.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["key"],
        message: "must be a non-empty string",
      });
    }
  } else {
    if (typeof entry.key_cmd !== "string" || entry.key_cmd.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["key_cmd"],
        message: "must be a non-empty string",
      });
    }
  }
  const hasVal = entry.val !== undefined;
  const hasValCmd = entry.val_cmd !== undefined;
  if (hasVal === hasValCmd) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must have exactly one of val or val_cmd",
    });
    return;
  }
  if (hasVal) {
    if (typeof entry.val !== "string") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["val"],
        message: "must be a string",
      });
    }
  } else {
    if (typeof entry.val_cmd !== "string" || entry.val_cmd.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["val_cmd"],
        message: "must be a non-empty string",
      });
    }
  }
  // mode / separator cross-validation
  const mode = entry.mode ?? "set";
  if (mode === "set") {
    if (entry.separator !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["separator"],
        message: 'separator is only allowed when mode is "prefix" or "suffix"',
      });
    }
  } else {
    if (entry.separator === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["separator"],
        message: `separator is required when mode is "${mode}"`,
      });
    }
  }
}).transform((entry) => {
  const keySpec = entry.key !== undefined
    ? { key: entry.key }
    : { keyCmd: entry.key_cmd! };
  const valSpec = entry.val !== undefined
    ? { val: entry.val }
    : { valCmd: entry.val_cmd! };
  const mode = (entry.mode ?? "set") as EnvMode;
  return {
    ...keySpec,
    ...valSpec,
    mode,
    ...(entry.separator !== undefined ? { separator: entry.separator } : {}),
  } as EnvConfig;
});

export const envSchema = z.array(
  envEntrySchema,
  { invalid_type_error: "env must be a list" },
).default([]);

// ---------------------------------------------------------------------------
// DBus
// ---------------------------------------------------------------------------

function dbusNameListSchema(field: string) {
  return z.array(
    nonEmptyString,
    { invalid_type_error: `${field} must be a list` },
  ).default([]);
}

const dbusRuleSchema = z.object(
  {
    name: nonEmptyString,
    rule: nonEmptyString,
  },
  { invalid_type_error: "must be an object" },
);

function dbusRulesSchema(field: string) {
  return z.array(
    dbusRuleSchema,
    { invalid_type_error: `${field} must be a list` },
  ).default([]);
}

export const dbusSessionSchema = z.object({
  enable: z.boolean().default(DEFAULT_DBUS_SESSION_CONFIG.enable),
  "source-address": nonEmptyString.optional(),
  see: dbusNameListSchema("dbus.session.see"),
  talk: dbusNameListSchema("dbus.session.talk"),
  own: dbusNameListSchema("dbus.session.own"),
  calls: dbusRulesSchema("dbus.session.calls"),
  broadcasts: dbusRulesSchema("dbus.session.broadcasts"),
}).default({}).transform((r) => ({
  enable: r.enable,
  sourceAddress: r["source-address"],
  see: r.see,
  talk: r.talk,
  own: r.own,
  calls: r.calls,
  broadcasts: r.broadcasts,
}));

export const dbusSchema = z.object({
  session: dbusSessionSchema,
}).default({});

// ---------------------------------------------------------------------------
// Secret config
// ---------------------------------------------------------------------------

const secretEntrySchema = z.object(
  {
    from: nonEmptyString.refine(
      (v) =>
        v.startsWith("env:") || v.startsWith("file:") ||
        v.startsWith("dotenv:") || v.startsWith("keyring:"),
      { message: "must start with env:, file:, dotenv:, or keyring:" },
    ),
    required: z.boolean().default(true),
  },
  { invalid_type_error: "must be an object" },
);

export const secretsSchema = z.record(
  z.string(),
  secretEntrySchema,
  { invalid_type_error: "hostexec.secrets must be an object" },
).default({});

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export const networkPromptSchema = z.object({
  enable: z.boolean().default(DEFAULT_NETWORK_PROMPT_CONFIG.enable),
  denylist: hostListSchema("network.prompt.denylist"),
  "timeout-seconds": parsePositiveInt("network.prompt.timeout-seconds")
    .default(DEFAULT_NETWORK_PROMPT_CONFIG.timeoutSeconds),
  "default-scope": zodEnum(["once", "host-port", "host"] as const)
    .default(DEFAULT_NETWORK_PROMPT_CONFIG.defaultScope),
  notify: zodEnum(["auto", "desktop", "off"] as const)
    .default(DEFAULT_NETWORK_PROMPT_CONFIG.notify),
}).default({}).transform((r) => ({
  enable: r.enable,
  denylist: r.denylist,
  timeoutSeconds: r["timeout-seconds"],
  defaultScope: r["default-scope"] as ApprovalScope,
  notify: r.notify,
}));

export function networkSchema(_profileName: string) {
  return z.object(
    {
      allowlist: hostListSchema("network.allowlist"),
      prompt: networkPromptSchema,
    },
    { invalid_type_error: "network must be an object" },
  ).default({}).superRefine((val, ctx) => {
    // Skip overlap check if any entries are invalid (empty strings would crash normalizeHost)
    const allEntries = [...val.allowlist, ...val.prompt.denylist];
    if (allEntries.some((e) => typeof e !== "string" || e.trim() === "")) {
      return;
    }
    const normalizeEntry = (e: string) => {
      const parsed = parseAllowlistEntry(e);
      const host = parsed.host.startsWith("*.")
        ? `*.${normalizeHost(parsed.host.slice(2))}`
        : normalizeHost(parsed.host);
      return parsed.port !== null ? `${host}:${parsed.port}` : host;
    };
    const normalizedAllowSet = new Set(val.allowlist.map(normalizeEntry));
    for (const entry of val.prompt.denylist) {
      if (normalizedAllowSet.has(normalizeEntry(entry))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `"${entry}" appears in both network.allowlist and network.prompt.denylist`,
        });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// HostExec
// ---------------------------------------------------------------------------

export const hostexecPromptSchema = z.object({
  enable: z.boolean().default(DEFAULT_HOSTEXEC_PROMPT_CONFIG.enable),
  "timeout-seconds": parsePositiveInt("hostexec.prompt.timeout-seconds")
    .default(DEFAULT_HOSTEXEC_PROMPT_CONFIG.timeoutSeconds),
  "default-scope": zodEnum(["once", "capability"] as const)
    .default(DEFAULT_HOSTEXEC_PROMPT_CONFIG.defaultScope),
  notify: zodEnum(["auto", "desktop", "off"] as const)
    .default(DEFAULT_HOSTEXEC_PROMPT_CONFIG.notify),
}).default({}).transform((r) => ({
  enable: r.enable,
  timeoutSeconds: r["timeout-seconds"],
  defaultScope: r["default-scope"],
  notify: r.notify,
}));

const hostexecCwdSchema = z.object({
  mode: zodEnum(
    [
      "workspace-only",
      "workspace-or-session-tmp",
      "allowlist",
      "any",
    ] as const,
  ).default(DEFAULT_HOSTEXEC_CWD_CONFIG.mode),
  allow: z.array(z.string()).default([]),
}).default({}).superRefine((val, ctx) => {
  if (
    !Array.isArray(val.allow) ||
    val.allow.some((v) => typeof v !== "string" || v.trim() === "")
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allow"],
      message: "must be a list of strings",
    });
    return;
  }
  if (val.mode !== "allowlist" && val.allow.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allow"],
      message: "is only valid with mode=allowlist",
    });
  }
});

const hostexecInheritEnvSchema = z.object({
  mode: zodEnum(["minimal", "unsafe-inherit-all"] as const)
    .default(DEFAULT_HOSTEXEC_INHERIT_ENV_CONFIG.mode),
  keys: z.array(z.string()).default([]),
}).default({}).superRefine((val, ctx) => {
  if (
    !Array.isArray(val.keys) ||
    val.keys.some((v) => typeof v !== "string" || v.trim() === "")
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["keys"],
      message: "must be a list of strings",
    });
  }
});

function hostexecRuleSchema(
  _prefix: string,
  secretNames: Set<string>,
) {
  return z.object(
    {
      id: nonEmptyString,
      match: z.object(
        {
          argv0: nonEmptyString,
          "arg-regex": nonEmptyString.optional(),
        },
        { invalid_type_error: "must be an object" },
      ).superRefine((val, ctx) => {
        if (val["arg-regex"] !== undefined) {
          try {
            new RegExp(val["arg-regex"]);
          } catch {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["arg-regex"],
              message: `is not a valid regular expression: ${val["arg-regex"]}`,
            });
          }
        }
      }),
      cwd: hostexecCwdSchema,
      env: z.record(z.string(), z.string(), {
        invalid_type_error: "must be an object",
      }).default({}).superRefine((val, ctx) => {
        for (const [key, value] of Object.entries(val)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message: `invalid env key name: ${key}`,
            });
            continue;
          }
          if (typeof value !== "string" || value.trim() === "") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message: "must be a non-empty string",
            });
            continue;
          }
          if (!value.startsWith("secret:")) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message: "must use secret:<name> reference",
            });
            continue;
          }
          const secretName = value.slice("secret:".length);
          if (!secretNames.has(secretName)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message: `references unknown secret "${secretName}"`,
            });
          }
        }
      }),
      "inherit-env": hostexecInheritEnvSchema,
      approval: zodEnum(["allow", "prompt", "deny"] as const).default(
        "prompt",
      ),
      fallback: zodEnum(["container", "deny"] as const).default("container"),
    },
    { invalid_type_error: "must be an object" },
  ).transform((r): HostExecRule => ({
    id: r.id,
    match: {
      argv0: r.match.argv0,
      argRegex: r.match["arg-regex"],
    },
    cwd: r.cwd,
    env: r.env,
    inheritEnv: r["inherit-env"],
    approval: r.approval,
    fallback: r.fallback,
  })).refine(
    (rule) =>
      !(rule.fallback === "container" &&
        (rule.match.argv0.startsWith("./") ||
          rule.match.argv0.startsWith("../"))),
    {
      message:
        'relative argv0 (e.g. "./gradlew") cannot use fallback "container" because the original binary is replaced by the wrapper inside the container; use fallback "deny" instead',
      path: ["fallback"],
    },
  ).refine(
    (rule) =>
      !(rule.fallback === "container" && rule.match.argv0.startsWith("/")),
    {
      message:
        'absolute argv0 (e.g. "/usr/bin/git") cannot use fallback "container" because the container binary is replaced by the wrapper; use fallback "deny" instead',
      path: ["fallback"],
    },
  );
}

export function hostexecSchema(_profileName: string) {
  return z.object(
    {
      prompt: hostexecPromptSchema,
      secrets: secretsSchema,
      rules: z.array(z.unknown()).default([]),
    },
    { invalid_type_error: "hostexec must be an object" },
  ).default({}).transform((val) => {
    const secretNames = new Set(Object.keys(val.secrets));
    const rules: HostExecRule[] = [];
    const errors: string[] = [];

    for (const [index, rawEntry] of val.rules.entries()) {
      const prefix = `hostexec.rules[${index}]`;
      const ruleSchema = hostexecRuleSchema(prefix, secretNames);
      const result = ruleSchema.safeParse(rawEntry);
      if (result.success) {
        rules.push(result.data);
      } else {
        errors.push(`${prefix}.${formatZodError(result.error)}`);
      }
    }

    if (errors.length > 0) {
      throw new ConfigValidationError(errors.join("\n  "));
    }

    return {
      prompt: val.prompt,
      secrets: val.secrets,
      rules,
    };
  });
}

// ---------------------------------------------------------------------------
// UI (top-level)
// ---------------------------------------------------------------------------

export const uiSchema = z.object({
  enable: z.boolean().default(DEFAULT_UI_CONFIG.enable),
  port: parsePositiveInt("ui.port").default(DEFAULT_UI_CONFIG.port),
  "idle-timeout": z.number().int().min(0, { message: "must be >= 0" })
    .default(DEFAULT_UI_CONFIG.idleTimeout),
}).default({}).transform((r) => ({
  enable: r.enable,
  port: r.port,
  idleTimeout: r["idle-timeout"],
}));

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

const VALID_AGENTS = ["claude", "copilot", "codex"] as const;

export function profileSchema(profileName: string) {
  return z.object({
    agent: zodEnum(VALID_AGENTS),
    "agent-args": z.array(z.string()).default([]),
    worktree: worktreeSchema.optional(),
    nix: nixSchema,
    docker: dockerSchema,
    gcloud: gcloudSchema,
    aws: awsSchema,
    gpg: gpgSchema,
    display: displaySchema,
    network: networkSchema(profileName),
    dbus: dbusSchema,
    "extra-mounts": extraMountsSchema,
    env: envSchema,
    hostexec: hostexecSchema(profileName),
  }).transform((r) => ({
    agent: r.agent,
    agentArgs: r["agent-args"],
    worktree: r.worktree,
    nix: r.nix,
    docker: r.docker,
    gcloud: r.gcloud,
    aws: r.aws,
    gpg: r.gpg,
    display: r.display,
    network: r.network,
    dbus: r.dbus,
    extraMounts: r["extra-mounts"],
    env: r.env,
    hostexec: r.hostexec,
  } satisfies Profile));
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const path = formatPath(issue.path);
      return path ? `${path} ${issue.message}` : issue.message;
    })
    .join("\n  ");
}

function formatPath(segments: (string | number)[]): string {
  return segments
    .map((seg, i) =>
      typeof seg === "number" ? `[${seg}]` : (i === 0 ? seg : `.${seg}`)
    )
    .join("");
}
