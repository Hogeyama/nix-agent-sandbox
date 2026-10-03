import type { CredentialHeaders } from "./credentials.ts";
// Request policy evaluated by srt's filterRequest hook.
//
// Pure: no srt import and no I/O. The caller reads the body only where
// `wantsBody` says the decision needs it, and passes it in as text. Anything
// not explicitly allowed here is denied, and srt itself denies when this
// throws.

import { judgeGraphql } from "./graphql.ts";
import {
  type ExecRequest,
  HOSTEXEC_HOST,
  HOSTEXEC_PATH,
  parseExecRequest,
} from "./hostexec.ts";

/**
 * `review` is a request that is outside the policy but carries only
 * credentials strait issued, so a human may let it through. Everything that
 * fails a transport or credential check is `deny`: no one is ever asked to
 * pass a foreign token or a request whose target GitHub would read
 * differently.
 */
export type Decision =
  | { action: "allow" | "deny"; reason?: string }
  | { action: "review"; reason: string; exec?: ExecRequest };

/** What srt enforces: a review ends in one of these. */
export type FinalDecision = Exclude<Decision, { action: "review" }>;

export interface PolicyRequest {
  method: string;
  url: string;
  headers: Headers;
  /**
   * The body as UTF-8 text, read only when `wantsBody` is true. null when it
   * was not read: over `BODY_LIMIT`, not UTF-8, or the read failed.
   */
  body?: string | null;
}

/** Largest body read for a decision. A larger one is never analysed. */
export const BODY_LIMIT = 256 * 1024;

/** A configured host, with the header strait owns when credentials exist. */
export interface HostRule {
  credential?: { header: string; scheme?: string };
}

export interface PolicyConfig {
  /** `owner/name` pairs whose contents may be read. Compared case-insensitively. */
  githubRepos: readonly string[];
  /** Whether HOSTEXEC_HOST takes requests to run commands on the host. */
  hostExec?: boolean;
  /** Hosts added in strait.json, by exact lowercase name. */
  hosts?: Readonly<Record<string, HostRule>>;
}

export const ANTHROPIC_HOST = "api.anthropic.com";
export const GITHUB_API_HOST = "api.github.com";
export const GITHUB_HOST = "github.com";
/** The only destinations the sandbox may reach, always on port 443. */
export const HOSTS = [ANTHROPIC_HOST, GITHUB_API_HOST, GITHUB_HOST] as const;

/**
 * Where Claude Code fetches a published Artifact's content: one host per
 * Artifact, `<id>.frame.claudeusercontent.com`. Every request there is held
 * for review, so it takes a wildcard in srt's allowlist; `isArtifactHost`
 * narrows that to exactly one label under the suffix.
 */
export const ARTIFACT_DOMAIN = "*.frame.claudeusercontent.com";
const ARTIFACT_SUFFIX = ARTIFACT_DOMAIN.slice(1);

