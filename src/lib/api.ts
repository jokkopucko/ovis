import { apiFetch } from "./api-request-id.ts";
import { CompactAgentsError, expandMachine, type WireMachine } from "../../shared/compact-agents.ts";
import type { PreferencesChange, SharedPreferences } from "../../shared/preferences.ts";
import type { AlertWebhookSave, AlertWebhookView } from "../../shared/alert-webhook.ts";
import type { SeenFinish, SeenPresentation } from "../../shared/seen.ts";
import type { MemoryView } from "../../shared/memory.ts";
import type { AgentCatalogResponse, AgentTabStarted } from "../../shared/agent-catalog.ts";
import type { ConversationSearchResponse } from "../../shared/conversation-search.ts";
import { resumeConnectionTraces } from "./connectionTrace.ts";
import type { PullRequestCheckLog, PullRequestMergeRequest, PullRequestView } from "../../shared/pull-request.ts";
import type { SystemReport } from "../../shared/system.ts";
import type { MovePlanResponse, MoveStartRequest, MoveStopAllOffer, MoveStopAllRequest, MoveStopRequest } from "../../shared/runtime-move.ts";
import type { EditableText, PaneDocuments, TextSaved, TextSaveRequest } from "../../shared/files.ts";
import { parseSystemReport } from "./systemReport.ts";
import { TAILNET_NODE_ROUTES, type TailnetNodesAnswer } from "../../shared/tailnet-nodes.ts";
import { machinePath, type ListAddState, type OwnJoinRequest, type BridgeHealth, type HerdrCoreFacts, type HerdrIdentity, type HerdrRuntimeFacts, type Machine, type MachineRoster, type PcInstallJob, type PcInstallRequest, type PendingKey, type RuntimeName, type SetupAction, type SetupJob, type SetupRequest } from "../../shared/machines.ts";
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
  PaneSummaries,
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
  AcpHold,
} from "../../shared/protocol.ts";
import { SUPPORTED_AGENT_KINDS } from "../../shared/supported-agents.ts";
import type { PaneScrollInfo } from "../../shared/herdr-api.generated.ts";
import { readInstalledNotes, readUpdateNotes, type HerdrUpdateStatus, type InstalledNotes, type UpdateNotes, type UpdateRequest, type UpdateStatus } from "../../shared/update.ts";
import type { AlertPrefs } from "../../shared/notify-policy.ts";
import type { TelemetryChange, TelemetryStatus } from "../../shared/telemetry.ts";
import type { VoiceConfigUpdate, VoiceStatus } from "../../shared/voice.ts";
import { MAX_ATTACHMENT_BYTES } from "../../shared/attachments.ts";
import { uploadableImage } from "./composerImageMime.ts";
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

export function followUsageLogin(request: Extract<UsageLoginRequest, { provider: "claude" | "codex" }>, signal: AbortSignal): Promise<UsageLoginFollowed> {
  return getJson<UsageLoginFollowed>("/api/usage/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...request, follow: true }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
}

export function fetchUsageLoginPrompt(login: string, signal: AbortSignal): Promise<UsageLoginPrompt> {
  return getJson(`/api/usage/login/prompt?login=${encodeURIComponent(login)}`, { signal, cache: "no-store" });
}

export async function sendUsageLoginCode(request: UsageLoginCode): Promise<void> {
  await sendJson("/api/usage/login/code", "POST", request);
}

/** A handoff must see a failure rather than start beside it. */
export async function cancelUsageLogin(login: string): Promise<void> {
  const url = "/api/usage/login/cancel";
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ login }), keepalive: true });
  if (!response.ok) throw await errorFrom(url, response);
}

export function startUsageLogin(request: UsageLoginRequest, signal?: AbortSignal): Promise<UsageLoginStarted> {
  const timeout = AbortSignal.timeout(30_000);
  return getJson<UsageLoginStarted>("/api/usage/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
}

export function fetchRemoteAccess(): Promise<RemoteAccess> {
  return getJson<RemoteAccess>("/api/access");
}

export type TailscaleServed = { ok: true; access: RemoteAccess } | { ok: false; code: string | null; operator: boolean };

/** Has this PC's server run `tailscale serve` for itself (this PC's own window only): the access it then has, or its refusal. */
export async function serveOnTailscale(): Promise<TailscaleServed> {
  const response = await apiFetch("/api/access/tailscale/serve", { method: "POST", headers: { "x-herdr-machine": "1" } });
  if (response.ok) return { ok: true, access: await response.json() as RemoteAccess };
  const body = await response.json().catch(() => null) as { error?: { code?: string; operator?: boolean } } | null;
  return { ok: false, code: body?.error?.code ?? null, operator: body?.error?.operator === true };
}

/** Opens the Tailscale app on this PC (this PC's own window only); false where it has none or it did not open. */
export async function openTailscaleApp(): Promise<boolean> {
  return (await apiFetch("/api/access/tailscale/open", { method: "POST", headers: { "x-herdr-machine": "1" } })).ok;
}

export function fetchUsage(refresh = false): Promise<UsageReport> {
  return getJson<UsageReport>(refresh ? "/api/usage?refresh=1" : "/api/usage");
}

export async function removeUsageAccount(account: string): Promise<void> {
  await sendJson("/api/usage/accounts", "DELETE", { account } satisfies UsageAccountRemoval);
}

export async function restoreUsageAccount(account: string): Promise<void> {
  await sendJson("/api/usage/accounts", "POST", { account } satisfies UsageAccountRemoval);
}

export function fetchStatusline(): Promise<StatuslineState> {
  return getJson<StatuslineState>("/api/usage/statusline", { cache: "no-store" });
}

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

export async function fetchUpdateNotes(): Promise<UpdateNotes> {
  return readUpdateNotes(await getJson<unknown>("/api/updates/notes"));
}

export async function fetchInstalledNotes(): Promise<InstalledNotes> {
  return readInstalledNotes(await getJson<unknown>("/api/updates/installed"));
}

export async function requestUpdate(request: UpdateRequest): Promise<void> {
  const url = `/api/updates/${request.command}`;
  const response = await apiFetch(url, request.command === "install"
    ? { method: "POST", headers: { "x-herdr-update": "1", "content-type": "application/json" }, body: JSON.stringify({ expected_revision: request.expected_revision } satisfies UpdateInstallRequest) }
    : { method: "POST", headers: { "x-herdr-update": "1" } });
  if (!response.ok) throw await errorFrom(url, response);
}

export function fetchHerdrUpdate(): Promise<HerdrUpdateStatus> {
  return getJson<HerdrUpdateStatus>("/api/herdr/update");
}

export async function switchRuntime(runtime: RuntimeName): Promise<void> {
  const url = "/api/runtime";
  const response = await apiFetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify({ runtime }) });
  if (!response.ok) throw await errorFrom(url, response);
}

export function fetchMovePlan(): Promise<MovePlanResponse> {
  return getJson<MovePlanResponse>("/api/runtime/move", { cache: "no-store" });
}

