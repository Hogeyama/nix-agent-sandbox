// sessionId は WebSocket attach や API 経路で UI に元から流れる識別子で、
// secret ではない。短縮表記は一覧表示の readability 用途のみで、
// routing / keying には常に元 sessionId を使う。
export function shortenSessionId(sessionId: string): string {
  const trimmed = sessionId.replace(/^s_/, "");
  return `s_${trimmed.slice(0, 6)}`;
}
