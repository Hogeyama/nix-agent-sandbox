import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import {
  mkdir,
  mkdtemp,
  readFile as readFileBytes,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  authorized: boolean;
}

interface ProxyFixture {
  upstreamPort: number;
  proxyPort: number;
  proxyRequests: RecordedRequest[];
  upstreamRequests: RecordedRequest[];
}

interface RunningServer {
  abortController: AbortController;
  port: number;
  finished: Promise<void>;
}

const PROXY_USER = "nas";
const PROXY_PASSWORD = "secret";
const EXPECTED_PROXY_AUTH = `Basic ${
  Buffer.from(`${PROXY_USER}:${PROXY_PASSWORD}`).toString("base64")
}`;

const curlAvailable = await commandExists("curl");
const gitAvailable = await commandExists("git");

async function commandExists(command: string): Promise<boolean> {
  try {
    const exitCode = await Bun.spawn([command, "--version"], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
  } = {},
): Promise<CommandResult> {
  const proc = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: options.cwd,
    env: options.env,
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function withProxyFixture(
  fn: (fixture: ProxyFixture) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(path.join(tmpdir(), "nas-client-compat-"));
  const proxyRequests: RecordedRequest[] = [];
  const upstreamRequests: RecordedRequest[] = [];

  try {
    await writeFile(
      path.join(rootDir, "hello.txt"),
      "hello through proxy\n",
    );
    await createBareRepo(rootDir);

    const upstreamServer = startServer((request) =>
      handleUpstreamRequest(rootDir, upstreamRequests, request)
    );

    const proxyServer = startServer((request) =>
      handleProxyRequest(proxyRequests, request)
    );

    try {
      await fn({
        upstreamPort: upstreamServer.port,
        proxyPort: proxyServer.port,
        proxyRequests,
        upstreamRequests,
      });
    } finally {
      await closeServer(proxyServer);
      await closeServer(upstreamServer);
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function createBareRepo(rootDir: string): Promise<void> {
  const workDir = path.join(rootDir, "work");
  const repoDir = path.join(rootDir, "repo.git");
  const gitHome = path.join(rootDir, "git-home");
  await mkdir(workDir, { recursive: true });
  await mkdir(gitHome, { recursive: true });
  const gitEnv = isolatedGitEnv(gitHome);

  await runChecked("git", ["init", workDir], { env: gitEnv });
  await runChecked("git", ["-C", workDir, "checkout", "-b", "main"], {
    env: gitEnv,
  });
  await runChecked("git", ["-C", workDir, "config", "user.name", "nas-test"], {
    env: gitEnv,
  });
  await runChecked("git", [
    "-C",
    workDir,
    "config",
    "user.email",
    "nas-test@example.com",
  ], { env: gitEnv });
  await writeFile(
    path.join(workDir, "README.md"),
    "# nas client compat\n",
  );
  await runChecked("git", ["-C", workDir, "add", "README.md"], { env: gitEnv });
  await runChecked("git", [
    "-C",
    workDir,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "init",
  ], { env: gitEnv });

  await runChecked("git", ["init", "--bare", repoDir], { env: gitEnv });
  await runChecked("git", ["-C", workDir, "remote", "add", "origin", repoDir], {
    env: gitEnv,
  });
  await runChecked("git", [
    "-C",
    workDir,
    "push",
    "origin",
    "HEAD:refs/heads/main",
  ], { env: gitEnv });
  await runChecked("git", [
    "--git-dir",
    repoDir,
    "symbolic-ref",
    "HEAD",
    "refs/heads/main",
  ], { env: gitEnv });
  await runChecked("git", ["--git-dir", repoDir, "update-server-info"], {
    env: gitEnv,
  });
}

async function runChecked(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
  } = {},
): Promise<void> {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${command} ${
        args.join(" ")
      } failed with ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

async function handleProxyRequest(
  proxyRequests: RecordedRequest[],
  request: Request,
): Promise<Response> {
  const authHeader = request.headers.get("proxy-authorization");
  proxyRequests.push({
    method: request.method,
    url: request.url,
    headers: normalizeHeaders(request.headers),
    authorized: authHeader === EXPECTED_PROXY_AUTH,
  });

  if (authHeader !== EXPECTED_PROXY_AUTH) {
    return new Response("proxy auth required", {
      status: 407,
      headers: { "Proxy-Authenticate": 'Basic realm="nas"' },
    });
  }

  let targetUrl: URL;
  try {
    targetUrl = parseTargetUrl(request);
  } catch (error) {
    return new Response((error as Error).message, { status: 400 });
  }

  const forwardedHeaders = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (key === "proxy-authorization" || key === "proxy-connection") continue;
    forwardedHeaders.set(key, value);
  }

  const upstreamResponse = await fetch(targetUrl, {
    method: request.method,
    headers: forwardedHeaders,
  });
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: upstreamResponse.headers,
  });
}

async function handleUpstreamRequest(
  rootDir: string,
  upstreamRequests: RecordedRequest[],
  request: Request,
): Promise<Response> {
  const target = new URL(request.url);
  upstreamRequests.push({
    method: request.method,
    url: `${target.pathname}${target.search}`,
    headers: normalizeHeaders(request.headers),
    authorized:
      request.headers.get("proxy-authorization") === EXPECTED_PROXY_AUTH,
  });

  const filePath = path.join(rootDir, decodeURIComponent(target.pathname));
  if (!isPathInsideRoot(rootDir, filePath)) {
    return new Response("forbidden", { status: 403 });
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      return new Response("not found", { status: 404 });
    }
    const data = await readFileBytes(filePath);
    return new Response(data, { status: 200 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Response("not found", { status: 404 });
    }
    return new Response((error as Error).message, { status: 500 });
  }
}

function parseTargetUrl(request: Request): URL {
  if (request.url.startsWith("http://") || request.url.startsWith("https://")) {
    return new URL(request.url);
  }
  const host = request.headers.get("host");
  if (!host) {
    throw new Error("missing host header");
  }
  return new URL(`http://${host}${request.url}`);
}

function normalizeHeaders(
  headers: Headers,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    normalized[key] = value;
  }
  return normalized;
}

function isPathInsideRoot(rootDir: string, target: string): boolean {
  const relative = path.relative(rootDir, target);
  return target === rootDir ||
    (relative !== "" && !relative.startsWith("..") &&
      !path.isAbsolute(relative));
}

function startServer(
  handler: (request: Request) => Response | Promise<Response>,
): RunningServer {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: handler,
  });
  return {
    abortController: {
      abort() {
        server.stop();
      },
    } as AbortController,
    port: server.port!,
    finished: Promise.resolve(),
  };
}

