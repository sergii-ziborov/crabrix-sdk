<img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/crabrix.png" alt="Crabrix crab" width="80">

# Crabrix for Rust 🦀

Typed Rust SDK and MCP launcher for temporary encrypted Crabrix Playgrounds.
**Node.js 22+ is required.** The crate embeds the same tested JavaScript protocol
core as npm `crabrix`; it does not install npm packages or reimplement encryption.
The Rust library owns a bounded stdio client; the binary runs that MCP core.
No phone application is required: a browser or another agent can join the room.

## Install from crates.io

```sh
# Add the library to a Rust project
cargo add crabrix@0.3.1
# Or install the optional MCP executable
cargo install crabrix --version 0.3.1 --locked
```

Install Node.js 22+ first. The executable and library run the embedded bridge
locally; no global npm installation, Crabrix account or phone app is needed.

## Use the Rust library

```rust,no_run
use crabrix::{Client, CreateOptions};
fn main() -> Result<(), crabrix::Error> {
    let mut client = Client::new()?;
    let _room = client.create(&CreateOptions::new("Rust agent exercise"))?;
    let file = client.read("main.rs")?;
    assert!(!file.revision.is_empty());
    let _handoff = client.share("edit")?;
    // Secret: deliver handoff.link only to an intended recipient.
    // Drop closes this participant; the shared room keeps its fixed expiry.
    Ok(())
}
```

## Connect an MCP client

```sh
claude mcp add --transport stdio crabrix -- crabrix
```

Or configure a desktop MCP client with `"command": "crabrix"` and `"args": []`.
Use one of the npm, Rust or Go launchers; they expose the same fourteen tools.
Another agent can join the full link using `Client::connect`; `snapshot`, `read`,
`apply`, `select` and `share` expose typed source and handoff operations. Use the
revision returned by the latest read for conditional edits. The link contains
a decryption capability: never print it into public logs or commit it to Git.

[Open the web Playground](https://crabrix.com/playground/) ·
[Setup, security boundaries and agent guide](https://crabrix.com/playground/mcp/) ·
[Detailed Crabrix user guide](https://crabrix.com/guide/#agent-sdk)

## Local execution and temporary rooms

Run/Debug require explicit permission on one connected browser or app. The relay
never executes source. The shared runtime is std/local modules, not arbitrary
Cargo projects or a host shell. Rooms expire in one hour by default, 24 hours
maximum; 16 text files/128 KiB, four participants. This is not Git hosting.

## See it on your phone or tablet

<p><img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/mcp-iphone-selection.png" alt="Crabrix iPhone editor showing an agent selection" width="230"> <img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/mcp-ipad-local-debug.png" alt="Crabrix iPad with actual locally executing Rust debugger" width="490"></p>

<img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/playground-shared-browser.png" alt="Crabrix browser Playground with live shared source and selection" width="760">

These are actual Crabrix application/browser captures. The SDK also works with
other agents and the web editor when nobody has installed the phone app.


SDK code: MIT. Brand/screenshot terms are in ASSETS-LICENSE.md.
[Full documentation](https://github.com/sergii-ziborov/crabrix-sdk).
