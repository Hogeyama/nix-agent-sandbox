/**
 * Profile から、ガイド本文の分岐を駆動する事実だけを抽出する。
 *
 * この型はコンテナから読める内容の材料になる。したがって profile.env /
 * profile.secrets / hostexec.secrets / hostexec.rules / mask の中身は
 * 読まない（mask は null かどうかだけを見る）。security-constraints C1。
 */

import type { AgentType } from "../../agents/types.ts";
import type { Profile } from "../../config/types.ts";
import type { NetworkFallback } from "../../network/authz/config.ts";

export interface GuideNetworkFacts {
  /** 未設定時の既定は "deny"。"allow" は存在しない。 */
  readonly fallback: NetworkFallback;
  readonly pendingTimeoutSeconds: number;
  readonly forwardPorts: readonly number[];
}

export interface GuideHostExecFacts {
  readonly promptEnabled: boolean;
  readonly timeoutSeconds: number;
}

export interface GuideDindFacts {
  readonly shared: boolean;
}

export interface GuideFacts {
  readonly agent: AgentType;
  readonly workDir: string;
  readonly network: GuideNetworkFacts;
  readonly hostexec: GuideHostExecFacts | null;
  readonly dind: GuideDindFacts | null;
  readonly maskEnabled: boolean;
  readonly displaySandbox: string;
  readonly extra: string | null;
}

export function profileToGuideFacts(
  profile: Profile,
  workDir: string,
): GuideFacts {
  return {
    agent: profile.agent,
    workDir,
    network: {
      fallback: profile.network.fallback ?? "deny",
      pendingTimeoutSeconds: profile.network.pendingTimeoutSeconds,
      forwardPorts: [...profile.network.proxy.forwardPorts],
    },
    hostexec:
      profile.hostexec == null
        ? null
        : {
            promptEnabled: profile.hostexec.prompt.enable,
            timeoutSeconds: profile.hostexec.prompt.timeoutSeconds,
          },
    dind: profile.docker.enable ? { shared: profile.docker.shared } : null,
    maskEnabled: profile.mask !== undefined && profile.mask !== null,
    displaySandbox: profile.display.sandbox,
    extra: profile.guide.extra ?? null,
  };
}
