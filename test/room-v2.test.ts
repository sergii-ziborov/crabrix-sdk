// Format 2 (stable file IDs) rooms against the site's relay logic of e04e9ff.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { PlaygroundRooms } from "./support/rooms";
import { startRelay } from "./support/relay";
import { PlaygroundRoom, authorizedLink } from "../src/room";
import { makeServer } from "../src/server";
import { CrabrixError, relayError, toCrabrixError } from "../src/errors";
import { Y, yDocument } from "../src/core/playground-collab";
import { createPresence } from "../src/core/playground-presence";
import { PlaygroundSession, compactUpdate, playgroundLink, type PlaygroundLink } from "../src/core/playground-session";
import { applyOperations, createProjectDoc, projectRevision, readProject } from "../src/core/playground-codec-v2";
import { newPlaygroundDocument, type PlaygroundDocument } from "../src/core/playground-document";
import { decryptPlayground, encryptPlayground, newEncryptionSecret } from "../src/core/playground-crypto";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function wait(check: () => boolean | Promise<boolean>) { const end = Date.now() + 10_000; while (!(await check())) { if (Date.now() >= end) throw new Error("Timed out"); await sleep(30); } }
const failsWith = (code: string, planError?: string) => (error: unknown) => {
  const coded = toCrabrixError(error);
  assert.ok(coded instanceof CrabrixError, String(error));
  assert.equal(coded.code, code, coded.message);
  if (planError) assert.equal(coded.details?.planError, planError);
  return true;
};
const source = (files: Record<string, string>, entryFile = "main.rs"): PlaygroundDocument => ({ schemaVersion: 1, name: "Stable IDs", entryFile, edition: "2024", files });
const twoFiles = { "main.rs": "fn main() {}\n", "util.rs": "pub fn util() {}\n" };

async function seededV2(rooms: PlaygroundRooms, origin: string, files: Record<string, string> = twoFiles, prepare?: (doc: Y.Doc) => void) {
  const key = newEncryptionSecret(), seed = createProjectDoc(source(files));
  prepare?.(seed);
  const created = rooms.create(await encryptPlayground(key, compactUpdate(seed)), 600, undefined, 2);
  const link = { id: created.id, key, access: created.edit, expiresAt: created.expiresAt, mode: "edit" as const };
  return { key, seed, created, link, url: playgroundLink(link, origin) };
}
async function relayProject(rooms: PlaygroundRooms, link: PlaygroundLink) {
  const state = rooms.state(link.id, link.access), doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, await decryptPlayground(link.key, state.snapshot, 512 * 1024));
    for (const event of state.events) Y.applyUpdate(doc, await decryptPlayground(link.key, event.packet, 192 * 1024));
    return readProject(doc);
  } finally { doc.destroy(); }
}
function participant(link: PlaygroundLink, origin: string, name = "Browser human") {
  const doc = new Y.Doc(), presence = createPresence(doc, name);
  const session = new PlaygroundSession(doc, link, () => {}, () => {}, presence, origin);
  void session.start();
  return { doc, presence, session, stop: () => { session.stop(); presence.destroy(); doc.destroy(); } };
}
const cursorAt = (text: Y.Text, anchor: number, head = anchor) => ({ anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, anchor)), head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, head)) });
const idOf = (status: any, path: string) => status.files.find((file: any) => file.path === path).id as string;

