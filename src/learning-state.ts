// AI Learning State v1: a portable JSON file the learner owns (docs/ai-learning/PLAN.md,
// "Phase 5"; schema: crabrix-courses academy/learning-state.schema.json). It is never the
// official progress record. Everything here is a pure function: nothing is read from disk,
// stored or sent anywhere.
import { CrabrixError } from "./errors.js";

export const LEARNING_STATE_FORMAT = "crabrix.ai-learning-state";
export const LEARNING_STATE_SCHEMA_VERSION = 1;
export const LEARNING_STATE_MAX_BYTES = 512 * 1024;

export type TeachingMode = "guided" | "socratic" | "pair" | "review";
export type LearnerBackground = "beginner" | "nodejs" | "c" | "experienced" | "other";
export type EvidenceKind = "discussed" | "compiled_by_learner" | "ran_by_learner" | "ai_reviewed";
export type OfficialProgressSource = "crabrix-ios" | "crabrix-backup-file";
export type LessonRef = { courseId: string; lessonId: string };
/** `courseId` is null when the app no longer has that course installed. */
export type ProgressLesson = { courseId: string | null; lessonId: string };
export type CreditedLesson = { courseId: string | null; lessonId: string; viaLessonId: string };
export type EvidenceItem = { courseId: string | null; lessonId: string; kind: EvidenceKind; at: string };
export type OfficialProgress = {
  source: OfficialProgressSource; capturedAt: string; appVersion: string | null;
  completed: ProgressLesson[]; credited: CreditedLesson[];
};
/** The canonical form every function here returns: all sections present, lists sorted. */
export type AILearningState = {
  format: typeof LEARNING_STATE_FORMAT;
  schemaVersion: 1;
  updatedAt: string;
  producer?: string;
  learningPath: string | null;
  teachingMode?: TeachingMode;
  currentLesson: LessonRef | null;
  learner: { background: LearnerBackground | null; knownTechnologies: string[]; preferredLanguage: string | null; goal: string | null };
  aiSession: { lastSummary: string; suggestedNextLesson: LessonRef | null; conceptsNeedingReview: string[] };
  officialProgress: OfficialProgress | null;
  evidence: EvidenceItem[];
};

export type LearningStateValidation =
  | { ok: true; state: AILearningState; droppedKeys: string[]; notes: string[] }
  | { ok: false; errors: string[]; droppedKeys: string[]; needsNewerCrabrix?: true };

const MODES: readonly string[] = ["guided", "socratic", "pair", "review"];
const BACKGROUNDS: readonly string[] = ["beginner", "nodejs", "c", "experienced", "other"];
const KINDS: readonly string[] = ["discussed", "compiled_by_learner", "ran_by_learner", "ai_reviewed"];
const SOURCES: readonly string[] = ["crabrix-ios", "crabrix-backup-file"];
const ID = /^[a-z0-9][a-z0-9.-]{0,159}$/;
const PATH_ID = /^[a-z0-9-]{1,128}$/;
const TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const LIMITS = { completed: 10_000, credited: 10_000, evidence: 500, knownTechnologies: 20, technology: 60, concepts: 50, concept: 80,
  producer: 80, appVersion: 40, preferredLanguage: 35, goal: 500, lastSummary: 2000, depth: 32, errors: 40, droppedKeys: 200 };
const KEYS = {
  root: ["format", "schemaVersion", "updatedAt", "producer", "learningPath", "teachingMode", "currentLesson", "learner", "aiSession", "officialProgress", "evidence"],
  lesson: ["courseId", "lessonId"],
  learner: ["background", "knownTechnologies", "preferredLanguage", "goal"],
  aiSession: ["lastSummary", "suggestedNextLesson", "conceptsNeedingReview"],
  officialProgress: ["source", "capturedAt", "appVersion", "completed", "credited"],
  credited: ["courseId", "lessonId", "viaLessonId"],
  evidence: ["courseId", "lessonId", "kind", "at"],
};

