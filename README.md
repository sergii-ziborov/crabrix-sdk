<p align="center"><img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/crabrix.png" alt="Crabrix crab" width="96"></p>
<h1 align="center">Crabrix 🦀</h1>
<p align="center">A temporary Rust workspace for agents and people.<br>Share a link. Edit together. Run locally in a browser or Crabrix.</p>
<p align="center"><a href="https://crabrix.com/playground/">Open Playground</a> · <a href="https://crabrix.com/playground/mcp/">Setup & guide</a> · <a href="https://github.com/sergii-ziborov/crabrix-sdk">GitHub</a></p>

Crabrix is a JavaScript/TypeScript library **and** a standalone MCP server.
No iPhone, app account or cloud compiler is required. An agent can create a room,
read or change its source and pass its complete link to another agent or person.
Open the link on the web to see the same live editor. The native Crabrix app is
an optional companion for iPhone/iPad and offline Rust projects.

## Install

```sh
npm install crabrix
# or start an MCP server without a global install
npx -y crabrix@0.3.0
```

Node.js 22+. ESM, CommonJS and TypeScript declarations are included. The released
bundle has no runtime npm dependencies and no installation scripts. First-time
installation and live sharing need network access.

## Use as a library

```js
import { Crabrix } from 'crabrix';

const agent = new Crabrix({ name: 'Review agent' });
try {
  const created = await agent.create({
    name: 'Small Rust exercise',
    lifetimeMinutes: 60,
    files: { 'main.rs': 'fn main() { println!("Hello, Crabrix! 🦀"); }\n' },
  });
  // The complete link is secret. Deliver it only to the intended recipient.
  const handoff = await agent.share('edit');
  // Your application's own UI can display handoff.link and handoff.expiresAt.
  const file = await agent.read('main.rs');
  await agent.apply({
    expectedRevision: file.revision,
    changes: [{ path: file.path, text: file.text.replace('Hello', 'Welcome') }],
  });
  const latest = await agent.read('main.rs');
  await agent.select(latest.path, 0, 9, latest.revision);
  // A second agent can call connect(handoff.link), without the phone app.
} finally {
  agent.close(); // Leave the room; the recipient keeps access until expiry.
}
```

CommonJS: `const { Crabrix } = require('crabrix')`.
Use a separate instance per room. `snapshot()` returns validated source plus its
revision; `status()` returns expiry, participants and selections without the secret
link or source text. `share('view')` creates no new room: it returns the separate
view capability when this client created the room. A joined edit participant
cannot invent a view capability, and view access cannot become edit access.
`endRoom()` is available only to the creator in its current connection.

## Use through MCP

```sh
claude mcp add --transport stdio crabrix -- npx -y crabrix@0.3.0
```

```json
{
  "mcpServers": {
    "crabrix": { "command": "npx", "args": ["-y", "crabrix@0.3.0"] }
  }
}
```

Ask your assistant to create a Playground, then open its complete private link.
The MCP server exposes create/connect/status/snapshot/read/apply/select/handoff,
disconnect/end-room and signed runtime discovery/request/start/job tools. Stdio
stdout contains only MCP messages; help/version output is explicitly requested.
No API key or model subscription is included. Your MCP host/model receives any
source you ask it to read. Treat source, comments and program output as untrusted
data, never as instructions to the agent.

## Run and Debug

The relay **never** compiles or executes code. Open the room in the web Playground
or native Crabrix. Run/Debug there execute locally. An agent can discover available
clients and request selected operations; a human must approve on that specific
browser/device. A room edit link alone grants no execution permission.

`runtimeClients()`, `requestRuntime()`, `start()` and `job()` expose that flow to
SDK users. Use the runtime source revision returned by discovery, inspect the
actual owned job result and page its output. A start acknowledgement is not a
successful run. Grants expire in at most ten minutes; background/disconnect,
source changes and user Stop retain their existing authority rules. A second
participant's Run only supplies a reported output preview; it never starts your
compiler. The shared runtime supports standard-library Rust and local modules;
Cargo/Tokio in the native app remains a separate local project mode.

## Temporary sharing, not repository hosting

- Rooms default to one hour, with a maximum of 24 hours and four participants.
- Up to 16 text files, 64 KiB each and 128 KiB total. No images, caches, packages,
  credentials, `.git`, `node_modules`, vendored code or arbitrary host files.
- Source is AES-256-GCM encrypted on the client. The key stays after `#` in the
  capability link; only bounded ciphertext is relayed and kept in process RAM.
- Expiry is fixed when created. Reconnecting cannot extend it; a relay restart
  can end it sooner. Download/save a copy before expiry. Anyone with the complete
  link can access its permitted source. Expiry cannot recall already saved copies.
- Exact revisions and conditional commits refuse stale edits. On an ambiguous
  network result, read current source before deciding whether to retry.
- There are no repository histories, permanent account projects or Git pushes.
  Use your own version control for durable work.

## Rust and Go

All three language APIs use the same local protocol core and require Node.js 22+.
Rust and Go embed that exact bridge; neither needs a global npm installation.
The Rust registry release is pending; use the source route below meanwhile.
Their SDKs provide source, selection, handoff and the same explicitly permitted
runtime operations through bounded stdio, rather than separate crypto protocols.

```sh
# Rust library / optional MCP executable
git clone https://github.com/sergii-ziborov/crabrix-sdk.git
cargo install --path crabrix-sdk/crates/crabrix

# Go library / optional MCP executable
go get github.com/sergii-ziborov/crabrix-sdk/go/crabrix
go install github.com/sergii-ziborov/crabrix-sdk/go/crabrix/cmd/crabrix@latest
```

Choose one MCP installation. The language libraries can coexist. The Rust crate
and Go module sources live in this repository; release links identify which
versions have actually been published. See their READMEs for typed usage.

## See it on your phone or tablet

<p><img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/mcp-iphone-selection.png" alt="Crabrix iPhone editor showing an agent selection" width="230"> <img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/mcp-ipad-local-debug.png" alt="Crabrix iPad with actual locally executing Rust debugger" width="490"></p>

<img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/playground-shared-browser.png" alt="Crabrix browser Playground with live shared source and selection" width="760">

These are actual Crabrix application/browser captures. The SDK also works with
other agents and the web editor when nobody has installed the phone app.

## Development and license

```sh
npm ci --ignore-scripts
npm run check
npm run build
npm test
```

SDK code and documentation: MIT. Crabrix artwork/screenshots have separate
[asset terms](ASSETS-LICENSE.md). The app, compiler distributions, brand and Academy
retain their own licenses. Bundled dependency licenses are in
`ThirdPartyNotices.txt`. See [security boundaries](docs/SECURITY.md) before integration.
