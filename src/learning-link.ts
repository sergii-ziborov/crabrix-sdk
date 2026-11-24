// Learning links: a personal, revocable MCP URL the learner creates in the Crabrix app,
// https://crabrix.com/mcp/learn/<linkId>/<secret> (contract: crabrix-poc
// docs/ai-learning/learning-link.md). The secret is in the path. This process derives the keys
// from it, reads the app's encrypted progress snapshot from the website and posts encrypted
// tutor messages to the app's inbox. It can never mark progress. Nothing is written to disk or
// logged, and a decrypted snapshot stays in memory for at most 10 seconds.
import { createHash } from "node:crypto";
import { academyOrigin } from "./academy.js";
import { CrabrixError, networkError } from "./errors.js";
import { isAcademyId, isLearningPathId, isLearningStateTime, secretKind } from "./learning-state.js";

export const LEARNING_LINK_VERSION = "crabrix-learning-link-v1";
export const LEARNING_LINK_SNAPSHOT_FORMAT = "crabrix.learning-link-snapshot";
export const TUTOR_MESSAGE_FORMAT = "crabrix.tutor-message";
export const LEARNING_LINK_LIMITS = Object.freeze({
  snapshotBytes: 256 * 1024, inboxEnvelopeBytes: 8 * 1024, completed: 10_000, credited: 10_000, recentLessons: 10, courses: 100, topics: 30,
  assigned: 20, concepts: 10, concept: 80, goal: 300, note: 500, reason: 200, agent: 60, app: 40, device: 60, courseTitle: 120, courseVersion: 40,
  assignLessons: 5,
});

// ---- The URL --------------------------------------------------------------------

/** linkId: 18 random bytes; secret: 32 random bytes; both base64url without padding. */
export type LearningLink = { linkId: string; secret: string };
const LINK_PATH = /^\/mcp\/learn\/([A-Za-z0-9_-]{24})\/([A-Za-z0-9_-]{43})\/?$/;
const canonical = (text: string, bytes: number) => { const decoded = Buffer.from(text, "base64url"); return decoded.length === bytes && decoded.toString("base64url") === text; };

/**
 * `/mcp/learn/<linkId 24>/<secret 43>` (an optional trailing slash), or null. Only canonical
 * base64url is accepted, so one link has exactly one URL. "learn" is never a 24-character room
 * id, so this path and a room agent link (`/mcp/<room 24>/<access 43>/<key 43>`) cannot match each other.
 */
export function parseLearningLinkPath(pathname: string): LearningLink | null {
  const match = LINK_PATH.exec(pathname);
  if (!match || !canonical(match[1], 18) || !canonical(match[2], 32)) return null;
  return { linkId: match[1], secret: match[2] };
}
export const learningLinkPath = (link: LearningLink) => `/mcp/learn/${link.linkId}/${link.secret}`;

// ---- Keys -----------------------------------------------------------------------

const encoder = new TextEncoder();
async function hkdf(secret: string, info: string): Promise<Uint8Array<ArrayBuffer>> {
  if (!canonical(secret, 32)) throw new CrabrixError("INVALID_LINK", "This Crabrix learning link is incomplete. Copy the entire link from the Crabrix app.");
  const ikm = await crypto.subtle.importKey("raw", new Uint8Array(Buffer.from(secret, "base64url")), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: encoder.encode(LEARNING_LINK_VERSION), info: encoder.encode(info) }, ikm, 256));
}
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** HKDF-SHA256 (salt `crabrix-learning-link-v1`) of the 32 secret bytes, each value base64url: the contract's test vectors. */
export async function learningLinkKeyMaterial(secret: string): Promise<{ encryptionKey: string; writeToken: string; readToken: string }> {
  const [encryption, write, read] = await Promise.all([hkdf(secret, "encryption"), hkdf(secret, "app-write"), hkdf(secret, "agent-read")]);
  return { encryptionKey: b64(encryption), writeToken: b64(write), readToken: b64(read) };
}
export type LearningLinkKeys = { key: CryptoKey; readToken: string };
/** The AES-256-GCM key (not extractable) and the read token. The MCP server never needs the app's write token. */
export async function deriveLearningLinkKeys(secret: string): Promise<LearningLinkKeys> {
  const [encryption, read] = await Promise.all([hkdf(secret, "encryption"), hkdf(secret, "agent-read")]);
  const key = await crypto.subtle.importKey("raw", encryption, "AES-GCM", false, ["encrypt", "decrypt"]);
  encryption.fill(0);
  return { key, readToken: b64(read) };
}
/** What the website stores for a token: SHA-256, in hex, of the token's base64url text. */
export const learningLinkTokenHash = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

