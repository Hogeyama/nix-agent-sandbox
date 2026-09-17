const { spawn } = require("node:child_process");

// nas サブコマンドを実行し stdout を返す。非ゼロ終了は stderr 付きで reject。
function runNas(nasPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(nasPath, args, {
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
function spawnNasWatch(nasPath, domain, sessionId, handlers) {
  const child = spawn(nasPath, [domain, "watch", "--session", sessionId], {
    stdio: ["ignore", "pipe", "pipe"],
  });
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
  child.on("error", (err) => {
    handlers.onError?.(String(err));
    handlers.onExit?.(-1);
  });
  child.on("close", (code) => handlers.onExit?.(code));
  return child;
}

module.exports = { runNas, spawnNasWatch };
