import { BODY_LIMIT } from "./policy.ts";

// srt tees the body: what is read here is buffered for upstream too, so the
// read stops at BODY_LIMIT instead of holding an unbounded upload in memory.
export async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!(declared <= BODY_LIMIT) || request.body === null) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of request.body) {
      size += chunk.byteLength;
      if (size > BODY_LIMIT) return null;
      chunks.push(chunk);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    return null;
  }
}
