#!/usr/bin/env node
// Builds test/fixtures/academy-v1.json: a faithful subset of the public Academy API v1
// (index, lessons, paths, examples, teaching contract) generated from the website corpus.
// Usage: node test/support/make-academy-fixture.mjs [site/content/courses.json] [crabrix-courses root]
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const coursesPath = process.argv[2] ?? "/Users/serhiirihgt/dev/crabrix-poc/site/content/courses.json";
const coursesRoot = process.argv[3] ?? "/Users/serhiirihgt/dev/crabrix-courses";
const ORIGIN = "https://crabrix.com";
const snapshot = JSON.parse(await readFile(coursesPath, "utf8"));
const catalogVersion = snapshot.sourceCommit.slice(0, 12);
const url = (course, lesson) => `${ORIGIN}/learn/${course}/${lesson ? lesson + (/\.[^/]+$/.test(lesson) ? "" : "/") : ""}`;
const short = text => { const plain = (text ?? "").replace(/\s+/g, " ").trim(); return plain.length <= 300 ? plain : plain.slice(0, 299) + "…"; };

// Atlas is large; keep its first two method units so search can be tested against it.
const keepUnit = (course, unitIndex) => course.id !== "algorithms" || unitIndex < 2;
const playgroundOf = lesson => Boolean(lesson.playgroundProject);
// Website first until Crabrix 1.1.9 ships: the bridge courses and Basics' "What Rust Is".
const appAvailabilityOf = (courseId, lessonId) => courseId.startsWith("rust-for-") || (courseId === "basics" && lessonId === "what-is-rust") ? "next-app-version" : "released";

const courses = [], lessons = [], byKey = new Map();
for (const course of snapshot.courses) {
  const units = course.units.filter((_, index) => keepUnit(course, index));
  courses.push({ id: course.id, title: course.title, subtitle: course.subtitle, level: course.level, order: course.order, url: url(course.id),
    lessonCount: units.reduce((sum, unit) => sum + unit.lessons.length, 0),
    units: units.map(unit => ({ id: unit.id, title: unit.title, subtitle: unit.subtitle, lessonIds: unit.lessons.map(lesson => lesson.id) })) });
  for (const unit of units) for (const lesson of unit.lessons) {
    byKey.set(`${course.id}/${lesson.id}`, { course, unit, lesson });
    lessons.push({ courseId: course.id, unitId: unit.id, id: lesson.id, title: lesson.title, concept: lesson.concept,
      summary: short(lesson.writing?.summary || lesson.concept), rule: lesson.writing?.rule ?? "", minutes: lesson.minutes,
      exerciseKind: lesson.exerciseKind, url: url(course.id, lesson.id), playground: playgroundOf(lesson),
      bridgeFrom: lesson.bridge?.from ?? null, credits: lesson.bridge?.credits ?? [], appAvailability: appAvailabilityOf(course.id, lesson.id) });
  }
}

const relatedOf = (course, lesson) => {
  const related = [];
  const ordered = course.units.flatMap(unit => unit.lessons), index = ordered.findIndex(item => item.id === lesson.id);
  if (index > 0) related.push({ courseId: course.id, lessonId: ordered[index - 1].id, title: ordered[index - 1].title, relation: "previous" });
  if (index + 1 < ordered.length) related.push({ courseId: course.id, lessonId: ordered[index + 1].id, title: ordered[index + 1].title, relation: "next" });
  for (const target of lesson.bridge?.credits ?? []) { const ref = byKey.get(target); if (ref) related.push({ courseId: ref.course.id, lessonId: ref.lesson.id, title: ref.lesson.title, relation: "covers" }); }
  for (const [key, ref] of byKey) if ((ref.lesson.bridge?.credits ?? []).includes(`${course.id}/${lesson.id}`)) related.push({ courseId: ref.course.id, lessonId: ref.lesson.id, title: ref.lesson.title, relation: "coveredBy" });
  return related;
};
const fullLesson = key => {
  const { course, unit, lesson } = byKey.get(key) ?? (() => { throw new Error(`fixture lesson missing: ${key}`); })();
  const { playgroundProject, illustration, writing, depth, algorithm, bridge } = lesson;
  return { schemaVersion: 1, catalogVersion, courseId: course.id, courseTitle: course.title, unitId: unit.id, unitTitle: unit.title, id: lesson.id, title: lesson.title,
    concept: lesson.concept, minutes: lesson.minutes, exerciseKind: lesson.exerciseKind, url: url(course.id, lesson.id),
    writing: writing ?? {}, depth: depth ?? {}, algorithm: algorithm ?? null, bridge: bridge ?? null,
    illustration: illustration ? { url: `${ORIGIN}/learn-media/${course.id}/${illustration.path.slice(6)}`, alt: illustration.alt, caption: illustration.caption } : null,
    playground: playgroundProject ? { available: true, url: `${ORIGIN}/playground/?lesson=${course.id}/${lesson.id}` } : { available: false, url: null },
    related: relatedOf(course, lesson), appAvailability: appAvailabilityOf(course.id, lesson.id) };
};

