/**
 * Zod schemas for config validation.
 *
 * Each schema accepts camelCase input (matching Pkl eval JSON output)
 * and transforms to Parsed types.
 */

import { z } from "zod";
import { logWarn } from "../log.ts";
import {
  type ApprovalScope,
  normalizeHost,
  parseAllowlistEntry,
} from "../network/protocol.ts";
import type { EnvConfig, EnvMode, HostExecRule } from "./types.ts";
import {
  DEFAULT_AWS_CONFIG,
  DEFAULT_DBUS_SESSION_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_DOCKER_CONFIG,
  DEFAULT_GCLOUD_CONFIG,
  DEFAULT_GPG_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_HOSTEXEC_CWD_CONFIG,
  DEFAULT_HOSTEXEC_INHERIT_ENV_CONFIG,
  DEFAULT_HOSTEXEC_PROMPT_CONFIG,
  DEFAULT_NETWORK_PROMPT_CONFIG,
  DEFAULT_NIX_CONFIG,
  DEFAULT_OBSERVABILITY_CONFIG,
  DEFAULT_PROXY_CONFIG,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_UI_CONFIG,
} from "./types.ts";
import { ConfigValidationError } from "./validate.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zodEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values, {
    error: `must be one of: ${values.join(", ")}`,
  });
}

const nonEmptyString = z
  .string()
  .refine((s) => s.trim() !== "", { message: "must be a non-empty string" });

function parsePositiveInt(_fieldName: string) {
  return z.number().refine((n) => Number.isInteger(n) && n > 0, {
    message: "must be a positive integer",
  });
}

// ---------------------------------------------------------------------------
// Host list validation (shared by allowlist / denylist)
// ---------------------------------------------------------------------------

function hostListSchema(fieldPath: string) {
  return z
    .array(z.string({ error: "must be a non-empty string" }), {
      error: `${fieldPath} must be a list`,
    })
    .default([])
    .superRefine((arr, ctx) => {
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
            message: `("${entry}") contains wildcard "*" in an invalid position; only "*.domain.com" prefix form is allowed`,
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
  onCreate: z.string().default(""),
});

export const sessionSchema = z
  .object({
    multiplex: z.boolean().default(DEFAULT_SESSION_CONFIG.multiplex),
    detachKey: z.string().default(DEFAULT_SESSION_CONFIG.detachKey),
  })
  .prefault({});

export const nixSchema = z
  .object({
    enable: z
      .union([z.boolean(), z.literal("auto")])
      .default(DEFAULT_NIX_CONFIG.enable),
    mountSocket: z.boolean().default(DEFAULT_NIX_CONFIG.mountSocket),
    extraPackages: z
      .array(
        z
          .string()
          .refine((s) => !s.startsWith("-"), {
            message: "must not start with '-' (flags are not allowed)",
          })
          .refine((s) => !s.includes(".."), {
            message: "must not contain '..'",
          }),
      )
      .default(DEFAULT_NIX_CONFIG.extraPackages),
  })
  .prefault({});

export const dockerSchema = z
  .object({
    enable: z.boolean().default(DEFAULT_DOCKER_CONFIG.enable),
    shared: z.boolean().default(DEFAULT_DOCKER_CONFIG.shared),
  })
  .prefault({});

export const gcloudSchema = z
  .object({
    mountConfig: z.boolean().default(DEFAULT_GCLOUD_CONFIG.mountConfig),
  })
  .prefault({});

export const awsSchema = z
  .object({
    mountConfig: z.boolean().default(DEFAULT_AWS_CONFIG.mountConfig),
  })
  .prefault({});

export const gpgSchema = z
  .object({
    forwardAgent: z.boolean().default(DEFAULT_GPG_CONFIG.forwardAgent),
  })
  .prefault({});

export const proxySchema = z
  .object({
    forwardPorts: z
      .array(
        z
          .number()
          .int({ message: "must be an integer" })
          .min(1, { message: "must be >= 1" })
          .max(65535, { message: "must be <= 65535" }),
      )
      .default(DEFAULT_PROXY_CONFIG.forwardPorts)
      .superRefine((ports, ctx) => {
        for (const [i, port] of ports.entries()) {
          if (port === 18080) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [i],
              message:
                "port 18080 is reserved for the internal authentication proxy",
            });
          }
        }
        const seen = new Set<number>();
        for (const [i, port] of ports.entries()) {
          if (seen.has(port)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [i],
              message: `duplicate port ${port}`,
            });
          }
          seen.add(port);
        }
      }),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Extra mounts
