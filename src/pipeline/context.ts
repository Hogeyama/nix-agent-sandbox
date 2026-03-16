/**
 * Pipeline / Stage / ExecutionContext
 */

import { encodeHex } from "@std/encoding/hex";
import type { Config, Profile } from "../config/types.ts";
import type { LogLevel } from "../log.ts";

/** パイプライン実行中に各ステージが読み書きするコンテキスト */
export interface ExecutionContext {
  /** 解決済み設定 */
  config: Config;
  /** 選択されたプロファイル */
  profile: Profile;
  /** プロファイル名 */
  profileName: string;
  /** セッション ID */
  sessionId: string;
  /** 作業ディレクトリ (コンテナ内の PWD) */
  workDir: string;
  /** マウントするホストディレクトリ (workDir と異なる場合に設定) */
  mountDir?: string;
  /** Docker イメージ名 */
  imageName: string;
  /** docker run に渡す引数 */
  dockerArgs: string[];
  /** docker run に渡す環境変数 */
  envVars: Record<string, string>;
  /** ネットワーク runtime dir */
  networkRuntimeDir?: string;
  /** プロキシ資格情報トークン */
  networkPromptToken?: string;
  /** 動的承認が有効か */
  networkPromptEnabled: boolean;
  /** broker UDS パス */
  networkBrokerSocket?: string;
  /** プロキシ endpoint */
  networkProxyEndpoint?: string;
  /** hostexec runtime dir */
  hostexecRuntimeDir?: string;
  /** hostexec broker UDS パス */
  hostexecBrokerSocket?: string;
  /** hostexec session tmp dir */
  hostexecSessionTmpDir?: string;
  /** Nix が有効か (auto 解決後) */
  nixEnabled: boolean;
  /** エージェント起動コマンド */
  agentCommand: string[];
  /** ログレベル */
  logLevel: LogLevel;
}

/** 初期コンテキストを生成 */
export function createContext(
  config: Config,
  profile: Profile,
  profileName: string,
  workDir: string,
  logLevel: LogLevel = "info",
): ExecutionContext {
  const sessionId = `sess_${randomHex(6)}`;
  const proxyEnabled = profile.network.allowlist.length > 0 ||
    profile.network.prompt.enable;

  return {
    config,
    profile,
    profileName,
    sessionId,
    workDir,
    imageName: "nas-sandbox",
    dockerArgs: [],
    envVars: {},
    networkPromptToken: proxyEnabled ? randomHex(32) : undefined,
    networkPromptEnabled: profile.network.prompt.enable,
    nixEnabled: false,
    agentCommand: [],
    logLevel,
  };
}

function randomHex(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return encodeHex(data);
}
