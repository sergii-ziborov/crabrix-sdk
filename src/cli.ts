#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { makeServer } from "./server.js";
import { PlaygroundRoom } from "./room.js";
import { SDK_VERSION } from "./version.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { serveHTTP } from "./remote-http.js";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  const color = process.stdout.isTTY ? { crab: "\x1b[38;2;255;95;65m", cyan: "\x1b[38;2;77;216;235m", off: "\x1b[0m" } : { crab: "", cyan: "", off: "" };
  process.stdout.write(`${color.crab}🦀 Crabrix SDK + MCP${color.off} · ${SDK_VERSION}\n${color.cyan}Agents and people. One temporary Rust Playground.${color.off}\n\nRun without arguments as an MCP stdio server.\nSetup: https://crabrix.com/ai/\nNode.js 22 or newer. No account. One-hour rooms by default.\nLive edits and selections. Use a browser or app for signed local Run/Debug after permission. No iPhone is required.
Diagnostics: crabrix doctor [--json]. It opens no room, reads no source and changes no setting.
Remote MCP for agent links: crabrix serve-http [--port 8090] [--host 127.0.0.1], behind a TLS proxy.
Library: import { Crabrix } from "crabrix";\n`);
} else if (args.length === 1 && args[0] === "--version") {
  process.stdout.write(SDK_VERSION + "\n");
} else if (args[0] === "doctor" && (args.length === 1 || (args.length === 2 && args[1] === "--json"))) {
  const report = await runDoctor();
  process.stdout.write(args[1] === "--json" ? JSON.stringify(report, null, 2) + "\n" : formatDoctor(report));
  process.exitCode = report.ok ? 0 : 1;
} else if (args[0] === "serve-http") {
  // Remote MCP for agent links, behind a TLS proxy that forwards /mcp/ here.
  const flags = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) flags.set(args[index], args[index + 1] ?? "");
  const unknown = [...flags.keys()].filter(flag => !["--port", "--host", "--relay"].includes(flag));
  if (unknown.length) { process.stderr.write("Crabrix: serve-http takes --port, --host and --relay.\n"); process.exit(2); }
  await serveHTTP({ port: Number(flags.get("--port") ?? 8090), host: flags.get("--host") ?? "127.0.0.1", relay: flags.get("--relay") });
} else if (args.length > 0 && !(args.length === 2 && args[0] === "--name")) {
  process.stderr.write("Crabrix MCP: use --help, doctor or start without arguments.\n"); process.exitCode = 1;
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
