const { isValidId } = require("./ids.js");

// `nas devcontainer status --json` の stdout を解釈する。
// 未 init の workspace では nas が JSON の null を出力する。
function parseDevcontainerStatus(stdout) {
  const data = JSON.parse(stdout);
  if (data === null) return null;
  return {
    phase: typeof data.phase === "string" ? data.phase : "stopped",
    sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
  };
}

function readySessionId(status) {
  if (!status || status.phase !== "ready") return null;
  return isValidId(status.sessionId) ? status.sessionId : null;
}

module.exports = { parseDevcontainerStatus, readySessionId };
