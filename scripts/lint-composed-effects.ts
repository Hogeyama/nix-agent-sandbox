#!/usr/bin/env bun

/**
 * lint-composed-effects: flag functions that mix IO primitives with effect
 * composition inside a single body. Implements the "D2 must not call IO
 * primitives" rule from skills/effect-separation/SKILL.md.
 *
 * A function is reported when its direct body contains BOTH:
 *   - a primitive call (proc.exec/spawn, fs.*, docker.*, Bun.spawn/write, gitExec, ...)
 *   - a helper composition call (yield* identifier(...) where identifier is
 *     NOT one of the primitive patterns)
 *
 * "Direct body" means the function's own statements; we do not descend into
 * nested function literals because those are analyzed as separate units.
 */

import * as path from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";

// ----- Configuration --------------------------------------------------------

const PRIMITIVE_MEMBERS: Record<string, "any" | string[]> = {
  proc: ["exec", "spawn"],
  fs: "any",
  docker: "any",
  Bun: ["spawn", "write"],
};

const PRIMITIVE_IDENTIFIERS = new Set(["gitExec"]);

const DEFAULT_GLOBS = ["src/services/**/*.ts"];
const EXCLUDE_SUFFIXES = ["_test.ts", ".test.ts"];

// ----- Types ----------------------------------------------------------------

interface CallSite {
  display: string;
  line: number;
}

interface Finding {
  file: string;
  fnName: string;
  fnLine: number;
  primitives: CallSite[];
  helpers: CallSite[];
}

// ----- Core -----------------------------------------------------------------

function isPrimitiveCall(expr: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    const obj = expr.expression.text;
    const allowed = PRIMITIVE_MEMBERS[obj];
    if (allowed === "any") return `${obj}.${expr.name.text}`;
    if (Array.isArray(allowed) && allowed.includes(expr.name.text)) {
      return `${obj}.${expr.name.text}`;
    }
  }
  if (ts.isIdentifier(expr) && PRIMITIVE_IDENTIFIERS.has(expr.text)) {
    return expr.text;
  }
  return null;
}

/** Extract identifier text from a helper call expression (not a primitive). */
function helperCallName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) {
    if (PRIMITIVE_IDENTIFIERS.has(expr.text)) return null;
    // Skip common Effect API entry points that aren't helper composition.
    if (expr.text === "Effect") return null;
    return expr.text;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    // yield* this.something(...) or yield* svc.method(...). Only flag when
    // the receiver is NOT a primitive service; in that case the member call
    // was already caught by isPrimitiveCall() and we won't reach here.
    return null;
  }
  return null;
}

function lineOf(node: ts.Node, sf: ts.SourceFile): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/**
 * Return a displayable name for a function-like node. Uses the nearest named
 * ancestor (VariableDeclaration, FunctionDeclaration, MethodDeclaration,
 * PropertyAssignment) when the node itself is anonymous.
 */
function functionDisplayName(node: ts.Node): string {
  const self = node as ts.FunctionLikeDeclaration;
  if (self.name && ts.isIdentifier(self.name)) {
    return self.name.text;
  }
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) {
      return `${cur.name.text} (inner)`;
    }
    if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) {
      return `${cur.name.text} (inner)`;
    }
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
      return `${cur.name.text} (inner)`;
    }
    if (ts.isPropertyAssignment(cur) && ts.isIdentifier(cur.name)) {
      return `${cur.name.text} (inner)`;
    }
    cur = cur.parent;
  }
  return "<anonymous>";
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/**
 * Walk the body of `fn` collecting direct (non-nested) call sites. Returns
 * both primitive and helper call sites grouped.
 */
