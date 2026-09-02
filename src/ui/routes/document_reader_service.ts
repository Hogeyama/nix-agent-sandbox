import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import * as path from "node:path";
import {
  DocumentOpenError,
  isStrictlyInside,
  parseDocumentClipboard,
} from "./document_path";

export const MAX_DOCUMENT_BYTES = 1024 * 1024;

export interface DocumentItem {
  readonly path: string;
  readonly content: string;
  readonly line: number | null;
  readonly column: number | null;
}

export interface DocumentFileHandle {
  readonly fd: number;
  stat(): Promise<{ isFile(): boolean; size: number }>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface DocumentFileOps {
  realpath(value: string): Promise<string>;
  open(value: string, flags: number): Promise<DocumentFileHandle>;
}

export interface DocumentReader {
  open(worktree: string, clipboardText: string): Promise<DocumentItem>;
}

const LIVE_OPS: DocumentFileOps = { realpath, open };
const CLOSE_AFTER_ERROR_WARNING =
  "Document descriptor close failed after an earlier error";

async function readBounded(handle: DocumentFileHandle): Promise<Uint8Array> {
  const output = new Uint8Array(MAX_DOCUMENT_BYTES + 1);
  let used = 0;
  while (used < output.length) {
    let bytesRead: number;
    try {
      ({ bytesRead } = await handle.read(output, used, output.length - used));
    } catch (cause) {
      throw new DocumentOpenError("unreadable", "Document could not be read", {
        cause,
      });
    }
    if (bytesRead === 0) break;
    used += bytesRead;
  }
  if (used > MAX_DOCUMENT_BYTES) {
    throw new DocumentOpenError("too-large", "Document is larger than 1 MiB");
  }
  return output.subarray(0, used);
}

export function makeDocumentReader(
  ops: DocumentFileOps = LIVE_OPS,
): DocumentReader {
  return {
    async open(worktree, clipboardText) {
      const parsed = parseDocumentClipboard(clipboardText);
      let root: string;
      try {
        root = await ops.realpath(worktree);
      } catch (cause) {
        throw new DocumentOpenError(
          "not-found",
          "Session document root is unavailable",
          { cause },
        );
      }
      const lexicalRoot = path.resolve(worktree);
      const candidate = path.isAbsolute(parsed.path)
        ? path.resolve(parsed.path)
        : path.resolve(lexicalRoot, parsed.path);
      if (
        !isStrictlyInside(lexicalRoot, candidate) &&
        !isStrictlyInside(root, candidate)
      ) {
        throw new DocumentOpenError(
          "outside-worktree",
          "Document is outside the session worktree",
        );
      }

      let handle: DocumentFileHandle;
      try {
        handle = await ops.open(
          candidate,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          throw new DocumentOpenError("not-found", "Document not found", {
            cause,
          });
        }
        if (code === "ELOOP") {
          throw new DocumentOpenError(
            "not-regular-file",
            "Document symlinks are not allowed",
            { cause },
          );
        }
        throw new DocumentOpenError(
          "unreadable",
          "Document could not be opened",
          { cause },
        );
      }

      let item: DocumentItem;
      try {
        const stat = await handle.stat().catch((cause) => {
          throw new DocumentOpenError(
            "unreadable",
            "Document metadata could not be read",
            { cause },
          );
        });
        if (!stat.isFile()) {
          throw new DocumentOpenError(
            "not-regular-file",
            "Document is not a regular file",
          );
        }
        if (stat.size > MAX_DOCUMENT_BYTES) {
          throw new DocumentOpenError(
            "too-large",
            "Document is larger than 1 MiB",
          );
        }
        const target = await ops
          .realpath(`/proc/self/fd/${handle.fd}`)
          .catch((cause) => {
            throw new DocumentOpenError(
              "unreadable",
              "Document identity could not be verified",
              { cause },
            );
          });
        if (!isStrictlyInside(root, target)) {
          throw new DocumentOpenError(
            "outside-worktree",
            "Document is outside the session worktree",
          );
        }
        const targetExt = path.extname(target).toLowerCase();
        if (targetExt !== ".md" && targetExt !== ".markdown") {
          throw new DocumentOpenError(
            "unsupported-type",
            "Only Markdown documents can be opened",
          );
        }
        const bytes = await readBounded(handle);
        let content: string;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch (cause) {
          throw new DocumentOpenError(
            "unreadable",
            "Document is not valid UTF-8",
            { cause },
          );
        }
        item = {
          path: path.relative(root, target),
          content,
          line: parsed.line,
          column: parsed.column,
        };
      } catch (error) {
        try {
          await handle.close();
        } catch {
          console.warn(CLOSE_AFTER_ERROR_WARNING);
        }
        throw error;
      }
      try {
        await handle.close();
      } catch (cause) {
        throw new DocumentOpenError(
          "unreadable",
          "Document could not be closed",
          { cause },
        );
      }
      return item;
    },
  };
}
