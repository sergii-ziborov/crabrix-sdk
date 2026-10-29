// Package crabrix connects Go agents to temporary encrypted Rust Playgrounds.
// It embeds the shared Crabrix protocol core and requires local Node.js 22+.
// No npm installation, phone app, host shell or remote compiler is required.
package crabrix

import (
	"bufio"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

//go:embed runtime/bridge.mjs
var bridge []byte

const maxFrame = 2_000_000

// Options selects a trusted local Node executable and a bounded request timeout.
type Options struct {
	Node    string
	Name    string
	Timeout time.Duration
}
type CreateOptions struct {
	Name            string            `json:"name"`
	Files           map[string]string `json:"files,omitempty"`
	EntryFile       string            `json:"entryFile,omitempty"`
	LifetimeMinutes int               `json:"lifetimeMinutes,omitempty"`
}
type Change struct {
	Path string  `json:"path"`
	Text *string `json:"text"`
}
type ApplyOptions struct {
	ExpectedRevision string   `json:"expectedRevision"`
	Changes          []Change `json:"changes"`
	EntryFile        string   `json:"entryFile,omitempty"`
	Name             string   `json:"name,omitempty"`
}
type SourceFile struct {
	Path     string `json:"path"`
	Text     string `json:"text"`
	Revision string `json:"revision"`
}

// Handoff contains a secret link; fmt formatting deliberately redacts it.
type Handoff struct {
	Schema    string `json:"schema"`
	LinkType  string `json:"linkType"`
	Link      string `json:"link"`
	ExpiresAt string `json:"expiresAt"`
	Revision  string `json:"revision"`
	Mode      string `json:"mode"`
}

func (h Handoff) String() string {
	return fmt.Sprintf("Crabrix Handoff{mode:%s expires:%s link:[REDACTED]}", h.Mode, h.ExpiresAt)
}
func (h Handoff) GoString() string { return h.String() }

type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      uint64          `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   json.RawMessage `json:"error"`
}
type received struct {
	value response
	err   error
}

// Client owns one room and one local subprocess. Close it when finished.
type Client struct {
	mu        sync.Mutex
	cmd       *exec.Cmd
	input     io.WriteCloser
	replies   chan received
	done      chan struct{}
	slots     chan struct{}
	directory string
	timeout   time.Duration
	next      uint64
	closed    bool
	cancel    context.CancelFunc
}

func command(ctx context.Context, node, file string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, node, file)
	for _, e := range os.Environ() {
		if len(e) >= 13 && e[:13] == "NODE_OPTIONS=" {
			continue
		}
		if len(e) >= 10 && e[:10] == "NODE_PATH=" {
			continue
		}
		cmd.Env = append(cmd.Env, e)
	}
	return cmd
}
func prepare() (string, string, error) {
	dir, err := os.MkdirTemp("", "crabrix-sdk-")
	if err != nil {
		return "", "", errors.New("cannot prepare Crabrix runtime")
	}
	file := filepath.Join(dir, "bridge.mjs")
	if err = os.WriteFile(file, bridge, 0600); err != nil {
		os.RemoveAll(dir)
		return "", "", errors.New("cannot prepare Crabrix runtime")
	}
	return dir, file, nil
}

// New starts the exact bundled protocol core. It performs no npm downloads.
func New(ctx context.Context, options Options) (*Client, error) {
	if ctx == nil {
		return nil, errors.New("a context is required")
	}
	if options.Node == "" {
		options.Node = "node"
	}
	if options.Timeout == 0 {
		options.Timeout = 30 * time.Second
	}
	if options.Timeout < time.Millisecond || options.Timeout > 120*time.Second {
		return nil, errors.New("choose a timeout from 1 ms to 120 seconds")
	}
	dir, file, err := prepare()
	if err != nil {
		return nil, err
	}
	life, cancel := context.WithCancel(ctx)
	ready := false
	defer func() {
		if !ready {
			cancel()
		}
	}()
	cmd := command(life, options.Node, file)
	if options.Name == "" {
		options.Name = "Go agent"
	}
	cmd.Args = append(cmd.Args, "--name", options.Name)
	cmd.Stderr = io.Discard
	input, err := cmd.StdinPipe()
	if err != nil {
		os.RemoveAll(dir)
		return nil, errors.New("cannot open Crabrix input")
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		os.RemoveAll(dir)
		return nil, errors.New("cannot open Crabrix output")
	}
	if err = cmd.Start(); err != nil {
		input.Close()
		os.RemoveAll(dir)
		return nil, errors.New("cannot start Crabrix: install Node.js 22+ or set Options.Node")
	}
	c := &Client{cmd: cmd, input: input, replies: make(chan received, 16), done: make(chan struct{}), slots: make(chan struct{}, 32), directory: dir, timeout: options.Timeout, next: 1, cancel: cancel}
	go c.read(output)
	if _, err = c.rpc(ctx, "initialize", map[string]any{"protocolVersion": "2025-11-25", "capabilities": map[string]any{}, "clientInfo": map[string]string{"name": "crabrix-go-sdk", "version": "0.3.0"}}); err != nil {
		c.closeLocked()
		return nil, err
	}
	if err = c.send(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized", "params": map[string]any{}}); err != nil {
		c.closeLocked()
		return nil, err
	}
	ready = true
	return c, nil
}
func (c *Client) read(output io.Reader) {
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 65536), maxFrame)
	for scanner.Scan() {
		var r response
		err := json.Unmarshal(scanner.Bytes(), &r)
		if err != nil {
			err = errors.New("invalid Crabrix protocol frame")
		}
		select {
		case c.replies <- received{r, err}:
		case <-c.done:
			return
		}
		if err != nil {
			return
		}
	}
	select {
	case c.replies <- received{err: errors.New("Crabrix transport ended or frame exceeded its limit")}:
	case <-c.done:
	}
}
func (c *Client) send(v any) error {
	if c.closed {
		return errors.New("Crabrix client is closed")
	}
	data, err := json.Marshal(v)
	if err != nil {
		return errors.New("invalid Crabrix request")
	}
	if len(data) > maxFrame {
		return errors.New("Crabrix request exceeds its limit")
	}
	_, err = c.input.Write(append(data, '\n'))
	if err != nil {
		return errors.New("Crabrix local transport failed")
	}
	return nil
}
func (c *Client) rpc(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if c.closed {
		return nil, errors.New("Crabrix client is closed")
	}
	id := c.next
	c.next++
	if err := c.send(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		return nil, err
	}
	timer := time.NewTimer(c.timeout)
	defer timer.Stop()
	for n := 0; n < 64; n++ {
		select {
		case <-ctx.Done():
			c.closeLocked()
			return nil, errors.New("Crabrix request cancelled; reconcile its outcome before retrying")
		case <-timer.C:
			c.closeLocked()
			return nil, errors.New("Crabrix request timed out; reconcile its outcome before retrying")
		case r := <-c.replies:
			if r.err != nil {
				c.closeLocked()
				return nil, r.err
			}
			if r.value.ID != id {
				continue
			}
			if r.value.JSONRPC != "2.0" {
				return nil, errors.New("invalid Crabrix protocol version")
			}
			if len(r.value.Error) > 0 {
				return nil, errors.New("Crabrix rejected the protocol request")
			}
			if len(r.value.Result) == 0 {
				return nil, errors.New("missing Crabrix result")
			}
			return r.value.Result, nil
		}
	}
	c.closeLocked()
	return nil, errors.New("too many Crabrix protocol notifications")
}

var tools = map[string]bool{"crabrix_create": true, "crabrix_connect": true, "crabrix_status": true, "crabrix_snapshot": true, "crabrix_read_file": true, "crabrix_apply_changes": true, "crabrix_select": true, "crabrix_handoff": true, "crabrix_disconnect": true, "crabrix_end_room": true, "crabrix_runtime_clients": true, "crabrix_runtime_request": true, "crabrix_runtime_start": true, "crabrix_runtime_job": true}

// Call invokes one allowlisted room tool. Source and output remain untrusted data.
func (c *Client) Call(ctx context.Context, name string, args any) (json.RawMessage, error) {
	if ctx == nil {
		return nil, errors.New("a context is required")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !tools[name] {
		return nil, errors.New("unknown Crabrix room tool")
	}
	select {
	case c.slots <- struct{}{}:
		defer func() { <-c.slots }()
	default:
		return nil, errors.New("too many queued Crabrix operations")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	data, err := c.rpc(ctx, "tools/call", map[string]any{"name": name, "arguments": args})
	if err != nil {
		return nil, err
	}
	var result struct {
		IsError    bool            `json:"isError"`
		Structured json.RawMessage `json:"structuredContent"`
		Content    []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if err = json.Unmarshal(data, &result); err != nil {
		return nil, errors.New("invalid Crabrix tool response")
	}
	if result.IsError {
		message := "Crabrix operation failed"
		if len(result.Content) > 0 {
			message = result.Content[0].Text
		}
		if len(message) > 400 {
			message = message[:400]
		}
		return nil, errors.New(message)
	}
	if len(result.Structured) > 0 {
		return result.Structured, nil
	}
	if len(result.Content) == 0 || !json.Valid([]byte(result.Content[0].Text)) {
		return nil, errors.New("missing Crabrix structured result")
	}
	return []byte(result.Content[0].Text), nil
}
func (c *Client) Create(ctx context.Context, options CreateOptions) (json.RawMessage, error) {
	return c.Call(ctx, "crabrix_create", options)
}
func (c *Client) Connect(ctx context.Context, link string) (json.RawMessage, error) {
	return c.Call(ctx, "crabrix_connect", map[string]string{"link": link})
}
func (c *Client) Status(ctx context.Context) (json.RawMessage, error) {
	return c.Call(ctx, "crabrix_status", map[string]any{})
}
func (c *Client) Snapshot(ctx context.Context) (json.RawMessage, error) {
	return c.Call(ctx, "crabrix_snapshot", map[string]any{})
}
func (c *Client) Read(ctx context.Context, path string) (SourceFile, error) {
	data, err := c.Call(ctx, "crabrix_read_file", map[string]string{"path": path})
	var result SourceFile
	if err == nil {
		err = json.Unmarshal(data, &result)
	}
	return result, err
}
func (c *Client) Apply(ctx context.Context, options ApplyOptions) (json.RawMessage, error) {
	return c.Call(ctx, "crabrix_apply_changes", options)
}
func (c *Client) Select(ctx context.Context, path string, anchor, head int, revision string) (json.RawMessage, error) {
	return c.Call(ctx, "crabrix_select", map[string]any{"path": path, "anchor": anchor, "head": head, "expectedRevision": revision})
}
func (c *Client) Share(ctx context.Context, mode string) (Handoff, error) {
	data, err := c.Call(ctx, "crabrix_handoff", map[string]string{"mode": mode})
	var h Handoff
	if err == nil {
		err = json.Unmarshal(data, &h)
	}
	return h, err
}
func (c *Client) RuntimeClients(ctx context.Context) (json.RawMessage, error) {
	return c.Call(ctx, "crabrix_runtime_clients", map[string]any{})
}
func (c *Client) RequestRuntime(ctx context.Context, target string, operations []string) (json.RawMessage, error) {
	return c.Call(ctx, "crabrix_runtime_request", map[string]any{"target": target, "operations": operations})
}
func (c *Client) Start(ctx context.Context, target, operation, revision string) (json.RawMessage, error) {
	return c.Call(ctx, "crabrix_runtime_start", map[string]any{"target": target, "operation": operation, "sourceRevision": revision})
}
func (c *Client) Job(ctx context.Context, target, revision, job, operation string, options map[string]any) (json.RawMessage, error) {
	args := map[string]any{}
	for k, v := range options {
		args[k] = v
	}
	args["target"] = target
	args["sourceRevision"] = revision
	args["job"] = job
	args["operation"] = operation
	return c.Call(ctx, "crabrix_runtime_job", args)
}
func (c *Client) EndRoom(ctx context.Context) (json.RawMessage, error) {
	return c.Call(ctx, "crabrix_end_room", map[string]any{})
}
func (c *Client) Disconnect(ctx context.Context) (json.RawMessage, error) {
	return c.Call(ctx, "crabrix_disconnect", map[string]any{})
}
func (c *Client) closeLocked() {
	if c.closed {
		return
	}
	c.closed = true
	if c.cancel != nil {
		c.cancel()
	}
	close(c.done)
	c.input.Close()
	if c.cmd.Process != nil {
		c.cmd.Process.Kill()
	}
	c.cmd.Wait()
	os.RemoveAll(c.directory)
}
func (c *Client) Close() error {
	if c.cancel != nil {
		c.cancel()
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closeLocked()
	return nil
}

// ServeStdio launches the bundled MCP server with inherited standard IO.
func ServeStdio(ctx context.Context) error {
	dir, file, err := prepare()
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	cmd := command(ctx, "node", file)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