export async function startMove(revision: string): Promise<void> {
  const url = "/api/runtime/move";
  const response = await apiFetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify({ revision } satisfies MoveStartRequest) });
  if (!response.ok) throw await errorFrom(url, response);
}

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

export async function installHerdrCore(): Promise<void> {
  const url = "/api/runtime/move/install";
  const response = await apiFetch(url, { method: "POST", headers: { "x-herdr-update": "1" } });
  if (!response.ok) throw await errorFrom(url, response);
}

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
  /** asked for with `x-ovis-no-account-only`: the account named for the PC as it made this code. Absent from an older server */
  readonly account?: string | null;
}

/**
 * The relay actions answer with the state they left the relay in, a refusal too: a start that
 * serve-only blocks is a 409 whose body is still the RelayStatus, so it is the answer, not an error.
 * Only a body without a phase (the origin gate, a watching device, an older server) is one.
 * A start gives up after 20 s (the server starts the relay at once and answers), so one that never answers does not
 * hold Turn on, or the setup guide's other ways. A stop or a reset may take the server longer, and is waited for.
 */
export async function requestRelay(action: "start" | "stop" | "reset-identity"): Promise<RelayStatus> {
  const url = `/api/relay/${action}`;
  const bounded = new AbortController();
  // kept here too: Safari before 15.4 has no signal.reason
  let gaveUp: DOMException | null = null;
  const timer = action === "start" ? setTimeout(() => { gaveUp = new DOMException(t("No answer"), "TimeoutError"); bounded.abort(gaveUp); }, 20_000) : undefined;
  try {
    const response = await apiFetch(url, { method: "POST", headers: { "x-herdr-update": "1" }, signal: bounded.signal });
    if (!response.ok) {
      const body: unknown = await response.clone().json().catch(() => null);
      if (body !== null && typeof body === "object" && "phase" in body) return body as RelayStatus;
      throw await errorFrom(url, response);
    }
    return (await response.json()) as RelayStatus;
  } catch (error) {
    // a browser may answer the abort with its own words (Safari 14): the deadline's are ours
    throw gaveUp ?? error;
  } finally { clearTimeout(timer); }
}

/** POST /api/relay/direct: whether paired phones may connect straight to this PC on its networks while the relay is on. */
export function requestRelayDirect(on: boolean): Promise<RelayStatus> {
  return getJson<RelayStatus>("/api/relay/direct", { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify({ on }) });
}

/**
 * `noAccountOnly`: the offer is to put this PC in an account (the relay tab's QR code). The PC then makes it only while
 * it is in no account, answers 409 `in_account` once it is in one, and ends the offer's code when it joins one. It
 * makes none before an account is named for it either (409 `no_account_named`; RelayStatus `account_named`).
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
export function requestRelayLink(options: { localOnly?: boolean } = {}): Promise<{ readonly url: string; readonly window_id?: string }> {
  return getJson<{ readonly url: string; readonly window_id?: string }>("/api/relay/link", { method: "POST", headers: { "x-herdr-update": "1", ...(options.localOnly ? { "x-ovis-local-only": "1" } : {}) } });
}

/** POST /api/relay/link/close: end the current pairing window, or only the named generation when supplied. */
export function closeRelayLink(windowId?: string): Promise<{ readonly ok: true }> {
  return getJson<{ readonly ok: true }>("/api/relay/link/close", { method: "POST", headers: { "x-herdr-update": "1", ...(windowId === undefined ? {} : { "x-ovis-window": windowId }) } });
}

/** GET /api/relay/joins: account joins waiting for this PC's own window, without their digits but a first join's (403 `own_window_required` elsewhere). */
export async function fetchOwnJoins(): Promise<OwnJoinRequest[]> {
  return (await getJson<{ readonly joins: OwnJoinRequest[] }>("/api/relay/joins")).joins;
}

/** POST /api/relay/join: the digits the new device shows, typed on this PC's own window; 409 `wrong_digits` ends that join. */
export async function approveOwnJoin(id: string, digits: string): Promise<void> {
  await getJson<{ readonly ok: true }>("/api/relay/join", { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify({ id, digits }) });
}

/**
 * GET /api/account/status: the account whose signed list this PC follows (it names one in `list` only once it is pinned
 * to it), or null for none, and where this browser may not read the PC's account.
 */
export async function fetchListAccount(): Promise<string | null> {
  const response = await apiFetch("/api/account/status", { cache: "no-store" });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null) as { account?: unknown; list?: { pinned_list?: unknown } | null } | null;
  return typeof body?.list?.pinned_list === "string" && typeof body.account === "string" ? body.account : null;
}

/**
 * GET /api/account/status, for why this PC lets nobody of its account in by its signed list: the `reason` of the list it
 * is pinned to, or what a PC that cannot read its own account state says (403 `strict`). Null for none.
 */
export async function fetchListReason(): Promise<string | null> {
  const response = await apiFetch("/api/account/status", { cache: "no-store" });
  const body = await response.json().catch(() => null) as { list?: { reason?: unknown } | null; error?: { code?: unknown; reason?: unknown } } | null;
  const said = response.ok ? body?.list?.reason : body?.error?.code === "strict" ? body.error.reason : null;
  return typeof said === "string" && said !== "" ? said : null;
}

/**
 * GET /api/account/list/add: where an add of this PC by its account's list stands (this PC's own window alone). `run`:
 * the add the caller started; another one in its place is answered `replaced`.
 */
export async function fetchListAdd(run?: string): Promise<ListAddState> {
  return await getJson<ListAddState>(run === undefined ? "/api/account/list/add" : `/api/account/list/add?run=${encodeURIComponent(run)}`, { cache: "no-store" });
}

/**
 * POST /api/account/list/add: a person at this PC starts adding it to `account` by the account's list, or goes on with
 * the add under way for it; `no_list` where the account keeps none (this PC's own window alone).
 */
export async function startListAdd(account: string): Promise<ListAddState> {
  return await getJson<ListAddState>("/api/account/list/add", { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ account }) });
}

/** POST /api/account/list/add/confirm: the person at this PC says the device adding it shows these digits; 409 `wrong_number` confirms nothing. */
export async function confirmListAdd(run: string, digits: string): Promise<void> {
  await postListAdd("/api/account/list/add/confirm", { run, digits });
}

/** POST /api/account/list/add/cancel: the numbers differ, or the person gives the add up; it joins nothing. */
export async function cancelListAdd(run: string): Promise<void> {
  await postListAdd("/api/account/list/add/cancel", { run });
}

async function postListAdd(url: string, body: Record<string, string>): Promise<void> {
  const response = await apiFetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify(body) });
  if (!response.ok) throw await errorFrom(url, response);
}

/** POST /api/relay/join: Allow or Decline of a first join on this PC's own window, its digits compared there. */
export async function decideOwnJoin(id: string, decision: "approve" | "decline"): Promise<void> {
  const url = "/api/relay/join";
  const response = await apiFetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify({ id, decision }) });
  if (!response.ok) throw await errorFrom(url, response);
}

