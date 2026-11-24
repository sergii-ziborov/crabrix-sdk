import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { makeAcademyServer } from "../../src/server";
import type { AcademyToolOptions } from "../../src/academy-tools";

// test/fixtures/academy-v1.json: a faithful subset of the public Academy API v1.
export const academyFixture = JSON.parse(readFileSync(path.resolve("test/fixtures/academy-v1.json"), "utf8")) as Record<string, any>;

/** A learning link the fake website knows: the SHA-256 hex of its read token's text, and the app's latest snapshot envelope. */
export type FakeLearnLink = { readTokenSha256: string; envelope?: unknown; updatedAt?: string };
/**
 * The website's learn-links API, as the MCP server uses it: GET …/<id>/snapshot/ and POST …/<id>/inbox/
 * with the read token. Like the site (trailingSlash: true), a path without its slash gets 308.
 */
export type FakeLearnLinks = {
  links: Map<string, FakeLearnLink>;
  /** Every inbox POST the website accepted, oldest first, as the app would fetch it. */
  inbox: { linkId: string; id: string; createdAt: string; envelope: any }[];
  /** Every learn-links request, with its Authorization header. */
  requests: { method: string; path: string; authorization: string | null; body: string }[];
  /** When set, every learn-links request gets this status (503 = CRABRIX_LEARN_LINKS=off). */
  status?: number;
  /** When set, only inbox POSTs get this status (429 = more than 60 an hour). */
  inboxStatus?: number;
  /** Delay before each learn-links answer, in milliseconds. */
  delayMs?: number;
};

function learnLinks(fake: FakeLearnLinks, req: IncomingMessage, res: ServerResponse, body: string) {
  const json = (status: number, value?: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }); res.end(value === undefined ? undefined : JSON.stringify(value)); };
  const error = (status: number, code: string, headers: Record<string, string> = {}) => json(status, { error: { code } }, headers);
  const url = req.url ?? "", authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : null;
  fake.requests.push({ method: req.method ?? "", path: url, authorization, body });
  if (/^\/api\/learn-links\/v1\/.*[^/]$/.test(url)) { res.writeHead(308, { Location: url + "/" }); res.end(); return; }
  const match = /^\/api\/learn-links\/v1\/([A-Za-z0-9_-]{24})\/(snapshot|inbox)\/$/.exec(url);
  if (fake.status) return error(fake.status, fake.status === 503 ? "UNAVAILABLE" : "ERROR");
  if (!match) return error(404, "NOT_FOUND");
  const link = fake.links.get(match[1]), token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "")?.[1];
  // Unknown link or wrong token: 404, never saying which.
  if (!link || !token || createHash("sha256").update(token).digest("hex") !== link.readTokenSha256) return error(404, "NOT_FOUND");
  if (match[2] === "snapshot" && req.method === "GET") return link.envelope === undefined ? error(404, "NOT_FOUND") : json(200, { envelope: link.envelope, updatedAt: link.updatedAt ?? "2026-11-24T10:00:05Z" });
  if (match[2] === "inbox" && req.method === "POST") {
    if (fake.inboxStatus) return error(fake.inboxStatus, fake.inboxStatus === 429 ? "RATE_LIMITED" : "ERROR", fake.inboxStatus === 429 ? { "Retry-After": "120" } : {});
    if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return error(400, "BAD_REQUEST");
    if (Buffer.byteLength(body) > 8 * 1024) return error(400, "TOO_LARGE");
    let envelope: unknown;
    try { envelope = JSON.parse(body); } catch { return error(400, "BAD_REQUEST"); }
    const item = { linkId: match[1], id: `msg-${fake.inbox.length + 1}`, createdAt: "2026-11-24T10:05:00Z", envelope };
    fake.inbox.push(item);
    return json(201, { id: item.id, createdAt: item.createdAt });
  }
  return error(405, "METHOD_NOT_ALLOWED");
}

/**
 * Serves the fixture, with `overrides` replacing or adding API paths (e.g. "lessons/basics/x.json"),
 * and the learn-links API for `learn` links.
 */
export async function startAcademyAPI(overrides: Record<string, unknown> = {}, learn: { links?: Record<string, FakeLearnLink> } = {}) {
  const content: Record<string, unknown> = { ...academyFixture, ...overrides };
  const requests: { method: string; path: string; bodyBytes: number }[] = [];
  const learnAPI: FakeLearnLinks = { links: new Map(Object.entries(learn.links ?? {})), inbox: [], requests: [] };
  const server = createServer((req, res) => {
    if ((req.url ?? "").startsWith("/api/learn-links/")) {
      const parts: Buffer[] = [];
      req.on("data", chunk => parts.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(parts).toString("utf8");
        requests.push({ method: req.method ?? "", path: req.url ?? "", bodyBytes: Buffer.byteLength(body) });
        const answer = () => learnLinks(learnAPI, req, res, body);
        if (learnAPI.delayMs) setTimeout(answer, learnAPI.delayMs); else answer();
      });
      return;
    }
    let bodyBytes = 0;
    req.on("data", chunk => { bodyBytes += chunk.length; });
    req.on("end", () => { requests.push({ method: req.method ?? "", path: req.url ?? "", bodyBytes }); });
    const match = /^\/api\/academy\/v1\/(.+)$/.exec(req.url ?? "");
    const value = match ? content[match[1]] : undefined;
    if (value === undefined) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ schemaVersion: 1, error: { code: "NOT_FOUND", message: "No such item." } })); return; }
    const body = typeof value === "string" ? value : JSON.stringify(value);
    res.writeHead(200, { "Content-Type": match![1].endsWith(".md") ? "text/markdown; charset=utf-8" : "application/json", ETag: `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"` });
    res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  return { origin, requests, learn: learnAPI, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

/** An in-memory MCP client of an Academy-only server. */
export async function academyClient(origin: string, options: AcademyToolOptions = {}) {
  const server = makeAcademyServer({ origin }, options), client = new Client({ name: "academy-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args }) as any;
    return { error: result.isError === true, value: result.structuredContent as any, text: result.content[0].text as string };
  };
  return { client, call, close: () => client.close() };
}
