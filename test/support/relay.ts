// The site's relay routes at e04e9ff (site/app/api/playground/rooms/route.ts,
// rooms/[id]/route.ts and rooms/[id]/events/route.ts) over loopback HTTP, with the
// real PlaygroundRooms class. It reports what clients actually sent.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { PlaygroundError, PlaygroundRooms, ROOM_LIMITS, requestLimit, roomCodec, snapshotLimit, validatePacket } from "./rooms";

// declaredCodecs and limitedJSON are copied from site/lib/playground-api.ts at e04e9ff.
// Clients list the document formats they read, as `codecs=1,2` on the event
// stream and the X-Crabrix-Codecs header elsewhere. Released clients send
// neither and read only format 1.
export function declaredCodecs(request: Request): number[] {
  const value = request.headers.get("x-crabrix-codecs") ?? new URL(request.url).searchParams.get("codecs") ?? "";
  if (!/^[1-9][0-9]?(,[1-9][0-9]?){0,7}$/.test(value)) return [1];
  return value.split(",").map(Number);
}

export async function limitedJSON(request: Request, maximum = 400_000, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json") || request.headers.get("content-encoding")) throw new PlaygroundError("Send uncompressed JSON.", 415);
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared < 0 || declared > maximum) throw new PlaygroundError("Request too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new PlaygroundError("Missing request body.");
  const chunks: Uint8Array[] = []; let length = 0;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let next: ReadableStreamReadResult<Uint8Array>;
    try {
      next = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PlaygroundError("Request body timed out.", 408)), Math.max(0, deadline - Date.now())); })]);
    } catch (error) { void reader.cancel().catch(() => {}); throw error; }
    finally { if (timer) clearTimeout(timer); }
    const { done, value } = next;
    if (done) break;
    length += value.byteLength;
    if (length > maximum) { await reader.cancel(); throw new PlaygroundError("Request too large.", 413); }
    chunks.push(value);
  }
  const buffer = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  let result: unknown;
  try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)); }
  catch { throw new PlaygroundError("Invalid UTF-8 JSON."); }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new PlaygroundError("Invalid request.");
  return result as Record<string, unknown>;
}

export type Seen = { method: string; path: string; codecs: number[]; status?: number };
export type Hooks = {
  // Runs before a room POST is handled; return true when the hook answered it.
  beforePost?: (body: any, id: string, access: string, res: ServerResponse) => boolean | void | Promise<boolean | void>;
  // Runs after an update was appended; return true to drop the reply instead of sending it.
  loseReply?: (body: any) => boolean;
};

export async function startRelay(rooms = new PlaygroundRooms(), hooks: Hooks = {}) {
  const log = { requests: [] as Seen[], creates: [] as any[], updates: [] as any[], snapshots: [] as any[] };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, "http://local"), id = url.pathname.split("/")[4], access = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    // The same Web Request the site's route handlers receive.
    const headers = Object.fromEntries(["authorization", "content-type", "content-length", "content-encoding", "x-crabrix-codecs"].flatMap(name => typeof req.headers[name] === "string" ? [[name, req.headers[name] as string]] : []));
    const request = new Request(url, { method: req.method, headers, ...(req.method === "POST" ? { body: Readable.toWeb(req) as ReadableStream, duplex: "half" } : {}) } as RequestInit);
    const seen: Seen = { method: req.method!, path: url.pathname, codecs: declaredCodecs(request) };
    log.requests.push(seen);
    const body = (maximum?: number) => limitedJSON(request, maximum) as Promise<any>;
    try {
      res.setHeader("Content-Type", "application/json");
      if (url.pathname === "/api/playground/rooms/" && req.method === "POST") {
        const value = await body();
        if (Object.keys(value).some(key => !["snapshot", "lifetimeSeconds", "codec"].includes(key))) throw new PlaygroundError("Unexpected request field.");
        const codec = roomCodec(value.codec);
        log.creates.push(value);
        const room = rooms.create(validatePacket(value.snapshot, snapshotLimit(codec)), Number(value.lifetimeSeconds), undefined, codec);
        res.statusCode = 201; res.end(JSON.stringify(room)); seen.status = 201; return;
      }
      if (url.pathname.endsWith("/events/")) {
        rooms.admit(id, access, seen.codecs);
        rooms.limit("stream:" + id + ":" + access, 30);
        const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        const release = rooms.subscribe(id, access, url.searchParams.get("peer") ?? "", event => typeof event === "string" ? (send(event, {}), res.end()) : send("kind" in event ? "presence" : "update", event));
        res.setHeader("Content-Type", "text/event-stream"); seen.status = 200;
        req.on("close", release); send("state", rooms.state(id, access)); return;
      }
      if (req.method === "GET") { rooms.admit(id, access, seen.codecs); res.end(JSON.stringify(rooms.state(id, access))); seen.status = 200; return; }
      if (req.method === "DELETE") { rooms.close(id, access); res.statusCode = 204; res.end(); seen.status = 204; return; }
      // The body limit follows the verified room's format, as on the site.
      const codec = rooms.admit(id, access, seen.codecs);
      const value = await body(requestLimit(codec));
      if (await hooks.beforePost?.(value, id, access, res)) return;
      if (value.type === "presence") { rooms.publishPresence(id, access, value.peer, validatePacket(value.packet, ROOM_LIMITS.presenceBytes)); res.statusCode = 204; res.end(); seen.status = 204; return; }
      if (value.type === "snapshot") {
        log.snapshots.push(value);
        res.end(JSON.stringify(rooms.compact(id, access, Number(value.sequence), validatePacket(value.packet, snapshotLimit(codec)), value.expectedGeneration))); seen.status = 200; return;
      }
      log.updates.push(value);
      const result = rooms.append(id, access, value.peer, value.messageID, validatePacket(value.packet, ROOM_LIMITS.updateBytes), value.expectedSequence, value.expectedGeneration);
      if (hooks.loseReply?.(value)) { res.destroy(); return; }
      res.end(JSON.stringify(result)); seen.status = 200;
    } catch (error: any) {
      seen.status = error instanceof PlaygroundError ? error.status : 500;
      res.statusCode = seen.status; res.end(JSON.stringify({ error: error instanceof PlaygroundError ? error.message : "This Playground operation could not be completed." }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  return { rooms, log, origin, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