/** POST /api/relay/pairing: the owner's answer to a phone waiting with the same digits (`relay-pairings` events). */
export async function decideRelayPairing(id: string, decision: "approve" | "decline", answer?: string | { proven_server_id: string; pc_label: string }): Promise<void> {
  const url = "/api/relay/pairing";
  // an account member approving through the relay names the digits it picked (docs/account.md, "Who may admit a device")
  const response = await apiFetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify({ id, decision, ...(typeof answer === "string" ? { digits: answer } : answer) }) });
  if (!response.ok) throw await errorFrom(url, response);
}

/** POST /api/account/confirm-page: opens this PC's confirm page on its own desktop (own window only; 409 when it cannot). */
export async function openConfirmPage(): Promise<void> {
  const url = "/api/account/confirm-page";
  const response = await apiFetch(url, { method: "POST", headers: { "x-herdr-machine": "1" } });
  if (!response.ok) throw await errorFrom(url, response);
}

/** Declines one device waiting for this PC's screen (S2-34, T72); the PC answers the list that is left. Approving stays on the screen. */
export async function declinePendingKey(id: string): Promise<readonly PendingKey[]> {
  const url = "/api/devices/pending/decline";
  const response = await apiFetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ id }) });
  if (!response.ok) throw await errorFrom(url, response);
  return ((await response.json()) as { pending: PendingKey[] }).pending;
}

export async function fetchPreferences(): Promise<SharedPreferences | null> {
  try { return await getJson<SharedPreferences>("/api/preferences"); }
  catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
}

export async function savePreferences(body: PreferencesChange, keepalive = false): Promise<SharedPreferences> {
  const url = "/api/preferences";
  const response = await apiFetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive });
  if (!response.ok) throw await errorFrom(url, response);
  return (await response.json()) as SharedPreferences;
}

/**
 * A server that predates it (404) or a watching device (403) keeps the read to this browser; one that
 * predates `presented` ignores it.
 */
export async function shareSeen(finish: SeenFinish, presented?: SeenPresentation): Promise<void> {
  const url = "/api/seen";
  const response = await apiFetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(presented === undefined ? finish : { ...finish, presented }) });
  if (response.ok || response.status === 404 || response.status === 403) return;
  throw await errorFrom(url, response);
}

const telemetryStatusListeners = new Set<(status: TelemetryStatus | null) => void>();

export function onTelemetryStatus(listener: (status: TelemetryStatus | null) => void): () => void {
  telemetryStatusListeners.add(listener);
  return () => { telemetryStatusListeners.delete(listener); };
}

function toldTelemetryStatus<T extends TelemetryStatus | null>(status: T): T {
  for (const listener of telemetryStatusListeners) listener(status);
  return status;
}

export async function fetchTelemetry(): Promise<TelemetryStatus | null> {
  try { return toldTelemetryStatus(await getJson<TelemetryStatus>("/api/telemetry")); }
  catch (error) { if (error instanceof ApiError && error.status === 404) return toldTelemetryStatus(null); throw error; }
}

export async function changeTelemetry(change: TelemetryChange, { keepalive = false }: { keepalive?: boolean } = {}): Promise<TelemetryStatus> {
  const url = "/api/telemetry";
  const response = await apiFetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify(change), ...(keepalive ? { keepalive } : {}) });
  if (!response.ok) throw await errorFrom(url, response);
  return toldTelemetryStatus((await response.json()) as TelemetryStatus);
}

/**
 * `code` is the server's error-envelope code when it sent one, so callers can branch on `status`
 * (401 = the token gate) without parsing the message.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly detail: string;
  readonly retryAfterMs: number | null;
  readonly fromStatusText: boolean;

  constructor(url: string, status: number, detail: string, code: string | null, retryAfterMs: number | null = null, fromStatusText = false) {
    super(`${url} failed (${status}): ${detail}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
    this.fromStatusText = fromStatusText;
  }
}

export const routeMissing = (error: unknown): boolean => error instanceof ApiError && error.status === 404 && error.code === "not_found";

const LOCALIZED_ERRORS: Readonly<Record<string, () => string>> = {
  pc_add_source_bound: () => t("This PC is in an account. Add PCs from your account."),
  pc_add_target_bound: () => t("That PC is in an account. Add it from that account."),
  pc_add_account_unavailable: () => t("Can't add a PC right now. Try again in a moment."),
  remote_response_too_large: () => t("The other PC's answer was larger than this app accepts"),
  remote_response_invalid: () => t("The other PC's answer could not be read"),
};

export async function errorFrom(url: string, response: Response): Promise<ApiError> {
  let detail = response.statusText;
  let fromStatusText = true;
  let code: string | null = null;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.message) { detail = body.error.message; fromStatusText = false; }
    if (body.error?.code) code = body.error.code;
  } catch {
  }
  if (code !== null && Object.hasOwn(LOCALIZED_ERRORS, code)) { detail = LOCALIZED_ERRORS[code]!(); fromStatusText = false; }
  const retryAfter = response.headers.get("retry-after");
  const seconds = retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : null;
  return new ApiError(url, response.status, detail, code, seconds === null ? null : seconds * 1000, fromStatusText);
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, init);
  if (!response.ok) throw await errorFrom(url, response);
  return (await response.json()) as T;
}

export async function fetchSystem(machineId = "local", signal?: AbortSignal): Promise<SystemReport> {
  const report = parseSystemReport(await getJson<unknown>(machinePath(machineId, "system"), { cache: "no-store", ...(signal ? { signal } : {}) }));
  if (report === null) throw new ApiError(machinePath(machineId, "system"), 502, LOCALIZED_ERRORS["remote_response_invalid"]!(), "remote_response_invalid");
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

export type ConversationPageQuery = {
  before?: string; since?: string; from?: string;
  history_id?: string;
  prompts?: number;
  fresh?: boolean;
  signal?: AbortSignal;
};

/**
 * The last answer per newest-page conversation URL and its ETag. The chat reads it again on
 * every transcript push (at most every 2s), every send and status edge, and a 10s backstop
 * (2s without pushes),
 * and a newest page can be megabytes: an unchanged one comes back as a bodyless 304,
 * and the chat gets the very same object back, which tells it nothing changed.
 */
interface ConversationAnswer {
  etag: string;
  body: ConversationResponse;
  bytes: number;
  pane: string;
  session: string | undefined;
}

function paneKey(paneId: string, machineId: string): string {
  return `${machineId}\u0000${paneId}`;
}
const conversationAnswers = new Map<string, ConversationAnswer>();
export const CONVERSATION_ANSWERS_KEPT = 24;
/** …and this much of them: enough for the panes of ten open tabs at the default page size. */
export const CONVERSATION_ANSWERS_BYTES = 64 * 1024 * 1024;
export const CONVERSATION_ANSWER_MAX_BYTES = 8 * 1024 * 1024;
const pinnedConversations = new Set<string>();

