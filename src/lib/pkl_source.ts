/**
 * 名前が参照になりえない範囲を空白で塗り潰す。改行は残すので行番号は変わらない。
 *
 * 伏せるのはコメント (行・ブロック) と文字列リテラルの中身である。Pkl の文字列は
 * `"..."` と複数行の `"""..."""`、およびそれぞれをポンド記号で囲む
 * `#"..."#` の形を取る。ポンドの本数はエスケープと閉じ記号の綴りを変えるので、
 * 開いたときの本数を覚えておいて突き合わせる。
 *
 * 文字列の中の `\(...)` は補間であり、その中は式である。つまり旧名がそこに
 * 現れれば本物の参照なので、補間の中はコードとして扱う。
 *
 * 閉じない引用符は行末で打ち切る。打ち切らないと、引用符 1 つの書き損じで
 * ファイルの残り全部が伏せられ、この検査が黙って無効になる。
 */
export function maskNonCode(source: string): string {
  type Frame =
    | { readonly kind: "string"; readonly pounds: number; multiline: boolean }
    | { kind: "interpolation"; depth: number };

  const out: string[] = [];
  const stack: Frame[] = [];
  let at = 0;
  const keep = (length: number): void => {
    out.push(source.slice(at, at + length));
    at += length;
  };
  const hide = (length: number): void => {
    for (const char of source.slice(at, at + length)) {
      out.push(char === "\n" ? "\n" : " ");
    }
    at += length;
  };

  while (at < source.length) {
    const top = stack[stack.length - 1];

    if (top === undefined || top.kind === "interpolation") {
      if (source.startsWith("//", at)) {
        const end = source.indexOf("\n", at);
        hide((end === -1 ? source.length : end) - at);
        continue;
      }
      if (source.startsWith("/*", at)) {
        const end = source.indexOf("*/", at + 2);
        hide((end === -1 ? source.length : end + 2) - at);
        continue;
      }
      const opener = stringOpener(source, at);
      if (opener !== null) {
        stack.push({
          kind: "string",
          pounds: opener.pounds,
          multiline: opener.multiline,
        });
        hide(opener.length);
        continue;
      }
      if (top !== undefined) {
        // 補間の中の括弧を数える。釣り合った時点で文字列に戻る。
        const char = source[at];
        if (char === "(") top.depth++;
        else if (char === ")") {
          if (top.depth === 0) {
            stack.pop();
            keep(1);
            continue;
          }
          top.depth--;
        }
      }
      keep(1);
      continue;
    }

    const escapePrefix = `\\${"#".repeat(top.pounds)}`;
    if (source.startsWith(escapePrefix, at)) {
      if (source[at + escapePrefix.length] === "(") {
        stack.push({ kind: "interpolation", depth: 0 });
        hide(escapePrefix.length + 1);
        continue;
      }
      hide(Math.min(escapePrefix.length + 1, source.length - at));
      continue;
    }
    const closer = `${top.multiline ? '"""' : '"'}${"#".repeat(top.pounds)}`;
    if (source.startsWith(closer, at)) {
      stack.pop();
      hide(closer.length);
      continue;
    }
    if (!top.multiline && source[at] === "\n") {
      stack.pop();
      keep(1);
      continue;
    }
    hide(1);
  }
  return out.join("");
}

/** その位置が文字列の開き記号なら、その本数と長さを返す。 */
export function stringOpener(
  source: string,
  at: number,
): { pounds: number; multiline: boolean; length: number } | null {
  let pounds = 0;
  while (source[at + pounds] === "#") pounds++;
  if (source[at + pounds] !== '"') return null;
  const multiline = source.startsWith('"""', at + pounds);
  return { pounds, multiline, length: pounds + (multiline ? 3 : 1) };
}

export function containsIdentifier(line: string, identifier: string): boolean {
  let from = 0;
  for (;;) {
    const at = line.indexOf(identifier, from);
    if (at === -1) return false;
    const before = line[at - 1];
    const after = line[at + identifier.length];
    if (!isIdentifierChar(before) && !isIdentifierChar(after)) return true;
    from = at + 1;
  }
}

function isIdentifierChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$]/.test(char);
}