function analyzeFunction(
  fn: ts.FunctionLikeDeclaration,
  sf: ts.SourceFile,
): { primitives: CallSite[]; helpers: CallSite[] } {
  const primitives: CallSite[] = [];
  const helpers: CallSite[] = [];
  const body = fn.body;
  if (!body) return { primitives, helpers };

  const visit = (node: ts.Node): void => {
    // Do not descend into nested function literals — they are separate units.
    if (node !== fn && isFunctionLike(node)) return;

    if (ts.isCallExpression(node)) {
      const prim = isPrimitiveCall(node.expression);
      if (prim !== null) {
        primitives.push({ display: prim, line: lineOf(node, sf) });
      } else if (isInsideYieldStar(node)) {
        const helper = helperCallName(node.expression);
        if (helper !== null) {
          helpers.push({ display: helper, line: lineOf(node, sf) });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(body);
  return { primitives, helpers };
}

function isInsideYieldStar(call: ts.CallExpression): boolean {
  const p = call.parent;
  return (
    p !== undefined &&
    ts.isYieldExpression(p) &&
    p.asteriskToken !== undefined &&
    p.expression === call
  );
}

function analyzeFile(file: string): Finding[] {
  const source = Bun.file(file);
  // Bun.file is async; use sync read via Node fs through typescript's own reader.
  const text = ts.sys.readFile(file);
  if (text === undefined) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];

  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      const { primitives, helpers } = analyzeFunction(node, sf);
      if (primitives.length > 0 && helpers.length > 0) {
        findings.push({
          file,
          fnName: functionDisplayName(node),
          fnLine: lineOf(node, sf),
          primitives,
          helpers,
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  // Silence unused-variable warning while keeping Bun import available for
  // future features (e.g. streaming output).
  void source;
  return findings;
}

// ----- CLI ------------------------------------------------------------------

interface CliOptions {
  patterns: string[];
  json: boolean;
  strict: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const patterns: string[] = [];
  let json = false;
  let strict = false;
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else if (arg === "--strict") strict = true;
    else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith("-")) {
      console.error(`unknown flag: ${arg}`);
      process.exit(2);
    } else {
      patterns.push(arg);
    }
  }
  return {
    patterns: patterns.length > 0 ? patterns : DEFAULT_GLOBS,
    json,
    strict,
  };
}

function printHelp(): void {
  console.log(`Usage: bun scripts/lint-composed-effects.ts [--json] [--strict] [glob ...]

Scans service files for functions that mix IO primitives with effect
composition. Default glob: ${DEFAULT_GLOBS.join(" ")}

Options:
  --json     Emit findings as JSON.
  --strict   Exit with code 1 when any finding is reported.
`);
}

async function collectFiles(patterns: string[]): Promise<string[]> {
  const cwd = process.cwd();
  const out = new Set<string>();
  for (const p of patterns) {
    const glob = new Glob(p);
    for await (const rel of glob.scan({ cwd, onlyFiles: true })) {
      if (EXCLUDE_SUFFIXES.some((s) => rel.endsWith(s))) continue;
      out.add(path.resolve(cwd, rel));
    }
  }
  return [...out].sort();
}

function formatText(findings: Finding[]): string {
  if (findings.length === 0) return "no violations\n";
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }
  const lines: string[] = [];
  const cwd = process.cwd();
  for (const [file, fs] of byFile) {
    lines.push(path.relative(cwd, file));
    for (const f of fs) {
      lines.push(`  ${f.fnName} @ L${f.fnLine}`);
      lines.push(`    primitives: ${summarize(f.primitives)}`);
      lines.push(`    helpers:    ${summarize(f.helpers)}`);
    }
    lines.push("");
  }
  lines.push(`${findings.length} violation(s) in ${byFile.size} file(s)`);
  return `${lines.join("\n")}\n`;
}

function summarize(sites: CallSite[]): string {
  const counts = new Map<string, number[]>();
  for (const s of sites) {
    const arr = counts.get(s.display) ?? [];
    arr.push(s.line);
    counts.set(s.display, arr);
  }
  return [...counts]
    .map(([name, lines]) => `${name} (${lines.length}x @ L${lines.join(",L")})`)
    .join(", ");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const files = await collectFiles(opts.patterns);
  const findings: Finding[] = [];
  for (const f of files) findings.push(...analyzeFile(f));

  if (opts.json) {
    console.log(JSON.stringify({ findings }, null, 2));
  } else {
    process.stdout.write(formatText(findings));
  }
  if (opts.strict && findings.length > 0) process.exit(1);
}

await main();