/**
 * `String.length` counts UTF-16 code units, which under-reports CJK and emoji by up to three times;
 * a page's cap is bytes.
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
 * The pane, not its URL, is what is pinned: the chat reads its newest page at the page size the
 * setting names, so a pin taken on the URL alone would never match the entry the open pane actually holds.
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

const paneSessions = new Map<string, string>();
const paneCommandScopes = new Map<string, string>();
const movingSessions = new Map<string, { token: string; event: number }>();
let movingEvents = 0;

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

export function paneSessionEvents(): number {
  return movingEvents;
}

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
    const moving = movingSessions.get(machine.id);
    if (moving !== undefined && readAfter !== undefined && readAfter >= moving.event) movingSessions.delete(machine.id);
    const listed = new Set<string>();
    for (const pane of machine.snapshot.panes) {
      const key = paneKey(pane.pane_id, machine.id);
      listed.add(key);
      const session = `${machine.snapshot.herdr_lifetime ?? ""}\u0000${paneSessionKey(pane)}`;
      paneSessions.set(key, session);
      paneCommandScopes.set(key, `${session}\u0000${pane.foreground_cwd ?? pane.cwd ?? ""}`);
    }
    for (const key of paneSessions.keys()) if (key.startsWith(paneKey("", machine.id)) && !listed.has(key)) paneSessions.delete(key);
    for (const key of paneCommandScopes.keys()) if (key.startsWith(paneKey("", machine.id)) && !listed.has(key)) paneCommandScopes.delete(key);
  }
}

export function paneCommandScope(paneId: string, machineId: string): string {
  return paneCommandScopes.get(paneKey(paneId, machineId)) ?? "";
}

export function paneScopesMoving(machineId: string): string | undefined {
  return movingSessions.get(machineId)?.token;
}

export function paneSessionsMoving(machineId: string): void {
  movingEvents += 1;
  movingSessions.set(machineId, { token: `moving:${movingEvents}`, event: movingEvents });
  for (const [url, pressed] of pressReads) if (pressed.pane.startsWith(paneKey("", machineId))) pressReads.delete(url);
}

function currentAnswer(url: string, pane: string): ConversationAnswer | undefined {
  const answer = conversationAnswers.get(url);
  if (answer === undefined || answer.session === sessionNow(pane)) return answer;
  conversationAnswers.delete(url);
  return undefined;
}

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

export function peekPaneConversation(paneId: string, machineId = "local", prompts?: number): ConversationResponse | undefined {
  const answer = conversationAnswers.get(conversationUrl(paneId, machineId, prompts === undefined ? {} : { prompts }));
  return answer?.session === sessionNow(paneKey(paneId, machineId)) ? answer?.body : undefined;
}

interface PressRead { at: number; pane: string; session: string | undefined; controller: AbortController; read: Promise<ConversationResponse>; answer?: ConversationResponse }
const pressReads = new Map<string, PressRead>();
export const PRESS_READ_MS = 1000;
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
  const cached = currentAnswer(url, pane)?.body;
  const historyId = cached?.source === "scrollback" ? undefined : cached?.history_id;
  const controller = new AbortController();
  const pressed: PressRead = { controller, at: performance.now(), pane, session: sessionNow(pane), read: fetchPaneConversation(paneId, machineId, { prompts, history_id: historyId, fresh: true, signal: controller.signal }) };
  pressed.read.then((answer) => { pressed.answer = answer; }, () => { if (pressReads.get(url) === pressed) pressReads.delete(url); });
  pressReads.set(url, pressed);
  setTimeout(() => { if (pressReads.get(url) === pressed) pressReads.delete(url); }, PRESS_READ_MS);
}

export async function searchPaneConversation(paneId: string, query: string, machineId = "local", page: { before?: string; historyId?: string; signal?: AbortSignal } = {}): Promise<ConversationSearchResponse> {
  const params = new URLSearchParams({ pane_id: paneId, q: query });
  if (page.before !== undefined) params.set("before", page.before);
  if (page.historyId !== undefined) params.set("history_id", page.historyId);
  return getJson<ConversationSearchResponse>(machinePath(machineId, `pane/conversation/search?${params.toString()}`), page.signal ? { signal: page.signal } : undefined);
}

export async function fetchPaneConversation(paneId: string, machineId = "local", page: ConversationPageQuery = {}): Promise<ConversationResponse> {
  return readPaneConversation(paneId, machineId, page, false);
}

async function readPaneConversation(paneId: string, machineId: string, page: ConversationPageQuery, retried: boolean): Promise<ConversationResponse> {
  if (page.signal?.aborted) throw page.signal.reason ?? new DOMException("The read was cancelled.", "AbortError");
  const url = conversationUrl(paneId, machineId, page);
  const pane = paneKey(paneId, machineId);
  const session = sessionNow(pane);
  const polled = page.before === undefined;
  const pressed = polled ? pressReads.get(url) : undefined;
  if (pressed !== undefined) {
    pressReads.delete(url);
    if (performance.now() - pressed.at < PRESS_READ_MS && pressed.session === session && namesSession(session)) {
      if (pressed.answer !== undefined) return { ...pressed.answer };
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
  const plain = polled && page.from !== undefined ? conversationUrl(paneId, machineId, page.prompts === undefined ? {} : { prompts: page.prompts }) : undefined;
  const read = ++newestReads;
  if (polled) lastNewestRead.set(url, read);
  if (plain !== undefined) lastNewestRead.set(plain, read);
  const known = polled ? currentAnswer(url, pane) : undefined;
  const requestUrl = page.history_id === undefined ? url : `${url}&history_id=${encodeURIComponent(page.history_id)}`;
  const { response, body } = await withChatReadDeadline(async (signal) => {
    const response = await apiFetch(requestUrl, { cache: "no-store", signal, ...(known && !page.fresh ? { headers: { "if-none-match": known.etag } } : {}) });
    const received = performance.now(), receivedWall = Date.now();
    if (response.status === 304 && known) {
      observeWaitingClock(waitingKey(machineId, paneId), response.headers.get("x-server-time"), received, receivedWall, true);
      return { response, body: known.body };
    }
    if (!response.ok) throw await errorFrom(url, response);
    const body = (await response.json()) as ConversationResponse;
    observeWaitingClock(waitingKey(machineId, paneId), response.headers.get("x-server-time") ?? body.server_time, received, receivedWall);
    return { response, body };
  }, chatReadDeadlineMs(machineId), page.signal).catch((cause: unknown) => {
    if (polled && lastNewestRead.get(url) === read) lastNewestRead.delete(url);
    if (plain !== undefined && lastNewestRead.get(plain) === read) lastNewestRead.delete(plain);
    if (cause instanceof ApiError && cause.status === 409 && sessionNow(pane) === session) {
      for (const [cached, answer] of conversationAnswers) if (cached === url || answer.pane === pane) conversationAnswers.delete(cached);
    }
    throw cause;
  });
  const ownsPlain = plain !== undefined && lastNewestRead.get(plain) === read;
  if (ownsPlain) lastNewestRead.delete(plain);
  const ownsUrl = polled && lastNewestRead.get(url) === read;
  if (ownsUrl) lastNewestRead.delete(url);
  if (page.signal?.aborted) throw page.signal.reason ?? new DOMException("The read was cancelled.", "AbortError");
  if (sessionNow(pane) !== session) return polled && !retried ? readPaneConversation(paneId, machineId, { prompts: page.prompts, fresh: true, signal: page.signal }, true) : body;
  if (polled && !ownsUrl) return body;
  if (response.status === 304 && known) {
    conversationAnswers.delete(url);
    conversationAnswers.set(url, known);
    return body;
  }
  const etag = response.headers.get("etag");
  if (!polled || body.recovery === "waiting") return body;
  conversationAnswers.delete(url);
  if (etag !== null) {
    const bytes = conversationAnswerBytes(body, response.headers.get("content-length"), response.headers.get("content-encoding"));
    if (bytes <= CONVERSATION_ANSWER_MAX_BYTES) {
      const answer = { etag, body, bytes, pane, session };
      conversationAnswers.set(url, answer);
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
  /** this Ovis server's version (`0.5.3`), authenticated only; absent from an older server */
  version?: string;
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

