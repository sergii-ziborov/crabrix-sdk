// Read-only reader for a .crabrixprogress learning backup made by the Crabrix iOS app
// (Crabrix/Progress/LearningProgressBackup.swift, LearningBackupCodec):
//
//   "CRABRIX-PROGRESS/1\n" | UInt32 big-endian decoded size | SHA-256 of the decoded JSON | DEFLATE
//
// Apple Compression's COMPRESSION_ZLIB is raw DEFLATE (RFC 1951, no zlib header). The JSON is a
// LearningProgressSnapshot written by JSONEncoder with its default date strategy: seconds since
// 2001-01-01T00:00:00Z. Only completedLessonIDs and creditedLessonIDs are read; answers, mastery,
// flashcards and progressData are ignored. Nothing is written, stored or sent anywhere.
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { constants, lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { CrabrixError } from "./errors.js";
import { type AILearningState, type CreditedLesson, type ProgressLesson, LEARNING_STATE_FORMAT, isLearningStateTime, readLearningState } from "./learning-state.js";

export const PROGRESS_BACKUP_EXTENSION = ".crabrixprogress";
export const PROGRESS_BACKUP_MAX_ENCODED_BYTES = 5 * 1024 * 1024;
export const PROGRESS_BACKUP_MAX_DECODED_BYTES = 4 * 1024 * 1024;
const MAGIC = Buffer.from("CRABRIX-PROGRESS/1\n", "utf8");
const HEADER = MAGIC.length + 4 + 32;
/** Foundation's reference date, 2001-01-01T00:00:00Z, in Unix seconds. */
const REFERENCE_DATE = 978_307_200;
/** The app accepts createdAt between 1970 and 2200 (7 258 118 400 Unix seconds). */
const LATEST_APP_DATE = 7_258_118_400;
const MAX_LESSONS = 10_000;
const STATE_ID = /^[a-z0-9][a-z0-9.-]{0,159}$/;

export type ProgressBackup = {
  schemaVersion: 1;
  /** The snapshot's createdAt as an ISO time (millisecond precision). */
  createdAt: string;
  completedLessonIds: string[];
  /** Target lesson → the bridge lesson that credits it. */
  creditedLessonIds: Record<string, string>;
};

const invalid = (detail: string) => new CrabrixError("INVALID_ARGUMENT", `This is not a valid Crabrix learning backup: ${detail}. Nothing was read from it.`);
const tooLarge = (detail: string) => new CrabrixError("LIMIT_EXCEEDED", `This learning backup exceeds the supported size: ${detail}.`);

/** Decodes and checks a .crabrixprogress file's bytes exactly as the app does before restoring. */
export function decodeProgressBackup(bytes: Uint8Array): ProgressBackup {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length > PROGRESS_BACKUP_MAX_ENCODED_BYTES) throw tooLarge("a backup file is at most 5 MiB");
  if (data.length <= HEADER || !data.subarray(0, MAGIC.length).equals(MAGIC)) throw invalid("it does not start with the Crabrix progress backup header");
  const size = data.readUInt32BE(MAGIC.length);
  if (size === 0) throw invalid("it declares no content");
  if (size > PROGRESS_BACKUP_MAX_DECODED_BYTES) throw tooLarge("its content would be larger than 4 MiB");
  let json: Buffer;
  try { json = inflateRawSync(data.subarray(HEADER), { maxOutputLength: size }); } catch { throw invalid("its compressed content is damaged or larger than it declares"); }
  if (json.length !== size) throw invalid("its content is not the size it declares");
  if (!createHash("sha256").update(json).digest().equals(data.subarray(MAGIC.length + 4, HEADER))) throw invalid("its checksum does not match its content (the file is damaged or was changed)");
  checkJSONBudget(json);
  let snapshot: unknown;
  try { snapshot = JSON.parse(json.toString("utf8")); } catch { throw invalid("its content is not JSON"); }
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) throw invalid("its content is not a progress snapshot");
  const value = snapshot as Record<string, unknown>;
  if (typeof value.schemaVersion === "number" && Number.isInteger(value.schemaVersion) && value.schemaVersion > 1)
    throw new CrabrixError("CLIENT_UPDATE_REQUIRED", `This backup has snapshot schema version ${value.schemaVersion} and needs a newer Crabrix. Update Crabrix (npm crabrix) to read it; nothing was read from it.`);
  if (value.schemaVersion !== 1) throw invalid("its snapshot schemaVersion is not 1");
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) throw invalid("it has no creation date");
  const unix = REFERENCE_DATE + value.createdAt;
  if (unix < 0 || unix > LATEST_APP_DATE) throw invalid("its creation date is out of range");
  const completed = value.completedLessonIDs;
  if (!Array.isArray(completed) || completed.length > MAX_LESSONS || !completed.every(appID)) throw invalid("its completed lessons are not a list of lesson ids");
  const credited = value.creditedLessonIDs ?? {};
  if (typeof credited !== "object" || credited === null || Array.isArray(credited)) throw invalid("its credited lessons are not a map of lesson ids");
  const credits = Object.entries(credited as Record<string, unknown>);
  if (credits.length > MAX_LESSONS || !credits.every(([target, via]) => appID(target) && appID(via))) throw invalid("its credited lessons are not a map of lesson ids");
  return { schemaVersion: 1, createdAt: new Date(Math.round(unix * 1000)).toISOString(), completedLessonIds: [...new Set(completed as string[])],
    creditedLessonIds: Object.fromEntries(credits) as Record<string, string> };
}

