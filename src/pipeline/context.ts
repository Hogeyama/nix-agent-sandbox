/**
 * Pipeline / Stage / ExecutionContext
 */

import type { Config, Profile } from "../config/types.ts";

/** パイプライン実行中に各ステージが読み書きするコンテキスト */
export interface ExecutionContext {
  /** 解決済み設定 */
  config: Config;
  /** 選択されたプロファイル */
  profile: Profile;
  /** プロファイル名 */
  profileName: string;
  /** 作業ディレクトリ (worktree 作成後はそのパス) */
  workDir: string;
  /** Docker イメージ名 */
  imageName: string;
  /** docker run に渡す引数 */
  dockerArgs: string[];
  /** docker run に渡す環境変数 */
  envVars: Record<string, string>;
  /** Nix が有効か (auto 解決後) */
  nixEnabled: boolean;
  /** エージェント起動コマンド */
  agentCommand: string[];
}

/** 初期コンテキストを生成 */
export function createContext(
  config: Config,
  profile: Profile,
  profileName: string,
  workDir: string,
): ExecutionContext {
  return {
    config,
    profile,
    profileName,
    workDir,
    imageName: "naw-sandbox",
    dockerArgs: [],
    envVars: {},
    nixEnabled: false,
    agentCommand: [],
  };
}