test("the relay admits a format 2 room only to clients that declare it, and this SDK declares 1,2 on every request", async () => {
  const { rooms, log, origin, close } = await startRelay(), mcp = new PlaygroundRoom(origin);
  try {
    const created: any = await mcp.create("Stable IDs", { "main.rs": "fn main() {}\n" }, "main.rs", 60, undefined, 2);
    assert.equal(created.format, 2);
    assert.equal(log.creates[0].codec, 2);
    const link = authorizedLink(created.link, origin), room = rooms.rooms.get(link.id)!;
    assert.equal(room.codec, 2);
    const listeners = room.listeners.size, first = log.requests.length;
    // A released client declares nothing: refused before any participant slot or ciphertext.
    const released = await fetch(origin + "/api/playground/rooms/" + link.id + "/", { headers: { Authorization: "Bearer " + link.access } });
    assert.equal(released.status, 426);
    assert.match((await released.json()).error, /Update Crabrix/);
    const stream = await fetch(origin + "/api/playground/rooms/" + link.id + "/events/?peer=" + "p".repeat(16), { headers: { Authorization: "Bearer " + link.access } });
    assert.equal(stream.status, 426);
    await stream.body?.cancel();
    assert.equal(room.listeners.size, listeners);
    const declared = await fetch(origin + "/api/playground/rooms/" + link.id + "/", { headers: { Authorization: "Bearer " + link.access, "X-Crabrix-Codecs": "1,2" } });
    assert.equal(declared.status, 200);
    assert.equal((await declared.json()).codec, 2);
    const last = log.requests.length;
    await mcp.status();
    await mcp.endRoom();
    const sdk = log.requests.filter((_, index) => index < first || index >= last);
    assert.ok(["POST /api/playground/rooms/", "GET", "DELETE"].every(kind => sdk.some(request => (request.method + " " + request.path).startsWith(kind))));
    assert.ok(sdk.some(request => request.path.endsWith("/events/")));
    for (const request of sdk) assert.deepEqual(request.codecs, [1, 2], request.method + " " + request.path);

    // A format 1 room still admits released clients, and stays the default.
    const classic: any = await mcp.create("Classic");
    assert.equal(classic.format, undefined);
    assert.match(classic.revision, /^[a-f0-9]{64}$/);
    assert.equal(log.creates[1].codec, undefined);
    const v1 = authorizedLink(classic.link, origin);
    const old = await fetch(origin + "/api/playground/rooms/" + v1.id + "/", { headers: { Authorization: "Bearer " + v1.access } });
    assert.equal(old.status, 200);
    assert.equal((await old.json()).codec, 1);
  } finally { mcp.dispose(); await close(); }
});