// ---------------------------------------------------------------------------

const extraMountEntrySchema = z.object(
  {
    src: nonEmptyString,
    dst: nonEmptyString,
    mode: zodEnum(["ro", "rw"] as const).default("ro"),
  },
  { error: "must be an object" },
);

export const extraMountsSchema = z
  .array(extraMountEntrySchema, { error: "extraMounts must be a list" })
  .default([]);

// ---------------------------------------------------------------------------
// Env entries
// ---------------------------------------------------------------------------

const envEntrySchema = z
  .object(
    {
      key: z.string().optional(),
      keyCmd: z.string().optional(),
      key_cmd: z.string().optional(),
      val: z.string().optional(),
      valCmd: z.string().optional(),
      val_cmd: z.string().optional(),
      mode: z.enum(["set", "prefix", "suffix"]).optional(),
      separator: z.string().optional(),
    },
    { error: "must be an object" },
  )
  .superRefine((entry, ctx) => {
    // ---- key / keyCmd / key_cmd exclusivity ----
    const hasKey = entry.key !== undefined;
    const hasKeyCmdCamel = entry.keyCmd !== undefined;
    const hasKeyCmdSnake = entry.key_cmd !== undefined;
    const keySetCount =
      (hasKey ? 1 : 0) + (hasKeyCmdCamel ? 1 : 0) + (hasKeyCmdSnake ? 1 : 0);

    if (keySetCount !== 1) {
      // Preserve the legacy "must have exactly one of key or key_cmd" wording
      // for the existing snake-only / plain-only diagnostics. When the new
      // camelCase form is involved, list only the fields the user actually
      // supplied (or "key" when nothing is set at all) so the message points
      // at the names that collided rather than a generic catch-all.
      let baseMessage: string;
      if (hasKeyCmdCamel) {
        const setFields: string[] = [];
        if (hasKey) setFields.push("key");
        if (hasKeyCmdCamel) setFields.push("keyCmd");
        if (hasKeyCmdSnake) setFields.push("key_cmd");
        baseMessage =
          setFields.length >= 2
            ? `must have exactly one of ${setFields.join(", ")}`
            : "must have exactly one of key, keyCmd, or key_cmd";
      } else {
        baseMessage = "must have exactly one of key or key_cmd";
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: baseMessage,
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
    } else if (hasKeyCmdCamel) {
      if (typeof entry.keyCmd !== "string" || entry.keyCmd.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["keyCmd"],
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

    // ---- val / valCmd / val_cmd exclusivity ----
    const hasVal = entry.val !== undefined;
    const hasValCmdCamel = entry.valCmd !== undefined;
    const hasValCmdSnake = entry.val_cmd !== undefined;
    const valSetCount =
      (hasVal ? 1 : 0) + (hasValCmdCamel ? 1 : 0) + (hasValCmdSnake ? 1 : 0);

    if (valSetCount !== 1) {
      // Mirror the key-side handling: when camelCase is involved, list only
      // the fields that actually collided; otherwise keep the legacy wording
      // expected by existing snake/plain diagnostics.
      let baseMessage: string;
      if (hasValCmdCamel) {
        const setFields: string[] = [];
        if (hasVal) setFields.push("val");
        if (hasValCmdCamel) setFields.push("valCmd");
        if (hasValCmdSnake) setFields.push("val_cmd");
        baseMessage =
          setFields.length >= 2
            ? `must have exactly one of ${setFields.join(", ")}`
            : "must have exactly one of val, valCmd, or val_cmd";
      } else {
        baseMessage = "must have exactly one of val or val_cmd";
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: baseMessage,
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
    } else if (hasValCmdCamel) {
      if (typeof entry.valCmd !== "string" || entry.valCmd.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["valCmd"],
          message: "must be a non-empty string",
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
          message:
            'separator is only allowed when mode is "prefix" or "suffix"',
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
  })
  .transform((entry) => {
    // superRefine above guarantees exactly-one-of and string types,
    // but narrow at runtime so the transform is type-safe on its own.
    // Precedence on the (already-validated) sole set field:
    //   keyCmd (camel) > key_cmd (snake) > key (plain).
    let keySpec: { key: string } | { keyCmd: string };
    if (typeof entry.keyCmd === "string") {
      keySpec = { keyCmd: entry.keyCmd };
    } else if (typeof entry.key_cmd === "string") {
      keySpec = { keyCmd: entry.key_cmd };
    } else if (typeof entry.key === "string") {
      keySpec = { key: entry.key };
    } else {
      throw new Error("env entry: missing key/keyCmd/key_cmd after refine");
    }

    let valSpec: { val: string } | { valCmd: string };
    if (typeof entry.valCmd === "string") {
      valSpec = { valCmd: entry.valCmd };
    } else if (typeof entry.val_cmd === "string") {
      valSpec = { valCmd: entry.val_cmd };
    } else if (typeof entry.val === "string") {
      valSpec = { val: entry.val };
    } else {
      throw new Error("env entry: missing val/valCmd/val_cmd after refine");
    }

    // Emit a deprecation warning for snake_case usage. Each env entry that
    // uses snake_case fields produces exactly one warning per config load.
    if (entry.key_cmd !== undefined || entry.val_cmd !== undefined) {
      const usedSnake: string[] = [];
      if (entry.key_cmd !== undefined) usedSnake.push("key_cmd");
      if (entry.val_cmd !== undefined) usedSnake.push("val_cmd");
      const camelEquivalents = usedSnake.map((s) =>
        s === "key_cmd" ? "keyCmd" : "valCmd",
      );
      logWarn(
        `[deprecation] env entry uses snake_case "${usedSnake.join("/")}"; ` +
          `rename to camelCase "${camelEquivalents.join("/")}" ` +
          "(snake will be removed in a future release)",
      );
    }

    const mode = (entry.mode ?? "set") as EnvMode;
    return {
      ...keySpec,
      ...valSpec,
      mode,
      ...(entry.separator !== undefined ? { separator: entry.separator } : {}),
    } as EnvConfig;
  });

export const envSchema = z
  .array(envEntrySchema, { error: "env must be a list" })
  .default([]);

// ---------------------------------------------------------------------------
// DBus
// ---------------------------------------------------------------------------

function dbusNameListSchema(field: string) {
  return z
    .array(nonEmptyString, { error: `${field} must be a list` })
    .default([]);
}

// D-Bus well-known name: dot-separated identifier (one char plus up to 253
// more, total 254 max per D-Bus spec), with optional trailing '*' wildcard
// commonly used by xdg-dbus-proxy. Must not contain '=', which is the
// delimiter used between name and rule on the xdg-dbus-proxy CLI.
const DBUS_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,253}\*?$/;

const dbusRuleSchema = z.object(
  {
    name: nonEmptyString
      .refine((s) => !s.includes("="), {
        message: "must not contain '='",
      })
      .refine((s) => DBUS_NAME_RE.test(s), {
        message:
          "must be a valid D-Bus well-known name (e.g. org.example.Foo, org.example.*)",
      }),
    rule: nonEmptyString.refine((s) => !s.includes("="), {
      message: "must not contain '='",
    }),
  },
  { error: "must be an object" },
);

function dbusRulesSchema(field: string) {
  return z
    .array(dbusRuleSchema, { error: `${field} must be a list` })
    .default([]);
}

export const dbusSessionSchema = z
  .object({
    enable: z.boolean().default(DEFAULT_DBUS_SESSION_CONFIG.enable),
    sourceAddress: nonEmptyString.optional(),
    see: dbusNameListSchema("dbus.session.see"),
    talk: dbusNameListSchema("dbus.session.talk"),
    own: dbusNameListSchema("dbus.session.own"),
    calls: dbusRulesSchema("dbus.session.calls"),
    broadcasts: dbusRulesSchema("dbus.session.broadcasts"),
  })
  .prefault({});

export const dbusSchema = z
  .object({
    session: dbusSessionSchema,
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Display (xpra sandbox)
// ---------------------------------------------------------------------------

const MAX_DISPLAY_DIMENSION = 16384;

export const displaySchema = z
  .object({
    sandbox: zodEnum(["none", "xpra"] as const).default(
      DEFAULT_DISPLAY_CONFIG.sandbox,
    ),
    size: z
      .string()
      .regex(/^\d+x\d+$/, { message: "must match WIDTHxHEIGHT" })
      .refine(
        (s) => {
          const [w, h] = s.split("x").map((n) => Number.parseInt(n, 10));
          return (
            Number.isFinite(w) &&
            Number.isFinite(h) &&
            w > 0 &&
            h > 0 &&
            w <= MAX_DISPLAY_DIMENSION &&
            h <= MAX_DISPLAY_DIMENSION
          );
        },
        {
          message: `width and height must be in range [1, ${MAX_DISPLAY_DIMENSION}]`,
        },
      )
      .default(DEFAULT_DISPLAY_CONFIG.size),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Secret config
// ---------------------------------------------------------------------------

const secretEntrySchema = z.object(
  {
    from: nonEmptyString.refine(
      (v) =>
        v.startsWith("env:") ||
        v.startsWith("file:") ||
        v.startsWith("dotenv:") ||
        v.startsWith("keyring:"),
      { message: "must start with env:, file:, dotenv:, or keyring:" },
    ),
    required: z.boolean().default(true),
  },
  { error: "must be an object" },
);

export const secretsSchema = z
  .record(z.string(), secretEntrySchema, {
    error: "hostexec.secrets must be an object",
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export const networkPromptSchema = z
  .object({
    enable: z.boolean().default(DEFAULT_NETWORK_PROMPT_CONFIG.enable),
    denylist: hostListSchema("network.prompt.denylist"),
    timeoutSeconds: parsePositiveInt("network.prompt.timeoutSeconds").default(
      DEFAULT_NETWORK_PROMPT_CONFIG.timeoutSeconds,
    ),
    defaultScope: zodEnum(["once", "host-port", "host"] as const).default(
      DEFAULT_NETWORK_PROMPT_CONFIG.defaultScope,
    ),
    notify: zodEnum(["auto", "desktop", "off"] as const).default(
      DEFAULT_NETWORK_PROMPT_CONFIG.notify,
    ),
  })
  .prefault({})
  .transform((r) => ({
    enable: r.enable,
    denylist: r.denylist,
    timeoutSeconds: r.timeoutSeconds,
    defaultScope: r.defaultScope as ApprovalScope,
    notify: r.notify,
  }));

export function networkSchema(_profileName: string) {
  return z
    .object(
      {
        allowlist: hostListSchema("network.allowlist"),
        proxy: proxySchema,
        prompt: networkPromptSchema,
      },
      { error: "network must be an object" },
    )
    .prefault({})
    .superRefine((val, ctx) => {
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
            message: `"${entry}" appears in both network.allowlist and network.prompt.denylist`,
          });
        }
      }
    });
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export const hookSchema = z
  .object({
    notify: zodEnum(["auto", "desktop", "off"] as const).default(
      DEFAULT_HOOK_CONFIG.notify,
    ),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// HostExec
// ---------------------------------------------------------------------------

export const hostexecPromptSchema = z
  .object({
    enable: z.boolean().default(DEFAULT_HOSTEXEC_PROMPT_CONFIG.enable),
    timeoutSeconds: parsePositiveInt("hostexec.prompt.timeoutSeconds").default(
      DEFAULT_HOSTEXEC_PROMPT_CONFIG.timeoutSeconds,
    ),
    defaultScope: zodEnum(["once", "capability"] as const).default(
      DEFAULT_HOSTEXEC_PROMPT_CONFIG.defaultScope,
    ),
    notify: zodEnum(["auto", "desktop", "off"] as const).default(
      DEFAULT_HOSTEXEC_PROMPT_CONFIG.notify,
    ),
  })
  .prefault({});

const hostexecCwdSchema = z
  .object({
    mode: zodEnum([
      "workspace-only",
      "workspace-or-session-tmp",
      "allowlist",
      "any",
    ] as const).default(DEFAULT_HOSTEXEC_CWD_CONFIG.mode),
    allow: z.array(z.string()).default([]),
  })
  .prefault({})
  .superRefine((val, ctx) => {
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

const hostexecInheritEnvSchema = z
  .object({
    mode: zodEnum(["minimal", "unsafe-inherit-all"] as const).default(
      DEFAULT_HOSTEXEC_INHERIT_ENV_CONFIG.mode,
    ),
    keys: z.array(z.string()).default([]),
  })
  .prefault({})
  .superRefine((val, ctx) => {
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

function hostexecRuleSchema(_prefix: string, secretNames: Set<string>) {
  return z.object(
    {
      id: nonEmptyString,
      match: z
        .object(
          {
            argv0: nonEmptyString,
            argRegex: nonEmptyString.optional(),
          },
          { error: "must be an object" },
        )
        .superRefine((val, ctx) => {
          if (val.argRegex !== undefined) {
            try {
              new RegExp(val.argRegex);
            } catch {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["argRegex"],
                message: `is not a valid regular expression: ${val.argRegex}`,
              });
            }
          }
        }),
      cwd: hostexecCwdSchema,
      env: z
        .record(z.string(), z.string(), {
          error: "must be an object",
        })
        .prefault({})
        .superRefine((val, ctx) => {
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
      inheritEnv: hostexecInheritEnvSchema,
      approval: zodEnum(["allow", "prompt", "deny"] as const).default("prompt"),
      fallback: zodEnum(["container", "deny"] as const).default("container"),
    },
    { error: "must be an object" },
  );
}

export function hostexecSchema(_profileName: string) {
  return z
    .object(
      {
        prompt: hostexecPromptSchema,
        secrets: secretsSchema,
        rules: z.array(z.unknown()).default([]),
      },
      { error: "hostexec must be an object" },
    )
    .prefault({})
    .transform((val) => {
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

export const uiSchema = z
  .object({
    enable: z.boolean().default(DEFAULT_UI_CONFIG.enable),
    port: parsePositiveInt("ui.port").default(DEFAULT_UI_CONFIG.port),
    idleTimeout: z
      .number()
      .int()
      .min(0, { message: "must be >= 0" })
      .default(DEFAULT_UI_CONFIG.idleTimeout),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Observability (top-level)
// ---------------------------------------------------------------------------

const retentionSchema = z
  .union([
    z
      .number()
      .int({ message: "must be an integer" })
      .min(3600, { message: "must be at least 1h (3600s)" }),
    z.null(),
  ])
  .default(null);

export const observabilitySchema = z
  .object({
    enable: z.boolean().default(DEFAULT_OBSERVABILITY_CONFIG.enable),
    retention: retentionSchema,
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

const VALID_AGENTS = ["claude", "copilot", "codex"] as const;

export function profileSchema(profileName: string) {
  return z.object({
    agent: zodEnum(VALID_AGENTS),
    agentArgs: z.array(z.string()).default([]),
    worktree: worktreeSchema.optional(),
    session: sessionSchema,
    nix: nixSchema,
    docker: dockerSchema,
    gcloud: gcloudSchema,
    aws: awsSchema,
    gpg: gpgSchema,
    network: networkSchema(profileName),
    dbus: dbusSchema,
    display: displaySchema,
    extraMounts: extraMountsSchema,
    env: envSchema,
    hook: hookSchema,
    hostexec: hostexecSchema(profileName),
  });
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

function formatPath(segments: PropertyKey[]): string {
  return segments
    .map((seg, i) =>
      typeof seg === "number"
        ? `[${seg}]`
        : i === 0
          ? String(seg)
          : `.${String(seg)}`,
    )
    .join("");
}