// ---- Envelopes ------------------------------------------------------------------

export type LearningLinkEnvelope = { v: 1; nonce: string; ct: string };
export type EnvelopeKind = "snapshot" | "inbox";
const additionalData = (linkId: string, kind: EnvelopeKind) => encoder.encode(`${LEARNING_LINK_VERSION}|${linkId}|${kind}`);
const unavailable = (message: string, details?: Record<string, unknown>) => new CrabrixError("LEARN_LINK_UNAVAILABLE", message, details);

/** AES-256-GCM with AAD `crabrix-learning-link-v1|<linkId>|<kind>` and a random 12-byte nonce. `nonce` exists for test vectors only: never reuse one. */
export async function sealLearningLinkEnvelope(key: CryptoKey, linkId: string, kind: EnvelopeKind, plaintext: string | Uint8Array, nonce?: Uint8Array): Promise<LearningLinkEnvelope> {
  const iv = nonce ? new Uint8Array(nonce) : crypto.getRandomValues(new Uint8Array(12));
  if (iv.length !== 12) throw new CrabrixError("INVALID_ARGUMENT", "A learning-link nonce has 12 bytes.");
  const bytes = typeof plaintext === "string" ? encoder.encode(plaintext) : new Uint8Array(plaintext);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: additionalData(linkId, kind) }, key, bytes);
  return { v: 1, nonce: b64(iv), ct: b64(new Uint8Array(ct)) };
}

/** The plaintext of an envelope, or LEARN_LINK_UNAVAILABLE: a wrong shape, link, kind or key never decrypts. */
export async function openLearningLinkEnvelope(key: CryptoKey, linkId: string, kind: EnvelopeKind, envelope: unknown, maximumBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const value = envelope as Partial<LearningLinkEnvelope> | null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw unavailable(`The learner's ${kind} is not a learning-link envelope.`);
  if (value.v !== 1) throw unavailable(`The learner's ${kind} uses an envelope version this Crabrix MCP does not read.`, { needsNewerCrabrix: typeof value.v === "number" && value.v > 1 });
  if (typeof value.nonce !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(value.nonce) || typeof value.ct !== "string" || !/^[A-Za-z0-9_-]{22,}$/.test(value.ct)
    || value.ct.length > Math.ceil((maximumBytes + 16) * 4 / 3)) throw unavailable(`The learner's ${kind} envelope is malformed or too large.`);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(Buffer.from(value.nonce, "base64url")), additionalData: additionalData(linkId, kind) },
      key, new Uint8Array(Buffer.from(value.ct, "base64url")));
    if (plain.byteLength > maximumBytes) throw new Error("too large");
    return new Uint8Array(plain);
  } catch {
    throw unavailable(`The learner's ${kind} could not be decrypted. Ask the learner to open Learn with AI in the Crabrix app so it syncs again.`);
  }
}

// ---- Snapshot (written only by the app) ----------------------------------------