// A state must never carry a capability or credential. Values are never echoed back;
// only the field and the kind of secret are named.
const SECRETS: [RegExp, string][] = [
  [/\/playground\/room\/[A-Za-z0-9_-]{24}\/?#\S*\bkey=/, "a Crabrix room link with its key"],
  [/\/mcp\/[A-Za-z0-9_-]{24}\/[A-Za-z0-9_-]{43}(?:\/[A-Za-z0-9_-]{43}|\/?#key=)/, "a Crabrix agent link with its key"],
  [/[#&?]key=[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/, "a Crabrix room key"],
  [/-----BEGIN [A-Z0-9 ]{2,60}-----/, "a private key or certificate block"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, "a GitHub token"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/, "a GitLab token"],
  [/\bsk-[A-Za-z0-9_-]{20,}/, "an API secret key"],
  [/\b[rs]k_live_[A-Za-z0-9]{16,}/, "an API secret key"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "a cloud access key"],
  [/\bAIza[0-9A-Za-z_-]{35}/, "a cloud API key"],
  [/\bnpm_[A-Za-z0-9]{36}\b/, "an npm token"],
];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const length = (text: string) => [...text].length;
const safeKey = (key: string) => /^[A-Za-z0-9_$-]{1,64}$/.test(key) ? key : "<key>";
const join = (path: string, key: string) => path ? `${path}.${key}` : key;
const timeValue = (text: string) => Date.parse(text);

/** RFC 3339 in UTC ("Z"), at most millisecond precision, 2020 through 2100. */
export function isLearningStateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = TIME.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (year < 2020 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}

/** The current time in the state's format, to the second. */
export const learningStateNow = (now = new Date()) => now.toISOString().replace(/\.\d{3}Z$/, "Z");

class Reader {
  readonly errors: string[] = [];
  readonly dropped = new Set<string>();
  readonly notes: string[] = [];
  fail(path: string, message: string) { if (this.errors.length < LIMITS.errors) this.errors.push(`${path || "state"}: ${message}`); }
  /** The object's known keys; anything else is dropped and reported with [] for array positions. */
  object(value: unknown, path: string, report: string, keys: string[]): Record<string, unknown> | undefined {
    if (!isObject(value)) { this.fail(path, "must be an object"); return undefined; }
    for (const key of Object.keys(value)) if (!keys.includes(key) && this.dropped.size < LIMITS.droppedKeys) this.dropped.add(join(report, safeKey(key)));
    return value;
  }
  id(value: unknown, path: string, nullable: false): string | undefined;
  id(value: unknown, path: string, nullable: true): string | null | undefined;
  id(value: unknown, path: string, nullable: boolean) {
    if (nullable && (value === null || value === undefined)) return null;
    if (typeof value === "string" && ID.test(value)) return value;
    this.fail(path, `must be an id: lowercase letters, digits, "." and "-", starting with a letter or digit, at most 160 characters${nullable ? ", or null" : ""}`);
    return undefined;
  }
  time(value: unknown, path: string): string | undefined {
    if (isLearningStateTime(value)) return value;
    this.fail(path, "must be an RFC 3339 UTC time between 2020 and 2100, such as 2026-11-23T18:00:00Z");
    return undefined;
  }
  /** Optional free text: trimmed; empty becomes null. */
  text(value: unknown, path: string, limit: number): string | null | undefined {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") { this.fail(path, "must be a string or null"); return undefined; }
    const text = value.trim();
    if (length(text) > limit) { this.fail(path, `must be at most ${limit} characters`); return undefined; }
    return text || null;
  }
  enumValue<T extends string>(value: unknown, path: string, values: readonly string[], nullable: boolean): T | null | undefined {
    if (value === null || value === undefined) return null;
    if (typeof value === "string" && values.includes(value)) return value as T;
    this.fail(path, `must be one of ${values.join(", ")}${nullable ? " or null" : ""}`);
    return undefined;
  }
  lesson(value: unknown, path: string): LessonRef | null | undefined {
    if (value === null || value === undefined) return null;
    const object = this.object(value, path, path, KEYS.lesson);
    if (!object) return undefined;
    const courseId = this.id(object.courseId, `${path}.courseId`, false), lessonId = this.id(object.lessonId, `${path}.lessonId`, false);
    return courseId && lessonId ? { courseId, lessonId } : undefined;
  }
  list(value: unknown, path: string, max: number, itemLimit: number): string[] {
    if (value === null || value === undefined) return [];
    if (!Array.isArray(value)) { this.fail(path, "must be an array of strings"); return []; }
    if (value.length > max) { this.fail(path, `must have at most ${max} items`); return []; }
    const items: string[] = [];
    value.forEach((item, index) => {
      const text = typeof item === "string" ? item.trim() : "";
      if (typeof item !== "string" || !text || length(text) > itemLimit) this.fail(`${path}[${index}]`, `must be a non-empty string of at most ${itemLimit} characters`);
      else items.push(text);
    });
    return uniqueSorted(items);
  }
}

/** Case-insensitive set, sorted; of two spellings the one that sorts first is kept. */
function uniqueSorted(items: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const item of items) {
    const key = item.toLowerCase(), known = byKey.get(key);
    if (known === undefined || item < known) byKey.set(key, item);
  }
  return [...byKey.values()].sort(compareText);
}
const compareText = (a: string, b: string) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0; };
const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const byLesson = (a: { lessonId: string }, b: { lessonId: string }) => compareId(a.lessonId, b.lessonId);
const byTime = (a: EvidenceItem, b: EvidenceItem) => timeValue(a.at) - timeValue(b.at) || compareId(a.lessonId, b.lessonId) || compareId(a.kind, b.kind);
const evidenceKey = (item: { lessonId: string; kind: string }) => `${item.lessonId}\u0000${item.kind}`;

/** Walks the raw value once: bounded depth, and no string or key that looks like a secret. */
function scan(value: unknown, reader: Reader, path = "", depth = 0): void {
  if (depth > LIMITS.depth) { reader.fail(path, `nests deeper than ${LIMITS.depth} levels`); return; }
  if (typeof value === "string") {
    for (const [pattern, what] of SECRETS) if (pattern.test(value)) { reader.fail(path, `contains what looks like ${what}. Remove it: an AI Learning State never carries links with keys, credentials or tokens`); break; }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => scan(item, reader, `${path}[${index}]`, depth + 1));
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const named = SECRETS.find(([pattern]) => pattern.test(key));
      if (named) reader.fail(path, `has a key that looks like ${named[1]}. Remove it`);
      scan(item, reader, join(path, named ? "<key>" : safeKey(key)), depth + 1);
    }
  }
}

/**
 * Checks a state against v1 and returns its canonical form. Unknown keys are dropped and
 * listed; a newer schemaVersion is refused without reading anything else.
 */
export function validateLearningState(input: unknown): LearningStateValidation {
  const reader = new Reader();
  if (!isObject(input)) return { ok: false, errors: ["state: must be a JSON object (an AI Learning State, format crabrix.ai-learning-state)"], droppedKeys: [] };
  scan(input, reader);
  if (reader.errors.some(error => error.includes("nests deeper"))) return { ok: false, errors: reader.errors, droppedKeys: [] };
  const bytes = Buffer.byteLength(JSON.stringify(input), "utf8");
  if (bytes > LEARNING_STATE_MAX_BYTES) return { ok: false, errors: [`state: is ${bytes} bytes; an AI Learning State is at most 512 KB of UTF-8 JSON`], droppedKeys: [] };
  if (input.format !== LEARNING_STATE_FORMAT) return { ok: false, errors: [`format: must be "${LEARNING_STATE_FORMAT}"; this is not an AI Learning State`], droppedKeys: [] };
  const version = input.schemaVersion;
  if (typeof version === "number" && Number.isInteger(version) && version > LEARNING_STATE_SCHEMA_VERSION)
    return { ok: false, needsNewerCrabrix: true, droppedKeys: [], errors: [`schemaVersion: this AI Learning State has schema version ${version} and needs a newer Crabrix. Update Crabrix (npm crabrix) to read it; nothing was read from it.`] };
  if (version !== LEARNING_STATE_SCHEMA_VERSION) reader.fail("schemaVersion", "must be 1");
  const root = reader.object(input, "", "", KEYS.root)!;
  const secretFound = reader.errors.length > 0;

  const updatedAt = reader.time(root.updatedAt, "updatedAt");
  let producer: string | null | undefined = null;
  if (root.producer !== undefined && root.producer !== null) {
    if (typeof root.producer !== "string") reader.fail("producer", "must be a string");
    else producer = reader.text(root.producer, "producer", LIMITS.producer);
  }
  let learningPath: string | null = null;
  if (root.learningPath !== undefined && root.learningPath !== null) {
    if (typeof root.learningPath === "string" && PATH_ID.test(root.learningPath)) learningPath = root.learningPath;
    else reader.fail("learningPath", "must be a learning path id (lowercase letters, digits and \"-\", at most 128) or null");
  }
  const teachingMode = reader.enumValue<TeachingMode>(root.teachingMode, "teachingMode", MODES, false);
  const currentLesson = reader.lesson(root.currentLesson, "currentLesson");

  const learnerInput = root.learner === undefined || root.learner === null ? {} : reader.object(root.learner, "learner", "learner", KEYS.learner) ?? {};
  const learner = {
    background: reader.enumValue<LearnerBackground>(learnerInput.background, "learner.background", BACKGROUNDS, true) ?? null,
    knownTechnologies: reader.list(learnerInput.knownTechnologies, "learner.knownTechnologies", LIMITS.knownTechnologies, LIMITS.technology),
    preferredLanguage: reader.text(learnerInput.preferredLanguage, "learner.preferredLanguage", LIMITS.preferredLanguage) ?? null,
    goal: reader.text(learnerInput.goal, "learner.goal", LIMITS.goal) ?? null,
  };
  const sessionInput = root.aiSession === undefined || root.aiSession === null ? {} : reader.object(root.aiSession, "aiSession", "aiSession", KEYS.aiSession) ?? {};
  const aiSession = {
    lastSummary: reader.text(sessionInput.lastSummary, "aiSession.lastSummary", LIMITS.lastSummary) ?? "",
    suggestedNextLesson: reader.lesson(sessionInput.suggestedNextLesson, "aiSession.suggestedNextLesson") ?? null,
    conceptsNeedingReview: reader.list(sessionInput.conceptsNeedingReview, "aiSession.conceptsNeedingReview", LIMITS.concepts, LIMITS.concept),
  };
  const officialProgress = readOfficialProgress(root.officialProgress, reader);
  const evidence = readEvidence(root.evidence, reader);

  const droppedKeys = secretFound ? [] : [...reader.dropped].sort(compareId);
  if (reader.errors.length || !updatedAt) return { ok: false, errors: reader.errors.length ? reader.errors : ["updatedAt: is required"], droppedKeys };
  const state: AILearningState = {
    format: LEARNING_STATE_FORMAT, schemaVersion: 1, updatedAt, ...(producer ? { producer } : {}), learningPath,
    ...(teachingMode ? { teachingMode } : {}), currentLesson: currentLesson ?? null, learner, aiSession, officialProgress: officialProgress ?? null, evidence,
  };
  return { ok: true, state, droppedKeys, notes: reader.notes };
}

function readOfficialProgress(value: unknown, reader: Reader): OfficialProgress | null | undefined {
  if (value === null || value === undefined) return null;
  const object = reader.object(value, "officialProgress", "officialProgress", KEYS.officialProgress);
  if (!object) return undefined;
  const source = reader.enumValue<OfficialProgressSource>(object.source, "officialProgress.source", SOURCES, false);
  if (source === null) reader.fail("officialProgress.source", `is required: ${SOURCES.join(" or ")}`);
  const capturedAt = reader.time(object.capturedAt, "officialProgress.capturedAt");
  let appVersion: string | null | undefined = null;
  if (object.appVersion !== undefined && object.appVersion !== null) {
    if (typeof object.appVersion !== "string") reader.fail("officialProgress.appVersion", "must be a string or null");
    else appVersion = reader.text(object.appVersion, "officialProgress.appVersion", LIMITS.appVersion);
  }
  const completed = new Map<string, ProgressLesson>(), credited = new Map<string, CreditedLesson>();
  const entries = (list: unknown, name: "completed" | "credited", read: (item: unknown, path: string) => void) => {
    if (!Array.isArray(list)) { reader.fail(`officialProgress.${name}`, "is required: an array (it may be empty)"); return; }
    if (list.length > LIMITS[name]) { reader.fail(`officialProgress.${name}`, `must have at most ${LIMITS[name]} items`); return; }
    list.forEach((item, index) => read(item, `officialProgress.${name}[${index}]`));
  };
  let duplicates = 0;
  entries(object.completed, "completed", (item, path) => {
    const entry = reader.object(item, path, "officialProgress.completed[]", KEYS.lesson);
    if (!entry) return;
    const courseId = reader.id(entry.courseId, `${path}.courseId`, true), lessonId = reader.id(entry.lessonId, `${path}.lessonId`, false);
    if (courseId === undefined || !lessonId) return;
    const known = completed.get(lessonId);
    if (known) { duplicates++; if (known.courseId === null) known.courseId = courseId; } else completed.set(lessonId, { courseId, lessonId });
  });
  entries(object.credited, "credited", (item, path) => {
    const entry = reader.object(item, path, "officialProgress.credited[]", KEYS.credited);
    if (!entry) return;
    const courseId = reader.id(entry.courseId, `${path}.courseId`, true), lessonId = reader.id(entry.lessonId, `${path}.lessonId`, false);
    const viaLessonId = reader.id(entry.viaLessonId, `${path}.viaLessonId`, false);
    if (courseId === undefined || !lessonId || !viaLessonId) return;
    const known = credited.get(lessonId);
    if (known) { duplicates++; if (known.courseId === null) known.courseId = courseId; } else credited.set(lessonId, { courseId, lessonId, viaLessonId });
  });
  if (!source || !capturedAt || appVersion === undefined) return undefined;
  let superseded = 0;
  for (const lessonId of credited.keys()) if (completed.has(lessonId)) { credited.delete(lessonId); superseded++; }
  if (duplicates) reader.notes.push(`officialProgress: ${duplicates} repeated lesson${duplicates === 1 ? "" : "s"} combined`);
  if (superseded) reader.notes.push(`officialProgress: ${superseded} credited lesson${superseded === 1 ? " is" : "s are"} also completed and kept only as completed`);
  return { source, capturedAt, appVersion, completed: [...completed.values()].sort(byLesson), credited: [...credited.values()].sort(byLesson) };
}

function readEvidence(value: unknown, reader: Reader): EvidenceItem[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) { reader.fail("evidence", "must be an array"); return []; }
  if (value.length > LIMITS.evidence) { reader.fail("evidence", `must have at most ${LIMITS.evidence} items`); return []; }
  const items = new Map<string, EvidenceItem>();
  let repeated = 0;
  value.forEach((item, index) => {
    const path = `evidence[${index}]`, entry = reader.object(item, path, "evidence[]", KEYS.evidence);
    if (!entry) return;
    const courseId = reader.id(entry.courseId, `${path}.courseId`, true), lessonId = reader.id(entry.lessonId, `${path}.lessonId`, false);
    const kind = reader.enumValue<EvidenceKind>(entry.kind, `${path}.kind`, KINDS, false), at = reader.time(entry.at, `${path}.at`);
    if (kind === null) reader.fail(`${path}.kind`, `is required: ${KINDS.join(", ")}`);
    if (courseId === undefined || !lessonId || !kind || !at) return;
    const next: EvidenceItem = { courseId, lessonId, kind, at }, key = evidenceKey(next), known = items.get(key);
    if (known) repeated++;
    items.set(key, known ? laterEvidence(known, next) : next);
  });
  if (repeated) reader.notes.push(`evidence: ${repeated} repeated item${repeated === 1 ? "" : "s"} (same lesson and kind) combined, keeping the later time`);
  return [...items.values()].sort(byTime);
}

