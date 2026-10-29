# Changelog

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