test("crabrix_apply_changes on a format 2 room writes, creates and deletes to recovery, and a browser sees the same file IDs", async () => {
  const { rooms, log, origin, close } = await startRelay();
  const room = await seededV2(rooms, origin), mcp = new PlaygroundRoom(origin), web = participant(room.link, origin);
  try {
    await mcp.connect(room.url);
    await wait(() => web.session.receivedState);
    assert.deepEqual([web.session.codec, web.session.formatMismatch], [2, false]);
    const status: any = await mcp.status();
    assert.equal(status.format, 2);
    assert.match(status.revision, /^[a-f0-9]{32}$/);
    assert.deepEqual(status.files.map((file: any) => [file.path, file.bytes, file.conflict]), [["main.rs", 13, false], ["util.rs", 17, false]]);
    assert.deepEqual([status.entryFile, status.entryId, status.recovery, status.blocked], ["main.rs", idOf(status, "main.rs"), [], []]);
    const snapshot: any = await mcp.snapshot();
    assert.equal(snapshot.revision, status.revision);
    assert.deepEqual(snapshot.document.files, twoFiles);
    const main = idOf(status, "main.rs"), util = idOf(status, "util.rs");

    const applied: any = await mcp.apply(status.revision, [{ path: "main.rs", text: "fn main() { println!(\"v2\"); }\n" }, { path: "src/new.rs", text: "pub fn new() {}\n" }, { path: "util.rs", text: null }]);
    assert.deepEqual([applied.changed, applied.format, applied.files], [true, 2, ["main.rs", "src/new.rs", "util.rs"]]);
    assert.match(applied.revision, /^[a-f0-9]{32}$/);
    assert.equal(applied.created[0].path, "src/new.rs");
    assert.deepEqual(applied.recovered, [{ id: util, path: "util.rs" }]);
    await wait(() => readProject(web.doc).files.some(file => file.path === "src/new.rs"));
    const seen = readProject(web.doc);
    assert.equal(seen.files.find(file => file.path === "main.rs")!.id, main, "a write keeps the file ID");
    assert.equal(projectRevision(seen), applied.revision);

    // The deleted file is a recovery row: listed by size, its text only on request.
    const after: any = await mcp.status();
    assert.deepEqual(after.recovery, [{ id: util, path: "util.rs", bytes: 17, conflict: false, orphan: false }]);
    assert.equal((await mcp.snapshot() as any).recovery[0].text, undefined);
    assert.equal((await mcp.snapshot(true) as any).recovery[0].text, twoFiles["util.rs"]);
    const row: any = await mcp.read(undefined, util);
    assert.deepEqual([row.recovery, row.path, row.text, row.conflict], [true, "util.rs", twoFiles["util.rs"], false]);
    await assert.rejects(() => mcp.read("util.rs"), failsWith("PATH_CONFLICT"));
    await assert.rejects(() => mcp.read("main.rs", main), failsWith("INVALID_ARGUMENT"));

    // A stale revision is refused before anything is relayed.
    const updates = log.updates.length;
    await assert.rejects(() => mcp.apply(status.revision, [{ path: "main.rs", text: "stale" }]), failsWith("REVISION_CONFLICT"));
    await assert.rejects(() => mcp.apply(applied.revision, [{ path: "gone.rs", text: null }]), failsWith("PATH_CONFLICT", "not-found"));
    assert.equal(log.updates.length, updates);
    assert.equal(projectRevision(await relayProject(rooms, room.link)), applied.revision);
    // The same content again changes nothing.
    assert.deepEqual(await mcp.apply(applied.revision, [{ path: "main.rs", text: "fn main() { println!(\"v2\"); }\n" }]), { changed: false, revision: applied.revision, format: 2 });

    // The browser's own typing reaches the agent through the relay.
    web.doc.getText("t:" + main).insert(0, "// human\n");
    await wait(() => rooms.state(room.link.id, room.link.access).sequence === 2);
    assert.match((await mcp.read("main.rs")).text, /^\/\/ human\n/);
  } finally { mcp.dispose(); web.stop(); room.seed.destroy(); await close(); }
});