export type SnapshotLesson = { courseId: string | null; lessonId: string };
export type SnapshotCredited = SnapshotLesson & { viaLessonId: string };
export type SnapshotCourse = { courseId: string; title: string | null; version: string | null; lessonCount: number | null; completed: number | null };
export type SnapshotTopic = { lessonId: string; attempts: number; correct: number; dueAt: string | null };
export type SnapshotAssignment = { courseId: string; lessonId: string; assignedAt: string | null; done: boolean; reason: string | null };
export type SnapshotTutor = { pathId: string | null; goal: string | null; concepts: string[]; note: string | null; assigned: SnapshotAssignment[] };
export type LearningLinkSnapshot = {
  format: typeof LEARNING_LINK_SNAPSHOT_FORMAT; schemaVersion: 1; capturedAt: string; app: string | null; device: string | null;
  completed: SnapshotLesson[]; credited: SnapshotCredited[]; currentLesson: SnapshotLesson | null; recentLessons: SnapshotLesson[];
  courses: SnapshotCourse[]; topics: SnapshotTopic[]; tutor: SnapshotTutor | null;
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const codePoints = (text: string) => [...text].length;
// Control characters, and the invisible marks that can reorder or hide displayed text (U+200D, which joins emoji, stays).
const HIDDEN = /[\p{Cc}\u200B\u200C\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;
/** One line of plain text: hidden characters become spaces, runs of white space one space, trimmed. */
export const plainText = (text: string) => text.replace(HIDDEN, " ").replace(/\s+/g, " ").trim();

class SnapshotReader {
  readonly errors: string[] = [];
  fail(path: string, message: string) { if (this.errors.length < 12) this.errors.push(`${path}: ${message}`); }
  list(value: unknown, path: string, max: number): unknown[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) { this.fail(path, "must be an array"); return []; }
    if (value.length > max) { this.fail(path, `must have at most ${max} items`); return []; }
    return value;
  }
  object(value: unknown, path: string): Record<string, unknown> | undefined {
    if (isObject(value)) return value;
    this.fail(path, "must be an object"); return undefined;
  }
  id(value: unknown, path: string, nullable: boolean): string | null | undefined {
    if (nullable && (value === null || value === undefined)) return null;
    if (isAcademyId(value)) return value;
    this.fail(path, `must be an Academy id${nullable ? " or null" : ""}`); return undefined;
  }
  text(value: unknown, path: string, limit: number): string | null | undefined {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") { this.fail(path, "must be a string or null"); return undefined; }
    const text = plainText(value);
    if (codePoints(text) > limit) { this.fail(path, `must be at most ${limit} characters`); return undefined; }
    return text || null;
  }
  time(value: unknown, path: string, nullable: boolean): string | null | undefined {
    if (nullable && (value === null || value === undefined)) return null;
    if (isLearningStateTime(value)) return value;
    this.fail(path, "must be an RFC 3339 UTC time"); return undefined;
  }
  count(value: unknown, path: string, nullable: boolean, max = 1_000_000): number | null | undefined {
    if (nullable && (value === null || value === undefined)) return null;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max) return value;
    this.fail(path, `must be a whole number from 0 to ${max}`); return undefined;
  }
  lesson(value: unknown, path: string): SnapshotLesson | undefined {
    const entry = this.object(value, path);
    if (!entry) return undefined;
    const courseId = this.id(entry.courseId, `${path}.courseId`, true), lessonId = this.id(entry.lessonId, `${path}.lessonId`, false);
    return courseId !== undefined && lessonId ? { courseId, lessonId } : undefined;
  }
}

/** Combines repeats of one lesson id, keeping the first entry and a known course over null. */
function uniqueLessons<T extends SnapshotLesson>(items: (T | undefined)[]): T[] {
  const byLesson = new Map<string, T>();
  for (const item of items) {
    if (!item) continue;
    const known = byLesson.get(item.lessonId);
    if (!known) byLesson.set(item.lessonId, item); else if (known.courseId === null && item.courseId !== null) known.courseId = item.courseId;
  }
  return [...byLesson.values()];
}

/**
 * Checks the app's decrypted snapshot strictly against `crabrix.learning-link-snapshot` v1 and
 * returns only its known fields, normalized. Anything else in it is never read or passed on.
 * Throws LEARN_LINK_UNAVAILABLE, naming fields but never echoing values.
 */
