import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { PlaygroundRooms } from "./support/rooms";
import { PlaygroundRoom, revision } from "../src/room";
import { makeServer } from "../src/server";
import { CrabrixError, relayError, toCrabrixError, networkError } from "../src/errors";
import { runDoctor, envProxySupported, formatDoctor } from "../src/doctor";
import { Y, yDocument, documentFromY, updateYDocument } from "../src/core/playground-collab";
import { playgroundLink } from "../src/core/playground-session";
import { runtimeSourceRevision } from "../src/core/playground-runtime-source";
import { newPlaygroundDocument, type PlaygroundDocument } from "../src/core/playground-document";
import { encryptPlayground, decryptPlayground, newEncryptionSecret } from "../src/core/playground-crypto";

type Hooks = {
  // Runs before the relay handles a POST; return true when the hook answered it.
  beforePost?: (body: any, id: string, access: string, res: ServerResponse) => boolean | void | Promise<boolean | void>;
  beforeSubscribe?: (id: string, res: ServerResponse) => boolean;
  beforeCreate?: (res: ServerResponse) => boolean;
  legacy?: boolean; // Behave as a relay from before state generations.
};

// The real relay class behind HTTP, reporting what the clients actually sent.
async function relay(rooms: PlaygroundRooms, hooks: Hooks = {}) {
  const sent = { updates: [] as any[], snapshots: [] as any[], deletes: 0 };
  const stateOf = (id: string, access: string) => {
    const state = rooms.state(id, access) as any;
    if (hooks.legacy) { delete state.generation; state.protocol = { conditionalUpdates: 1 }; }
    return state;
  };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url!, "http://local"), id = url.pathname.split("/")[4], access = (req.headers.authorization ?? "").slice(7);
      res.setHeader("Content-Type", "application/json");
      if (url.pathname.endsWith("/events/")) {
        if (hooks.beforeSubscribe?.(id, res)) return;
        const peer = url.searchParams.get("peer")!;
        const release = rooms.subscribe(id, access, peer, e => typeof e === "string" ? (send(e, {}), res.end()) : send("kind" in e ? "presence" : "update", e));
        res.setHeader("Content-Type", "text/event-stream");
        const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        req.on("close", release); send("state", stateOf(id, access)); return;
      }
      if (req.method === "GET") { res.end(JSON.stringify(stateOf(id, access))); return; }
      if (req.method === "DELETE") { sent.deletes++; rooms.close(id, access); res.statusCode = 204; res.end(); return; }
      const chunks: Buffer[] = []; for await (const b of req) chunks.push(b);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (url.pathname === "/api/playground/rooms/") {
        if (hooks.beforeCreate?.(res)) return;
        res.end(JSON.stringify(rooms.create(body.snapshot, body.lifetimeSeconds))); return;
      }
      if (body.type === "presence") { rooms.publishPresence(id, access, body.peer, body.packet); res.statusCode = 204; res.end(); return; }
      if (body.type === "snapshot") sent.snapshots.push(body); else sent.updates.push(body);
      if (await hooks.beforePost?.(body, id, access, res)) return;
      if (body.type === "snapshot") { res.end(JSON.stringify(rooms.compact(id, access, body.sequence, body.packet, hooks.legacy ? undefined : body.expectedGeneration))); return; }
      res.end(JSON.stringify(rooms.append(id, access, body.peer, body.messageID, body.packet, body.expectedSequence, hooks.legacy ? undefined : body.expectedGeneration)));
    } catch (e: any) { res.statusCode = e.status ?? 500; res.end(JSON.stringify({ error: e.message })); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  return { sent, origin, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

async function seeded(rooms: PlaygroundRooms, origin: string, source: PlaygroundDocument = newPlaygroundDocument()) {
  const key = newEncryptionSecret(), seed = yDocument(source);
  const created = rooms.create(await encryptPlayground(key, Y.encodeStateAsUpdate(seed)), 600);
  const link = { id: created.id, key, access: created.edit, expiresAt: created.expiresAt, mode: "edit" as const };
  return { key, seed, created, link, url: playgroundLink(link, origin), view: playgroundLink({ ...link, access: created.view, mode: "view" }, origin) };
}
const contents = async (rooms: PlaygroundRooms, id: string, access: string, key: string) => {
  const state = rooms.state(id, access), doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, await decryptPlayground(key, state.snapshot));
    for (const event of state.events) Y.applyUpdate(doc, await decryptPlayground(key, event.packet, 192 * 1024));
    return documentFromY(doc);
  } finally { doc.destroy(); }
};
const failsWith = (code: string) => (error: unknown) => { assert.ok(error instanceof CrabrixError, String(error)); assert.equal(error.code, code, error.message); return true; };