export function isArtifactHost(host: string): boolean {
  if (!host.endsWith(ARTIFACT_SUFFIX)) return false;
  const label = host.slice(0, -ARTIFACT_SUFFIX.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
}

const allow: Decision = { action: "allow" };
const deny = (reason: string): Decision => ({ action: "deny", reason });
const review = (reason: string): Decision => ({ action: "review", reason });

// Claude Code's endpoints on api.anthropic.com, taken from nas's
// `presets.anthropic.v1`, plus `/api/model_selector/cc`, which Claude Code
// 2.1.284 requested under strait. `*` matches exactly one path segment.
const ANTHROPIC_ROUTES: ReadonlyArray<{ methods: string[]; paths: string[] }> =
  [
    {
      methods: ["POST"],
      paths: [
        "/v1/messages",
        "/v1/messages/count_tokens",
        "/api/event_logging/v2/batch",
        "/api/eval/*",
      ],
    },
    {
      methods: ["GET"],
      paths: [
        "/api/claude_cli/bootstrap",
        "/api/claude_code_grove",
        "/api/claude_code_penguin_mode",
        "/api/claude_code/policy_limits",
        "/api/claude_code/settings",
        "/api/oauth/account/settings",
        "/api/oauth/organizations/*/referral/eligibility",
        "/api/oauth/profile",
        "/api/oauth/usage",
        "/api/organizations/*/model_selector/cc",
        "/api/model_selector/cc",
        "/mcp-registry/v0/servers",
        "/v1/code/triggers",
        "/v1/mcp_servers",
        "/v1/ultrareview/quota",
      ],
    },
  ];

/** Whether `decide` looks at this request's body. */
export function wantsBody(method: string, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (method.toUpperCase() !== "POST") return false;
  return (
    (u.hostname === GITHUB_API_HOST && u.pathname === GRAPHQL_PATH) ||
    (u.hostname === HOSTEXEC_HOST && u.pathname === HOSTEXEC_PATH)
  );
}

const GRAPHQL_PATH = "/graphql";

export function decide(
  req: PolicyRequest,
  config: PolicyConfig,
  credentials: CredentialHeaders,
): Decision {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return deny("unparsable URL");
  }
  if (url.protocol !== "https:") return deny("only HTTPS is allowed");
  if (url.port !== "" && url.port !== "443") return deny("only port 443");
  if (url.username !== "" || url.password !== "") {
    return deny("credentials in the URL");
  }
  // srt forwards the request target byte for byte, while URL parsing resolves
  // `..`, `%2e` and `\`. Judge only targets the parser leaves unchanged, so the
  // path decided on is the path GitHub receives.
  const slash = req.url.indexOf("/", url.protocol.length + 2);
  const target = slash === -1 ? "/" : req.url.slice(slash);
  if (target !== url.pathname + url.search) {
    return deny("request target is not in canonical form");
  }

  const credential = checkCredentials(
    req,
    url,
    credentials,
    Object.hasOwn(config.hosts ?? {}, url.hostname)
      ? config.hosts?.[url.hostname]?.credential?.header
      : undefined,
  );
  if (credential) return credential;
  if (Object.hasOwn(config.hosts ?? {}, url.hostname)) return allow;

  const method = req.method.toUpperCase();
  switch (url.hostname) {
    case ANTHROPIC_HOST:
      return decideAnthropic(method, url.pathname);
    case GITHUB_API_HOST:
      if (method === "POST" && url.pathname === GRAPHQL_PATH) {
        return decideGraphql(req, url, config);
      }
      return decideGithubApi(method, url.pathname, config);
    case GITHUB_HOST:
      return decideGit(method, url, config);
    case HOSTEXEC_HOST:
      return config.hostExec
        ? decideHostExec(method, url, req)
        : deny("hostExec is off");
    default:
      // Anthropic serves Artifact content from here; a human decides each
      // fetch, since the host is Anthropic's but the content is anyone's.
      if (isArtifactHost(url.hostname)) {
        return review(`${method} on an Artifact content host`);
      }
      return deny(`host ${url.hostname} is not allowed`);
  }
}

/** Client auth is removable only where the host supplies credentials. */
function checkCredentials(
  req: PolicyRequest,
  url: URL,
  credentials: CredentialHeaders,
  configuredHeader?: string,
): Decision | undefined {
  if (req.headers.has("cookie")) return deny("cookies are not forwarded");
  if (url.searchParams.has("access_token")) {
    return deny("credential in the query string");
  }
  const header = Object.hasOwn(credentials, url.hostname)
    ? credentials[url.hostname]
    : undefined;
  for (const name of new Set([
    "authorization",
    "x-api-key",
    ...(configuredHeader ? [configuredHeader] : []),
  ])) {
    if (req.headers.has(name) && header === undefined) {
      return deny("no host credential configured");
    }
  }
  return undefined;
}

function decideAnthropic(method: string, path: string): Decision {
  for (const route of ANTHROPIC_ROUTES) {
    if (!route.methods.includes(method)) continue;
    if (route.paths.some((p) => matchPath(p, path))) return allow;
  }
  return review(`${method} ${path} is not a Claude Code endpoint`);
}

function matchPath(pattern: string, path: string): boolean {
  const p = pattern.split("/");
  const s = path.split("/");
  if (p.length !== s.length) return false;
  return p.every((seg, i) => (seg === "*" ? s[i] !== "" : seg === s[i]));
}

function decideGithubApi(
  method: string,
  path: string,
  config: PolicyConfig,
): Decision {
  if (method !== "GET" && method !== "HEAD") {
    return review(`${method} on the GitHub API is not allowed`);
  }
  // /repos/{owner}/{repo} and anything below it.
  const segs = path.split("/");
  if (segs[1] !== "repos" || segs.length < 4) {
    return review(`${path} is outside /repos/{owner}/{repo}`);
  }
  return repoAllowed(segs[2], segs[3], config)
    ? allow
    : review(`${segs[2]}/${segs[3]} is not an allowed repository`);
}