export function validateLearningLinkSnapshot(input: unknown): LearningLinkSnapshot {
  const refuse = (errors: string[], details: Record<string, unknown> = {}) => unavailable(
    `The learner's progress snapshot from the Crabrix app is not valid (${errors.slice(0, 4).join("; ")}${errors.length > 4 ? `; and ${errors.length - 4} more` : ""}). Nothing was read from it. Ask the learner to open Learn with AI in the Crabrix app so it syncs again.`,
    { errors, ...details });
  if (!isObject(input)) throw refuse(["snapshot: must be a JSON object"]);
  if (input.format !== LEARNING_LINK_SNAPSHOT_FORMAT) throw refuse([`format: must be "${LEARNING_LINK_SNAPSHOT_FORMAT}"`]);
  const version = input.schemaVersion;
  if (typeof version === "number" && Number.isInteger(version) && version > 1)
    throw unavailable(`The Crabrix app sent progress in a newer format (schemaVersion ${version}) than this Crabrix MCP reads (1). Nothing was read from it; teach from what the learner tells you until Crabrix MCP is updated.`, { needsNewerCrabrix: true });
  const reader = new SnapshotReader(), L = LEARNING_LINK_LIMITS;
  if (version !== 1) reader.fail("schemaVersion", "must be 1");
  const capturedAt = reader.time(input.capturedAt, "capturedAt", false);
  const app = reader.text(input.app, "app", L.app), device = reader.text(input.device, "device", L.device);
  const completed = uniqueLessons(reader.list(input.completed, "completed", L.completed).map((item, index) => reader.lesson(item, `completed[${index}]`)));
  const credited = uniqueLessons(reader.list(input.credited, "credited", L.credited).map((item, index): SnapshotCredited | undefined => {
    const lesson = reader.lesson(item, `credited[${index}]`), via = isObject(item) ? reader.id(item.viaLessonId, `credited[${index}].viaLessonId`, false) : undefined;
    return lesson && via ? { ...lesson, viaLessonId: via } : undefined;
  }));
  const currentLesson = input.currentLesson === null || input.currentLesson === undefined ? null : reader.lesson(input.currentLesson, "currentLesson");
  const recentLessons = reader.list(input.recentLessons, "recentLessons", L.recentLessons).map((item, index) => reader.lesson(item, `recentLessons[${index}]`)).filter((item): item is SnapshotLesson => !!item);
  const courses = new Map<string, SnapshotCourse>();
  reader.list(input.courses, "courses", L.courses).forEach((item, index) => {
    const path = `courses[${index}]`, entry = reader.object(item, path);
    if (!entry) return;
    const courseId = reader.id(entry.courseId, `${path}.courseId`, false), title = reader.text(entry.title, `${path}.title`, L.courseTitle);
    const courseVersion = reader.text(entry.version, `${path}.version`, L.courseVersion);
    const lessonCount = reader.count(entry.lessonCount, `${path}.lessonCount`, true, 100_000), done = reader.count(entry.completed, `${path}.completed`, true, 100_000);
    if (typeof lessonCount === "number" && typeof done === "number" && done > lessonCount) reader.fail(`${path}.completed`, "must not exceed lessonCount");
    if (courseId && title !== undefined && courseVersion !== undefined && lessonCount !== undefined && done !== undefined && !courses.has(courseId))
      courses.set(courseId, { courseId, title, version: courseVersion, lessonCount, completed: done });
  });
  const topics = reader.list(input.topics, "topics", L.topics).map((item, index): SnapshotTopic | undefined => {
    const path = `topics[${index}]`, entry = reader.object(item, path);
    if (!entry) return undefined;
    const lessonId = reader.id(entry.lessonId, `${path}.lessonId`, false), attempts = reader.count(entry.attempts, `${path}.attempts`, false), correct = reader.count(entry.correct, `${path}.correct`, false);
    const dueAt = reader.time(entry.dueAt, `${path}.dueAt`, true);
    if (typeof attempts === "number" && typeof correct === "number" && correct > attempts) reader.fail(`${path}.correct`, "must not exceed attempts");
    return lessonId && typeof attempts === "number" && typeof correct === "number" && dueAt !== undefined ? { lessonId, attempts, correct, dueAt } : undefined;
  }).filter((item): item is SnapshotTopic => !!item);
  const tutor = input.tutor === null || input.tutor === undefined ? null : readTutor(input.tutor, reader);
  if (reader.errors.length || !capturedAt) throw refuse(reader.errors.length ? reader.errors : ["capturedAt: is required"]);
  const done = new Set(completed.map(item => item.lessonId));
  return {
    format: LEARNING_LINK_SNAPSHOT_FORMAT, schemaVersion: 1, capturedAt, app: app ?? null, device: device ?? null, completed,
    // A lesson the app lists as completed is not also credited.
    credited: credited.filter(item => !done.has(item.lessonId)),
    currentLesson: currentLesson ?? null, recentLessons, courses: [...courses.values()], topics, tutor: tutor ?? null,
  };
}

