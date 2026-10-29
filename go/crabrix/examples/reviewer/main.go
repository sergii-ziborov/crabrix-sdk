// An authorized edit link arrives on stdin; it is never logged or passed in argv.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"github.com/sergii-ziborov/crabrix-sdk/go/crabrix"
	"os"
)

func main() {
	if err := review(); err != nil {
		os.Stderr.WriteString("Crabrix Go reviewer failed; no private link was logged.\n")
		os.Exit(1)
	}
}
func review() error {
	lines := bufio.NewScanner(os.Stdin)
	if !lines.Scan() {
		return lines.Err()
	}
	ctx := context.Background()
	client, err := crabrix.New(ctx, crabrix.Options{})
	if err != nil {
		return err
	}
	defer client.Close()
	if _, err = client.Connect(ctx, lines.Text()); err != nil {
		return err
	}
	file, err := client.Read(ctx, "main.rs")
	if err != nil {
		return err
	}
	text := file.Text + "// reviewed by Go\n"
	if _, err = client.Apply(ctx, crabrix.ApplyOptions{ExpectedRevision: file.Revision, Changes: []crabrix.Change{{Path: file.Path, Text: &text}}}); err != nil {
		return err
	}
	file, err = client.Read(ctx, "main.rs")
	if err != nil {
		return err
	}
	if _, err = client.Select(ctx, file.Path, 10, 14, file.Revision); err != nil {
		return err
	}
	json.NewEncoder(os.Stdout).Encode(map[string]any{"ready": true, "revision": file.Revision})
	lines.Scan()
	_, err = client.Disconnect(ctx)
	return err
}
