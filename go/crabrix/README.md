<img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/crabrix.png" alt="Crabrix crab" width="80">

# Crabrix for Go 🦀

Typed Go SDK and MCP launcher for temporary encrypted Rust Playgrounds.
Requires **Node.js 22+**. The same bundled protocol core is embedded; no npm
installation is needed. A browser or another agent can join without a phone app.

```sh
go get github.com/sergii-ziborov/crabrix-sdk/go/crabrix
go install github.com/sergii-ziborov/crabrix-sdk/go/crabrix/cmd/crabrix@latest
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

## See it on your phone or tablet

<p><img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/mcp-iphone-selection.png" alt="Crabrix iPhone editor showing an agent selection" width="230"> <img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/mcp-ipad-local-debug.png" alt="Crabrix iPad with actual locally executing Rust debugger" width="490"></p>

<img src="https://raw.githubusercontent.com/sergii-ziborov/crabrix-sdk/main/assets/playground-shared-browser.png" alt="Crabrix browser Playground with live shared source and selection" width="760">

These are actual Crabrix application/browser captures. The SDK also works with
other agents and the web editor when nobody has installed the phone app.


SDK code: MIT; separate artwork/screenshot terms in ASSETS-LICENSE.md.
[Full docs](https://github.com/sergii-ziborov/crabrix-sdk).
