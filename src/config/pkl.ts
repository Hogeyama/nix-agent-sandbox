import type { RawConfig } from "./types.ts";

/**
 * Convert a RawConfig object into a Pkl source string.
 *
 * The output is intended to be written as `agent-sandbox.global.pkl`
 * so that user `.pkl` files can amend it.
 */
export function rawConfigToPklSource(raw: RawConfig): string {
  const lines = objectToLines(raw as Record<string, unknown>, 0);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** Determine whether a key needs bracket quoting in Pkl. */
function needsBracketKey(key: string): boolean {
  return !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key);
}

/** Format a key for Pkl output. */
function formatKey(key: string): string {
  return needsBracketKey(key) ? `["${escapeString(key)}"]` : key;
}

/** Escape a string value for Pkl string literals. */
function escapeString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/** Convert a primitive or composite value to a Pkl expression string. */
function valueToPkl(val: unknown, _indent: number): string {
  if (typeof val === "string") {
    return `"${escapeString(val)}"`;
  }
  if (typeof val === "number" || typeof val === "boolean") {
    return String(val);
  }
  return String(val);
}

/** Convert an array to a `new Listing { ... }` expression. */
function arrayToPkl(arr: unknown[], indent: number): string {
  if (arr.length === 0) {
    return "new Listing {}";
  }
  const prefix = "  ".repeat(indent + 1);
  const closing = "  ".repeat(indent);
  const items = arr
    .filter((item) => item !== null && item !== undefined)
    .map((item) => {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const innerLines = objectToLines(
          item as Record<string, unknown>,
          indent + 2,
        );
        if (innerLines.length === 0) {
          return `${prefix}new {}`;
        }
        return `${prefix}new {\n${innerLines.join("\n")}\n${prefix}}`;
      }
      return `${prefix}${valueToPkl(item, indent + 1)}`;
    });
  return `new Listing {\n${items.join("\n")}\n${closing}}`;
}

/**
 * Convert an object's entries into Pkl property lines.
 *
 * Each returned line is already indented to `indent` level.
 */
function objectToLines(obj: Record<string, unknown>, indent: number): string[] {
  const lines: string[] = [];
  const prefix = "  ".repeat(indent);

  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) {
      continue;
    }

    const fkey = formatKey(key);

    if (Array.isArray(val)) {
      lines.push(`${prefix}${fkey} = ${arrayToPkl(val, indent)}`);
    } else if (typeof val === "object") {
      const innerLines = objectToLines(
        val as Record<string, unknown>,
        indent + 1,
      );
      if (innerLines.length === 0) {
        // Empty object block
        lines.push(`${prefix}${fkey} {}`);
      } else {
        lines.push(`${prefix}${fkey} {`);
        lines.push(...innerLines);
        lines.push(`${prefix}}`);
      }
    } else {
      lines.push(`${prefix}${fkey} = ${valueToPkl(val, indent)}`);
    }
  }

  return lines;
}
