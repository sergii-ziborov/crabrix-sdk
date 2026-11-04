import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startRelay } from "./support/relay";
import { PlaygroundRoom, parseAgentLink } from "../src/room";
import { serveHTTP } from "../src/remote-http";

const text = (result: any) => JSON.parse(result.content[0].text);

test("a person hands off an agent link; Crabrix MCP joins it directly with the room's expiry", async () => {
  const { origin, log, close } = await startRelay(), owner = new PlaygroundRoom(origin, "Person"), agent = new PlaygroundRoom(origin, "Agent");
  try {
    const created = await owner.exclusive(() => owner.create("agents", { "main.rs": "fn main() {}\n" })) as any;
    const handoff = await owner.exclusive(() => owner.share("edit")) as any, view = await owner.exclusive(() => owner.share("view")) as any;
    assert.match(handoff.link, /\/playground\/room\//);
    assert.match(handoff.agentLink, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[A-Za-z0-9_-]{24}\/[A-Za-z0-9_-]{43}\/[A-Za-z0-9_-]{43}$/);
    assert.notEqual(handoff.agentLink, view.agentLink);
    assert.equal(handoff.agentLink.includes(created.link.match(/access=([^&]+)/)[1]), false);
    const status = await agent.exclusive(() => agent.connect(handoff.agentLink)) as any;
    assert.equal(status.mode, "edit"); assert.equal(status.expiresAt, created.expiresAt);
    // The agent edits through the relay itself; nothing went to /mcp/.
    await agent.exclusive(() => agent.apply(status.revision, [{ path: "main.rs", text: "fn main() { println!(\"agent\"); }\n" }]));
    assert.match((await owner.exclusive(() => owner.read("main.rs")) as any).text, /agent/);
    assert.equal(log.requests.some(request => request.path.startsWith("/mcp/")), false);
    // An agent link hands off only itself.
    assert.equal((await agent.exclusive(() => agent.share("edit")) as any).link, handoff.agentLink);
    await assert.rejects(agent.exclusive(() => agent.share("view")), /only itself/);
    const viewer = new PlaygroundRoom(origin, "Viewer");
    try {
      assert.equal((await viewer.exclusive(() => viewer.connect(view.agentLink)) as any).mode, "view");
      await assert.rejects(viewer.exclusive(async () => { const s = await viewer.status() as any; return viewer.apply(s.revision, [{ path: "main.rs", text: "" }]); }), /view-only|READ_ONLY/);
    } finally { viewer.dispose(); }
    assert.throws(() => parseAgentLink(handoff.agentLink + "?x=1", origin), /incomplete/);
    assert.equal(parseAgentLink(handoff.link, origin), null);
  } finally { agent.dispose(); owner.dispose(); await close(); }
});

test("a local agent link keeps its key after #: Crabrix MCP joins it, the remote MCP cannot", async () => {
  const { origin, log, close } = await startRelay(), owner = new PlaygroundRoom(origin, "Person"), agent = new PlaygroundRoom(origin, "Agent");
  const remote = await serveHTTP({ port: 0, host: "127.0.0.1", origin, relay: origin });
  const base = `http://127.0.0.1:${(remote.server.address() as any).port}`;
  try {
    await owner.exclusive(() => owner.create("local", { "main.rs": "fn main() {}\n" }));
    const [, id, access, key] = (await owner.exclusive(() => owner.share("edit")) as any).agentLink.match(/\/mcp\/([^/]+)\/([^/]+)\/([^/]+)$/);
    const local = `${origin}/mcp/${id}/${access}#key=${key}`;
    assert.deepEqual(parseAgentLink(local, origin), { id, access, key, local: true });
    assert.throws(() => parseAgentLink(`${origin}/mcp/${id}/${access}`, origin), /incomplete/);
    assert.throws(() => parseAgentLink(`${origin}/mcp/${id}/${access}/${key}#key=${key}`, origin), /incomplete/);
    const status = await agent.exclusive(() => agent.connect(local)) as any;
    assert.equal(status.mode, "edit");
    await agent.exclusive(() => agent.apply(status.revision, [{ path: "main.rs", text: "fn main() { println!(\"local\"); }\n" }]));
    assert.match((await owner.exclusive(() => owner.read("main.rs")) as any).text, /local/);
    // It hands off itself in the same form, so the key never moves into the path.
    const handoff = await agent.exclusive(() => agent.share("edit")) as any;
    assert.equal(handoff.link, local); assert.match(handoff.note, /does not work as a remote MCP server/);
    // An MCP client never sends the fragment; the remote MCP gets no key and joins nothing.
    const refused = await fetch(new URL(new URL(local).pathname, base), { method: "POST", signal: AbortSignal.timeout(20_000), headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "1" } } }) });
    assert.equal(refused.status, 404);
    assert.match((await refused.json() as any).error.message, /only with Crabrix MCP on the agent's computer/);
    assert.equal(log.requests.some(request => request.path.startsWith("/mcp/")), false);
  } finally { agent.dispose(); owner.dispose(); remote.close(); await close(); }
});

test("the agent link is a remote MCP server bound to its room", async () => {
  const { origin, close } = await startRelay(), owner = new PlaygroundRoom(origin, "Person");
  const remote = await serveHTTP({ port: 0, host: "127.0.0.1", origin, relay: origin });
  const base = `http://127.0.0.1:${(remote.server.address() as any).port}`;
  const client = new Client({ name: "remote-agent", version: "1.0.0" });
  try {
    await owner.exclusive(() => owner.create("remote", { "main.rs": "fn main() {}\n" }));
    const handoff = await owner.exclusive(() => owner.share("edit")) as any;
    const url = new URL(new URL(handoff.agentLink).pathname, base);
    await client.connect(new StreamableHTTPClientTransport(url));
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    for (const hidden of ["crabrix_connect", "crabrix_create", "crabrix_end_room", "crabrix_disconnect"]) assert.equal(tools.includes(hidden), false);
    assert.ok(tools.includes("crabrix_apply_changes"));
    const status = text(await client.callTool({ name: "crabrix_status", arguments: {} }));
    assert.equal(status.connected, true); assert.equal(status.mode, "edit");
    assert.ok(status.participants.length >= 2);
    await client.callTool({ name: "crabrix_apply_changes", arguments: { expectedRevision: status.revision, changes: [{ path: "main.rs", text: "fn main() { println!(\"remote\"); }\n" }] } });
    assert.match((await owner.exclusive(() => owner.read("main.rs")) as any).text, /remote/);
    // A wrong capability, a person link path or another session's id gets nothing.
    const wrong = new URL(url); wrong.pathname = wrong.pathname.replace(/\/[A-Za-z0-9_-]{43}\//, "/" + "A".repeat(43) + "/");
    const refused = await fetch(wrong, { method: "POST", signal: AbortSignal.timeout(20_000), headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "1" } } }) });
    assert.equal(refused.status, 403);
    assert.equal((await fetch(new URL("/playground/room/x/", base), { method: "POST", signal: AbortSignal.timeout(20_000) })).status, 404);
    await client.close();
  } finally { remote.close(); owner.dispose(); await close(); }
});
