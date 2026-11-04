// Remote MCP for agent links: https://crabrix.com/mcp/<room>/<agent access>/<key>.
// The link is the server URL, so a client with only remote MCP works in the room.
// This process holds the room key while a session lasts and decrypts what the agent reads.
// Nothing is written to disk or logged; a session ends on DELETE, when idle, or when the room expires.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { makeServer } from "./server.js";
import { PlaygroundRoom, agentLinkURL, parseAgentLink } from "./room.js";
import { toCrabrixError } from "./errors.js";

export type RemoteOptions = {
  /** The public origin agent links use, and the relay this process joins. */
  origin?: string;
  /** The relay address when it differs from the public origin, as in tests. */
  relay?: string;
  maxSessions?: number;
  idleMs?: number;
};
type Session = { transport: WebStandardStreamableHTTPServerTransport; room: PlaygroundRoom; link: Buffer; used: number; expiresAt: number };

const digest = (value: string) => createHash("sha256").update(value).digest();
const jsonError = (status: number, message: string) => Response.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, { status, headers: { "Cache-Control": "no-store" } });

export function createRemoteHandler(options: RemoteOptions = {}) {
  const origin = options.origin ?? "https://crabrix.com", relay = options.relay ?? origin;
  const maxSessions = options.maxSessions ?? 64, idleMs = options.idleMs ?? 30 * 60_000;
  const sessions = new Map<string, Session>();
  let opening = 0;

  const end = (id: string) => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    session.room.dispose();
    void session.transport.close().catch(() => {});
  };
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) if (now - session.used > idleMs || now >= session.expiresAt) end(id);
  }, 30_000);
  sweep.unref?.();

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // The path is the capability. It is compared as a hash and never echoed.
    let parsed;
    try { parsed = parseAgentLink(origin + url.pathname, origin); } catch { parsed = null; }
    // A local agent link arrives without its key, which stays after # on the agent's side.
    if (!parsed && /^\/mcp\/[A-Za-z0-9_-]{24}\/[A-Za-z0-9_-]{43}\/?$/.test(url.pathname)) return jsonError(404, "This agent link works only with Crabrix MCP on the agent's computer. Install Crabrix MCP and paste the link into the agent's chat.");
    if (!parsed || url.search) return jsonError(404, "This is not a Crabrix agent link. Copy the complete link from Connect AI agent in Crabrix.");
    const link = digest(agentLinkURL(parsed, origin)), sessionID = request.headers.get("mcp-session-id");

    if (sessionID) {
      const session = sessions.get(sessionID);
      if (!session || !timingSafeEqual(session.link, link)) return jsonError(404, "This MCP session has ended. Reconnect with the agent link.");
      if (Date.now() >= session.expiresAt) { end(sessionID); return jsonError(404, "This Playground expired."); }
      session.used = Date.now();
      return session.transport.handleRequest(request);
    }
    if (request.method !== "POST") return jsonError(400, "Start an MCP session with an initialize request.");
    if (sessions.size + opening >= maxSessions) return jsonError(503, "Crabrix remote MCP is at capacity. Retry shortly, or use Crabrix MCP locally with the same link.");

    opening++;
    const room = new PlaygroundRoom(relay, "Agent · Crabrix");
    try {
      // The bridge joins through the relay address; the link it was given names the public origin.
      const status = await room.exclusive(() => room.connect(agentLinkURL(parsed, relay))) as { expiresAt?: string };
      const expiresAt = Date.parse(status.expiresAt ?? "");
      let created: Session | undefined;
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => { created = { transport, room, link, used: Date.now(), expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 86_400_000 }; sessions.set(id, created); },
        onsessionclosed: id => end(id),
      });
      await makeServer(room, { bound: true }).connect(transport);
      const response = await transport.handleRequest(request);
      if (!created) { room.dispose(); void transport.close().catch(() => {}); }
      return response;
    } catch (error) {
      room.dispose();
      const failure = toCrabrixError(error);
      const status = failure.code === "ROOM_EXPIRED" || failure.code === "INVALID_LINK" ? 404 : failure.code === "ACCESS_DENIED" ? 403 : failure.code === "PARTICIPANT_LIMIT_REACHED" ? 409 : 502;
      return jsonError(status, failure.message);
    } finally { opening--; }
  }

  return {
    handle,
    get sessions() { return sessions.size; },
    close() { clearInterval(sweep); for (const id of [...sessions.keys()]) end(id); },
  };
}