test("plan then apply needs the read revision and the reviewed plan, and an operation ID applies once", async () => {
  const { rooms, log, origin, close } = await startRelay();
  const room = await seededV2(rooms, origin), mcp = new PlaygroundRoom(origin), web = participant(room.link, origin);
  try {
    await mcp.connect(room.url);
    await wait(() => web.session.receivedState);
    const util = idOf(await mcp.status(), "util.rs");
    const move = [{ kind: "move", file: { path: "util.rs" }, path: "src/util.rs" }];
    const plan: any = await mcp.plan(move);
    assert.equal(plan.format, 2);
    assert.match(plan.planHash, /^[a-f0-9]{32}$/);
    assert.deepEqual(plan.moved, [{ id: util, from: "util.rs", to: "src/util.rs" }]);
    assert.equal(plan.checkSuggested, true);
    assert.equal(log.updates.length, 0, "planning changes nothing");

    // Another participant types into the file after the plan read the project.
    web.doc.getText("t:" + util).insert(0, "// typed\n");
    await wait(() => rooms.state(room.link.id, room.link.access).sequence === 1);
    await assert.rejects(() => mcp.applyPlanned(move, plan.revision, plan.planHash, "move-util-0001"), failsWith("REVISION_CONFLICT", "stale"));
    assert.equal(log.updates.length, 1, "a stale plan relays nothing");
    const fresh: any = await mcp.plan(move);
    assert.notEqual(fresh.revision, plan.revision);
    const other: any = await mcp.plan([{ kind: "move", file: { path: "util.rs" }, path: "lib/util.rs" }]);
    await assert.rejects(() => mcp.applyPlanned(move, fresh.revision, other.planHash, "move-util-0001"), failsWith("PLAN_CHANGED", "plan-changed"));

    const applied: any = await mcp.applyPlanned(move, fresh.revision, fresh.planHash, "move-util-0001");
    assert.deepEqual([applied.changed, applied.alreadyApplied, applied.operationId], [true, false, "move-util-0001"]);
    assert.deepEqual(applied.moved, [{ id: util, from: "util.rs", to: "src/util.rs" }]);
    await wait(() => readProject(web.doc).files.some(file => file.path === "src/util.rs"));
    const moved = readProject(web.doc).files.find(file => file.id === util)!;
    assert.deepEqual([moved.path, moved.text], ["src/util.rs", "// typed\npub fn util() {}\n"], "the rename kept the text typed meanwhile");
    assert.equal(projectRevision(readProject(web.doc)), applied.revision);

    const updates = log.updates.length;
    const retried: any = await mcp.applyPlanned(move, fresh.revision, fresh.planHash, "move-util-0001");
    assert.deepEqual([retried.alreadyApplied, retried.changed, retried.revision], [true, false, applied.revision]);
    assert.equal(log.updates.length, updates, "a retry relays nothing");
    const remove = [{ kind: "delete", file: { id: util } }];
    await assert.rejects(async () => mcp.applyPlanned(remove, applied.revision, (await mcp.plan(remove) as any).planHash, "move-util-0001"), failsWith("OPERATION_ID_CONFLICT", "operation-conflict"));
    await assert.rejects(() => mcp.plan([{ kind: "create", path: "main.rs" }]), failsWith("PATH_CONFLICT", "path-taken"));
    await assert.rejects(() => mcp.plan(Array.from({ length: 33 }, (_, i) => ({ kind: "create", path: `f${i}.md` }))), failsWith("INVALID_ARGUMENT", "invalid-operation"));
    await assert.rejects(() => mcp.applyPlanned(remove, applied.revision, fresh.planHash, "bad id"), failsWith("INVALID_ARGUMENT", "invalid-operation"));
    assert.equal(log.updates.length, updates);
    // Deleting and restoring keep the ID; purging clears the recovery row.
    const deletion: any = await mcp.plan(remove);
    const deleted: any = await mcp.applyPlanned(remove, deletion.revision, deletion.planHash, "delete-util-0001");
    assert.deepEqual(deleted.deleted, [{ id: util, path: "src/util.rs" }]);
    assert.deepEqual((await mcp.status() as any).recovery.map((row: any) => [row.id, row.path]), [[util, "src/util.rs"]]);
    const restore = [{ kind: "restore", id: util }];
    const restoring: any = await mcp.plan(restore);
    await mcp.applyPlanned(restore, restoring.revision, restoring.planHash, "restore-util-001");
    assert.equal((await mcp.read(undefined, util)).text, "// typed\npub fn util() {}\n");
  } finally { mcp.dispose(); web.stop(); room.seed.destroy(); await close(); }
});

test("a lost reply is OUTCOME_UNKNOWN, and the same operation ID then reports alreadyApplied", async () => {
  let lose = 0;
  const { rooms, log, origin, close } = await startRelay(undefined, { loseReply: () => { if (lose <= 0) return false; lose--; return true; } });
  const room = await seededV2(rooms, origin), mcp = new PlaygroundRoom(origin);
  try {
    await mcp.connect(room.url);
    const operations = [{ kind: "create", path: "notes.md", text: "kept once\n" }];
    const plan: any = await mcp.plan(operations);
    lose = 2;
    await assert.rejects(() => mcp.applyPlanned(operations, plan.revision, plan.planHash, "create-notes-01"), failsWith("OUTCOME_UNKNOWN"));
    assert.equal(log.updates.length, 2);
    assert.equal(log.updates[0].messageID, log.updates[1].messageID, "one commit, retried once");
    const retried: any = await mcp.applyPlanned(operations, plan.revision, plan.planHash, "create-notes-01");
    assert.equal(retried.alreadyApplied, true);
    assert.equal(log.updates.length, 2);
    assert.equal(rooms.state(room.link.id, room.link.access).sequence, 1);
    assert.deepEqual((await relayProject(rooms, room.link)).files.filter(file => file.path === "notes.md").map(file => file.text), ["kept once\n"]);
    assert.deepEqual((await mcp.status() as any).lastOperation, { outcome: "applied", files: ["notes.md"] });
  } finally { mcp.dispose(); room.seed.destroy(); await close(); }
});