/** The later `at` wins; on a tie the entry that names its course, then the first one. */
function laterEvidence(first: EvidenceItem, second: EvidenceItem): EvidenceItem {
  const delta = timeValue(second.at) - timeValue(first.at);
  if (delta > 0) return second;
  if (delta < 0) return first;
  return first.courseId === null && second.courseId !== null ? second : first;
}

/** Validates or throws: INVALID_ARGUMENT, or CLIENT_UPDATE_REQUIRED for a newer schema version. */
export function readLearningState(input: unknown, what = "state"): { state: AILearningState; droppedKeys: string[]; notes: string[] } {
  const result = validateLearningState(input);
  if (result.ok) return result;
  throw invalidState(result, what);
}

function invalidState(result: Extract<LearningStateValidation, { ok: false }>, what: string): CrabrixError {
  if (result.needsNewerCrabrix) return new CrabrixError("CLIENT_UPDATE_REQUIRED", result.errors[0].replace(/^schemaVersion: this AI Learning State/, `The ${what}`), { errors: result.errors });
  const shown = result.errors.slice(0, 6).join("; ") + (result.errors.length > 6 ? `; and ${result.errors.length - 6} more` : "");
  return new CrabrixError("INVALID_ARGUMENT", `The ${what} is not a valid AI Learning State v1: ${shown}`, { errors: result.errors, droppedKeys: result.droppedKeys });
}

