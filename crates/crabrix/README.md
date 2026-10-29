<img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/crabrix.png" alt="Crabrix crab" width="80">

# Crabrix for Rust 🦀

Typed Rust SDK and MCP launcher for temporary encrypted Crabrix Playgrounds.
**Node.js 22+ is required.** The crate embeds the same audited JavaScript protocol
core as npm `crabrix`; it does not install npm packages or reimplement encryption.
The Rust library owns a bounded stdio client; the binary runs that MCP core.
No phone application is required: a browser or another agent can join the room.

```sh
# Registry release pending; from a checked-out SDK repository:
cargo install --path crates/crabrix
```

```rust,no_run
use crabrix::{Client, CreateOptions};
let mut client = Client::new()?;
let room = client.create(&CreateOptions::new("Rust agent exercise"))?;
let file = client.read("main.rs")?;
let handoff = client.share("edit")?; // secret: send only to intended recipient
# Ok::<(), crabrix::Error>(())
```

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
