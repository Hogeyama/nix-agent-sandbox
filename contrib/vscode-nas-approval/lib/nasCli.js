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
// stdin は pipe にする。watch は fd 0 が FIFO のときだけ stopOnOwnerExit を
// 武装するので、"ignore" (/dev/null) だと extension host が SIGKILL で死んだ
// 場合に孤児 watcher が無期限にポーリングし続ける。親は書き込まないので、
// 親の死でパイプが閉じ、子は自走で停止する。
function spawnNasWatch(nasPath, domain, sessionId, handlers) {
  const child = spawn(nasPath, [domain, "watch", "--session", sessionId], {
    stdio: ["pipe", "pipe", "pipe"],
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

module.exports = { runNas, spawnNasWatch };
