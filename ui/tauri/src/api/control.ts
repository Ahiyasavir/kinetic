// control.ts — the typed HTTP API layer between the React UI and the Kinetic control server
// (autopilot/ui/server.mjs on http://127.0.0.1:4317).
//
// Rules of this file:
//   • Plain fetch() ONLY. Zero Tauri imports — process lifecycle (start/stop the server itself)
//     belongs to src/tauri/commands.ts; everything data-shaped flows through here.
//   • Result interfaces mirror autopilot/lib/control-api.mjs return values FIELD-FOR-FIELD.
//     If the server adds a field, add it here — never invent fields the server doesn't send.
//   • No type in this file can ever hold a secret. ApiPoolEntry carries `key_env` — the NAME of
//     an environment variable — never a token value.
//   • Server errors arrive as `{ error, code }` JSON; they are surfaced as a thrown
//     ControlApiError, never swallowed.

export const API_BASE = "http://127.0.0.1:4317";

// ── Error envelope ───────────────────────────────────────────────────────────

/** Thrown for every non-2xx response and for network-level failures. */
export class ControlApiError extends Error {
  /** HTTP status of the response, or 0 when the request never reached the server. */
  readonly httpStatus: number;
  /** Engine error code from the `{ error, code }` envelope (e.g. 'WORKSPACE_UNKNOWN'), if any. */
  readonly code: string | null;

  constructor(message: string, httpStatus: number, code: string | null = null) {
    super(message);
    this.name = "ControlApiError";
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

async function parseError(res: Response): Promise<ControlApiError> {
  try {
    const body = (await res.json()) as { error?: string; code?: string | null };
    return new ControlApiError(body.error || `HTTP ${res.status}`, res.status, body.code ?? null);
  } catch {
    return new ControlApiError(`HTTP ${res.status}`, res.status);
  }
}

async function jget<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, init);
  } catch (e) {
    throw new ControlApiError(`control server unreachable: ${(e as Error).message}`, 0);
  }
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

async function jpost<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new ControlApiError(`control server unreachable: ${(e as Error).message}`, 0);
  }
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

// ── /api/health ──────────────────────────────────────────────────────────────

export interface HealthResult {
  ok: true;
  version: string;
  at: string; // ISO timestamp
}

// ── /api/workspaces ──────────────────────────────────────────────────────────

/** One row of the workspace picker (workspace-registry listWorkspaces shape). */
export interface WorkspaceInfo {
  id: string;
  label: string;
  isDefault: boolean;
  root: string;
  branch: string | null;
  budgetScope: string;
}

export interface WorkspacesResult {
  defaultId: string | null;
  warnings: string[];
  workspaces: WorkspaceInfo[];
}

// ── /api/status ──────────────────────────────────────────────────────────────

/** workspace.mjs summarizeWorkspace shape — embedded in StatusResult. */
export interface WorkspaceSummary {
  id: string;
  label: string;
  isDefault: boolean;
  root: string;
  profileId: string | null;
  branch: string | null;
  budgetScope: string;
  stateDir: string;
}

/** budget-governor governCycle snapshot. Known `action` values: 'proceed' | 'downgrade' | 'stop'. */
export interface BudgetSnapshot {
  action: string;
  reason: string | null;
  quotaMode: string;
  safeMode: boolean;
  spent: number;
  quota: number | null; // null = uncapped (UI renders ∞)
  usable: number | null;
  projected: number | null;
  cyclesLeft: number | null; // null = unbounded
  fractionUsed: number;
}

/** The workspace has never run — no state.json yet. Consumers MUST handle this variant. */
export interface StatusNeverRun {
  workspace: WorkspaceSummary;
  exists: false;
  stopRequested: boolean;
  quotaMode: string;
  at: string;
}

export interface StatusLive {
  workspace: WorkspaceSummary;
  exists: true;
  stopRequested: boolean;
  quotaMode: string;
  status: string | null;
  cycle: number;
  goalPhase: string | null;
  queues: { backlog: number; done: number; blocked: number };
  budget: BudgetSnapshot;
  breaker: { tripped: boolean; reason: string | null };
  at: string;
}

export type StatusResult = StatusNeverRun | StatusLive;

// ── /api/queues ──────────────────────────────────────────────────────────────

/** control-api taskSummary shape — one row of a queue listing. */
export interface TaskSummary {
  id: string;
  title: string;
  goal: string;
  risk: number | null;
  status: string | null;
  blockReason: string | null;
  userRequested: boolean;
}

export interface QueuesNeverRun {
  workspace: string;
  exists: false;
  backlog: TaskSummary[]; // always [] in this variant
  done: TaskSummary[];
  blocked: TaskSummary[];
}