// ---- Template ------------------------------------------------------------------

/** An empty v1 state for an agent to fill with context and evidence. It has no official progress. */
export function learningStateTemplate(now = new Date()): AILearningState {
  return {
    format: LEARNING_STATE_FORMAT, schemaVersion: 1, updatedAt: learningStateNow(now), learningPath: null, currentLesson: null,
    learner: { background: null, knownTechnologies: [], preferredLanguage: null, goal: null },
    aiSession: { lastSummary: "", suggestedNextLesson: null, conceptsNeedingReview: [] },
    officialProgress: null, evidence: [],
  };
}

// ---- Merge ---------------------------------------------------------------------

type Count = { kept: number; added: number; total: number };
export type LearningStateMergeReport = {
  updatedAt: { base: string; incoming: string; result: string };
  /** The side whose context fields win (the later updatedAt; incoming on a tie). */
  newerSide: "base" | "incoming";
  context: { fromIncoming: string[]; keptFromBase: string[] };
  officialProgress: {
    /** Where source, capturedAt and appVersion came from: the later capture. */
    captureFrom: "base" | "incoming" | null;
    completed: Count;
    credited: Count & { droppedBecauseCompleted: number };
  };
  evidence: Count & { updated: number; droppedOldest: number };
  knownTechnologies: Count & { droppedOverLimit: number };
  conceptsNeedingReview: Count & { droppedOverLimit: number };
  droppedKeys: { base: string[]; incoming: string[] };
  notes: string[];
};

