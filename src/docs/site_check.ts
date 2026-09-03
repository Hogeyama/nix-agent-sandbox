import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { parse } from "parse5";

export interface SiteCheckOptions {
  siteDir: string;
  basePath: string;
  readme?: { path: string; minLines: number; maxLines: number };
}

interface ReferenceTarget {
  file: string;
  fragment: string;
}

export async function collectSiteErrors(
  options: SiteCheckOptions,
): Promise<string[]> {
  const siteDir = resolve(options.siteDir);
  const files = await listFiles(siteDir);
  const htmlFiles = files.filter((file) => file.endsWith(".html"));
  const errors = new Set<string>();
  const documentIds = new Map<string, Set<string>>();

  for (const htmlFile of htmlFiles) {
    const contents = await readFile(htmlFile, "utf8");
    const source = displayPath(siteDir, htmlFile);

    for (const reference of extractReferences(contents)) {
      if (isRootRelativeOutsideBasePath(reference, options.basePath)) {
        errors.add(
          `${source}: root-relative reference is outside base path ${reference}`,
        );
        continue;
      }

      const target = resolveReference({
        reference,
        sourceFile: htmlFile,
        siteDir,
        basePath: options.basePath,
      });

      if (target === undefined) continue;

      if (!isWithin(siteDir, target.file)) {
        errors.add(`${source}: target escapes site directory ${reference}`);
        continue;
      }

      if (!(await isFile(target.file))) {
        errors.add(
          `${source}: missing target ${displayPath(siteDir, target.file)}`,
        );
        continue;
      }

      if (target.fragment !== "" && target.file.endsWith(".html")) {
        let ids = documentIds.get(target.file);
        if (ids === undefined) {
          ids = extractIds(await readFile(target.file, "utf8"));
          documentIds.set(target.file, ids);
        }

        if (!ids.has(target.fragment)) {
          errors.add(
            `${source}: missing fragment #${target.fragment} in ${displayPath(siteDir, target.file)}`,
          );
        }
      }
    }
  }

  if (!(await isFile(resolve(siteDir, "pagefind/pagefind.js")))) {
    errors.add("site: missing Pagefind JavaScript pagefind/pagefind.js");
  }

  const pagefindDirectory = resolve(siteDir, "pagefind");
  if (
    !files.some(
      (file) => isWithin(pagefindDirectory, file) && file.endsWith(".pf_index"),
    )
  ) {
    errors.add("site: missing Pagefind index shard (*.pf_index)");
  }

  if (options.readme !== undefined) {
    const contents = await readFile(options.readme.path, "utf8");
    const lines =
      contents === ""
        ? 0
        : contents.split(/\r?\n/).length - (/\r?\n$/.test(contents) ? 1 : 0);
    if (lines < options.readme.minLines || lines > options.readme.maxLines) {
      errors.add(
        `README: expected ${options.readme.minLines}-${options.readme.maxLines} lines, found ${lines}`,
      );
    }
  }

  return [...errors].sort();
}

async function listFiles(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    }),
  );
  return files.flat().sort();
}

function extractReferences(html: string): string[] {
  return extractAttributeValues(html, new Set(["href", "src"]));
}

function resolveReference({
  reference,
  sourceFile,
  siteDir,
  basePath,
}: {
  reference: string;
  sourceFile: string;
  siteDir: string;
  basePath: string;
}): ReferenceTarget | undefined {
  const trimmed = reference.trim();
  if (
    trimmed === "" ||
    trimmed.startsWith("//") ||
    /^(?:https?:|mailto:|data:)/i.test(trimmed)
  ) {
    return undefined;
  }

  const hashIndex = trimmed.indexOf("#");
  const beforeFragment =
    hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex);
  const fragment =
    hashIndex === -1 ? "" : decodeSafely(trimmed.slice(hashIndex + 1));
  const queryIndex = beforeFragment.indexOf("?");
  const path = decodeSafely(
    queryIndex === -1 ? beforeFragment : beforeFragment.slice(0, queryIndex),
  );

  const strippedPath = stripBasePath(path, basePath);
  const resolvedPath =
    strippedPath === ""
      ? sourceFile
      : resolve(
          strippedPath.startsWith("/") ? siteDir : dirname(sourceFile),
          strippedPath.startsWith("/") ? strippedPath.slice(1) : strippedPath,
        );
  const file = isRoute(path, strippedPath)
    ? resolve(resolvedPath, "index.html")
    : resolvedPath;

  return { file, fragment };
}

function isRootRelativeOutsideBasePath(
  reference: string,
  basePath: string,
): boolean {
  const trimmed = reference.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return false;

  const suffixIndex = trimmed.search(/[?#]/);
  const path = suffixIndex === -1 ? trimmed : trimmed.slice(0, suffixIndex);
  const normalizedBase = normalizeBasePath(basePath);

  return (
    normalizedBase !== "/" &&
    path !== normalizedBase &&
    !path.startsWith(`${normalizedBase}/`)
  );
}

function stripBasePath(path: string, basePath: string): string {
  if (!path.startsWith("/")) return path;

  const normalizedBase = normalizeBasePath(basePath);
  if (path === normalizedBase) return "/";
  if (path.startsWith(`${normalizedBase}/`))
    return path.slice(normalizedBase.length);
  return path;
}

function normalizeBasePath(basePath: string): string {
  const path = basePath.replace(/^\/+|\/+$/g, "");
  return path === "" ? "/" : `/${path}`;
}

function isRoute(path: string, strippedPath: string): boolean {
  if (strippedPath === "") return false;
  return path.endsWith("/") || extname(basename(strippedPath)) === "";
}

function extractIds(html: string): Set<string> {
  return new Set(extractAttributeValues(html, new Set(["id"])));
}

function extractAttributeValues(
  html: string,
  names: ReadonlySet<string>,
): string[] {
  const values: string[] = [];
  visitHtmlNode(parse(html), names, values);
  return values;
}

function visitHtmlNode(
  node: { attrs?: { name: string; value: string }[]; childNodes?: unknown[] },
  names: ReadonlySet<string>,
  values: string[],
): void {
  for (const attribute of node.attrs ?? []) {
    if (names.has(attribute.name)) values.push(attribute.value);
  }

  for (const child of node.childNodes ?? []) {
    visitHtmlNode(
      child as {
        attrs?: { name: string; value: string }[];
        childNodes?: unknown[];
      },
      names,
      values,
    );
  }
}

function decodeSafely(value: string): string {
  return value.replace(/(?:%[\da-f]{2})+/gi, (encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  });
}

function isWithin(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

function displayPath(siteDir: string, path: string): string {
  return relative(siteDir, path).replaceAll("\\", "/");
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR"
    ) {
      return false;
    }
    throw error;
  }
}
