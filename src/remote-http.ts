import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createRemoteHandler } from "./remote.js";

// Node's HTTP server in front of the Web-standard handler. The URL holds the agent
// capability (or a learning link's secret), so requests are never logged.
export type ServeHTTPOptions = { port: number; host: string; relay?: string; origin?: string; academyOrigin?: string;
  /** false: /mcp/academy and learning links (/mcp/learn/…) answer 503 (also CRABRIX_ACADEMY_MCP=off). Agent links are unaffected. */
  academy?: boolean };

/** `crabrix serve-http` arguments: value flags in pairs, plus --no-academy. null for an unknown flag. */
export function parseServeHTTPArgs(args: string[]): ServeHTTPOptions | null {
  const flags = new Map<string, string>();
  let academy = true;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--no-academy") { academy = false; continue; }
    flags.set(args[index], args[index + 1] ?? ""); index++;
  }
  if ([...flags.keys()].some(flag => !["--port", "--host", "--relay", "--academy-origin"].includes(flag))) return null;
  return { port: Number(flags.get("--port") ?? 8090), host: flags.get("--host") ?? "127.0.0.1", relay: flags.get("--relay"), academyOrigin: flags.get("--academy-origin"), academy };
}

export async function serveHTTP(options: ServeHTTPOptions) {
  const remote = createRemoteHandler({ origin: options.origin, relay: options.relay, academyOrigin: options.academyOrigin, academy: options.academy });
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.url === "/healthz") { res.end(JSON.stringify({ ok: true, sessions: remote.sessions })); return; }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
      const hasBody = req.method === "POST" && (Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"] !== undefined);
      const body = hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: "half" } : {};
      const response = await remote.handle(new Request("http://local" + req.url, { method: req.method, headers, ...body } as RequestInit));
      // A refused request leaves its body unread, which would stall the next request on this socket.
      res.writeHead(response.status, { ...Object.fromEntries(response.headers), ...(req.readableEnded ? {} : { Connection: "close" }) });
      if (!response.body) { res.end(); return; }
      const stream = Readable.fromWeb(response.body as any);
      req.once("close", () => stream.destroy());
      stream.pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Crabrix remote MCP could not handle this request." }));
    }
  });
  server.requestTimeout = 0;
  await new Promise<void>(resolve => server.listen(options.port, options.host, resolve));
  process.stderr.write(`Crabrix remote MCP on ${options.host}:${options.port}. Agent links and learning links are not logged.\n`);
  if (remote.academy === "paused") process.stderr.write("Crabrix Academy MCP (/mcp/academy, and learning links under /mcp/learn/) is paused: it answers 503. Agent links work as usual.\n");
  const close = () => { remote.close(); server.closeAllConnections(); server.close(); };
  process.once("SIGINT", close); process.once("SIGTERM", close);
  return { server, close };
}