async function closeServer(server: RunningServer): Promise<void> {
  server.abortController.abort();
  await server.finished;
}

function cleanClientEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    ...process.env,
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    all_proxy: "",
    NO_PROXY: "",
    no_proxy: "",
    ...extra,
  };
}

function isolatedGitEnv(homeDir: string): Record<string, string> {
  return cleanClientEnv({
    HOME: homeDir,
    XDG_CONFIG_HOME: homeDir,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
    GIT_TERMINAL_PROMPT: "0",
  });
}

function assertRetriedWithProxyAuth(requests: RecordedRequest[]): void {
  const byUrl = new Map<string, { authorized: number; unauthorized: number }>();
  for (const request of requests) {
    const entry = byUrl.get(request.url) ?? { authorized: 0, unauthorized: 0 };
    if (request.authorized) {
      entry.authorized += 1;
    } else {
      entry.unauthorized += 1;
    }
    byUrl.set(request.url, entry);
  }

  const retried = Array.from(byUrl.values()).some((entry) =>
    entry.authorized > 0 && entry.unauthorized > 0
  );
  expect(retried).toEqual(true);
}

function assertNoProxyAuthLeak(requests: RecordedRequest[]): void {
  expect(requests.length > 0).toEqual(true);
  for (const request of requests) {
    expect(request.headers["proxy-authorization"]).toBeUndefined();
  }
}

test.skipIf(!curlAvailable)(
  "Client compatibility: curl retries after 407 and does not leak proxy credentials upstream",
  async () => {
    await withProxyFixture(
      async ({ proxyPort, upstreamPort, proxyRequests, upstreamRequests }) => {
        const result = await runCommand(
          "curl",
          [
            "--silent",
            "--show-error",
            "--fail",
            "--noproxy",
            "",
            "--proxy",
            `http://127.0.0.1:${proxyPort}`,
            "--proxy-user",
            `${PROXY_USER}:${PROXY_PASSWORD}`,
            "--proxy-anyauth",
            `http://127.0.0.1:${upstreamPort}/hello.txt`,
          ],
          { env: cleanClientEnv() },
        );

        expect(result.code).toEqual(0);
        expect(result.stdout.trim()).toEqual("hello through proxy");
        assertRetriedWithProxyAuth(proxyRequests);
        assertNoProxyAuthLeak(upstreamRequests);
      },
    );
  },
);

test.skipIf(!gitAvailable)(
  "Client compatibility: git retries after 407 and does not leak proxy credentials upstream",
  async () => {
    await withProxyFixture(
      async ({ proxyPort, upstreamPort, proxyRequests, upstreamRequests }) => {
        const homeDir = await mkdtemp(path.join(tmpdir(), "nas-git-home-"));
        try {
          const result = await runCommand(
            "git",
            [
              "-c",
              "credential.helper=",
              "-c",
              `http.proxy=http://${PROXY_USER}:${PROXY_PASSWORD}@127.0.0.1:${proxyPort}`,
              "-c",
              "http.proxyAuthMethod=anyauth",
              "ls-remote",
              `http://127.0.0.1:${upstreamPort}/repo.git`,
            ],
            {
              env: cleanClientEnv({
                HOME: homeDir,
                XDG_CONFIG_HOME: homeDir,
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_TERMINAL_PROMPT: "0",
              }),
            },
          );

          expect(result.code).toEqual(0);
          expect(result.stdout).toMatch(/refs\/heads\/main/);
          assertRetriedWithProxyAuth(proxyRequests);
          assertNoProxyAuthLeak(upstreamRequests);
        } finally {
          await rm(homeDir, { recursive: true, force: true }).catch(() => {});
        }
      },
    );
  },
);
