import type { HostExecRule } from "../config/types.ts";

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
}

export interface ExecuteRequest {
  version: 1;
  type: "execute";
  sessionId: string;
  requestId: string;
  argv0: string;
  args: string[];
  cwd: string;
  stdin?: string;
  tty: boolean;
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

export type HostExecBrokerMessage =
  | ExecuteRequest
  | ApprovalRequest
  | DenyRequest
  | ListPendingRequest;

export interface ExecuteResultResponse {
  type: "result";
  requestId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecuteFallbackResponse {
  type: "fallback";
  requestId: string;
}

export interface ExecuteErrorResponse {
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

export type HostExecBrokerResponse =
  | ExecuteResultResponse
  | ExecuteFallbackResponse
  | ExecuteErrorResponse
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
