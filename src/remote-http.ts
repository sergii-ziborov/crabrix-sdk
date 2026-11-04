import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createRemoteHandler } from "./remote.js";

// Node's HTTP server in front of the Web-standard handler. The URL holds the agent
// capability, so requests are never logged.
export async function serveHTTP(options: { port: number; host: string; relay?: string; origin?: string }) {
  const remote = createRemoteHandler({ origin: options.origin, relay: options.relay });
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
  process.stderr.write(`Crabrix remote MCP on ${options.host}:${options.port}. Agent links are not logged.\n`);
  const close = () => { remote.close(); server.closeAllConnections(); server.close(); };
  process.once("SIGINT", close); process.once("SIGTERM", close);
  return { server, close };
}