/** POST /api/devices/joins/seen: a join this window showed is seen, for every window of the PC (`device-paired-seen`). */
export async function markJoinSeen(eventId: string): Promise<void> {
  await sendJson("/api/devices/joins/seen", "POST", { event_id: eventId });
}

/** GET /api/devices/tailnet-nodes: the tailnet nodes of the owner's login this PC has seen, and the one waiting on the card (this PC's own window only). */
export function fetchTailnetNodes(): Promise<TailnetNodesAnswer> {
  return getJson<TailnetNodesAnswer>(TAILNET_NODE_ROUTES.list);
}

/** POST /api/devices/tailnet-nodes/block: these nodes get nothing by the owner's Tailscale login until Allow. */
export async function blockTailnetNodes(ids: readonly string[]): Promise<TailnetNodesAnswer> {
  return (await sendJson(TAILNET_NODE_ROUTES.block, "POST", { ids })).json();
}

/** POST /api/devices/tailnet-nodes/answer: Allow or Decline of the blocked node on the card; refused while the PC is locked. */
export async function answerTailnetNode(id: string, decision: "allow" | "decline"): Promise<void> {
  await sendJson(TAILNET_NODE_ROUTES.answer, "POST", { id, decision });
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

const megabytes = (bytes: number): string => `${Math.ceil((bytes / (1024 * 1024)) * 10) / 10} MB`;

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

export function assertAttachable(file: Blob): void {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentTooLargeError(file instanceof File && file.name ? file.name : file.type || "file", file.size);
}

/** Any file: an image is stored as a paste, anything else under its own (sanitised) name. */
export async function uploadPaneImage(paneId: string, file: Blob, machineId = "local"): Promise<string> {
  assertAttachable(file);
  const image = await uploadableImage(file);
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

export async function fetchPluginActions(machineId = "local"): Promise<PluginActions[]> {
  return (await getJson<PluginActionsResponse>(machinePath(machineId, "plugins/actions"))).plugins;
}

export async function runPluginAction(request: PluginActionRequest, machineId = "local"): Promise<PluginActionResult> {
  const response = await sendJson(machinePath(machineId, "plugin/action"), "POST", request);
  return (await response.json()) as PluginActionResult;
}

export async function fetchPluginActionStatus(pluginId: string, logId: string, machineId = "local"): Promise<PluginActionResult> {
  return getJson<PluginActionResult>(machinePath(machineId, `plugin/action?plugin_id=${encodeURIComponent(pluginId)}&log_id=${encodeURIComponent(logId)}`));
}

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

export interface PaneTextPoint { row: number; col: number }

export async function fetchPaneSelection(paneId: string, anchor: PaneTextPoint, cursor: PaneTextPoint, machineId = "local"): Promise<string> {
  const query = new URLSearchParams({
    pane_id: paneId,
    anchor_row: String(anchor.row), anchor_col: String(anchor.col),
    cursor_row: String(cursor.row), cursor_col: String(cursor.col),
  });
  return (await getJson<{ text: string }>(machinePath(machineId, `pane/selection?${query.toString()}`))).text;
}

export async function closePane(paneId: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "pane/close"), "POST", { pane_id: paneId });
}

/** POST /api/pane/focus: herdr brings this pane and its tab/workspace to the front. */
export async function focusPane(paneId: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "pane/focus"), "POST", { pane_id: paneId } satisfies FocusPaneRequest);
}

/** POST /api/pane/turn/cancel: a person's Stop on an ACP child. Its turn is cancelled and the agent that started it gets no new turn until it is handed back. */
export async function holdAcpChild(paneId: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "pane/turn/cancel"), "POST", { pane_id: paneId });
}

/** POST /api/pane/turn/release: hands a stopped ACP child back, for the hold its pane reports (HerdrPane `acp_hold`). */
export async function releaseAcpChild(paneId: string, hold: AcpHold, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "pane/turn/release"), "POST", { pane_id: paneId, ...hold });
}

/** POST /api/pane/turn/cancel-children: the same Stop on every ACP child the pane started; `failed` names the panes that did not take it. */
export async function holdAcpChildren(paneId: string, machineId = "local"): Promise<{ failed: string[] }> {
  const answer = await (await sendJson(machinePath(machineId, "pane/turn/cancel-children"), "POST", { pane_id: paneId })).json() as { failed?: unknown };
  return { failed: Array.isArray(answer.failed) ? answer.failed.filter((pane): pane is string => typeof pane === "string") : [] };
}

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

export async function zoomPane(paneId: string, mode: ZoomPaneRequest["mode"] = "toggle", machineId = "local"): Promise<PaneZoomed> {
  const response = await sendJson(machinePath(machineId, "pane/zoom"), "POST", { pane_id: paneId, mode } satisfies ZoomPaneRequest);
  return (await response.json()) as PaneZoomed;
}

export async function swapPane(paneId: string, direction: PaneDirection, machineId = "local"): Promise<PaneSwapped> {
  const response = await sendJson(machinePath(machineId, "pane/swap"), "POST", { pane_id: paneId, direction } satisfies SwapPaneRequest);
  return (await response.json()) as PaneSwapped;
}

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

export async function setSplitRatio(tabId: string, path: boolean[], ratio: number, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "layout/ratio"), "POST", { tab_id: tabId, path, ratio } satisfies SetSplitRatioRequest);
}

