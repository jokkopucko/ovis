import { machineFailure, machineHealth, machineLayoutReason, machineReadError, machineRoster, machineRouteRestricted, machineTcpAnswer, machineUnauthorized } from "./machine-profile.ts";
import { handleWorkspaceRequest } from "./workspace-routes.ts";
import { handleAlertWebhookRequest } from "./alert-webhook.ts";
import { connectionData, type createCore, type SocketData } from "./core/index.ts";
import type { ClientConnectionLog } from "./client-connection-log.ts";
import type { RequestLog } from "./request-log.ts";
import { handlePaneRequest } from "./pane-routes.ts";
import { handleIntegrationsRequest } from "./integrations-routes.ts";
import type { OrderSequence } from "./order-sequence.ts";
import type { HealthAuth, ObservedIngress, SecuritySummary, SessionSnapshot } from "../shared/protocol.ts";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import type { Machine } from "../shared/machines.ts";
import { authClient, deviceAuthorizationValue, deviceCookieValue, bearerMatches, handleAuthRequest, isAuthenticated, isSecureRequest, parseCookies, presentedToken, presentedTokenHeld, recordPresentedTokenFailure, requiresAuth, unauthorizedJson } from "./auth.ts";
import { bindScope, cameThroughProxy, decideAccess, decideMachineAccess, forwardingHeaders, inTailnet, isLoopbackAddress, isServeOwnerRequest, lanExposed, machineForwardingHeaders, observedIngress, ownerAccess } from "./access.ts";
import { type DeviceStore, handleDeviceRequest, newStreamKey, streamCookie, streamKeys, type DeviceMatch } from "./devices.ts";
import { handlePreferencesRequest, type PreferenceStore } from "./preferences.ts";
import { handleSeenRequest, type SeenStore } from "./seen.ts";
import { openTailscaleApp, remoteAccess, serveTailscale, tailscaleBinary, type TailnetNode } from "./tailscale.ts";
import { handleTailnetNodeRequest, tailnetNodeGate, type TailnetNodes } from "./tailnet-nodes.ts";
import { TAILSCALE_CONTROLS } from "./dispatch-routes.ts";
import { badRequest, errorResponse, jsonResponse, readJsonObject, setRequestRoute, wordedHeaders, wordHerdrFailures } from "./http.ts";
import { requestOrigin, serveStatic } from "./static.ts";
import { compressResponse } from "./compress.ts";
import { handleTasksRequest } from "./tasks-routes.ts";
import { handlePlanRequest } from "./plan-routes.ts";
import { handleArtifactsRequest } from "./claude-artifacts.ts";
import { handleBtwRequest } from "./omp-btw.ts";
import { paneTranscript } from "./conversation.ts";
import { ConversationUnavailable } from "./conversation-shared.ts";
import type { ShellAgentLocator } from "./shell-agent.ts";
import { handleAgentsRequest } from "./agents-routes.ts";
import type { AgentDetector } from "./agent-catalog-detect.ts";
import { handleAgentCatalogRequest } from "./agent-catalog-routes.ts";
import { type AgentInstaller, INSTALL_PATH, SIGN_IN_PATH } from "./agent-catalog-install.ts";
import { forgetPageMedia } from "./file-view.ts";
import { textEditAllowed } from "./file-edit.ts";
import { handleFileRequest } from "./file-routes.ts";
import { BACKGROUND_AGENT_PATH, handleBackgroundAgentRequest } from "./background-agent.ts";
import { paneGet, ping } from "./herdr/client.ts";
import { version } from "../package.json";
import { RUNTIME_MOVE_PATH, RUNTIME_MOVE_ROUTE } from "./runtime-move.ts";
import type { StopRefusal } from "./runtime-move-service.ts";
import type { MoveService } from "./runtime-move-service.ts";
import { handlePushRequest } from "./push.ts";
import { handlePromptRequest, type OpenCodePromptState } from "./prompt.ts";
import type { ApprovalHub } from "./approvals/hub.ts";
import type { AcpChildren } from "./acp/children.ts";
import { attachableIdentity } from "./pty/sidecar.ts";
import { runtime } from "./herdr-core/runtime.ts";
import { handleUpdateRequest, updateRequestAllowed } from "./update-api.ts";
import { handleHerdrUpdateRequest } from "./herdr-update.ts";
import { handlePortalRequest } from "./portal.ts";
import { handleRelayRequest } from "./relay/routes.ts";
import type { LocalConfirms } from "./account/local-confirm.ts";
import type { RecoveryReleases } from "./account/recovery.ts";
import type { PendingRedemption, PendingRedemptions } from "./account/pending.ts";
import type { KeyProofPairings } from "./account/key-proof.ts";
import { handlePendingRequest } from "./account/pending-routes.ts";
import type { lockRoutes } from "./account/lock-routes.ts";
import { lockBoundary, untilLockFrom, type LockSignal } from "./lock-boundary.ts";
import { handleAccountRequest } from "./account/routes.ts";
import type { AccountMailbox } from "./account/mailbox.ts";
import type { AccountHolds } from "./account/holds.ts";
import type { SafetyLog } from "./account/safety-log.ts";
import type { CatchUpGate } from "./account/catch-up-gate.ts";
import type { accountRowsFor } from "./account/account-devices.ts";
import type { ListAdd } from "./account/list-add.ts";
import type { ListFollow } from "./account/list-follow.ts";
import type { AccountWitness } from "./account/witness.ts";
import { accountDispatchRefusal } from "./account/dispatch-rights.ts";
import type { AccountIntroductions } from "./account/introductions.ts";
import type { RelayService } from "./relay/service.ts";
import { handleTelemetryRequest, visitSurface } from "./telemetry.ts";
import type { TelemetryIngress } from "../shared/telemetry.ts";
import { handleStatuslineRequest, handleUsageRequest } from "./usage.ts";
import { handleSystemRequest, type SystemSampler } from "./system-stats.ts";
import { handleUserFontsRequest } from "./user-fonts.ts";
import { USER_FONTS_PATH } from "../shared/user-fonts.ts";
import type { UsageAccountList } from "./usage-account-list.ts";
import { handleVoiceRequest } from "./voice.ts";
import { handleMemoryRequest } from "./memory/routes.ts";
import { BRIDGE_PROTOCOL } from "../shared/machines.ts";
import { bridgeIdentity } from "./bridge.ts";
import { discoverHerdrSessions } from "./herdr-discovery.ts";
import { ACCOUNT_PC_OWNER_ONLY, accountRoster, handleMachineRequest, nonCanonicalPath, slowMachinePath, type EventStreamBudget } from "./machine-api.ts";
import { machinePairingEvents, remotePairingEvents } from "./machine-pairing-events.ts";
import { handleJoinSeen, JOIN_SEEN_PATH, type JoinNotices, type JoinViewer } from "./join-notices.ts";
import { handleSessionHistoryRequest, handleSessionResumeRequest, SESSION_HISTORY_PATH, SESSION_RESUME_PATH } from "./session-history-routes.ts";
import type { PiSessionReader } from "./pi-session-metadata.ts";
import type { HerdrSidebarConfig } from "./herdr-sidebar.ts";
import { readHerdrUi } from "./herdr-ui.ts";
import { MachineRelay, type RelayReceiptIds } from "./machine-relay.ts";
import { RECEIPT_RESUME_ID } from "../shared/receipt-resume.ts";
import { sameOrigin } from "./machine-security.ts";
import { handlePluginRequest } from "./plugin-routes.ts";
import type { createServer } from "./index.ts";
import type { TailnetIdentity } from "./tailscale.ts";
import type { CLIProxyRoutes } from "./cliproxy-routes.ts";
import type { UsageLoginService } from "./usage-login.ts";
import type { UsageService } from "./usage.ts";
import type { VoiceService } from "./voice.ts";
import type { MemoryStore } from "./memory/store.ts";

type PortalStartup = { ok: true } | { ok: false; error: unknown };

export interface RequestServices {
  readonly runtimeMove: MoveService | null;
  readonly relay: RelayService;
  readonly relayReceiptIds: RelayReceiptIds;
  readonly options: NonNullable<Parameters<typeof createServer>[0]>;
  readonly hostname: string;
  readonly token: string;
  readonly bridgeToken: string;
  readonly bootId: string;
  readonly devices: DeviceStore;
  /** the joins no window of this PC has seen yet (server/join-notices.ts) */
  readonly joins: JoinNotices;
  readonly accountMailbox: AccountMailbox;
  readonly accountIntroductions: AccountIntroductions;
  readonly accountHolds: AccountHolds;
  /** the account safety log; null while OVIS_ACCOUNT_OPENS_ALL is off */
  readonly safetyLog: SafetyLog | null;
  /** Step 2 (S2-27): the wait after a start for rows not paired at this PC; null with the release flag off. */
  readonly catchUp: CatchUpGate | null;
  checkAccountFreshness(): void;
  /** Step 2 (S2-25): the account-joined rows of this PC's relay identity; null with the release flag off. */
  readonly accountRows: ReturnType<typeof accountRowsFor> | null;
  /** This PC following its account's signed list (server/account/list-follow.ts); null with the release flag off. */
  readonly accountList: ListFollow | null;
  /** Adding this PC to an account that keeps a signed list (server/account/list-add.ts); null with the release flag off. */
  readonly listAdd: ListAdd | null;
  /** For how long this PC has let each key of its account in (server/account/witness.ts); null with the release flag off. */
  readonly accountWitness: AccountWitness | null;
  /** On a server that follows no list (Step 2 off): looks whether another Ovis on this folder pinned the PC, and then closes this server's account part. Null on a server that follows its list itself. */
  readonly pinWatch: (() => void) | null;
  readonly preferences: PreferenceStore;
  readonly herdrSidebar: HerdrSidebarConfig;
  /** `loginPath`: the request states a Tailscale login, so the PC's own login must be known, not merely cached as unknown */
  readonly identityOf: (grantPath: boolean, host: string | null, loginPath?: boolean) => Promise<TailnetIdentity>;
  readonly serveOnly: boolean;
  /** the tailnet nodes this PC keeps out (server/tailnet-nodes.ts), and the WhoIs read that names a request's node */
  readonly tailnetNodes: TailnetNodes;
  readonly whoisNode: (address: string) => Promise<TailnetNode | null>;
  readonly portalGuards: () => { tokenSet: boolean; serveOnly: boolean };
  readonly shellAgents: ShellAgentLocator;
  readonly agentDetector: AgentDetector;
  readonly agentOffered: (kind: string) => Promise<boolean>;
  readonly agentInstaller: AgentInstaller;
  readonly openCodeState: OpenCodePromptState;
  readonly approvals: ApprovalHub;
  /** the agents this server drives over ACP (server/acp/children.ts); null off this PC's herdr-core */
  readonly acp: AcpChildren | null;
  readonly cliProxyRoutes: CLIProxyRoutes;
  readonly usageLogin: UsageLoginService;
  readonly usage: UsageService;
  readonly usageAccounts: UsageAccountList;
  readonly systemSampler: SystemSampler | null;
  /** the state folder's fonts/, served to every device that may read this PC (server/user-fonts.ts) */
  readonly fontsDir: string;
  readonly voice: VoiceService;
  /** Settings → Memory's notes for agents (server/memory/store.ts) */
  readonly memory: MemoryStore;
  readonly browserSnapshot: <S extends SessionSnapshot>(snapshot: S) => S;
  readonly core: ReturnType<typeof createCore>;
  readonly seen: SeenStore;
  readonly piReader: PiSessionReader;
  readonly orderSequence: OrderSequence;
  readonly clientConnectionLog: ClientConnectionLog;
  readonly requestLog: RequestLog;
  /** acts waiting for this PC's screen (server/account/local-confirm.ts); only with the Step 2 release flag */
  readonly localConfirms?: LocalConfirms;
  /** releases `ovis recover` made since this start (server/account/recovery.ts); only with the release flag */
  readonly recoveryReleases?: RecoveryReleases;
  /** devices waiting for this PC's screen to approve their key (server/account/pending.ts); only with the release flag */
  readonly pendingRedemptions?: PendingRedemptions;
  /** pairings that prove their key and wait for this PC's screen (server/account/key-proof.ts); Linux with the flag only */
  readonly keyProofPairings?: KeyProofPairings;
  /**
   * Opens this PC's local confirm page in a browser on its own desktop, as `ovis confirm` does, so its port stays in no
   * answer (R8). False when no page listens or there is no desktop to open it on.
   */
  readonly openConfirmPage?: () => Promise<boolean>;
  /** the tailscale CLI /api/access reads and POST /api/access/tailscale/serve runs; unset, the one this PC has */
  readonly tailscaleBinary?: string | null | undefined;
  /** puts a waiting key on this PC's screen */
  readonly askScreenForKey?: (entry: PendingRedemption) => void;
  /** /api/account/lock and /unlock (server/account/lock-routes.ts); only with the release flag */
  readonly lockRoutes?: ReturnType<typeof lockRoutes>;
  /** fired when the screen's approval writes a lock: what it no longer lets in ends (T46) */
  readonly lockSignal?: LockSignal;
  readonly portalStartupResult: PortalStartup | undefined;
  readonly portalStartup: Promise<PortalStartup>;
}

