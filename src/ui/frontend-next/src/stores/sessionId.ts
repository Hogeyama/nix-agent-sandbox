// sessionId は WebSocket attach や API 経路で UI に元から流れる識別子で、
// secret ではない。短縮表記は一覧表示の readability 用途のみで、
// routing / keying には常に元 sessionId を使う。
//
// 実 sessionId は backend (`src/ui/launch.ts`) で `sess_<12hex>` 形式で生成される。
// 表示上は sess_ または s_ プレフィックスを剥がし、残りの 6 文字だけを返す。
// プレフィックスの再付与はしない。
export function shortenSessionId(sessionId: string): string {
  if (sessionId === "") return "";
  const stripped = sessionId.replace(/^(?:sess_|s_)/, "");
  // 6 文字未満の入力 (プレフィックス剥がし後に 6 文字未満となるケースを含む)
  // は slice(0, 6) で全文が返るためそのまま返却される。
  return stripped.slice(0, 6);
}
