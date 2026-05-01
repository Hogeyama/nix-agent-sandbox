import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { extractTranscriptSummary } from "./transcript_reader.ts";

interface Tmp {
  dir: string;
  file: string;
}

async function makeTmpFile(contents: string): Promise<Tmp> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-transcript-"));
  const file = path.join(dir, "transcript.jsonl");
  await writeFile(file, contents, "utf8");
  return { dir, file };
}

async function cleanup(t: Tmp): Promise<void> {
  await rm(t.dir, { recursive: true, force: true }).catch(() => {});
}

test("extractTranscriptSummary returns null when the file does not exist", () => {
  const missing = path.join(tmpdir(), "nas-transcript-missing-xyz", "no.jsonl");
  expect(extractTranscriptSummary(missing)).toBeNull();
});

test("extractTranscriptSummary picks the first user message (type=user/message.content string)", async () => {
  const t = await makeTmpFile(
    `${JSON.stringify({
      type: "user",
      message: { content: "Help me refactor the auth flow" },
    })}\n`,
  );
  try {
    expect(extractTranscriptSummary(t.file)).toBe(
      "Help me refactor the auth flow",
    );
  } finally {
    await cleanup(t);
  }
});

test("extractTranscriptSummary supports role=user/content array of text parts", async () => {
  const t = await makeTmpFile(
    `${JSON.stringify({
      role: "user",
      content: [
        { type: "text", text: "Part one." },
        { type: "text", text: "Part two." },
      ],
    })}\n`,
  );
  try {
    expect(extractTranscriptSummary(t.file)).toBe("Part one. Part two.");
  } finally {
    await cleanup(t);
  }
});

test("extractTranscriptSummary collapses newlines and runs of whitespace into single spaces", async () => {
  const t = await makeTmpFile(
    `${JSON.stringify({
      type: "user",
      message: { content: "line one\n\nline   two\tthree" },
    })}\n`,
  );
  try {
    expect(extractTranscriptSummary(t.file)).toBe("line one line two three");
  } finally {
    await cleanup(t);
  }
});

test("extractTranscriptSummary truncates with a trailing ellipsis past maxChars", async () => {
  const long = "x".repeat(500);
  const t = await makeTmpFile(
    `${JSON.stringify({ type: "user", message: { content: long } })}\n`,
  );
  try {
    const out = extractTranscriptSummary(t.file);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(160);
    expect(out?.endsWith("…")).toBe(true);
  } finally {
    await cleanup(t);
  }
});

test("extractTranscriptSummary respects custom maxChars option", async () => {
  const t = await makeTmpFile(
    `${JSON.stringify({
      type: "user",
      message: { content: "one two three four five" },
    })}\n`,
  );
  try {
    expect(extractTranscriptSummary(t.file, { maxChars: 5 })).toBe("one …");
  } finally {
    await cleanup(t);
  }
});

test("extractTranscriptSummary returns null when no user entry appears", async () => {
  const t = await makeTmpFile(
    [
      JSON.stringify({ type: "system", message: { content: "boot" } }),
      JSON.stringify({ type: "assistant", message: { content: "hi" } }),
    ].join("\n"),
  );
  try {
    expect(extractTranscriptSummary(t.file)).toBeNull();
  } finally {
    await cleanup(t);
  }
});

test("extractTranscriptSummary returns null when the user entry is past the 32-line scan cap", async () => {
  const lines: string[] = [];
  for (let i = 0; i < 40; i++) {
    lines.push(
      JSON.stringify({ type: "system", message: { content: `s${i}` } }),
    );
  }
  // user entry at line 33 (index 32): just past the cap.
  lines[32] = JSON.stringify({
    type: "user",
    message: { content: "too late" },
  });
  const t = await makeTmpFile(`${lines.join("\n")}\n`);
  try {
    expect(extractTranscriptSummary(t.file)).toBeNull();
  } finally {
    await cleanup(t);
  }
});

test("extractTranscriptSummary skips malformed JSON lines and continues scanning", async () => {
  const t = await makeTmpFile(
    [
      "{not valid json",
      JSON.stringify({ type: "user", message: { content: "real content" } }),
    ].join("\n"),
  );
  try {
    expect(extractTranscriptSummary(t.file)).toBe("real content");
  } finally {
    await cleanup(t);
  }
});

test("extractTranscriptSummary skips user entries with empty content", async () => {
  const t = await makeTmpFile(
    [
      JSON.stringify({ type: "user", message: { content: "" } }),
      JSON.stringify({ type: "user", message: { content: "next one" } }),
    ].join("\n"),
  );
  try {
    expect(extractTranscriptSummary(t.file)).toBe("next one");
  } finally {
    await cleanup(t);
  }
});

test("extractTranscriptSummary returns null on a non-object entry", async () => {
  const t = await makeTmpFile(
    [JSON.stringify("just a string"), JSON.stringify(null)].join("\n"),
  );
  try {
    expect(extractTranscriptSummary(t.file)).toBeNull();
  } finally {
    await cleanup(t);
  }
});
