import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AcademyClient } from "../src/academy";
import { CrabrixError } from "../src/errors";
import { LearningLinkClient, deriveLearningLinkKeys, learningLinkKeyMaterial, learningLinkPath, learningLinkTokenHash, learningStateFromSnapshot,
  openLearningLinkEnvelope, parseLearningLinkPath, sealLearningLinkEnvelope, validateLearningLinkSnapshot } from "../src/learning-link";
import { LEARNING_LINK_INSTRUCTIONS, makeLearningLinkServer } from "../src/learning-link-tools";
import { secretKind, validateLearningState } from "../src/learning-state";
import { createRemoteHandler } from "../src/remote";
import { serveHTTP } from "../src/remote-http";
import { PlaygroundRoom, parseAgentLink } from "../src/room";
import { startRelay } from "./support/relay";
import { academyFixture, startAcademyAPI, type FakeLearnLink } from "./support/academy-api";

// A copy of crabrix-poc docs/ai-learning/learning-link-vectors.json: the app, the website and this SDK must all match it.
const V = JSON.parse(readFileSync(path.resolve("test/fixtures/learning-link-vectors.json"), "utf8"));
const LINK = { linkId: V.linkId as string, secret: V.secret as string };
const LEARN_PATH = new URL(V.url).pathname;
const ACADEMY_TOOLS = ["crabrix_academy_catalog", "crabrix_academy_search", "crabrix_academy_get_lesson", "crabrix_academy_get_exercise", "crabrix_academy_get_hint",
  "crabrix_academy_learning_path", "crabrix_academy_get_examples", "crabrix_academy_open_playground", "crabrix_academy_review_attempt", "crabrix_academy_next",
  "crabrix_academy_learning_state"];
const MY_READ = ["crabrix_my_progress", "crabrix_my_lesson", "crabrix_my_next"], MY_WRITE = ["crabrix_assign_lessons", "crabrix_set_focus"];
const BOUND = ["crabrix_snapshot", "crabrix_handoff", "crabrix_status", "crabrix_read_file", "crabrix_apply_changes", "crabrix_select", "crabrix_plan_changes", "crabrix_apply_operations",
  "crabrix_runtime_clients", "crabrix_runtime_request", "crabrix_runtime_start", "crabrix_runtime_job", "crabrix_runtime_inspect", "crabrix_runtime_control"];
const INITIALIZE = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "1" } } });
const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const b64 = (bytes: number) => randomBytes(bytes).toString("base64url");
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const crabrixError = (code: string, pattern?: RegExp) => (error: unknown) => error instanceof CrabrixError && error.code === code && (!pattern || pattern.test(error.message));
const RLO = String.fromCodePoint(0x202e), BELL = String.fromCharCode(7), ZWSP = String.fromCodePoint(0x200b);
const clip = (value: string, limit: number) => [...value].slice(0, limit - 1).join("").trimEnd() + "…";

/** The contract's snapshot example, with lesson ids from the Academy fixture. */
const SNAPSHOT = {
  format: "crabrix.learning-link-snapshot", schemaVersion: 1, capturedAt: "2026-11-24T10:00:00Z", app: "1.2.0 (140)", device: "iPhone",
  completed: [{ courseId: "basics", lessonId: "what-is-rust" }, { courseId: "basics", lessonId: "hello-rust" }, { courseId: null, lessonId: "node-what-rust-is" },
    { courseId: "ownership", lessonId: "ownership", extra: "dropped" }],
  credited: [{ courseId: "basics", lessonId: "variables", viaLessonId: "node-let-const-to-let-mut" }, { courseId: "basics", lessonId: "hello-rust", viaLessonId: "c-printf-to-println" }],
  currentLesson: { courseId: "ownership", lessonId: "borrowing" },
  recentLessons: [{ courseId: "ownership", lessonId: "borrowing" }, { courseId: "ownership", lessonId: "ownership" }],
  courses: [{ courseId: "basics", title: "Rust Basics", version: "1.0.10", lessonCount: 29, completed: 2 }],
  topics: [{ lessonId: "ownership", attempts: 5, correct: 4, dueAt: null }, { lessonId: "borrowing", attempts: 4, correct: 2, dueAt: "2026-11-25T00:00:00Z" }],
  tutor: { pathId: "rust-for-nodejs", goal: "Backend services", concepts: ["borrowing"],
    assigned: [{ courseId: "ownership", lessonId: "slices", assignedAt: "2026-11-24T09:00:00Z", done: false, reason: "Slices next" },
      { courseId: "basics", lessonId: "hello-rust", assignedAt: "2026-11-23T09:00:00Z", done: true }] },
  answers: ["never read"], unknownField: { anything: true },
};
const snapshotWith = (fields: Record<string, unknown>) => ({ ...structuredClone(SNAPSHOT), ...fields });
const sealSnapshot = async (snapshot: unknown, kind: "snapshot" | "inbox" = "snapshot") =>
  sealLearningLinkEnvelope((await deriveLearningLinkKeys(V.secret)).key, V.linkId, kind, typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot));
const fakeLink = async (snapshot: unknown = SNAPSHOT): Promise<FakeLearnLink> => ({ readTokenSha256: V.readTokenSha256, envelope: await sealSnapshot(snapshot), updatedAt: "2026-11-24T10:00:05Z" });

/** The fake website with the vector link, and an in-memory MCP client of that link's server. */
async function learning(options: { snapshot?: unknown; link?: typeof LINK; clientTitle?: string; timeoutMs?: number } = {}) {
  const api = await startAcademyAPI({}, { links: { [V.linkId]: await fakeLink(options.snapshot ?? SNAPSHOT) } });
  const academy = new AcademyClient({ origin: api.origin }), links = new LearningLinkClient({ origin: api.origin, timeoutMs: options.timeoutMs });
  const server = makeLearningLinkServer(academy, links, options.link ?? LINK);
  const client = new Client({ name: "claude-test", version: "1", ...(options.clientTitle ? { title: options.clientTitle } : {}) }), [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args }) as any;
    return { error: result.isError === true, value: result.structuredContent as any, text: result.content[0].text as string };
  };
  const { key } = await deriveLearningLinkKeys(V.secret);
  /** What the app would decrypt from its inbox. */
  const inbox = async () => Promise.all(api.learn.inbox.map(async item => JSON.parse(text(await openLearningLinkEnvelope(key, V.linkId, "inbox", item.envelope, 8192)))));
  const posts = () => api.learn.requests.filter(request => request.method === "POST").length;
  return { api, client, call, inbox, posts, close: async () => { await client.close(); await api.close(); } };
}