test("selections bind to file IDs: they follow a rename, and an unknown text name is never resolved", async () => {
  const { rooms, origin, close } = await startRelay();
  const room = await seededV2(rooms, origin), mcp = new PlaygroundRoom(origin);
  const web = participant(room.link, origin), stranger = participant(room.link, origin, "Stranger");
  try {
    await mcp.connect(room.url);
    await wait(() => web.session.receivedState && stranger.session.receivedState);
    const status: any = await mcp.status(), util = idOf(status, "util.rs");
    await mcp.select("util.rs", 4, 6, status.revision);
    // The browser fetches the file's text before resolving the agent's cursor.
    const text = web.doc.getText("t:" + util);
    const agentCursor = () => [...web.presence.getStates().values()].find(state => state.user?.name === "Agent · Crabrix")?.cursor;
    await wait(() => !!agentCursor() && Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(agentCursor().anchor), web.doc)?.index === 4);
    assert.equal(Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(agentCursor().head), web.doc)!.type, text);

    // A file created after the agent joined reaches its live copy only as decoded data.
    const late = applyOperations(web.doc, [{ kind: "create", path: "late.rs", text: "fn late() {}\n" }], { origin: "structure" }) as any;
    const lateId = late.plan.created[0];
    await wait(() => rooms.state(room.link.id, room.link.access).sequence === 1);
    web.presence.setLocalStateField("cursor", cursorAt(web.doc.getText("t:" + lateId), 1, 3));
    const unknown = "t:" + "Z".repeat(22);
    stranger.presence.setLocalStateField("cursor", cursorAt(stranger.doc.getText(unknown), 0));
    await wait(async () => ((await mcp.status()) as any).participants.length === 3);
    await wait(async () => ((await mcp.status()) as any).selections.length === 1);
    const selections = (await mcp.status() as any).selections;
    assert.deepEqual(selections.map((selection: any) => [selection.name, selection.file, selection.id, selection.anchor, selection.head]), [["Browser human", "late.rs", lateId, 1, 3]]);
    assert.equal((mcp as any).doc.share.has(unknown), false, "an unknown file's cursor created no root");

    const move = [{ kind: "move", file: { id: lateId }, path: "src/late.rs" }];
    const plan: any = await mcp.plan(move);
    await mcp.applyPlanned(move, plan.revision, plan.planHash, "move-selected-01");
    const renamed = (await mcp.status() as any).selections;
    assert.deepEqual(renamed.map((selection: any) => [selection.file, selection.id, selection.anchor, selection.head]), [["src/late.rs", lateId, 1, 3]]);
    const selected: any = await mcp.select("src/late.rs", 0, 3, (await mcp.status()).revision!);
    assert.deepEqual([selected.format, selected.id], [2, lateId]);
    await assert.rejects(async () => mcp.select("late.rs", 0, 1, (await mcp.status()).revision!), failsWith("INVALID_ARGUMENT"));
  } finally { mcp.dispose(); web.stop(); stranger.stop(); room.seed.destroy(); await close(); }
});

