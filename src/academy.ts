// Read-only client for the public Crabrix Academy API (https://crabrix.com/api/academy/v1).
// It reads published lessons only. It never sends source code, room links or progress.
import { createHash } from "node:crypto";
import { CrabrixError, networkError } from "./errors.js";

export type AcademyLessonRef = {
  courseId: string; unitId: string; id: string; title: string; concept: string; summary: string; rule: string;
  minutes: number; exerciseKind: string; url: string; playground: boolean; bridgeFrom: string | null; credits: string[];
  /** "released": in the App Store app. "next-app-version": on the website first, in the app from its next version. */
  appAvailability?: AppAvailability;
};
export type AppAvailability = "released" | "next-app-version";
export type AcademyCourse = {
  id: string; title: string; subtitle: string; level: string; order: number; url: string; lessonCount: number;
  units: { id: string; title: string; subtitle: string; lessonIds: string[] }[];
};
export type AcademyPathSummary = { id: string; title: string; audience: string; description: string; stepCount: number };
export type AcademyExampleSummary = { id: string; title: string; detail: string; difficulty: string; category: string; concepts: string[] };
export type AcademyIndex = {
  schemaVersion: 1; catalogVersion: string; source?: { repository: string; commit: string };
  platforms?: Record<string, string>;
  courses: AcademyCourse[]; lessons: AcademyLessonRef[]; paths: AcademyPathSummary[]; examples: AcademyExampleSummary[];
  teachingContract: { version: string; url: string };
};
export type AcademyLesson = Record<string, any> & { courseId: string; id: string; title: string; url: string };
export type AcademyPath = { schemaVersion: 1; catalogVersion: string; id: string; title: string; audience: string; description: string;
  steps: { courseId: string; lessonId: string; title: string; url: string; note?: string }[] };
export type AcademyExample = Record<string, any> & { id: string; title: string };

export type AcademyOptions = {
  /** Site origin; the API lives under /api/academy/v1. Default: CRABRIX_ACADEMY_ORIGIN or https://crabrix.com. */
  origin?: string;
  fetch?: typeof fetch;
  /** How long a response is reused before it is revalidated with If-None-Match. */
  ttlMs?: number;
  timeoutMs?: number;
};

const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MAX_INDEX_BYTES = 4 * 1024 * 1024, MAX_BYTES = 1024 * 1024, MAX_ENTRIES = 256;