export interface QueuesLive {
  workspace: string;
  exists: true;
  backlog: TaskSummary[];
  done: TaskSummary[];
  blocked: TaskSummary[];
}

export type QueuesResult = QueuesNeverRun | QueuesLive;

// ── /api/budget ──────────────────────────────────────────────────────────────

export interface BudgetResult {
  workspace: string;
  budgetScope: string;
  quotaMode: string;
  safeMode: boolean;
  action: string;
  spent: number;
  quota: number | null;
  usable: number | null;
  projected: number | null;
  cyclesLeft: number | null;
  fractionUsed: number;
  usage: { cycles: number; costUsd: number; inputTokens: number; outputTokens: number };
}

// ── /api/activity ────────────────────────────────────────────────────────────

/** One state.history entry. Field set varies by outcome; extras pass through untyped. */
export interface HistoryEntry {
  cycle: number;
  outcome?: string | null;
  title?: string | null;
  taskId?: string | null;
  [key: string]: unknown;
}

export interface ActivityResult {
  workspace: string;
  history: HistoryEntry[];
}

// ── /api/keys ────────────────────────────────────────────────────────────────

/**
 * One config.api_pools entry. `key_env` is the NAME of an environment variable
 * (e.g. "ANTHROPIC_API_KEY_2") — the secret itself lives only in process.env of
 * the engine and NEVER crosses this API. There is deliberately no index signature
 * here: no extra field can smuggle a token through this type.
 */
export interface ApiPoolEntry {
  id: string;
  provider: string;
  key_env: string;
  daily_budget?: number; // USD; 0 or absent = uncapped
}

export interface KeysResult {
  workspace: string;
  pools: ApiPoolEntry[];
}

// ── POST results ─────────────────────────────────────────────────────────────

export interface AddTaskResult {
  workspace: string;
  file: string; // path of the created inbox file
}

export interface StopResult {
  workspace: string;
  stopRequested: boolean;
}

export interface StartResult {
  workspace: string;
  started: true;
  pid: number;
}

// ── Endpoint wrappers ────────────────────────────────────────────────────────

const wsq = (ws: string) => `?ws=${encodeURIComponent(ws)}`;

/**
 * Liveness probe. Bounded by a timeout so an unreachable server fails fast
 * instead of hanging a poll loop.
 */
export function getHealth(timeoutMs = 3000): Promise<HealthResult> {
  return jget<HealthResult>("/api/health", { signal: AbortSignal.timeout(timeoutMs) });
}

/** Workspace picker data. */
export function getWorkspaces(): Promise<WorkspacesResult> {
  return jget<WorkspacesResult>("/api/workspaces");
}

/** Full status snapshot for one workspace. Check `.exists` before reading live fields. */
export function getStatus(ws: string): Promise<StatusResult> {
  return jget<StatusResult>(`/api/status${wsq(ws)}`);
}

/** Backlog / done / blocked task listings. Check `.exists` before trusting counts. */
export function getQueues(ws: string): Promise<QueuesResult> {
  return jget<QueuesResult>(`/api/queues${wsq(ws)}`);
}

/** Budget governor snapshot + lifetime usage counters. */
export function getBudget(ws: string): Promise<BudgetResult> {
  return jget<BudgetResult>(`/api/budget${wsq(ws)}`);
}

/** Tail of the cycle history. `n` is clamped server-side to 1..200. */
export function getActivity(ws: string, n = 20): Promise<ActivityResult> {
  return jget<ActivityResult>(`/api/activity${wsq(ws)}&n=${n}`);
}

/** Secret-free API key pool listing (env-var names only — see ApiPoolEntry). */
export function getKeys(ws: string): Promise<KeysResult> {
  return jget<KeysResult>(`/api/keys${wsq(ws)}`);
}

/** Drop a user task into the workspace's inbox; the loop ingests it next cycle. */
export function addTask(ws: string, text: string): Promise<AddTaskResult> {
  return jpost<AddTaskResult>("/api/task", { ws, text });
}

/**
 * Graceful pause: raises the workspace STOP flag, honored at the next cycle
 * boundary — never kills in-flight work.
 */
export function requestStop(ws: string, reason?: string): Promise<StopResult> {
  return jpost<StopResult>("/api/stop", reason === undefined ? { ws } : { ws, reason });
}

/** Clear the STOP flag so the loop may run again. */
export function clearStop(ws: string): Promise<StopResult> {
  return jpost<StopResult>("/api/resume", { ws });
}

/** Spawn the engine loop for this workspace (detached child of the control server). */
export function startLoop(ws: string): Promise<StartResult> {
  return jpost<StartResult>("/api/start", { ws });
}