const isEmpty = (value: unknown) => value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The only way two states combine (PLAN.md Phase 5): official progress is a union that never
 * loses a lesson, evidence a union by (lessonId, kind), context from the later updatedAt
 * without letting an empty value replace a filled one. Deterministic and idempotent.
 */
export function mergeLearningStates(base: unknown, incoming: unknown): { state: AILearningState; report: LearningStateMergeReport } {
  const left = validateLearningState(base), right = validateLearningState(incoming);
  if (!left.ok || !right.ok) {
    const newer = [!left.ok && left.needsNewerCrabrix ? "base state" : "", !right.ok && right.needsNewerCrabrix ? "incoming state" : ""].filter(Boolean);
    if (newer.length) throw new CrabrixError("CLIENT_UPDATE_REQUIRED", `The ${newer.join(" and the ")} ${newer.length > 1 ? "need" : "needs"} a newer Crabrix (a higher schemaVersion). Update Crabrix (npm crabrix); nothing was merged.`);
    const errors = [...(left.ok ? [] : left.errors.map(error => `base ${error}`)), ...(right.ok ? [] : right.errors.map(error => `incoming ${error}`))];
    throw new CrabrixError("INVALID_ARGUMENT", `Nothing was merged: ${errors.slice(0, 6).join("; ")}${errors.length > 6 ? `; and ${errors.length - 6} more` : ""}`, { errors });
  }
  const a = left.state, b = right.state;
  const incomingNewer = timeValue(b.updatedAt) >= timeValue(a.updatedAt);
  const newer = incomingNewer ? b : a, older = incomingNewer ? a : b;
  const fromIncoming: string[] = [], keptFromBase: string[] = [];
  const baseValue = (name: string): unknown => name.split(".").reduce<any>((object, key) => object?.[key], a);
  // Field by field: the newer side's value, unless it is empty.
  const pick = <T>(name: string, newerValue: T, olderValue: T): T => {
    const value = isEmpty(newerValue) ? olderValue : newerValue;
    if (!isEmpty(value)) (sameValue(value, baseValue(name)) ? keptFromBase : fromIncoming).push(name);
    return value;
  };

  const producer = pick("producer", newer.producer, older.producer);
  const learningPath = pick("learningPath", newer.learningPath, older.learningPath);
  const teachingMode = pick("teachingMode", newer.teachingMode, older.teachingMode);
  const currentLesson = pick("currentLesson", newer.currentLesson, older.currentLesson);
  const background = pick("learner.background", newer.learner.background, older.learner.background);
  const preferredLanguage = pick("learner.preferredLanguage", newer.learner.preferredLanguage, older.learner.preferredLanguage);
  const goal = pick("learner.goal", newer.learner.goal, older.learner.goal);
  const lastSummary = pick("aiSession.lastSummary", newer.aiSession.lastSummary, older.aiSession.lastSummary);
  const suggestedNextLesson = pick("aiSession.suggestedNextLesson", newer.aiSession.suggestedNextLesson, older.aiSession.suggestedNextLesson);
  const technologies = unionList(a.learner.knownTechnologies, b.learner.knownTechnologies, LIMITS.knownTechnologies);
  const concepts = unionList(a.aiSession.conceptsNeedingReview, b.aiSession.conceptsNeedingReview, LIMITS.concepts);
  const progress = mergeOfficial(a.officialProgress, b.officialProgress);
  const evidence = mergeEvidence(a.evidence, b.evidence);

  const state: AILearningState = {
    format: LEARNING_STATE_FORMAT, schemaVersion: 1, updatedAt: newer.updatedAt, ...(producer ? { producer } : {}), learningPath,
    ...(teachingMode ? { teachingMode } : {}), currentLesson,
    learner: { background, knownTechnologies: technologies.items, preferredLanguage, goal },
    aiSession: { lastSummary, suggestedNextLesson, conceptsNeedingReview: concepts.items },
    officialProgress: progress.value, evidence: evidence.items,
  };
  return { state, report: {
    updatedAt: { base: a.updatedAt, incoming: b.updatedAt, result: state.updatedAt }, newerSide: incomingNewer ? "incoming" : "base",
    context: { fromIncoming, keptFromBase },
    officialProgress: progress.report, evidence: evidence.report,
    knownTechnologies: technologies.report, conceptsNeedingReview: concepts.report,
    droppedKeys: { base: left.droppedKeys, incoming: right.droppedKeys },
    notes: [...left.notes.map(note => `base ${note}`), ...right.notes.map(note => `incoming ${note}`)],
  } };
}

