const { isValidId } = require("./ids.js");

const DOMAINS = new Set(["hostexec", "network"]);

// Webview からの決定メッセージを nas argv に変換する。検証失敗は throw。
function decisionArgv(msg) {
  if (!DOMAINS.has(msg.domain))
    throw new Error(`unknown domain: ${msg.domain}`);
  if (!isValidId(msg.sessionId))
    throw new Error(`bad sessionId: ${msg.sessionId}`);
  if (!isValidId(msg.requestId))
    throw new Error(`bad requestId: ${msg.requestId}`);
  if (msg.action === "deny")
    return [msg.domain, "deny", msg.sessionId, msg.requestId];
  if (msg.action !== "approve")
    throw new Error(`unknown action: ${msg.action}`);
  const argv = [msg.domain, "approve", msg.sessionId, msg.requestId];
  if (msg.scope !== undefined && msg.scope !== null) {
    if (!isValidId(msg.scope)) throw new Error(`bad scope: ${msg.scope}`);
    argv.push("--scope", msg.scope);
  }
  return argv;
}

module.exports = { decisionArgv };
