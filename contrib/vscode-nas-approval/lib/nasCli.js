const { spawn } = require("node:child_process");
const { platform } = require("node:process");

// `nas-approval.nasPath` はコマンド全体を1つの文字列として受け取る。
// 素の "nas" だけでなく、"wsl.exe -e /home/user/.nix-profile/bin/nas" のように
// 前置きコマンドを含められる。UI extensionKind は常にVS Code自体と同じ
// マシン (Windows+WSL2+Dev Container の三重構成なら Windows) で動くので、
// nas が別のリモート層 (WSL) にしかいない場合はこの前置きが唯一の橋渡し。
function splitCommand(nasPath) {
  const tokens = nasPath.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) throw new Error("nas-approval.nasPath is empty");
  return { cmd: tokens[0], prefixArgs: tokens.slice(1) };
}

// nas サブコマンドを実行し stdout を返す。非ゼロ終了は stderr 付きで reject。
function runNas(nasPath, args) {
  return new Promise((resolve, reject) => {
    const { cmd, prefixArgs } = splitCommand(nasPath);
    const child = spawn(cmd, [...prefixArgs, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out)
        : reject(
            new Error(`nas ${args.join(" ")} exited ${code}: ${err.trim()}`),
          ),
    );
  });
}

// `nas <domain> watch --session <sid>` を spawn し、行区切りで onLine を呼ぶ。
// stdin は pipe にする。watch は fd 0 が FIFO のときだけ stopOnOwnerExit を
// 武装するので、"ignore" (/dev/null) だと extension host が SIGKILL で死んだ
// 場合に孤児 watcher が無期限にポーリングし続ける。親は書き込まないので、
// 親の死でパイプが閉じ、子は自走で停止する。
function spawnNasWatch(nasPath, domain, sessionId, handlers) {
  const { cmd, prefixArgs } = splitCommand(nasPath);
  const child = spawn(
    cmd,
    [...prefixArgs, domain, "watch", "--session", sessionId],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) handlers.onLine(line);
      idx = buf.indexOf("\n");
    }
  });
  child.stderr.on("data", (d) => handlers.onError?.(String(d)));
  // spawn 失敗時は error と close の両方が来るので onExit は一度だけにする。
  let fired = false;
  const fireExit = (code) => {
    if (fired) return;
    fired = true;
    handlers.onExit?.(code);
  };
  child.on("error", (err) => {
    handlers.onError?.(String(err));
    fireExit(-1);
  });
  child.on("close", (code) => fireExit(code));
  return child;
}

// `wsl.exe -l -q` prints one distro name per line as UTF-16LE. Read as UTF-8
// that arrives as a leading BOM plus a NUL byte after every character.
function parseWslDistroList(raw) {
  return raw
    .split("\u0000")
    .join("")
    .split(/\r?\n/)
    .map((line) => (line.startsWith("﻿") ? line.slice(1) : line))
    .map((line) => line.trim())
    .filter(Boolean);
}

// Tries each distro's `nas --version` in turn and returns the bridging
// command for the first one that succeeds. Only a fallback for when no
// distro hint is available (see extractWslDistroFromAuthority): guessing
// across every installed distro can't tell two nas-having distros apart, so
// a workspace folder whose authority names its distro must never reach this.
// `listDistros`/`probe` are injected so this selection logic can be tested
// without a real WSL install.
async function pickWslNasCommand(listDistros, probe) {
  for (const distro of await listDistros()) {
    const command = `wsl.exe -d ${distro} nas`;
    try {
      await probe(command);
      return command;
    } catch {
      // try the next distro
    }
  }
  return undefined;
}