function decideGraphql(
  req: PolicyRequest,
  url: URL,
  config: PolicyConfig,
): Decision {
  // A query string could carry a second document; GitHub reads the body.
  if (url.search !== "") return deny("GraphQL with a query string");
  if (req.headers.has("content-encoding")) {
    return deny("GraphQL body is encoded");
  }
  if (!isJsonUtf8(req.headers.get("content-type"))) {
    return deny("GraphQL body is not application/json");
  }
  if (typeof req.body !== "string") return deny("GraphQL body was not read");
  let body: unknown;
  try {
    body = JSON.parse(req.body);
  } catch {
    return deny("GraphQL body is not JSON");
  }
  // JSON.parse keeps a duplicated member's last value; GitHub's parser need
  // not, so a query or owner judged here might not be the one executed.
  if (hasDuplicateMember(req.body)) {
    return deny("GraphQL body has a duplicated member");
  }
  const verdict = judgeGraphql(body, (owner, name) =>
    repoAllowed(owner, name, config),
  );
  return verdict.ok ? allow : review(verdict.reason);
}

// Every well-formed run goes to a human; there are no rules that allow one.
function decideHostExec(
  method: string,
  url: URL,
  req: PolicyRequest,
): Decision {
  if (
    method !== "POST" ||
    url.pathname !== HOSTEXEC_PATH ||
    url.search !== ""
  ) {
    return deny(`hostexec takes only POST ${HOSTEXEC_PATH}`);
  }
  if (req.headers.has("content-encoding")) {
    return deny("hostexec body is encoded");
  }
  if (typeof req.body !== "string") return deny("hostexec body was not read");
  let exec = parseExecRequest(req.body);
  // Only valid JSON reaches the duplicate scan, which relies on it.
  if (typeof exec !== "string" && hasDuplicateMember(req.body)) {
    exec = "hostexec body has a duplicated member";
  }
  if (typeof exec === "string") return deny(exec);
  return { action: "review", reason: "run a command on the host", exec };
}

/**
 * Whether any object in `text`, which must already be valid JSON, names the
 * same member twice. Validity lets the scan track only strings and brackets.
 */
export function hasDuplicateMember(text: string): boolean {
  const stack: { keys: Set<string> | null; expectKey: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const top = stack[stack.length - 1];
    if (c === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (c === "[") stack.push({ keys: null, expectKey: false });
    else if (c === "}" || c === "]") stack.pop();
    else if (c === "," && top?.keys) top.expectKey = true;
    else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        j += text[j] === "\\" ? 2 : 1;
      }
      if (top?.keys && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j;
    }
  }
  return false;
}

// `application/json`, optionally with `charset=utf-8`, and nothing else.
function isJsonUtf8(contentType: string | null): boolean {
  if (contentType === null) return false;
  const [type, ...params] = contentType.split(";").map((p) => p.trim());
  if (type?.toLowerCase() !== "application/json") return false;
  return params.every((p) => /^charset="?utf-8"?$/i.test(p));
}

function decideGit(method: string, url: URL, config: PolicyConfig): Decision {
  // /{owner}/{repo}[.git]/info/refs?service=git-upload-pack
  // /{owner}/{repo}[.git]/git-upload-pack
  const segs = url.pathname.split("/");
  const owner = segs[1];
  const repo = segs[2]?.replace(/\.git$/, "");
  const rest = segs.slice(3).join("/");

  let fetch = false;
  if (method === "GET" && rest === "info/refs") {
    const service = url.searchParams.getAll("service");
    fetch = service.length === 1 && service[0] === "git-upload-pack";
  } else if (method === "POST" && rest === "git-upload-pack") {
    fetch = true;
  }
  if (!fetch) return review(`only git fetch is allowed on ${GITHUB_HOST}`);
  return owner !== undefined &&
    repo !== undefined &&
    repoAllowed(owner, repo, config)
    ? allow
    : review(`${owner}/${repo} is not an allowed repository`);
}

function repoAllowed(
  owner: string,
  repo: string,
  config: PolicyConfig,
): boolean {
  // Percent-encoding would let two spellings name one repository.
  if (owner === "" || repo === "" || /%/.test(owner + repo)) return false;
  const want = `${owner}/${repo}`.toLowerCase();
  return config.githubRepos.some((r) => r.toLowerCase() === want);
}
