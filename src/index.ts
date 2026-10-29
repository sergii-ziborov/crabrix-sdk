import { PlaygroundRoom } from './room.js';
import type { Status,CreatedRoom,Snapshot,SourceFile,ApplyResult,Handoff,RuntimeClients,RuntimeResult } from './types.js';
export type * from './types.js';
export { PLAYGROUND_LIMITS } from './core/playground-document.js';
export type CrabrixOptions = { name?: string };
export type CreateOptions = { name: string; files?: Record<string,string>; entryFile?: string; lifetimeMinutes?: number };
export type ApplyOptions = { expectedRevision: string; changes: { path: string; text: string | null }[]; entryFile?: string; name?: string };
/** One live temporary Playground per instance. Source stays encrypted at the relay.
 * Neither construction, edits nor a handoff execute source. Call close() in finally.
 */
export class Crabrix {
  readonly #room: PlaygroundRoom;
  constructor(options: CrabrixOptions = {}) { this.#room = new PlaygroundRoom(undefined, options.name); }
  create(options: CreateOptions):Promise<CreatedRoom> { return this.#room.exclusive(()=>this.#room.create(options.name,options.files,options.entryFile,options.lifetimeMinutes)) as Promise<CreatedRoom>; }
  connect(link: string):Promise<Status> { return this.#room.exclusive(()=>this.#room.connect(link)); }
  status():Promise<Status> { return this.#room.exclusive(()=>this.#room.status()); }
  snapshot():Promise<Snapshot> { return this.#room.exclusive(()=>this.#room.snapshot()); }
  read(path: string):Promise<SourceFile> { return this.#room.exclusive(()=>this.#room.read(path)); }
  apply(options: ApplyOptions):Promise<ApplyResult> { return this.#room.exclusive(()=>this.#room.apply(options.expectedRevision,options.changes,options.entryFile,options.name)); }
  select(path: string,anchor: number,head: number,expectedRevision: string) { return this.#room.exclusive(()=>this.#room.select(path,anchor,head,expectedRevision)); }
  /** Explicitly returns a secret link for handoff to an intended participant. */
  share(mode?: 'edit'|'view'):Promise<Handoff> { return this.#room.exclusive(()=>this.#room.share(mode)); }
  runtimeClients():Promise<RuntimeClients> { return this.#room.exclusive(()=>this.#room.runtimeClients()); }
  requestRuntime(target:string,operations:('check'|'build'|'run'|'debug')[]):Promise<RuntimeResult> { return this.#room.exclusive(()=>this.#room.runtimeRequest(target,operations)); }
  start(target:string,operation:'check'|'build'|'run'|'debug',sourceRevision:string):Promise<RuntimeResult> { return this.#room.exclusive(()=>this.#room.runtimeCommand(target,operation,sourceRevision)); }
  job(target:string,sourceRevision:string,job:string,operation:'status'|'stdout'|'stderr'|'diagnostics'|'locals'|'stop'|'step'|'continue'|'breakpoints',options:Record<string,unknown>={}):Promise<RuntimeResult> { return this.#room.exclusive(()=>this.#room.runtimeCommand(target,operation,sourceRevision,job,options)); }
  endRoom() { return this.#room.exclusive(()=>this.#room.endRoom()); }
  disconnect() { return this.#room.exclusive(async()=>this.#room.disconnect()); }
  /** Synchronous cancellation releases network, keys and outstanding operations. */
  close() { this.#room.dispose(); }
}
