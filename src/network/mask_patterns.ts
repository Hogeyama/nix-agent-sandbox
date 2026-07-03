/**
 * mask_patterns — MaskConfig 秘密値の照合パターン展開と文字列マスク。
 *
 * broker が reviewContext (pending エントリ・監査ログ・レビュー UI に渡る)
 * をマスクするために使う。実際の HTTP リクエストのマスクは
 * src/docker/mitmproxy/nas_addon.py の同等実装が行う。
 * パターン展開ロジックを変更するときは両方を揃えること。
 */

import type { ReviewContext } from "./protocol.ts";

export const MASK_REPLACEMENT = "****";
/** base64 確定部分文字列の最低長。これ未満は誤マスク防止のため捨てる */
export const B64_MIN_PATTERN_LEN = 8;

/**
 * Python の urllib.parse.quote(value, safe="") / quote_plus(value) と同じ
 * 出力を生成する。unreserved (A-Za-z0-9_.~-) 以外を %XX にする。
 * plusForSpace が true のとき空白は "+" になる (quote_plus 相当)。
 */
function percentEncodeAll(value: string, plusForSpace: boolean): string {
  const bytes = new TextEncoder().encode(value);
  let out = "";
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    if (/[A-Za-z0-9_.~-]/.test(ch)) {
      out += ch;
    } else if (plusForSpace && ch === " ") {
      out += "+";
    } else {
      out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/**
 * base64 は3バイト単位でエンコードするため、秘密値がストリームのどの
 * オフセット (mod 3) に埋め込まれても検知できるよう、3アライメント分の
 * 「確定部分文字列」(隣接バイトの影響を受けない範囲) を生成する。
 * 標準/URL-safe 両アルファベット。truffleHog 等と同じ手法。
 */
function base64ConfidentSubstrings(value: string): string[] {
  const raw = new TextEncoder().encode(value);
  const out: string[] = [];
  for (let k = 0; k < 3; k++) {
    const prefixed = new Uint8Array(k + raw.length);
    prefixed.set(raw, k);
    const encoded = Buffer.from(prefixed).toString("base64").replace(/=+$/, "");
    // 先頭 k バイトの影響を受ける文字: i < 8k/6 → ceil(8k/6) 文字を落とす。
    // 末尾は後続バイトの影響を受け得るので floor(8(k+n)/6) 文字目まで。
    const start = Math.ceil((8 * k) / 6);
    const end = Math.floor((8 * (k + raw.length)) / 6);
    const candidate = encoded.slice(start, end);
    if (candidate.length >= B64_MIN_PATTERN_LEN) {
      out.push(candidate);
      out.push(candidate.replaceAll("+", "-").replaceAll("/", "_"));
    }
  }
  return out;
}

export function expandMaskPatterns(values: string[]): string[] {
  const patterns = new Set<string>();
  for (const value of values) {
    if (value.length === 0) continue;
    patterns.add(value);
    patterns.add(percentEncodeAll(value, false));
    patterns.add(percentEncodeAll(value, true));
    for (const p of base64ConfidentSubstrings(value)) {
      patterns.add(p);
    }
  }
  return [...patterns].sort((a, b) => b.length - a.length);
}

export function maskText(text: string, patterns: string[]): string {
  let out = text;
  for (const p of patterns) {
    out = out.replaceAll(p, MASK_REPLACEMENT);
  }
  return out;
}

/**
 * reviewContext (path / bodyPreview) を、展開済みパターンでマスクする。
 * 既知の制限: bodyPreview は先頭 1024 バイトで切り詰められるため、
 * 秘密値がプレビュー境界をまたぐと先頭部分だけが残り得る (spec 参照)。
 *
 * 呼び出し側の注意: これはマスク済みの reviewContext を pending エントリ
 * に永続化するためだけに使う。ホスト/パスマッチング (review rule の
 * pathPrefix, credential の pathPrefix 等) には、元の (マスクしていない)
 * reviewContext を使い続けること。マスク後の値でマッチングすると、URL
 * パス中に秘密値が現れた場合に一致すべきルールが一致しなくなる。
 */
export function maskReviewContextWithPatterns(
  ctx: ReviewContext | undefined,
  patterns: string[],
): ReviewContext | undefined {
  if (!ctx || patterns.length === 0) return ctx;
  return {
    ...ctx,
    path: maskText(ctx.path, patterns),
    bodyPreview:
      ctx.bodyPreview === null ? null : maskText(ctx.bodyPreview, patterns),
  };
}

export function maskReviewContext(
  ctx: ReviewContext | undefined,
  values: string[],
): ReviewContext | undefined {
  return maskReviewContextWithPatterns(ctx, expandMaskPatterns(values));
}
