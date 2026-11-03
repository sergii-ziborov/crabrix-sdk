import { lookup } from "node:dns/promises";
import { connect as connectTLS } from "node:tls";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { proxyVariables } from "./errors.js";
import { SDK_VERSION, SERVER_NAME } from "./version.js";
import { CLIENT_CODECS } from "./core/playground-session.js";

export const RELAY_ORIGIN = "https://crabrix.com";
const PROBE_ROOM = "doctor-probe-not-a-room0"; // Valid shape, never created: the relay answers 410.
const PROBE_TOKEN = "d".repeat(43);

export type DoctorCheck = { name: string; status: "ok" | "warning" | "failed" | "skipped"; detail: string };
export type DoctorReport = {
  integrationFamily: "crabrix"; server: { name: string; version: string; transport: "stdio"; source: string };
  node: { version: string; supported: boolean }; checks: DoctorCheck[];
  proxy: { configured: string[]; envProxyEnabled: boolean; envProxySupported: boolean };
  ok: boolean;
};
type Options = { origin?: string; timeoutMs?: number; argv1?: string };

const failure = (error: unknown) => {
  const seen: string[] = []; let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    const value = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof value.code === "string") seen.push(value.code); else if (typeof value.name === "string" && value.name !== "Error" && value.name !== "TypeError") seen.push(value.name);
    current = value.cause;
  }
  return seen[0] ?? "connection failed";
};
const major = (version: string) => version.replace(/^v/, "").split(".").map(Number);
// NODE_USE_ENV_PROXY arrived in Node 24.0 and was backported to 22.21.
export function envProxySupported(version = process.version) { const [a, b] = major(version); return a >= 24 || (a === 22 && b >= 21); }
const masked = (value: string) => { const home = homedir(); return value.startsWith(home) ? "~" + value.slice(home.length) : value; };

function owningPackage(file: string) {
  let directory = path.dirname(file);
  for (let depth = 0; depth < 5; depth++, directory = path.dirname(directory)) {
    try { const name = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")).name; if (typeof name === "string") return name; } catch {}
  }
  return "unknown";
}

/** Read-only: only an explicit doctor call looks at PATH, and it never edits anything. */
export function installedCommands(): DoctorCheck {
  const found = new Map<string, string>();
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const command of ["crabrix-mcp", "crabrix"]) {
      const file = path.join(directory, command);
      if (found.has(file) || !existsSync(file)) continue;
      try { found.set(file, owningPackage(realpathSync(file))); } catch {}
    }
  }
  const legacy = [...found].filter(([, owner]) => owner === "crabrix-playground-mcp");
  if (legacy.length) return { name: "global-cli", status: "warning", detail: `${legacy.map(([file]) => masked(file)).join(", ")} belongs to the historical crabrix-playground-mcp package, which shares the crabrix-mcp command. Use one installation: npm uninstall -g crabrix-playground-mcp.` };
  return { name: "global-cli", status: "ok", detail: found.size ? `Commands on PATH: ${[...found.keys()].map(masked).join(", ")}.` : "No global Crabrix command on PATH; npx or a plugin does not need one." };
}

function certificate(origin: URL, timeoutMs: number): Promise<DoctorCheck> {
  return new Promise(resolve => {
    const socket = connectTLS({ host: origin.hostname, port: Number(origin.port) || 443, servername: origin.hostname, timeout: timeoutMs }, () => {
      const peer = socket.getPeerCertificate();
      const days = peer.valid_to ? Math.floor((Date.parse(peer.valid_to) - Date.now()) / 86_400_000) : NaN;
      resolve(socket.authorized
        ? { name: "tls", status: "ok", detail: `Certificate verified for ${origin.hostname}${Number.isFinite(days) ? `, valid for ${days} more days` : ""}.` }
        : { name: "tls", status: "failed", detail: `Certificate not verified: ${socket.authorizationError}. Check system time and a corporate TLS root; do not disable verification.` });
      socket.destroy();
    });
    socket.once("timeout", () => { socket.destroy(); resolve({ name: "tls", status: "failed", detail: "TLS handshake timed out." }); });
    socket.once("error", error => { resolve({ name: "tls", status: "failed", detail: `TLS connection failed: ${failure(error)}. Do not disable verification.` }); });
  });
}