test("SYNC-01: a snapshot that changed the source refuses a commit prepared on the old state", async () => {
  const rooms = new PlaygroundRooms();
  let room: Awaited<ReturnType<typeof seeded>>;
  let replaced = false;
  const { sent, origin, close } = await relay(rooms, { beforePost: async (body, id, access) => {
    // Another client's forced snapshot lands between the read and the commit. It moves
    // no sequence, so a sequence-only precondition would have accepted the stale write.
    if (body.type === "update" && !replaced) {
      replaced = true;
      updateYDocument(room.seed, { ...documentFromY(room.seed), files: { "main.rs": "// someone else's unacknowledged edit\n" } });
      rooms.compact(id, access, rooms.state(id, access).sequence, await encryptPlayground(room.key, Y.encodeStateAsUpdate(room.seed)));
    }
  } });
  room = await seeded(rooms, origin);
  const mcp = new PlaygroundRoom(origin);
  try {
    await mcp.connect(room.url);
    const file = await mcp.read("main.rs");
    await assert.rejects(() => mcp.apply(file.revision, [{ path: "main.rs", text: "stale" }]), failsWith("REVISION_CONFLICT"));
    assert.equal(sent.updates.length, 1, "the refusal needed no second attempt");
    assert.equal(sent.updates[0].expectedGeneration, 0);
    assert.equal((await contents(rooms, room.link.id, room.link.access, room.key)).files["main.rs"], "// someone else's unacknowledged edit\n");
  } finally { mcp.disconnect(); room.seed.destroy(); await close(); }
});

test("SYNC-01: a routine snapshot of the same content does not cost the agent its edit", async () => {
  const rooms = new PlaygroundRooms();
  let room: Awaited<ReturnType<typeof seeded>>, replaced = false;
  const { sent, origin, close } = await relay(rooms, { beforePost: async (body, id, access) => {
    if (body.type === "update" && !replaced) {
      replaced = true;
      rooms.compact(id, access, rooms.state(id, access).sequence, await encryptPlayground(room.key, Y.encodeStateAsUpdate(room.seed)));
    }
  } });
  room = await seeded(rooms, origin);
  const mcp = new PlaygroundRoom(origin);
  try {
    await mcp.connect(room.url);
    const file = await mcp.read("main.rs");
    const result = await mcp.apply(file.revision, [{ path: "main.rs", text: "fn main() { /* kept */ }\n" }]);
    assert.equal(result.changed, true);
    assert.deepEqual(sent.updates.map(body => body.expectedGeneration), [0, 1]);
    assert.notEqual(sent.updates[0].messageID, sent.updates[1].messageID);
    assert.equal((await contents(rooms, room.link.id, room.link.access, room.key)).files["main.rs"], "fn main() { /* kept */ }\n");
  } finally { mcp.disconnect(); room.seed.destroy(); await close(); }
});

test("SYNC-01: state that keeps moving ends in a conflict instead of an endless loop", async () => {
  const rooms = new PlaygroundRooms();
  let room: Awaited<ReturnType<typeof seeded>>;
  const { sent, origin, close } = await relay(rooms, { beforePost: async (body, id, access) => {
    if (body.type === "update") rooms.compact(id, access, rooms.state(id, access).sequence, await encryptPlayground(room.key, Y.encodeStateAsUpdate(room.seed)));
  } });
  room = await seeded(rooms, origin);
  const mcp = new PlaygroundRoom(origin);
  try {
    await mcp.connect(room.url);
    const file = await mcp.read("main.rs");
    await assert.rejects(() => mcp.apply(file.revision, [{ path: "main.rs", text: "never" }]), failsWith("REVISION_CONFLICT"));
    assert.equal(sent.updates.length, 3);
    assert.equal(sent.snapshots.length, 0);
  } finally { mcp.disconnect(); room.seed.destroy(); await close(); }
});

