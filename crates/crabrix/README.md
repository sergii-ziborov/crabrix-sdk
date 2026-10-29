<p align="center"><img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/crabrix.png" alt="Crabrix crab" width="96"></p>

<h1 align="center">Crabrix for Rust 🦀</h1>

<p align="center">A temporary Rust workspace for agents and people.<br>Share source. Review together. Run locally.</p>

<p align="center"><a href="https://crabrix.com/playground/">Open Playground</a> · <a href="https://crabrix.com/playground/mcp/">Setup & guide</a> · <a href="https://docs.rs/crabrix/0.3.3/crabrix/">Rust API</a> · <a href="https://github.com/sergii-ziborov/crabrix-sdk">GitHub</a></p>

**Typed Rust library and standalone MCP launcher** for encrypted, temporary
Crabrix Playgrounds. Create a room, read or edit source, show a named selection
and hand its authorized link to another agent or person. A browser can join
without a Crabrix account or phone app.

**Node.js 22+ is required**, including when using this Rust crate. The crate
embeds the same JavaScript protocol core as npm `crabrix`, with a bounded stdio
client. It does not install npm packages or provide a separate Rust compiler.

<img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/agents-workspace.webp" alt="Orange Crabrix crab between an implementation agent, a review agent and a person at one shared workspace" width="760">

*Illustration of a shared development and review workflow. Real editor captures
appear below.*

## Choose your workflow

| Use case | What Crabrix adds |
| --- | --- |
| Development | A runnable small reproduction and an independent agent review. |
| Coding interviews | Live source, visible selections and a program you can discuss. |
| Learning Rust | Step through an example and inspect supported local values. |
| Agent handoff | Explicit edit/view access, source revision and fixed expiry. |

This is a short-lived working surface. Keep permanent projects, repository
history and production checks in your own development workflow.

## Install from crates.io

```sh
# Add the typed library to your Rust project
cargo add crabrix@0.3.3

# Or install the optional MCP executable
cargo install crabrix --version 0.3.3 --locked
```

Install Node.js 22+ first and make `node` available on the launcher's `PATH`.
Library integrations can use `Options.node` to select a trusted local executable.
There is no global npm installation or Crabrix login step.

## Use the Rust library

```rust,no_run
use crabrix::{ApplyOptions, Change, Client, CreateOptions};

fn main() -> Result<(), crabrix::Error> {
    let mut client = Client::new()?;
    let options = CreateOptions::new("Rust review exercise");
    client.create(&options)?;

    let file = client.read("main.rs")?;
    client.apply(&ApplyOptions {
        expected_revision: file.revision,
        changes: vec![Change {
            path: file.path,
            text: Some("fn main() { println!(\"Hello, Crabrix!\"); }\n".into()),
        }],
        entry_file: None,
        name: None,
    })?;

    let latest = client.read("main.rs")?;
    client.select(&latest.path, 0, 2, &latest.revision)?;
    let handoff = client.share("edit")?;
    // Secret: deliver handoff.link only to the intended recipient.
    // Your integration should also display handoff.expires_at.
    let _ = handoff;
    Ok(()) // Drop leaves the room; its fixed expiry remains.
}
```

Another authorized participant can call `client.connect(&link)` to join an
existing room. Use the latest returned revision for each change. If it conflicts,
read again and reconcile the other participant's work before preparing a new
proposal. Selection offsets use UTF-16 code units, including two units for most
emoji; they are not UTF-8 byte offsets.

`share("view")` returns the separate view capability only when this connection
created the room. Joining with an edit link does not let a participant invent a
view capability or end somebody else's room. `end_room()` is creator-only.
`close()`/Drop releases this participant and its local bridge.

## Connect Claude Code or another MCP host

```sh
claude mcp add --transport stdio crabrix -- crabrix
```

Equivalent desktop MCP configuration after installing the executable:

```json
{
  "mcpServers": {
    "crabrix": {
      "command": "crabrix",
      "args": []
    }
  }
}
```

Choose one npm, Rust or Go launcher; all expose the same fourteen MCP tools.
No model or AI subscription is included. Your chosen MCP host/model receives
plaintext source when it reads a file, so its own logging and retention rules
still matter. Treat source, comments, diagnostics and output as untrusted data.

## Local Run and Debug