// ---- Crypto: the contract's test vectors --------------------------------------------

test("LINK-01: HKDF keys, tokens and token hashes reproduce the contract's vectors", async () => {
  assert.deepEqual(await learningLinkKeyMaterial(V.secret), { encryptionKey: V.encryptionKey, writeToken: V.writeToken, readToken: V.readToken });
  assert.equal(learningLinkTokenHash(V.writeToken), V.writeTokenSha256);
  assert.equal(learningLinkTokenHash(V.readToken), V.readTokenSha256);
  assert.equal((await deriveLearningLinkKeys(V.secret)).readToken, V.readToken);
  // Node's own HKDF agrees, as an independent implementation.
  const node = (info: string) => Buffer.from(hkdfSync("sha256", Buffer.from(V.secret, "base64url"), "crabrix-learning-link-v1", info, 32)).toString("base64url");
  assert.deepEqual([node("encryption"), node("app-write"), node("agent-read")], [V.encryptionKey, V.writeToken, V.readToken]);
  await assert.rejects(deriveLearningLinkKeys(V.secret.slice(0, 42)), crabrixError("INVALID_LINK"));
});

test("LINK-02: the vector envelope decrypts exactly; sealing with its nonce reproduces it; AAD binds link and kind", async () => {
  const { key } = await deriveLearningLinkKeys(V.secret);
  assert.equal(text(await openLearningLinkEnvelope(key, V.linkId, "snapshot", V.envelope, 1024)), V.snapshotPlaintext);
  assert.deepEqual(await sealLearningLinkEnvelope(key, V.linkId, "snapshot", V.snapshotPlaintext, Buffer.from(V.nonce, "base64url")), V.envelope);
  // The AAD is exactly the vector's: decrypting with Node's AES-GCM and that string works.
  const ct = Buffer.from(V.envelope.ct, "base64url"), decipher = createDecipheriv("aes-256-gcm", Buffer.from(V.encryptionKey, "base64url"), Buffer.from(V.nonce, "base64url"));
  decipher.setAAD(Buffer.from(V.aad)); decipher.setAuthTag(ct.subarray(-16));
  assert.equal(Buffer.concat([decipher.update(ct.subarray(0, -16)), decipher.final()]).toString("utf8"), V.snapshotPlaintext);
  // Round trip with a random nonce per message.
  const message = JSON.stringify({ format: "crabrix.tutor-message", note: "Grüße — 🦀" });
  const first = await sealLearningLinkEnvelope(key, V.linkId, "inbox", message), second = await sealLearningLinkEnvelope(key, V.linkId, "inbox", message);
  assert.notEqual(first.nonce, second.nonce); assert.notEqual(first.ct, second.ct); assert.equal(first.v, 1); assert.match(first.nonce, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(text(await openLearningLinkEnvelope(key, V.linkId, "inbox", first, 8192)), message);
  // Another kind, another link, another key, or any changed byte never decrypts.
  const refused = crabrixError("LEARN_LINK_UNAVAILABLE");
  await assert.rejects(openLearningLinkEnvelope(key, V.linkId, "snapshot", first, 8192), refused);
  await assert.rejects(openLearningLinkEnvelope(key, V.linkId, "inbox", V.envelope, 8192), refused);
  await assert.rejects(openLearningLinkEnvelope(key, b64(18), "snapshot", V.envelope, 8192), refused);
  await assert.rejects(openLearningLinkEnvelope((await deriveLearningLinkKeys(b64(32))).key, V.linkId, "snapshot", V.envelope, 8192), refused);
  const flipped = Buffer.from(V.envelope.ct, "base64url"); flipped[0] ^= 1;
  await assert.rejects(openLearningLinkEnvelope(key, V.linkId, "snapshot", { ...V.envelope, ct: flipped.toString("base64url") }, 8192), refused);
  for (const bad of [null, [], "text", { ...V.envelope, v: 2 }, { ...V.envelope, nonce: "short" }, { ...V.envelope, ct: "not base64url!" }, { v: 1, ct: V.envelope.ct }])
    await assert.rejects(openLearningLinkEnvelope(key, V.linkId, "snapshot", bad, 8192), refused, JSON.stringify(bad));
  await assert.rejects(openLearningLinkEnvelope(key, V.linkId, "snapshot", V.envelope, 8), refused, "larger than the limit");
});

// ---- URLs ---------------------------------------------------------------------------

test("LINK-03: learning-link URLs parse strictly and never collide with room agent links", () => {
  assert.deepEqual(parseLearningLinkPath(LEARN_PATH), LINK);
  assert.deepEqual(parseLearningLinkPath(LEARN_PATH + "/"), LINK);
  assert.equal(learningLinkPath(LINK), LEARN_PATH);
  // A non-canonical last character decodes to the same bytes, so it is refused: one link, one URL.
  const nonCanonical = V.secret.slice(0, 42) + "9";
  assert.equal(Buffer.from(nonCanonical, "base64url").equals(Buffer.from(V.secret, "base64url")), true);
  for (const bad of [LEARN_PATH + "x", `/mcp/learn/${V.linkId}`, `/mcp/learn/${V.linkId}/`, `${LEARN_PATH}/${V.secret}`, LEARN_PATH.replace("/learn/", "/LEARN/"),
    `/mcp/learn/${V.linkId}/${nonCanonical}`, `/mcp/learn/${V.linkId.slice(1)}/${V.secret}`, `/mcp/learn/${V.linkId}A/${V.secret}`, `/mcp/learn/${V.linkId}/${V.secret}A`,
    `/mcp/learn/${V.linkId}/${V.secret.slice(1)}`, `/mcp/learn//${V.secret}`, `/x/mcp/learn/${V.linkId}/${V.secret}`, "/mcp/learn", "/mcp/academy"])
    assert.equal(parseLearningLinkPath(bad), null, bad);
  const remoteRoom = /^\/mcp\/([A-Za-z0-9_-]{24})\/([A-Za-z0-9_-]{43})\/([A-Za-z0-9_-]{43})\/?$/, localRoom = /^\/mcp\/[A-Za-z0-9_-]{24}\/[A-Za-z0-9_-]{43}\/?$/;
  for (let round = 0; round < 300; round++) {
    const room = b64(18), access = b64(32), key = b64(32), learn = `/mcp/learn/${b64(18)}/${b64(32)}`;
    // A learning link is never a room link…
    assert.ok(parseLearningLinkPath(learn), learn);
    assert.doesNotMatch(learn, remoteRoom); assert.doesNotMatch(learn, localRoom);
    assert.throws(() => parseAgentLink("https://crabrix.com" + learn), crabrixError("INVALID_LINK"));
    // …and a room link, remote or local, is never a learning link.
    assert.equal(parseLearningLinkPath(`/mcp/${room}/${access}/${key}`), null); assert.equal(parseLearningLinkPath(`/mcp/${room}/${access}`), null);
    assert.deepEqual(parseAgentLink(`https://crabrix.com/mcp/${room}/${access}/${key}`), { id: room, access, key });
  }
  // A room id may begin with "learn"; it stays a room link.
  const learnish = "learn" + b64(15).slice(0, 19), access = b64(32), key = b64(32);
  assert.equal(learnish.length, 24);
  assert.equal(parseLearningLinkPath(`/mcp/${learnish}/${access}/${key}`), null);
  assert.deepEqual(parseAgentLink(`https://crabrix.com/mcp/${learnish}/${access}/${key}`), { id: learnish, access, key });
  // A learning link is a capability: an AI Learning State never carries one.
  assert.equal(secretKind(`see ${V.url} later`), "a Crabrix learning link");
  const state = { format: "crabrix.ai-learning-state", schemaVersion: 1, updatedAt: "2026-11-24T10:00:00Z", aiSession: { lastSummary: `Connected through ${V.url}` } };
  const result = validateLearningState(state);
  assert.equal(result.ok, false); assert.match(JSON.stringify(result), /a Crabrix learning link/); assert.equal(JSON.stringify(result).includes(V.secret), false);
});

// ---- Snapshot validation --------------------------------------------------------------

test("LINK-04: the app's snapshot is validated strictly and only its known fields are read", () => {
  const snapshot = validateLearningLinkSnapshot(SNAPSHOT);
  assert.equal(snapshot.capturedAt, "2026-11-24T10:00:00Z"); assert.equal(snapshot.app, "1.2.0 (140)");
  assert.deepEqual(snapshot.completed.map(item => item.lessonId), ["what-is-rust", "hello-rust", "node-what-rust-is", "ownership"]);
  // A lesson the app lists as completed is not also credited.
  assert.deepEqual(snapshot.credited, [{ courseId: "basics", lessonId: "variables", viaLessonId: "node-let-const-to-let-mut" }]);
  for (const hidden of ["answers", "never read", "unknownField", "extra", "dropped"]) assert.equal(JSON.stringify(snapshot).includes(hidden), false, hidden);
  // Missing lists are empty; the minimal vector plaintext lacks the required capturedAt.
  const minimal = validateLearningLinkSnapshot({ format: "crabrix.learning-link-snapshot", schemaVersion: 1, capturedAt: "2026-11-24T10:00:00Z" });
  assert.deepEqual([minimal.completed, minimal.credited, minimal.topics, minimal.tutor, minimal.currentLesson], [[], [], [], null, null]);
  assert.throws(() => validateLearningLinkSnapshot(JSON.parse(V.snapshotPlaintext)), crabrixError("LEARN_LINK_UNAVAILABLE", /capturedAt/));
  const newer = (() => { try { validateLearningLinkSnapshot(snapshotWith({ schemaVersion: 2 })); } catch (error) { return error as CrabrixError; } })();
  assert.equal(newer?.code, "LEARN_LINK_UNAVAILABLE"); assert.match(newer!.message, /newer format/); assert.equal(newer!.details?.needsNewerCrabrix, true);
  const many = (count: number, make: (index: number) => unknown) => Array.from({ length: count }, (_, index) => make(index));
  const lesson = (index: number) => ({ courseId: "basics", lessonId: `lesson-${index}` });
  const refusals: [Record<string, unknown>, RegExp][] = [
    [{ format: "crabrix.ai-learning-state" }, /format/], [{ schemaVersion: "1" }, /schemaVersion/], [{ capturedAt: "2026-11-24 10:00:00" }, /capturedAt/],
    [{ completed: "basics/variables" }, /completed/], [{ completed: [{ courseId: "basics", lessonId: "SECRET-VALUE" }] }, /completed\[0\]\.lessonId/],
    [{ credited: [{ courseId: "basics", lessonId: "variables" }] }, /viaLessonId/], [{ currentLesson: { courseId: "../etc", lessonId: "x" } }, /currentLesson\.courseId/],
    [{ recentLessons: many(11, lesson) }, /recentLessons/], [{ topics: many(31, index => ({ lessonId: `t-${index}`, attempts: 1, correct: 0 })) }, /topics/],
    [{ topics: [{ lessonId: "borrowing", attempts: 2, correct: 3 }] }, /correct/], [{ topics: [{ lessonId: "borrowing", attempts: -1, correct: 0 }] }, /attempts/],
    [{ courses: [{ courseId: "basics", title: "Rust Basics", lessonCount: 2, completed: 3 }] }, /courses\[0\]\.completed/],
    [{ app: "x".repeat(41) }, /app/], [{ tutor: { pathId: "Rust For Node" } }, /tutor\.pathId/], [{ tutor: { goal: "g".repeat(301) } }, /tutor\.goal/],
    [{ tutor: { concepts: many(11, index => `c${index}`) } }, /tutor\.concepts/], [{ tutor: { concepts: ["c".repeat(81)] } }, /tutor\.concepts\[0\]/],
    [{ tutor: { assigned: many(21, index => ({ ...lesson(index), done: false })) } }, /tutor\.assigned/],
    [{ tutor: { assigned: [{ courseId: null, lessonId: "slices", done: false }] } }, /tutor\.assigned\[0\]\.courseId/],
    [{ tutor: { assigned: [{ courseId: "ownership", lessonId: "slices", done: "yes" }] } }, /done/],
  ];
  for (const [fields, pattern] of refusals) {
    const error = (() => { try { validateLearningLinkSnapshot(snapshotWith(fields)); } catch (failure) { return failure as CrabrixError; } })();
    assert.ok(error instanceof CrabrixError && error.code === "LEARN_LINK_UNAVAILABLE", JSON.stringify(fields).slice(0, 120));
    assert.match(error.message, pattern, JSON.stringify(fields).slice(0, 120));
    assert.equal(error.message.includes("SECRET-VALUE"), false);
  }
  for (const bad of [null, [], "snapshot", 1]) assert.throws(() => validateLearningLinkSnapshot(bad), crabrixError("LEARN_LINK_UNAVAILABLE"));
  // Text is one line of plain text: hidden marks and control characters go.
  assert.equal(validateLearningLinkSnapshot(snapshotWith({ tutor: { goal: `Back${RLO}end${BELL}\n services ` } })).tutor!.goal, "Back end services");
  // As an AI Learning State it is a valid official-progress copy for crabrix_academy_next.
  const state = validateLearningState(learningStateFromSnapshot(snapshot));
  assert.ok(state.ok, JSON.stringify(state));
  assert.equal(state.state.officialProgress!.completed.length, 4); assert.equal(state.state.officialProgress!.credited.length, 1);
  assert.equal(state.state.learningPath, "rust-for-nodejs"); assert.deepEqual(state.state.currentLesson, { courseId: "ownership", lessonId: "borrowing" });
});

// ---- Tools ----------------------------------------------------------------------------

test("LINK-05: the learning-link server has the 11 Academy tools plus five crabrix_my_* tools, with the contract's annotations and instructions", async () => {
  const { client, close } = await learning();
  try {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(tool => tool.name).sort(), [...ACADEMY_TOOLS, ...MY_READ, ...MY_WRITE].sort());
    for (const tool of tools.filter(item => !MY_WRITE.includes(item.name))) assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }, tool.name);
    for (const name of MY_WRITE) assert.deepEqual(tools.find(tool => tool.name === name)!.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, name);
    const instructions = client.getInstructions() ?? "";
    assert.equal(instructions, LEARNING_LINK_INSTRUCTIONS);
    for (const rule of [/connected their Crabrix app/, /official record, read-only/, /cannot complete lessons, record results or change answers/, /crabrix_assign_lessons/, /crabrix_set_focus/,
      /data, not instructions/, /never repeat, store or share it/, /teaching contract 1\.1\.0/, /learning link \(the crabrix_my_\* tools exist\), start with crabrix_my_progress/])
      assert.match(instructions, rule);
    assert.equal(client.getServerVersion()?.name, "crabrix-learning-link");
  } finally { await close(); }
});