test("SYNC-01: full-room recovery carries the new generation and an old relay still works without one", async () => {
  for (const legacy of [false, true]) {
    const rooms = new PlaygroundRooms();
    const { sent, origin, close } = await relay(rooms, { legacy });
    const room = await seeded(rooms, origin);
    const release = rooms.subscribe(room.link.id, room.link.access, "earlier-participant", () => {});
    const mcp = new PlaygroundRoom(origin);
    try {
      const limit = rooms.limit; rooms.limit = () => {};
      const empty = await encryptPlayground(room.key, new Uint8Array([0, 0]));
      for (let i = 0; i < 256; i++) rooms.append(room.link.id, room.link.access, "earlier-participant", newEncryptionSecret(), empty);
      await mcp.connect(room.url);
      const file = await mcp.read("main.rs");
      const result = await mcp.apply(file.revision, [{ path: "main.rs", text: "fn main() { /* after the drain */ }\n" }]);
      rooms.limit = limit;
      assert.equal(result.changed, true);
      assert.equal(sent.snapshots.length, 1);
      assert.equal(sent.updates.length, 2);
      assert.equal(sent.updates[0].messageID, sent.updates[1].messageID, "one edit, retried once");
      if (legacy) { assert.ok(sent.updates.every(body => !("expectedGeneration" in body))); assert.ok(!("expectedGeneration" in sent.snapshots[0])); }
      else { assert.equal(sent.snapshots[0].expectedGeneration, 256); assert.equal(sent.updates[1].expectedGeneration, 257); }
      assert.equal((await mcp.status()).stateGenerationChecks, !legacy);
    } finally { release(); mcp.disconnect(); room.seed.destroy(); await close(); }
  }
});

test("MCP-01: a lost commit reply is reported as unknown, then settled by reading", async () => {
  const rooms = new PlaygroundRooms();
  let lose = 0;
  const { sent, origin, close } = await relay(rooms, { beforePost: (body, _id, _access, res) => { if (body.type === "update" && lose > 0) { lose--; res.destroy(); return true; } } });
  const room = await seeded(rooms, origin), mcp = new PlaygroundRoom(origin);
  try {
    await mcp.connect(room.url);
    const file = await mcp.read("main.rs");
    lose = 2;
    await assert.rejects(() => mcp.apply(file.revision, [{ path: "main.rs", text: "maybe" }]), failsWith("OUTCOME_UNKNOWN"));
    assert.equal(sent.updates.length, 2);
    assert.equal(sent.updates[0].messageID, sent.updates[1].messageID);
    const status = await mcp.status();
    assert.deepEqual(status.lastOperation, { outcome: "not_applied", files: ["main.rs"] });
    assert.equal(status.outcomeUnknown, undefined);
  } finally { mcp.disconnect(); room.seed.destroy(); await close(); }
});

test("MCP-01: relay answers keep distinct codes and never echo relay text", () => {
  assert.equal(relayError(409, "The shared project changed. Read its latest revision before applying changes.").code, "REVISION_CONFLICT");
  assert.equal(relayError(409, "Receive the latest changes before publishing a snapshot.").code, "REVISION_CONFLICT");
  assert.equal(relayError(409, "Waiting for a fresh encrypted snapshot; retry your update.").code, "ROOM_BUDGET_EXCEEDED");
  assert.equal(relayError(409, "This room already has four participants.").code, "PARTICIPANT_LIMIT_REACHED");
  // An unexplained 409 must not be called a stale revision.
  assert.equal(relayError(409, "Something else").code, "RELAY_CONFLICT");
  assert.equal(relayError(410).code, "ROOM_EXPIRED");
  assert.equal(relayError(403).code, "ACCESS_DENIED");
  assert.equal(relayError(429).code, "RATE_LIMITED");
  assert.equal(relayError(503).code, "RELAY_UNAVAILABLE");
  assert.equal(toCrabrixError(new Error("This Playground link is view-only.")).code, "READ_ONLY");
  assert.equal(toCrabrixError(new Error("Unsupported source path: ../x")).code, "PATH_CONFLICT");
  assert.equal(toCrabrixError(new Error("The source project exceeds 128 KiB.")).code, "LIMIT_EXCEEDED");
  assert.equal(toCrabrixError(new Error("No current grant from this client.")).code, "RUNTIME_GRANT_REQUIRED");
  assert.equal(toCrabrixError(new Error("Runtime transport is busy.")).code, "RUNTIME_UNAVAILABLE");
  assert.equal(toCrabrixError(new Error("Something unforeseen")).code, "OPERATION_FAILED");
  const fetchFailure = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("https://crabrix.com/secret"), { code }) });
  assert.equal(networkError(fetchFailure("ENOTFOUND"))?.code, "NETWORK_UNREACHABLE");
  assert.equal(networkError(fetchFailure("UNABLE_TO_VERIFY_LEAF_SIGNATURE"))?.code, "TLS_ERROR");
  assert.ok(!networkError(fetchFailure("ENOTFOUND"))!.message.includes("secret"));
  assert.equal(networkError(new Error("plain")), null);
});