function unionList(base: string[], incoming: string[], limit: number) {
  const all = uniqueSorted([...base, ...incoming]), items = all.slice(0, limit), known = new Set(base.map(item => item.toLowerCase()));
  const kept = items.filter(item => known.has(item.toLowerCase())).length;
  return { items, report: { kept, added: items.length - kept, total: items.length, droppedOverLimit: all.length - items.length } };
}

function mergeOfficial(base: OfficialProgress | null, incoming: OfficialProgress | null) {
  const empty = { kept: 0, added: 0, total: 0 };
  if (!base && !incoming) return { value: null, report: { captureFrom: null, completed: empty, credited: { ...empty, droppedBecauseCompleted: 0 } } };
  const incomingLater = !base || (!!incoming && timeValue(incoming.capturedAt) >= timeValue(base.capturedAt));
  const later = (incomingLater ? incoming : base)!;
  // Same lesson on both sides: keep a known course over null; on a real conflict the later capture's.
  const course = (known: string | null, other: string | null, otherIsLater: boolean) => known === null ? other : other !== null && otherIsLater ? other : known;
  const union = <T extends { courseId: string | null; lessonId: string }>(left: T[], right: T[]) => {
    const map = new Map<string, T>(left.map(item => [item.lessonId, { ...item }]));
    for (const item of right) {
      const known = map.get(item.lessonId);
      if (!known) { map.set(item.lessonId, { ...item }); continue; }
      const merged = incomingLater ? { ...item } : { ...known };
      merged.courseId = course(known.courseId, item.courseId, incomingLater);
      map.set(item.lessonId, merged);
    }
    return map;
  };
  const completed = union(base?.completed ?? [], incoming?.completed ?? []), credited = union(base?.credited ?? [], incoming?.credited ?? []);
  let droppedBecauseCompleted = 0;
  for (const lessonId of [...credited.keys()]) if (completed.has(lessonId)) { credited.delete(lessonId); droppedBecauseCompleted++; }
  if (completed.size > LIMITS.completed || credited.size > LIMITS.credited)
    throw new CrabrixError("LIMIT_EXCEEDED", `Nothing was merged: together the two states list more than ${LIMITS.completed} completed or credited lessons.`);
  const count = (map: Map<string, unknown>, before: { lessonId: string }[] = []) => {
    const known = new Set(before.map(item => item.lessonId)), kept = [...map.keys()].filter(id => known.has(id)).length;
    return { kept, added: map.size - kept, total: map.size };
  };
  return {
    value: { source: later.source, capturedAt: later.capturedAt, appVersion: later.appVersion,
      completed: [...completed.values()].sort(byLesson), credited: [...credited.values()].sort(byLesson) } as OfficialProgress,
    report: { captureFrom: incomingLater ? "incoming" as const : "base" as const, completed: count(completed, base?.completed),
      credited: { ...count(credited, base?.credited), droppedBecauseCompleted } },
  };
}

