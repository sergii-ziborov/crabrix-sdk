import { PlaygroundRoom } from './room.js';
import type { Status,CreatedRoom,Snapshot,SourceFile,ApplyResult,Handoff,RuntimeClients,RuntimeResult,ProjectOperation,PlanResult,OperationsResult } from './types.js';
export type * from './types.js';
export { PLAYGROUND_LIMITS } from './core/playground-document.js';
export { CrabrixError } from './errors.js';
export type CrabrixOptions = { name?: string };
/** Leave `format` unset: format 2 (stable file IDs) is for testing until new rooms move to it. */
export type CreateOptions = { name: string; files?: Record<string,string>; entryFile?: string; lifetimeMinutes?: number; edition?: '2021'|'2024'; format?: 1|2 };
export type ApplyOptions = { expectedRevision: string; changes: { path: string; text: string | null }[]; entryFile?: string; name?: string; edition?: '2021'|'2024' };
/** The operations, revision and hash of a reviewed plan, and a new ID for this change. */
export type ApplyOperationsOptions = { operations: ProjectOperation[]; expectedRevision: string; planHash: string; operationId: string };
/** One live temporary Playground per instance. Source stays encrypted at the relay.
 * Neither construction, edits nor a handoff execute source. Call close() in finally.
 */
export class Crabrix {
  readonly #room: PlaygroundRoom;
  constructor(options: CrabrixOptions = {}) { this.#room = new PlaygroundRoom(undefined, options.name); }
  create(options: CreateOptions):Promise<CreatedRoom> { options=structuredClone(options); return this.#room.exclusive(()=>this.#room.create(options.name,options.files,options.entryFile,options.lifetimeMinutes,options.edition,options.format)) as Promise<CreatedRoom>; }
  connect(link: string):Promise<Status> { return this.#room.exclusive(()=>this.#room.connect(link)); }
  status():Promise<Status> { return this.#room.exclusive(()=>this.#room.status()); }
  snapshot(options: { includeRecoveryText?: boolean } = {}):Promise<Snapshot> { return this.#room.exclusive(()=>this.#room.snapshot(options.includeRecoveryText===true)) as Promise<Snapshot>; }
  read(path: string):Promise<SourceFile> { return this.#room.exclusive(()=>this.#room.read(path)) as Promise<SourceFile>; }
  /** Format 2 rooms: a live file or a recovery row by its stable ID. */
  readById(id: string):Promise<SourceFile> { return this.#room.exclusive(()=>this.#room.read(undefined,id)) as Promise<SourceFile>; }
  apply(options: ApplyOptions):Promise<ApplyResult> { options=structuredClone(options); return this.#room.exclusive(()=>this.#room.apply(options.expectedRevision,options.changes,options.entryFile,options.name,options.edition)); }
  /** Format 2 rooms: check up to 32 file operations without changing anything. */
  planChanges(operations: ProjectOperation[]):Promise<PlanResult> { operations=structuredClone(operations); return this.#room.exclusive(()=>this.#room.plan(operations)) as Promise<PlanResult>; }
  /** Format 2 rooms: apply a reviewed plan once; a retry with the same operationId reports alreadyApplied. */
  applyOperations(options: ApplyOperationsOptions):Promise<OperationsResult> { options=structuredClone(options); return this.#room.exclusive(()=>this.#room.applyPlanned(options.operations,options.expectedRevision,options.planHash,options.operationId)) as Promise<OperationsResult>; }
  select(path: string,anchor: number,head: number,expectedRevision: string) { return this.#room.exclusive(()=>this.#room.select(path,anchor,head,expectedRevision)); }
  /** Explicitly returns a secret link for handoff to an intended participant. */
  share(mode?: 'edit'|'view'):Promise<Handoff> { return this.#room.exclusive(()=>this.#room.share(mode)); }
  runtimeClients():Promise<RuntimeClients> { return this.#room.exclusive(()=>this.#room.runtimeClients()); }
  requestRuntime(target:string,operations:('check'|'build'|'run'|'debug')[]):Promise<RuntimeResult> { return this.#room.exclusive(()=>this.#room.runtimeRequest(target,operations)); }
  start(target:string,operation:'check'|'build'|'run'|'debug',sourceRevision:string):Promise<RuntimeResult> { return this.#room.exclusive(()=>this.#room.runtimeCommand(target,operation,sourceRevision)); }
  job(target:string,sourceRevision:string,job:string,operation:'status'|'stdout'|'stderr'|'diagnostics'|'locals'|'stop'|'step'|'continue'|'breakpoints',options:Record<string,unknown>={}):Promise<RuntimeResult> { options=structuredClone(options); return this.#room.exclusive(()=>this.#room.runtimeCommand(target,operation,sourceRevision,job,options)); }
  /** Read a job's status or paged output without changing it. */
  inspect(target:string,sourceRevision:string,job:string,operation:'status'|'stdout'|'stderr'|'diagnostics'|'locals',options:{cursor?:number}={}):Promise<RuntimeResult> { options=structuredClone(options); return this.#room.exclusive(()=>this.#room.runtimeCommand(target,operation,sourceRevision,job,options)); }
  /** Stop or step a job this controller owns. */
  control(target:string,sourceRevision:string,job:string,operation:'stop'|'step'|'continue'|'breakpoints',options:Record<string,unknown>={}):Promise<RuntimeResult> { options=structuredClone(options); return this.#room.exclusive(()=>this.#room.runtimeCommand(target,operation,sourceRevision,job,options)); }
  endRoom() { return this.#room.exclusive(()=>this.#room.endRoom()); }
  disconnect() { return this.#room.exclusive(async()=>this.#room.disconnect()); }
  /** Synchronous cancellation releases network, keys and outstanding operations. */
  close() { this.#room.dispose(); }
}
