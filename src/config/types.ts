/** エージェント種別 */
export type AgentType = "claude" | "copilot";

/** Worktree クリーンアップ戦略 */
export type WorktreeCleanup = "force" | "auto" | "keep";

/** Worktree 設定 */
export interface WorktreeConfig {
  base: string;
  onCreate: string;
  cleanup: WorktreeCleanup;
}

/** Nix 設定 */
export interface NixConfig {
  enable: boolean | "auto";
  mountSocket: boolean;
  extraPackages: string[];
}

/** Docker 設定 */
export interface DockerConfig {
  mountSocket: boolean;
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

/** 固定値の環境変数エントリ */
export interface StaticEnvConfig {
  key: string;
  val: string;
}

/** コマンド出力の環境変数エントリ */
export interface CommandEnvConfig {
  keyCmd: string;
  valCmd: string;
}

export type EnvConfig = StaticEnvConfig | CommandEnvConfig;

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
    cleanup?: string;
  };
  nix?: {
    enable?: boolean | "auto";
    "mount-socket"?: boolean;
    "extra-packages"?: string[];
  };
  docker?: {
    "mount-socket"?: boolean;
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
  mountSocket: false,
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
