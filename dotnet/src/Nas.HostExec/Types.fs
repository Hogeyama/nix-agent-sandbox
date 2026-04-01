namespace Nas.HostExec

open System
open Nas.Core

type ExecuteRequest =
    { Version: int; Type: string; SessionId: string; RequestId: string
      Argv0: string; Args: string list; Cwd: string; Tty: bool }

[<RequireQualifiedAccess>]
type BrokerResponseKind = Result | Fallback | Error | Pending | Ack

type BrokerResponse =
    { Version: int; Type: string; Kind: BrokerResponseKind; RequestId: string
      ExitCode: int option; Stdout: string option; Stderr: string option; Message: string option }

type ResolvedExecution =
    { Rule: Config.HostExecRule; Argv0: string; Args: string list; Cwd: string
      Env: Map<string, string>; Approval: HostExecApproval }

type PendingEntry =
    { RequestId: string; SessionId: string; Argv0: string; Args: string list
      Cwd: string; RuleId: string; ObservedAt: DateTimeOffset }

type SessionEntry =
    { SessionId: string; BrokerSocket: string; Rules: string list; CreatedAt: DateTimeOffset }
