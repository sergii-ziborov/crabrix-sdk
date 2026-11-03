import { PlanError, type PlanErrorCode } from "./core/playground-codec-v2.js";

// A stable machine-readable reason beside the existing human text. Codes name only
// the cause actually established: an unexplained 409 is not called a stale revision.
export type ErrorCode =
  | "INVALID_LINK" | "INVALID_ARGUMENT" | "NOT_CONNECTED" | "ROOM_EXPIRED" | "PARTICIPANT_LIMIT_REACHED" | "ROOM_BUDGET_EXCEEDED"
  | "ACCESS_DENIED" | "READ_ONLY" | "REVISION_CONFLICT" | "PATH_CONFLICT" | "LIMIT_EXCEEDED" | "RATE_LIMITED" | "BRIDGE_CLOSED"
  | "NETWORK_UNREACHABLE" | "TLS_ERROR" | "PROXY_ERROR" | "JOIN_TIMEOUT" | "RELAY_CONFLICT" | "RELAY_UNAVAILABLE"
  | "RUNTIME_GRANT_REQUIRED" | "RUNTIME_UNAVAILABLE" | "OUTCOME_UNKNOWN" | "OPERATION_FAILED"
  | "CLIENT_UPDATE_REQUIRED" | "UNSUPPORTED_ROOM_FORMAT" | "PLAN_CHANGED" | "OPERATION_ID_CONFLICT" | "RECOVERY_FULL" | "PROJECT_BLOCKED";

const GUIDANCE: Record<ErrorCode, { retryable: boolean; action: string }> = {
  INVALID_LINK: { retryable: false, action: "check_link" },
  INVALID_ARGUMENT: { retryable: false, action: "fix_request" },
  NOT_CONNECTED: { retryable: false, action: "connect" },
  ROOM_EXPIRED: { retryable: false, action: "request_new_room" },
  PARTICIPANT_LIMIT_REACHED: { retryable: false, action: "free_participant_slot" },
  ROOM_BUDGET_EXCEEDED: { retryable: true, action: "wait_for_snapshot" },
  ACCESS_DENIED: { retryable: false, action: "request_access" },
  READ_ONLY: { retryable: false, action: "request_edit_access" },
  REVISION_CONFLICT: { retryable: true, action: "refresh_and_replan" },
  PATH_CONFLICT: { retryable: false, action: "fix_paths" },
  LIMIT_EXCEEDED: { retryable: false, action: "reduce_selection" },
  RATE_LIMITED: { retryable: true, action: "wait_and_retry" },
  BRIDGE_CLOSED: { retryable: false, action: "restart_bridge" },
  NETWORK_UNREACHABLE: { retryable: true, action: "run_doctor" },
  TLS_ERROR: { retryable: false, action: "run_doctor" },
  PROXY_ERROR: { retryable: true, action: "run_doctor" },
  JOIN_TIMEOUT: { retryable: true, action: "check_link_or_run_doctor" },
  RELAY_CONFLICT: { retryable: true, action: "refresh_and_replan" },
  RELAY_UNAVAILABLE: { retryable: true, action: "wait_and_retry" },
  RUNTIME_GRANT_REQUIRED: { retryable: false, action: "request_runtime_grant" },
  RUNTIME_UNAVAILABLE: { retryable: true, action: "select_runtime_client" },
  OUTCOME_UNKNOWN: { retryable: false, action: "read_state_before_retry" },
  OPERATION_FAILED: { retryable: false, action: "report" },
  CLIENT_UPDATE_REQUIRED: { retryable: false, action: "update_sdk" },
  UNSUPPORTED_ROOM_FORMAT: { retryable: false, action: "use_apply_changes" },
  PLAN_CHANGED: { retryable: true, action: "replan" },
  OPERATION_ID_CONFLICT: { retryable: false, action: "use_new_operation_id" },
  RECOVERY_FULL: { retryable: false, action: "clear_recovery" },
  PROJECT_BLOCKED: { retryable: false, action: "fix_project" },
};

export class CrabrixError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly action: string;
  readonly details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CrabrixError"; this.code = code; this.retryable = GUIDANCE[code].retryable; this.action = GUIDANCE[code].action;
    if (details) this.details = details;
  }
  toJSON() { return { code: this.code, message: this.message, retryable: this.retryable, action: this.action, ...(this.details ? { details: this.details } : {}) }; }
}

export class RelayError extends CrabrixError {
  readonly status?: number;
  constructor(code: ErrorCode, message: string, status?: number) { super(code, message); this.status = status; }
}

const UPDATE_REQUIRED = "This Playground uses a newer document format than this Crabrix SDK reads. Update Crabrix (npm crabrix, the Rust crate or the Go module) to open it.";