function readTutor(value: unknown, reader: SnapshotReader): SnapshotTutor | undefined {
  const entry = reader.object(value, "tutor"), L = LEARNING_LINK_LIMITS;
  if (!entry) return undefined;
  let pathId: string | null = null;
  if (entry.pathId !== null && entry.pathId !== undefined) { if (isLearningPathId(entry.pathId)) pathId = entry.pathId; else reader.fail("tutor.pathId", "must be a learning path id or null"); }
  const goal = reader.text(entry.goal, "tutor.goal", L.goal), note = reader.text(entry.note, "tutor.note", L.note);
  const concepts = reader.list(entry.concepts, "tutor.concepts", L.concepts).map((item, index) => {
    const text = typeof item === "string" ? reader.text(item, `tutor.concepts[${index}]`, L.concept) : (reader.fail(`tutor.concepts[${index}]`, "must be a string"), undefined);
    return text ?? undefined;
  }).filter((item): item is string => !!item);
  const assigned = reader.list(entry.assigned, "tutor.assigned", L.assigned).map((item, index): SnapshotAssignment | undefined => {
    const path = `tutor.assigned[${index}]`, lesson = reader.object(item, path);
    if (!lesson) return undefined;
    const courseId = reader.id(lesson.courseId, `${path}.courseId`, false), lessonId = reader.id(lesson.lessonId, `${path}.lessonId`, false);
    const assignedAt = reader.time(lesson.assignedAt, `${path}.assignedAt`, true), reason = reader.text(lesson.reason, `${path}.reason`, L.reason);
    if (lesson.done !== undefined && typeof lesson.done !== "boolean") reader.fail(`${path}.done`, "must be true or false");
    return courseId && lessonId && assignedAt !== undefined && reason !== undefined ? { courseId, lessonId, assignedAt, done: lesson.done === true, reason } : undefined;
  }).filter((item): item is SnapshotAssignment => !!item);
  if (goal === undefined || note === undefined) return undefined;
  return { pathId, goal, concepts, note, assigned };
}

/**
 * The snapshot as an AI Learning State whose officialProgress is the app's record: what
 * crabrix_academy_next reads. Only the fields next uses are filled.
 */
export function learningStateFromSnapshot(snapshot: LearningLinkSnapshot): Record<string, unknown> {
  const current = snapshot.currentLesson?.courseId ? { courseId: snapshot.currentLesson.courseId, lessonId: snapshot.currentLesson.lessonId } : null;
  return {
    format: "crabrix.ai-learning-state", schemaVersion: 1, updatedAt: snapshot.capturedAt, producer: "Crabrix app (learning link)",
    learningPath: snapshot.tutor?.pathId ?? null, currentLesson: current,
    officialProgress: { source: "crabrix-ios", capturedAt: snapshot.capturedAt, appVersion: snapshot.app,
      completed: snapshot.completed.map(({ courseId, lessonId }) => ({ courseId, lessonId })),
      credited: snapshot.credited.map(({ courseId, lessonId, viaLessonId }) => ({ courseId, lessonId, viaLessonId })) },
    evidence: [],
  };
}

// ---- Tutor messages (written only by this server) -------------------------------

export type TutorLesson = { courseId: string; lessonId: string; reason?: string };
export type TutorMessage = {
  format: typeof TUTOR_MESSAGE_FORMAT; schemaVersion: 1; createdAt: string; kind: "assign" | "focus";
  lessons?: TutorLesson[]; pathId?: string; goal?: string; concepts?: string[]; note?: string; agent?: string;
};

/**
 * Agent text made safe for a tutor message: one line of plain text, clipped to `limit`
 * characters (code points) with "…". Text that looks like a link with a key or a token is
 * refused and never echoed. `trimmed` names each field that was clipped.
 */
