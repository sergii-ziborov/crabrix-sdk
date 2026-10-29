package main

import (
	"context"
	"fmt"
	"github.com/sergii-ziborov/crabrix-sdk/go/crabrix"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	if len(os.Args) == 2 {
		switch os.Args[1] {
		case "--help":
			fmt.Printf("🦀 Crabrix %s · Go SDK + MCP launcher\nNode.js 22+ required; no npm installation.\nhttps://crabrix.com/playground/mcp/\n", crabrix.Version)
			return
		case "--version":
			fmt.Println(crabrix.Version)
			return
		default:
			fmt.Fprintln(os.Stderr, "Use --help or start without arguments.")
			os.Exit(2)
		}
	}
	if len(os.Args) > 1 {
		fmt.Fprintln(os.Stderr, "Use --help or start without arguments.")
		os.Exit(2)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := crabrix.ServeStdio(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "Crabrix MCP stopped. Check Node.js 22+ and the client configuration.")
		os.Exit(1)
	}
}