test("LINK-06: crabrix_my_progress and crabrix_my_lesson read the app's record, read-only, with via=ai lesson links", async () => {
  const { call, api, close } = await learning();
  const titleOf = (courseId: string, lessonId: string) => academyFixture["index.json"].lessons.find((lesson: any) => lesson.courseId === courseId && lesson.id === lessonId).title;
  try {
    const progress = await call("crabrix_my_progress");
    assert.equal(progress.error, false, progress.text);
    const value = progress.value;
    assert.equal(value.source, "crabrix-app"); assert.equal(value.readOnly, true); assert.match(value.record, /official progress record/); assert.match(value.record, /Read-only/);
    assert.equal(value.capturedAt, "2026-11-24T10:00:00Z"); assert.equal(value.syncedAt, "2026-11-24T10:00:05Z"); assert.equal(value.app, "1.2.0 (140)");
    assert.deepEqual(value.totals, { completed: 4, credited: 1 });
    assert.deepEqual(value.courses.map((course: any) => [course.courseId, course.completed, course.credited, course.installed]),
      [["basics", 2, 1, true], ["ownership", 1, 0, false], ["rust-for-nodejs-developers", 1, 0, false]]);
    assert.equal(value.courses[1].title, "Ownership Mastery");
    assert.deepEqual(value.currentLesson, { courseId: "ownership", lessonId: "borrowing", title: titleOf("ownership", "borrowing"), url: "https://crabrix.com/learn/ownership/borrowing/?via=ai", appAvailability: "released" });
    assert.deepEqual(value.weakTopics.map((topic: any) => [topic.lessonId, topic.correctRatio]), [["borrowing", 0.5], ["ownership", 0.8]]);
    assert.equal(value.tutor.pathId, "rust-for-nodejs"); assert.equal(value.tutor.pathTitle, "Rust for Node.js Developers"); assert.equal(value.tutor.openAssignments, 1);
    assert.deepEqual(value.tutor.assigned.map((item: any) => [item.lessonId, item.done, item.url.endsWith("?via=ai")]), [["slices", false, true], ["hello-rust", true, true]]);
    for (const hidden of ["never read", "unknownField", "dropped"]) assert.equal(progress.text.includes(hidden), false, hidden);
    // Each GET carried the read token, never the secret or the write token.
    const gets = api.learn.requests.filter(request => request.method === "GET");
    assert.ok(gets.length >= 1 && gets.every(request => request.authorization === `Bearer ${V.readToken}` && request.path === `/api/learn-links/v1/${V.linkId}/snapshot/`));
    assert.equal(JSON.stringify(api.learn.requests).includes(V.secret) || JSON.stringify(api.learn.requests).includes(V.writeToken), false);

    const completed = (await call("crabrix_my_lesson", { courseId: "rust-for-nodejs-developers", lessonId: "node-what-rust-is" })).value;
    assert.equal(completed.status, "completed"); assert.equal(completed.completed, true); assert.equal(completed.inAcademy, true); assert.match(completed.url, /\?via=ai$/);
    const credited = (await call("crabrix_my_lesson", { courseId: "basics", lessonId: "variables" })).value;
    assert.equal(credited.status, "credited"); assert.equal(credited.credited.viaLessonId, "node-let-const-to-let-mut"); assert.equal(credited.credited.via.courseId, "rust-for-nodejs-developers");
    const current = (await call("crabrix_my_lesson", { courseId: "ownership", lessonId: "borrowing" })).value;
    assert.equal(current.status, "not_completed"); assert.equal(current.current, true); assert.equal(current.recent, true);
    assert.deepEqual(current.topic, { attempts: 4, correct: 2, correctRatio: 0.5, dueAt: "2026-11-25T00:00:00Z" }); assert.equal(current.assigned, null);
    const assigned = (await call("crabrix_my_lesson", { courseId: "ownership", lessonId: "slices" })).value;
    assert.deepEqual(assigned.assigned, { assignedAt: "2026-11-24T09:00:00Z", done: false, reason: "Slices next" }); assert.equal(assigned.readOnly, true);
    const unknown = (await call("crabrix_my_lesson", { courseId: "basics", lessonId: "no-such-lesson" })).value;
    assert.equal(unknown.inAcademy, false); assert.equal(unknown.status, "not_completed");
    assert.equal((await call("crabrix_my_lesson", { courseId: "Basics", lessonId: "x" })).value.error.code, "INVALID_ARGUMENT");
  } finally { await close(); }
});