export function tutorText(value: string | undefined, limit: number, field: string, trimmed: string[]): string | undefined {
  if (value === undefined) return undefined;
  const kind = secretKind(value) ?? secretKind(plainText(value));
  if (kind) throw new CrabrixError("INVALID_ARGUMENT", `${field} contains what looks like ${kind}. Remove it: tutor messages never carry links with keys, credentials or tokens. Nothing was sent.`);
  const text = plainText(value), points = [...text];
  if (points.length <= limit) return text || undefined;
  trimmed.push(field);
  return points.slice(0, limit - 1).join("").trimEnd() + "…";
}

// ---- The website API -----------------------------------------------------------

export type LearningLinkClientOptions = {
  /** Site origin; the API lives under /api/learn-links/v1. Default: CRABRIX_ACADEMY_ORIGIN or https://crabrix.com. */
  origin?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** How long a decrypted snapshot is reused, at most 10 seconds. */
  cacheMs?: number;
};
export type SnapshotRead = { snapshot: LearningLinkSnapshot; updatedAt: string | null };
type CacheEntry = { value: SnapshotRead; fetchedAt: number };

const NOT_FOUND = "This learning link is not connected: the learner turned it off, it expired, or the app has not synced progress yet. Ask the learner to connect again in the Crabrix app (Learn → Learn with AI → Connect my progress).";
const MAX_RESPONSE_BYTES = 512 * 1024, MAX_CACHE = 256;

/**
 * The website's learn-links API with the link's read token. One fetch per link at a time; a
 * decrypted snapshot is kept in memory for at most `cacheMs` (≤ 10 s), keyed by a hash of the
 * whole link, so a link with the right id and a wrong secret never sees it.
 */
export class LearningLinkClient {
  readonly origin: string;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;
  readonly #ttl: number;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #pending = new Map<string, Promise<SnapshotRead>>();

  constructor(options: LearningLinkClientOptions = {}) {
    this.origin = academyOrigin(options.origin);
    this.#fetch = options.fetch ?? fetch;
    this.#timeout = options.timeoutMs ?? 10_000;
    this.#ttl = Math.max(0, Math.min(options.cacheMs ?? 10_000, 10_000));
  }

