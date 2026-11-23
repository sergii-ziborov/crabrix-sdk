# Testing Crabrix SDKs

Node.js 22+, a Rust toolchain and Go 1.23+ are required for the full matrix.

```sh
npm ci --ignore-scripts
npm run check
npm run build
npm test
cargo test --manifest-path crates/crabrix/Cargo.toml --locked
cargo clippy --manifest-path crates/crabrix/Cargo.toml --locked --all-targets -- -D warnings
(cd go/crabrix && go test -race ./... && go vet ./...)
```

CI runs the local checks on Linux, macOS and Windows. Source changes do not
publish new registry versions automatically; qualify a real change and use an
immutable release version. A published Go submodule needs its own prefixed tag.

`package.json` is the one version source: `npm run build` regenerates `.mcp.json`,
the plugin version, `server.json`, `go/crabrix/version.go`, `docs/protocol-core.json`
and `docs/release-manifest.json`, and fails if `src/version.ts` or Cargo disagree.
`docs/release-manifest.json` states what this source would release; registry
availability still needs its own publication receipt.

The shared core in `src/core` is ported from the website. `src/core/provenance.json`
names the site commit and each site file's SHA-256; the build refuses a core file
without an entry and writes both hashes to `docs/protocol-core.json`. The codec and
relay tests from the site (`test/codec-v2.test.ts`, `test/relay-codec.test.ts`) run
unchanged apart from import paths. `test/support/rooms.ts` is the site's relay class and
`test/support/relay.ts` serves it over loopback HTTP the way the site's routes do, so
`test/room-v2.test.ts` exercises format 2 rooms, the 426 refusal of clients that do not
declare format 2, and the format 1 regression without a network.

The Claude Code plugin manifests must stay valid:
`claude plugin validate . --strict`. The plugin starts the published npm version
named in `.mcp.json`, so publish npm before announcing a plugin version.

Optional production integration probes create short-lived rooms and end them.
Install Playwright separately for these development probes (it is not an SDK
runtime dependency), or set `CRABRIX_PLAYWRIGHT_MODULE` to a trusted installed
Playwright module. Prepare its Chromium runtime through the normal vendor tools.
Build the Rust reviewer with `cargo build --manifest-path crates/crabrix/Cargo.toml
--example reviewer` and the Go reviewer from `go/crabrix/examples/reviewer` into
`build/go-reviewer`. Run `node test/cross-language-probe.mjs` to exercise actual
JS/Rust/Go clients plus the browser. The reviewer accepts its secret link on
stdin, never argv, and remains connected until the harness releases it.

The browser runtime probe requires compilation of its TypeScript development
entry first. It explicitly prepares the browser compiler and grants selected
operations on that client. It checks Build without main execution, real stdout,
String/Vec/structure Debug locals, Step and owned Stop. The relay is ciphertext
transport, not a compiler. Production probes are deliberately excluded from
ordinary unit-test/CI runs; they consume temporary room and network resources.

Retain only sanitized results and masked screenshots. Never commit a capability
URL, plaintext user project, auth configuration or token. A participant name and
a reported output card are not attestations. These checks do not establish
physical-device timings, arbitrary Cargo compatibility or a live model-provider
conversation.

## Crabrix Academy tools

`test/academy.test.ts` serves `test/fixtures/academy-v1.json` (a subset of the public
Academy API v1) from a local HTTP server with ETag/304 support and checks every
`crabrix_academy_*` tool, the stdio `crabrix academy` server, the remote `/mcp/academy`
route, and that the default and agent-link tool lists are unchanged. Regenerate the fixture
from the website corpus with
`node test/support/make-academy-fixture.mjs <site/content/courses.json> <crabrix-courses>`.

`test/learning-state.test.ts` covers the AI Learning State v1 (every field rule, secret
patterns, the newer-version refusal, each merge rule, and idempotence over 200 seeded random
pairs), the `.crabrixprogress` reader, the learning-state and backup tools through an
in-memory MCP client, `via=ai` links, the remote `/mcp/academy` never offering the backup
tool, and the `--no-academy` / `CRABRIX_ACADEMY_MCP=off` kill switch (in process and through
the built CLI) with an agent link still working. `test/fixtures/synthetic-v1.crabrixprogress`
and `synthetic-v2.crabrixprogress` (schema version 2) hold synthetic data only and are made
with the app's codec (Compression `COMPRESSION_ZLIB`, CryptoKit SHA-256) by
`swift test/fixtures/make-progress-backup.swift test/fixtures`.