export interface ServerContext {
  requestIP(request: Request): { address: string } | null;
  timeout(request: Request, seconds: number): void;
  upgrade(request: Request, options: { headers?: HeadersInit; data: SocketData }): boolean;
  readonly port: number | undefined;
  /** `serverId`: the relay identity the device signed in to, which a `link` must name (docs/account.md). */
  readonly peer: { kind: "socket" } | { kind: "relay"; device: DeviceMatch; sessionId: string; serverId: string; key: string };
  readonly services: RequestServices;
  readonly relayBodyBudget?: EventStreamBudget;
  /**
   * The request came in on the machine profile's owner socket (`<state folder>/serve.sock`): set by the
   * server for that listener alone, never read from the request. Only there is a local owner of the profile.
   */
  readonly ownerSocket?: boolean;
  /**
   * The request came to the opt-in LAN HTTPS listener (server/lan-https.ts), from a private IPv4 peer:
   * it gets in only with the token or a paired device, never as an open install, by the bridge token,
   * and its wrong tokens share one budget with every other peer there.
   */
  readonly lanHttps?: boolean;
}

/** the tailscale CLI this server reads and, for its own window, runs: the one it was handed (tests), else this PC's */
const tailscaleCli = (ctx: ServerContext): string | null => ctx.services.tailscaleBinary !== undefined ? ctx.services.tailscaleBinary : tailscaleBinary();

const OTHER_MACHINE_FILES = /^\/api\/(?:fs\/|pane\/(?:files|docs|image)$|workspace\/(?:diff\/|git\/|directories$|pr(?:$|\/)))/;

