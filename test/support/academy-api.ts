import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { makeAcademyServer } from "../../src/server";
import type { AcademyToolOptions } from "../../src/academy-tools";

// test/fixtures/academy-v1.json: a faithful subset of the public Academy API v1.
export const academyFixture = JSON.parse(readFileSync(path.resolve("test/fixtures/academy-v1.json"), "utf8")) as Record<string, any>;

/** Serves the fixture, with `overrides` replacing or adding API paths (e.g. "lessons/basics/x.json"). */
export async function startAcademyAPI(overrides: Record<string, unknown> = {}) {
  const content: Record<string, unknown> = { ...academyFixture, ...overrides };
  const requests: { method: string; path: string; bodyBytes: number }[] = [];
  const server = createServer((req, res) => {
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
  return { origin, requests, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
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