test("LINK-07: crabrix_my_next is crabrix_academy_next over the app's record; the tutor plan's path is the default", async () => {
  const { call, close } = await learning();
  try {
    const next = (await call("crabrix_my_next", { limit: 3 })).value;
    const path = (academyFixture["paths/rust-for-nodejs.json"] as any).steps;
    assert.match(next.basis, /^path rust-for-nodejs \(the tutor plan's pathId in the Crabrix app\) after ownership\/borrowing \(the Crabrix app's current lesson\)$/);
    // node-what-rust-is is completed (its course was not installed: courseId null), so the path starts after it.
    assert.deepEqual(next.next.map((item: any) => item.lessonId), path.slice(1, 4).map((step: any) => step.lessonId));
    assert.ok(next.next.every((item: any) => item.url.endsWith("?via=ai")));
    assert.equal(next.progressSource, "crabrix-app (learning link, captured 2026-11-24T10:00:00Z)"); assert.match(next.note, /official record/);
    assert.equal(next.capturedAt, "2026-11-24T10:00:00Z");
    assert.deepEqual(next.assigned.map((item: any) => item.lessonId), ["slices"]);
    // The same logic as crabrix_academy_next with that state.
    const academy = (await call("crabrix_academy_next", { limit: 3, learningState: learningStateFromSnapshot(validateLearningLinkSnapshot(SNAPSHOT)) })).value;
    assert.deepEqual(academy.next, next.next);
    const zero = (await call("crabrix_my_next", { pathId: "rust-from-zero", currentLessonId: "basics/hello-rust", limit: 2 })).value;
    // variables is credited, so it counts as done.
    assert.equal(zero.basis, "path rust-from-zero after basics/hello-rust"); assert.deepEqual(zero.next.map((item: any) => item.lessonId), ["print-formatting", "number-types"]);
  } finally { await close(); }
  // A tutor path the Academy no longer has is skipped and named.
  const stale = await learning({ snapshot: snapshotWith({ tutor: { pathId: "retired-path" }, currentLesson: null }) });
  try {
    const next = (await stale.call("crabrix_my_next")).value;
    assert.match(next.basis, /not used from the Crabrix app's snapshot: its tutor pathId retired-path is not a Crabrix learning path/);
    // what-is-rust and hello-rust are completed and variables is credited, so the first Rust Basics lesson not done is print-formatting.
    assert.deepEqual(next.next.map((item: any) => item.lessonId), ["print-formatting"]);
    assert.equal(next.progressSource, "crabrix-app (learning link, captured 2026-11-24T10:00:00Z)");
  } finally { await stale.close(); }
});

test("LINK-08: crabrix_assign_lessons sends exactly one validated, trimmed tutor message; unknown or too many lessons send nothing", async () => {
  const { call, inbox, posts, api, close } = await learning({ clientTitle: "Claude Test" });
  try {
    const longReason = "Practise   borrowing\nwith slices " + "x".repeat(300), note = `Do these two${RLO}before Friday.${BELL}`;
    const sent = await call("crabrix_assign_lessons", { lessons: [{ courseId: "ownership", lessonId: "slices", reason: longReason }, { courseId: "basics", lessonId: "variables" },
      { courseId: "ownership", lessonId: "slices", reason: "again" }], note });
    assert.equal(sent.error, false, sent.text);
    assert.equal(sent.value.sent, true); assert.equal(sent.value.kind, "assign"); assert.equal(sent.value.inboxId, "msg-1"); assert.equal(sent.value.duplicatesSkipped, 1);
    assert.deepEqual(sent.value.trimmed, ["lessons[0].reason"]); assert.match(sent.value.message, /From your AI tutor/); assert.match(sent.value.message, /changes no progress/);
    assert.ok(sent.value.lessons.every((lesson: any) => lesson.url.endsWith("?via=ai") && lesson.title));
    const [message, ...rest] = await inbox();
    assert.equal(rest.length, 0);
    const reason = clip("Practise borrowing with slices " + "x".repeat(300), 200);
    assert.equal([...reason].length, 200);
    assert.match(message.createdAt, /^2\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.deepEqual(message, { format: "crabrix.tutor-message", schemaVersion: 1, createdAt: message.createdAt, kind: "assign",
      lessons: [{ courseId: "ownership", lessonId: "slices", reason }, { courseId: "basics", lessonId: "variables" }], note: "Do these two before Friday.", agent: "Claude Test" });
    // Only ciphertext went to the website, with the read token.
    const post = api.learn.requests.find(request => request.method === "POST")!;
    assert.equal(post.authorization, `Bearer ${V.readToken}`); assert.equal(post.path, `/api/learn-links/v1/${V.linkId}/inbox/`);
    assert.deepEqual(Object.keys(JSON.parse(post.body)).sort(), ["ct", "nonce", "v"]); assert.equal(post.body.includes("slices") || post.body.includes("Friday"), false);

    const before = posts();
    const unknown = await call("crabrix_assign_lessons", { lessons: [{ courseId: "ownership", lessonId: "slices" }, { courseId: "basics", lessonId: "no-such-lesson" }, { courseId: "Basics", lessonId: "x" }] });
    assert.equal(unknown.error, true); assert.equal(unknown.value.error.code, "ACADEMY_NOT_FOUND");
    assert.match(unknown.text, /basics\/no-such-lesson/); assert.match(unknown.text, /lessons\[2\] \(not an Academy id\)/); assert.match(unknown.text, /Nothing was sent/);
    const six = await call("crabrix_assign_lessons", { lessons: Array.from({ length: 6 }, () => ({ courseId: "ownership", lessonId: "slices" })) });
    assert.equal(six.error, true);
    assert.equal((await call("crabrix_assign_lessons", { lessons: [] })).error, true);
    assert.equal((await call("crabrix_assign_lessons", { lessons: [{ courseId: "ownership", lessonId: "slices", extra: 1 }] })).error, true);
    const keyed = await call("crabrix_assign_lessons", { lessons: [{ courseId: "ownership", lessonId: "slices" }], note: `Use ${V.url}` });
    assert.equal(keyed.value.error.code, "INVALID_ARGUMENT"); assert.match(keyed.text, /a Crabrix learning link/); assert.equal(keyed.text.includes(V.secret), false);
    // Within every field limit, long non-ASCII text can still exceed the 8 KB inbox envelope: refused before sending.
    const crabs = "🦀".repeat(600), five = ["ownership/slices", "ownership/borrowing", "basics/variables", "basics/hello-rust", "basics/print-formatting"];
    const heavy = await call("crabrix_assign_lessons", { lessons: five.map(id => ({ courseId: id.split("/")[0], lessonId: id.split("/")[1], reason: crabs })), note: crabs });
    assert.equal(heavy.value.error.code, "LIMIT_EXCEEDED"); assert.match(heavy.text, /too long once encrypted.*8 KB.*Nothing was sent/);
    const hidden = await call("crabrix_assign_lessons", { lessons: [{ courseId: "ownership", lessonId: "slices", reason: "token gh" + "p_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8" }] });
    assert.equal(hidden.value.error.code, "INVALID_ARGUMENT");
    assert.equal(posts(), before, "nothing refused reached the inbox");
    assert.equal((await inbox()).length, 1);
  } finally { await close(); }
});

test("LINK-09: crabrix_set_focus sends a validated focus; an unknown path or an empty focus sends nothing", async () => {
  const { call, inbox, posts, close } = await learning();
  try {
    const goal = "Write backend services in Rust " + "y".repeat(400);
    const sent = await call("crabrix_set_focus", { pathId: "rust-for-nodejs", goal, concepts: [" borrowing ", "Borrowing", "lifetimes", "", `trait${ZWSP}objects`, "z".repeat(100)], note: "Short sessions." });
    assert.equal(sent.error, false, sent.text);
    assert.deepEqual(sent.value.trimmed, ["goal", "concepts[5]"]);
    const [message] = await inbox();
    assert.deepEqual(message, { format: "crabrix.tutor-message", schemaVersion: 1, createdAt: message.createdAt, kind: "focus", pathId: "rust-for-nodejs",
      goal: clip("Write backend services in Rust " + "y".repeat(400), 300), concepts: ["borrowing", "lifetimes", "trait objects", clip("z".repeat(100), 80)], note: "Short sessions.", agent: "claude-test" });
    assert.deepEqual(sent.value.focus, { pathId: message.pathId, goal: message.goal, concepts: message.concepts, note: message.note });
    const noteOnly = await call("crabrix_set_focus", { note: "Review closures." });
    assert.equal(noteOnly.error, false);
    assert.deepEqual(Object.keys((await inbox())[1]).sort(), ["agent", "createdAt", "format", "kind", "note", "schemaVersion"]);
    const before = posts();
    const path = await call("crabrix_set_focus", { pathId: "no-such-path" });
    assert.equal(path.value.error.code, "ACADEMY_NOT_FOUND"); assert.match(path.text, /Nothing was sent/);
    assert.equal((await call("crabrix_set_focus", { pathId: "Not A Path" })).value.error.code, "INVALID_ARGUMENT");
    const empty = await call("crabrix_set_focus", { goal: `  ${BELL} `, concepts: [" "] });
    assert.equal(empty.value.error.code, "INVALID_ARGUMENT"); assert.match(empty.text, /at least one of pathId, goal, concepts or note/);
    assert.equal((await call("crabrix_set_focus", {})).value.error.code, "INVALID_ARGUMENT");
    assert.equal((await call("crabrix_set_focus", { concepts: Array.from({ length: 11 }, (_, index) => `c${index}`) })).error, true);
    assert.equal(posts(), before);
  } finally { await close(); }
});

// ---- Errors and the cache ------------------------------------------------------------

test("LINK-10: a revoked or unknown link is LEARN_LINK_NOT_FOUND; other failures are LEARN_LINK_UNAVAILABLE", async () => {
  const wrong = await learning({ link: { linkId: V.linkId, secret: b64(32) } });
  try {
    for (const [name, args] of [["crabrix_my_progress", {}], ["crabrix_my_lesson", { courseId: "basics", lessonId: "variables" }], ["crabrix_my_next", {}],
      ["crabrix_assign_lessons", { lessons: [{ courseId: "ownership", lessonId: "slices" }] }], ["crabrix_set_focus", { note: "x" }]] as [string, Record<string, unknown>][]) {
      const result = await wrong.call(name, args);
      assert.equal(result.error, true, name); assert.equal(result.value.error.code, "LEARN_LINK_NOT_FOUND", name);
      assert.match(result.text, /Ask the learner to connect again in the Crabrix app/, name);
      assert.equal(result.value.error.retryable, false); assert.equal(result.value.error.action, "reconnect_learning_link");
    }
    assert.equal(wrong.api.learn.inbox.length, 0);
    // The Academy tools keep working on a revoked link.
    assert.equal((await wrong.call("crabrix_academy_search", { query: "ownership", limit: 1 })).error, false);
  } finally { await wrong.close(); }
  const other = await learning({ link: { linkId: b64(18), secret: V.secret } });
  try { assert.equal((await other.call("crabrix_my_progress")).value.error.code, "LEARN_LINK_NOT_FOUND"); } finally { await other.close(); }
  const { api, call, close } = await learning();
  try {
    api.learn.links.get(V.linkId)!.envelope = undefined; // a link with no snapshot yet
    assert.equal((await call("crabrix_my_progress")).value.error.code, "LEARN_LINK_NOT_FOUND");
    api.learn.links.get(V.linkId)!.envelope = await sealSnapshot(SNAPSHOT);
    const unavailable = async (pattern: RegExp, name = "crabrix_my_progress", args: Record<string, unknown> = {}) => {
      await new Promise(resolve => setTimeout(resolve, 0));
      const result = await call(name, args);
      assert.equal(result.value?.error?.code, "LEARN_LINK_UNAVAILABLE", result.text); assert.equal(result.value.error.retryable, true); assert.match(result.text, pattern);
    };
    api.learn.status = 503; await unavailable(/paused/);
    api.learn.status = 500; await unavailable(/answered 500/);
    api.learn.status = undefined; api.learn.inboxStatus = 429;
    await unavailable(/60 an hour.*Try again in 120 seconds/, "crabrix_assign_lessons", { lessons: [{ courseId: "ownership", lessonId: "slices" }] });
    api.learn.inboxStatus = undefined;
    // No request ever went to a path without its trailing slash (the site would redirect it).
    assert.ok(api.learn.requests.every(request => request.path.endsWith("/")));
  } finally { await close(); }
  for (const [envelope, pattern] of [[await sealSnapshot(SNAPSHOT, "inbox"), /could not be decrypted/], [await sealSnapshot("not json"), /not valid JSON/],
    [await sealSnapshot(snapshotWith({ completed: [{ courseId: "basics", lessonId: "BAD" }] })), /not valid/], [JSON.stringify(await sealSnapshot(SNAPSHOT)), /^/],
    [await sealSnapshot(JSON.stringify(snapshotWith({ pad: "p".repeat(300 * 1024) }))), /too large/]] as [unknown, RegExp][]) {
    const api = await startAcademyAPI({}, { links: { [V.linkId]: { readTokenSha256: V.readTokenSha256, envelope } } });
    try {
      const read = new LearningLinkClient({ origin: api.origin }).snapshot(LINK);
      if (typeof envelope === "string") { assert.equal((await read).snapshot.capturedAt, SNAPSHOT.capturedAt, "an envelope stored as JSON text is read too"); continue; }
      await assert.rejects(read, crabrixError("LEARN_LINK_UNAVAILABLE", pattern), String(pattern));
    } finally { await api.close(); }
  }
  await assert.rejects(new LearningLinkClient({ origin: "http://127.0.0.1:1" }).snapshot(LINK), crabrixError("LEARN_LINK_UNAVAILABLE", /Could not reach Crabrix/));
  const slow = await startAcademyAPI({}, { links: { [V.linkId]: await fakeLink() } });
  try {
    slow.learn.delayMs = 3000;
    const started = Date.now();
    await assert.rejects(new LearningLinkClient({ origin: slow.origin, timeoutMs: 200 }).snapshot(LINK), crabrixError("LEARN_LINK_UNAVAILABLE", /timeout/));
    assert.ok(Date.now() - started < 2500);
  } finally { await slow.close(); }
});

test("LINK-11: the decrypted snapshot is cached in memory for at most its TTL, per whole link", async () => {
  const api = await startAcademyAPI({}, { links: { [V.linkId]: await fakeLink() } });
  const gets = () => api.learn.requests.filter(request => request.method === "GET").length;
  try {
    const client = new LearningLinkClient({ origin: api.origin, cacheMs: 150 });
    const [a, b, c] = await Promise.all([client.snapshot(LINK), client.snapshot(LINK), client.snapshot(LINK)]);
    assert.equal(gets(), 1, "concurrent reads share one request"); assert.equal(a, b); assert.equal(b, c);
    api.learn.links.get(V.linkId)!.envelope = await sealSnapshot(snapshotWith({ capturedAt: "2026-11-24T11:00:00Z" }));
    assert.equal((await client.snapshot(LINK)).snapshot.capturedAt, "2026-11-24T10:00:00Z"); assert.equal(gets(), 1);
    // The right id with a wrong secret never reads the cached snapshot.
    await assert.rejects(client.snapshot({ linkId: V.linkId, secret: b64(32) }), crabrixError("LEARN_LINK_NOT_FOUND")); assert.equal(gets(), 2);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal((await client.snapshot(LINK)).snapshot.capturedAt, "2026-11-24T11:00:00Z"); assert.equal(gets(), 3);
    // A failure is not cached.
    api.learn.status = 500;
    await new Promise(resolve => setTimeout(resolve, 200));
    await assert.rejects(client.snapshot(LINK), crabrixError("LEARN_LINK_UNAVAILABLE"));
    api.learn.status = undefined;
    assert.equal((await client.snapshot(LINK)).snapshot.capturedAt, "2026-11-24T11:00:00Z");
    // With no cache, every read asks again; a longer TTL than 10 s is not accepted.
    const uncached = new LearningLinkClient({ origin: api.origin, cacheMs: 0 }), count = gets();
    await uncached.snapshot(LINK); await uncached.snapshot(LINK);
    assert.equal(gets(), count + 2);
  } finally { await api.close(); }
});

// ---- Remote MCP ----------------------------------------------------------------------

test("LINK-12: serve-http routes /mcp/learn/… statelessly; /mcp/academy and room agent links behave as before", async () => {
  const api = await startAcademyAPI({}, { links: { [V.linkId]: await fakeLink() } });
  const { origin, close: closeRelay } = await startRelay(), owner = new PlaygroundRoom(origin, "Person");
  const remote = await serveHTTP({ port: 0, host: "127.0.0.1", origin, relay: origin, academyOrigin: api.origin });
  const base = `http://127.0.0.1:${(remote.server.address() as any).port}`;
  const learn = new Client({ name: "remote-learner", version: "1" }), academy = new Client({ name: "remote-academy", version: "1" }), agent = new Client({ name: "remote-agent", version: "1" });
  try {
    await learn.connect(new StreamableHTTPClientTransport(new URL(base + LEARN_PATH)));
    assert.deepEqual((await learn.listTools()).tools.map(tool => tool.name).sort(), [...ACADEMY_TOOLS, ...MY_READ, ...MY_WRITE].sort());
    assert.match(learn.getInstructions() ?? "", /official record, read-only/);
    const progress = await learn.callTool({ name: "crabrix_my_progress", arguments: {} }) as any;
    assert.equal(progress.isError, undefined, progress.content?.[0]?.text); assert.equal(progress.structuredContent.totals.completed, 4);
    const sent = await learn.callTool({ name: "crabrix_assign_lessons", arguments: { lessons: [{ courseId: "ownership", lessonId: "slices", reason: "Next." }] } }) as any;
    assert.equal(sent.structuredContent.sent, true);
    const { key } = await deriveLearningLinkKeys(V.secret);
    const message = JSON.parse(text(await openLearningLinkEnvelope(key, V.linkId, "inbox", api.learn.inbox[0].envelope, 8192)));
    assert.deepEqual(message.lessons, [{ courseId: "ownership", lessonId: "slices", reason: "Next." }]);
    // Over stateless HTTP the tool call carries no client identity, so the message names no agent (the field is optional).
    assert.equal("agent" in message, false, JSON.stringify(message));
    // Stateless: GET is refused, and nothing but the exact path is a learning link.
    const get = await fetch(base + LEARN_PATH, { headers: { Accept: "text/event-stream" } });
    assert.equal(get.status, 405); assert.equal(get.headers.get("allow"), "POST"); assert.match((await get.json() as any).error.message, /stateless/);
    for (const route of [LEARN_PATH + "?x=1", `/mcp/learn/${V.linkId}`, `/mcp/learn/${V.linkId}/${V.secret.slice(0, 42)}9`, "/mcp/learn", "/mcp/learn/"]) {
      const refused = await fetch(base + route, { method: "POST", headers: MCP_HEADERS, body: INITIALIZE });
      assert.equal(refused.status, 404, route); assert.match((await refused.json() as any).error.message, /not a complete Crabrix learning link/, route);
    }
    // A revoked link still connects; its progress tools answer LEARN_LINK_NOT_FOUND.
    const revoked = new Client({ name: "revoked", version: "1" });
    try {
      await revoked.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/learn/${b64(18)}/${b64(32)}`)));
      const result = await revoked.callTool({ name: "crabrix_my_progress", arguments: {} }) as any;
      assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, "LEARN_LINK_NOT_FOUND");
    } finally { await revoked.close().catch(() => {}); }
    // /mcp/academy is unchanged.
    await academy.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp/academy")));
    assert.deepEqual((await academy.listTools()).tools.map(tool => tool.name).sort(), [...ACADEMY_TOOLS].sort());
    // A room agent link is matched and served as before.
    await owner.exclusive(() => owner.create("learning-link-routing", { "main.rs": "fn main() {}\n" }));
    const handoff = await owner.exclusive(() => owner.share("edit")) as any;
    await agent.connect(new StreamableHTTPClientTransport(new URL(new URL(handoff.agentLink).pathname, base)));
    assert.deepEqual((await agent.listTools()).tools.map(tool => tool.name).sort(), [...BOUND].sort());
    const status = JSON.parse(((await agent.callTool({ name: "crabrix_status", arguments: {} })) as any).content[0].text);
    assert.equal(status.connected, true);
  } finally {
    await Promise.all([learn, academy, agent].map(client => client.close().catch(() => {})));
    remote.close(); owner.dispose(); await closeRelay(); await api.close();
  }
});

test("LINK-13: learning links have their own concurrency limit", async () => {
  const api = await startAcademyAPI({}, { links: { [V.linkId]: await fakeLink() } });
  const post = (handler: ReturnType<typeof createRemoteHandler>, route: string) => handler.handle(new Request("http://local" + route, { method: "POST", headers: MCP_HEADERS, body: INITIALIZE }));
  const full = createRemoteHandler({ origin: "http://127.0.0.1:1", academyOrigin: api.origin, maxLearningLinkRequests: 0 });
  const open = createRemoteHandler({ origin: "http://127.0.0.1:1", academyOrigin: api.origin, maxAcademyRequests: 0 });
  try {
    const busy = await post(full, LEARN_PATH);
    assert.equal(busy.status, 503); assert.match((await busy.json() as any).error.message, /learning link MCP is busy/);
    assert.equal((await post(full, "/mcp/academy")).status, 200, "the Academy's limit is separate");
    assert.equal((await post(open, "/mcp/academy")).status, 503);
    const answered = await post(open, LEARN_PATH);
    assert.equal(answered.status, 200); assert.equal((await answered.json() as any).result.serverInfo.name, "crabrix-learning-link");
    assert.equal(full.learningLinks, "on");
  } finally { full.close(); open.close(); await api.close(); }
});

test("LINK-14: --no-academy and CRABRIX_ACADEMY_MCP=off also pause learning links (503); room agent links are unaffected", async () => {
  const { origin, close: closeRelay } = await startRelay(), owner = new PlaygroundRoom(origin, "Person");
  const check = async (remote: Awaited<ReturnType<typeof serveHTTP>>) => {
    const base = `http://127.0.0.1:${(remote.server.address() as any).port}`;
    for (const route of [LEARN_PATH, LEARN_PATH + "/"]) {
      const paused = await fetch(base + route, { method: "POST", headers: MCP_HEADERS, body: INITIALIZE });
      assert.equal(paused.status, 503); assert.equal(paused.headers.get("cache-control"), "no-store");
      const body = await paused.json() as any;
      assert.equal(body.jsonrpc, "2.0"); assert.equal(body.id, null); assert.match(body.error.message, /Crabrix learning links are paused/);
    }
    assert.equal((await fetch(base + "/mcp/academy", { method: "POST", headers: MCP_HEADERS, body: INITIALIZE })).status, 503);
    assert.equal((await fetch(base + LEARN_PATH + "?x=1", { method: "POST", headers: MCP_HEADERS, body: "{}" })).status, 404);
    const handoff = await owner.exclusive(() => owner.share("edit")) as any;
    const client = new Client({ name: "agent-during-pause", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(new URL(handoff.agentLink).pathname, base)));
      assert.equal(JSON.parse(((await client.callTool({ name: "crabrix_status", arguments: {} })) as any).content[0].text).connected, true);
    } finally { await client.close().catch(() => {}); }
  };
  try {
    await owner.exclusive(() => owner.create("learn-kill-switch", { "main.rs": "fn main() {}\n" }));
    const flagged = await serveHTTP({ port: 0, host: "127.0.0.1", origin, relay: origin, academy: false });
    try { await check(flagged); } finally { flagged.close(); }
    const previous = process.env.CRABRIX_ACADEMY_MCP;
    process.env.CRABRIX_ACADEMY_MCP = "off";
    const fromEnv = await serveHTTP({ port: 0, host: "127.0.0.1", origin, relay: origin })
      .finally(() => { if (previous === undefined) delete process.env.CRABRIX_ACADEMY_MCP; else process.env.CRABRIX_ACADEMY_MCP = previous; });
    try { await check(fromEnv); } finally { fromEnv.close(); }
    assert.equal(createRemoteHandler({ academy: false }).learningLinks, "paused");
  } finally { owner.dispose(); await closeRelay(); }
  // The shipped CLI.
  const cli = path.resolve("dist/cli.mjs");
  const port = await new Promise<number>(resolve => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const { port } = server.address() as any; server.close(() => resolve(port)); }); });
  const child = spawn(process.execPath, [cli, "serve-http", "--port", String(port), "--no-academy"], { env: { PATH: process.env.PATH ?? "" }, stdio: ["ignore", "ignore", "pipe"] });
  try {
    let stderr = "";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("serve-http did not start: " + stderr)), 15_000);
      child.stderr!.on("data", chunk => { stderr += chunk; if (/paused: it answers 503/.test(stderr)) { clearTimeout(timer); resolve(); } });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`serve-http exited ${code}: ${stderr}`)); });
    });
    assert.match(stderr, /learning links under \/mcp\/learn\//); assert.equal(stderr.includes(V.secret), false);
    const paused = await fetch(`http://127.0.0.1:${port}${LEARN_PATH}`, { method: "POST", headers: MCP_HEADERS, body: INITIALIZE });
    assert.equal(paused.status, 503); assert.match((await paused.json() as any).error.message, /learning links are paused/);
  } finally { child.kill("SIGTERM"); }
});
