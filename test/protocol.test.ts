import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { spawnSync } from "node:child_process";

test("CLI version agrees with the package and language bindings embed identical bridge bytes", async () => {
  const packageInfo = JSON.parse(await readFile("package.json", "utf8"));
  const version = spawnSync(process.execPath, ["dist/cli.mjs", "--version"], { encoding: "utf8", timeout: 5000 });
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), packageInfo.version);
  const bridge = await readFile("dist/cli.mjs");
  for (const file of ["crates/crabrix/runtime/bridge.mjs", "go/crabrix/runtime/bridge.mjs"]) assert.deepEqual(await readFile(file), bridge, file);
});

test("participant names that look like options still start a real MCP server", async () => {
  for (const name of ["--help", "--version", "Review agent 🦀"]) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve("dist/cli.mjs"), "--name", name], stderr: "pipe" });
    const client = new Client({ name: "named-participant-regression", version: "1" });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "crabrix_status", arguments: {} });
      assert.equal((result.structuredContent as any).connected, false);
    } finally { await client.close(); await transport.close(); }
  }
});

test("invalid mixed CLI flags fail without writing text into the MCP stdout channel", () => {
  for (const args of [["--name"], ["--version", "extra"], ["--name", "Alice", "--help"], ["--help", "--version"]]) {
    const result = spawnSync(process.execPath, [path.resolve("dist/cli.mjs"), ...args], { encoding: "utf8", timeout: 5000 });
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Crabrix MCP/);
  }
});

test("official MCP client discovers and invokes the isolated bundled stdio executable", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "crabrix-mcp-stdio-"));
  const binary = path.join(directory, "bridge.mjs");
  await copyFile(path.resolve("dist/cli.mjs"), binary);
  const transport = new StdioClientTransport({ command: process.execPath, args: [binary], cwd: directory, stderr: "pipe", env: { PATH: process.env.PATH ?? "" } });
  const client = new Client({ name: "crabrix-mcp-qualification", version: "1.0.0" });
  let errors = "";
  transport.stderr?.on("data", bytes => { errors += bytes; });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(t => t.name).sort(), ["crabrix_snapshot", "crabrix_handoff", "crabrix_connect", "crabrix_create", "crabrix_status", "crabrix_read_file", "crabrix_apply_changes", "crabrix_select", "crabrix_disconnect", "crabrix_end_room", "crabrix_runtime_clients", "crabrix_runtime_request", "crabrix_runtime_start", "crabrix_runtime_job"].sort());
    assert.equal(tools.tools.find(t => t.name === "crabrix_read_file")?.annotations?.readOnlyHint, true);
    const status = await client.callTool({ name: "crabrix_status", arguments: {} });
    assert.equal((status.structuredContent as any).connected, false);
    const invalid = await client.callTool({ name: "crabrix_connect", arguments: { link: "https://example.com/secret-that-must-not-leak" } });
    assert.equal(invalid.isError, true);
    assert.ok(!JSON.stringify(invalid).includes("secret-that-must-not-leak"));
    const resource = await client.readResource({ uri: "crabrix://playground/status" });
    assert.equal(JSON.parse((resource.contents[0] as any).text).connected, false);
    const prompts = await client.listPrompts(); assert.equal(prompts.prompts[0].name, "work_in_crabrix");
    const prompt = await client.getPrompt({ name: "work_in_crabrix", arguments: { task: "Add a small Rust example" } });
    assert.equal(prompt.messages[0].role, "user");
    assert.equal(errors, "");
  } finally { await client.close(); await transport.close(); await rm(directory, { recursive: true, force: true }); }
});
