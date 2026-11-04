# Changelog

## 0.5.0 — 2026-11-04

- Agent links: `https://crabrix.com/mcp/<room>/<agent access>/<key>`. A person in the
  room gets one from Connect AI agent in Crabrix or the website, with the same access
  and expiry as their own link. Agent links cannot produce other links.
- `crabrix_connect` and `connect()` accept an agent link and join the room directly; the
  key stays on this computer. A person link still works.
- Local agent links, `https://crabrix.com/mcp/<room>/<agent access>#key=<key>`, as the Crabrix
  app gives them: no HTTP client sends the key, so only Crabrix MCP on the agent's computer can
  use one. The remote MCP refuses them, and a bridge joined through one hands off that form.
- `crabrix_handoff` and `share()` return `agentLink` next to the person `link`. Joined
  through an agent link, they hand off only that link.
- `crabrix serve-http` runs the remote MCP server behind agent links, one bound session
  per agent: it joins the link's room and offers every tool except connect, create,
  disconnect and end room. It holds the key in memory while the session lasts.

## 0.4.0 — 2026-11-03

- Read and edit Playground rooms in format 2, where every file has a stable ID and a
  rename, move or delete never drops an edit made at the same time. Deleted files keep
  their text as recovery rows until purged; collisions read as `conflict-…` names and a
  project that cannot run reports `blocked` reasons instead of failing to load.
- Add `crabrix_plan_changes` (read-only, up to 32 operations: returns the plan, its
  revision and `planHash`) and `crabrix_apply_operations` (needs that revision, the
  `planHash` and an `operationId`; one update or nothing; a retried ID reports
  `alreadyApplied`). Both answer `UNSUPPORTED_ROOM_FORMAT` in a format 1 room.
- In a format 2 room, `crabrix_status`, `crabrix_snapshot` and `crabrix_read_file` add
  file IDs, conflicts, recovery rows and `blocked`, `crabrix_read_file` reads by `id`, and
  `crabrix_apply_changes` maps paths to writes, creates and deletes. Revisions there have
  32 hex characters. Format 1 results keep their shape.
- `crabrix_create` still creates format 1 rooms; `format: 2` is for testing until new
  rooms move to it. Every relay request declares the formats this SDK reads. A room of a
  newer format answers `CLIENT_UPDATE_REQUIRED` at once instead of `JOIN_TIMEOUT`.
- New codes: `CLIENT_UPDATE_REQUIRED`, `UNSUPPORTED_ROOM_FORMAT`, `PLAN_CHANGED`,
  `OPERATION_ID_CONFLICT`, `RECOVERY_FULL` and `PROJECT_BLOCKED`. A refused plan keeps
  its own reason in `error.details.planError`.
- The shared core is ported from the website at `e04e9ff`. `docs/protocol-core.json`
  records each site file's SHA-256 beside the SDK file's.
- The library adds `planChanges()`, `applyOperations()`, `readById()` and
  `snapshot({ includeRecoveryText })`; Rust and Go add `plan_changes`/`PlanChanges` and
  `apply_operations`/`ApplyOperations`.

## 0.3.5 — 2026-11-02

- Conditional edits also check the relay's state generation when it declares one,
  so a snapshot that replaced the source refuses a commit prepared before it. A
  routine snapshot of the same content retries at most three times; older relays
  keep the sequence check. Full-room recovery carries the new generation.
- Refused calls add a stable `error.code`, `retryable`, `action` and `requestId`
  beside the existing text and `isError`. Join failures report their actual cause.
  Library calls throw `CrabrixError`; Rust and Go expose the code.
- Add `crabrix doctor [--json]`: version, Node, DNS, TLS, relay and proxy checks.
  It opens no room, reads no source and changes no setting.
- Add `crabrix_runtime_inspect` (read-only) and `crabrix_runtime_control`.
  `crabrix_runtime_job` stays, with the same checks.
- Connecting again to the current link keeps its slot, creator rights and view
  access. A failed switch leaves the current room connected. A room that was created
  but could not be joined is closed, and the error says exactly what exists.
- A commit whose reply was lost reports `OUTCOME_UNKNOWN`; the next read settles it
  and `status` reports `lastOperation`. A switch waits for that read.
- Add `edition` (`2021`, `2024`) to create and apply, in all three languages.
  `changes` may be empty when only `entryFile`, `name` or `edition` changes.
- An apply that changes nothing reports `changed: false` even after earlier deletions.
- Generate `.mcp.json`, plugin version, `server.json` and `docs/release-manifest.json`
  from `package.json`. README gives one recommended install per client.

## 0.3.4 — 1 November 2026

- Publish a snapshot when the relay answers 409, even with pending edits. The
  relay now refuses updates once a room holds 1.9 MB (or 12 MiB per creating
  address) as well as at 256 events, and only a snapshot drains a full room.
  A forced snapshot is validated first; a new state clears the overdue flag.
- `apply` and `crabrix_apply_changes` drain a full room and commit once. A stale
  revision is still refused: only a sequence that did not move can be a full room.
- A failed runtime edit confirmation in a full room schedules the same drain.
- Accept a joined room's state up to 4.5 MB, wider than the relay's 2,000,000
  character message, so a room created under different limits stays readable.
- Update bundled zod to 4.6.7 for GHSA-mrhx-c7xc-m3w5.
- Package the SDK as a Claude Code plugin: `.mcp.json`, marketplace manifest and
  a `crabrix-handoff` skill. npm, Cargo and Go packages are otherwise unchanged.
- Replace the iPhone, browser and observer captures with current interfaces.

## 0.3.3 — 29 October 2026

- Expand the Rust README to match the JavaScript/MCP overview: workflows, typed
  examples, client-local Run/Debug, permissions, expiry, limits and honest test scope.
- Add original Crabrix illustrations, a permissions infographic and documented
  editor captures; display native screenshots at equal heights.
- Use explicit documentation/license links that also work on package registries.
- Keep runtime behavior unchanged; release matching npm, Cargo and Go versions
  so the registries receive the current packaged documentation.

## 0.3.2 — 29 October 2026

- Share one implementation between ESM, CommonJS and the programmatic MCP
  factory. Mixed imports previously loaded Yjs twice and produced distinct
  Crabrix constructors; the new regression checks identity, instanceof and
  an empty stderr channel in a fresh process.
- Unify declaration identity for strict mixed-mode TypeScript consumers.
- Preserve the standalone CLI and exact Rust/Go embedded-core agreement.
- Extend source manifests to cover public types and the build configuration.

## 0.3.1 — 29 October 2026

- Correct CLI parsing: `--name --help` and `--name --version` are participant
  labels and start the MCP server. Previously they printed help/version and
  broke the stdio handshake. Standalone help/version still work; mixed or extra
  arguments fail on stderr with no protocol-channel text. Rust and Go launchers
  also refuse extra arguments.
- Generate the Rust/Go embedded bridges from the exact npm CLI bytes during
  builds, record their common hash and test version/bundle agreement.
- Clarify neutral MCP participant names and shared browser/app selections.
- Qualify two independent coding agents and two browser clients: shared edits,
  selections, stale-write refusal, 13 local Rust assertions, structured Debug,
  foreign-job refusal, output-only observers and revocation. See
  `docs/qualification-0.3.1.json` for precise scope.

## 0.3.0 — 29 October 2026

Initial standalone JS/TypeScript library, stdio MCP, typed Rust/Go bindings,
encrypted temporary handoff and explicitly permitted browser/app execution.
