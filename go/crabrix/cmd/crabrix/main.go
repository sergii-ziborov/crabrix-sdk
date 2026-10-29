package main

import (
	"context"
	"fmt"
	"github.com/sergii-ziborov/crabrix-sdk/go/crabrix"
	"os"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "--help":
			fmt.Println("🦀 Crabrix 0.3.0 · Go SDK + MCP launcher\nNode.js 22+ required; no npm installation.\nhttps://crabrix.com/playground/mcp/")
			return
		case "--version":
			fmt.Println("0.3.0")
			return
		default:
			fmt.Fprintln(os.Stderr, "Use --help or start without arguments.")
			os.Exit(2)
		}
	}
	if err := crabrix.ServeStdio(context.Background()); err != nil {
		fmt.Fprintln(os.Stderr, "Crabrix MCP stopped. Check Node.js 22+ and the client configuration.")
		os.Exit(1)
	}
}
