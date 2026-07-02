/**
 * nas-maskfs デーモンの stdin フレーミング (maskfs.zig readSecretsFromStdin と対):
 * u32le count, その後 count 個の [u32le byteLen + utf8 bytes]。
 */
export function encodeMaskSecrets(secrets: readonly string[]): Uint8Array {
  const enc = new TextEncoder();
  const encoded = secrets.map((s) => enc.encode(s));
  let total = 4;
  for (const e of encoded) total += 4 + e.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, encoded.length, true);
  let pos = 4;
  for (const e of encoded) {
    view.setUint32(pos, e.byteLength, true);
    pos += 4;
    out.set(e, pos);
    pos += e.byteLength;
  }
  return out;
}
