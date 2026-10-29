<img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/crabrix.png" alt="Crabrix crab" width="80">

# Crabrix for Go 🦀

Typed Go SDK and MCP launcher for temporary encrypted Rust Playgrounds.
Requires **Node.js 22+**. The same bundled protocol core is embedded; no npm
installation is needed. A browser or another agent can join without a phone app.

```sh
go get github.com/sergii-ziborov/crabrix-sdk/go/crabrix@v0.3.3
go install github.com/sergii-ziborov/crabrix-sdk/go/crabrix/cmd/crabrix@v0.3.3
```

```go
ctx := context.Background()
client, err := crabrix.New(ctx, crabrix.Options{})
if err != nil { return err }
defer client.Close()
room, err := client.Create(ctx, crabrix.CreateOptions{Name: "Go agent exercise"})
if err != nil { return err }
_ = room
handoff, err := client.Share(ctx, "edit") // secret: intended recipient only
if err != nil { return err }
_ = handoff
```

Rooms default to one hour and expire within 24 hours. Four participants, 16 text
files/128 KiB total. No repository history, account project or package storage.
Run/Debug need explicit permission on one browser/app; code never runs on the
relay. Go context cancellation closes its owned bridge rather than silently
retrying a possibly committed edit. Exact revisions reject stale proposals.

## Development, interviews and teaching

Create a focused example, hand its edit or view link to an intended participant,
and review the same source in a browser. Compare exact revisions before applying
changes; named UTF-16 selections help explain the relevant statement. Local
execution needs a separate grant on the chosen browser/app.

[Practical two-agent walkthrough](https://crabrix.com/blog/crabrix-mcp-two-agents-local-rust-workflows/)

<img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/local-execution-boundaries.webp" alt="Crabrix permission diagram: an edit link shares source, a human approves one client, and Run or Debug executes locally while results can be shared" width="760">

*Conceptual permission diagram. Browser icons are illustrative; they do not
certify every browser. A room link alone never grants execution permission.*

## See it on your phone or tablet

<p><img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/mcp-iphone-selection.png" alt="Native Crabrix iPhone editor with a shared agent selection" width="166" height="360"> <img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/mcp-ipad-local-debug.png" alt="Native Crabrix iPad inspecting a locally paused Rust program" width="270" height="360"></p>

*Actual application captures from earlier native qualification, displayed at the
same height. The two-agent test below used two browser clients on one Mac.*

<img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/playground-shared-browser.png" alt="Crabrix browser Playground with live shared source and selection" width="760">

These are actual Crabrix application/browser captures. The SDK also works with
other agents and the web editor when nobody has installed the phone app.


SDK code: MIT; separate artwork/screenshot terms in [ASSETS-LICENSE.md](https://github.com/sergii-ziborov/crabrix-sdk/blob/main/ASSETS-LICENSE.md).
[Full docs](https://github.com/sergii-ziborov/crabrix-sdk).
