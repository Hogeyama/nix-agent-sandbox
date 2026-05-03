import type { AgentType } from "../agents/types.ts";
import type { ApprovalScope } from "../network/protocol.ts";

export type { AgentType } from "../agents/types.ts";

/** Worktree 設定 */
export interface WorktreeConfig {
  base: string;
  onCreate: string;
}

/** Nix 設定 */
export interface NixConfig {
  enable: boolean | "auto";
  mountSocket: boolean;
  extraPackages: string[];
}

/** Docker 設定 */
export interface DockerConfig {
  enable: boolean;
  shared: boolean;
}

/** gcloud 設定 */
export interface GcloudConfig {
  mountConfig: boolean;
}

/** AWS 設定 */
export interface AwsConfig {
  mountConfig: boolean;
}

/** GPG 設定 */
export interface GpgConfig {
  forwardAgent: boolean;
}

/** Proxy 設定 */
export interface ProxyConfig {
  forwardPorts: number[];
}

/** Secret 設定 */
export type SecretSource = string;

export interface SecretConfig {
  from: SecretSource;
  required: boolean;
}

/** Session 設定 */
export interface SessionConfig {
  multiplex: boolean;
  detachKey: string;
}

/** Hook 設定 */
export type HookNotify = "auto" | "desktop" | "off";

export interface HookConfig {
  notify: HookNotify;
}

/** HostExec 設定 */
export type HostExecApproval = "allow" | "prompt" | "deny";
export type HostExecFallback = "container" | "deny";
export type HostExecCwdMode =
  | "workspace-only"
  | "workspace-or-session-tmp"
  | "allowlist"
  | "any";
export type HostExecInheritEnvMode = "minimal" | "unsafe-inherit-all";
export type HostExecPromptNotify = "auto" | "desktop" | "off";
export type HostExecPromptScope = "once" | "capability";

export interface HostExecPromptConfig {
  enable: boolean;
  timeoutSeconds: number;
  defaultScope: HostExecPromptScope;
  notify: HostExecPromptNotify;
}

export interface HostExecCwdConfig {
  mode: HostExecCwdMode;
  allow: string[];
}

export interface HostExecInheritEnvConfig {
  mode: HostExecInheritEnvMode;
  keys: string[];
}

export interface HostExecMatchConfig {
  argv0: string;
  argRegex?: string;
}

export interface HostExecRule {
  id: string;
  match: HostExecMatchConfig;
  cwd: HostExecCwdConfig;
  env: Record<string, string>;
  inheritEnv: HostExecInheritEnvConfig;
  approval: HostExecApproval;
  fallback: HostExecFallback;
}

export interface HostExecConfig {
  prompt: HostExecPromptConfig;
  secrets: Record<string, SecretConfig>;
  rules: HostExecRule[];
}

/** ネットワーク設定 */
export type NetworkPromptNotify = "auto" | "desktop" | "off";

export interface NetworkPromptConfig {
  enable: boolean;
  denylist: string[];
  timeoutSeconds: number;
  defaultScope: ApprovalScope;
  notify: NetworkPromptNotify;
}

export interface NetworkConfig {
  allowlist: string[];
  prompt: NetworkPromptConfig;
  proxy: ProxyConfig;
}

/** DBus 設定 */
export interface DbusRuleConfig {
  name: string;
  rule: string;
}

export interface DbusSessionConfig {
  enable: boolean;
  sourceAddress?: string;
  see: string[];
  talk: string[];
  own: string[];
  calls: DbusRuleConfig[];
  broadcasts: DbusRuleConfig[];
}

export interface DbusConfig {
  session: DbusSessionConfig;
}

/** Display 設定 */
export type DisplaySandbox = "none" | "xpra";

export interface DisplayConfig {
  sandbox: DisplaySandbox;
  size: string;
}

/** 追加マウント設定 */
export interface ExtraMountConfig {
  src: string;
  dst: string;
  mode: "ro" | "rw";
}

/** 環境変数のキー指定 */
export type EnvKeySpec = { key: string } | { keyCmd: string };

/** 環境変数の値指定 */
export type EnvValSpec = { val: string } | { valCmd: string };

/** 環境変数の操作モード */
export type EnvMode = "set" | "prefix" | "suffix";

/** 環境変数エントリ (key/key_cmd × val/val_cmd × mode の組み合わせ) */
export type EnvConfig = EnvKeySpec &
  EnvValSpec & {
    mode: EnvMode;
    separator?: string;
  };

/** プロファイル */
export interface Profile {
  agent: AgentType;
  agentArgs: string[];
  worktree?: WorktreeConfig;
  session: SessionConfig;
  nix: NixConfig;
  docker: DockerConfig;
  gcloud: GcloudConfig;
  aws: AwsConfig;
  gpg: GpgConfig;
  network: NetworkConfig;
  dbus: DbusConfig;
  display: DisplayConfig;
  extraMounts: ExtraMountConfig[];
  env: EnvConfig[];
  hook: HookConfig;
  hostexec?: HostExecConfig;
}

/** UI 設定 */
export interface UiConfig {
  enable: boolean;
  port: number;
  idleTimeout: number;
}

/**
 * Observability (OpenTelemetry / OTLP receiver) 設定。
 *
 * Top-level — `ui` と並列。Profile 単位ではなく、`nas` プロセス全体の
 * 観測可能性を制御する flag。Default false。
 */
export interface ObservabilityConfig {
  enable: boolean;
}

/** トップレベル設定 */
export interface Config {
  default?: string;
  ui: UiConfig;
  observability: ObservabilityConfig;
  profiles: Record<string, Profile>;
}

