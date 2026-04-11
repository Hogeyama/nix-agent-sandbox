# Plan: make `notify-send-wsl` click-to-open actually open `nas ui`

## Problem

On WSL the `notify-send-wsl` shim (`scripts/notify-send-wsl`) currently has no
click handling. Even though `tryDesktopNotification` in
`src/lib/notify_utils.ts` passes `--wait --action=default=Open` and expects the
child to print `default` on stdout when the user clicks, the shim:

- Ignores `--wait` entirely (`scripts/notify-send-wsl:46-50`).
- Displays a `System.Windows.Forms.NotifyIcon` BalloonTip with a fixed
  `Start-Sleep -Seconds 3` (`scripts/notify-send-wsl:154-167`) and never
  subscribes to `BalloonTipClicked`.
- Unconditionally prints `wsl-notify-only` at the end
  (`scripts/notify-send-wsl:184`), which is not `default`, so
  `src/lib/notify_utils.ts:97` never calls `xdg-open`.

Result: clicking the Windows balloon does nothing — it never opens `nas ui`.
There is also no way to deliver the target URL to the shim today; `uiUrl` is
only known to the caller.

## Fix

Keep the `wsl-notify-only` output contract (so the caller's `xdg-open` branch
stays dormant on WSL and we don't double-open), but make the shim itself open
the URL in Windows when the user clicks the balloon.

### 1. `src/lib/notify_utils.ts`

In `tryDesktopNotification`, pass the target URL to the child via env:

```ts
env: { ...process.env, NAS_NOTIFY_UI_URL: options.uiUrl },
```

Rationale:

- Self-contained per-spawn; no globals.
- Harmless for native Linux `notify-send` (ignored env var).
- Avoids having to thread a new CLI flag and keeps the shim's argv parser
  unchanged.

### 2. `scripts/notify-send-wsl`

Rework the PowerShell block so it:

- Reads `NAS_NOTIFY_UI_URL` from the bash side and injects it into the PS
  script text (same placeholder-substitution style already used for title /
  body).
- Subscribes to `BalloonTipClicked` and `BalloonTipClosed`, setting script
  scope flags.
- Runs a `while` loop pumping `[System.Windows.Forms.Application]::DoEvents()`
  until clicked, closed, or a safety timeout (~60s) elapses.
- On click, calls `Start-Process $url` (Windows side), which launches the
  default browser against `http://localhost:<uiPort>/...`.
- Disposes the tray icon and exits.

Also honour `--wait` properly: the shim used to fall through immediately, but
since the balloon now needs to stay alive for the click handler we simply
always wait for the PowerShell block to finish. The parent already kills the
child via `AbortSignal` if it wants to cancel early
(`src/lib/notify_utils.ts:81-86`).

`--expire-time` still isn't meaningful for `BalloonTip` display time (OS
controlled), but we use the safety timeout to bound the wait loop.

The final `echo "wsl-notify-only"` stays, so no caller-side action dispatch
changes are needed.

### 3. Tests

- `src/hostexec/notify_integration_test.ts` and
  `src/network/notify_integration_test.ts` already install a fake
  `notify-send` on PATH. Extend the fake so it can dump its env to a file and
  assert that `NAS_NOTIFY_UI_URL` is set and points to the UI URL when the
  caller requests an "Open UI" notification.
- No new tests for the PowerShell path itself — it is WSL-only and not
  reachable from the Linux CI runner. A manual repro note goes in the commit
  message.

## Out of scope

- `tryCliActionNotification` (approve/deny). BalloonTip can't render two
  action buttons, and the caller does not currently pass a UI URL. Left as
  follow-up.
- Replacing `BalloonTip` with WinRT `ToastNotificationManager`. That requires
  `AppUserModelId` registration and is known to fail silently from WSL per
  the existing shim comment (`scripts/notify-send-wsl:19-22`).
