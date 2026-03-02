/** エージェント種別 */
export type AgentType = "claude" | "copilot";

/** Worktree 設定 */
export interface WorktreeConfig {
  base: string;
  onCreate: string;
  onEnd: string;
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

/** プロファイル */
export interface Profile {
  agent: AgentType;
  worktree?: WorktreeConfig;
  nix: NixConfig;
  docker: DockerConfig;
  env: Record<string, string>;
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
  worktree?: {
    base?: string;
    "on-create"?: string;
    "on-end"?: string;
  };
  nix?: {
    enable?: boolean | "auto";
    "mount-socket"?: boolean;
    "extra-packages"?: string[];
  };
  docker?: {
    "mount-socket"?: boolean;
  };
  env?: Record<string, string>;
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
