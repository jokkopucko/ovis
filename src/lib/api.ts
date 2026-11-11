import { apiFetch } from "./api-request-id.ts";
import type { PreferencesChange, SharedPreferences } from "../../shared/preferences.ts";
import type { AlertWebhookSave, AlertWebhookView } from "../../shared/alert-webhook.ts";
import type { SeenFinish, SeenPresentation } from "../../shared/seen.ts";
import type { AgentCatalogResponse, AgentTabStarted } from "../../shared/agent-catalog.ts";
import type { ConversationSearchResponse } from "../../shared/conversation-search.ts";
import { resumeConnectionTraces } from "./connectionTrace.ts";
import type { PullRequestCheckLog, PullRequestMergeRequest, PullRequestView } from "../../shared/pull-request.ts";
import type { SystemReport } from "../../shared/system.ts";
import type { MovePlanResponse, MoveStartRequest, MoveStopAllOffer, MoveStopAllRequest, MoveStopRequest } from "../../shared/runtime-move.ts";
import type { EditableText, PaneDocuments, TextSaved, TextSaveRequest } from "../../shared/files.ts";
import { parseSystemReport } from "./systemReport.ts";
import { machinePath, type BridgeHealth, type HerdrCoreFacts, type HerdrIdentity, type HerdrRuntimeFacts, type Machine, type MachineRoster, type RuntimeName, type SetupAction, type SetupJob, type SetupRequest } from "../../shared/machines.ts";
import type {
  WorkspaceMoved,
  HerdrPane,
  AgentKind,
  AgentRenameRequest,
  CommandOutcome,
  ConversationResponse,
  CreateWorktreeRequest,
  CreateTabRequest,
  CreateWorkspaceRequest,
  DevicesRevokedAll,
  DirectoryCreated,
  DirectoryListing,
  FileInfo,
  FocusPaneRequest,
  HealthAuth,
  IntegrationsResponse,
  LanExposure,
  DirectExposure,
  SecuritySummary,
  InteractivePrompt,
  MoveTabRequest,
  MoveTabToWorkspaceRequest,
  TabMoved,
  TabMovedToWorkspace,
  OmoActivity,
  ClaudeArtifact,
  OmpBtwHistory,
  PaneBackgroundAgentDetail,
  OpenWorktreeRequest,
  PairedDevice,
  PairingCode,
  PaneDirection,
  PaneInfo,
  PanePlan,
  PanePromptResponse,
  PaneReadResult,
  PaneResized,
  RepoBranchComparison,
  RepoDiffFileList,
  RepoDiffFilePatch,
  RepoDiffRefs,
  RepoDiffScope,
  PaneSplit,
  PaneSwapped,
  PaneZoomed,
  PaneFindRequest,
  PaneFindResponse,
  PlanStep,
  ProjectFavicon,
  PromptAnswer,
  PushKey,
  PortalAuth,
  PortalInvite,
  PushSubscriptionStatus,
  PortalStatus,
  RelayStatus,
  RemoteAccess,
  RemoveWorktreeRequest,
  ResizePaneRequest,
  SessionHistoryAgent,
  SessionHistoryResponse,
  SessionResumeRequest,
  SessionResumeResponse,
  SessionSnapshot,
  SetSplitRatioRequest,
  SlashCommand,
  SplitPaneDirection,
  SplitPaneRequest,
  SwapPaneRequest,
  MovePaneRequest,
  PaneMoved,
  TabCreated,
  UpdateInstallRequest,
  StatuslineState, UsageReport,
  WorkspaceCreated,
  PluginActionRequest,
  PluginActionResult,
  PluginActions,
  PluginActionsResponse,
  WorktreeInventory,
  WorktreeListing,
  WorktreeOpened,
  WorktreeRemoved,
  ZoomPaneRequest,
} from "../../shared/protocol.ts";
import { SUPPORTED_AGENT_KINDS } from "../../shared/supported-agents.ts";
import type { PaneScrollInfo } from "../../shared/herdr-api.generated.ts";
import { readInstalledNotes, readUpdateNotes, type HerdrUpdateStatus, type InstalledNotes, type UpdateNotes, type UpdateRequest, type UpdateStatus } from "../../shared/update.ts";
import type { AlertPrefs } from "../../shared/notify-policy.ts";
import type { TelemetryChange, TelemetryStatus } from "../../shared/telemetry.ts";
import type { VoiceConfigUpdate, VoiceStatus } from "../../shared/voice.ts";
import { MAX_ATTACHMENT_BYTES } from "../../shared/attachments.ts";
import { t } from "./i18n.ts";
import { chatReadDeadlineMs, withChatReadDeadline } from "./chatReadDeadline.ts";
import { movingHerdrFocus } from "./followFocus.ts";
import { observeWaitingClock, waitingKey } from "./sentWaiting.ts";
import type { UsageAccountRemoval, UsageLoginAccounts, UsageLoginCode, UsageLoginFollowed, UsageLoginPrompt, UsageLoginProvider, UsageLoginRequest, UsageLoginStarted } from "../../shared/usage-login.ts";

export function fetchUsageLoginProviders(signal: AbortSignal): Promise<{ providers: readonly UsageLoginProvider[] }> {
  return getJson("/api/usage/login", { signal });
}

export function fetchUsageLoginAccounts(provider: string, signal: AbortSignal): Promise<UsageLoginAccounts> {
  return getJson(`/api/usage/login?provider=${encodeURIComponent(provider)}`, { signal });
}

/** Starts a Claude Code or Codex sign-in the browser follows: it runs in the server's own PTY, reached by its id. */
export function followUsageLogin(request: Extract<UsageLoginRequest, { provider: "claude" | "codex" }>, signal: AbortSignal): Promise<UsageLoginFollowed> {
  return getJson<UsageLoginFollowed>("/api/usage/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...request, follow: true }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
}

/** What a followed sign-in asks of its user now: the page to open, the code to enter, a code box. */
export function fetchUsageLoginPrompt(login: string, signal: AbortSignal): Promise<UsageLoginPrompt> {
  return getJson(`/api/usage/login/prompt?login=${encodeURIComponent(login)}`, { signal, cache: "no-store" });
}

/** Types the code a sign-in page showed into that sign-in's CLI, then Enter. */
export async function sendUsageLoginCode(request: UsageLoginCode): Promise<void> {
  await sendJson("/api/usage/login/code", "POST", request);
}

/**
 * Stops a followed sign-in's CLI; settles once the server has stopped it and freed its home. Sent as the page
 * may be leaving, so it outlives the page. A handoff must see a failure rather than start beside it.
 */
export async function cancelUsageLogin(login: string): Promise<void> {
  const url = "/api/usage/login/cancel";
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ login }), keepalive: true });
  if (!response.ok) throw await errorFrom(url, response);
}

export function startUsageLogin(request: UsageLoginRequest, signal?: AbortSignal): Promise<UsageLoginStarted> {
  // a request the asker gave up on opens no tab (the server checks before it does)
  const timeout = AbortSignal.timeout(30_000);
  return getJson<UsageLoginStarted>("/api/usage/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
}

/** Settings → Phone: what Tailscale on the server's PC already serves, or the command to run. */
export function fetchRemoteAccess(): Promise<RemoteAccess> {
  return getJson<RemoteAccess>("/api/access");
}

/** The sidebar's plan meters; `refresh` asks the providers again instead of the server's recent answer. */
export function fetchUsage(refresh = false): Promise<UsageReport> {
  return getJson<UsageReport>(refresh ? "/api/usage?refresh=1" : "/api/usage");
}

/** Removes the account from Ovis without changing the CLI's sign-in. */
export async function removeUsageAccount(account: string): Promise<void> {
  await sendJson("/api/usage/accounts", "DELETE", { account } satisfies UsageAccountRemoval);
}

/** Lists a removed account in Ovis again. */
export async function restoreUsageAccount(account: string): Promise<void> {
  await sendJson("/api/usage/accounts", "POST", { account } satisfies UsageAccountRemoval);
}

/** Settings → Agents' plan limits: whether Claude's limits are read from its status line on the server's PC. */
export function fetchStatusline(): Promise<StatuslineState> {
  return getJson<StatuslineState>("/api/usage/statusline", { cache: "no-store" });
}

/** Turns that on or off; the server decides what it installs and where, so only the switch is sent. */
export async function setStatusline(enabled: boolean): Promise<StatuslineState> {
  return await (await sendJson("/api/usage/statusline", "POST", { enabled })).json() as StatuslineState;
}

/** Local server's CLIProxyAPI controls; secrets are only ever sent, never read back. */
export function cliProxyRequest<T>(path = "", init: RequestInit = {}): Promise<T> {
  return getJson<T>(`/api/cliproxy${path}`, { ...init, cache: "no-store", signal: init.signal ?? AbortSignal.timeout(60_000) });
}

export function fetchUpdateStatus(): Promise<UpdateStatus> {
  return getJson<UpdateStatus>("/api/updates");
}

/** What the available update brings. A server older than the notes answers with an error. */
export async function fetchUpdateNotes(): Promise<UpdateNotes> {
  return readUpdateNotes(await getJson<unknown>("/api/updates/notes"));
}

/** What the last update brought. A server older than the question answers with an error. */
export async function fetchInstalledNotes(): Promise<InstalledNotes> {
  return readInstalledNotes(await getJson<unknown>("/api/updates/installed"));
}

/** A check goes without a body; an install names the release the person was offered. */
export async function requestUpdate(request: UpdateRequest): Promise<void> {
  const url = `/api/updates/${request.command}`;
  const response = await apiFetch(url, request.command === "install"
    ? { method: "POST", headers: { "x-herdr-update": "1", "content-type": "application/json" }, body: JSON.stringify({ expected_revision: request.expected_revision } satisfies UpdateInstallRequest) }
    : { method: "POST", headers: { "x-herdr-update": "1" } });
  if (!response.ok) throw await errorFrom(url, response);
}

/** Settings → Updates: herdr itself, on the PC the server runs on. */
export function fetchHerdrUpdate(): Promise<HerdrUpdateStatus> {
  return getJson<HerdrUpdateStatus>("/api/herdr/update");
}

/** Settings → About → Terminals: saves `runtime` and has the server start again on it (server/herdr-core/runtime-choice.ts). */
export async function switchRuntime(runtime: RuntimeName): Promise<void> {
  const url = "/api/runtime";
  const response = await apiFetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify({ runtime }) });
  if (!response.ok) throw await errorFrom(url, response);
}

/** Settings → About → Terminals: the move of this PC's whole herdr session to herdr-core, as it stands now (server/runtime-move.ts). */
export function fetchMovePlan(): Promise<MovePlanResponse> {
  return getJson<MovePlanResponse>("/api/runtime/move", { cache: "no-store" });
}

/** Starts the move of the plan shown, by its revision; a busy pane makes it wait, and the server goes by itself once none is. */
export async function startMove(revision: string): Promise<void> {
  const url = "/api/runtime/move";
  const response = await apiFetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify({ revision } satisfies MoveStartRequest) });
  if (!response.ok) throw await errorFrom(url, response);
}