export async function handleRequest(request: Request, ctx: ServerContext): Promise<Response | undefined> {
  const { options, hostname, token, bridgeToken, bootId, devices, preferences, herdrSidebar, identityOf, serveOnly, portalGuards, shellAgents, agentDetector, agentOffered, agentInstaller, openCodeState, approvals, acp, cliProxyRoutes, usageLogin, usage, voice, browserSnapshot, core, seen, piReader, orderSequence, clientConnectionLog, requestLog, portalStartupResult, portalStartup } = ctx.services;
  const { sidecar, serialize, push, alertWebhook, logPushError, omo, claudeAgents, opencodeAgents, plans, clientSnapshot, machines, broadcastAll, collector, queueFirstMessage, askFirstMessage } = core;
  return requestLog.handle(request, async (headers) => {
  if (options.profile === "machine") wordHerdrFailures(machineFailure, machineLayoutReason);
  const startup = portalStartupResult ?? await portalStartup;
  if (!startup.ok) {
    setRequestRoute("startup");
    return compressResponse(request, errorResponse(startup.error));
  }
  return compressResponse(request, await (async (): Promise<Response | undefined> => {
  const url = new URL(request.url);
  let { pathname } = url;
  const relayPeer = ctx.peer.kind === "relay" ? ctx.peer.device : undefined;
  const accountRefusal = accountDispatchRefusal(request, ctx);
  if (accountRefusal !== null) return accountRefusal;
  // the machine profile on TCP: its liveness for every caller; no credential or header of the request is read
  if (options.profile === "machine" && relayPeer === undefined && ctx.ownerSocket !== true) return machineTcpAnswer(request, pathname);
  // an act waiting for this PC's screen is answered there alone (server/account/local-confirm.ts): every caller of a
  // route gets the same refusal, before anything about it is decided
  if (/^\/api\/account\/local-confirm(?:\/|$)/.test(pathname) && ctx.services.localConfirms !== undefined) {
    setRequestRoute("/api/account/local-confirm");
    return jsonResponse({ error: { code: "local_required", message: "Confirm this on this PC's own screen." } }, 403);
  }
  const bridgeAuthorized = options.profile !== "machine" && relayPeer === undefined && ctx.lanHttps !== true && isAuthenticated(request, bridgeToken);
  // the connection server that reaches this one as its PC reads its update status and asks for the
  // update on offer: an Ovis run on this PC by itself is updated through its own updater, never
  // replaced (server/machines.ts ownOffer). An install still names the offered revision and the
  // custom header (update-api.ts), and whoever holds the token already drives every pane here. Only those two
  // requests, each by its own method and with no query: the token opens nothing else of these routes (#2054)
  const bridgeUpdatePath = url.search === "" && (pathname === "/api/updates" ? request.method === "GET" : (pathname === "/api/updates/install" || pathname === "/api/updates/cancel") && request.method === "POST");
  // the same server runs the move to herdr-core here for the person on its side (docs/runtime-move.md,
  // "On another PC"); each move route still asks for the app's own header and no query (updateRequestAllowed)
  const bridgeMovePath = RUNTIME_MOVE_ROUTE.test(pathname);
  const bridgePath = pathname === "/api/bridge" || pathname === "/api/session" || pathname === SESSION_HISTORY_PATH || pathname === SESSION_RESUME_PATH || pathname === "/api/agents" || pathname === "/api/agent-catalog" || pathname === INSTALL_PATH || pathname === SIGN_IN_PATH || pathname === "/api/agent/rename" || pathname === "/api/agent/commands" || pathname === "/api/integrations" || (pathname === "/api/system" && request.method === "GET") || pathname === "/api/usage/statusline" || pathname === "/api/plugins/actions" || pathname === "/api/plugin/action" || pathname.startsWith("/api/pane/") || pathname.startsWith("/api/workspace/") || pathname.startsWith("/api/worktree/") || pathname.startsWith("/api/tab/") || pathname === "/api/layout/ratio" || pathname.startsWith("/api/fs/") || pathname === "/ws" || bridgeUpdatePath || bridgeMovePath;
  const ip = relayPeer === undefined ? ctx.requestIP(request) : null;
  const loopback = ip !== null && isLoopbackAddress(ip.address);
  const forwarded = relayPeer === undefined && cameThroughProxy(request.headers);
  const funnel = relayPeer === undefined && request.headers.has("tailscale-funnel-request");
  const tailscaleLogin = relayPeer === undefined ? request.headers.get("tailscale-user-login") : null;
  const forwardedFor = relayPeer === undefined ? request.headers.get("x-forwarded-for") : null;
  const requestHost = request.headers.get("host");
  // the guessing budget of the address that asks (auth.ts): a token presented while it waits is not compared
  // on the LAN listener `via lan-https` puts every peer in one shared budget too (auth.ts sharedKey)
  const client = relayPeer !== undefined ? `relay:${relayPeer.id}` : ctx.lanHttps === true && ip !== null ? `${ip.address} via lan-https` : authClient(ip?.address ?? null, request.headers);
  const presented = relayPeer === undefined ? presentedToken(request, token, client) : null;
  // counted at once, before any await below lets a concurrent guess pass the same check. Every
  // wrong token counts, a paired watch device's too (a right one would upgrade it to drive);
  // the connection server's own bridge token does not
  if (presented === "wrong" && !bridgeAuthorized) recordPresentedTokenFailure(client);
  const tokenMatched = presented === "match";
  let pairedDevice: DeviceMatch | null;
  try {
    // a script's `Authorization: Device` header stands for the cookie a browser holds (#2744)
    // the machine profile reads no device cookie: it lets in no device but through the relay
    pairedDevice = relayPeer ?? (options.profile === "machine" ? null : devices.match(deviceAuthorizationValue(request) ?? deviceCookieValue(parseCookies(request.headers.get("cookie")))));
  } catch (error) {
    // First-cookie confirmation is an authorization write, not best-effort telemetry.
    return errorResponse(error);
  }
  const requestShape = { loopback, forwarded, funnel, tailscaleLogin, forwardedFor, serveOnly };
  const apiPath = pathname === "/ws" || pathname.startsWith("/api/");
  const identity = relayPeer === undefined
    ? await identityOf(token === "" && pairedDevice === null && isServeOwnerRequest(requestShape) && apiPath, requestHost,
      // only the shape decideAccess could let in by login: from loopback, one tailnet address, not Funnel
      token === "" && pairedDevice === null && loopback && tailscaleLogin !== null && !funnel && inTailnet(forwardedFor) && apiPath)
    : { owner: null, tagged: false, soleLogin: null, dnsName: null, tailnetIp: null };
  // Portal reaches this server over loopback, never the LAN listener: its proof is not a way in there
  const portalProven = relayPeer === undefined && ctx.lanHttps !== true && (options.portal?.vouches(request.headers.get("x-portal-proof") ?? null) ?? false);
  // How this request came, for /api/health and the daily active message: the relay session it arrived on (any of
  // its carriers), Portal, else what the request itself proves (observedIngress). Portal's proof says so even when
  // the token or a paired device signed the request in. A Portal with no sign-in has no proof to send: for
  // /api/health (`portalShape`) a request from this PC in the shape it forwards (X-Forwarded-Proto https) to an
  // address it serves is taken as Portal's, since another program here could send the same and would only
  // mislabel its own answer. That shape is headers, so the counts never take it
  const requestIngress = (portalShape: boolean): ObservedIngress => {
    if (relayPeer !== undefined) return "relay";
    if (portalProven || (portalShape && loopback && request.headers.get("x-forwarded-proto") === "https" && (options.portal?.serves(requestHost) ?? false))) return "portal";
    return observedIngress({ ...requestShape, ...identity, peerKnown: ip !== null, forwardingHeaders: forwardingHeaders(request.headers) });
  };
  let access = options.profile === "machine" ? decideMachineAccess({ relayPeer, ownerSocket: ctx.ownerSocket === true, host: requestHost, forwarded: machineForwardingHeaders(request.headers) }) : decideAccess({
    relayPeer,
    ...requestShape,
    host: requestHost,
    tokenMatched,
    device: pairedDevice,
    ...identity,
    tokenConfigured: token !== "",
    gated: devices.gated || ctx.lanHttps === true,
    portal: {
      proven: portalProven,
      user: portalProven ? request.headers.get("x-portal-user") : null,
      auth: portalProven ? request.headers.get("x-portal-auth") : null,
      role: portalProven ? options.portal?.roleFor(request.headers.get("x-portal-user"), request.headers.get("x-portal-auth")) ?? "watch" : "watch",
    },
  });
  // a node the owner removed gets no Tailscale grant, and a device's own credential over the tailnet names its node on
  // its row (server/tailnet-nodes.ts). Through Serve (loopback) only the address the local tailscaled wrote counts:
  // one source. A direct connection to a tailnet bind is named by its socket's peer, never by a header it sent
  let tailnetNode: string | null = null;
  if (options.profile !== "machine" && relayPeer === undefined) {
    const peer = ip?.address.replace(/^::ffff:/i, "") ?? null;
    ({ access, node: tailnetNode } = await tailnetNodeGate(access, {
      address: loopback ? (forwarded && !funnel && inTailnet(forwardedFor) ? forwardedFor : null) : inTailnet(peer) ? peer : null,
      owner: identity.owner, nodes: ctx.services.tailnetNodes, rows: devices, whois: ctx.services.whoisNode,
    }));
  }
  // the lock and a log that cannot be read decide here, once, for every way in (server/lock-boundary.ts)
  const safety = ctx.services.safetyLog;
  // this PC's own window may still read the lock and ask for an unlock: both only ask the screen, which grants
  // (on a PC with an access token, that window comes in with the token: the same window, loopback and not forwarded)
  const ownWindow = access.level === "full" && (access.via === "local" || (access.via === "token" && loopback && !forwarded));
  // who is told of a join that waits to be seen, and may mark it seen (server/join-notices.ts shownTo)
  const joinViewer: JoinViewer = { ownWindow, since: access.level === "full" && access.device ? devices.addedAt(access.device.id) : undefined };
  // a lock or unlock is asked only from this PC's own window: any other is told so, before any other refusal (S36-1)
  if (!ownWindow && request.method === "POST" && (pathname === "/api/account/lock" || pathname === "/api/account/unlock") && ctx.services.lockRoutes !== undefined) {
    setRequestRoute(pathname);
    return jsonResponse({ error: { code: "local_required", message: "Turn the lock on or off on this PC's own screen." } }, 403, { "cache-control": "no-store" });
  }
  // a key that waits for this PC's screen: its own window may have the confirm page opened, which decides it with its
  // own same-user check; any other window is told so (the page's port is never sent, R8)
  if (pathname === "/api/account/confirm-page" && ctx.services.openConfirmPage !== undefined) {
    setRequestRoute(pathname);
    const refuse = (code: string, message: string, status: number) => jsonResponse({ error: { code, message } }, status, { "cache-control": "no-store" });
    if (request.method !== "POST") return refuse("method_not_allowed", "use POST", 405);
    if (!ownWindow) return refuse("local_required", "Open the confirm page on this PC's own screen.", 403);
    if (!sameOrigin(request) || request.headers.get("x-herdr-machine") !== "1") return refuse("invalid_origin", "Open it from this app", 403);
    return await ctx.services.openConfirmPage() ? new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
      : refuse("confirm_page_unavailable", "The confirm page could not be opened here. Run ovis confirm on this PC.", 409);
  }
  // a Tailscale change (serve Ovis on the tailnet, open the app) is asked only from this PC's own window: any other
  // caller, a relayed or account-joined one included, is told so before anything is read or run
  const tailscaleControl = pathname === TAILSCALE_CONTROLS.serve || pathname === TAILSCALE_CONTROLS.open;
  if (tailscaleControl && !ownWindow) {
    setRequestRoute(pathname);
    return jsonResponse({ error: { code: "local_required", message: "Set up Tailscale on this PC's own screen." } }, 403, { "cache-control": "no-store" });
  }
  const askingTheScreen = ownWindow
    && ((pathname === "/api/account/lock" && request.method === "GET") || (pathname === "/api/account/unlock" && request.method === "POST"));
  const localDenial = ownWindow && !funnel && devices.localRemovalRetry()
    && ((request.method === "POST" && pathname === "/api/devices/revoke-all")
      || (request.method === "DELETE" && /^\/api\/devices\/[0-9a-f]{16}$/.test(pathname)));
  // strict is every source the store fails closed on (the log, the admission order, removal evidence, the journal: S19)
  if (safety !== null && safety !== undefined && !askingTheScreen) {
    access = lockBoundary(access, { locked: safety.state().locked, strict: devices.failsClosed && !localDenial }, {
      localProof: false, ownProgram: ctx.ownerSocket === true, originOf: (rowId) => devices.originOf(rowId),
    });
  }
  const authenticated = access.level === "full" || (bridgePath && bridgeAuthorized);
  // a connection or stream on a grant a lock would refuse ends when a lock is written (T46, S24); a row ends through
  // the store, and this PC's own programs keep working
  const lockSignal = ctx.services.lockSignal;
  const survivesLock = access.level === "full" && (bridgeAuthorized || (access.device !== undefined && access.via !== "local")
    || lockBoundary(access, { locked: true, strict: false }, { localProof: false, ownProgram: ctx.ownerSocket === true, originOf: (rowId) => devices.originOf(rowId) }).level === "full");
  const untilLocked = lockSignal !== undefined && !survivesLock ? untilLockFrom(lockSignal) : undefined;
  // and one that came from a tailnet node ends when that node is blocked, as a row's end with its Revoke (tailnet-nodes.ts)
  const node = tailnetNode;
  const untilRefused = node === null ? untilLocked : (close: () => void) => {
    const stops = [untilLocked?.(close), ctx.services.tailnetNodes.onBlocked(node, close)];
    return () => { for (const stop of stops) stop?.(); };
  };

  // on the owner's socket a request naming another host or showing a proxy gets nothing, its health included
  if (options.profile === "machine" && access.level !== "full") return machineUnauthorized(pathname);

  if (requiresAuth(pathname) && !authenticated) {
    setRequestRoute("auth-refusal");
    // a script's Bearer guess is told to wait; a browser's cookie gets the usual 401 and its sign-in form
    if (presented === "held" && pathname !== "/ws" && request.headers.has("authorization")) return presentedTokenHeld(client);
    // this PC's own window is told what it cannot read (the file, the folder), where any other caller hears the general words
    return pathname === "/ws" ? new Response("unauthorized", { status: 401 })
      : unauthorizedJson(access.level === "none" ? access.reason : "token_required", ownWindow ? devices.accountError : null);
  }

  if (options.profile === "machine" && machineRouteRestricted(pathname, request.method)) {
    setRequestRoute("machine-profile-refusal");
    return jsonResponse({ error: { code: "machine_profile", message: "This control is unavailable in the machine profile" } }, 409);
  }
  const engineRefusal = options.profile === "machine" && (pathname === "/api/session" || pathname === "/api/machines" || pathname === "/ws") ? await options.machineRefusal?.() : undefined;

  const readOnly = access.level === "full" && access.role === "watch";
  // who started a followed sign-in: only that device (or that signed-in browser) reaches it again
  const loginOwner = access.level === "full" ? (access.device ? `device:${access.device.id}` : `${access.via}:${access.login ?? ""}`) : null;
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  if (pathname.startsWith("/api/") && mutating && !sameOrigin(request)) {
    setRequestRoute("origin-refusal");
    return jsonResponse({ error: { code: "invalid_origin", message: "Use controls from this app" } }, 403);
  }
  // An empty segment ("//", or a trailing "/") or an encoded separator reads as another route to
  // the checks below, while the PC proxy drops empty segments before forwarding:
  // `/api/machines/<id>//fs/file` would pass as not a file read, `<id>/sessions/history/` as no history.
  if (pathname.startsWith("/api/") && nonCanonicalPath(pathname)) return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
  // What a watching device must not reach, spelled out rather than inferred from the
  // method: file contents (those files include credentials) and a directory listing
  // (names and sizes are the shape of a repository the terminals never print), plus
  // every mutation except the two below.
  const fileRead = /^\/api\/(?:machines\/[^/]+\/)?fs\//.test(pathname);
  const directoryListing = /^\/api\/(?:machines\/[^/]+\/)?workspace\/directories$/.test(pathname);
  // Signing a device's own alerts in is a preference of that device, so `watch` keeps
  // it. The endpoint it registers is https-only (server/push.ts), and that is the
  // protection: a watch device's subscription is delivered every status change anyway.
  // /api/push/test stays with a session that can drive only because it is a mutation; /api/push/status
  // is a POST only to keep the subscription out of the address, and answers the device about its own.
  // A watch device may report its own connection metadata, never terminal input or file data.
  const ownPreferences = pathname === "/api/auth" || pathname === "/api/push/subscribe" || pathname === "/api/push/status" || pathname === "/api/connection-diagnostics";
  // a repository's changes are file contents too: the patch of a credential file is that file; its
  // history (commit messages, branch names) is read the same way
  const repositoryDiff = /^\/api\/(?:machines\/[^/]+\/)?workspace\/(?:diff|git)\//.test(pathname);
  // a pull request's review comments and job logs are the repository's contents as well
  const pullRequest = /^\/api\/(?:machines\/[^/]+\/)?workspace\/pr(?:\/|$)/.test(pathname);
  // earlier sessions carry their first prompts
  const sessionHistory = /^\/api\/(?:machines\/[^/]+\/)?sessions\/history$/.test(pathname);
  // an agent's commands in a folder, and a pane's, are read from that folder's command files (each row
  // carries a file's first line and its path), as a directory listing and a file read are; the
  // composer's menu that lists them is a drive feature (#2132)
  const commandRows = /^\/api\/(?:machines\/[^/]+\/)?(?:agent|pane)\/commands$/.test(pathname);
  // the paths under a pane's folder that match a query are a directory listing too; they feed the
  // composer's @-mention picker, a drive feature (#2244); so are its Markdown files, which Files' Documents lists
  const paneFiles = /^\/api\/(?:machines\/[^/]+\/)?pane\/(?:files|docs)$/.test(pathname);
  // where a plugin action's run stands carries what its command printed when it failed, asked for by a
  // log id: only the device that started the run (a POST, which a watching device cannot send) asks it
  const pluginRun = /^\/api\/(?:machines\/[^/]+\/)?plugin\/action$/.test(pathname);
  // a repository's checkouts are its folders' paths and branches, those not open in herdr too; the worktree
  // dialog that lists them is a drive feature, and the sidebar names a branch only for a driving device (#2250)
  const worktreeList = /^\/api\/(?:machines\/[^/]+\/)?worktree\/(?:list|inventory)$/.test(pathname);
  // the digits of a waiting comparison are what approving it takes (docs/account.md, "Who may admit a device")
  const pairingDigits = pathname === "/api/relay/pairings";
  // a device that waits to link (it paired with a code made for a PC in no account) has the role with the fewest
  // rights, and sends one mutation: its own link, which makes it a device (server/account/routes.ts). Its relay
  // session refuses it every other call but the read of its own account status (server/relay/session.ts)
  const ownLink = relayPeer?.provisional === true && request.method === "POST" && (pathname === "/api/account/link" || pathname === "/api/account/list/named");
  // a member tells this PC where its account's signed list stands and hands it entries it lacks: entries prove
  // themselves, so a device that only watches may carry them too (server/account/routes.ts)
  // only on a PC that follows a list a person named: one that follows none answers every caller as before
  const listGossip = request.method === "POST" && (pathname === "/api/account/list/head" || pathname === "/api/account/list/page") && (ctx.services.accountList?.peerHead() ?? null) !== null;
  if (readOnly && (fileRead || directoryListing || repositoryDiff || pullRequest || sessionHistory || commandRows || paneFiles || pluginRun || worktreeList || pairingDigits || mutating && !ownPreferences && !ownLink && !listGossip)) {
    setRequestRoute("watch-refusal");
    // A device the account's list holds only to watch, asking for the joins that wait at this pinned PC or deciding one:
    // it is told, in a code of its own, that it is in the list and may not let a device in (relay/routes.ts says the
    // same to a device that drives with bound power)
    if (ctx.peer.kind === "relay" && ctx.peer.key !== "" && (pairingDigits && request.method === "GET" || pathname === "/api/relay/pairing" && request.method === "POST")
      && ctx.services.accountList?.allowsJoins(ctx.peer.key) === false) {
      return jsonResponse({ error: { code: "list_cannot_allow", message: "This device is in your account's list, but only a device that can add devices to the list may let one in." } }, 403);
    }
    return jsonResponse({ error: { code: "read_only", message: "this device can only watch" } }, 403);
  }
  // a text file is edited (read for it and saved) only by a device that drives this PC, here or through it on another PC (file-edit.ts)
  const textEdit = /^\/api\/(?:machines\/[^/]+\/)?fs\/text$/.test(pathname);
  if (textEdit && !textEditAllowed(access, bridgeAuthorized, pathname.startsWith("/api/machines/"))) {
    setRequestRoute("drive-refusal");
    return jsonResponse({ error: { code: "drive_only", message: "Only a device that drives this PC can edit its files" } }, 403);
  }
  // Portal visitors use the same watch checks above as paired watch devices. Even a Portal
  // identity explicitly given drive in local state cannot use these controls to leave access
  // behind: device changes (including redeeming a pairing code), relay controls (a relay offer
  // carries a pairing code), push subscriptions and their status, and Portal controls require
  // the owner's app credential.
  const standingAccess = mutating && (
    pathname.startsWith("/api/portal/")
    || pathname.startsWith("/api/devices/")
    || pathname === "/api/relay" || pathname.startsWith("/api/relay/")
    || pathname.startsWith("/api/account/")
    || (request.method === "POST" && (pathname === "/api/push/subscribe" || pathname === "/api/push/status"))
    // a destination keeps getting alerts after the visitor who set it lost access, as a push subscription would
    || pathname === "/api/alerts/webhook" || pathname === "/api/alerts/webhook/test"
  );
  // pairing without a code ends in an approval only a window that hears of it can give (relay-pairings below):
  // an ungated LAN window never does, so it neither makes such a link nor answers one
  // the account's members are standing access, like devices: never a Portal visitor's or an open LAN window's
  const postingAccountRecords = request.method === "POST" && pathname === "/api/account/records";
  if (access.level === "full" && pathname.startsWith("/api/account/") &&
      (postingAccountRecords && access.role === "drive" ? !ownerAccess(access) : access.via === "open" || access.via === "portal")) {
    setRequestRoute("owner-refusal");
    return jsonResponse({ error: { code: "owner_only", message: "Manage the account from this PC itself, or from a paired device." } }, 403);
  }
  // one press binds this PC to an account: only this PC's own window may ask it (security-triage), never another
  // device on the LAN, through the relay or with the access token from elsewhere
  // so does vouching for another PC with this PC's account over SSH (docs/account.md, "Adding a PC over SSH")
  if (pathname === "/api/account/ssh-add" && !ownWindow) {
    setRequestRoute("owner-refusal");
    return jsonResponse({ error: { code: "owner_only", message: "Add another PC to your account from this PC itself." } }, 403);
  }
  // so does this PC's own proof for its listing, which lists it again after `ovis logout` left the account
  if ((pathname === "/api/account/one-press" || pathname === "/api/account/pc-proof") && !ownWindow) {
    setRequestRoute("owner-refusal");
    return jsonResponse({ error: { code: "owner_only", message: "Add this PC to your account on this PC itself." } }, 403);
  }
  // how this PC follows its account's signed list is for this PC's own window and CLI to read, and only a person at
  // this PC names the list it pins, by its id, by the number it compares with the phone that adds it, or by the line of an invite
  if ((pathname === "/api/account/list" || pathname === "/api/account/list/pin" || pathname === "/api/account/list/add" || pathname.startsWith("/api/account/list/add/")
    || pathname === "/api/account/list/join" || pathname.startsWith("/api/account/list/join/")) && !ownWindow) {
    setRequestRoute("owner-refusal");
    return jsonResponse({ error: { code: "owner_only", message: "Read this on this PC itself." } }, 403);
  }
  // the list of waiting pairings shows their digits, so it goes only where the approval may come from
  if (access.level === "full" && (access.via === "open" || access.via === "portal") && pathname === "/api/relay/pairings") {
    setRequestRoute("owner-refusal");
    return jsonResponse({ error: { code: "owner_only", message: "Approve pairings on this PC itself, or from a paired device." } }, 403);
  }
  if (access.level === "full" && access.via === "open" && request.method === "POST"
    && (pathname === "/api/relay/link" || pathname === "/api/relay/pairing")) {
    setRequestRoute("open-refusal");
    return jsonResponse({ error: { code: "owner_only", message: "Pair without a code from this PC itself, or from a paired device: an open LAN window is not told when a phone waits for approval." } }, 403);
  }
  // the owner's other PCs answer this PC's own Tailscale login (server/tailnet-pcs.ts): an open LAN window, a Portal
  // visitor or a device on the relay must not borrow it to pair this PC with them
  if (pathname === "/api/machines/tailnet" && access.level === "full" && (access.via === "open" || access.via === "portal" || access.via === "relay")) {
    setRequestRoute("owner-refusal");
    return jsonResponse({ error: { code: "owner_only", message: "Add PCs from your Tailscale on this PC itself, or from a device paired with it directly." } }, 403);
  }
  // Another PC of the account is paired with this PC's server by a device that drives this PC (docs/account.md, "Adding a
  // PC of your account"): a window direct to it, or a device paired with it over the relay, which is how the hosted shell
  // and the phone reach this PC at all. Their account sign-in posts the admission that vouches for this PC, and a member
  // still picks the digits on the other PC. An open LAN window or a Portal visitor has no such sign-in and must not have
  // this PC pair itself with whatever PC they name; a watching device is refused above and in machine-api.ts (read_only).
  // The same routes of another PC asked through this one are the owner's too (machine-api.ts ACCOUNT_PC_PATH).
  if (pathname.startsWith("/api/machines/relay/account/") && access.level === "full" && (access.via === "open" || access.via === "portal")) {
    setRequestRoute("owner-refusal");
    return jsonResponse({ error: { code: "owner_only", message: ACCOUNT_PC_OWNER_ONLY } }, 403);
  }
  // so is another PC's Ovis added by its address: this PC would keep a device token that drives it
  if (pathname === "/api/machines/address" && access.level === "full" && (access.via === "open" || access.via === "portal" || access.via === "relay")) {
    setRequestRoute("owner-refusal");
    return jsonResponse({ error: { code: "owner_only", message: "Add a PC by its address on this PC itself, or from a device paired with it directly." } }, 403);
  }
  // The SSH tab's list (hosts of this PC's ssh config with their user@hostname, and its Tailscale login's PCs) goes
  // only to clients that may drive this PC with full access: this PC itself, its access token, a device paired with
  // it directly to drive, and another PC on the owner's Tailscale login. Each of those can already open a terminal
  // here and read ~/.ssh/config, so the list tells them nothing new. An open LAN window, a Portal visitor and a
  // device on the relay are refused here; a watching device is refused in machine-api.ts (read_only).
  if (pathname === "/api/machines/ssh-candidates" && access.level === "full" && (access.via === "open" || access.via === "portal" || access.via === "relay")) {
    setRequestRoute("owner-refusal");
    return jsonResponse({ error: { code: "owner_only", message: "See the PCs this PC knows on this PC itself, or from a device paired with it directly." } }, 403);
  }
  // and what it keeps open is closed after a while, so it comes through Portal's sign-in again (portal.ts recheckMs)
  const portalRecheckMs = access.level === "full" && access.via === "portal" ? options.portal?.recheckMs : undefined;
  if (access.level === "full" && access.via === "portal" && standingAccess) {
    setRequestRoute("owner-refusal");
    return jsonResponse({ error: { code: "owner_only", message: "A visitor signed in through Portal cannot pair devices, subscribe to alerts or control Portal or the relay here. Use the access token or a paired device." } }, 403);
  }

  // API reads can chain several bounded 10 s Herdr RPCs. Give the handler time to return
  // its JSON result or timeout instead of Bun closing the socket at its default 10 s idle
  // cutoff. Static files keep their default; streaming and long-operation routes override
  // this finite budget below, after access and origin checks have passed. Only a signed-in
  // request gets it: the routes open without sign-in (health, auth, pairing) keep the default,
  // so an unauthenticated client cannot hold idle sockets for a minute.
  if (pathname.startsWith("/api/") && authenticated) ctx.timeout(request, 60);

  // the panes' files are on another machine: this disk's would be shown, listed, diffed or written as theirs
  if (options.localFiles === false && OTHER_MACHINE_FILES.test(pathname)) {
    setRequestRoute(pathname);
    return jsonResponse({ error: { code: "unsupported", message: "Files on another machine of herdr-core are not reachable from Ovis yet" } }, 501);
  }

  if (pathname === "/api/bridge") {
    setRequestRoute(pathname);
    const discover = url.searchParams.get("discover") === "herdr";
    // discovery is the owner's (a paired driving device, their Tailscale login, this PC) or the bridge token's, on a
    // tokenless installation too; the identity alone stays the bridge token's there
    if (discover && !bridgeAuthorized && !ownerAccess(access)) return jsonResponse({ error: { code: "forbidden", message: "Only the owner can discover this PC's sessions" } }, 403);
    if (token === "" && !bridgeAuthorized && !discover) return unauthorizedJson();
    try {
      const identity = await bridgeIdentity(sidecar);
      return jsonResponse(discover ? { ...identity, found_herdr_sessions: await discoverHerdrSessions() } : identity);
    } catch (error) { return errorResponse(error); }
  }
  if (pathname === "/api/machines" || pathname.startsWith("/api/machines/")) {
    // the machine profile manages no other PC: its list is this machine alone, and every other route here was refused above
    if (options.profile === "machine") {
      setRequestRoute("/api/machines");
      if (!sameOrigin(request)) return jsonResponse({ error: { code: "invalid_origin", message: "Use PC controls from this app" } }, 403);
      try {
        const roster = await machineRoster(url, async () => browserSnapshot(await clientSnapshot()), { bootId, serverId: ctx.services.relay.serverId() }, options.machineEngine ?? "herdr", engineRefusal);
        return jsonResponse(roster, 200, { "cache-control": "no-store" });
      } catch (error) { return machineReadError(error, options.machineEngine ?? "herdr", engineRefusal); }
    }
    if (!machines) return jsonResponse({ error: { code: "bridge_only", message: "Manage PCs on the connection server" } }, 404);
    if (pathname.startsWith("/api/machines/local/")) {
      if (!sameOrigin(request) || (request.method !== "GET" && request.headers.get("x-herdr-machine") !== "1")) return jsonResponse({ error: { code: "invalid_origin", message: "Use PC controls from this app" } }, 403);
      pathname = pathname.replace("/api/machines/local/", "/api/");
      if (!/^\/api\/(session|agents|agent-catalog$|agent-catalog\/(?:install|sign-in)$|integrations|pane\/|workspace\/|worktree\/|tab\/|layout\/ratio$|agent\/(?:rename|commands)$|plugins\/actions$|plugin\/action$|sessions\/(?:history|resume)$)/.test(pathname)) return badRequest("invalid_route", "Unknown PC endpoint");
      url.pathname = pathname;
    } else {
      // a worktree made with an agent waits on git and then agent.start, up to 150 s on the PC, and a
      // resume on agent.start and then its store check (machine-api.ts slowMachinePath)
      // a move's install there is waited for 200 s (machine-api.ts), and so is that PC's comparison with another PC of
      // the account (it holds it 180 s): this connection is held a little longer still
      const machinePathAsked = pathname.split("/").slice(4).join("/");
      ctx.timeout(request, pathname === "/api/machines/events" ? 0 : machinePathAsked === "runtime/move/install" || machinePathAsked === "machines/relay/account/pair" ? 210 : slowMachinePath(machinePathAsked) || pathname === "/api/machines/relay/account/pair" ? 180 : 80);
      const deviceId = access.level === "full" ? access.device?.id : undefined;
      // Tabs opening at once each get a cookie of their own name; a later pairing carries all of them.
      const presentedKeys = streamKeys(request);
      const issuedKey = presentedKeys.length === 0 && pathname === "/api/machines/events" ? newStreamKey() : null;
      const keys = issuedKey === null ? presentedKeys : [issuedKey];
      const openAccess = access.level === "full" && access.via === "open";
      const pairings = machinePairingEvents(ctx, access, keys, joinViewer);
      // a stream ends with what let it in: a device's revoke, the gate closing on one the open LAN let in, Portal's recheck
      const endsWith = deviceId ? (close: () => void) => devices.onRevoke(deviceId, close) : openAccess ? (close: () => void) => devices.endWithGate(close) : portalRecheckMs !== undefined ? (close: () => void) => { const timer = setTimeout(close, portalRecheckMs); return () => clearTimeout(timer); } : undefined;
      // and with a lock, when what let it in is a grant the lock refuses, or with a block of the tailnet node it came from
      const ends = untilRefused === undefined ? endsWith : (close: () => void) => { const stops = [untilRefused(close), endsWith?.(close)]; return () => { for (const stop of stops) stop?.(); }; };
      const response = await handleMachineRequest(request, machines, ends, preferences, readOnly, herdrSidebar, seen, pairings, ctx.relayBodyBudget, ownerAccess(access), ctx.services.safetyLog !== null, devices, relayPeer !== undefined && devices.isAccountRow(relayPeer.id));
      response.headers.set("cache-control", "no-store");
      if (issuedKey !== null && response.ok) response.headers.append("set-cookie", streamCookie(issuedKey, isSecureRequest(request)));
      return response;
    }
  }
  if (pathname === "/ws") {
    setRequestRoute(pathname);
    if (!sameOrigin(request)) return new Response("invalid origin", { status: 403 });
    const deviceId = access.level === "full" ? access.device?.id : undefined;
    const recheck = portalRecheckMs === undefined ? {} : { recheckMs: portalRecheckMs };
    const machineId = url.searchParams.get("machine_id");
    const browser = url.searchParams.get("receipt_resume_id");
    const commandBrowser = browser && RECEIPT_RESUME_ID.test(browser) ? browser : undefined;
    if (machineId && machineId !== "local") {
      if (access.level === "none") return unauthorizedJson(access.reason);
      if (!machines?.endpoint(machineId)) return jsonResponse({ error: { code: "machine_offline", message: "This PC is disconnected" } }, 503);
      // whose receipts these are: the paired device, else the Portal user or Tailscale login the request proved
      const principal = deviceId !== undefined ? JSON.stringify(["device", deviceId])
        : access.portal ? JSON.stringify(["portal", access.portal.method, access.portal.user])
        : access.login !== undefined ? JSON.stringify(["tailscale", access.login.toLowerCase()]) : undefined;
      let relay: MachineRelay | undefined;
      try {
        relay = new MachineRelay(machines, machineId, readOnly, browserSnapshot,
          (browser) => ctx.services.relayReceiptIds.scope(machineId, principal, browser), commandBrowser);
        await relay.ready;
        const upgraded = ctx.upgrade(request, { headers, data: connectionData({ relay, deviceId, readOnly, ...(access.level === "full" && access.via === "open" ? { open: true } : {}), ...recheck, ...(untilRefused ? { untilLock: untilRefused } : {}) }) });
        if (upgraded) return undefined;
        relay.close();
      } catch { relay?.close(); return new Response("remote websocket unavailable", { status: 502 }); }
      return new Response("websocket upgrade required", { status: 426 });
    }
    // what the daily active message counts of this visit: the page's kind of screen and the way it came in;
    // nothing for another server's bridge, or for a surface no page names (visitSurface)
    const surface = bridgeAuthorized ? false : visitSurface(url.searchParams.get("surface"));
    const observed = surface === false ? undefined : requestIngress(false);
    const ingress: TelemetryIngress | undefined = observed === "direct" ? (loopback ? "local" : "lan") : observed;
    // Reuse the terminal socket for the same authorized event document as /api/machines/events.
    const listed = devices.isAccountRow(deviceId ?? "");
    const eventsEnabled = !bridgeAuthorized && process.env["OVIS_MACHINE_EVENTS_WS"] !== "0";
    const useMachineEvents = machines && eventsEnabled && !listed;
    const localRoster = machines && eventsEnabled && listed ? (tell: (rows: Machine[]) => void) => machines.subscribe(event => {
      if (event.type === "machines") tell(accountRoster(herdrSidebar.get(), event.machines));
    }) : undefined;
    // a device of the account's list hears the joins that wait at this PC over the same socket, when it may let one in
    const listJoins = localRoster ? remotePairingEvents(ctx) : undefined;
    const presentedKeys = streamKeys(request);
    const issuedKey = useMachineEvents && presentedKeys.length === 0 ? newStreamKey() : null;
    const keys = issuedKey === null ? presentedKeys : [issuedKey];
    if (issuedKey !== null) headers.append("set-cookie", streamCookie(issuedKey, isSecureRequest(request)));
    const openAccess = access.level === "full" && access.via === "open";
    const machineEvents = useMachineEvents ? {
      manager: machines, preferences, herdrSidebar, seen,
      pairings: machinePairingEvents(ctx, access, keys, joinViewer),
    } : undefined;
    const managedReceipts = options.bridgeOnly === true && ctx.peer.kind !== "relay" && bearerMatches(request, token);
    const upgraded = ctx.upgrade(request, { headers, data: connectionData({ machineEvents, localRoster, listJoins, deviceId, commandBrowser, managedReceipts, ...(ctx.peer.kind === "relay" && ctx.peer.device.id === deviceId && ctx.peer.key ? { provedKey: ctx.peer.key } : {}), readOnly, ...(openAccess && !bridgeAuthorized ? { open: true } : {}), bridge: bridgeAuthorized, ...(surface ? { surface } : {}), ...(ingress === undefined ? {} : { ingress }), ...recheck, ...(untilRefused ? { untilLock: untilRefused } : {}) }) });
    if (upgraded) return undefined;
    return new Response("websocket upgrade required", { status: 426 });
  }

  if (pathname === "/api/auth") {
    setRequestRoute(pathname);
    if (relayPeer !== undefined) return jsonResponse({ error: { code: "device_key_required", message: "Relay access uses a paired device key" } }, 403);
    // signing out also ends the page media this browser was given (by its device, else by its address)
    // a browser can hold the token and a device cookie at once, and its renders are then the
    // client's: signing out ends both kinds
    if (request.method === "DELETE" && authenticated) {
      if (pairedDevice !== null) forgetPageMedia({ device: pairedDevice.id });
      forgetPageMedia({ client });
    }
    return handleAuthRequest(request, token, client);
  }
  if (pathname === "/api/devices/pending" || pathname.startsWith("/api/devices/pending/")) {
    const pendingRedemptions = ctx.services.pendingRedemptions;
    if (pendingRedemptions !== undefined) return handlePendingRequest(request, pathname, pendingRedemptions, access);
  }
  if (pathname === JOIN_SEEN_PATH) return handleJoinSeen(request, ctx.services.joins, access, joinViewer);
  if (pathname === "/api/devices/tailnet-nodes" || pathname.startsWith("/api/devices/tailnet-nodes/")) {
    try {
      return await handleTailnetNodeRequest(request, pathname, {
        nodes: ctx.services.tailnetNodes, rows: devices, ownWindow: ownWindow && !funnel, locked: safety?.state().locked === true,
      });
    } catch (error) { return errorResponse(error); }
  }
  if (pathname === "/api/devices" || pathname.startsWith("/api/devices/")) {
    try {
      // one device, or all of them: the registry names what was revoked, and the cleanup follows its ids
      const revokeAccess = localDenial && access.level === "full" ? { ...access, via: "local" as const } : access;
      return await handleDeviceRequest(request, pathname, devices, revokeAccess, ctx.peer.kind === "relay" ? ctx.peer.key : null, (revoked) => {
        for (const id of revoked) {
          // The device registry is the delivery authority even if cleaning the push file fails.
          try { push.revokeDevice(id); } catch (error) { logPushError(error); }
          // and every page media address its renders were given
          forgetPageMedia({ device: id });
        }
      }, ctx.lanHttps === true, { list: () => ctx.services.relay.connections(), check: (ms) => ctx.services.relay.checkConnections(ms) }, ownWindow && !funnel);
    } catch (error) { return errorResponse(error); }
  }

  // installing an update on this PC (Ovis or herdr; a check installs too where OVIS_AUTO_UPDATE=1) is the owner's, as changing its PCs is (machine-api.ts): from any device
  // he signed in or paired himself. The connection server's bridge token asks its own install by revision (bridgeUpdatePath)
  if (request.method === "POST" && (pathname === "/api/updates/install" || pathname === "/api/updates/cancel" || pathname === "/api/updates/check" || pathname === "/api/herdr/update") && !ownerAccess(access) && !(bridgeAuthorized && bridgeUpdatePath)) {
    setRequestRoute(pathname);
    return jsonResponse({ error: { code: "forbidden", message: "Only the owner's own signed-in or paired devices can update this PC, from this app's own page." } }, 403);
  }
  if (pathname === "/api/updates" || pathname.startsWith("/api/updates/")) {
    // the bridge token cannot read /api/access: where this server answers comes with its update status (#2191)
    const where = bridgeAuthorized ? async () => {
      const port = ctx.port ?? DEFAULT_PORT;
      const serving = await remoteAccess(port, undefined, tailscaleCli(ctx)).then((access) => access.tailscale.serving_url, () => null);
      return { port, serving_url: serving };
    } : undefined;
    return handleUpdateRequest(request, pathname, options.updates, where);
  }
  if (pathname === "/api/herdr/update") { setRequestRoute(pathname); return handleHerdrUpdateRequest(request, options.herdrUpdate); }
  if (pathname === "/api/portal" || pathname.startsWith("/api/portal/")) {
    return handlePortalRequest(request, pathname, options.portal, { port: ctx.port ?? DEFAULT_PORT, ...portalGuards() });
  }
  if (pathname === "/api/account/lock" || pathname === "/api/account/unlock") {
    const lockRoutes = ctx.services.lockRoutes;
    if (lockRoutes !== undefined) return lockRoutes(request, pathname, access, ownWindow);
  }
  if (pathname.startsWith("/api/account/")) return handleAccountRequest(request, pathname, ctx, access);
  if (pathname === "/api/relay" || pathname.startsWith("/api/relay/")) {
    // the paired device that asks, when one does: a pairing code it starts or is handed goes with it (DeviceStore.revoke)
    return handleRelayRequest(request, pathname, ctx, access.level === "full" ? access.device?.id ?? null : null, access.level === "full" && access.via === "local", ownWindow);
  }
  if (pathname === "/api/connection-diagnostics") { setRequestRoute(pathname); return clientConnectionLog.handle(request, client ?? "unknown"); }
  if (pathname === "/api/telemetry") { setRequestRoute(pathname); return handleTelemetryRequest(request, options.telemetry); }
  // what every browser of this server shares; a watching device reads it and cannot change it (above)
  if (pathname === "/api/preferences") { setRequestRoute(pathname); return handlePreferencesRequest(request, preferences); }
  // the finishes read in some browser of this server; a watching device reads them and cannot add to them (above)
  if (pathname === "/api/seen") { setRequestRoute(pathname); return handleSeenRequest(request, seen); }

  if (pathname === "/api/system") { setRequestRoute(pathname); return handleSystemRequest(request, ctx.services.systemSampler); }
  if (pathname === USER_FONTS_PATH || pathname.startsWith(`${USER_FONTS_PATH}/`)) return handleUserFontsRequest(request, pathname, ctx.services.fontsDir, url.search);
  if (pathname === "/api/usage") { setRequestRoute(pathname); return handleUsageRequest(request, url, ctx.services.usageAccounts); }
  if (pathname === "/api/usage/accounts") { setRequestRoute(pathname); return ctx.services.usageAccounts.handle(request); }
  // on or off only: the server decides what is installed and where (server/statusline-install.ts)
  if (pathname === "/api/usage/statusline") { setRequestRoute(pathname); return handleStatuslineRequest(request, usage); }
  if (pathname === "/api/usage/login") { setRequestRoute(pathname); ctx.timeout(request, 30); return usageLogin.handle(request, collector.trackPane, loginOwner); }
  // the browser's sign-in dialog: a followed login's prompt, the code its page showed, and stopping it (a watching device: none)
  if (pathname === "/api/usage/login/prompt" || pathname === "/api/usage/login/code" || pathname === "/api/usage/login/cancel") { setRequestRoute(pathname); return usageLogin.handlePrompt(request, readOnly, loginOwner); }
  if (pathname === "/api/cliproxy" || pathname.startsWith("/api/cliproxy/")) { ctx.timeout(request, 60); return cliProxyRoutes.handle(request); }
  // a long clip can keep the provider silent past Bun's 10 s idle limit before the first line
  if (pathname === "/api/voice" || pathname.startsWith("/api/voice/")) { ctx.timeout(request, 120); return handleVoiceRequest(request, pathname, voice); }
  // Settings → Memory: every change is a person's on a screen; the bridge token never reaches it (not a bridge path)
  if (pathname === "/api/memory" || pathname.startsWith("/api/memory/")) {
    const by = access.level !== "full" ? "unknown" : access.device ? `device:${access.device.id}` : access.via;
    return handleMemoryRequest(request, url, ctx.services.memory, { readOnly, by });
  }

  // Settings → Alerts → Also send to: one destination this PC also posts its alerts to (a watching device: none, above)
  if (pathname === "/api/alerts/webhook" || pathname === "/api/alerts/webhook/test") {
    // its owner as a push subscription's: a paired device, null for a local/token/Tailscale sign-in, undefined for the open LAN
    const owner = access.level !== "full" ? null : access.device?.id ?? (access.via === "open" ? undefined : null);
    try { return (await handleAlertWebhookRequest(request, pathname, alertWebhook, owner))!; } catch (error) { return errorResponse(error); }
  }
  if (pathname === "/api/push" || pathname.startsWith("/api/push/")) {
    try {
      // a paired device owns its alerts; the open LAN (before any pairing) owns them only while
      // it stays open, like a subscription from before owners (undefined); a local/token/
      // Tailscale sign-in is the owner (null)
      const owner = access.level !== "full" ? null : access.device?.id ?? (access.via === "open" ? undefined : null);
      // the subscription remembers its browser's stream keys, so that browser's own pairing is not
      // pushed to it whoever owns the subscription; a browser without one gets one here
      const presentedKeys = streamKeys(request);
      const issuedKey = presentedKeys.length === 0 && request.method === "POST" && pathname === "/api/push/subscribe" ? newStreamKey() : null;
      const answered = await handlePushRequest(request, pathname, push, owner, issuedKey === null ? presentedKeys : [issuedKey]);
      if (answered && issuedKey !== null && answered.ok) answered.headers.append("set-cookie", streamCookie(issuedKey, isSecureRequest(request)));
      if (answered) return answered;
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api/health") {
    setRequestRoute(pathname);
    const own = ownWindow && ctx.services.lockRoutes !== undefined ? { own_window: true as const } : {};
    const auth: HealthAuth = access.level === "full"
      ? { required: false, authenticated: true, via: access.via, role: access.role, ...(access.via === "token" && bearerMatches(request, token) ? { bearer: true as const } : {}), ...(access.portal ? { portal: access.portal } : {}), ...own }
      // a window refused at the door of a locked PC is told the PC is locked, never offered a pairing it cannot use (T47, N4)
      : { required: true, authenticated, ...(authenticated ? {} : { reason: ctx.services.safetyLog?.state().locked === true && access.reason === "pairing_required" ? "locked" as const : access.reason }), ...own };
    // this server is open to the network with no token and nothing paired, told to a client
    // that got in and to nobody else: naming it to an anonymous caller would be
    // reconnaissance, not help. Nothing here changes who is let in (server/access.ts).
    const directCarriers = ctx.services.relay.status().direct?.carriers ?? [];
    const lan_exposure = access.level !== "full" ? undefined
      : lanExposed({ hostname, tokenConfigured: token !== "", gated: devices.gated }) ? { host: hostname } : undefined;
    // the relay's direct carrier: on the network, but for devices paired through the relay only, and said in those
    // words. A field of its own: a 0.4.x client takes any lan_exposure for an open server.
    const direct_exposure = access.level !== "full" || lan_exposure || directCarriers.length === 0 ? undefined
      : { host: new URL(directCarriers[0]!.replace(/^ws:/, "http:")).hostname };
    const exposure = { ...(lan_exposure ? { lan_exposure } : {}), ...(direct_exposure ? { direct_exposure } : {}) };
    // what protects this server, for a client that got in (a watching one too) and nobody else;
    // per request, so never stored. The ingress is this request's, proven or `unknown`
    const ingress = requestIngress(true);
    const security: SecuritySummary | undefined = access.level === "full" ? {
      token_configured: token !== "",
      pairing_gate: devices.error !== null || devices.failsClosed ? "unavailable" : devices.gated ? "closed" : "open",
      bind_scope: bindScope(hostname),
      observed_ingress: ingress,
      public_exposure: ingress === "funnel" ? "observed" : "unknown",
    } : undefined;
    const securityHeaders: Record<string, string> = security ? { "cache-control": "no-store" } : {};
    const relay = access.level === "full" ? { relay: ctx.services.relay.status() } : {};
    const serverId = access.level === "full" && access.via !== "open" ? ctx.services.relay.serverId() : undefined;
    // what this PC has of the Herdr app's runtime, for Settings: never waited for, no path in it.
    // Only a driving owner is told: a session name can name a project, which a watching device, a
    // stranger on an open install or a Portal visitor (who may not switch it) has no need to read
    const owner = access.level === "full" && access.role === "drive" && access.via !== "open" && access.via !== "portal";
    // the connection server that reaches this PC with its bridge token shows its move badge from them
    const herdr_runtime = owner || bridgeAuthorized ? options.runtimeService?.facts() : undefined;
    // the devices the owner is shown apart (`ovis status`): outside the account, and members on their own word
    const account_devices = owner ? devices.accountGroups() : undefined;
    if (options.profile === "machine") {
      const health = await machineHealth(options.machineEngine ?? "herdr", await options.machineRefusal?.());
      return jsonResponse({ ok: true, auth, version, runtime: "herdr", ...relay, ...health,
        ...(health.herdr ? { herdr: attachableIdentity(health.herdr, sidecar) } : {}), ...(account_devices ? { account_devices } : {}),
        ...(security ? { security } : {}), web_ui: { boot_id: bootId, ...(serverId ? { server_id: serverId } : {}) },
      }, 200, { "cache-control": "no-store" });
    }
    // this PC's own window, and the port it reaches this server on: where the page may sign in to the account through
    // the loopback redirect, an app's own sign-in (src/lib/account/ownWindow.ts); any other window signs in with a code
    const own_window = ownWindow && ctx.port !== undefined ? { port: ctx.port } : undefined;
    if (url.searchParams.get("scope") === "bridge") return jsonResponse({ ok: true, auth, bridge_protocol: BRIDGE_PROTOCOL, ...relay, ...(own_window ? { own_window } : {}), ...(security ? { security } : {}), web_ui: { boot_id: bootId }, runtime: runtime(), ...(options.launchAccepted ? { accepted: options.launchAccepted() } : {}), ...(herdr_runtime ? { herdr_runtime } : {}) }, 200, securityHeaders);
    const herdr_core = owner ? options.herdrCoreFacts?.() : undefined;
    try {
      const info = await ping();
      // a forced answer (tests) and a runtime without the PTY sidecar are told the way a Windows herdr's own would be
      const herdr = attachableIdentity(info, sidecar);
      // this server's own version (package.json, embedded in the compiled binary), told with the other facts to a client that got in
      return jsonResponse({ ok: true, herdr, auth, ...(access.level === "full" ? { version } : {}), ...relay, ...exposure, ...(security ? { security } : {}), ...(herdr_core ? { herdr_core } : {}), ...(herdr_runtime ? { herdr_runtime } : {}), ...(account_devices ? { account_devices } : {}),
        web_ui: { boot_id: bootId, revision: process.env["OVIS_REVISION"] ?? null, ...(serverId ? { server_id: serverId } : {}) } }, 200, securityHeaders);
    } catch (error) {
      const failed = errorResponse(error);
      if (!lan_exposure && !direct_exposure) return failed;
      const body: unknown = await failed.json();
      return jsonResponse({ ...(body !== null && typeof body === "object" ? body : {}), ...exposure }, failed.status, { "cache-control": "no-store" });
    }
  }

  if (pathname === "/api/runtime") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    if (!updateRequestAllowed(request)) return jsonResponse({ error: { code: "forbidden", message: "a runtime switch must come from this app's own page" } }, 403);
    // only a driving owner, never a watching device, a stranger on an open install or a Portal visitor
    // (the move's own boundary, moveDriver below)
    if (!(access.level === "full" && access.role === "drive" && access.via !== "open" && access.via !== "portal")) return jsonResponse({ error: { code: "forbidden", message: "only a device that drives this PC can switch its runtime" } }, 403);
    if (!options.runtimeService) return jsonResponse({ error: { code: "runtime_locked", message: "this server cannot switch its runtime" } }, 409);
    let body: unknown;
    try { body = await request.json(); } catch { return badRequest("invalid_json", "send { \"runtime\": \"herdr\" | \"herdr-core\" }"); }
    if (ctx.services.runtimeMove?.busy()) return jsonResponse({ error: { code: "runtime_switching", message: "a move to herdr-core is waiting or running" } }, 409);
    const answer = options.runtimeService.request(body !== null && typeof body === "object" ? (body as Record<string, unknown>)["runtime"] : undefined);
    return answer.ok ? jsonResponse({ accepted: true }, 202) : jsonResponse({ error: { code: answer.code, message: answer.message } }, answer.status);
  }

  // who may move this PC's runtime: a driving owner, or the connection server holding the bridge token,
  // which already drives every pane here. A Portal visitor never, whatever its role. A relay device that
  // drives may: a connection server reaches a PC added through the relay as one
  const moveDriver = bridgeAuthorized || access.level === "full" && access.role === "drive" && access.via !== "open" && access.via !== "portal";

  if (pathname === `${RUNTIME_MOVE_PATH}/install`) {
    setRequestRoute(pathname);
    // downloads and runs a program on this PC: the runtime switch's own boundary, and only from this app's page
    if (!moveDriver) return jsonResponse({ error: { code: "forbidden", message: "only a device that drives this PC can install herdr-core" } }, 403);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    // its download alone may take 120 s (herdr-core/install.ts): the answer outlasts the usual minute, as
    // another PC's proxy waits for it (machine-api.ts slowMachinePath)
    ctx.timeout(request, 180);
    if (!updateRequestAllowed(request)) return jsonResponse({ error: { code: "forbidden", message: "an install must come from this app's own page" } }, 403);
    const move = ctx.services.runtimeMove;
    if (!move) return jsonResponse({ error: { code: "runtime_locked", message: "this server cannot switch its runtime" } }, 409);
    try {
      const refused = await move.install();
      if (refused === null) return jsonResponse({ installed: true });
      return jsonResponse({ error: { code: refused, message: refused === "installing" ? "herdr-core is already being installed" : "Ovis offers no herdr-core install here" } }, 409);
    } catch (error) {
      return jsonResponse({ error: { code: "install_failed", message: error instanceof Error ? error.message : String(error) } }, 502);
    }
  }

  if (pathname === `${RUNTIME_MOVE_PATH}/stop`) {
    setRequestRoute(pathname);
    // ends a command in a pane of this PC: the move's own boundary, and only from this app's page
    if (!moveDriver) return jsonResponse({ error: { code: "forbidden", message: "only a device that drives this PC can end a pane's command" } }, 403);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    if (!updateRequestAllowed(request)) return jsonResponse({ error: { code: "forbidden", message: "a stop must come from this app's own page" } }, 403);
    const move = ctx.services.runtimeMove;
    if (!move) return jsonResponse({ error: { code: "runtime_locked", message: "this server cannot switch its runtime" } }, 409);
    let body: unknown;
    try { body = await request.json(); } catch { return badRequest("invalid_json", "send { \"pane_id\": \"...\", \"force\"?: true }"); }
    const fields = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const paneId = fields["pane_id"];
    if (typeof paneId !== "string" || paneId === "") return badRequest("invalid_pane", "pane_id must name a pane of the plan");
    if (fields["force"] !== undefined && typeof fields["force"] !== "boolean") return badRequest("invalid_force", "force must be true or false");
    const command = fields["command"];
    if (command !== undefined && typeof command !== "string") return badRequest("invalid_command", "command must name the command shown");
    try {
      const refused = await move.stopPane(paneId, fields["force"] === true, command);
      if (refused === null) return jsonResponse({ ok: true });
      return jsonResponse({ error: { code: refused, message: stopRefusalText(refused) } }, 409);
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === `${RUNTIME_MOVE_PATH}/stop-all`) {
    setRequestRoute(pathname);
    // ends commands in panes of this PC: the move's own boundary, and only from this app's page
    if (!moveDriver) return jsonResponse({ error: { code: "forbidden", message: "only a device that drives this PC can end a pane's command" } }, 403);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    if (!updateRequestAllowed(request)) return jsonResponse({ error: { code: "forbidden", message: "a stop must come from this app's own page" } }, 403);
    const move = ctx.services.runtimeMove;
    if (!move) return jsonResponse({ error: { code: "runtime_locked", message: "this server cannot switch its runtime" } }, 409);
    let body: unknown;
    try { body = await request.json(); } catch { return badRequest("invalid_json", "send {} to ask, or { \"token\": \"...\" } to confirm"); }
    const token = body !== null && typeof body === "object" ? (body as Record<string, unknown>)["token"] : undefined;
    if (token !== undefined && (typeof token !== "string" || token === "")) return badRequest("invalid_token", "token must be the one the ask returned");
    try {
      if (token === undefined) {
        const offer = await move.prepareStopAll();
        return offer === "not_waiting" ? jsonResponse({ error: { code: offer, message: stopRefusalText(offer) } }, 409) : jsonResponse(offer);
      }
      const refused = await move.stopAll(token);
      if (refused === null) return jsonResponse({ ok: true });
      return jsonResponse({ error: { code: refused, message: refused === "no_offer" ? "that confirm is used or unknown: ask again" : stopRefusalText(refused) } }, 409);
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === RUNTIME_MOVE_PATH) {
    setRequestRoute(pathname);
    // folders and conversation ids of every pane, and agents ended and started: the runtime switch's own boundary
    if (!moveDriver) return jsonResponse({ error: { code: "forbidden", message: "only a device that drives this PC can move its runtime" } }, 403);
    const move = ctx.services.runtimeMove;
    if (!move) return jsonResponse({ error: { code: "runtime_locked", message: "this server cannot switch its runtime" } }, 409);
    if (request.method === "GET") {
      try { return jsonResponse(await move.read(), 200, { "cache-control": "no-store" }); } catch (error) { return errorResponse(error); }
    }
    if (request.method !== "POST" && request.method !== "DELETE") return badRequest("method_not_allowed", "use GET, POST or DELETE");
    if (!updateRequestAllowed(request)) return jsonResponse({ error: { code: "forbidden", message: "a runtime move must come from this app's own page" } }, 403);
    if (request.method === "DELETE") { move.cancel(); return jsonResponse({ ok: true }); }
    let body: unknown;
    try { body = await request.json(); } catch { return badRequest("invalid_json", "send { \"revision\": \"...\" }"); }
    const revision = body !== null && typeof body === "object" ? (body as Record<string, unknown>)["revision"] : undefined;
    if (typeof revision !== "string" || revision === "") return badRequest("invalid_revision", "revision must name the plan shown");
    try {
      const refused = await move.start(revision);
      if (refused === null) return jsonResponse({ accepted: true }, 202);
      if (refused === "locked") return jsonResponse({ error: { code: "already_moving", message: "Another Ovis on this PC is moving this herdr session already: its own page, or a connection server reaching it. Wait for that move to end; a holder that stopped lets go on its own." } }, 409);
      // why the lock cannot be taken here, in MoveLockUnsafe's own words (none names a path)
      if (typeof refused === "object") return jsonResponse({ error: { code: "move_lock_unsafe", message: refused.lock_unsafe } }, 409);
      return jsonResponse({ error: { code: refused, message: refused === "plan_changed" ? "the panes changed since the plan was shown: look again" : refused === "already_moving" ? "a move is already waiting or running" : refused === "runtime_switching" ? "the server is switching its runtime: try again once it is back" : "no move to herdr-core is offered here" } }, 409);
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api/herdr-ui") {
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    return jsonResponse(readHerdrUi(options.herdrConfigPath), 200, { "cache-control": "no-store" });
  }

  if (tailscaleControl) {
    setRequestRoute(pathname);
    const refuse = (code: string, message: string, status: number, extra: Record<string, unknown> = {}) =>
      jsonResponse({ error: { code, message, ...extra } }, status, { "cache-control": "no-store" });
    if (request.method !== "POST") return refuse("method_not_allowed", "use POST", 405);
    if (request.headers.get("x-herdr-machine") !== "1") return refuse("invalid_origin", "Use controls from this app", 403);
    if (pathname === TAILSCALE_CONTROLS.open) {
      const opened = openTailscaleApp();
      if (opened.ok) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      if (opened.detail !== undefined) console.warn(`Tailscale app did not open: ${opened.detail}`);
      return refuse(opened.code, "This PC has no Tailscale app to open.", 409);
    }
    // a tailnet request gets in as this PC's owner only by that login (server/access.ts decideAccess): with no owner
    // known, a serve could open Ovis to another login's tailnet request, so nothing is run
    if ((await identityOf(false, requestHost, true)).owner === null) return refuse("tailscale_owner_unknown", "This PC's Tailscale login is not known: Ovis is not served.", 409);
    const served = await serveTailscale(ctx.port ?? DEFAULT_PORT, undefined, tailscaleCli(ctx));
    if (served.ok) return jsonResponse({ ...served.access, relay: ctx.services.relay.status() }, 200, { "cache-control": "no-store" });
    // the CLI's own words go to this PC's log only, never to the page
    if (served.detail !== undefined) console.warn(`tailscale serve refused: ${served.detail}`);
    return refuse(served.code, "Tailscale did not serve Ovis here.", 409, served.operator === true ? { operator: true } : {});
  }

  if (pathname === "/api/access") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    return jsonResponse({ ...await remoteAccess(ctx.port ?? DEFAULT_PORT, undefined, tailscaleCli(ctx)), relay: ctx.services.relay.status() }, 200, { "cache-control": "no-store" });
  }

  if (pathname === "/api/session") {
    setRequestRoute(pathname);
    try {
      // another Ovis server reading this PC (its bridge token) applies its own rows; a browser gets this server's
      const snapshot = await clientSnapshot();
      return jsonResponse({ snapshot: bridgeAuthorized ? snapshot : browserSnapshot(snapshot) }, 200, wordedHeaders());
    } catch (error) {
      return options.profile === "machine" ? machineReadError(error, options.machineEngine ?? "herdr", engineRefusal) : errorResponse(error);
    }
  }

  const agentsResponse = await handleAgentsRequest(request, pathname, shellAgents, agentOffered);
  if (agentsResponse) return agentsResponse;

  const installResponse = await agentInstaller.handle(request, pathname);
  if (installResponse) return installResponse;
  const catalogResponse = await handleAgentCatalogRequest(request, pathname, agentDetector, undefined, readOnly);
  if (catalogResponse) return catalogResponse;

  const integrationsResponse = await handleIntegrationsRequest(request, pathname);
  if (integrationsResponse) return integrationsResponse;

  const filesResponse = await handleFileRequest(request, url, pathname, { bridgeAuthorized, requestHost, forwarded, client, access });
  if (filesResponse) return filesResponse;

  const workspaceResponse = await handleWorkspaceRequest(request, url, pathname, ctx, broadcastAll, { ask: askFirstMessage, queue: queueFirstMessage }, () => {
    const receipt = orderSequence.moved();
    void machines?.refreshLocal();
    return receipt;
  }, shellAgents, options.localFiles !== false);
  if (workspaceResponse) return workspaceResponse;

  const pluginResponse = await handlePluginRequest(request, url, pathname, options);
  if (pluginResponse) return pluginResponse;

  const paneResponse = await handlePaneRequest(request, url, pathname, options);
  if (paneResponse) return paneResponse;

  const tasksResponse = await handleTasksRequest(request, url, pathname, { omo, claudeAgents, opencodeAgents });
  if (tasksResponse) return tasksResponse;

  // a GET a watching device may make on purpose: a subagent's prose and tool-call arguments (which can carry file
  // contents) are what the live conversation already shows it of the agents of this pane
  if (pathname === BACKGROUND_AGENT_PATH) {
    return handleBackgroundAgentRequest(request, url, { paneGet, omoPane: (paneId) => omo.sessionOf(paneId) !== null, claudeAgents, opencodeAgents, read: options.backgroundAgentRead });
  }

  const planResponse = await handlePlanRequest(request, url, pathname, { omo, claudeAgents, plans });
  if (planResponse) return planResponse;

  const artifactsResponse = await handleArtifactsRequest(request, url, pathname, { claudeAgents });
  if (artifactsResponse) return artifactsResponse;

  const btwResponse = await handleBtwRequest(request, url, pathname, {
    transcript: (paneId) => paneTranscript(paneId, options.codexHome, undefined, options.devinDbPath, options.opencodeDb, options.hermesHome, options.grokHome, options.museData).then(
      (found) => found.source === "omp-transcript" ? found.path : null,
      (error: unknown) => { if (error instanceof ConversationUnavailable) return null; throw error; },
    ),
  });
  if (btwResponse) return btwResponse;

  if (pathname === SESSION_HISTORY_PATH) {
    setRequestRoute(SESSION_HISTORY_PATH);
    return handleSessionHistoryRequest(request, url, { readOnly, stores: { codexHome: options.codexHome, opencodeDb: options.opencodeDb, hermesHome: options.hermesHome, piReader } });
  }

  if (pathname === SESSION_RESUME_PATH) {
    setRequestRoute(SESSION_RESUME_PATH);
    // agent.start can legitimately take a minute; Bun's default idle timeout is shorter
    return handleSessionResumeRequest(request, { readOnly, stores: { codexHome: options.codexHome, opencodeDb: options.opencodeDb, hermesHome: options.hermesHome }, holdOpen: (seconds) => ctx.timeout(request, seconds) });
  }

  if (acp && (pathname === "/api/pane/turn/cancel" || pathname === "/api/pane/turn/release" || pathname === "/api/pane/turn/cancel-children")) {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "Use POST.");
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    if (typeof body.pane_id !== "string") return badRequest("missing_pane_id", "pane_id is required.");
    if (pathname.endsWith("/cancel-children")) {
      // every ACP child the pane started gets the same hold as its own Stop; one a person holds already keeps its hold
      // (a new one would cancel the turn that person started), and one that cannot take it is named
      let children;
      try { children = await acp.childrenOf(body.pane_id); } catch (error) { return errorResponse(error); }
      const tried = await Promise.allSettled(children.map(async child => {
        if (!child.client.connected || !child.client.session) throw new Error("not connected");
        if (child.client.holdGeneration !== null) return { pane_id: child.terminal, child_id: child.id, generation: child.client.holdGeneration };
        return { pane_id: child.terminal, child_id: child.id, generation: await child.client.hold(child.client.session) };
      }));
      return jsonResponse({
        ok: true,
        held: tried.flatMap(outcome => outcome.status === "fulfilled" ? [outcome.value] : []),
        failed: children.filter((_, index) => tried[index]?.status === "rejected").map(child => child.terminal),
      });
    }
    const child = acp.forPane(body.pane_id);
    if (!child?.client.connected || !child.client.session) return badRequest("unavailable", "No connected ACP child.");
    const cancel = pathname.endsWith("/cancel");
    if (!cancel && (body.child_id !== child.id || !Number.isSafeInteger(body.generation))) return badRequest("hold_changed", "The child and hold generation are required.");
    try {
      if (cancel) return jsonResponse({ ok: true, child_id: child.id, generation: await child.client.hold(child.client.session) });
      const receipt = await child.client.request("_keeper/release", { sessionId: child.client.session, generation: body.generation });
      if (!receipt || typeof receipt !== "object" || !("released" in receipt && receipt.released === true)) return badRequest("unavailable", "No keeper receipt.");
      return jsonResponse({ ok: true, child_id: child.id, ...receipt });
    } catch { return badRequest("hold_changed", "The keeper could not confirm that operation."); }
  }
  if (pathname.startsWith("/api/pane/prompt")) {
    try {
      const response = await handlePromptRequest(request, url, { serialize, codexHome: options.codexHome, claudeTranscript: (paneId) => claudeAgents.sessionOf(paneId)?.path ?? null, readOnly, openCodeStateDir: options.openCodeStateDir, openCodeState, approvals, ...(acp ? { acp } : {}), ...(options.telemetry ? { onAnswering: (paneId: string) => options.telemetry!.answering(paneId) } : {}) });
      if (response) return response;
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname.startsWith("/api/")) {
    return jsonResponse({ error: { code: "not_found", message: `unknown endpoint ${pathname}` } }, 404);
  }

  // static client - public even when the API is gated, so the login UI can load
  setRequestRoute("static");
  return serveStatic(pathname, request.headers.get("accept-encoding"), requestOrigin(request));
  })());
  });
}

function stopRefusalText(refused: StopRefusal): string {
  switch (refused) {
    case "not_waiting": return "no move is waiting";
    case "not_running": return "that pane is not a shell running a command";
    case "changed": return "the panes changed since you looked: look again";
    case "own_server": return "that pane runs this Ovis server";
    case "own_group_unknown": return "Ovis cannot tell its own process group here, so it ends nothing";
    case "not_tried": return "send Ctrl+C first, and force only once it has had a few seconds";
    case "not_local": return "this PC does not show that command in front of its shell, so Ovis does not signal it";
  }
}