export async function runDoctor(options: Options = {}): Promise<DoctorReport> {
  const origin = new URL(options.origin ?? RELAY_ORIGIN), timeoutMs = options.timeoutMs ?? 8000, checks: DoctorCheck[] = [];
  const [nodeMajor] = major(process.version), supported = nodeMajor >= 22;
  checks.push({ name: "node", status: supported ? "ok" : "failed", detail: supported ? `Node ${process.version}.` : `Node ${process.version} is too old; Crabrix needs Node 22 or newer.` });
  const missing = ["fetch", "AbortSignal", "TextDecoder"].filter(name => !(name in globalThis)).concat(globalThis.crypto?.subtle ? [] : ["crypto.subtle"]);
  checks.push({ name: "node-api", status: missing.length ? "failed" : "ok", detail: missing.length ? `Missing: ${missing.join(", ")}.` : "fetch and WebCrypto are available." });
  const bundled = typeof __CRABRIX_RELEASE_VERSION__ === "string" ? __CRABRIX_RELEASE_VERSION__ : undefined;
  checks.push(bundled === undefined ? { name: "release", status: "skipped", detail: "Running from source; no release manifest is bundled." }
    : bundled === SDK_VERSION ? { name: "release", status: "ok", detail: `Bundle and release manifest agree on ${SDK_VERSION}.` }
    : { name: "release", status: "failed", detail: `Bundle is ${SDK_VERSION}, but its release manifest says ${bundled}.` });

  const configured = proxyVariables(), envProxyEnabled = process.env.NODE_USE_ENV_PROXY === "1", proxySupport = envProxySupported();
  if (!configured.length) checks.push({ name: "proxy", status: "ok", detail: "No proxy variables are set." });
  else if (envProxyEnabled && proxySupport) checks.push({ name: "proxy", status: "ok", detail: `${configured.join(", ")} set, and Node is told to use them.` });
  else checks.push({ name: "proxy", status: "warning", detail: `${configured.join(", ")} set, but this Node process does not use them for fetch. ${proxySupport ? "If direct connections fail, start the MCP server with NODE_USE_ENV_PROXY=1." : `Node ${process.version} has no NODE_USE_ENV_PROXY; use Node 22.21 or 24 and set it if direct connections fail.`}` });

  if (/^(?:127\.|localhost$|\[?::1)/.test(origin.hostname)) checks.push({ name: "dns", status: "skipped", detail: "Loopback relay." });
  else {
    try { const address = await lookup(origin.hostname); checks.push({ name: "dns", status: "ok", detail: `${origin.hostname} resolves (IPv${address.family}).` }); }
    catch (error) { checks.push({ name: "dns", status: configured.length ? "warning" : "failed", detail: `${origin.hostname} does not resolve here: ${failure(error)}.` }); }
  }
  if (origin.protocol === "https:") checks.push(await certificate(origin, timeoutMs));
  else checks.push({ name: "tls", status: "skipped", detail: "The test relay does not use TLS." });
  // A deliberately unknown room proves the relay's route answers. No room is created or read.
  try {
    const response = await fetch(`${origin.origin}/api/playground/rooms/${PROBE_ROOM}/`, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(timeoutMs), headers: { Authorization: "Bearer " + PROBE_TOKEN, "X-Crabrix-Codecs": CLIENT_CODECS } });
    await response.body?.cancel().catch(() => {});
    const answered = response.status === 410 || response.status === 403;
    checks.push(answered ? { name: "relay", status: "ok", detail: "HTTPS reaches the Playground relay." } : { name: "relay", status: "failed", detail: `The relay answered HTTP ${response.status}.` });
  } catch (error) { checks.push({ name: "relay", status: "failed", detail: `HTTPS could not reach the relay: ${failure(error)}.${configured.length && !envProxyEnabled ? " Proxy variables are set but unused." : ""}` }); }
  checks.push(installedCommands());
  const entry = options.argv1 ?? process.argv[1] ?? "";
  return { integrationFamily: "crabrix", server: { name: SERVER_NAME, version: SDK_VERSION, transport: "stdio", source: entry.includes("_npx") ? "npx" : entry.includes("node_modules") ? "npm package" : "local file" },
    node: { version: process.version, supported }, checks, proxy: { configured, envProxyEnabled, envProxySupported: proxySupport }, ok: checks.every(check => check.status !== "failed") };
}

export function formatDoctor(report: DoctorReport): string {
  const marks = { ok: "ok  ", warning: "warn", failed: "FAIL", skipped: "skip" };
  return [`Crabrix doctor · ${report.server.name} ${report.server.version} · ${report.server.transport} · ${report.server.source}`, ...report.checks.map(check => `${marks[check.status]} ${check.name}: ${check.detail}`),
    report.ok ? "No blocking problem found. This did not open a room or read any source." : "Blocking problems found. This did not open a room or read any source."].join("\n") + "\n";
}
declare const __CRABRIX_RELEASE_VERSION__: string | undefined;
