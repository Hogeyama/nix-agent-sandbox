/**
 * Display (xpra sandbox) Stage (EffectStage)
 *
 * ホスト上に xpra の detached X server (Xvfb を spawn) を起動し、その
 * Xvfb ソケット + per-session な MIT-MAGIC-COOKIE xauthority だけを
 * コンテナへ渡すことで、ホスト本体の X セッションに到達させずに X11
 * クライアントを動かす。起動時点ではビューアは出ない — ユーザが見たい
 * ときに別ターミナルで `xpra attach :N` を叩くと初めてウィンドウが現れる。
 */

import { Effect, type Scope } from "effect";
import { logInfo } from "../../log.ts";
import type { Stage } from "../../pipeline/stage_builder.ts";
import type { DisplayState } from "../../pipeline/state.ts";
import type { StageInput, StageResult } from "../../pipeline/types.ts";
import type { MountProbes } from "../mount.ts";
import { DisplayService, type DisplayStartPlan } from "./display_service.ts";

// Xvfb 起動があるので遅い
const SOCKET_READY_TIMEOUT_MS = 15_000;
const SOCKET_READY_POLL_MS = 50;
const MIN_DISPLAY_NUMBER = 100;
const MAX_DISPLAY_NUMBER = 65535;

const DISPLAY_DISABLED_STATE = { enabled: false } satisfies DisplayState;

function buildDisabledDisplayResult(): Pick<StageResult, "display"> {
  return { display: DISPLAY_DISABLED_STATE };
}

// ---------------------------------------------------------------------------
// DisplayPlan
// ---------------------------------------------------------------------------

export interface DisplayPlan {
  readonly startPlan: DisplayStartPlan;
}

// ---------------------------------------------------------------------------
// EffectStage
// ---------------------------------------------------------------------------

export function createDisplayStage(
  shared: StageInput,
  mountProbes: MountProbes,
): Stage<never, Pick<StageResult, "display">, DisplayService, unknown> {
  return {
    name: "DisplayStage",
    needs: [],

    run(
      _input,
    ): Effect.Effect<
      Pick<StageResult, "display">,
      unknown,
      Scope.Scope | DisplayService
    > {
      if (shared.profile.display.sandbox === "none") {
        return Effect.succeed(buildDisabledDisplayResult());
      }

      const planResult = planDisplay(shared, mountProbes);
      if (planResult.kind === "error") {
        return Effect.fail(new Error(planResult.message));
      }
      return runDisplay(planResult.plan);
    },
  };
}

// ---------------------------------------------------------------------------
// Planner (pure — reads probes, allocates display number)
// ---------------------------------------------------------------------------

type PlanResult =
  | { kind: "ok"; plan: DisplayPlan }
  | { kind: "error"; message: string };

export function planDisplay(
  input: StageInput,
  mountProbes: MountProbes,
): PlanResult {
  if (!mountProbes.xpraBinPath) {
    return {
      kind: "error",
      message:
        "[nas] xpra not found on PATH. Install xpra (e.g. Debian: xpra, Nix: pkgs.xpra) to enable display.sandbox: xpra.",
    };
  }

  const displayNumber = pickFreeDisplayNumber(mountProbes.takenX11Displays);
  if (displayNumber === null) {
    return {
      kind: "error",
      message: `[nas] No free X11 display number in range [${MIN_DISPLAY_NUMBER}, ${MAX_DISPLAY_NUMBER}).`,
    };
  }

  const sessionDir = resolveSessionDir(input);
  const xauthorityPath = `${sessionDir}/Xauthority`;
  const socketPath = `/tmp/.X11-unix/X${displayNumber}`;
  const xpraInternalXauthPath = resolveXpraInternalXauthPath(input);

  return {
    kind: "ok",
    plan: {
      startPlan: {
        xpraBinaryPath: mountProbes.xpraBinPath,
        sessionDir,
        xauthorityPath,
        xpraInternalXauthPath,
        displayNumber,
        size: input.profile.display.size,
        socketPath,
        timeoutMs: SOCKET_READY_TIMEOUT_MS,
        pollIntervalMs: SOCKET_READY_POLL_MS,
        sessionId: input.sessionId,
      },
    },
  };
}

/**
 * [MIN, MAX) の範囲で、takenX11Displays に含まれない最小の番号を返す。
 * 空きが無ければ null。
 */
export function pickFreeDisplayNumber(
  taken: ReadonlySet<number>,
): number | null {
  for (let n = MIN_DISPLAY_NUMBER; n < MAX_DISPLAY_NUMBER; n++) {
    if (!taken.has(n)) return n;
  }
  return null;
}

function resolveSessionDir(input: StageInput): string {
  const xdg = input.host.env.get("XDG_RUNTIME_DIR");
  if (xdg && xdg.trim().length > 0) {
    return `${xdg}/nas/display/${input.sessionId}`;
  }
  const uid = input.host.uid ?? "unknown";
  return `/tmp/nas-${uid}/display/${input.sessionId}`;
}

/**
 * xpra が default の Xorg-for-Xpra を起動する時に `-auth` で渡すファイル。
 * xpra 6.x は `$XAUTHORITY` または `~/.Xauthority` を使う (ps で観測した
 * `-auth /home/<user>/.Xauthority`)。per-display dir の `xauthority` は
 * 別物 (空で出てくることがある) なのでそちらは見ない。
 */
function resolveXpraInternalXauthPath(input: StageInput): string {
  const xauth = input.host.env.get("XAUTHORITY");
  if (xauth && xauth.trim().length > 0) return xauth;
  return `${input.host.home}/.Xauthority`;
}

// ---------------------------------------------------------------------------
// Effect runner
// ---------------------------------------------------------------------------

function runDisplay(
  plan: DisplayPlan,
): Effect.Effect<
  Pick<StageResult, "display">,
  unknown,
  Scope.Scope | DisplayService
> {
  return Effect.gen(function* () {
    const displayService = yield* DisplayService;
    const handle = yield* displayService.startXpra(plan.startPlan);
    logInfo(
      `[nas] xpra :${handle.displayNumber} ready (auto-attached). ` +
        `xpra log: ${handle.logPath}`,
    );
    return {
      display: {
        enabled: true,
        displayNumber: handle.displayNumber,
        socketPath: handle.socketPath,
        xauthorityPath: handle.xauthorityPath,
      },
    } satisfies Pick<StageResult, "display">;
  });
}
