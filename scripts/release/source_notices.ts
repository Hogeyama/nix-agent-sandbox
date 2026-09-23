/**
 * Collect copyright notices that permissive licenses keep only in source file
 * headers. WebKit and Bun carry most BSD and MIT terms per file rather than in
 * a LICENSE file, and a binary distribution must reproduce those notices.
 */
import { open, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface HeaderNotice {
  copyrights: string[];
  terms: string;
}
export interface NoticeGroup {
  terms: string;
  copyrights: string[];
  files: number;
}

// Terms whose conditions require the notice in a binary's documentation.
const termStarts = [
  "Redistribution and use in source and binary forms",
  "Permission is hereby granted, free of charge",
];
// Terms end at their disclaimer; a line break may fall anywhere inside it.
const termEnd = /(SUCH DAMAGE\.|DEALINGS IN THE SOFTWARE\.)/;
const lineComment = /^\s*(\/\/|\/\*|\*|#|<!--|--|;)/;
const copyrightMark = /copyright|\(c\)|©/i;
const headBytes = 32 * 1024;
// Disclaimers span well under this many lines; stop rather than run on.
const maxTermLines = 60;

function uncomment(line: string): string {
  return line
    .trim()
    .replace(/^(\/\*+|\*+\/|\*+|\/\/+|#+|<!--|--|;+)\s?/, "")
    .replace(/\s*(\*+\/|-->)$/, "")
    .trim();
}

/** Whether each line is inside a comment; blank lines count as neither. */
function commentLines(lines: string[]): boolean[] {
  let inBlock = false;
  return lines.map((line) => {
    const comment = inBlock || lineComment.test(line);
    const open = line.lastIndexOf("/*");
    const close = line.lastIndexOf("*/");
    if (open >= 0 && open > close) inBlock = true;
    else if (close >= 0) inBlock = false;
    return comment;
  });
}

/**
 * The first BSD- or MIT-style notice in a comment of the file, with the
 * copyright lines of the same comment. Code may precede it: Bun places the
 * notices of copied functions next to them.
 */
export function headerNotice(text: string): HeaderNotice | undefined {
  const lines = text.slice(0, headBytes).split("\n");
  const comment = commentLines(lines);
  const start = lines.findIndex(
    (line, index) =>
      comment[index] && termStarts.some((marker) => line.includes(marker)),
  );
  if (start < 0) return undefined;
  let terms = "";
  let complete = false;
  for (let index = start; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (index - start >= maxTermLines) break;
    // A blank line may separate paragraphs of `//`-style terms.
    if (!comment[index] && line.trim() !== "") break;
    terms = `${terms} ${uncomment(line)}`.replace(/\s+/g, " ");
    const match = termEnd.exec(terms);
    if (match) {
      terms = terms.slice(0, match.index + match[0].length).trim();
      complete = true;
      break;
    }
  }
  if (!complete) return undefined;
  let first = start;
  while (
    first > 0 &&
    (comment[first - 1] || (lines[first - 1] ?? "").trim() === "")
  )
    first--;
  const before = lines.slice(first, start).map(uncomment);
  const holder = before.findIndex((line) => copyrightMark.test(line));
  const copyrights =
    holder < 0
      ? []
      : before.slice(holder).filter((line) => /[A-Za-z0-9]/.test(line));
  return { copyrights, terms };
}

async function readHead(file: string): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(headBytes);
    const { bytesRead } = await handle.read(buffer, 0, headBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Group every header notice under `roots` by identical terms. */
export async function collectSourceNotices(
  roots: string[],
): Promise<NoticeGroup[]> {
  const groups = new Map<string, { copyrights: Set<string>; files: number }>();
  async function visit(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const head = await readHead(path);
        if (head.includes(0)) continue;
        const notice = headerNotice(head.toString("utf8"));
        if (!notice) continue;
        const group = groups.get(notice.terms) ?? {
          copyrights: new Set<string>(),
          files: 0,
        };
        for (const line of notice.copyrights) group.copyrights.add(line);
        group.files++;
        groups.set(notice.terms, group);
      }
    }
  }
  for (const root of roots) await visit(root);
  return [...groups]
    .map(([terms, group]) => ({
      terms,
      copyrights: [...group.copyrights].sort(),
      files: group.files,
    }))
    .sort((a, b) => b.files - a.files || a.terms.localeCompare(b.terms));
}

function wrap(text: string, width = 78): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

export function renderSourceNotices(groups: NoticeGroup[]): string {
  const sections = groups.map(
    (group) =>
      `${"=".repeat(78)}\n${group.files} source file(s) carry the following notices and terms.\n\n${group.copyrights.join("\n")}\n\n${wrap(group.terms)}\n`,
  );
  return `Copyright notices and permissive license terms reproduced from the headers of\nthe source files of this component.\n\n${sections.join("\n")}`;
}

if (import.meta.main) {
  const [output, ...roots] = Bun.argv.slice(2);
  if (!output || roots.length === 0) {
    console.error("usage: source_notices.ts OUTPUT ROOT...");
    process.exit(2);
  }
  const groups = await collectSourceNotices(roots);
  if (groups.length === 0) {
    console.error(`no header notices found under ${roots.join(", ")}`);
    process.exit(1);
  }
  await writeFile(output, renderSourceNotices(groups));
}