/** YAML ファイルの生データ型 (バリデーション前) */
export interface RawConfig {
  default?: string;
  ui?: {
    enable?: boolean;
    port?: number;
    "idle-timeout"?: number;
  };
  observability?: {
    enable?: boolean;
  };
  profiles?: Record<string, RawProfile>;
}

export interface RawProfile {
  agent?: string;
  "agent-args"?: string[];
  worktree?: {
    base?: string;
    "on-create"?: string;
  };
  session?: {
    multiplex?: boolean;
    "detach-key"?: string;
  };
  nix?: {
    enable?: boolean | "auto";
    "mount-socket"?: boolean;
    "extra-packages"?: string[];
  };
  docker?: {
    enable?: boolean;
    shared?: boolean;
  };
  gcloud?: {
    "mount-config"?: boolean;
  };
  aws?: {
    "mount-config"?: boolean;
  };
  gpg?: {
    "forward-agent"?: boolean;
  };
  network?: {
    allowlist?: string[];
    proxy?: {
      "forward-ports"?: number[];
    };
    prompt?: {
      enable?: boolean;
      denylist?: string[];
      "timeout-seconds"?: number;
      "default-scope"?: ApprovalScope;
      notify?: NetworkPromptNotify;
    };
  };
  display?: {
    sandbox?: string;
    size?: string;
  };
  dbus?: {
    session?: {
      enable?: boolean;
      "source-address"?: string;
      see?: string[];
      talk?: string[];
      own?: string[];
      calls?: Array<{
        name?: string;
        rule?: string;
      }>;
      broadcasts?: Array<{
        name?: string;
        rule?: string;
      }>;
    };
  };
  "extra-mounts"?: Array<{
    src?: string;
    dst?: string;
    mode?: string;
  }>;
  env?: Array<{
    key?: string;
    val?: string;
    key_cmd?: string;
    val_cmd?: string;
    mode?: string;
    separator?: string;
  }>;
  hook?: {
    notify?: HookNotify;
  };
  hostexec?: {
    prompt?: {
      enable?: boolean;
      "timeout-seconds"?: number;
      "default-scope"?: HostExecPromptScope;
      notify?: HostExecPromptNotify;
    };
    secrets?: Record<
      string,
      {
        from?: string;
        required?: boolean;
      }
    >;
    rules?: Array<{
      id?: string;
      match?: {
        argv0?: string;
        "arg-regex"?: string;
      };
      cwd?: {
        mode?: HostExecCwdMode;
        allow?: string[];
      };
      env?: Record<string, string>;
      "inherit-env"?: {
        mode?: HostExecInheritEnvMode;
        keys?: string[];
      };
      approval?: HostExecApproval;
      fallback?: HostExecFallback;
    }>;
  };
}

/** デフォルト値 */
export const DEFAULT_UI_CONFIG: UiConfig = {
  enable: true,
  port: 3939,
  idleTimeout: 300,
};

export const DEFAULT_OBSERVABILITY_CONFIG: ObservabilityConfig = {
  enable: false,
};

export const DEFAULT_NIX_CONFIG: NixConfig = {
  enable: "auto",
  mountSocket: true,
  extraPackages: [],
};

export const DEFAULT_DOCKER_CONFIG: DockerConfig = {
  enable: false,
  shared: false,
};

export const DEFAULT_GCLOUD_CONFIG: GcloudConfig = {
  mountConfig: false,
};

export const DEFAULT_AWS_CONFIG: AwsConfig = {
  mountConfig: false,
};

export const DEFAULT_GPG_CONFIG: GpgConfig = {
  forwardAgent: false,
};

export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  forwardPorts: [],
};

export const DEFAULT_NETWORK_PROMPT_CONFIG: NetworkPromptConfig = {
  enable: false,
  denylist: [],
  timeoutSeconds: 300,
  defaultScope: "host-port",
  notify: "auto",
};

export const DEFAULT_NETWORK_CONFIG: NetworkConfig = {
  allowlist: [],
  prompt: DEFAULT_NETWORK_PROMPT_CONFIG,
  proxy: DEFAULT_PROXY_CONFIG,
};

export const DEFAULT_DBUS_SESSION_CONFIG: DbusSessionConfig = {
  enable: false,
  sourceAddress: undefined,
  see: [],
  talk: [],
  own: [],
  calls: [],
  broadcasts: [],
};

export const DEFAULT_DBUS_CONFIG: DbusConfig = {
  session: DEFAULT_DBUS_SESSION_CONFIG,
};

export const DEFAULT_DISPLAY_CONFIG: DisplayConfig = {
  sandbox: "none",
  size: "1920x1080",
};

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  multiplex: false,
  detachKey: "^\\",
};

export const DEFAULT_HOOK_CONFIG: HookConfig = {
  notify: "auto",
};

export const DEFAULT_HOSTEXEC_PROMPT_CONFIG: HostExecPromptConfig = {
  enable: true,
  timeoutSeconds: 300,
  defaultScope: "capability",
  notify: "auto",
};

export const DEFAULT_HOSTEXEC_CWD_CONFIG: HostExecCwdConfig = {
  mode: "workspace-or-session-tmp",
  allow: [],
};

export const DEFAULT_HOSTEXEC_INHERIT_ENV_CONFIG: HostExecInheritEnvConfig = {
  mode: "minimal",
  keys: [],
};

export const DEFAULT_HOSTEXEC_CONFIG: HostExecConfig = {
  prompt: DEFAULT_HOSTEXEC_PROMPT_CONFIG,
  secrets: {},
  rules: [],
};