const firstChallenge = lessons.find(lesson => lesson.courseId === "algorithms" && lesson.id.endsWith(".challenge"));
const fixtureLessons = ["basics/what-is-rust", "basics/option-result", "ownership/ownership", "concurrency/futures",
  "rust-for-nodejs-developers/node-promises-to-futures", "rust-for-c-developers/c-malloc-free-to-ownership",
  "projects/route-cli-arguments", `algorithms/${firstChallenge.id}`];

const step = (courseId, lessonId, note) => { const ref = byKey.get(`${courseId}/${lessonId}`); if (!ref) throw new Error(`path step missing: ${courseId}/${lessonId}`); return { courseId, lessonId, title: ref.lesson.title, url: url(courseId, lessonId), ...(note ? { note } : {}) }; };
const courseSteps = id => snapshot.courses.find(course => course.id === id).units.flatMap(unit => unit.lessons.map(lesson => step(id, lesson.id)));
const paths = {
  "rust-from-zero": { title: "Rust from Zero", audience: "New to Rust", description: "Rust Basics in order, then ownership.", steps: [...courseSteps("basics"), step("ownership", "ownership"), step("ownership", "borrowing")] },
  "rust-for-nodejs": { title: "Rust for Node.js Developers", audience: "JavaScript, TypeScript and Node.js developers", description: "The Node.js bridge, then the Academy lessons it does not cover.",
    steps: [...courseSteps("rust-for-nodejs-developers"), step("ownership", "lifetimes-intro", "Not covered by the bridge"), step("concurrency", "async-runtime", "Runtimes after futures")] },
};
const pathSummaries = Object.entries(paths).map(([id, value]) => ({ id, title: value.title, audience: value.audience, description: value.description, stepCount: value.steps.length }));

const examples = [];
const exampleFiles = {};
for (const id of ["ascii-histogram", "budget-planner"]) {
  const root = path.join(coursesRoot, "courses/examples/library-projects", id), meta = JSON.parse(await readFile(path.join(root, "project.json"), "utf8"));
  const files = { "Cargo.toml": await readFile(path.join(root, "Cargo.toml"), "utf8") };
  for (const name of await readdir(path.join(root, "src"))) files[`src/${name}`] = await readFile(path.join(root, "src", name), "utf8");
  examples.push({ id, title: meta.title, detail: meta.detail, difficulty: meta.difficulty, category: meta.category, concepts: meta.concepts });
  exampleFiles[`examples/${id}.json`] = { schemaVersion: 1, catalogVersion, id, title: meta.title, detail: meta.detail, difficulty: meta.difficulty, category: meta.category,
    concepts: meta.concepts, readme: await readFile(path.join(root, "README.md"), "utf8"), files, entryFile: meta.project.entryFile,
    illustration: meta.illustration ? { url: `${ORIGIN}/learn-media/examples/${id}.png`, alt: meta.illustration.alt, caption: meta.illustration.caption } : null };
}

const fixture = {
  "index.json": { schemaVersion: 1, catalogVersion, source: { repository: snapshot.source, commit: snapshot.sourceCommit },
    platforms: { web: "Every lesson listed here is public at its url.", app: "The Crabrix iOS app installs signed CoursePacks; a lesson can reach the app later than the website." },
    courses, lessons, paths: pathSummaries, examples, teachingContract: { version: "1.0.0", url: `${ORIGIN}/api/academy/v1/teaching-contract.md` } },
  ...Object.fromEntries(fixtureLessons.map(key => [`lessons/${key}.json`, fullLesson(key)])),
  ...Object.fromEntries(Object.entries(paths).map(([id, value]) => [`paths/${id}.json`, { schemaVersion: 1, catalogVersion, id, ...value }])),
  ...exampleFiles,
  "teaching-contract.md": "# Crabrix Academy teaching contract 1.0.0 (test fixture)\n\nTeach from official lessons. Never mark progress.\n",
};
await mkdir(path.join(here, "../fixtures"), { recursive: true });
await writeFile(path.join(here, "../fixtures/academy-v1.json"), JSON.stringify(fixture) + "\n");
console.log(`academy-v1.json: ${courses.length} courses, ${lessons.length} lessons, ${fixtureLessons.length} full lessons, catalog ${catalogVersion}, Atlas challenge ${firstChallenge.id}`);