/** POST /api/pane/resize: the border the pane shares with a neighbour moves that way, by herdr's default share (0.05) of the split the border belongs to. */
export async function resizePane(paneId: string, direction: PaneDirection, machineId = "local"): Promise<PaneResized> {
  const response = await sendJson(machinePath(machineId, "pane/resize"), "POST", { pane_id: paneId, direction } satisfies ResizePaneRequest);
  return (await response.json()) as PaneResized;
}

export async function clearPane(paneId: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "pane/clear"), "POST", { pane_id: paneId });
}

export async function fetchAgentKinds(machineId = "local"): Promise<AgentKind[]> {
  // filtered here, not on the server: a remote PC's older bridge still answers every manifest,
  // and says nothing of what is installed, so its supported kinds are all offered
  return (await getJson<{ agents: AgentKind[] }>(machinePath(machineId, "agents"))).agents.filter((agent) => SUPPORTED_AGENT_KINDS.has(agent.kind) && agent.installed !== false);
}

export async function fetchAgentCatalog(machineId = "local", signal?: AbortSignal, recheck = false): Promise<AgentCatalogResponse> {
  const bounded = new AbortController();
  const end = () => bounded.abort();
  const timer = setTimeout(end, 30_000);
  if (signal?.aborted) end();
  else signal?.addEventListener("abort", end, { once: true });
  try {
    return await getJson<AgentCatalogResponse>(`${machinePath(machineId, "agent-catalog")}${recheck ? "?recheck=1" : ""}`, { signal: bounded.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", end);
  }
}

export async function startAgentInstall(agent: string, machineId = "local", alternative?: number): Promise<AgentTabStarted> {
  const response = await sendJson(machinePath(machineId, "agent-catalog/install"), "POST", alternative === undefined ? { agent } : { agent, alternative });
  return (await response.json()) as AgentTabStarted;
}

export async function startAgentSignIn(agent: string, machineId = "local"): Promise<AgentTabStarted> {
  return (await (await sendJson(machinePath(machineId, "agent-catalog/sign-in"), "POST", { agent })).json()) as AgentTabStarted;
}

export async function fetchIntegrations(machineId = "local"): Promise<IntegrationsResponse["integrations"]> {
  return (await getJson<IntegrationsResponse>(machinePath(machineId, "integrations"))).integrations;
}

export async function fetchDirectories(path: string, hidden: boolean, machineId = "local", files = false, paneId: string | null = null): Promise<DirectoryListing> {
  const query = new URLSearchParams({ path, ...(hidden ? { hidden: "1" } : {}), ...(files ? { files: "1" } : {}), ...(paneId ? { pane_id: paneId } : {}) });
  return getJson<DirectoryListing>(machinePath(machineId, `workspace/directories?${query.toString()}`));
}

export async function createDirectory(path: string, name: string, machineId = "local"): Promise<DirectoryCreated> {
  const response = await sendJson(machinePath(machineId, "workspace/directories"), "POST", { path, name });
  return (await response.json()) as DirectoryCreated;
}

function fileQuery(path: string, paneId: string | null): string {
  return new URLSearchParams({ path, ...(paneId ? { pane_id: paneId } : {}) }).toString();
}

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

export async function fetchEditableText(path: string, paneId: string, machineId = "local"): Promise<EditableText> {
  return getJson<EditableText>(machinePath(machineId, `fs/text?${fileQuery(path, paneId)}`), { cache: "no-store" });
}

export async function saveEditableText(request: TextSaveRequest, machineId = "local"): Promise<TextSaved> {
  return (await (await sendJson(machinePath(machineId, "fs/text"), "PUT", request)).json()) as TextSaved;
}

export async function fetchProjectFavicon(root: string, machineId = "local"): Promise<FileInfo | null> {
  return (await getJson<ProjectFavicon>(projectFaviconUrl(root, machineId))).icon;
}

export function projectFaviconUrl(root: string, machineId = "local"): string {
  return machinePath(machineId, `fs/favicon?${new URLSearchParams({ root }).toString()}`);
}

export function fileUrl(path: string, paneId: string | null, machineId = "local", download = false): string {
  return machinePath(machineId, `fs/file?${fileQuery(path, paneId)}${download ? "&download=1" : ""}`);
}

export interface RepoDiffQuery {
  paneId: string | null;
  directory: string | null;
  scope: RepoDiffScope;
  base: string | null;
  head: string | null;
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

export async function fetchRepoDiffRefs(query: Pick<RepoDiffQuery, "paneId" | "directory">, machineId = "local"): Promise<RepoDiffRefs> {
  const params = new URLSearchParams({ ...(query.paneId ? { pane_id: query.paneId } : {}), ...(query.directory ? { directory: query.directory } : {}) });
  return getJson<RepoDiffRefs>(machinePath(machineId, `workspace/diff/refs?${params.toString()}`));
}

export async function fetchRepoDiffFiles(query: RepoDiffQuery, machineId = "local"): Promise<RepoDiffFileList> {
  return getJson<RepoDiffFileList>(machinePath(machineId, `workspace/diff/files?${repoDiffQuery(query).toString()}`));
}

export async function fetchRepoDiffFile(query: RepoDiffQuery, path: string, oldPath: string | null, machineId = "local"): Promise<RepoDiffFilePatch> {
  const params = repoDiffQuery(query);
  params.set("path", path);
  if (oldPath !== null) params.set("old_path", oldPath);
  return getJson<RepoDiffFilePatch>(machinePath(machineId, `workspace/diff/file?${params.toString()}`));
}

export interface PullRequestTarget { paneId: string | null; directory: string | null }

function pullRequestParams(target: PullRequestTarget): URLSearchParams {
  return new URLSearchParams({ ...(target.paneId ? { pane_id: target.paneId } : {}), ...(target.directory ? { directory: target.directory } : {}) });
}

export async function fetchPullRequest(target: PullRequestTarget, machineId = "local"): Promise<PullRequestView> {
  return getJson<PullRequestView>(machinePath(machineId, `workspace/pr?${pullRequestParams(target).toString()}`));
}

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

export async function createWorktree(request: CreateWorktreeRequest, machineId = "local"): Promise<WorktreeOpened> {
  const response = await sendJson(machinePath(machineId, "worktree/create"), "POST", request);
  return (await response.json()) as WorktreeOpened;
}

export function listWorktrees(workspaceId: string, machineId = "local"): Promise<WorktreeListing> {
  return getJson<WorktreeListing>(`${machinePath(machineId, "worktree/list")}?workspace_id=${encodeURIComponent(workspaceId)}`);
}

export function readWorktreeInventory(workspaceIds: readonly string[], machineId = "local"): Promise<WorktreeInventory> {
  return getJson<WorktreeInventory>(`${machinePath(machineId, "worktree/inventory")}?${workspaceIds.map((id) => `workspace_id=${encodeURIComponent(id)}`).join("&")}`);
}

export async function openWorktree(request: OpenWorktreeRequest, machineId = "local"): Promise<WorktreeOpened> {
  const response = await sendJson(machinePath(machineId, "worktree/open"), "POST", request);
  return (await response.json()) as WorktreeOpened;
}

export function fetchSessionHistory(workspaceId: string, agent: SessionHistoryAgent, machineId = "local", paneId: string | null = null): Promise<SessionHistoryResponse> {
  const query = new URLSearchParams({ workspace_id: workspaceId, agent, ...(paneId === null ? {} : { pane_id: paneId }) });
  return getJson<SessionHistoryResponse>(`${machinePath(machineId, "sessions/history")}?${query.toString()}`, { cache: "no-store" });
}
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
export async function createTab(request: CreateTabRequest, machineId = "local"): Promise<TabCreated> {
  const response = await sendJson(machinePath(machineId, "tab/create"), "POST", request);
  return (await response.json()) as TabCreated;
}

export async function renameTab(tabId: string, label: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "tab/rename"), "POST", { tab_id: tabId, label });
}

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

export async function moveWorkspace(workspaceId: string, insertIndex: number, machineId = "local"): Promise<WorkspaceMoved> {
  const response = await sendJson(machinePath(machineId, "workspace/move"), "POST", { workspace_id: workspaceId, insert_index: insertIndex });
  return (await response.json().catch(() => ({ ok: true }))) as WorkspaceMoved;
}

/** closeGroup takes the repository's open worktree workspaces with it; herdr refuses to close over them otherwise. */
export async function closeWorkspace(workspaceId: string, machineId = "local", closeGroup = false): Promise<void> {
  await sendJson(machinePath(machineId, "workspace/close"), "POST", { workspace_id: workspaceId, ...(closeGroup ? { close_group: true } : {}) });
}

export async function removeWorktree(request: RemoveWorktreeRequest, machineId = "local"): Promise<WorktreeRemoved> {
  const response = await sendJson(machinePath(machineId, "worktree/remove"), "POST", request);
  return (await response.json()) as WorktreeRemoved;
}

export async function fetchPaneCommands(paneId: string, machineId = "local"): Promise<SlashCommand[]> {
  // a read that never answers would be shared by every later caller for good: it fails at a deadline instead,
  // past the 45 s the server waits for a scan before it answers 503 (server/commands.ts COMMANDS_WAIT_MS)
  return (await withChatReadDeadline((signal) => getJson<{ commands: SlashCommand[] }>(machinePath(machineId, `pane/commands?pane_id=${encodeURIComponent(paneId)}`), { signal }), 4 * chatReadDeadlineMs(machineId))).commands;
}

export async function fetchAgentCommands(agent: string, cwd: string | null, machineId = "local"): Promise<SlashCommand[]> {
  const query = new URLSearchParams({ agent, ...(cwd === null || cwd.trim() === "" ? {} : { cwd }) });
  return (await getJson<{ commands: SlashCommand[] }>(`${machinePath(machineId, "agent/commands")}?${query.toString()}`)).commands;
}

export async function fetchPaneOmoActivity(paneId: string, machineId = "local"): Promise<{ tasks: OmoActivity["tasks"]; runs: OmoActivity["runs"]; serverTime: string | null; moreRunning: number }> {
  const activity = await getJson<Partial<OmoActivity>>(machinePath(machineId, `pane/omo-tasks?pane_id=${encodeURIComponent(paneId)}`));
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

export async function fetchPaneArtifacts(paneId: string, machineId = "local"): Promise<ClaudeArtifact[]> {
  return (await getJson<{ artifacts: ClaudeArtifact[] }>(machinePath(machineId, `pane/artifacts?pane_id=${encodeURIComponent(paneId)}`))).artifacts;
}

export async function fetchPaneBtw(paneId: string, machineId = "local", signal?: AbortSignal): Promise<OmpBtwHistory> {
  const answer = await getJson<Partial<OmpBtwHistory>>(machinePath(machineId, `pane/btw?pane_id=${encodeURIComponent(paneId)}`), { signal });
  return { topics: answer.topics ?? [], more: answer.more === true };
}

export async function fetchPanePlan(paneId: string, machineId = "local"): Promise<{ steps: PlanStep[] | null; serverTime: string | null }> {
  const answer = await getJson<Partial<PanePlan>>(machinePath(machineId, `pane/plan?pane_id=${encodeURIComponent(paneId)}`));
  return { steps: answer.plan?.steps ?? null, serverTime: answer.server_time ?? null };
}

export async function fetchPaneFiles(paneId: string, query: string, limit = 20, machineId = "local"): Promise<string[]> {
  const params = new URLSearchParams({ pane_id: paneId, q: query, limit: String(limit) });
  return (await getJson<{ files: string[] }>(machinePath(machineId, `pane/files?${params.toString()}`))).files;
}

export async function fetchPaneDocuments(paneId: string, machineId = "local", signal?: AbortSignal): Promise<PaneDocuments> {
  return getJson<PaneDocuments>(machinePath(machineId, `pane/docs?pane_id=${encodeURIComponent(paneId)}`), { signal });
}

export async function fetchPanePrompt(paneId: string, machineId = "local"): Promise<InteractivePrompt | null> {
  return (await fetchPanePromptState(paneId, machineId)).prompt;
}

export async function fetchPanePromptState(paneId: string, machineId = "local"): Promise<{ prompt: InteractivePrompt | null; suggestion: string | null; restored: string | null; outcomes: CommandOutcome[] }> {
  const body = await getJson<PanePromptResponse>(machinePath(machineId, `pane/prompt?pane_id=${encodeURIComponent(paneId)}`));
  return {
    prompt: body.prompt,
    suggestion: typeof body.suggestion === "string" && body.suggestion !== "" ? body.suggestion : null,
    restored: typeof body.restored === "string" && body.restored !== "" ? body.restored : null,
    outcomes: Array.isArray(body.outcomes) ? body.outcomes : [],
  };
}

/** How long a summary request may take: the PC answers within PANE_SUMMARY_DEADLINE_MS, the rest is the way there and back. */
export const SUMMARY_REQUEST_MS = 8_000;

export async function fetchPaneSummaries(machineId: string, paneIds: readonly string[]): Promise<PaneSummaries | null> {
  const query = new URLSearchParams(paneIds.map((paneId) => ["pane_id", paneId]));
  const bounded = new AbortController();
  const timer = setTimeout(() => bounded.abort(), SUMMARY_REQUEST_MS);
  try { return await getJson<PaneSummaries>(machinePath(machineId, `pane/summary?${query.toString()}`), { signal: bounded.signal }); }
  catch (error) {
    if (!routeMissing(error)) throw error;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function answerPanePrompt(answer: PromptAnswer, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "pane/prompt/answer"), "POST", answer);
}

/** GET /api/push: the server's VAPID key, the `applicationServerKey` this device subscribes with. */
export async function fetchPushKey(): Promise<string> {
  return (await getJson<PushKey>("/api/push")).public_key;
}

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
export async function fetchMachines(signal?: AbortSignal, full = false): Promise<Machine[]> {
  const response = await apiFetch(full ? "/api/machines" : "/api/machines?compact_agents=1", { signal });
  if (!response.ok) throw await errorFrom("/api/machines", response);
  if (full) return ((await response.json()) as { machines: Machine[] }).machines;
  const { machines } = (await response.json()) as { machines: WireMachine[] };
  try { return machines.map(expandMachine); } catch (error) {
    if (error instanceof CompactAgentsError) return fetchMachines(signal, true);
    throw error;
  }
}
/**
 * GET /api/machines?verify_source_boot: the roster, and the boot id of the server behind `machineId`
 * proved during this very request (shared/protocol.ts). Null when the server proves nothing: a
 * refusal, or an older server that ignored the query.
 */
export async function verifySourceBoot(machineId: string, signal: AbortSignal): Promise<{ machines: Machine[]; boot_id: string } | null> {
  const path = `/api/machines?verify_source_boot=${encodeURIComponent(machineId)}`;
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
/**
 * Asks the server to try a PC it is waiting to reconnect now: any read of a PC it has no connection to does
 * (machine-api.ts `retryNow`), and only then; it leaves a connected PC and one a setup holds alone. The answer is
 * that PC's roster or `machine_offline`, both expected; what the try finds arrives as the PC's next state.
 */
export async function askMachineRetry(id: string): Promise<void> {
  const url = `/api/machines/${encodeURIComponent(id)}/session`;
  const response = await apiFetch(url);
  if (!response.ok && response.status !== 503) throw await errorFrom(url, response);
  await response.body?.cancel();
}
export interface SshCandidate {
  readonly name: string; readonly destination: string; readonly detail: string | null; readonly source: "ssh_config" | "tailscale";
  readonly tailnet?: string;
  /** the User the config sets (absent: none, so ssh uses the server account's name; null: a Match may set one) and its Port */
  readonly user?: string | null; readonly port?: number;
}
export const findSshCandidates = () => machineRequest<{ pcs: SshCandidate[] }>("/ssh-candidates");
/**
 * A PC of this PC's Tailscale login whose Ovis lets this PC in as its owner (server/tailnet-pcs.ts); `outdated`: older
 * than 0.5; `server_id`: the relay ID that PC names itself (absent from an older server), for display only.
 */
export interface TailnetPc { readonly name: string; readonly url: string; readonly relay: string | null; readonly outdated: boolean; readonly server_id?: string | null }
export const findTailnetPcs = () => machineRequest<{ pcs: TailnetPc[] }>("/tailnet");
/** POST /api/machines/address: pairs with another PC's Ovis at that https address by the six-digit code it shows, and adds it. */
export const addAddressPc = (address: string, code: string) => machineRequest<{ machine: Machine }>("/address", "POST", { address, code });
/** Another PC of the account as the page read it from the account's directory: its key checked against its id here too. */
export interface AccountPcEntry { readonly server_id: string; readonly server_public_key: string; readonly relay: string; readonly name: string }
/** `offline`: the relay said no PC answered; `unreachable`: anything else kept its answer away (server/relay-pc.ts VouchedSupport). */
export type AccountPcState = "ready" | "outdated" | "offline" | "unreachable";
export const checkAccountPcs = (pcs: readonly AccountPcEntry[]) => machineRequest<{ pcs: { server_id: string; state: AccountPcState }[] }>("/relay/account/check", "POST", { pcs });
/** POST /api/machines/relay/account/start: the key this PC would hold for that PC, for the admission to name; ApiError `account_pc_outdated` for an older one. */
export const startAccountPc = (pc: AccountPcEntry) => machineRequest<{ ticket: string; key: string; label: string }>("/relay/account/start", "POST", { pc });
/**
 * POST /api/machines/relay/account/pair: asks that PC through the relay, `onWaiting` told once that PC took the request
 * and waits for a member of the account to approve it on another device, and resolves with the PC once one did. Aborting
 * `signal` cancels it on this PC's server too. ApiError `account_pc_<failure>` otherwise.
 */
export async function pairAccountPc(ticket: string, onWaiting: () => void, signal: AbortSignal): Promise<Machine> {
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
      const line = JSON.parse(buffer.slice(0, end)) as { waiting?: true; machine?: Machine; error?: { code: string; message: string } };
      buffer = buffer.slice(end + 1);
      if (line.waiting === true) onWaiting();
      if (line.machine) { void reader.cancel(); return line.machine; }
      if (line.error) { void reader.cancel(); throw new ApiError(url, 409, line.error.message, line.error.code); }
    }
  }
}
export const startMachineSetup = (request: SetupRequest) => machineRequest<SetupJob>("/setup", "POST", request);
export const fetchMachineSetup = (id: string) => machineRequest<SetupJob>(`/setup/${encodeURIComponent(id)}`);
export const answerMachineSetup = (id: string, action: SetupAction) => machineRequest<SetupJob>(`/setup/${encodeURIComponent(id)}`, "POST", action);
/** Ovis installed on a PC over SSH with the official installer, pinned to this app's release (PcInstallJob) */
export const startPcInstall = (request: PcInstallRequest) => machineRequest<PcInstallJob>("/install", "POST", request);
export const fetchPcInstall = (id: string) => machineRequest<PcInstallJob>(`/install/${encodeURIComponent(id)}`);

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

export async function saveAlertWebhook(save: AlertWebhookSave): Promise<AlertWebhookView> {
  const response = await apiFetch("/api/alerts/webhook", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(save) });
  if (!response.ok) throw await errorFrom("/api/alerts/webhook", response);
  return (await response.json()) as AlertWebhookView;
}