function mergeEvidence(base: EvidenceItem[], incoming: EvidenceItem[]) {
  const map = new Map(base.map(item => [evidenceKey(item), item]));
  for (const item of incoming) {
    const key = evidenceKey(item), known = map.get(key);
    map.set(key, known ? laterEvidence(known, item) : item);
  }
  // Newest first for the cap, so the oldest are the ones dropped; then chronological.
  const all = [...map.values()].sort((x, y) => byTime(y, x)), items = all.slice(0, LIMITS.evidence).sort(byTime);
  const baseItems = new Set(base), baseKeys = new Set(base.map(evidenceKey));
  const kept = items.filter(item => baseItems.has(item)).length, updated = items.filter(item => !baseItems.has(item) && baseKeys.has(evidenceKey(item))).length;
  return { items, report: { kept, added: items.length - kept - updated, updated, total: items.length, droppedOldest: all.length - items.length } };
}

// ---- Summary -------------------------------------------------------------------

export type LearningStateSummary = {
  updatedAt: string; producer: string | null; learningPath: string | null; teachingMode: TeachingMode | null;
  currentLesson: LessonRef | null; suggestedNextLesson: LessonRef | null;
  learner: AILearningState["learner"]; conceptsNeedingReview: string[]; lastSummary: string;
  officialProgress: null | { source: OfficialProgressSource; capturedAt: string; appVersion: string | null; completed: number; credited: number; note: string };
  evidence: { total: number; lessons: number; byKind: Record<EvidenceKind, number>; latestAt: string | null; note: string };
  text: string;
};

