/** エージェント種別 */
export type AgentType = "claude" | "copilot" | "codex";

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

/** 環境変数エントリ (key/key_cmd × val/val_cmd の4通り) */
export type EnvConfig = EnvKeySpec & EnvValSpec;

/** プロファイル */
export interface Profile {
  agent: AgentType;
  agentArgs: string[];
  worktree?: WorktreeConfig;
  nix: NixConfig;
  docker: DockerConfig;
  gcloud: GcloudConfig;
  aws: AwsConfig;
  gpg: GpgConfig;
  extraMounts: ExtraMountConfig[];
  env: EnvConfig[];
}

/** トップレベル設定 */
export interface Config {
  default?: string;
  profiles: Record<string, Profile>;
}

/** YAML ファイルの生データ型 (バリデーション前) */
export interface RawConfig {
  default?: string;
  profiles?: Record<string, RawProfile>;
}

export interface RawProfile {
  agent?: string;
  "agent-args"?: string[];
  worktree?: {
    base?: string;
    "on-create"?: string;
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
  }>;
}

/** デフォルト値 */
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