/** The app's own id rule (LearningProgressSnapshot.validID). */
function appID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 256 && !value.includes("\0");
}

/** LearningBackupCodec.checkJSONBudget: bounded nesting and token count before parsing. */
function checkJSONBudget(bytes: Buffer) {
  let depth = 0, tokens = 0, quoted = false, escaped = false;
  for (const byte of bytes) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (byte === 92) escaped = true;
      else if (byte === 34) quoted = false;
    } else if (byte === 34) quoted = true;
    else if (byte === 123 || byte === 91) { depth++; tokens++; if (depth > 32) throw invalid("its content nests too deeply"); }
    else if (byte === 125 || byte === 93) { depth--; if (depth < 0) throw invalid("its content is not balanced JSON"); }
    else if (byte === 44 || byte === 58) tokens++;
    if (tokens > 200_000) throw tooLarge("its content has too many entries");
  }
  if (depth !== 0 || quoted) throw invalid("its content is not balanced JSON");
}

export type ProgressBackupImport = {
  backupCreatedAt: string;
  completed: number; credited: number;
  /** Credits for lessons the backup also lists as completed; completion wins. */
  creditsAlreadyCompleted: number;
  /** Ids the app accepts but an AI Learning State cannot hold (not [a-z0-9][a-z0-9.-]*, ≤ 160). */
  skippedIds: number;
  courseIds: { resolved: number; unresolved: number; academyIndex: "used" | "unavailable" };
};

/**
 * An AI Learning State whose officialProgress is a copy of the backup's completed and credited
 * lessons. `courseOf` names each lesson's course (lesson ids are unique across the Academy), or
 * returns null; pass null when the Academy index could not be read.
 */