export async function removeAlertWebhook(): Promise<void> {
  const response = await apiFetch("/api/alerts/webhook", { method: "DELETE" });
  if (!response.ok) throw await errorFrom("/api/alerts/webhook", response);
}

export async function testAlertWebhook(): Promise<void> {
  const response = await apiFetch("/api/alerts/webhook/test", { method: "POST" });
  if (!response.ok) throw await errorFrom("/api/alerts/webhook/test", response);
}

/** Settings → Memory (server/memory/routes.ts): the notes, and a person's change to them */
export function fetchMemory(folder: string | null): Promise<MemoryView> {
  return getJson<MemoryView>(folder === null ? "/api/memory" : `/api/memory?${new URLSearchParams({ folder }).toString()}`, { cache: "no-store" });
}

export async function memoryRequest<T>(action: "add" | "edit" | "confirm" | "remove" | "discard" | "discard-run", body: unknown): Promise<T> {
  return (await (await sendJson(`/api/memory/${action}`, "POST", body)).json()) as T;
}

/** PUT /api/voice/config: ApiError 409 `key_from_env` when the key comes from OVIS_OPENAI_API_KEY. */
export async function saveVoiceConfig(update: VoiceConfigUpdate): Promise<VoiceStatus> {
  const response = await apiFetch("/api/voice/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(update) });
  if (!response.ok) throw await errorFrom("/api/voice/config", response);
  return (await response.json()) as VoiceStatus;
}
