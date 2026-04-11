/**
 * 最小限のHTTPルーター — Bun.serve() と直接組み合わせて使う
 */

export interface RouteContext {
  req: Request;
  params: Record<string, string>;
  url: URL;
}

export type RouteHandler = (ctx: RouteContext) => Response | Promise<Response>;

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function html(content: string, status = 200): Response {
  return new Response(content, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export function text(content: string, status = 200): Response {
  return new Response(content, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

function compilePath(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  if (path === "/") {
    return { pattern: /^\/$/, paramNames };
  }
  const segments = path.replace(/\/$/, "").split("/");
  const parts = segments.map((seg) => {
    if (seg.startsWith(":")) {
      paramNames.push(seg.slice(1));
      return "([^/]+)";
    }
    if (seg === "*") return "(.*)";
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return { pattern: new RegExp(`^${parts.join("/")}$`), paramNames };
}

export class Router {
  private routes: Route[] = [];
  private mounts: Array<{ prefix: string; router: Router }> = [];

  get(path: string, handler: RouteHandler): void {
    const { pattern, paramNames } = compilePath(path);
    this.routes.push({ method: "GET", pattern, paramNames, handler });
  }

  post(path: string, handler: RouteHandler): void {
    const { pattern, paramNames } = compilePath(path);
    this.routes.push({ method: "POST", pattern, paramNames, handler });
  }

  route(prefix: string, router: Router): void {
    this.mounts.push({ prefix, router });
  }

  private match(
    method: string,
    pathname: string,
    req: Request,
    url: URL,
  ): Response | Promise<Response> | null {
    for (const { prefix, router } of this.mounts) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
        const sub = pathname.slice(prefix.length) || "/";
        const result = router.match(method, sub, req, url);
        if (result !== null) return result;
      }
    }

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = pathname.match(route.pattern);
      if (!m) continue;
      const params: Record<string, string> = {};
      for (let i = 0; i < route.paramNames.length; i++) {
        params[route.paramNames[i]] = decodeURIComponent(m[i + 1]);
      }
      return route.handler({ req, params, url });
    }

    return null;
  }

  fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const result = this.match(req.method, url.pathname, req, url);
    if (result !== null) return result;
    return new Response("404 Not Found", { status: 404 });
  };

  async request(path: string, init?: RequestInit): Promise<Response> {
    const url = path.startsWith("http") ? path : `http://localhost${path}`;
    return this.fetch(new Request(url, init));
  }
}