  /** The app's latest snapshot, validated. LEARN_LINK_NOT_FOUND when the link is gone; LEARN_LINK_UNAVAILABLE otherwise. */
  snapshot(link: LearningLink): Promise<SnapshotRead> {
    const id = createHash("sha256").update(`${link.linkId}/${link.secret}`).digest("hex"), now = Date.now();
    for (const [key, entry] of this.#cache) if (now - entry.fetchedAt >= this.#ttl) this.#cache.delete(key);
    const cached = this.#cache.get(id);
    if (cached) return Promise.resolve(cached.value);
    const pending = this.#pending.get(id);
    if (pending) return pending;
    const work = this.#load(link).then(value => {
      if (this.#ttl > 0) {
        this.#cache.set(id, { value, fetchedAt: Date.now() });
        while (this.#cache.size > MAX_CACHE) this.#cache.delete(this.#cache.keys().next().value!);
        // Gone after the TTL even when no other request comes.
        setTimeout(() => { if (this.#cache.get(id)?.value === value) this.#cache.delete(id); }, this.#ttl).unref?.();
      }
      return value;
    }).finally(() => this.#pending.delete(id));
    this.#pending.set(id, work);
    return work;
  }

  /** Encrypts a tutor message for the app's inbox and posts it. Returns the inbox id the website gave it. */
  async send(link: LearningLink, message: TutorMessage): Promise<{ id: string | null; createdAt: string | null }> {
    const { key, readToken } = await deriveLearningLinkKeys(link.secret);
    const body = JSON.stringify(await sealLearningLinkEnvelope(key, link.linkId, "inbox", JSON.stringify(message)));
    if (Buffer.byteLength(body) > LEARNING_LINK_LIMITS.inboxEnvelopeBytes)
      throw new CrabrixError("LIMIT_EXCEEDED", "This tutor message is too long once encrypted (the inbox takes 8 KB). Shorten the note, goal or reasons. Nothing was sent.");
    const response = await this.#request(link, "inbox", readToken, { method: "POST", body, headers: { "Content-Type": "application/json" } });
    if (response.status !== 201 && response.status !== 200) throw await this.#failure(response, "inbox");
    const result = await this.#json(response).catch(() => ({})) as { id?: unknown; createdAt?: unknown };
    return { id: typeof result.id === "string" && result.id.length <= 128 ? result.id : null, createdAt: isLearningStateTime(result.createdAt) ? result.createdAt : null };
  }

  async #load(link: LearningLink): Promise<SnapshotRead> {
    const { key, readToken } = await deriveLearningLinkKeys(link.secret);
    const response = await this.#request(link, "snapshot", readToken, { method: "GET" });
    if (response.status !== 200) throw await this.#failure(response, "snapshot");
    let body: { envelope?: unknown; updatedAt?: unknown };
    try { body = await this.#json(response) as typeof body; } catch (error) { throw error instanceof CrabrixError ? error : unavailable("The learner's progress snapshot from Crabrix was not readable. Try again shortly."); }
    let envelope = body?.envelope;
    if (typeof envelope === "string") { try { envelope = JSON.parse(envelope); } catch { envelope = null; } }
    const plain = await openLearningLinkEnvelope(key, link.linkId, "snapshot", envelope, LEARNING_LINK_LIMITS.snapshotBytes);
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)); } catch { throw unavailable("The learner's progress snapshot is not valid JSON. Ask the learner to open Learn with AI in the Crabrix app so it syncs again."); }
    return { snapshot: validateLearningLinkSnapshot(parsed), updatedAt: typeof body.updatedAt === "string" && isLearningStateTime(body.updatedAt) ? body.updatedAt : null };
  }

  async #request(link: LearningLink, part: "snapshot" | "inbox", token: string, init: RequestInit): Promise<Response> {
    try {
      // The site uses trailing slashes; without one it redirects, and a redirect may drop Authorization.
      return await this.#fetch(`${this.origin}/api/learn-links/v1/${link.linkId}/${part}/`, {
        ...init, headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) },
        redirect: "error", cache: "no-store", signal: AbortSignal.timeout(this.#timeout) });
    } catch (error) {
      const network = networkError(error);
      throw unavailable("Could not reach Crabrix for the learner's learning link" + (network ? ` (${network.code === "TLS_ERROR" ? "TLS" : "network or timeout"})` : "") + ". Try again shortly." + (part === "inbox" ? " It is not known whether the message arrived, so do not resend it at once." : ""));
    }
  }

  /** The website answers {error:{code}}: NOT_FOUND (unknown link or wrong token), BAD_REQUEST, TOO_LARGE, 429 with Retry-After, UNAVAILABLE when paused. */
  async #failure(response: Response, part: "snapshot" | "inbox"): Promise<CrabrixError> {
    const status = response.status, body = await this.#json(response).catch(() => null) as { error?: { code?: unknown } } | null;
    const code = typeof body?.error?.code === "string" ? body.error.code : null;
    if (status === 404) return new CrabrixError("LEARN_LINK_NOT_FOUND", NOT_FOUND);
    if (status === 503) return unavailable("Crabrix learning links are paused right now. Teach from the public lessons and ask the learner where they are; try again later.");
    if (status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      const wait = Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds), 86_400) : null;
      return unavailable((part === "inbox" ? "Too many tutor messages for this learning link (at most 60 an hour); nothing was sent." : "Crabrix asked to slow down for this learning link.")
        + (wait ? ` Try again in ${wait} seconds.` : " Try again later."), wait ? { retryAfterSeconds: wait } : undefined);
    }
    if (status === 413 || code === "TOO_LARGE") return new CrabrixError("LIMIT_EXCEEDED", "Crabrix refused this tutor message as too large (the inbox takes 8 KB once encrypted). Shorten it; nothing was sent.");
    if (status === 400) return unavailable(`Crabrix refused this ${part === "inbox" ? "tutor message" : "request"} as malformed. Nothing was sent; this is a Crabrix MCP problem, not the learner's.`);
    return unavailable(`Crabrix answered ${status} for this learning link. Try again shortly.`);
  }

  async #json(response: Response): Promise<unknown> {
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_RESPONSE_BYTES) throw unavailable("The learning-link response was larger than this client accepts.");
    if (!response.body) return {};
    const reader = response.body.getReader(), parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => {}); throw unavailable("The learning-link response was larger than this client accepts."); }
      parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  }
}
