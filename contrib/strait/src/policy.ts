// Request policy evaluated by srt's filterRequest hook.
//
// Pure: no srt import, no I/O, no body reads. Anything not explicitly allowed
// here is denied, and srt itself denies when this throws.

export type Decision = { action: "allow" | "deny"; reason?: string };

export interface PolicyRequest {
  method: string;
  url: string;
  headers: Headers;
}

/**
 * Sentinels srt substituted for the real credentials inside the sandbox.
 * A request may carry a credential only in the exact shape strait itself set
 * up, so a token the sandboxed program brought along never reaches upstream.
 */
export interface Sentinels {
  /** `GH_TOKEN`, sent by gh as `token <s>` or `Bearer <s>`. */
  githubToken?: string;
  /** Whole `Authorization` value for git over HTTPS (`Basic …`). */
  gitAuthorization?: string;
  /** `CLAUDE_CODE_OAUTH_TOKEN`, sent as `Bearer <s>`. */
  anthropicOauth?: string;
  /** `ANTHROPIC_API_KEY`, sent as `x-api-key`. */
  anthropicApiKey?: string;
}

export interface PolicyConfig {
  /** `owner/name` pairs whose contents may be read. Compared case-insensitively. */
  githubRepos: readonly string[];
}

export const ANTHROPIC_HOST = "api.anthropic.com";
export const GITHUB_API_HOST = "api.github.com";
export const GITHUB_HOST = "github.com";
/** The only destinations the sandbox may reach, always on port 443. */
export const HOSTS = [ANTHROPIC_HOST, GITHUB_API_HOST, GITHUB_HOST] as const;

const allow: Decision = { action: "allow" };
const deny = (reason: string): Decision => ({ action: "deny", reason });

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

export function decide(
  req: PolicyRequest,
  config: PolicyConfig,
  sentinels: Sentinels,
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

  const credential = checkCredentials(req, url, sentinels);
  if (credential) return credential;

  const method = req.method.toUpperCase();
  switch (url.hostname) {
    case ANTHROPIC_HOST:
      return decideAnthropic(method, url.pathname);
    case GITHUB_API_HOST:
      return decideGithubApi(method, url.pathname, config);
    case GITHUB_HOST:
      return decideGit(method, url, config);
    default:
      return deny(`host ${url.hostname} is not allowed`);
  }
}

/** Returns a denial when the request carries a credential strait did not issue. */
function checkCredentials(
  req: PolicyRequest,
  url: URL,
  s: Sentinels,
): Decision | undefined {
  if (req.headers.has("cookie")) return deny("cookies are not forwarded");
  if (url.searchParams.has("access_token")) {
    return deny("credential in the query string");
  }

  const authorization = req.headers.get("authorization");
  if (authorization !== null) {
    const accepted = acceptedAuthorizations(url.hostname, s);
    if (!accepted.some((a) => sameAuthorization(authorization, a))) {
      return deny("Authorization was not issued by strait");
    }
  }

  const apiKey = req.headers.get("x-api-key");
  if (apiKey !== null) {
    const ok =
      url.hostname === ANTHROPIC_HOST &&
      s.anthropicApiKey !== undefined &&
      apiKey === s.anthropicApiKey;
    if (!ok) return deny("x-api-key was not issued by strait");
  }
  return undefined;
}

function acceptedAuthorizations(host: string, s: Sentinels): string[] {
  switch (host) {
    case GITHUB_API_HOST:
      return s.githubToken === undefined
        ? []
        : [`token ${s.githubToken}`, `Bearer ${s.githubToken}`];
    case GITHUB_HOST:
      return s.gitAuthorization === undefined ? [] : [s.gitAuthorization];
    case ANTHROPIC_HOST:
      return s.anthropicOauth === undefined
        ? []
        : [`Bearer ${s.anthropicOauth}`];
    default:
      return [];
  }
}

// The scheme is case-insensitive; the credential must match byte for byte.
// Duplicate headers arrive joined with ", " and so never match.
function sameAuthorization(got: string, expected: string): boolean {
  const g = splitScheme(got);
  const e = splitScheme(expected);
  if (g === undefined || e === undefined) return got === expected;
  return g.scheme.toLowerCase() === e.scheme.toLowerCase() && g.rest === e.rest;
}

function splitScheme(v: string): { scheme: string; rest: string } | undefined {
  const i = v.indexOf(" ");
  return i <= 0 ? undefined : { scheme: v.slice(0, i), rest: v.slice(i + 1) };
}

function decideAnthropic(method: string, path: string): Decision {
  for (const route of ANTHROPIC_ROUTES) {
    if (!route.methods.includes(method)) continue;
    if (route.paths.some((p) => matchPath(p, path))) return allow;
  }
  return deny(`${method} ${path} is not a Claude Code endpoint`);
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
    return deny(`${method} on the GitHub API is not allowed`);
  }
  // /repos/{owner}/{repo} and anything below it.
  const segs = path.split("/");
  if (segs[1] !== "repos" || segs.length < 4) {
    return deny(`${path} is outside /repos/{owner}/{repo}`);
  }
  return repoAllowed(segs[2], segs[3], config)
    ? allow
    : deny(`${segs[2]}/${segs[3]} is not an allowed repository`);
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
  if (!fetch) return deny(`only git fetch is allowed on ${GITHUB_HOST}`);
  return owner !== undefined &&
    repo !== undefined &&
    repoAllowed(owner, repo, config)
    ? allow
    : deny(`${owner}/${repo} is not an allowed repository`);
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