/** The relay's own wording is matched to classify, and never echoed to the caller. */
export function relayError(status: number, relayMessage = ""): RelayError {
  if (status === 409) {
    if (/project changed|latest changes/i.test(relayMessage)) return new RelayError("REVISION_CONFLICT", "Revision conflict: the shared project changed; nothing was changed. Read the current Playground before retrying.", status);
    if (/fresh encrypted snapshot/i.test(relayMessage)) return new RelayError("ROOM_BUDGET_EXCEEDED", "The room's relay budget is full and waits for a fresh snapshot; nothing was changed. Retry shortly or save the source.", status);
    if (/four participants/i.test(relayMessage)) return new RelayError("PARTICIPANT_LIMIT_REACHED", "This room already has four participants. Ask one to leave, or use a new room.", status);
    return new RelayError("RELAY_CONFLICT", "Revision conflict, connection conflict or a full room budget; nothing was changed. Read the current Playground before retrying.", status);
  }
  if (status === 410) return new RelayError("ROOM_EXPIRED", "This temporary Playground expired or closed.", status);
  if (status === 403) return new RelayError("ACCESS_DENIED", "This link does not authorize this operation.", status);
  if (status === 413) return new RelayError("LIMIT_EXCEEDED", "This change exceeds the relay's size limit.", status);
  if (status === 429) return new RelayError("RATE_LIMITED", "The Playground relay asked to slow down. Wait a minute before retrying.", status);
  if (status === 503) return new RelayError("RELAY_UNAVAILABLE", "The Playground relay is at capacity. Retry later.", status);
  if (status === 426) return new RelayError("CLIENT_UPDATE_REQUIRED", UPDATE_REQUIRED, status);
  return new RelayError("RELAY_UNAVAILABLE", "The Playground relay could not complete this operation.", status);
}

function causeCodes(error: unknown): { codes: string[]; text: string } {
  const codes: string[] = []; let text = "", current = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    const value = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    if (typeof value.code === "string") codes.push(value.code);
    if (typeof value.name === "string") codes.push(value.name);
    if (typeof value.message === "string") text += " " + value.message;
    current = value.cause;
  }
  return { codes, text };
}
const TLS_CODE = /^(?:CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_TLS|ERR_SSL|HOSTNAME_MISMATCH|ERR_OSSL)/;
const NETWORK_CODE = /^(?:ENOTFOUND|EAI_|ECONN|ETIMEDOUT|EHOST|ENET|EPIPE|UND_ERR_|TimeoutError$)/;
export const proxyVariables = () => ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].filter(name => process.env[name]);

/** A transport failure, or null when this error is not one. Text never carries a URL. */
export function networkError(error: unknown): CrabrixError | null {
  const { codes, text } = causeCodes(error);
  if (codes.some(code => TLS_CODE.test(code)) || /certificate|tls handshake/i.test(text)) return new CrabrixError("TLS_ERROR", "The TLS connection to the Crabrix relay could not be verified. Run `crabrix doctor` to inspect this environment; do not disable certificate checks.");
  if (/proxy/i.test(text)) return new CrabrixError("PROXY_ERROR", "A network proxy refused or failed the connection to the Crabrix relay. Run `crabrix doctor` to inspect this environment.");
  if (codes.some(code => NETWORK_CODE.test(code)) || /fetch failed|network|socket/i.test(text)) {
    const hint = proxyVariables().length ? " Proxy variables are set, and this Node process may not use them." : "";
    return new CrabrixError("NETWORK_UNREACHABLE", "Could not reach the Crabrix relay (DNS, connection or timeout)." + hint + " Run `crabrix doctor` to inspect this environment.");
  }
  return null;
}

const KNOWN: [RegExp, ErrorCode][] = [
  [/bridge is closed/i, "BRIDGE_CLOSED"],
  [/newer format|Update Crabrix/, "CLIENT_UPDATE_REQUIRED"],
  [/Revision conflict/, "REVISION_CONFLICT"],
  [/view-only/, "READ_ONLY"],
  [/Connect to a (?:live )?Playground first|Wait for the shared connection/, "NOT_CONNECTED"],
  [/cannot grant edit|Only the room creator|only a room it created/, "ACCESS_DENIED"],
  [/rate limit|Too many queued/i, "RATE_LIMITED"],
  [/No current grant/, "RUNTIME_GRANT_REQUIRED"],
  [/Runtime (?:controller|transport|access|connection)|pending runtime/i, "RUNTIME_UNAVAILABLE"],
  [/Unsupported source path|collide|spellings conflict|conflicts with a directory|Cannot remove a file|does not exist/, "PATH_CONFLICT"],
  [/1–16|64 KiB|128 KiB|live update limit|distinct file changes/, "LIMIT_EXCEEDED"],
  [/Choose a lifetime|Choose edit or view|Selection must|surrogate pair|Invalid source project|Choose a Rust source entry|project name|participant name/, "INVALID_ARGUMENT"],
];

// A refused plan changes nothing; its own code stays in the details.
const PLAN_CODES: Record<PlanErrorCode, ErrorCode> = {
  "invalid-operation": "INVALID_ARGUMENT", "not-found": "PATH_CONFLICT", "invalid-path": "PATH_CONFLICT", "path-taken": "PATH_CONFLICT",
  limit: "LIMIT_EXCEEDED", "recovery-budget": "RECOVERY_FULL", stale: "REVISION_CONFLICT", "plan-changed": "PLAN_CHANGED", "operation-conflict": "OPERATION_ID_CONFLICT",
};
export const planError = (error: PlanError) => new CrabrixError(PLAN_CODES[error.code] ?? "OPERATION_FAILED", error.message, { planError: error.code });

/** Keeps each original message; only adds the code a caller can act on. */
export function toCrabrixError(error: unknown): CrabrixError {
  if (error instanceof CrabrixError) return error;
  if (error instanceof PlanError) return planError(error);
  const network = networkError(error);
  const message = error instanceof Error ? error.message : "This Playground operation failed.";
  if (network && !KNOWN.some(([pattern]) => pattern.test(message))) return network;
  return new CrabrixError(KNOWN.find(([pattern]) => pattern.test(message))?.[1] ?? "OPERATION_FAILED", message);
}