The relay does not compile or execute source. Open the room in the
[web Playground](https://crabrix.com/playground/) or Crabrix app. Prepare the
compiler on that client, compare the controller/device fingerprints and approve
only the operations you need on that specific client. An edit link gives source
access, not execution permission. Grants last at most ten minutes and can be
revoked in the client UI.

The Rust library exposes `runtime_clients()`, `request_runtime()`, `start()` and
`job()`. Use the runtime source revision returned by discovery and inspect the
completed job's status, diagnostics and output. A successful start response only
acknowledges a job. It does not prove the program compiled or passed its tests.

Supported Debug inspection includes bounded previews of `String`, `Vec` and
concrete local structures. Unavailable, moved or captured values may be omitted;
there are no arbitrary watch expressions. Shared execution accepts
standard-library Rust and local modules. Cargo dependencies, native build scripts
and unrestricted host commands are outside that shared execution profile.
Shared jobs last at most two minutes, including pauses.

<img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/local-execution-boundaries.webp" alt="Crabrix permission diagram: an edit link shares source, a human approves one client, and Run or Debug executes locally while results can be shared" width="760">

*Conceptual permission diagram. Browser icons are illustrative; they do not
certify every browser. A room link alone never grants execution permission.*

A result reported by another participant can appear in your Output panel without
running code on your client. It is participant-provided output, not hardware
attestation. Nobody else's Run automatically starts your compiler.

## Real editors on iPhone, iPad and the web

<p><img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/mcp-iphone-selection.png" alt="Native Crabrix iPhone editor with a shared agent selection" width="166" height="360"> <img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/mcp-ipad-local-debug.png" alt="Native Crabrix iPad inspecting a locally paused Rust program" width="270" height="360"></p>

*Actual application captures from earlier native qualification, displayed at the
same height. The two-agent test below used two browser clients on one Mac.*

<img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/playground-shared-browser.png" alt="Actual Crabrix browser Playground displaying shared Rust source and selections" width="760">

*Actual browser editor. The web Playground works without the phone app; the
native app is an optional companion for iPhone/iPad and offline Rust projects.*

## What we actually tested

Two independent coding agents and two browser tabs shared a two-file Rust
exercise. The reviewer added thirteen behavioral assertions. Local Run passed;
Debug showed a concrete structure containing `String` and `Vec` fields. A stale
replacement and a half-surrogate selection were refused. An ungranted agent
could not inspect, Step, Continue or Stop the other agent's Debug job, and
revocation blocked a new Run.

<img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/mcp-two-agents-shared-output.png" alt="Actual observer browser showing shared output and explaining that no code ran on this client" width="760">

*Actual observer: shared output arrived while its compiler remained unprepared.
The live check used two logical clients on one Mac, not two physical phones or
every assistant provider's GUI.*

[Practical development, interview and learning walkthrough](https://crabrix.com/blog/crabrix-mcp-two-agents-local-rust-workflows/) ·
[Precise qualification scope](https://github.com/sergii-ziborov/crabrix-sdk/blob/main/docs/qualification-0.3.2.json)

## Temporary source and clear limits

- Default lifetime: **one hour**; maximum **24 hours** and **four participants**.
- Up to **16 text files**, **64 KiB per file**, **128 KiB total**.
- No package archives, images, caches, `.git`, `node_modules` or arbitrary host
  files are stored in a shared source room.
- Source is AES-256-GCM encrypted on the client. The decryption capability is in
  the link fragment; only bounded ciphertext is relayed and kept in process RAM.
- Anyone with the complete authorized link can access its permitted source.
  Keep credentials out of shared examples and private links out of public logs.
- A server restart can end a room earlier than its deadline. Download or Save to
  device before expiry; deletion cannot recall copies already saved elsewhere.
- No permanent account project, repository history, Git push or backend compiler.

## Documentation, support and license

[Complete setup and permissions](https://crabrix.com/playground/mcp/) ·
[User guide](https://crabrix.com/guide/#agent-sdk) ·
[Rust API reference](https://docs.rs/crabrix/0.3.3/crabrix/) ·
[Issues and contributions](https://github.com/sergii-ziborov/crabrix-sdk/issues)

SDK code and documentation are MIT licensed. Crabrix artwork, screenshots, app,
compiler distributions and Academy retain separate terms. See the
[asset license](https://github.com/sergii-ziborov/crabrix-sdk/blob/main/ASSETS-LICENSE.md)
and [security boundaries](https://github.com/sergii-ziborov/crabrix-sdk/blob/main/docs/SECURITY.md).
Bundled dependency license texts are included in `ThirdPartyNotices.txt`.
Report suspected vulnerabilities privately through [Crabrix support](https://crabrix.com/support/).