// A Dev Container opened from a Remote - WSL window encodes its host's UNC
// path into the workspace folder's `dev-container+<hex>` authority, as
// hex-encoded JSON's `hostPath` field — e.g. hex-decoding yields
// `{"hostPath":"\\\\wsl.localhost\\NixOS\\home\\me\\repo",...}`. That names
// the exact WSL distro nas has to run in, so a workspace never needs to
// guess across every installed distro the way pickWslNasCommand does. This
// is undocumented (reverse-engineered; see the extension's README), so a
// caller must keep working when it returns undefined — pickWslNasCommand is
// exactly that fallback. It is deliberately *not* used for the workspace
// path nas needs: `vscode.Uri.path` (unlike `.fsPath`) is always POSIX per
// the URI spec, official and stable, and already correct for this.
function extractWslDistroFromAuthority(authority) {
  if (typeof authority !== "string") return undefined;
  const match = /^dev-container\+([0-9a-f]+)$/i.exec(authority);
  if (!match) return undefined;
  let hostPath;
  try {
    hostPath = JSON.parse(
      Buffer.from(match[1], "hex").toString("utf8"),
    )?.hostPath;
  } catch {
    return undefined;
  }
  if (typeof hostPath !== "string") return undefined;
  const wslMatch = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\/i.exec(hostPath);
  return wslMatch?.[1];
}

// distro name (or "" for "no hint available") -> resolved command | null
const resolvedWindowsCommands = new Map();

// Failures are cached too (as null), so a resolution that failed at
// activation — nas not yet installed in the hinted distro, WSL down — would
// otherwise stay failed for the rest of the session. The refresh command
// clears this so "fix the setup, then retry" actually re-probes.
function clearResolvedCommandCache() {
  resolvedWindowsCommands.clear();
}

/**
 * `nas-approval.nasPath` defaulting to "nas" only works when nas is reachable
 * from wherever this (always locally-hosted, extensionKind "ui") extension
 * runs. On Windows with nas installed in WSL2 — the common case for a Dev
 * Container opened from a Remote - WSL window — that's never true.
 *
 * `distroHint`, when the caller could extract one (see
 * extractWslDistroFromAuthority), names the exact distro to use; this only
 * verifies nas actually runs there before caching it, so two folders backed
 * by different distros each resolve correctly. Without a hint this falls
 * back to probing every installed distro and caching whichever has nas,
 * which cannot tell two nas-having distros apart. Any non-default nasPath,
 * or any platform but Windows, passes through unchanged.
 */
async function resolveNasCommand(configuredPath, distroHint, log) {
  if (configuredPath !== "nas" || platform !== "win32") return configuredPath;
  const cacheKey = distroHint ?? "";
  if (!resolvedWindowsCommands.has(cacheKey)) {
    let resolved;
    if (distroHint) {
      const candidate = `wsl.exe -d ${distroHint} nas`;
      try {
        await runNas(candidate, ["--version"]);
        resolved = candidate;
        log?.(`resolved nas for WSL distro "${distroHint}": ${candidate}`);
      } catch (err) {
        log?.(
          `WSL distro "${distroHint}" (from this workspace's own host path) has no working nas: ${err.message}`,
        );
      }
    } else {
      try {
        resolved = await pickWslNasCommand(
          async () => parseWslDistroList(await runNas("wsl.exe", ["-l", "-q"])),
          (command) => runNas(command, ["--version"]),
        );
      } catch (err) {
        log?.(`WSL distro auto-detection failed: ${err.message}`);
      }
      if (resolved) log?.(`auto-detected nas via: ${resolved}`);
    }
    if (!resolved) {
      log?.(
        `no WSL distro has a working nas${distroHint ? "" : " (checked every installed distro)"}; set nas-approval.nasPath explicitly`,
      );
    }
    resolvedWindowsCommands.set(cacheKey, resolved ?? null);
  }
  return resolvedWindowsCommands.get(cacheKey) ?? configuredPath;
}

module.exports = {
  runNas,
  spawnNasWatch,
  splitCommand,
  parseWslDistroList,
  pickWslNasCommand,
  extractWslDistroFromAuthority,
  resolveNasCommand,
  clearResolvedCommandCache,
};
