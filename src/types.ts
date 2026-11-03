export type PlaygroundDocument = { schemaVersion:1; name:string; entryFile:string; files:Record<string,string>; edition:'2021'|'2024'; origin?:{url:string;commit?:string} };
export type Change = {path:string;text:string|null};
export type RemoteSelection = {clientID:number;name:string;color:string;file:string;anchor:number;head:number;id?:string};
/** Why a format 2 project cannot run; editing and recovery stay available. */
export type BlockedReason = 'no-files'|'no-entry'|'files'|'file-bytes'|'source-bytes'|'text';
/** A live file of a format 2 room. `requestedPath` is shown only for a conflict name. */
export type ProjectFileSummary = {id:string;path:string;bytes:number;conflict:boolean;requestedPath?:string};
/** A deleted file with text, or text without a file record (`orphan`). */
export type RecoveryRowSummary = {id:string;path:string;bytes:number;conflict:boolean;orphan:boolean;text?:string};
/** Format 2 only. `format` is absent for a format 1 room, whose results keep their shape. */
export type ProjectDetails = {format?:2;entryId?:string|null;entryFallback?:boolean;recovery?:RecoveryRowSummary[];blocked?:BlockedReason[];records?:number;readOnly?:boolean};
export type Status = {connected:boolean;connection:string;execution:string;room?:string;mode?:'edit'|'view';expiresAt?:string;remainingSeconds?:number;canEndRoom?:boolean;revision?:string;stateGenerationChecks?:boolean;lastOperation?:{outcome:'applied'|'not_applied'|'superseded';files:string[]};outcomeUnknown?:boolean;sequence?:number;name?:string;entryFile?:string;edition?:'2021'|'2024';files?:{path:string;bytes:number;id?:string;conflict?:boolean;requestedPath?:string}[];participants?:{name:string}[];selections?:RemoteSelection[];conditionalEdits?:boolean} & ProjectDetails;
export type CreatedRoom = Status & {link:string;linkType:string;instructions:string;canEndRoom:true;expiresAt:string;revision:string};
export type SourceFile = {path:string;text:string;revision:string;contentTrust:string;format?:2;id?:string;conflict?:boolean;requestedPath?:string;recovery?:boolean;orphan?:boolean};
export type Snapshot = {document:PlaygroundDocument;revision:string;contentTrust:string;files?:ProjectFileSummary[]} & ProjectDetails;
export type FileTouch = {id?:string;path:string};
export type ApplyResult = {changed:boolean;revision:string;acknowledgedSequence?:number;files?:string[];edition?:'2021'|'2024';note?:string;format?:2;created?:FileTouch[];recovered?:FileTouch[]};
/** A file named by its stable ID or by its shown path. */
export type FileRef = {id:string}|{path:string};
export type ProjectOperation =
  | {kind:'create';path:string;text?:string} | {kind:'copy';file:FileRef;path:string} | {kind:'write';file:FileRef;text:string}
  | {kind:'move';file:FileRef;path:string} | {kind:'moveFolder';from:string;to:string} | {kind:'delete';file:FileRef} | {kind:'deleteFolder';path:string}
  | {kind:'restore';id:string;path?:string} | {kind:'purge';id:string} | {kind:'setEntry';file:FileRef} | {kind:'setEdition';edition:'2021'|'2024'} | {kind:'setName';name:string};
export type PlanSummary = {created:FileTouch[];written:FileTouch[];moved:{id:string;from:string;to:string}[];deleted:FileTouch[];restored:FileTouch[];purged:FileTouch[];
  metadata:{name?:string;edition?:'2021'|'2024';entryFile?:string};checkSuggested:boolean;after:{entryFile:string;blocked:BlockedReason[];files:(FileTouch&{bytes:number})[];recovery:number}};
export type PlanResult = PlanSummary & {format:2;revision:string;planHash:string;operations:number;note:string};
export type OperationsResult = {format:2;alreadyApplied:boolean;changed:boolean;revision:string;operationId:string;acknowledgedSequence?:number;note:string} & Partial<PlanSummary>;
export type Handoff = {schema:string;linkType:string;link:string;expiresAt:string;revision:string;mode:'edit'|'view';execution:string;warning:string};
export type RuntimeOperation = 'discover'|'grant'|'check'|'build'|'run'|'debug'|'step'|'continue'|'stop'|'status'|'stdout'|'stderr'|'diagnostics'|'locals'|'breakpoints'|'revoke';
export type RuntimeClients = {controller:string;warnings:string[];source:{revision:string;paths:string[]};clients:{fingerprint:string;revision:string;expires:number;name:string;profile:string;operations:string[];ready:boolean;busy:boolean;permissions:string;editConfirmed:boolean;grant?:{id:string;expires:number;operations:string[]}|null;job?:{id:string;requestID:string;operation:string;state:string}}[];execution:string};
export type RuntimeResult = Record<string,unknown>;