export function academyOrigin(origin?: string): string {
  const value = (origin ?? process.env.CRABRIX_ACADEMY_ORIGIN ?? "https://crabrix.com").replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(value); } catch { throw new CrabrixError("INVALID_ARGUMENT", "The Crabrix Academy origin must be an http(s) URL."); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new CrabrixError("INVALID_ARGUMENT", "The Crabrix Academy origin must be a plain http(s) origin.");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export function checkId(value: string, what: string): string {
  if (!ID.test(value)) throw new CrabrixError("INVALID_ARGUMENT", `Unknown ${what}: use an id from crabrix_academy_catalog or crabrix_academy_search.`);
  return value;
}

type Entry = { etag: string | null; body: string; fetchedAt: number };

export class AcademyClient {
  readonly origin: string;
  readonly #fetch: typeof fetch;
  readonly #ttl: number;
  readonly #timeout: number;
  readonly #cache = new Map<string, Entry>();
  readonly #pending = new Map<string, Promise<string>>();

  constructor(options: AcademyOptions = {}) {
    this.origin = academyOrigin(options.origin);
    this.#fetch = options.fetch ?? fetch;
    this.#ttl = options.ttlMs ?? 5 * 60_000;
    this.#timeout = options.timeoutMs ?? 15_000;
  }

  async index(): Promise<AcademyIndex> {
    const index = JSON.parse(await this.#text("index.json", MAX_INDEX_BYTES)) as AcademyIndex;
    if (index?.schemaVersion !== 1 || !Array.isArray(index.lessons) || !Array.isArray(index.courses)) throw unavailable("The Academy index has an unsupported format. Update Crabrix.");
    index.paths ??= []; index.examples ??= [];
    return index;
  }
  async lesson(courseId: string, lessonId: string): Promise<AcademyLesson> {
    return JSON.parse(await this.#text(`lessons/${encodeURIComponent(checkId(courseId, "course"))}/${encodeURIComponent(checkId(lessonId, "lesson"))}.json`));
  }
  async path(pathId: string): Promise<AcademyPath> {
    return JSON.parse(await this.#text(`paths/${encodeURIComponent(checkId(pathId, "learning path"))}.json`));
  }
  async example(exampleId: string): Promise<AcademyExample> {
    return JSON.parse(await this.#text(`examples/${encodeURIComponent(checkId(exampleId, "example"))}.json`));
  }
  async contract(): Promise<string> { return this.#text("teaching-contract.md"); }

  /** One request per path at a time; a fresh copy is reused, a stale one is revalidated. */
  #text(path: string, limit = MAX_BYTES): Promise<string> {
    const pending = this.#pending.get(path);
    if (pending) return pending;
    const work = this.#load(path, limit).finally(() => this.#pending.delete(path));
    this.#pending.set(path, work);
    return work;
  }

  async #load(path: string, limit: number): Promise<string> {
    const cached = this.#cache.get(path);
    if (cached && Date.now() - cached.fetchedAt < this.#ttl) return cached.body;
    const headers: Record<string, string> = { Accept: path.endsWith(".md") ? "text/markdown, text/plain" : "application/json" };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    let response: Response;
    try {
      response = await this.#fetch(`${this.origin}/api/academy/v1/${path}`, { headers, redirect: "error", signal: AbortSignal.timeout(this.#timeout) });
    } catch (error) {
      if (cached) return cached.body;
      const network = networkError(error);
      throw unavailable("Could not reach Crabrix Academy" + (network ? ` (${network.code === "TLS_ERROR" ? "TLS" : "network"})` : "") + ". Try again shortly; lessons are also public at https://crabrix.com/learn/.");
    }
    if (response.status === 304 && cached) {
      cached.fetchedAt = Date.now();
      return cached.body;
    }
    if (response.status === 404) throw new CrabrixError("ACADEMY_NOT_FOUND", "Crabrix Academy has no such item. Use ids from crabrix_academy_catalog or crabrix_academy_search.");
    if (!response.ok) {
      if (cached) return cached.body;
      throw unavailable(`Crabrix Academy answered ${response.status}. Try again shortly.`);
    }
    const body = await readLimited(response, limit);
    this.#cache.delete(path);
    this.#cache.set(path, { etag: response.headers.get("etag"), body, fetchedAt: Date.now() });
    while (this.#cache.size > MAX_ENTRIES) this.#cache.delete(this.#cache.keys().next().value!);
    return body;
  }
}

const unavailable = (message: string) => new CrabrixError("ACADEMY_UNAVAILABLE", message);

async function readLimited(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) throw new CrabrixError("LIMIT_EXCEEDED", "A Crabrix Academy response was larger than this client accepts.");
  if (!response.body) return "";
  const reader = response.body.getReader(), parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => {}); throw new CrabrixError("LIMIT_EXCEEDED", "A Crabrix Academy response was larger than this client accepts."); }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

// ---- Search -----------------------------------------------------------------

const STOP = new Set("a an and are as at be by do for from how i in is it me my of on or rust the to vs versus what when with developer developers programmer programmers learn learning lesson lessons".split(" "));
const SYNONYMS: Record<string, string[]> = {
  node: ["nodejs", "javascript", "typescript", "npm", "promise"], nodejs: ["node", "javascript", "typescript"], js: ["javascript", "node"],
  javascript: ["node", "nodejs", "typescript"], typescript: ["javascript", "node", "ts"], ts: ["typescript"],
  c: ["malloc", "free", "pointer", "pointers", "unsafe", "ffi"], memory: ["ownership", "drop", "malloc", "free", "heap", "allocation", "box", "borrow", "borrowing", "garbage"],
  management: ["ownership", "drop"], gc: ["garbage", "collector"], tokio: ["async", "futures", "future", "runtime", "joinset", "semaphore", "await"],
  concurrency: ["thread", "threads", "async", "mutex", "channel", "channels", "send", "sync"], async: ["future", "futures", "await", "tokio", "runtime"],
  error: ["result", "errors", "failure", "panic", "recoverable"], handling: ["result"], trait: ["traits", "bound", "bounds", "impl", "dyn"],
  generic: ["generics", "trait", "monomorphization"], ownership: ["borrow", "borrowing", "move", "moves", "drop"], lifetime: ["lifetimes", "borrow"],
};
const SOURCE: Record<string, string[]> = { c: ["c"], javascript: ["node", "nodejs", "js", "javascript"], typescript: ["typescript", "ts", "node", "nodejs"] };

export function tokens(text: string): string[] {
  return text.toLowerCase().replace(/node\.js/g, "nodejs").split(/[^a-z0-9+#]+/).filter(Boolean).map(stem);
}
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1);
  return word;
}

export type SearchHit = { lesson: AcademyLessonRef; score: number };

/** Deterministic ranking: field weights, synonyms at a lower weight, then catalog order. */
export function searchLessons(index: AcademyIndex, query: string, courseId?: string): SearchHit[] {
  const words = tokens(query).filter(word => !STOP.has(word));
  if (!words.length) return [];
  const weighted = new Map<string, number>();
  for (const word of words) {
    weighted.set(word, Math.max(weighted.get(word) ?? 0, 1));
    for (const synonym of SYNONYMS[word] ?? []) { const s = stem(synonym); weighted.set(s, Math.max(weighted.get(s) ?? 0, 0.5)); }
  }
  const courses = new Map(index.courses.map(course => [course.id, course]));
  const units = new Map(index.courses.flatMap(course => course.units.map(unit => [`${course.id}/${unit.id}`, unit] as const)));
  const wantsAlgorithms = words.some(word => /^(algorithm|atla|pattern|leetcode|interview)$/.test(word));
  const hits: SearchHit[] = [];
  index.lessons.forEach((lesson, order) => {
    if (courseId && lesson.courseId !== courseId) return;
    const course = courses.get(lesson.courseId), unit = units.get(`${lesson.courseId}/${lesson.unitId}`);
    const fields: [Set<string>, number][] = [
      [new Set(tokens(lesson.title)), 6], [new Set(tokens(lesson.concept)), 4], [new Set(tokens(course?.title ?? "")), 3],
      [new Set(tokens(unit?.title ?? "")), 2], [new Set(tokens(lesson.summary)), 2], [new Set(tokens(lesson.rule)), 1],
      [new Set(lesson.bridgeFrom ? SOURCE[lesson.bridgeFrom] ?? [] : []), 5],
    ];
    let score = 0, matched = 0;
    for (const [word, weight] of weighted) {
      let best = 0;
      for (const [set, fieldWeight] of fields) if (set.has(word)) best = Math.max(best, fieldWeight);
      if (best) { score += best * weight; if (weight === 1) matched++; }
    }
    if (!score) return;
    // A lesson whose title is only words the learner asked for is about exactly that topic.
    const titleWords = tokens(lesson.title).filter(word => !STOP.has(word));
    if (titleWords.length && titleWords.every(word => weighted.get(word) === 1)) score += 6;
    // Lessons that match more of the words the learner typed come first.
    score *= 1 + matched / words.length;
    if (lesson.courseId === "algorithms" && !wantsAlgorithms && !courseId) score *= 0.5;
    hits.push({ lesson, score: Math.round(score * 1000) / 1000 + (index.lessons.length - order) / 1e9 });
  });
  return hits.sort((a, b) => b.score - a.score);
}

export function searchCourses(index: AcademyIndex, query: string) {
  const words = new Set(tokens(query).filter(word => !STOP.has(word)));
  return index.courses
    .map(course => ({ course, score: [...new Set(tokens(course.title + " " + course.subtitle))].filter(word => words.has(word)).length }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.course.order - b.course.order)
    .map(entry => entry.course);
}

// ---- Cursors ----------------------------------------------------------------

/** Opaque, bound to the request it continues: a cursor from another query is refused. */
export function encodeCursor(offset: number, scope: string): string {
  return Buffer.from(JSON.stringify({ o: offset, s: createHash("sha256").update(scope).digest("hex").slice(0, 16) })).toString("base64url");
}
export function decodeCursor(cursor: string | undefined, scope: string): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Number.isInteger(value.o) && value.o >= 0 && value.s === createHash("sha256").update(scope).digest("hex").slice(0, 16)) return value.o;
  } catch { /* refused below */ }
  throw new CrabrixError("INVALID_ARGUMENT", "This cursor belongs to a different request. Repeat the request without a cursor.");
}
export function page<T>(items: T[], offset: number, limit: number, scope: string) {
  const slice = items.slice(offset, offset + limit), next = offset + limit < items.length ? encodeCursor(offset + limit, scope) : undefined;
  return { items: slice, total: items.length, ...(next ? { nextCursor: next } : {}) };
}
