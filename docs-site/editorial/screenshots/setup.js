async (page) => {
  const sessionId = "sess_docs_example";
  const createdAt = new Date().toISOString();
  const events = {
    containers: {
      items: [
        {
          name: "nas-agent-sess_docs_example",
          running: true,
          sessionId,
          sessionName: "web-preview",
          sessionProfile: "claude",
          sessionAgent: "claude",
          turn: "user-turn",
          labels: { "nas.kind": "agent", "nas.pwd": "/work/example-app" },
        },
      ],
    },
    "network:pending": {
      items: [
        {
          sessionId,
          requestId: "req_network_example",
          createdAt,
          method: "GET",
          target: { host: "registry.npmjs.org", port: 443 },
          reviewContext: { path: "/vite", contentType: null, bodySize: 0 },
          ruleId: "npm-packages",
          askReason: "rule",
          approvalScopes: ["once", "rule"],
        },
      ],
    },
    "hostexec:pending": {
      items: [
        {
          sessionId,
          requestId: "req_hostexec_example",
          createdAt,
          argv0: "/usr/bin/uptime",
          args: [],
          cwd: "/work/example-app",
          ruleId: "host-uptime",
          defaultScope: "once",
          capability: {
            ruleId: "host-uptime",
            argv0: "/usr/bin/uptime",
            normalizedArgv: ["/usr/bin/uptime"],
            normalizedCwd: "/work/example-app",
            envBindings: [],
            inheritEnv: { mode: "minimal", keys: [] },
          },
        },
      ],
    },
    "port-bindings": {
      items: [
        {
          sessionId,
          bindings: [{ containerPort: 3000, hostPort: 3000, createdAt }],
        },
      ],
    },
    "terminal:sessions": {
      items: [
        {
          sessionId,
          name: "claude",
          socketPath: "/tmp/docs-example.sock",
          createdAt: Date.now(),
        },
      ],
    },
    "audit:logs": { items: [] },
    sessions: { network: [], hostexec: [] },
  };

  const audit = [
    {
      id: "audit_docs_deny",
      timestamp: createdAt,
      domain: "network",
      sessionId,
      requestId: "req_docs_denied",
      decision: "deny",
      reason: "no matching scope",
      target: "GET https://example.com:443/docs",
    },
    {
      id: "audit_docs_allow",
      timestamp: createdAt,
      domain: "hostexec",
      sessionId,
      requestId: "req_docs_allowed",
      decision: "allow",
      reason: "approved once",
      command: "/usr/bin/uptime",
    },
  ];
  events["audit:logs"] = { items: audit };
  const history = {
    conversations: [
      {
        id: "conv_docs_example",
        agent: "claude",
        firstSeenAt: createdAt,
        lastSeenAt: createdAt,
        turnCount: 3,
        spanCount: 12,
        invocationCount: 1,
        inputTokensTotal: 8000,
        outputTokensTotal: 2400,
        cacheReadTotal: 12000,
        cacheWriteTotal: 1000,
        summary: "Add a settings page to example-app",
        worktreePath: "/work/example-app",
      },
    ],
    modelTokenTotals: [],
    conversationModelTokenTotals: {},
    since: createdAt,
  };
  await page.unrouteAll();
  await page.route("**/api/**", (route) => {
    const path = route.request().url().split("3939")[1].split("?")[0];
    const json = path.endsWith("/candidates")
      ? {
          candidates: [
            { containerPort: 5173, scope: "loopback", reachable: true },
          ],
          watch: "watching",
        }
      : path === "/api/launch/info"
        ? {
            dtachAvailable: true,
            profiles: ["claude", "codex"],
            defaultProfile: "claude",
            recentDirectories: ["/work/example-app"],
          }
        : path === "/api/launch/branches"
          ? { currentBranch: "main", hasMain: true }
          : path === "/api/info"
            ? { home: "/home/demo" }
            : path === "/api/audit"
              ? { items: audit, hasMore: false }
              : path === "/api/pricing/snapshot"
                ? {
                    status: "unavailable",
                    source: "unavailable",
                    models: {},
                    fetched_at: createdAt,
                  }
                : path === "/api/terminal/sessions"
                  ? events["terminal:sessions"]
                  : { items: [], ok: true };
    return route.fulfill({ json });
  });
  await page.addInitScript(
    ({ events, history }) => {
      class ExampleEventSource extends EventTarget {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSED = 2;
        readyState = 1;
        onopen = null;
        onmessage = null;
        onerror = null;
        constructor(url) {
          super();
          this.url = url;
          this.timer = setTimeout(() => {
            this.onopen?.(new Event("open"));
            this.dispatchEvent(new Event("open"));
            const payloads = url.includes("/history/")
              ? { "history:list": history }
              : events;
            for (const [name, data] of Object.entries(payloads))
              this.dispatchEvent(
                new MessageEvent(name, { data: JSON.stringify(data) }),
              );
          }, 100);
        }
        close() {
          clearTimeout(this.timer);
          this.readyState = 2;
        }
      }
      window.EventSource = ExampleEventSource;
    },
    { events, history },
  );
  await page.routeWebSocket("**/api/terminal/**", (ws) => {
    let sent = false;
    ws.onMessage(() => {
      if (!sent) {
        sent = true;
        ws.send(
          "Example session — documentation screenshot\r\n\r\n> Add a settings page to example-app.\r\n\r\nThe development server is running on port 3000.\r\nOpen the localhost link in Ports · in to review it.\r\n\r\nA package request is waiting for network approval.\r\n",
        );
      }
    });
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("http://localhost:3939/");
  await page.getByText("web-preview", { exact: true }).first().waitFor();
  await page.getByText("web-preview", { exact: true }).first().click();
}