export function learningStateFromBackup(backup: ProgressBackup, courseOf: ((lessonId: string) => string | null) | null, producer = "crabrix-sdk, from a .crabrixprogress file"): { state: AILearningState; import: ProgressBackupImport } {
  const capturedAt = backup.createdAt.replace(/\.\d{3}Z$/, "Z");
  if (!isLearningStateTime(capturedAt)) throw invalid("its creation date is not between 2020 and 2100; check the device's clock");
  let skippedIds = 0, creditsAlreadyCompleted = 0, resolved = 0, unresolved = 0;
  const course = (lessonId: string) => { const id = courseOf?.(lessonId) ?? null; if (id && STATE_ID.test(id)) { resolved++; return id; } unresolved++; return null; };
  const completedIds = new Set(backup.completedLessonIds);
  const completed: ProgressLesson[] = [];
  for (const lessonId of [...backup.completedLessonIds].sort()) {
    if (!STATE_ID.test(lessonId)) { skippedIds++; continue; }
    completed.push({ courseId: course(lessonId), lessonId });
  }
  const credited: CreditedLesson[] = [];
  for (const [lessonId, viaLessonId] of Object.entries(backup.creditedLessonIds).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!STATE_ID.test(lessonId) || !STATE_ID.test(viaLessonId)) { skippedIds++; continue; }
    if (completedIds.has(lessonId)) { creditsAlreadyCompleted++; continue; }
    credited.push({ courseId: course(lessonId), lessonId, viaLessonId });
  }
  const { state } = readLearningState({
    format: LEARNING_STATE_FORMAT, schemaVersion: 1, updatedAt: capturedAt, producer: producer.slice(0, 80),
    learningPath: null, currentLesson: null,
    learner: { background: null, knownTechnologies: [], preferredLanguage: null, goal: null },
    aiSession: { lastSummary: "", suggestedNextLesson: null, conceptsNeedingReview: [] },
    officialProgress: { source: "crabrix-backup-file", capturedAt, appVersion: null, completed, credited },
    evidence: [],
  }, "backup");
  return { state, import: { backupCreatedAt: backup.createdAt, completed: completed.length, credited: credited.length, creditsAlreadyCompleted, skippedIds,
    courseIds: { resolved, unresolved, academyIndex: courseOf ? "used" : "unavailable" } } };
}

/**
 * Reads a .crabrixprogress file the learner names: a regular file (not a link, device or
 * pipe), opened read-only, at most 5 MiB. Its bytes stay in this process.
 */
export async function readProgressBackupFile(file: string): Promise<Buffer> {
  if (typeof file !== "string" || !file.trim() || file.includes("\0") || file.length > 4096) throw new CrabrixError("INVALID_ARGUMENT", "Name the .crabrixprogress file to read.");
  const expanded = file === "~" || file.startsWith("~/") ? path.join(homedir(), file.slice(1)) : file;
  const resolved = path.resolve(expanded);
  if (path.extname(resolved).toLowerCase() !== PROGRESS_BACKUP_EXTENSION) throw new CrabrixError("INVALID_ARGUMENT", "Only a .crabrixprogress learning backup file can be read. Export one from the Crabrix app's learning backup settings.");
  const unreadable = (error: unknown) => {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return new CrabrixError("INVALID_ARGUMENT", "There is no file at that path. Check the name and folder of the .crabrixprogress file.");
    if (code === "EACCES" || code === "EPERM") return new CrabrixError("ACCESS_DENIED", "Crabrix cannot read that file (permission denied).");
    if (code === "ELOOP") return new CrabrixError("INVALID_ARGUMENT", "That path is a symbolic link. Name the .crabrixprogress file itself.");
    return new CrabrixError("OPERATION_FAILED", "Crabrix could not read that file.");
  };
  let info;
  try { info = await lstat(resolved); } catch (error) { throw unreadable(error); }
  if (info.isSymbolicLink()) throw new CrabrixError("INVALID_ARGUMENT", "That path is a symbolic link. Name the .crabrixprogress file itself.");
  if (!info.isFile()) throw new CrabrixError("INVALID_ARGUMENT", "That path is not a regular file.");
  if (info.size > PROGRESS_BACKUP_MAX_ENCODED_BYTES) throw tooLarge("a backup file is at most 5 MiB");
  let handle;
  try { handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch (error) { throw unreadable(error); }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new CrabrixError("INVALID_ARGUMENT", "That path is not a regular file.");
    if (opened.size > PROGRESS_BACKUP_MAX_ENCODED_BYTES) throw tooLarge("a backup file is at most 5 MiB");
    // Read one byte past the limit so a file that grew after stat is still refused.
    const buffer = Buffer.alloc(PROGRESS_BACKUP_MAX_ENCODED_BYTES + 1);
    let filled = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
      if (filled > PROGRESS_BACKUP_MAX_ENCODED_BYTES) throw tooLarge("a backup file is at most 5 MiB");
    }
    return buffer.subarray(0, filled);
  } finally { await handle.close().catch(() => {}); }
}
