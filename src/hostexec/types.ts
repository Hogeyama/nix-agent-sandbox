import type { HostExecPromptScope, HostExecRule } from "../config/types.ts";

export interface HostExecSessionRegistryEntry {
  version: 1;
  sessionId: string;
  brokerSocket: string;
  profileName: string;
  createdAt: string;
  pid: number;
  agent?: string;
}

export interface HostExecPendingEntry {
  version: 1;
  sessionId: string;
  requestId: string;
  approvalKey: string;
  ruleId: string;
  argv0: string;
  args: string[];
  cwd: string;
  state: "pending";
  createdAt: string;
  updatedAt: string;
  defaultScope?: HostExecPromptScope;
  capability?: ResolvedExecutionCapability;
  /**
   * true のとき、この pending は「対象ファイルがブローカー起動時の baseline から
   * 変化した」ために allow ルールを承認へ格上げした結果である。承認 UI が
   * 「変化した事実」を提示するために使う。
   */
  integrityChanged?: boolean;
}

export interface ExecuteRequest {
  version: 2;
  type: "execute";
  sessionId: string;
  requestId: string;
  argv0: string;
  args: string[];
  cwd: string;
  tty: boolean;
  stdinMode: "fd" | "none";
}

export interface ApprovalRequest {
  type: "approve";
  requestId: string;
  scope?: import("../config/types.ts").HostExecPromptScope;
}

export interface DenyRequest {
  type: "deny";
  requestId: string;
}

export interface ListPendingRequest {
  type: "list_pending";
}

export type HostExecControlRequest =
  | ApprovalRequest
  | DenyRequest
  | ListPendingRequest;

export interface HostExecErrorResponse {
  type: "error";
  requestId: string;
  message: string;
}

export interface PendingListResponse {
  type: "pending";
  items: HostExecPendingEntry[];
}

export interface AckResponse {
  type: "ack";
  requestId: string;
  decision: "approve" | "deny";
}

export type HostExecControlResponse =
  | HostExecErrorResponse
  | PendingListResponse
  | AckResponse;

export interface EnvBindingFingerprint {
  key: string;
  source: string;
}

export interface ResolvedExecutionCapability {
  ruleId: string;
  argv0: string;
  normalizedArgv: string[];
  normalizedCwd: string;
  envBindings: EnvBindingFingerprint[];
  inheritEnv: {
    mode: "minimal" | "unsafe-inherit-all";
    keys: string[];
  };
}

export interface ResolvedExecution {
  rule: HostExecRule;
  cwd: string;
  capability: ResolvedExecutionCapability;
  envVars: Record<string, string>;
}