test("MCP tools: format 1 keeps its shape and refuses the new tools with a code; format 2 plans and applies", async () => {
  const { origin, close } = await startRelay();
  const room = new PlaygroundRoom(origin), server = makeServer(room), client = new Client({ name: "format-two", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
  try {
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 18);
    const plan = tools.find(tool => tool.name === "crabrix_plan_changes")!, apply = tools.find(tool => tool.name === "crabrix_apply_operations")!;
    assert.equal(plan.annotations?.readOnlyHint, true);
    assert.equal(apply.annotations?.readOnlyHint, false);
    assert.deepEqual((apply.inputSchema as any).required.sort(), ["expectedRevision", "operationId", "operations", "planHash"]);
    assert.equal((plan.inputSchema as any).properties.operations.maxItems, 32);

    const classic = (await call("crabrix_create", { name: "Classic" })).structuredContent;
    assert.equal(classic.format, undefined);
    assert.match(classic.revision, /^[a-f0-9]{64}$/);
    const refusals = [await call("crabrix_plan_changes", { operations: [{ kind: "create", path: "a.md" }] }),
      await call("crabrix_apply_operations", { operations: [{ kind: "create", path: "a.md" }], expectedRevision: classic.revision, planHash: "a".repeat(32), operationId: "classic-0001" }),
      await call("crabrix_read_file", { id: "A".repeat(22) })];
    for (const refused of refusals) {
      assert.equal(refused.isError, true);
      assert.equal(refused.structuredContent.error.code, "UNSUPPORTED_ROOM_FORMAT");
      assert.match(refused.content[0].text, /older Playground format.*crabrix_apply_changes/);
    }
    const classicApply = (await call("crabrix_apply_changes", { expectedRevision: classic.revision, changes: [{ path: "main.rs", text: "fn main() {}\n" }] })).structuredContent;
    assert.deepEqual([classicApply.changed, classicApply.format], [true, undefined]);
    assert.match(classicApply.revision, /^[a-f0-9]{64}$/);
    await call("crabrix_end_room");

    const created = (await call("crabrix_create", { name: "Stable", format: 2, files: twoFiles })).structuredContent;
    assert.equal(created.format, 2);
    const operations = [{ kind: "move", file: { path: "util.rs" }, path: "src/util.rs" }, { kind: "create", path: "README.md", text: "# Notes\n" }];
    const planned = await call("crabrix_plan_changes", { operations });
    assert.equal(planned.isError, undefined, JSON.stringify(planned.content));
    const preview = planned.structuredContent;
    assert.deepEqual([preview.format, preview.revision, preview.operations], [2, created.revision, 2]);
    assert.deepEqual(preview.created, [{ path: "README.md" }], "a preview's new file has no ID yet");
    assert.deepEqual(preview.after.files.map((file: any) => file.path), ["README.md", "main.rs", "src/util.rs"]);
    const applied = (await call("crabrix_apply_operations", { operations, expectedRevision: preview.revision, planHash: preview.planHash, operationId: "mcp-plan-0001" })).structuredContent;
    assert.deepEqual([applied.changed, applied.alreadyApplied], [true, false]);
    assert.match(applied.created[0].id, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(applied.moved[0].to, "src/util.rs");
    const again = (await call("crabrix_apply_operations", { operations, expectedRevision: preview.revision, planHash: preview.planHash, operationId: "mcp-plan-0001" })).structuredContent;
    assert.deepEqual([again.alreadyApplied, again.revision], [true, applied.revision]);
    const stale = await call("crabrix_apply_operations", { operations: [{ kind: "setName", name: "Renamed" }], expectedRevision: preview.revision, planHash: preview.planHash, operationId: "mcp-plan-0002" });
    assert.equal(stale.structuredContent.error.code, "REVISION_CONFLICT");
    const taken = await call("crabrix_plan_changes", { operations: [{ kind: "create", path: "main.rs" }] });
    assert.deepEqual([taken.structuredContent.error.code, taken.structuredContent.error.details.planError], ["PATH_CONFLICT", "path-taken"]);
    const tooMany = await call("crabrix_plan_changes", { operations: Array.from({ length: 33 }, (_, i) => ({ kind: "create", path: `f${i}.md` })) });
    assert.equal(tooMany.isError, true);
    const status = (await call("crabrix_status")).structuredContent;
    assert.deepEqual(status.files.map((file: any) => file.path), ["README.md", "main.rs", "src/util.rs"]);
    const readme = (await call("crabrix_read_file", { id: applied.created[0].id })).structuredContent;
    assert.deepEqual([readme.path, readme.text, readme.revision], ["README.md", "# Notes\n", status.revision]);
    const changed = (await call("crabrix_apply_changes", { expectedRevision: status.revision, changes: [{ path: "README.md", text: null }] })).structuredContent;
    assert.deepEqual([changed.changed, changed.format], [true, 2]);
    const recovered = (await call("crabrix_snapshot", { includeRecoveryText: true })).structuredContent;
    assert.deepEqual(recovered.recovery.map((row: any) => [row.path, row.text]), [["README.md", "# Notes\n"]]);
    const purge = [{ kind: "purge", id: applied.created[0].id }];
    const purging = (await call("crabrix_plan_changes", { operations: purge })).structuredContent;
    assert.deepEqual(purging.purged, [{ id: applied.created[0].id, path: "README.md" }]);
    const selected = (await call("crabrix_select", { path: "src/util.rs", anchor: 0, head: 3, expectedRevision: changed.revision })).structuredContent;
    assert.equal(selected.selected, true);
  } finally { await client.close(); await server.close(); room.dispose(); await close(); }
});

test("a relay's 426 and a room of an unknown format are CLIENT_UPDATE_REQUIRED, not a timeout", async () => {
  const { rooms, origin, close } = await startRelay();
  const room = await seededV2(rooms, origin), mcp = new PlaygroundRoom(origin);
  const future = (codec: number) => { (rooms.rooms.get(room.link.id) as any).codec = codec; };
  try {
    future(3);
    const started = Date.now();
    await assert.rejects(() => mcp.connect(room.url), failsWith("CLIENT_UPDATE_REQUIRED"));
    assert.ok(Date.now() - started < 5000);
    // A relay that does not check still hands over a state this SDK refuses by itself.
    const admit = rooms.admit;
    rooms.admit = () => 1;
    await assert.rejects(() => mcp.connect(room.url), failsWith("CLIENT_UPDATE_REQUIRED"));
    rooms.admit = admit;
    future(2);
    await mcp.connect(room.url);
    future(3);
    await assert.rejects(() => mcp.status(), failsWith("CLIENT_UPDATE_REQUIRED"));
    const error = relayError(426, "secret relay text");
    assert.deepEqual([error.code, error.retryable, error.action], ["CLIENT_UPDATE_REQUIRED", false, "update_sdk"]);
    assert.match(error.message, /Update Crabrix/);
    assert.ok(!error.message.includes("secret"));
  } finally { mcp.dispose(); room.seed.destroy(); await close(); }
});

test("a format 2 room over the old 256 KiB snapshot limit joins, reads and publishes its snapshot", async () => {
  const { rooms, log, origin, close } = await startRelay();
  const orphan = (n: number) => ("orphan" + n).padEnd(22, "x");
  const room = await seededV2(rooms, origin, twoFiles, seed => { for (let n = 0; n < 5; n++) seed.getText("t:" + orphan(n)).insert(0, String(n).repeat(60 * 1024)); });
  const mcp = new PlaygroundRoom(origin), web = participant(room.link, origin);
  try {
    assert.ok(compactUpdate(room.seed).length > 256 * 1024);
    await mcp.connect(room.url);
    const status: any = await mcp.status();
    assert.deepEqual(status.recovery.map((row: any) => [row.id, row.bytes, row.orphan, row.conflict]), [0, 1, 2, 3, 4].map(n => [orphan(n), 60 * 1024, true, false]));
    assert.deepEqual(status.blocked, []);
    await wait(() => web.session.receivedState);
    web.session.snapshotOverdue = true;
    await (web.session as any).snapshot();
    assert.equal(log.snapshots.length, 1);
    assert.ok(JSON.stringify(log.snapshots[0]).length > 400_000, "larger than a format 1 request may be");
    assert.equal(log.requests.filter(request => request.method === "POST" && request.status === 413).length, 0);
    assert.equal(rooms.state(room.link.id, room.link.access).generation, 1);
    assert.deepEqual((await relayProject(rooms, room.link)).recovery.length, 5);
  } finally { mcp.dispose(); web.stop(); room.seed.destroy(); await close(); }
});

test("a format 2 snapshot is encoded through a copy, so Undo history never reaches the relay", async () => {
  const { rooms, log, origin, close } = await startRelay();
  const room = await seededV2(rooms, origin), web = participant(room.link, origin);
  try {
    await wait(() => web.session.receivedState);
    const id = readProject(web.doc).files.find(file => file.path === "main.rs")!.id, text = web.doc.getText("t:" + id);
    const undo = new Y.UndoManager(text, { trackedOrigins: new Set([web.session]), captureTimeout: 0 });
    for (let i = 0; i < 8; i++) { web.doc.transact(() => text.insert(0, "x".repeat(60 * 1024)), web.session); web.doc.transact(() => text.delete(0, 60 * 1024), web.session); }
    assert.ok(Y.encodeStateAsUpdate(web.doc).length > 400_000);
    web.session.snapshotOverdue = true;
    await (web.session as any).snapshot();
    assert.equal(log.snapshots.length, 1);
    const stored = await decryptPlayground(room.key, rooms.state(room.link.id, room.link.access).snapshot, 512 * 1024);
    assert.ok(stored.length < 10_000, String(stored.length));
    undo.destroy();
  } finally { web.stop(); room.seed.destroy(); await close(); }
});

test("a blocked format 2 project still reads and can be repaired, but cannot run", async () => {
  const { rooms, origin, close } = await startRelay();
  const room = await seededV2(rooms, origin, { "main.rs": "fn main() {}\n", "notes.md": "x" }, seed => {
    const id = readProject(seed).files.find(file => file.path === "main.rs")!.id;
    (seed.getMap("entries").get(id) as Y.Map<unknown>).set("path", "main.txt");
  });
  const mcp = new PlaygroundRoom(origin);
  try {
    await mcp.connect(room.url);
    const status: any = await mcp.status();
    assert.deepEqual([status.blocked, status.entryFile, status.entryId], [["no-entry"], "", null]);
    await assert.rejects(() => mcp.runtimeClients(), failsWith("PROJECT_BLOCKED"));
    const repair = [{ kind: "move", file: { path: "main.txt" }, path: "main.rs" }];
    const plan: any = await mcp.plan(repair);
    assert.deepEqual(plan.after.blocked, []);
    await mcp.applyPlanned(repair, plan.revision, plan.planHash, "repair-entry-01");
    assert.deepEqual((await mcp.status() as any).blocked, []);
    assert.deepEqual((await mcp.runtimeClients()).source.paths, ["main.rs", "notes.md"]);
  } finally { mcp.dispose(); room.seed.destroy(); await close(); }
});

test("a format 2 room whose document has another format opens read-only and sends nothing", async () => {
  const { rooms, log, origin, close } = await startRelay();
  const key = newEncryptionSecret(), seed = yDocument(newPlaygroundDocument());
  const created = rooms.create(await encryptPlayground(key, Y.encodeStateAsUpdate(seed)), 600, undefined, 2);
  const link = { id: created.id, key, access: created.edit, expiresAt: created.expiresAt, mode: "edit" as const };
  const mcp = new PlaygroundRoom(origin);
  try {
    await mcp.connect(playgroundLink(link, origin));
    const status: any = await mcp.status();
    assert.deepEqual([status.format, status.readOnly, status.blocked], [2, true, ["no-files", "no-entry"]]);
    await assert.rejects(() => mcp.apply(status.revision, [{ path: "main.rs", text: "fn main() {}\n" }]), failsWith("READ_ONLY"));
    const plan: any = await mcp.plan([{ kind: "create", path: "main.rs", text: "fn main() {}\n" }]);
    await assert.rejects(() => mcp.applyPlanned([{ kind: "create", path: "main.rs", text: "fn main() {}\n" }], plan.revision, plan.planHash, "mismatch-0001"), failsWith("READ_ONLY"));
    assert.equal(log.updates.length, 0);
  } finally { mcp.dispose(); seed.destroy(); await close(); }
});