/** While the move waits: Ctrl+C to a shell pane running the command shown, or once the wait offers it, `force` (SIGTERM to its command). */
export async function stopMovePane(paneId: string, command: string | null, force = false): Promise<void> {
  const url = "/api/runtime/move/stop";
  const body: MoveStopRequest = { pane_id: paneId, ...(command === null ? {} : { command }), ...(force ? { force: true } : {}) };
  const response = await apiFetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify(body) });
  if (!response.ok) throw await errorFrom(url, response);
}

/** End all and move now, asked: the running commands it would end, under a token for exactly that list. */
export async function prepareStopAll(): Promise<MoveStopAllOffer> {
  const url = "/api/runtime/move/stop-all";
  const response = await apiFetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify({} satisfies MoveStopAllRequest) });
  if (!response.ok) throw await errorFrom(url, response);
  return (await response.json()) as MoveStopAllOffer;
}

/** End all and move now, confirmed: refused when the panes changed since the offer, so the person is asked again. */
export async function confirmStopAll(token: string): Promise<void> {
  const url = "/api/runtime/move/stop-all";
  const response = await apiFetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify({ token } satisfies MoveStopAllRequest) });
  if (!response.ok) throw await errorFrom(url, response);
}

/** Installs herdr-core where the move offers it (`install` in the plan's answer); the move is offered once it is in. */
export async function installHerdrCore(): Promise<void> {
  const url = "/api/runtime/move/install";
  const response = await apiFetch(url, { method: "POST", headers: { "x-herdr-update": "1" } });
  if (!response.ok) throw await errorFrom(url, response);
}

/** Ends a wait for busy panes; a move under way is not stopped. */
export async function cancelMove(): Promise<void> {
  const url = "/api/runtime/move";
  const response = await apiFetch(url, { method: "DELETE", headers: { "x-herdr-update": "1" } });
  if (!response.ok) throw await errorFrom(url, response);
}

export async function requestHerdrUpdate(): Promise<void> {
  const url = "/api/herdr/update";
  const response = await apiFetch(url, { method: "POST", headers: { "x-herdr-update": "1" } });
  if (!response.ok) throw await errorFrom(url, response);
}

/** Settings → Phone & devices: Portal's public address for the server's PC. */
export function fetchPortal(): Promise<PortalStatus> {
  return getJson<PortalStatus>("/api/portal");
}

export async function requestPortal(action: "start" | "stop", relay?: string, auth?: PortalAuth): Promise<void> {
  const url = `/api/portal/${action}`;
  const response = await apiFetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify(relay === undefined ? {} : { relay, auth }) });
  if (!response.ok) throw await errorFrom(url, response);
}

/** A private link for `name`, good for `days`: a bearer secret the server keeps nowhere, so this is the one time it is read. */
export async function issuePortalInvite(name: string, days: number): Promise<PortalInvite> {
  const url = "/api/portal/invite";
  const response = await apiFetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify({ name, days }) });
  if (!response.ok) throw await errorFrom(url, response);
  return (await response.json()) as PortalInvite;
}

/** Settings → Phone & devices: the Ovis relay, through which paired phones reach this PC from anywhere. */
export function fetchRelay(): Promise<RelayStatus> {
  return getJson<RelayStatus>("/api/relay");
}

/** POST /api/relay/offer: a one-time pairing offer for the QR code, good until `expires_at`. */
export interface RelayOffer {
  readonly url: string;
  readonly expires_at: string;
}

/**
 * The relay actions answer with the state they left the relay in, a refusal too: a start that
 * serve-only blocks is a 409 whose body is still the RelayStatus, so it is the answer, not an error.
 * Only a body without a phase (the origin gate, a watching device, an older server) is one.
 */
export async function requestRelay(action: "start" | "stop" | "reset-identity"): Promise<RelayStatus> {
  const url = `/api/relay/${action}`;
  const response = await apiFetch(url, { method: "POST", headers: { "x-herdr-update": "1" } });
  if (!response.ok) {
    const body: unknown = await response.clone().json().catch(() => null);
    if (body !== null && typeof body === "object" && "phase" in body) return body as RelayStatus;
    throw await errorFrom(url, response);
  }
  return (await response.json()) as RelayStatus;
}

/** POST /api/relay/direct: whether paired phones may connect straight to this PC on its networks while the relay is on. */
export function requestRelayDirect(on: boolean): Promise<RelayStatus> {
  return getJson<RelayStatus>("/api/relay/direct", { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify({ on }) });
}

/**
 * `noAccountOnly`: the offer is to put this PC in an account (the relay tab's QR code). The PC then makes it only while
 * it is in no account, answers 409 `in_account` once it is in one, and ends the offer's code when it joins one.
 */
export function requestRelayOffer({ noAccountOnly = false }: { noAccountOnly?: boolean } = {}): Promise<RelayOffer> {
  return getJson<RelayOffer>("/api/relay/offer", { method: "POST", headers: { "x-herdr-update": "1", ...(noAccountOnly ? { "x-ovis-no-account-only": "1" } : {}) } });
}

/** POST /api/relay/code: a code to type on the device being paired, good until `expires_at`; it replaces any showing. */
export interface RelayCode {
  readonly code: string;
  readonly expires_at: string;
  readonly server_id: string;
}

export function requestRelayCode(): Promise<RelayCode> {
  return getJson<RelayCode>("/api/relay/code", { method: "POST", headers: { "x-herdr-update": "1" } });
}

/** POST /api/relay/code/cancel: takes the code showing off the relay. `keepalive`: the request outlives a page that is going. */
export function cancelRelayCode(keepalive = false): Promise<{ readonly ok: true }> {
  return getJson<{ readonly ok: true }>("/api/relay/code/cancel", { method: "POST", headers: { "x-herdr-update": "1" }, ...(keepalive ? { keepalive } : {}) });
}

/**
 * POST /api/relay/link: a pairing link without a code; the phone that opens it compares six digits with this PC.
 * `localOnly`: this PC's screen waits to be added to an account, so what comes is approved on this PC only.
 */
export function requestRelayLink(options: { localOnly?: boolean } = {}): Promise<{ readonly url: string }> {
  return getJson<{ readonly url: string }>("/api/relay/link", { method: "POST", headers: { "x-herdr-update": "1", ...(options.localOnly ? { "x-ovis-local-only": "1" } : {}) } });
}

/** POST /api/relay/link/close: the owner stopped waiting, so this PC takes no more comparisons from its link. An older server has no such route (404). */
export function closeRelayLink(): Promise<{ readonly ok: true }> {
  return getJson<{ readonly ok: true }>("/api/relay/link/close", { method: "POST", headers: { "x-herdr-update": "1" } });
}

/** POST /api/relay/pairing: the owner's answer to a phone waiting with the same digits (`relay-pairings` events). */
export async function decideRelayPairing(id: string, decision: "approve" | "decline", digits?: string): Promise<void> {
  const url = "/api/relay/pairing";
  // an account member approving through the relay names the digits it picked (docs/account.md, "Who may admit a device")
  const response = await apiFetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify({ id, decision, ...(digits === undefined ? {} : { digits }) }) });
  if (!response.ok) throw await errorFrom(url, response);
}

/** Anonymous install and update counts; null from a server that sends none (404). */
/** What every browser of this server shares (shared/preferences.ts); null where the server predates it. */
export async function fetchPreferences(): Promise<SharedPreferences | null> {
  try { return await getJson<SharedPreferences>("/api/preferences"); }
  catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
}

/** `keepalive` lets the request finish after the page is gone (a reload, a closed tab) */
export async function savePreferences(body: PreferencesChange, keepalive = false): Promise<SharedPreferences> {
  const url = "/api/preferences";
  const response = await apiFetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive });
  if (!response.ok) throw await errorFrom(url, response);
  return (await response.json()) as SharedPreferences;
}

/**
 * Tells every browser of this server that this one presented a finish (shared/seen.ts). A server
 * that predates it (404) or a watching device (403) keeps the read to this browser; one that
 * predates `presented` ignores it.
 */
export async function shareSeen(finish: SeenFinish, presented?: SeenPresentation): Promise<void> {
  const url = "/api/seen";
  const response = await apiFetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(presented === undefined ? finish : { ...finish, presented }) });
  if (response.ok || response.status === 404 || response.status === 403) return;
  throw await errorFrom(url, response);
}

export async function fetchTelemetry(): Promise<TelemetryStatus | null> {
  try { return await getJson<TelemetryStatus>("/api/telemetry"); }
  catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
}

export async function changeTelemetry(change: TelemetryChange): Promise<TelemetryStatus> {
  const url = "/api/telemetry";
  const response = await apiFetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify(change) });
  if (!response.ok) throw await errorFrom(url, response);
  return (await response.json()) as TelemetryStatus;
}

