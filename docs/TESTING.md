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