export const OFFICIAL_COPY_NOTE = "The learner's own copy of progress from the Crabrix app or a backup file. It was not read from Crabrix and is not verified by this tool.";

/** A short description of a (validated) state for the agent; it adds nothing. */
export function summarizeLearningState(input: unknown): LearningStateSummary {
  const { state } = readLearningState(input);
  const byKind = Object.fromEntries(KINDS.map(kind => [kind, state.evidence.filter(item => item.kind === kind).length])) as Record<EvidenceKind, number>;
  const progress = state.officialProgress;
  const lessonText = (lesson: LessonRef | null) => lesson ? `${lesson.courseId}/${lesson.lessonId}` : "none";
  const lines = [
    `AI Learning State updated ${state.updatedAt}${state.producer ? ` by ${state.producer}` : ""}.`,
    `Path: ${state.learningPath ?? "none"}; mode: ${state.teachingMode ?? "not set"}; current lesson: ${lessonText(state.currentLesson)}; suggested next: ${lessonText(state.aiSession.suggestedNextLesson)}.`,
    progress
      ? `Official progress copy (${progress.source}, captured ${progress.capturedAt}${progress.appVersion ? `, app ${progress.appVersion}` : ""}): ${progress.completed.length} completed, ${progress.credited.length} credited by bridge lessons. ${OFFICIAL_COPY_NOTE}`
      : "No official progress copy: completion is unknown until the learner confirms it or exports it from the Crabrix app.",
    `Evidence (reported, never official): ${state.evidence.length} item${state.evidence.length === 1 ? "" : "s"}${state.evidence.length ? ` — ${KINDS.filter(kind => byKind[kind as EvidenceKind]).map(kind => `${byKind[kind as EvidenceKind]} ${kind}`).join(", ")}` : ""}.`,
    ...(state.aiSession.conceptsNeedingReview.length ? [`Concepts to review: ${state.aiSession.conceptsNeedingReview.join(", ")}.`] : []),
    ...(state.learner.background || state.learner.knownTechnologies.length || state.learner.goal
      ? [`Learner: background ${state.learner.background ?? "not set"}${state.learner.knownTechnologies.length ? `; knows ${state.learner.knownTechnologies.join(", ")}` : ""}${state.learner.goal ? `; goal: ${state.learner.goal}` : ""}.`] : []),
  ];
  return {
    updatedAt: state.updatedAt, producer: state.producer ?? null, learningPath: state.learningPath, teachingMode: state.teachingMode ?? null,
    currentLesson: state.currentLesson, suggestedNextLesson: state.aiSession.suggestedNextLesson,
    learner: state.learner, conceptsNeedingReview: state.aiSession.conceptsNeedingReview, lastSummary: state.aiSession.lastSummary,
    officialProgress: progress ? { source: progress.source, capturedAt: progress.capturedAt, appVersion: progress.appVersion,
      completed: progress.completed.length, credited: progress.credited.length, note: OFFICIAL_COPY_NOTE } : null,
    evidence: { total: state.evidence.length, lessons: new Set(state.evidence.map(item => item.lessonId)).size, byKind,
      latestAt: state.evidence.at(-1)?.at ?? null, note: "Reported by the learner or an agent. Evidence never counts as completion." },
    text: lines.join("\n"),
  };
}

/** Lesson ids the state's official progress copy counts as done: completed and credited. */
export function learningStateDoneLessons(state: AILearningState): string[] {
  return state.officialProgress ? [...state.officialProgress.completed, ...state.officialProgress.credited].map(item => item.lessonId) : [];
}
