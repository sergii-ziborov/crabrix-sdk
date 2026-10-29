#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { makeServer } from "./server.js";
import { PlaygroundRoom } from "./room.js";
import { SDK_VERSION } from "./version.js";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  const color = process.stdout.isTTY ? { crab: "\x1b[38;2;255;95;65m", cyan: "\x1b[38;2;77;216;235m", off: "\x1b[0m" } : { crab: "", cyan: "", off: "" };
  process.stdout.write(`${color.crab}🦀 Crabrix SDK + MCP${color.off} · ${SDK_VERSION}\n${color.cyan}Agents and people. One temporary Rust Playground.${color.off}\n\nRun without arguments as an MCP stdio server.\nSetup: https://crabrix.com/playground/mcp/\nNode.js 22 or newer. No account. One-hour rooms by default.\nLive edits and selections. Use a browser or app for signed local Run/Debug after permission. No iPhone is required.
Library: import { Crabrix } from "crabrix";\n`);
} else if (args.length === 1 && args[0] === "--version") {
  process.stdout.write(SDK_VERSION + "\n");
} else if (args.length > 0 && !(args.length === 2 && args[0] === "--name")) {
  process.stderr.write("Crabrix MCP: use --help or start without arguments.\n"); process.exitCode = 1;
} else {
  let room: PlaygroundRoom;
  try { room = new PlaygroundRoom(undefined, args[1]); } catch { process.stderr.write("Crabrix: use a printable participant name up to 40 characters.\n"); process.exit(2); }
  const handle = serveStdio(() => makeServer(room), { onerror: () => { process.stderr.write("Crabrix MCP protocol error. No source or private link was logged.\n"); } });
  let closing = false;
  const close = async () => { if (closing) return; closing = true; room.dispose(); await handle.close(); };
  process.stdin.once("end", () => { void close(); });
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
}