/**
 * A non-2xx answer from the Ovis API. `code` is the server's error-envelope
 * code when it sent one, so callers can branch on `status` (401 = the token gate)
 * without parsing the message.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** the server's own words, without the URL and status the message starts with */
  readonly detail: string;
  /** how long the server asked to wait before trying again (`Retry-After` in seconds), in ms; null when it did not say */
  readonly retryAfterMs: number | null;

  constructor(url: string, status: number, detail: string, code: string | null, retryAfterMs: number | null = null) {
    super(`${url} failed (${status}): ${detail}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * A 404 for the route itself, not for what it was asked about: a PC whose bridge is from before
 * the route, whose answer the local server passes through (server/machine-api.ts). What herdr
 * refuses comes with a code of its own (pane_not_found).
 */
export const routeMissing = (error: unknown): boolean => error instanceof ApiError && error.status === 404 && error.code === "not_found";

/**
 * The PC proxy's fixed words for another PC's answer it would not pass on (server/remote-json.ts),
 * in the UI language: they are the detail every error surface shows beside its own sentence.
 */
const UNUSABLE_ANSWER: Readonly<Record<string, () => string>> = {
  remote_response_too_large: () => t("The other PC's answer was larger than this app accepts"),
  remote_response_invalid: () => t("The other PC's answer could not be read"),
};

export async function errorFrom(url: string, response: Response): Promise<ApiError> {
  let detail = response.statusText;
  let code: string | null = null;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.message) detail = body.error.message;
    if (body.error?.code) code = body.error.code;
  } catch {
    /* non-JSON error body */
  }
  if (code !== null && Object.hasOwn(UNUSABLE_ANSWER, code)) detail = UNUSABLE_ANSWER[code]!();
  // only the seconds form (the server's `retry-after: 1`); an HTTP date is not one this API sends
  const retryAfter = response.headers.get("retry-after");
  const seconds = retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : null;
  return new ApiError(url, response.status, detail, code, seconds === null ? null : seconds * 1000);
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, init);
  if (!response.ok) throw await errorFrom(url, response);
  return (await response.json()) as T;
}

/** GET /api/system on a PC: its load right now. A bridge from before this route answers 404. */
export async function fetchSystem(machineId = "local", signal?: AbortSignal): Promise<SystemReport> {
  const report = parseSystemReport(await getJson<unknown>(machinePath(machineId, "system"), { cache: "no-store", ...(signal ? { signal } : {}) }));
  // another PC's bridge can be of another version: an answer the sidebar cannot draw is an unusable one
  if (report === null) throw new ApiError(machinePath(machineId, "system"), 502, UNUSABLE_ANSWER["remote_response_invalid"]!(), "remote_response_invalid");
  return report;
}

export async function fetchSession(machineId = "local"): Promise<SessionSnapshot> {
  const body = await getJson<{ snapshot: SessionSnapshot }>(machinePath(machineId, "session"));
  return body.snapshot;
}

/** PCs whose herdr rejected `recent_unwrapped`: an older herdr, read row by row from then on. */
const wrappedOnly = new Set<string>();

/**
 * GET /api/pane/read as the chat view reads it: herdr's own scrollback (up to
 * `lines`), ANSI-stripped text. herdr owns scrollback — the attach stream cannot
 * serve history, so the transcript reads it back instead. `recent_unwrapped`
 * rejoins the rows the terminal soft-wrapped, so a line reflows to the chat's
 * width instead of breaking where the pty's columns ended.
 */
export async function fetchPaneTranscript(paneId: string, lines: number, machineId = "local", signal?: AbortSignal): Promise<PaneReadResult> {
  const read = async (source: "recent" | "recent_unwrapped"): Promise<PaneReadResult> => {
    const query = new URLSearchParams({ pane_id: paneId, source, format: "text", lines: String(lines) });
    return (await withChatReadDeadline((bounded) => getJson<{ read: PaneReadResult }>(machinePath(machineId, `pane/read?${query.toString()}`), { signal: bounded }), chatReadDeadlineMs(machineId), signal)).read;
  };
  if (wrappedOnly.has(machineId)) return read("recent");
  try {
    return await read("recent_unwrapped");
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "invalid_request") throw error;
    wrappedOnly.add(machineId);
    return read("recent");
  }
}

/** Which turns (ConversationResponse.cursor): the page `before` a cursor, not past `since`; the newest ones `from` a held start. */
export type ConversationPageQuery = {
  before?: string; since?: string; from?: string;
  /** History currently displayed, even if its cached response was evicted. */
  history_id?: string;
  /** Prompts per page: the chat's history-page setting, kept in the URL so its cache key matches. */
  prompts?: number;
  /** Revalidate a new finish without borrowing another key's 304. */
  fresh?: boolean;
  /** The requesting screen lifetime; transport-only, never part of the URL or cache key. */
  signal?: AbortSignal;
};

/**
 * The last answer per newest-page conversation URL and its ETag. The chat reads it again on
 * every transcript push (at most every 2s), every send and status edge, and a 10s backstop
 * (2s without pushes),
 * and a newest page can be megabytes: an unchanged one comes back as a bodyless 304,
 * and the chat gets the very same object back, which tells it nothing changed. An
 * older page (`before`) is asked for once, so it keeps no ETag and takes no slot.
 *
 * A count alone does not bound what a tab holds: sixteen polled panes is a small number of
 * bodies, each as large as the server makes it, so the cache also gives up its oldest entries
 * once the answers together pass a byte budget. The answer just fetched is never given up for
 * that (it is the one the caller is about to read), the panes after it go first.
 */
interface ConversationAnswer {
  etag: string;
  body: ConversationResponse;
  /** the body's rough size: what the count cap alone cannot bound */
  bytes: number;
  /** the pane the answer belongs to: a pane the chat has open keeps every page size it read */
  pane: string;
  /** the pane's session when it was read (paneSessions): drawn and revalidated only while the pane is still on it */
  session: string | undefined;
}

/** The pane alone, without the page query: one pane can hold several sizes and cursors at once. */
function paneKey(paneId: string, machineId: string): string {
  return `${machineId}\u0000${paneId}`;
}
const conversationAnswers = new Map<string, ConversationAnswer>();
export const CONVERSATION_ANSWERS_KEPT = 24;
/** …and this much of them: enough for the panes of ten open tabs at the default page size. */
export const CONVERSATION_ANSWERS_BYTES = 64 * 1024 * 1024;
/** One pane's page is a page, not a session: past this a page is fetched again rather than kept. */
export const CONVERSATION_ANSWER_MAX_BYTES = 8 * 1024 * 1024;
/** The panes of the tabs the chat has open: their answers go last when the cache must make room. */
const pinnedConversations = new Set<string>();

/**
 * The UTF-8 length of a body's JSON, counted without encoding a copy of it. `String.length` counts
 * UTF-16 code units, which under-reports CJK and emoji by up to three times; a page's cap is bytes.
 */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    // a well-formed pair is four bytes as one character; a lone surrogate is escaped by JSON.stringify
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * The body a cache entry carries: the server's own count when it sends one for the body as it is,
 * else the JSON we parsed. A compressed answer's length counts the bytes on the wire, not these.
 */
export function conversationAnswerBytes(body: ConversationResponse, contentLength: string | null, contentEncoding: string | null = null): number {
  const declared = Number(contentLength);
  const identity = contentEncoding === null || contentEncoding.trim().toLowerCase() === "identity";
  if (identity && Number.isFinite(declared) && declared > 0) return declared;
  return utf8Length(JSON.stringify(body) ?? "");
}

/**
 * Drops the least recently used answers until the cache is back inside both caps. An answer the
 * chat still has a pane open for is dropped only once no unpinned one is left. The pane, not its
 * URL, is what is pinned: the chat reads its newest page at the page size the setting names, so a
 * pin taken on the URL alone would never match the entry the open pane actually holds.
 */
function trimConversationAnswers(keep: string): void {
  let total = 0;
  for (const answer of conversationAnswers.values()) total += answer.bytes;
  const over = (): boolean => conversationAnswers.size > CONVERSATION_ANSWERS_KEPT || total > CONVERSATION_ANSWERS_BYTES;
  while (over()) {
    let victim: string | undefined;
    for (const [url, answer] of conversationAnswers) {
      if (url === keep) continue;
      if (!pinnedConversations.has(answer.pane)) { victim = url; break; }
      victim ??= url;
    }
    if (victim === undefined) break;
    total -= conversationAnswers.get(victim)!.bytes;
    conversationAnswers.delete(victim);
  }
}

/**
 * Each pane's session as the roster last named it: its agent and the session herdr reports for it.
 * A conversation answer is read for the session its pane was on when the read started, and stands for
 * that session only: a press read is taken, a cached page drawn or revalidated, and an answer kept
 * only while the pane is still on it. A pane the roster has not named yet is on `undefined`.
 */
const paneSessions = new Map<string, string>();
/** Each pane's session (as paneSessions) and folder as the roster last named them: what its slash commands are read for. */
const paneCommandScopes = new Map<string, string>();
/**
 * Per PC, a token its event that panes changed (paneSessionsMoving) gave it until the roster after it
 * names the sessions: a read in between is of a session not known yet, so it stands for none other.
 */
const movingSessions = new Map<string, { token: string; event: number }>();
let movingEvents = 0;

/** The session a pane (paneKey) is on for a read starting now: its PC's moving token, else the roster's. */
function sessionNow(pane: string): string | undefined {
  return movingSessions.get(pane.slice(0, pane.indexOf("\u0000")))?.token ?? paneSessions.get(pane);
}

/**
 * The session names the conversation: herdr reports the pane's agent_session, and its PC has said nothing
 * since. A press read is started and taken only then: a pane with no reported session can change
 * conversation with nothing on the client changing, so its chat asks the server on mount, as before #2562.
 */
function namesSession(session: string | undefined): boolean {
  return session !== undefined && !movingToken(session) && !session.endsWith("\u0000");
}
const movingToken = (session: string): boolean => session.startsWith("moving:");

/** How many PC events said panes changed: a roster read started now is read after every one of them. */
export function paneSessionEvents(): number {
  return movingEvents;
}

/** A pane's session as paneSessions keeps it. */
export function paneSessionKey(pane: Pick<HerdrPane, "agent" | "agent_session">): string {
  return `${pane.agent ?? ""}\u0000${pane.agent_session?.value ?? ""}`;
}

/**
 * Takes every pane's session from a roster as it arrives, before any chat renders from it. A herdr that
 * replaced another reuses its pane IDs, so the session is the herdr's too; a pane the roster no longer
 * lists has none.
 */
export function observePaneSessions(machines: readonly { id: string; snapshot: { herdr_lifetime?: string; panes: readonly Pick<HerdrPane, "pane_id" | "agent" | "agent_session" | "cwd" | "foreground_cwd">[] } | null }[], readAfter?: number): void {
  for (const machine of machines) {
    if (machine.snapshot === null) continue;
    // only a roster read after the PC's last event names its panes' sessions now; one read before it (a poll
    // that was out, a push the server built earlier) can still name the session a pane left
    const moving = movingSessions.get(machine.id);
    if (moving !== undefined && readAfter !== undefined && readAfter >= moving.event) movingSessions.delete(machine.id);
    const listed = new Set<string>();
    for (const pane of machine.snapshot.panes) {
      const key = paneKey(pane.pane_id, machine.id);
      listed.add(key);
      const session = `${machine.snapshot.herdr_lifetime ?? ""}\u0000${paneSessionKey(pane)}`;
      paneSessions.set(key, session);
      // the folder the server lists the pane's commands for (pane-context.ts)
      paneCommandScopes.set(key, `${session}\u0000${pane.foreground_cwd ?? pane.cwd ?? ""}`);
    }
    for (const key of paneSessions.keys()) if (key.startsWith(paneKey("", machine.id)) && !listed.has(key)) paneSessions.delete(key);
    for (const key of paneCommandScopes.keys()) if (key.startsWith(paneKey("", machine.id)) && !listed.has(key)) paneCommandScopes.delete(key);
  }
}

/**
 * What a pane's slash commands are read for now: its session and folder as the roster last named them
 * (empty before it names the pane). The same pane running its agent in another project lists other skills.
 */
export function paneCommandScope(paneId: string, machineId: string): string {
  return paneCommandScopes.get(paneKey(paneId, machineId)) ?? "";
}

/**
 * The PC's token from its last event that panes changed, until the roster after it names them; undefined
 * otherwise. A commands read in that gap may be of a session not named yet: it joins no read begun before
 * and is not kept, while the lists already kept stay drawn.
 */
export function paneScopesMoving(machineId: string): string | undefined {
  return movingSessions.get(machineId)?.token;
}

/**
 * The PC says its panes changed (a session-changed or pane-exited event) before the roster that
 * names them comes: a press read on it may be of a session a pane has left, so none is taken.
 */
export function paneSessionsMoving(machineId: string): void {
  movingEvents += 1;
  movingSessions.set(machineId, { token: `moving:${movingEvents}`, event: movingEvents });
  for (const [url, pressed] of pressReads) if (pressed.pane.startsWith(paneKey("", machineId))) pressReads.delete(url);
}

/** The cached answer at `url`, while its pane is still on the session it was read for; one from another session is dropped. */
function currentAnswer(url: string, pane: string): ConversationAnswer | undefined {
  const answer = conversationAnswers.get(url);
  if (answer === undefined || answer.session === sessionNow(pane)) return answer;
  conversationAnswers.delete(url);
  return undefined;
}

/** The chat's open pane keeps its pages: `pin`ed panes are evicted last. */
export function pinPaneConversation(paneId: string, machineId = "local"): void {
  pinnedConversations.add(paneKey(paneId, machineId));
}

export function unpinPaneConversation(paneId: string, machineId = "local"): void {
  pinnedConversations.delete(paneKey(paneId, machineId));
}

function conversationUrl(paneId: string, machineId: string, page: ConversationPageQuery): string {
  const query = new URLSearchParams({ pane_id: paneId });
  if (page.before !== undefined) query.set("before", page.before);
  if (page.since !== undefined) query.set("since", page.since);
  if (page.from !== undefined) query.set("from", page.from);
  if (page.prompts !== undefined) query.set("prompts", String(page.prompts));
  return machinePath(machineId, `pane/conversation?${query.toString()}`);
}

/**
 * The newest page last answered for this pane (no page query), without asking the server: a chat
 * that mounts draws it at once while its read revalidates it. It leaves the cache order alone.
 */
export function peekPaneConversation(paneId: string, machineId = "local", prompts?: number): ConversationResponse | undefined {
  const answer = conversationAnswers.get(conversationUrl(paneId, machineId, prompts === undefined ? {} : { prompts }));
  return answer?.session === sessionNow(paneKey(paneId, machineId)) ? answer?.body : undefined;
}

/** A newest-page read a press started, the pane's session it was read for, and its answer once it came. */
interface PressRead { at: number; pane: string; session: string | undefined; controller: AbortController; read: Promise<ConversationResponse>; answer?: ConversationResponse }
/**
 * Newest-page reads a press started (prefetchPaneConversation), by page URL without the history:
 * the chat the press opens takes its mount read from here instead of asking again. Each one is
 * taken once, only within PRESS_READ_MS of the press, and only while the pane is still on the session
 * it was read for: any other read asks the server.
 */
const pressReads = new Map<string, PressRead>();
/** A press becomes a pick well within this, or it was a scroll, a drag or a long press. */
export const PRESS_READ_MS = 1000;
/**
 * Per newest-page URL, the read that started last: an older read that answers after it (an untaken press read,
 * a held page) keeps out of the cache. A held (`from`) read also counts for the plain page it writes.
 */
const lastNewestRead = new Map<string, number>();
let newestReads = 0;

/**
 * Starts the first read of a chat that a press is about to open (a tab or a sidebar row, before
 * the pick renders), with the query ChatView's mount read sends. Sent at the press, it answers
 * before the herdr calls the pick sets off, which herdr 0.9.0 holds about 250 ms when they overlap.
 * A pane whose chat is mounted (pinned: shown, or kept in the tab cache) reads it itself, so
 * nothing starts for it.
 */
export function prefetchPaneConversation(paneId: string, machineId: string, prompts: number): void {
  const pane = paneKey(paneId, machineId);
  if (pinnedConversations.has(pane) || !namesSession(sessionNow(pane))) return;
  const url = conversationUrl(paneId, machineId, { prompts });
  if (pressReads.has(url)) return;
  // the mount read names the history of the cached answer it drew (ChatView's peek)
  const cached = currentAnswer(url, pane)?.body;
  const historyId = cached?.source === "scrollback" ? undefined : cached?.history_id;
  const controller = new AbortController();
  const pressed: PressRead = { controller, at: performance.now(), pane, session: sessionNow(pane), read: fetchPaneConversation(paneId, machineId, { prompts, history_id: historyId, fresh: true, signal: controller.signal }) };
  // a press that was a scroll leaves it untaken; a read that takes it on its way still gets its failure,
  // and a read that comes after the failure asks the server again (the bridge may be back by then)
  pressed.read.then((answer) => { pressed.answer = answer; }, () => { if (pressReads.get(url) === pressed) pressReads.delete(url); });
  pressReads.set(url, pressed);
  setTimeout(() => { if (pressReads.get(url) === pressed) pressReads.delete(url); }, PRESS_READ_MS);
}

/**
 * GET /api/pane/conversation/search: the messages and answers that hold `query`, newest first, a
 * few pages per answer; `before` and `historyId` go on from an answer's cursor and history.
 */
export async function searchPaneConversation(paneId: string, query: string, machineId = "local", page: { before?: string; historyId?: string; signal?: AbortSignal } = {}): Promise<ConversationSearchResponse> {
  const params = new URLSearchParams({ pane_id: paneId, q: query });
  if (page.before !== undefined) params.set("before", page.before);
  if (page.historyId !== undefined) params.set("history_id", page.historyId);
  return getJson<ConversationSearchResponse>(machinePath(machineId, `pane/conversation/search?${params.toString()}`), page.signal ? { signal: page.signal } : undefined);
}

/** GET /api/pane/conversation: structured turns, or scrollback fallback; `page` as ConversationResponse.cursor describes. */
export async function fetchPaneConversation(paneId: string, machineId = "local", page: ConversationPageQuery = {}): Promise<ConversationResponse> {
  return readPaneConversation(paneId, machineId, page, false);
}

/** fetchPaneConversation; `retried`: this is the one read again for a session the pane moved to, which is not read a third time. */
async function readPaneConversation(paneId: string, machineId: string, page: ConversationPageQuery, retried: boolean): Promise<ConversationResponse> {
  if (page.signal?.aborted) throw page.signal.reason ?? new DOMException("The read was cancelled.", "AbortError");
  const url = conversationUrl(paneId, machineId, page);
  const pane = paneKey(paneId, machineId);
  const session = sessionNow(pane);
  const polled = page.before === undefined;
  const pressed = polled ? pressReads.get(url) : undefined;
  if (pressed !== undefined) {
    pressReads.delete(url);
    // a press held past its answer: the pick drew that answer from the cache and names its history.
    // A copy is this read's own: the chat counts its presentation read, and it can prove a finish.
    // A pane herdr moved to another session since the press asks again: that answer is the old session's
    if (performance.now() - pressed.at < PRESS_READ_MS && pressed.session === session && namesSession(session)) {
      if (pressed.answer !== undefined) return { ...pressed.answer };
      // The press read is taken once: its adopting screen now owns the pending transport too.
      const abort = () => pressed.controller.abort(page.signal?.reason);
      page.signal?.addEventListener("abort", abort, { once: true });
      try {
        const answer = await pressed.read;
        if (page.signal?.aborted) throw page.signal.reason ?? new DOMException("The read was cancelled.", "AbortError");
        return answer;
      }
      finally { page.signal?.removeEventListener("abort", abort); }
    }
  }
  // the plain page a held read also writes (below): a plain read that starts after it owns that page
  const plain = polled && page.from !== undefined ? conversationUrl(paneId, machineId, page.prompts === undefined ? {} : { prompts: page.prompts }) : undefined;
  const read = ++newestReads;
  if (polled) lastNewestRead.set(url, read);
  if (plain !== undefined) lastNewestRead.set(plain, read);
  const known = polled ? currentAnswer(url, pane) : undefined;
  const requestUrl = page.history_id === undefined ? url : `${url}&history_id=${encodeURIComponent(page.history_id)}`;
  const { response, body } = await withChatReadDeadline(async (signal) => {
    const response = await apiFetch(requestUrl, { cache: "no-store", signal, ...(known && !page.fresh ? { headers: { "if-none-match": known.etag } } : {}) });
    // as it arrived, whatever becomes of its body: its time bounds this browser's clock against the PC's
    const received = performance.now(), receivedWall = Date.now();
    if (response.status === 304 && known) {
      observeWaitingClock(waitingKey(machineId, paneId), response.headers.get("x-server-time"), received, receivedWall);
      return { response, body: known.body };
    }
    if (!response.ok) throw await errorFrom(url, response);
    const body = (await response.json()) as ConversationResponse;
    observeWaitingClock(waitingKey(machineId, paneId), response.headers.get("x-server-time") ?? body.server_time, received, receivedWall);
    return { response, body };
  }, chatReadDeadlineMs(machineId), page.signal).catch((cause: unknown) => {
    // a failed read gives up what it held of the pages' order: a later read is the newest again
    if (polled && lastNewestRead.get(url) === read) lastNewestRead.delete(url);
    if (plain !== undefined && lastNewestRead.get(plain) === read) lastNewestRead.delete(plain);
    // a rejected history is the pane's, whatever page size it was read at: none of its pages may draw again
    // (unless the pane has moved on to another session since: that one's pages are not the rejected history's)
    if (cause instanceof ApiError && cause.status === 409 && sessionNow(pane) === session) {
      for (const [cached, answer] of conversationAnswers) if (cached === url || answer.pane === pane) conversationAnswers.delete(cached);
    }
    throw cause;
  });
  // Cache changes occur after the bounded read: a late, aborted answer cannot replace it.
  // A newest-page read that started after this one owns the cache, answered or not
  const ownsPlain = plain !== undefined && lastNewestRead.get(plain) === read;
  if (ownsPlain) lastNewestRead.delete(plain);
  const ownsUrl = polled && lastNewestRead.get(url) === read;
  if (ownsUrl) lastNewestRead.delete(url);
  if (page.signal?.aborted) throw page.signal.reason ?? new DOMException("The read was cancelled.", "AbortError");
  // the pane went to another session while this read was out: its answer is the session left behind,
  // so the newest page is read again for the session the pane is on now, whether or not a newer read
  // owns the cache; it is never the cache's. Once only: a PC whose panes keep changing is caught up by the chat's
  // next read (a push, the backstop, the roster naming the session), not by a chain of reads
  if (sessionNow(pane) !== session) return polled && !retried ? readPaneConversation(paneId, machineId, { prompts: page.prompts, fresh: true, signal: page.signal }, true) : body;
  if (polled && !ownsUrl) return body;
  if (response.status === 304 && known) {
    conversationAnswers.delete(url);
    conversationAnswers.set(url, known);
    return body;
  }
  const etag = response.headers.get("etag");
  // a wait for the reader's proof keeps the conversation it would return to
  if (!polled || body.recovery === "waiting") return body;
  conversationAnswers.delete(url);
  if (etag !== null) {
    const bytes = conversationAnswerBytes(body, response.headers.get("content-length"), response.headers.get("content-encoding"));
    if (bytes <= CONVERSATION_ANSWER_MAX_BYTES) {
      const answer = { etag, body, bytes, pane, session };
      conversationAnswers.set(url, answer);
      // a chat that holds its newest turns from a cursor (`from`) reads no other newest page: a chat
      // opened again draws this answer first (peekPaneConversation), not the one from before it held.
      // Its ETag is never the plain page's, so the mount read still gets the plain page whole.
      // A newest page read since it started (a chat opened again on the pane's next session) is newer.
      if (plain !== undefined && ownsPlain) {
        conversationAnswers.delete(plain);
        conversationAnswers.set(plain, answer);
      }
      trimConversationAnswers(url);
    }
  }
  return body;
}

export interface HealthInfo {
  ok: boolean;
  herdr: HerdrIdentity;
  /** `server_id`: this PC's relay ID, told to an authenticated browser where the PC has one; absent from an older server */
  web_ui?: { boot_id: string | null; revision: string | null; server_id?: string };
  /** Absent only on a server that predates the token gate. */
  auth?: HealthAuth;
  /** authenticated only; absent from an older server */
  relay?: RelayStatus;
  /** present only while this server is reachable beyond this PC with no token and nothing paired */
  lan_exposure?: LanExposure;
  /** present only while lan_exposure is not: the relay's direct carrier listens on this PC's network, for relay-paired devices only */
  direct_exposure?: DirectExposure;
  /** authenticated only; absent from an older server, which the summary shows as unavailable */
  security?: SecuritySummary;
  /** authenticated only; absent from an older server and until the server's first look for hc has ended */
  herdr_core?: HerdrCoreFacts;
  /** a driving owner only; absent from an older server */
  herdr_runtime?: HerdrRuntimeFacts;
}

export async function fetchHealth(): Promise<HealthInfo> {
  return await getJson<HealthInfo>("/api/health");
}

/**
 * POST /api/auth. Resolves once the server has set its HttpOnly session cookie;
 * there is nothing to store client-side. Throws ApiError (401 `invalid_token`) on
 * a mismatch.
 */
export async function authenticate(token: string): Promise<void> {
  const response = await apiFetch("/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json", "x-herdr-machine": "1" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw await errorFrom("/api/auth", response);
  resumeConnectionTraces();
}

/** POST /api/devices/pair: the code shown on the PC, once; the server answers with this device's own HttpOnly cookie. */
export async function pairDevice(code: string, label: string): Promise<void> {
  const response = await apiFetch("/api/devices/pair", { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ code, label }) });
  if (!response.ok) throw await errorFrom("/api/devices/pair", response);
  resumeConnectionTraces();
}

/** `check`: the PC measures every connected device's round trip first (Check now), within a few seconds */
export async function fetchDevices(check = false): Promise<PairedDevice[]> {
  return (await getJson<{ devices: PairedDevice[] }>(check ? "/api/devices?check=1" : "/api/devices")).devices;
}

export async function startPairing(): Promise<PairingCode> {
  return (await sendJson("/api/devices/pair/start", "POST", {})).json();
}

/**
 * POST /api/devices/pair/cancel { code }: takes that six-digit code back, and the typed relay code bound to it, when it
 * is the one pending; `cancelled` is false when it was not (used up, expired, or replaced by a newer code).
 * `keepalive`: the request outlives a page that is going (a reload, a closed tab).
 */
export async function endPairing(code: string, keepalive = false): Promise<{ readonly ok: true; readonly cancelled: boolean }> {
  return (await sendJson("/api/devices/pair/cancel", "POST", { code }, keepalive)).json();
}

export async function renameDevice(id: string, label: string): Promise<PairedDevice> {
  return (await sendJson(`/api/devices/${encodeURIComponent(id)}`, "PATCH", { label })).json();
}

export async function revokeDevice(id: string): Promise<void> {
  await sendJson(`/api/devices/${encodeURIComponent(id)}`, "DELETE", {});
}

/**
 * POST /api/devices/revoke-all: every paired device loses its pairing access in one durable step,
 * this browser's own included (the answer clears its device cookie). The access token, the PC
 * itself and its Tailscale login get in as before.
 */
export async function revokeAllDevices(): Promise<DevicesRevokedAll> {
  return (await sendJson("/api/devices/revoke-all", "POST", {})).json();
}

/** DELETE /api/auth: clears the session and device cookies, so the next health check reports the gate again. */
export async function signOut(): Promise<void> {
  const response = await apiFetch("/api/auth", { method: "DELETE" });
  if (!response.ok) throw await errorFrom("/api/auth", response);
}

/** Portal's own sign-out, answered by its gateway and never by this server: a same-origin POST that clears Portal's session cookie for this address. */
export async function signOutOfPortal(): Promise<void> {
  const url = "/_portal/auth/logout";
  const response = await apiFetch(url, { method: "POST" });
  if (!response.ok) throw await errorFrom(url, response);
}

/** Chunked btoa: the naive one-liner blows the stack on multi-MB screenshots. */
function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Megabytes to one decimal, rounded up: a file just over the limit never reads as the limit itself. */
const megabytes = (bytes: number): string => `${Math.ceil((bytes / (1024 * 1024)) * 10) / 10} MB`;

/** A file over the attachment limit. Its message is what the person reads: the file, its size, the limit. */
export class AttachmentTooLargeError extends Error {
  readonly fileName: string;
  readonly size: number;

  constructor(fileName: string, size: number) {
    super(t("Too large to attach: {name} ({size}). A file can be up to {limit}.", { name: fileName, size: megabytes(size), limit: megabytes(MAX_ATTACHMENT_BYTES) }));
    this.name = "AttachmentTooLargeError";
    this.fileName = fileName;
    this.size = size;
  }
}

/** Throws for a file the server would refuse, before any of it is read or sent. */
export function assertAttachable(file: Blob): void {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentTooLargeError(file instanceof File && file.name ? file.name : file.type || "file", file.size);
}

/**
 * POST /api/pane/image: stores one pasted or file-picked image next to the pane and
 * resolves to the absolute path the prompt should reference (the composer inserts
 * `@path`). AttachmentTooLargeError for a file over the limit, with nothing sent;
 * ApiError 413 image_too_large from a server whose limit is lower.
 */
/** Any file: an image is stored as a paste, anything else under its own (sanitised) name. */
export async function uploadPaneImage(paneId: string, image: Blob, machineId = "local"): Promise<string> {
  assertAttachable(image);
  const data_base64 = base64FromBytes(new Uint8Array(await image.arrayBuffer()));
  const response = await apiFetch(machinePath(machineId, "pane/image"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-herdr-machine": "1" },
    body: JSON.stringify({ pane_id: paneId, content_type: image.type, data_base64, ...(image instanceof File ? { name: image.name } : {}) }),
  });
  if (!response.ok) throw await errorFrom(machinePath(machineId, "pane/image"), response);
  return ((await response.json()) as { path: string }).path;
}

async function sendJson(url: string, method: "POST" | "PATCH" | "PUT" | "DELETE", body: unknown, keepalive = false): Promise<Response> {
  const response = await apiFetch(url, {
    method,
    headers: { "content-type": "application/json", "x-herdr-machine": "1" },
    body: JSON.stringify(body),
    ...(keepalive ? { keepalive } : {}),
  });
  if (!response.ok) throw await errorFrom(url, response);
  return response;
}

/** GET /api/plugins/actions: the PC's herdr plugins and the actions it can run. */
export async function fetchPluginActions(machineId = "local"): Promise<PluginActions[]> {
  return (await getJson<PluginActionsResponse>(machinePath(machineId, "plugins/actions"))).plugins;
}

/** POST /api/plugin/action: runs one plugin action, against the pane named when there is one. */
export async function runPluginAction(request: PluginActionRequest, machineId = "local"): Promise<PluginActionResult> {
  const response = await sendJson(machinePath(machineId, "plugin/action"), "POST", request);
  return (await response.json()) as PluginActionResult;
}

/** GET /api/plugin/action: where a run the POST answered `running` for stands now. */
export async function fetchPluginActionStatus(pluginId: string, logId: string, machineId = "local"): Promise<PluginActionResult> {
  return getJson<PluginActionResult>(machinePath(machineId, `plugin/action?plugin_id=${encodeURIComponent(pluginId)}&log_id=${encodeURIComponent(logId)}`));
}

/** GET /api/pane/scroll: where the pane's viewport sits in its history (null: herdr reports none). */
export async function fetchPaneScroll(paneId: string, machineId = "local"): Promise<PaneScrollInfo | null> {
  return (await getJson<{ scroll: PaneScrollInfo | null }>(machinePath(machineId, `pane/scroll?pane_id=${encodeURIComponent(paneId)}`))).scroll;
}

/** POST /api/pane/scroll: moves the viewport; herdr redraws the attached terminal. */
export async function scrollPane(paneId: string, offsetFromBottom: number, machineId = "local"): Promise<PaneScrollInfo | null> {
  const response = await sendJson(machinePath(machineId, "pane/scroll"), "POST", { pane_id: paneId, offset_from_bottom: offsetFromBottom });
  return ((await response.json()) as { scroll: PaneScrollInfo | null }).scroll;
}

export async function findPane(request: PaneFindRequest, machineId = "local"): Promise<PaneFindResponse> {
  return (await sendJson(machinePath(machineId, "pane/find"), "POST", request)).json();
}

/** A cell in a pane's whole history: rows count from the top of the scrollback. */
export interface PaneTextPoint { row: number; col: number }

/** GET /api/pane/selection: the text between two history cells, both inclusive, wrapped lines joined. */
export async function fetchPaneSelection(paneId: string, anchor: PaneTextPoint, cursor: PaneTextPoint, machineId = "local"): Promise<string> {
  const query = new URLSearchParams({
    pane_id: paneId,
    anchor_row: String(anchor.row), anchor_col: String(anchor.col),
    cursor_row: String(cursor.row), cursor_col: String(cursor.col),
  });
  return (await getJson<{ text: string }>(machinePath(machineId, `pane/selection?${query.toString()}`))).text;
}

/**
 * POST /api/pane/close: closes the pane in herdr itself (the `pane.close` RPC).
 * The sidebar updates on its own when the server's session-changed broadcast lands;
 * a failure (e.g. the pane already gone) throws ApiError and the 5s poll reconciles.
 */
export async function closePane(paneId: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "pane/close"), "POST", { pane_id: paneId });
}

/** POST /api/pane/focus: herdr brings this pane and its tab/workspace to the front. */
export async function focusPane(paneId: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "pane/focus"), "POST", { pane_id: paneId } satisfies FocusPaneRequest);
}

/** POST /api/pane/rename: sets the pane's label in herdr (an empty label clears it). */
export async function renamePane(paneId: string, label: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "pane/rename"), "POST", { pane_id: paneId, label });
}

/** POST /api/agent/rename: the live name of the agent in the pane, what `herdr agent prompt <name>` addresses; null clears it. */
export async function renameAgent(paneId: string, name: string | null, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "agent/rename"), "POST", { pane_id: paneId, name } satisfies AgentRenameRequest);
}

/**
 * POST /api/pane/split: a new pane beside this one in herdr (its prefix+v / prefix+-), answered as
 * herdr lists it. herdr's focus stays put unless `focus` asks for the new pane, which the caller then
 * opens itself (movingHerdrFocus); the sidebar and the tab strip learn of it from the server's
 * session-changed broadcast.
 */
export async function splitPane(paneId: string, direction: SplitPaneDirection, focus = false, machineId = "local"): Promise<PaneInfo> {
  const request = sendJson(machinePath(machineId, "pane/split"), "POST", { pane_id: paneId, direction, ...(focus ? { focus: true } : {}) } satisfies SplitPaneRequest)
    .then(async (response) => ((await response.json()) as PaneSplit).pane);
  return focus ? movingHerdrFocus(machineId, request) : request;
}

/** POST /api/pane/zoom: herdr's prefix+z on that pane; `zoomed` is the tab's state after it. */
export async function zoomPane(paneId: string, mode: ZoomPaneRequest["mode"] = "toggle", machineId = "local"): Promise<PaneZoomed> {
  const response = await sendJson(machinePath(machineId, "pane/zoom"), "POST", { pane_id: paneId, mode } satisfies ZoomPaneRequest);
  return (await response.json()) as PaneZoomed;
}

/** POST /api/pane/swap: the pane and its neighbour on that side change places; `changed` false when it has none there. */
export async function swapPane(paneId: string, direction: PaneDirection, machineId = "local"): Promise<PaneSwapped> {
  const response = await sendJson(machinePath(machineId, "pane/swap"), "POST", { pane_id: paneId, direction } satisfies SwapPaneRequest);
  return (await response.json()) as PaneSwapped;
}

/** POST /api/pane/swap: an explicit same-tab swap; leave its temporary focus events to the caller. */
export async function swapPaneWith(paneId: string, targetPaneId: string, machineId = "local"): Promise<PaneSwapped> {
  const request = sendJson(machinePath(machineId, "pane/swap"), "POST", { pane_id: paneId, target_pane_id: targetPaneId } satisfies SwapPaneRequest)
    .then(async (response) => (await response.json()) as PaneSwapped);
  return movingHerdrFocus(machineId, request);
}

/** POST /api/pane/move: the pane goes to that side of another pane of its tab; herdr's focus moves on the way and back, so its events wait as a swap's do. */
export async function movePaneBeside(paneId: string, targetPaneId: string, side: PaneDirection, machineId = "local"): Promise<PaneMoved> {
  const request = sendJson(machinePath(machineId, "pane/move"), "POST", { pane_id: paneId, target_pane_id: targetPaneId, side } satisfies MovePaneRequest)
    .then(async (response) => (await response.json()) as PaneMoved);
  return movingHerdrFocus(machineId, request);
}

/** POST /api/layout/ratio: set the split identified by its binary path to the dragged ratio. */
export async function setSplitRatio(tabId: string, path: boolean[], ratio: number, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "layout/ratio"), "POST", { tab_id: tabId, path, ratio } satisfies SetSplitRatioRequest);
}

/** POST /api/pane/resize: the border the pane shares with a neighbour moves that way, by herdr's default share (0.05) of the split the border belongs to. */
export async function resizePane(paneId: string, direction: PaneDirection, machineId = "local"): Promise<PaneResized> {
  const response = await sendJson(machinePath(machineId, "pane/resize"), "POST", { pane_id: paneId, direction } satisfies ResizePaneRequest);
  return (await response.json()) as PaneResized;
}

/** POST /api/pane/clear: clears the pane's terminal screen in herdr. */
export async function clearPane(paneId: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "pane/clear"), "POST", { pane_id: paneId });
}

/** GET /api/agents: of the agent kinds herdr can start, the ones this app supports and that PC has installed, for the new-session dialog. */
export async function fetchAgentKinds(machineId = "local"): Promise<AgentKind[]> {
  // filtered here, not on the server: a remote PC's older bridge still answers every manifest,
  // and says nothing of what is installed, so its supported kinds are all offered
  return (await getJson<{ agents: AgentKind[] }>(machinePath(machineId, "agents"))).agents.filter((agent) => SUPPORTED_AGENT_KINDS.has(agent.kind) && agent.installed !== false);
}

/** GET /api/agent-catalog: every agent Ovis can install, with that PC's commands and what it has installed. */
export async function fetchAgentCatalog(machineId = "local", signal?: AbortSignal): Promise<AgentCatalogResponse> {
  // bounded to 30 s, so a read that never answers ends and Check again can try again; joined by
  // hand, as verifySourceBoot's: AbortSignal.any needs Safari 17.4
  const bounded = new AbortController();
  const end = () => bounded.abort();
  const timer = setTimeout(end, 30_000);
  if (signal?.aborted) end();
  else signal?.addEventListener("abort", end, { once: true });
  try {
    return await getJson<AgentCatalogResponse>(machinePath(machineId, "agent-catalog"), { signal: bounded.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", end);
  }
}

/** POST /api/agent-catalog/install: opens a tab on that PC and types the agent's official command there. */
export async function startAgentInstall(agent: string, machineId = "local", alternative?: number): Promise<AgentTabStarted> {
  const response = await sendJson(machinePath(machineId, "agent-catalog/install"), "POST", alternative === undefined ? { agent } : { agent, alternative });
  return (await response.json()) as AgentTabStarted;
}

/** POST /api/agent-catalog/sign-in: opens a tab on that PC running the agent's own sign-in. */
export async function startAgentSignIn(agent: string, machineId = "local"): Promise<AgentTabStarted> {
  return (await (await sendJson(machinePath(machineId, "agent-catalog/sign-in"), "POST", { agent })).json()) as AgentTabStarted;
}

/** GET /api/integrations: herdr's agent integrations on that PC and whether each is installed. */
export async function fetchIntegrations(machineId = "local"): Promise<IntegrationsResponse["integrations"]> {
  return (await getJson<IntegrationsResponse>(machinePath(machineId, "integrations"))).integrations;
}

/** GET /api/workspace/directories: the folders in `path` (empty: home), for the folder browser. */
export async function fetchDirectories(path: string, hidden: boolean, machineId = "local", files = false, paneId: string | null = null): Promise<DirectoryListing> {
  const query = new URLSearchParams({ path, ...(hidden ? { hidden: "1" } : {}), ...(files ? { files: "1" } : {}), ...(paneId ? { pane_id: paneId } : {}) });
  return getJson<DirectoryListing>(machinePath(machineId, `workspace/directories?${query.toString()}`));
}

/** POST /api/workspace/directories: makes the folder `name` inside `path`, for the folder browser's New folder. */
export async function createDirectory(path: string, name: string, machineId = "local"): Promise<DirectoryCreated> {
  const response = await sendJson(machinePath(machineId, "workspace/directories"), "POST", { path, name });
  return (await response.json()) as DirectoryCreated;
}

function fileQuery(path: string, paneId: string | null): string {
  return new URLSearchParams({ path, ...(paneId ? { pane_id: paneId } : {}) }).toString();
}

/**
 * GET /api/fs/stat: a file to open; `path` is absolute, `~/…` or relative to the pane's
 * folder. A bare name that several files under the folder end in answers with them.
 */
export async function fetchFileInfo(path: string, paneId: string | null, machineId = "local"): Promise<FileInfo | { candidates: string[] }> {
  const url = machinePath(machineId, `fs/stat?${fileQuery(path, paneId)}`);
  const response = await apiFetch(url);
  if (response.status === 409) {
    const body = (await response.json().catch(() => null)) as { error?: { candidates?: unknown } } | null;
    if (Array.isArray(body?.error?.candidates)) return { candidates: body.error.candidates.map(String) };
  }
  if (!response.ok) throw await errorFrom(url, response);
  return (await response.json()) as FileInfo;
}

/** GET /api/fs/text: a text file under the pane's folder, read to edit it (shared/files.ts). */
export async function fetchEditableText(path: string, paneId: string, machineId = "local"): Promise<EditableText> {
  return getJson<EditableText>(machinePath(machineId, `fs/text?${fileQuery(path, paneId)}`), { cache: "no-store" });
}

/** PUT /api/fs/text: saves the text over the file read with `revision`; a file changed since is an ApiError `stale_revision`. */
export async function saveEditableText(request: TextSaveRequest, machineId = "local"): Promise<TextSaved> {
  return (await (await sendJson(machinePath(machineId, "fs/text"), "PUT", request)).json()) as TextSaved;
}

/** GET /api/fs/favicon: the icon the project in folder `root` keeps, or null, in one request. */
export async function fetchProjectFavicon(root: string, machineId = "local"): Promise<FileInfo | null> {
  return (await getJson<ProjectFavicon>(projectFaviconUrl(root, machineId))).icon;
}

export function projectFaviconUrl(root: string, machineId = "local"): string {
  return machinePath(machineId, `fs/favicon?${new URLSearchParams({ root }).toString()}`);
}

/** GET /api/fs/file: the file itself, streamed (ranges for media); `download` saves it instead. */
export function fileUrl(path: string, paneId: string | null, machineId = "local", download = false): string {
  return machinePath(machineId, `fs/file?${fileQuery(path, paneId)}${download ? "&download=1" : ""}`);
}

/**
 * Which repository and which two of its states: the pane's folder (or `directory`, read when the
 * pane is gone), and the working tree against the index, the index against HEAD, two commits, or
 * the working tree against the merge base of a chosen base and HEAD.
 */
export interface RepoDiffQuery {
  paneId: string | null;
  directory: string | null;
  scope: RepoDiffScope;
  /** `commit`: the list's hashes, so a file is read from the same comparison; `branch`: the base to list from */
  base: string | null;
  head: string | null;
  /** `branch` only: the identity the list answered with, which a patch is read from instead of the base's name */
  comparison: RepoBranchComparison | null;
}

function repoDiffQuery(query: RepoDiffQuery): URLSearchParams {
  const pinned = query.scope === "branch" && query.comparison !== null;
  return new URLSearchParams({
    ...(query.paneId ? { pane_id: query.paneId } : {}),
    ...(query.directory ? { directory: query.directory } : {}),
    scope: query.scope,
    ...((query.scope === "commit" || query.scope === "branch") && !pinned && query.base ? { base: query.base } : {}),
    ...(query.scope === "commit" && query.head ? { head: query.head } : {}),
    ...(pinned ? { comparison: JSON.stringify(query.comparison) } : {}),
  });
}

/** GET /api/workspace/diff/refs: the repository's branches, for choosing a base; nothing is fetched. */
export async function fetchRepoDiffRefs(query: Pick<RepoDiffQuery, "paneId" | "directory">, machineId = "local"): Promise<RepoDiffRefs> {
  const params = new URLSearchParams({ ...(query.paneId ? { pane_id: query.paneId } : {}), ...(query.directory ? { directory: query.directory } : {}) });
  return getJson<RepoDiffRefs>(machinePath(machineId, `workspace/diff/refs?${params.toString()}`));
}

/** GET /api/workspace/diff/files: the files a comparison changed, with their status and counts. */
export async function fetchRepoDiffFiles(query: RepoDiffQuery, machineId = "local"): Promise<RepoDiffFileList> {
  return getJson<RepoDiffFileList>(machinePath(machineId, `workspace/diff/files?${repoDiffQuery(query).toString()}`));
}

/** GET /api/workspace/diff/file: one changed file's patch, as git prints it, or why there is none. */
export async function fetchRepoDiffFile(query: RepoDiffQuery, path: string, oldPath: string | null, machineId = "local"): Promise<RepoDiffFilePatch> {
  const params = repoDiffQuery(query);
  params.set("path", path);
  if (oldPath !== null) params.set("old_path", oldPath);
  return getJson<RepoDiffFilePatch>(machinePath(machineId, `workspace/diff/file?${params.toString()}`));
}

/** The folder whose branch's pull request is read: the pane's own, or `directory` when the pane is gone. */
export interface PullRequestTarget { paneId: string | null; directory: string | null }

function pullRequestParams(target: PullRequestTarget): URLSearchParams {
  return new URLSearchParams({ ...(target.paneId ? { pane_id: target.paneId } : {}), ...(target.directory ? { directory: target.directory } : {}) });
}

/** GET /api/workspace/pr: the branch's pull request, its checks and open review threads, read through the PC's gh. */
export async function fetchPullRequest(target: PullRequestTarget, machineId = "local"): Promise<PullRequestView> {
  return getJson<PullRequestView>(machinePath(machineId, `workspace/pr?${pullRequestParams(target).toString()}`));
}

/** GET /api/workspace/pr/log: the last lines of a check's Actions job log. */
export async function fetchPullRequestLog(target: PullRequestTarget, jobId: string, host: string, machineId = "local"): Promise<PullRequestCheckLog> {
  const params = pullRequestParams(target);
  params.set("job_id", jobId);
  params.set("host", host);
  return getJson<PullRequestCheckLog>(machinePath(machineId, `workspace/pr/log?${params.toString()}`));
}

/** POST /api/workspace/pr/merge: merges the pull request at the head it was read at, with the method shown. */
export async function mergePullRequest(target: PullRequestTarget, merge: Pick<PullRequestMergeRequest, "number" | "head_oid" | "base_ref" | "method">, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "workspace/pr/merge"), "POST", { ...(target.paneId ? { pane_id: target.paneId } : {}), ...(target.directory ? { directory: target.directory } : {}), ...merge } satisfies PullRequestMergeRequest);
}

export type { CreateTabRequest, CreateWorkspaceRequest } from "../../shared/protocol.ts";

/**
 * POST /api/workspace/create: a new herdr workspace (and an agent started in its root
 * pane when `agent` is given). Slow when an agent starts: herdr waits for the agent's
 * interactive prompt (up to 60s) before answering.
 */
export async function createWorkspace(request: CreateWorkspaceRequest, machineId = "local"): Promise<WorkspaceCreated> {
  const response = await sendJson(machinePath(machineId, "workspace/create"), "POST", request);
  return (await response.json()) as WorkspaceCreated;
}

/** POST /api/worktree/create: a git worktree of the workspace's repository, opened as a workspace grouped with it. */
export async function createWorktree(request: CreateWorktreeRequest, machineId = "local"): Promise<WorktreeOpened> {
  const response = await sendJson(machinePath(machineId, "worktree/create"), "POST", request);
  return (await response.json()) as WorktreeOpened;
}

/** GET /api/worktree/list: every checkout of the workspace's repository, with the workspace each is open in. */
export function listWorktrees(workspaceId: string, machineId = "local"): Promise<WorktreeListing> {
  return getJson<WorktreeListing>(`${machinePath(machineId, "worktree/list")}?workspace_id=${encodeURIComponent(workspaceId)}`);
}

/**
 * GET /api/worktree/inventory: what listWorktrees answers for each workspace, in one read (at most
 * MAX_INVENTORY_WORKSPACES). A PC whose bridge is from before it answers 404 not_found (routeMissing).
 */
export function readWorktreeInventory(workspaceIds: readonly string[], machineId = "local"): Promise<WorktreeInventory> {
  return getJson<WorktreeInventory>(`${machinePath(machineId, "worktree/inventory")}?${workspaceIds.map((id) => `workspace_id=${encodeURIComponent(id)}`).join("&")}`);
}

/** POST /api/worktree/open: an existing checkout as a workspace; the one it already has when it is open. */
export async function openWorktree(request: OpenWorktreeRequest, machineId = "local"): Promise<WorktreeOpened> {
  const response = await sendJson(machinePath(machineId, "worktree/open"), "POST", request);
  return (await response.json()) as WorktreeOpened;
}

/**
 * GET /api/sessions/history: the earlier sessions of `agent` in the workspace's folder, newest first;
 * never cached. `paneId` is the pane the list was asked for from: Claude's are that pane's store's.
 * Pi reads refused by their deadline, reader limit or a changed transcript throw ApiError 503
 * `session_history_busy` (with retryAfterMs). The dialog retries while keeping its loading state,
 * then offers Retry, never incomplete rows. The server reuses only stat-keyed completed labels,
 * never an unfinished scan.
 */
export function fetchSessionHistory(workspaceId: string, agent: SessionHistoryAgent, machineId = "local", paneId: string | null = null): Promise<SessionHistoryResponse> {
  const query = new URLSearchParams({ workspace_id: workspaceId, agent, ...(paneId === null ? {} : { pane_id: paneId }) });
  return getJson<SessionHistoryResponse>(`${machinePath(machineId, "sessions/history")}?${query.toString()}`, { cache: "no-store" });
}
/** POST /api/sessions/resume: a Claude row's Resume, in the store it was listed from. */
export async function resumeSession(request: SessionResumeRequest, machineId = "local"): Promise<SessionResumeResponse> {
  const response = await sendJson(machinePath(machineId, "sessions/resume"), "POST", request);
  return (await response.json()) as SessionResumeResponse;
}
/**
 * Whether the PC's bridge has the session history route, asked without a query so no session is
 * listed: a bridge that has it refuses the query (400), one from before it answers not_found (404).
 * Any other refusal (403 for a device that only watches) still says the route is there; a PC that
 * could not be asked rejects, so the caller asks again when it comes back.
 */
export async function sessionHistoryOffered(machineId = "local"): Promise<boolean> {
  try { await getJson(machinePath(machineId, "sessions/history")); return true; }
  catch (error) {
    if (routeMissing(error)) return false;
    if (error instanceof ApiError && error.status < 500) return true;
    throw error;
  }
}
/** POST /api/tab/create: another tab in an existing workspace, with the same agent launch. */
export async function createTab(request: CreateTabRequest, machineId = "local"): Promise<TabCreated> {
  const response = await sendJson(machinePath(machineId, "tab/create"), "POST", request);
  return (await response.json()) as TabCreated;
}

/** POST /api/tab/rename: the tab's name in herdr; an empty one is refused. */
export async function renameTab(tabId: string, label: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "tab/rename"), "POST", { tab_id: tabId, label });
}

/** Move within its workspace without changing the selected pane or tab. */
export async function moveTab(tabId: string, insertIndex: number, machineId = "local"): Promise<TabMoved> {
  const request: MoveTabRequest = { tab_id: tabId, insert_index: insertIndex };
  const response = await sendJson(machinePath(machineId, "tab/move"), "POST", request);
  return (await response.json()) as TabMoved;
}

/** A one-pane tab into a new tab of another workspace; its pane answers under its new ID. */
export async function moveTabToWorkspace(tabId: string, workspaceId: string, machineId = "local"): Promise<TabMovedToWorkspace> {
  const request: MoveTabToWorkspaceRequest = { tab_id: tabId, workspace_id: workspaceId };
  const response = await sendJson(machinePath(machineId, "tab/move-to-workspace"), "POST", request);
  return (await response.json()) as TabMovedToWorkspace;
}

/** POST /api/tab/close: the tab and every pane in it; a workspace's last tab takes the workspace with it. */
export async function closeTab(tabId: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "tab/close"), "POST", { tab_id: tabId });
}

export async function renameWorkspace(workspaceId: string, label: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "workspace/rename"), "POST", { workspace_id: workspaceId, label });
}

/**
 * POST /api/workspace/move: places the workspace at `insertIndex` in herdr's order (the sidebar order).
 * The receipt says which move this was in that PC's server's order (lib/workspaceOrder.ts).
 */
export async function moveWorkspace(workspaceId: string, insertIndex: number, machineId = "local"): Promise<WorkspaceMoved> {
  const response = await sendJson(machinePath(machineId, "workspace/move"), "POST", { workspace_id: workspaceId, insert_index: insertIndex });
  return (await response.json().catch(() => ({ ok: true }))) as WorkspaceMoved;
}

/** closeGroup takes the repository's open worktree workspaces with it; herdr refuses to close over them otherwise. */
export async function closeWorkspace(workspaceId: string, machineId = "local", closeGroup = false): Promise<void> {
  await sendJson(machinePath(machineId, "workspace/close"), "POST", { workspace_id: workspaceId, ...(closeGroup ? { close_group: true } : {}) });
}

/** POST /api/worktree/remove: deletes the checkout and closes its workspace; the branch stays. */
export async function removeWorktree(request: RemoveWorktreeRequest, machineId = "local"): Promise<WorktreeRemoved> {
  const response = await sendJson(machinePath(machineId, "worktree/remove"), "POST", request);
  return (await response.json()) as WorktreeRemoved;
}

/** GET /api/pane/commands: the slash commands the pane's agent understands (built-in + custom). */
export async function fetchPaneCommands(paneId: string, machineId = "local"): Promise<SlashCommand[]> {
  // a read that never answers would be shared by every later caller for good: it fails at a deadline instead,
  // past the 45 s the server waits for a scan before it answers 503 (server/commands.ts COMMANDS_WAIT_MS)
  return (await withChatReadDeadline((signal) => getJson<{ commands: SlashCommand[] }>(machinePath(machineId, `pane/commands?pane_id=${encodeURIComponent(paneId)}`), { signal }), 4 * chatReadDeadlineMs(machineId))).commands;
}

/**
 * GET /api/agent/commands?agent=&cwd=: the commands `agent` would offer in `cwd` before any pane runs it
 * (the new workspace and tab dialogs list its skills), read from the bridge's tables and the folder; no
 * process is started for it. A folder of null asks for the agent's own and the user's skills alone.
 */
export async function fetchAgentCommands(agent: string, cwd: string | null, machineId = "local"): Promise<SlashCommand[]> {
  const query = new URLSearchParams({ agent, ...(cwd === null || cwd.trim() === "" ? {} : { cwd }) });
  return (await getJson<{ commands: SlashCommand[] }>(`${machinePath(machineId, "agent/commands")}?${query.toString()}`)).commands;
}

/** GET /api/pane/omo-tasks: the background tasks and workflows the pane's OmO session started, and that PC's clock. */
export async function fetchPaneOmoActivity(paneId: string, machineId = "local"): Promise<{ tasks: OmoActivity["tasks"]; runs: OmoActivity["runs"]; serverTime: string | null; moreRunning: number }> {
  const activity = await getJson<Partial<OmoActivity>>(machinePath(machineId, `pane/omo-tasks?pane_id=${encodeURIComponent(paneId)}`));
  // a bridge from before workflows answers tasks only; one from before the running list was cut, every running one
  return { tasks: activity.tasks ?? [], runs: activity.runs ?? [], serverTime: activity.server_time ?? null, moreRunning: typeof activity.more_running === "number" && activity.more_running > 0 ? activity.more_running : 0 };
}

/**
 * GET /api/pane/background-agent: what a running Claude Code subagent's own transcript holds now,
 * read-only and bounded (its dispatch prompt, its prose and the tools it called), for the
 * background-task list's detail sheet. The PC resolves the session and the files: the caller
 * names a pane and the agent id the list gave it, nothing else.
 */
export async function fetchPaneBackgroundAgent(paneId: string, agentId: string, machineId = "local"): Promise<PaneBackgroundAgentDetail> {
  const query = new URLSearchParams({ pane_id: paneId, agent_id: agentId });
  return await getJson<PaneBackgroundAgentDetail>(machinePath(machineId, `pane/background-agent?${query.toString()}`));
}

/** GET /api/pane/artifacts: the pages the pane's Claude Code session published, newest first. */
export async function fetchPaneArtifacts(paneId: string, machineId = "local"): Promise<ClaudeArtifact[]> {
  return (await getJson<{ artifacts: ClaudeArtifact[] }>(machinePath(machineId, `pane/artifacts?pane_id=${encodeURIComponent(paneId)}`))).artifacts;
}

/** GET /api/pane/btw: the side conversations the pane's OMP session saved with `/btw`, newest first; `more` when the PC left some out. */
export async function fetchPaneBtw(paneId: string, machineId = "local", signal?: AbortSignal): Promise<OmpBtwHistory> {
  const answer = await getJson<Partial<OmpBtwHistory>>(machinePath(machineId, `pane/btw?pane_id=${encodeURIComponent(paneId)}`), { signal });
  return { topics: answer.topics ?? [], more: answer.more === true };
}

/** GET /api/pane/plan: the plan the pane's Claude Code or Codex session keeps, and that PC's clock. */
export async function fetchPanePlan(paneId: string, machineId = "local"): Promise<{ steps: PlanStep[] | null; serverTime: string | null }> {
  const answer = await getJson<Partial<PanePlan>>(machinePath(machineId, `pane/plan?pane_id=${encodeURIComponent(paneId)}`));
  return { steps: answer.plan?.steps ?? null, serverTime: answer.server_time ?? null };
}

/** GET /api/pane/files: paths under the pane's cwd matching `query`, for @-mentions. */
export async function fetchPaneFiles(paneId: string, query: string, limit = 20, machineId = "local"): Promise<string[]> {
  const params = new URLSearchParams({ pane_id: paneId, q: query, limit: String(limit) });
  return (await getJson<{ files: string[] }>(machinePath(machineId, `pane/files?${params.toString()}`))).files;
}

/** GET /api/pane/docs: the Markdown files under the pane's folder, newest first. */
export async function fetchPaneDocuments(paneId: string, machineId = "local", signal?: AbortSignal): Promise<PaneDocuments> {
  return getJson<PaneDocuments>(machinePath(machineId, `pane/docs?pane_id=${encodeURIComponent(paneId)}`), { signal });
}

/** GET /api/pane/prompt: the agent's interactive menu currently on screen, or null. */
export async function fetchPanePrompt(paneId: string, machineId = "local"): Promise<InteractivePrompt | null> {
  return (await fetchPanePromptState(paneId, machineId)).prompt;
}

/** The waiting prompt, and with none, the next prompt the agent suggests; restored is a send the agent put back in its input box when it was cancelled; outcomes are the pane's tracked command sends (older servers send none of the three). */
export async function fetchPanePromptState(paneId: string, machineId = "local"): Promise<{ prompt: InteractivePrompt | null; suggestion: string | null; restored: string | null; outcomes: CommandOutcome[] }> {
  const body = await getJson<PanePromptResponse>(machinePath(machineId, `pane/prompt?pane_id=${encodeURIComponent(paneId)}`));
  return {
    prompt: body.prompt,
    suggestion: typeof body.suggestion === "string" && body.suggestion !== "" ? body.suggestion : null,
    restored: typeof body.restored === "string" && body.restored !== "" ? body.restored : null,
    outcomes: Array.isArray(body.outcomes) ? body.outcomes : [],
  };
}

/** POST /api/pane/prompt/answer: ApiError 409 `prompt_changed` when the menu moved on. */
export async function answerPanePrompt(answer: PromptAnswer, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "pane/prompt/answer"), "POST", answer);
}

/** GET /api/push: the server's VAPID key, the `applicationServerKey` this device subscribes with. */
export async function fetchPushKey(): Promise<string> {
  return (await getJson<PushKey>("/api/push")).public_key;
}

/** `alerts`: what this device wants to hear about; the server applies it to every alert it sends here. */
export async function registerPushSubscription(subscription: PushSubscriptionJSON, alerts?: AlertPrefs): Promise<void> {
  await sendJson("/api/push/subscribe", "POST", alerts === undefined ? { subscription } : { subscription, alerts });
}

export async function unregisterPushSubscription(endpoint: string): Promise<void> {
  await sendJson("/api/push/subscribe", "DELETE", { endpoint });
}

/** One confirmation push to this device only; ApiError 502 `push_failed` when the push service refused it. */
export async function sendTestPush(endpoint: string): Promise<void> {
  await sendJson("/api/push/test", "POST", { endpoint });
}

/**
 * POST /api/push/status: what the server knows of this browser's own subscription (the one its
 * PushManager holds, never the selected PC's), once it has proven the keys. `null` when the
 * server does not know it: another owner's, a stranger's or never registered are one answer.
 * A server from before the route throws its 404 `not_found` (`routeMissing`).
 */
export async function fetchPushSubscriptionStatus(subscription: PushSubscriptionJSON): Promise<PushSubscriptionStatus | null> {
  try {
    return await (await sendJson("/api/push/status", "POST", { subscription })).json() as PushSubscriptionStatus;
  } catch (error) {
    if (error instanceof ApiError && error.code === "subscription_not_found") return null;
    throw error;
  }
}

export function fetchBridgeHealth(): Promise<BridgeHealth> { return getJson("/api/health?scope=bridge"); }
export async function fetchMachines(signal?: AbortSignal): Promise<Machine[]> {
  const response = await apiFetch("/api/machines", { signal });
  if (!response.ok) throw await errorFrom("/api/machines", response);
  return ((await response.json()) as { machines: Machine[] }).machines;
}
/**
 * GET /api/machines?verify_source_boot: the roster, and the boot id of the server behind `machineId`
 * proved during this very request (shared/protocol.ts). Null when the server proves nothing: a
 * refusal, or an older server that ignored the query. Bounded to 20 s, and ended by `signal`.
 */
export async function verifySourceBoot(machineId: string, signal: AbortSignal): Promise<{ machines: Machine[]; boot_id: string } | null> {
  const path = `/api/machines?verify_source_boot=${encodeURIComponent(machineId)}`;
  // joined by hand: AbortSignal.any needs Safari 17.4, and without this check a PC's order never
  // leaves an old epoch after its server restarts
  const bounded = new AbortController();
  const end = () => bounded.abort();
  const timer = setTimeout(end, 20_000);
  if (signal.aborted) end();
  else signal.addEventListener("abort", end, { once: true });
  try {
    const response = await apiFetch(path, { signal: bounded.signal, cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as MachineRoster;
    const proof = body.verified_source_boot;
    return proof?.machine_id === machineId && typeof proof.boot_id === "string" && proof.boot_id !== "" ? { machines: body.machines, boot_id: proof.boot_id } : null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", end);
  }
}
export async function machineRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  // x-herdr-update: an owner's actions on its PCs (updates, turning one on, approving an install) need it, as this PC's own updates do
  const response = await apiFetch(`/api/machines${path}`, { method, headers: { "content-type": "application/json", "x-herdr-machine": "1", "x-herdr-update": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw await errorFrom("/api/machines", response);
  return response.json();
}
/** A PC this PC's server could reach over SSH: a host of its ssh config, or a PC of its Tailscale login (server/ssh-candidates.ts). */
export interface SshCandidate {
  readonly name: string; readonly destination: string; readonly detail: string | null; readonly source: "ssh_config" | "tailscale";
  /** the MagicDNS name of the Tailscale PC it is, when it is one (a config host may name one) */
  readonly tailnet?: string;
}
/** GET /api/machines/ssh-candidates: Add a connection → SSH's list, each added through the Add PC dialog. */
export const findSshCandidates = () => machineRequest<{ pcs: SshCandidate[] }>("/ssh-candidates");
/** A PC of this PC's Tailscale login whose Ovis lets this PC in as its owner (server/tailnet-pcs.ts); `outdated`: older than 0.5. */
export interface TailnetPc { readonly name: string; readonly url: string; readonly relay: string | null; readonly outdated: boolean }
/** GET /api/machines/tailnet: those PCs, each asked over Tailscale which Ovis it runs. */
export const findTailnetPcs = () => machineRequest<{ pcs: TailnetPc[] }>("/tailnet");
/** Another PC of the account as the page read it from the account's directory: its key checked against its id here too. */
export interface AccountPcEntry { readonly server_id: string; readonly server_public_key: string; readonly relay: string; readonly name: string }
/** Whether another PC of the account would pair with this one: it answered the relay and takes such a pairing, is an older Ovis, or did not answer. */
export type AccountPcState = "ready" | "outdated" | "offline";
/** POST /api/machines/relay/account/check: asks each PC, sending nothing to pair. */
export const checkAccountPcs = (pcs: readonly AccountPcEntry[]) => machineRequest<{ pcs: { server_id: string; state: AccountPcState }[] }>("/relay/account/check", "POST", { pcs });
/** POST /api/machines/relay/account/start: the key this PC would hold for that PC, for the admission to name; ApiError `account_pc_outdated` for an older one. */
export const startAccountPc = (pc: AccountPcEntry) => machineRequest<{ ticket: string; key: string; label: string }>("/relay/account/start", "POST", { pc });
/**
 * POST /api/machines/relay/account/pair: compares digits with that PC through the relay, `onDigits` told them once that
 * PC took the request, and resolves with the PC once a member of the account approved it there. Aborting `signal`
 * cancels it on this PC's server too. ApiError `account_pc_<failure>` otherwise.
 */
export async function pairAccountPc(ticket: string, onDigits: (digits: string) => void, signal: AbortSignal): Promise<Machine> {
  const url = "/api/machines/relay/account/pair";
  const response = await apiFetch(url, { method: "POST", signal, headers: { "content-type": "application/json", "x-herdr-machine": "1", "x-herdr-update": "1" }, body: JSON.stringify({ ticket }) });
  if (!response.ok || response.body === null) throw await errorFrom(url, response);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) throw new ApiError(url, 502, "The answer ended early", null);
    buffer += chunk.value;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = JSON.parse(buffer.slice(0, end)) as { digits?: string; machine?: Machine; error?: { code: string; message: string } };
      buffer = buffer.slice(end + 1);
      if (typeof line.digits === "string") onDigits(line.digits);
      if (line.machine) { void reader.cancel(); return line.machine; }
      if (line.error) { void reader.cancel(); throw new ApiError(url, 409, line.error.message, line.error.code); }
    }
  }
}
export const startMachineSetup = (request: SetupRequest) => machineRequest<SetupJob>("/setup", "POST", request);
export const fetchMachineSetup = (id: string) => machineRequest<SetupJob>(`/setup/${encodeURIComponent(id)}`);
export const answerMachineSetup = (id: string, action: SetupAction) => machineRequest<SetupJob>(`/setup/${encodeURIComponent(id)}`, "POST", action);

/** GET /api/voice: whether the server holds a key; the key itself never comes back. */
export async function fetchVoiceStatus(): Promise<VoiceStatus> {
  const response = await apiFetch("/api/voice", { cache: "no-store" });
  if (!response.ok) throw await errorFrom("/api/voice", response);
  return (await response.json()) as VoiceStatus;
}

/** Settings → Alerts → Also send to: the destination this PC also posts its alerts to, its URL or token masked. */
export function fetchAlertWebhook(): Promise<AlertWebhookView> {
  return getJson<AlertWebhookView>("/api/alerts/webhook", { cache: "no-store" });
}

/** ApiError 400 `invalid_webhook` names what is wrong with the destination. */
export async function saveAlertWebhook(save: AlertWebhookSave): Promise<AlertWebhookView> {
  const response = await apiFetch("/api/alerts/webhook", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(save) });
  if (!response.ok) throw await errorFrom("/api/alerts/webhook", response);
  return (await response.json()) as AlertWebhookView;
}

export async function removeAlertWebhook(): Promise<void> {
  const response = await apiFetch("/api/alerts/webhook", { method: "DELETE" });
  if (!response.ok) throw await errorFrom("/api/alerts/webhook", response);
}

/** ApiError 502 `webhook_failed` with what the destination answered. */
export async function testAlertWebhook(): Promise<void> {
  const response = await apiFetch("/api/alerts/webhook/test", { method: "POST" });
  if (!response.ok) throw await errorFrom("/api/alerts/webhook/test", response);
}

/** PUT /api/voice/config: ApiError 409 `key_from_env` when the key comes from OVIS_OPENAI_API_KEY. */
export async function saveVoiceConfig(update: VoiceConfigUpdate): Promise<VoiceStatus> {
  const response = await apiFetch("/api/voice/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(update) });
  if (!response.ok) throw await errorFrom("/api/voice/config", response);
  return (await response.json()) as VoiceStatus;
}
