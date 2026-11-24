// Remote MCP for agent links: https://crabrix.com/mcp/<room>/<agent access>/<key>.
// The link is the server URL, so a client with only remote MCP works in the room.
// This process holds the room key while a session lasts and decrypts what the agent reads.
// Nothing is written to disk or logged; a session ends on DELETE, when idle, or when the room expires.
// Two stateless routes sit beside it: the public Academy MCP (/mcp/academy) and learning links
// (/mcp/learn/<linkId>/<secret>), which read the learner's own progress from the Crabrix app.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { makeAcademyServer, makeServer } from "./server.js";
import { AcademyClient } from "./academy.js";
import { LearningLinkClient, parseLearningLinkPath, type LearningLink, type LearningLinkClientOptions } from "./learning-link.js";
import { makeLearningLinkServer } from "./learning-link-tools.js";
import { PlaygroundRoom, agentLinkURL, parseAgentLink } from "./room.js";
import { toCrabrixError } from "./errors.js";

export type RemoteOptions = {
  /** The public origin agent links use, and the relay this process joins. */
  origin?: string;
  /** The relay address when it differs from the public origin, as in tests. */
  relay?: string;
  maxSessions?: number;
  idleMs?: number;
  /** Where the read-only Academy API is fetched from (default: CRABRIX_ACADEMY_ORIGIN, then origin). */
  academyOrigin?: string;
  /** Concurrent /mcp/academy requests, kept apart from room sessions. */
  maxAcademyRequests?: number;
  /** Concurrent /mcp/learn/… requests, kept apart from room sessions and /mcp/academy. */
  maxLearningLinkRequests?: number;
  /** The learn-links website client (timeouts, the snapshot cache of at most 10 s); its origin is the Academy origin. */
  learningLinks?: Omit<LearningLinkClientOptions, "origin">;
  /** false pauses /mcp/academy and learning links (HTTP 503); CRABRIX_ACADEMY_MCP=off does the same. Agent links are unaffected. */
  academy?: boolean;
};
type Session = { transport: WebStandardStreamableHTTPServerTransport; room: PlaygroundRoom; link: Buffer; used: number; expiresAt: number };

const digest = (value: string) => createHash("sha256").update(value).digest();
const jsonError = (status: number, message: string) => Response.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, { status, headers: { "Cache-Control": "no-store" } });
const ACADEMY_PAUSED = "Crabrix Academy MCP is paused. Lessons stay available at https://crabrix.com/learn/ and in the Crabrix app. Crabrix agent links are not affected.";
const LEARN_PAUSED = "Crabrix learning links are paused. The learner's progress stays in the Crabrix app, and lessons stay available at https://crabrix.com/learn/. Crabrix agent links are not affected.";
const NOT_LEARNING_LINK = "This is not a complete Crabrix learning link. Copy it again from Learn with AI → Connect my progress in the Crabrix app.";
/** The kill switch for the public Academy MCP and learning links: `serve-http --no-academy` or CRABRIX_ACADEMY_MCP=off. */
const academyMcpPaused = (option?: boolean) => option === false || (process.env.CRABRIX_ACADEMY_MCP ?? "").trim().toLowerCase() === "off";

export function createRemoteHandler(options: RemoteOptions = {}) {
  const origin = options.origin ?? "https://crabrix.com", relay = options.relay ?? origin;
  const maxSessions = options.maxSessions ?? 64, idleMs = options.idleMs ?? 30 * 60_000;
  const sessions = new Map<string, Session>();
  let opening = 0;
  // Public, read-only Academy MCP: stateless, no room, no key. Its own small limit
  // keeps lesson traffic from taking capacity that agent-link sessions need.
  const academy = new AcademyClient({ origin: options.academyOrigin ?? process.env.CRABRIX_ACADEMY_ORIGIN ?? origin });
  const maxAcademy = options.maxAcademyRequests ?? 16, academyPaused = academyMcpPaused(options.academy);
  // Learning links: the same switch, their own limit, and one website client so the snapshot cache spans requests.
  const learning = new LearningLinkClient({ ...options.learningLinks, origin: academy.origin });
  const maxLearning = options.maxLearningLinkRequests ?? 16;
  /** One JSON-RPC request on a fresh server: no session, no state kept after the answer. */
  const stateless = (name: string, max: number) => {
    let inFlight = 0;
    return async (request: Request, server: () => ReturnType<typeof makeAcademyServer>): Promise<Response> => {
      if (request.method !== "POST") return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: `${name} is stateless: send JSON-RPC requests with POST.` }, id: null }, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
      if (inFlight >= max) return jsonError(503, `${name} is busy. Retry shortly.`);
      inFlight++;
      try {
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        const instance = server();
        await instance.connect(transport);
        const response = await transport.handleRequest(request);
        const body = await response.text();
        void instance.close().catch(() => {});
        return new Response(body, { status: response.status, headers: response.headers });
      } catch {
        return jsonError(500, `${name} could not handle this request.`);
      } finally { inFlight--; }
    };
  };
  const academyRequest = stateless("Crabrix Academy MCP", maxAcademy), learningRequest = stateless("Crabrix learning link MCP", maxLearning);
  const handleAcademy = (request: Request) => academyRequest(request, () => makeAcademyServer(academy));
  const handleLearningLink = (request: Request, link: LearningLink) => learningRequest(request, () => makeLearningLinkServer(academy, learning, link));

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
    if (/^\/mcp\/academy\/?$/.test(url.pathname) && !url.search) return academyPaused ? jsonError(503, ACADEMY_PAUSED) : handleAcademy(request);
    // Before agent links: "learn" is never a 24-character room id, so neither path can match the other.
    if (/^\/mcp\/learn(?:\/|$)/.test(url.pathname)) {
      const link = url.search ? null : parseLearningLinkPath(url.pathname);
      if (!link) return jsonError(404, NOT_LEARNING_LINK);
      return academyPaused ? jsonError(503, LEARN_PAUSED) : handleLearningLink(request, link);
    }
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
    /** "paused" when the kill switch is on: /mcp/academy answers 503. */
    get academy(): "on" | "paused" { return academyPaused ? "paused" : "on"; },
    /** The same switch: "paused" when learning links (/mcp/learn/…) answer 503. */
    get learningLinks(): "on" | "paused" { return academyPaused ? "paused" : "on"; },
    close() { clearInterval(sweep); for (const id of [...sessions.keys()]) end(id); },
  };
}