test("MCP-01: joining reports the actual cause quickly", async () => {
  const rooms = new PlaygroundRooms(), { origin, close } = await relay(rooms);
  const room = await seeded(rooms, origin), mcp = new PlaygroundRoom(origin);
  const releases = ["a", "b", "c", "d"].map(n => rooms.subscribe(room.link.id, room.link.access, n.repeat(16), () => {}));
  try {
    const started = Date.now();
    await assert.rejects(() => mcp.connect(room.url), failsWith("PARTICIPANT_LIMIT_REACHED"));
    assert.ok(Date.now() - started < 5000);
    for (const release of releases) release();
    await assert.rejects(() => mcp.connect(playgroundLink({ ...room.link, access: "x".repeat(43) }, origin)), failsWith("ACCESS_DENIED"));
    rooms.close(room.link.id, room.created.owner);
    await assert.rejects(() => mcp.connect(room.url), failsWith("ROOM_EXPIRED"));
    await assert.rejects(() => mcp.connect("https://example.com/#k"), failsWith("INVALID_LINK"));
    await assert.rejects(() => mcp.read("main.rs"), failsWith("NOT_CONNECTED"));
  } finally { mcp.disconnect(); room.seed.destroy(); await close(); }
});

test("MCP-01: the MCP result keeps its text and adds a machine-readable error without secrets", async () => {
  const room = new PlaygroundRoom("http://127.0.0.1:1"), server = makeServer(room), client = new Client({ name: "errors", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const secret = "k".repeat(43);
    const refused = await client.callTool({ name: "crabrix_connect", arguments: { link: `https://example.com/playground/room/${"r".repeat(24)}/#key=${secret}` } });
    assert.equal(refused.isError, true);
    assert.match((refused.content as any)[0].text, /Only a Crabrix Playground room link/);
    const error = (refused.structuredContent as any);
    assert.equal(error.ok, false);
    assert.equal(error.error.code, "INVALID_LINK");
    assert.equal(error.error.retryable, false);
    assert.match(error.requestId, /^[a-f0-9]{16}$/);
    assert.ok(!JSON.stringify(refused).includes(secret));
    const tools = (await client.listTools()).tools;
    const tool = (name: string) => tools.find(t => t.name === name)!;
    assert.equal(tool("crabrix_runtime_inspect").annotations?.readOnlyHint, true);
    assert.equal(tool("crabrix_runtime_control").annotations?.readOnlyHint, false);
    assert.equal(tool("crabrix_runtime_job").annotations?.readOnlyHint, false);
    assert.deepEqual((tool("crabrix_runtime_inspect").inputSchema as any).properties.operation.enum, ["status", "stdout", "stderr", "diagnostics", "locals"]);
    assert.deepEqual((tool("crabrix_runtime_control").inputSchema as any).properties.operation.enum, ["stop", "step", "continue", "breakpoints"]);
    assert.ok(tool("crabrix_apply_changes").outputSchema);
    const noGrant = await client.callTool({ name: "crabrix_runtime_inspect", arguments: { target: "a".repeat(64), sourceRevision: "b".repeat(64), job: "c".repeat(16), operation: "status" } });
    assert.equal(noGrant.isError, true);
    assert.equal((noGrant.structuredContent as any).error.code, "NOT_CONNECTED");
    const disconnected = await client.callTool({ name: "crabrix_status", arguments: {} });
    assert.equal((disconnected.structuredContent as any).connected, false, "a success keeps its existing shape");
    assert.equal((disconnected.structuredContent as any).ok, undefined);
    const oldEdition = await client.callTool({ name: "crabrix_create", arguments: { name: "x", edition: "2018" } });
    assert.equal(oldEdition.isError, true);
  } finally { await client.close(); await server.close(); room.dispose(); }
});

test("MCP-05: reconnecting to the same room keeps its slot, owner and view access", async () => {
  const rooms = new PlaygroundRooms(), { origin, close } = await relay(rooms), mcp = new PlaygroundRoom(origin);
  try {
    const created = await mcp.create("Same room");
    const id = created.room!, room = rooms.rooms.get(id)!;
    assert.equal(room.listeners.size, 1);
    const again = await mcp.connect(created.link);
    assert.equal(again.canEndRoom, true);
    assert.equal(room.listeners.size, 1, "no extra peer slot");
    assert.equal((await mcp.share("view")).mode, "view");
    const viewLink = (await mcp.share("view")).link;
    const viewing = await mcp.connect(viewLink);
    assert.equal(viewing.mode, "view");
    assert.equal(viewing.canEndRoom, true, "the same room's owner capability stays in this process");
    await mcp.connect(created.link);
    assert.equal((await mcp.share("view")).link, viewLink);
    await mcp.endRoom();
    assert.equal(rooms.rooms.has(id), false);
  } finally { mcp.dispose(); await close(); }
});

test("MCP-05: a failed switch leaves the previous room usable, and ownership never crosses rooms", async () => {
  const rooms = new PlaygroundRooms(), { origin, close } = await relay(rooms), mcp = new PlaygroundRoom(origin);
  const other = await seeded(rooms, origin);
  try {
    const created = await mcp.create("Keep me");
    const denied = playgroundLink({ ...other.link, access: "x".repeat(43) }, origin);
    await assert.rejects(() => mcp.connect(denied), failsWith("ACCESS_DENIED"));
    const file = await mcp.read("main.rs");
    assert.equal(file.text.includes("Hello"), true);
    assert.equal((await mcp.apply(file.revision, [{ path: "main.rs", text: "fn main() { /* still here */ }\n" }])).changed, true);
    assert.equal((await mcp.status()).canEndRoom, true);
    assert.equal(rooms.rooms.get(created.room!)!.listeners.size, 1);
    const before = (await mcp.runtimeClients()).controller;
    const switched = await mcp.connect(other.url);
    assert.equal(switched.room, other.link.id);
    assert.equal(switched.canEndRoom, false);
    assert.equal(rooms.rooms.get(created.room!)!.listeners.size, 0, "the previous slot is released");
    await assert.rejects(() => mcp.share("view"), /room creator/);
    await assert.rejects(() => mcp.endRoom(), failsWith("ACCESS_DENIED"));
    assert.notEqual((await mcp.runtimeClients()).controller, before, "a switch never carries a runtime controller or its grants");
    assert.equal(mcp.disconnect().connected, false);
    assert.equal((await mcp.status()).connected, false);
    await assert.rejects(() => mcp.read("main.rs"), failsWith("NOT_CONNECTED"));
  } finally { mcp.dispose(); other.seed.destroy(); await close(); }
});

test("MCP-05: created but not joined says what exists and keeps the current connection", async () => {
  const rooms = new PlaygroundRooms();
  let refuse = "";
  const { sent, origin, close } = await relay(rooms, { beforeSubscribe: (id, res) => {
    if (id !== refuse && refuse !== "new") return false;
    res.statusCode = 403; res.end(JSON.stringify({ error: "denied" })); return true;
  } });
  const mcp = new PlaygroundRoom(origin);
  try {
    const first = await mcp.create("Current");
    refuse = "new";
    const beforeRooms = rooms.rooms.size;
    const failure = await mcp.create("Never joined").then(() => null, error => error);
    refuse = "";
    assert.ok(failure instanceof CrabrixError);
    assert.equal(failure.code, "ACCESS_DENIED");
    assert.match(failure.message, /created, but this bridge could not join/);
    assert.equal(failure.details?.roomCreated, true);
    assert.equal(failure.details?.roomClosed, true);
    assert.equal(sent.deletes, 1);
    assert.equal(rooms.rooms.size, beforeRooms, "a retry does not accumulate hidden rooms");
    assert.equal((await mcp.status()).room, first.room);
  } finally { mcp.dispose(); await close(); }
});

test("MCP-06: edition is explicit on create and apply, and moves both revisions", async () => {
  const rooms = new PlaygroundRooms(), { sent, origin, close } = await relay(rooms), mcp = new PlaygroundRoom(origin);
  try {
    const created = await mcp.create("Edition", { "main.rs": "fn main() {}\n" }, "main.rs", 60, "2021");
    assert.equal(created.edition, "2021");
    const snapshot = await mcp.snapshot();
    assert.equal(snapshot.document.edition, "2021");
    const runtimeBefore = await runtimeSourceRevision(snapshot.document);
    await assert.rejects(() => mcp.apply(snapshot.revision, [], undefined, undefined, "2018" as any), failsWith("INVALID_ARGUMENT"));
    await assert.rejects(() => mcp.create("Old", undefined, undefined, 60, "2015" as any), failsWith("INVALID_ARGUMENT"));
    await assert.rejects(() => mcp.apply(snapshot.revision, []), failsWith("LIMIT_EXCEEDED"));
    assert.equal(sent.updates.length, 0, "an invalid edition changes nothing");
    const changed = await mcp.apply(snapshot.revision, [], undefined, undefined, "2024");
    assert.equal(changed.changed, true);
    assert.equal(changed.edition, "2024");
    assert.notEqual(changed.revision, snapshot.revision);
    const after = await mcp.snapshot();
    assert.equal(after.document.edition, "2024");
    assert.equal(after.revision, revision(after.document));
    assert.notEqual(await runtimeSourceRevision(after.document), runtimeBefore, "earlier build readiness no longer matches");
    await assert.rejects(() => mcp.apply(snapshot.revision, [], undefined, undefined, "2021"), failsWith("REVISION_CONFLICT"));
    const unchanged = await mcp.apply(after.revision, [], undefined, undefined, "2024");
    assert.equal(unchanged.changed, false);
    assert.equal((await mcp.create("Default")).edition, newPlaygroundDocument().edition);
  } finally { mcp.dispose(); await close(); }
});

test("MCP-02: doctor reports the environment without a room, source or proxy secret", async () => {
  const rooms = new PlaygroundRooms(), { origin, close } = await relay(rooms);
  const variables = ["HTTPS_PROXY", "NODE_USE_ENV_PROXY"], saved = variables.map(name => process.env[name]);
  try {
    delete process.env.HTTPS_PROXY; delete process.env.NODE_USE_ENV_PROXY;
    const clean = await runDoctor({ origin });
    assert.equal(clean.ok, true, JSON.stringify(clean.checks));
    assert.equal(clean.integrationFamily, "crabrix");
    assert.equal(clean.server.name, "crabrix");
    assert.equal(clean.server.transport, "stdio");
    assert.equal(clean.checks.find(check => check.name === "relay")?.status, "ok");
    assert.equal(clean.checks.find(check => check.name === "tls")?.status, "skipped");
    assert.equal(rooms.rooms.size, 0, "the probe creates no room");

    process.env.HTTPS_PROXY = "http://user:proxy-secret@proxy.invalid:3128";
    const proxied = await runDoctor({ origin });
    assert.deepEqual(proxied.proxy.configured, ["HTTPS_PROXY"]);
    assert.equal(proxied.checks.find(check => check.name === "proxy")?.status, "warning");
    const text = JSON.stringify(proxied) + formatDoctor(proxied);
    assert.ok(!text.includes("proxy-secret"));
    assert.ok(!text.includes("proxy.invalid"));
    assert.ok(!/NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized/.test(text), "never suggests disabling TLS");
    process.env.NODE_USE_ENV_PROXY = "1";
    const enabled = await runDoctor({ origin });
    if (envProxySupported()) assert.equal(enabled.checks.find(check => check.name === "proxy")?.status, "ok");
  } finally {
    variables.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
    await close();
  }
  const unreachable = await runDoctor({ origin, timeoutMs: 1000 });
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.checks.find(check => check.name === "relay")?.status, "failed");
  assert.equal(envProxySupported("v22.20.0"), false);
  assert.equal(envProxySupported("v22.21.0"), true);
  assert.equal(envProxySupported("v24.0.0"), true);
});
