import { assertEquals, assertMatch } from "@std/assert";
import * as path from "@std/path";
import { Buffer } from "node:buffer";

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
    const output = await new Deno.Command(command, {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return output.success;
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
  const output = await new Deno.Command(command, {
    args,
    cwd: options.cwd,
    env: options.env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

async function withProxyFixture(
  fn: (fixture: ProxyFixture) => Promise<void>,
): Promise<void> {
  const rootDir = await Deno.makeTempDir({ prefix: "nas-client-compat-" });
  const proxyRequests: RecordedRequest[] = [];
  const upstreamRequests: RecordedRequest[] = [];

  try {
    await Deno.writeTextFile(
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
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
}

async function createBareRepo(rootDir: string): Promise<void> {
  const workDir = path.join(rootDir, "work");
  const repoDir = path.join(rootDir, "repo.git");
  await Deno.mkdir(workDir, { recursive: true });

  await runChecked("git", ["init", workDir]);
  await runChecked("git", ["-C", workDir, "checkout", "-b", "main"]);
  await runChecked("git", ["-C", workDir, "config", "user.name", "nas-test"]);
  await runChecked("git", [
    "-C",
    workDir,
    "config",
    "user.email",
    "nas-test@example.com",
  ]);
  await Deno.writeTextFile(
    path.join(workDir, "README.md"),
    "# nas client compat\n",
  );
  await runChecked("git", ["-C", workDir, "add", "README.md"]);
  await runChecked("git", ["-C", workDir, "commit", "-m", "init"]);

  await runChecked("git", ["init", "--bare", repoDir]);
  await runChecked("git", ["-C", workDir, "remote", "add", "origin", repoDir]);
  await runChecked("git", [
    "-C",
    workDir,
    "push",
    "origin",
    "HEAD:refs/heads/main",
  ]);
  await runChecked("git", [
    "--git-dir",
    repoDir,
    "symbolic-ref",
    "HEAD",
    "refs/heads/main",
  ]);
  await runChecked("git", ["--git-dir", repoDir, "update-server-info"]);
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
    const info = await Deno.stat(filePath);
    if (!info.isFile) {
      return new Response("not found", { status: 404 });
    }
    const data = await Deno.readFile(filePath);
    return new Response(data, { status: 200 });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
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
  const abortController = new AbortController();
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: abortController.signal,
    onListen: () => {},
  }, handler);
  const address = server.addr;
  if (address.transport !== "tcp") {
    throw new Error("expected tcp server");
  }
  return {
    abortController,
    port: address.port,
    finished: server.finished.catch(() => {}),
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
    ...Deno.env.toObject(),
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
  assertEquals(
    retried,
    true,
    `Expected proxy challenge and retry, saw ${
      JSON.stringify(requests, null, 2)
    }`,
  );
}

function assertNoProxyAuthLeak(requests: RecordedRequest[]): void {
  assertEquals(
    requests.length > 0,
    true,
    "Expected upstream requests to be recorded",
  );
  for (const request of requests) {
    assertEquals(request.headers["proxy-authorization"], undefined);
  }
}

Deno.test({
  name:
    "Client compatibility: curl retries after 407 and does not leak proxy credentials upstream",
  ignore: !curlAvailable,
  async fn() {
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

        assertEquals(result.code, 0, result.stderr);
        assertEquals(result.stdout.trim(), "hello through proxy");
        assertRetriedWithProxyAuth(proxyRequests);
        assertNoProxyAuthLeak(upstreamRequests);
      },
    );
  },
});

Deno.test({
  name:
    "Client compatibility: git retries after 407 and does not leak proxy credentials upstream",
  ignore: !gitAvailable,
  async fn() {
    await withProxyFixture(
      async ({ proxyPort, upstreamPort, proxyRequests, upstreamRequests }) => {
        const homeDir = await Deno.makeTempDir({ prefix: "nas-git-home-" });
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

          assertEquals(result.code, 0, result.stderr);
          assertMatch(result.stdout, /refs\/heads\/main/);
          assertRetriedWithProxyAuth(proxyRequests);
          assertNoProxyAuthLeak(upstreamRequests);
        } finally {
          await Deno.remove(homeDir, { recursive: true }).catch(() => {});
        }
      },
    );
  },
});
