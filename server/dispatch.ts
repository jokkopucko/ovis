import { handleWorkspaceRequest } from "./workspace-routes.ts";
import { handleAlertWebhookRequest } from "./alert-webhook.ts";
import { connectionData, type createCore, type SocketData } from "./core/index.ts";
import type { ClientConnectionLog } from "./client-connection-log.ts";
import type { RequestLog } from "./request-log.ts";
import { handlePaneRequest } from "./pane-routes.ts";
import { handleIntegrationsRequest } from "./integrations-routes.ts";
import type { OrderSequence } from "./order-sequence.ts";
import type { DevicePairedEvent, DeviceRemovedEvent, HealthAuth, RelayPairingsEvent, RemotePairingsEvent, SecuritySummary, SessionSnapshot } from "../shared/protocol.ts";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import { authClient, deviceAuthorizationValue, deviceCookieValue, bearerMatches, handleAuthRequest, isAuthenticated, isSecureRequest, parseCookies, presentedToken, presentedTokenHeld, recordPresentedTokenFailure, requiresAuth, unauthorizedJson } from "./auth.ts";
import { bindScope, cameThroughProxy, decideAccess, forwardingHeaders, inTailnet, isLoopbackAddress, isServeOwnerRequest, lanExposed, observedIngress, ownerAccess } from "./access.ts";
import { type DeviceStore, handleDeviceRequest, newStreamKey, sameBrowser, streamCookie, streamKeys, type DeviceMatch } from "./devices.ts";
import { handlePreferencesRequest, type PreferenceStore } from "./preferences.ts";
import { handleSeenRequest, type SeenStore } from "./seen.ts";
import { remoteAccess } from "./tailscale.ts";
import { badRequest, errorResponse, jsonResponse, setRequestRoute } from "./http.ts";
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
import { RUNTIME_MOVE_PATH, RUNTIME_MOVE_ROUTE } from "./runtime-move.ts";
import type { StopRefusal } from "./runtime-move-service.ts";
import type { MoveService } from "./runtime-move-service.ts";
import { handlePushRequest } from "./push.ts";
import { handlePromptRequest, type OpenCodePromptState } from "./prompt.ts";
import { attachableIdentity } from "./pty/sidecar.ts";
import { runtime } from "./herdr-core/runtime.ts";
import { handleUpdateRequest, updateRequestAllowed } from "./update-api.ts";
import { handleHerdrUpdateRequest } from "./herdr-update.ts";
import { handlePortalRequest } from "./portal.ts";
import { handleRelayRequest } from "./relay/routes.ts";
import { handleAccountRequest } from "./account/routes.ts";
import type { AccountMailbox } from "./account/mailbox.ts";
import type { AccountHolds } from "./account/holds.ts";
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
import { BRIDGE_PROTOCOL } from "../shared/machines.ts";
import { bridgeIdentity } from "./bridge.ts";
import { discoverHerdrSessions } from "./herdr-discovery.ts";
import { handleMachineRequest, nonCanonicalPath, slowMachinePath, type EventStreamBudget } from "./machine-api.ts";
import { handleSessionHistoryRequest, handleSessionResumeRequest, SESSION_HISTORY_PATH, SESSION_RESUME_PATH } from "./session-history-routes.ts";
import type { PiSessionReader } from "./pi-session-metadata.ts";
import type { HerdrSidebarConfig } from "./herdr-sidebar.ts";
import { readHerdrUi } from "./herdr-ui.ts";
import { MachineRelay, type RelayReceiptIds } from "./machine-relay.ts";
import { sameOrigin } from "./machine-security.ts";
import { handlePluginRequest } from "./plugin-routes.ts";
import type { createServer } from "./index.ts";
import type { TailnetIdentity } from "./tailscale.ts";
import type { CLIProxyRoutes } from "./cliproxy-routes.ts";
import type { UsageLoginService } from "./usage-login.ts";
import type { UsageService } from "./usage.ts";
import type { VoiceService } from "./voice.ts";

type PortalStartup = { ok: true } | { ok: false; error: unknown };

/** Per-server services shared by socket requests and other dispatch callers. */
export interface RequestServices {
  /** the move of herdr's session to herdr-core, where the runtime can be switched from here */
  readonly runtimeMove: MoveService | null;
  readonly relay: RelayService;
  readonly relayReceiptIds: RelayReceiptIds;
  readonly options: NonNullable<Parameters<typeof createServer>[0]>;
  readonly hostname: string;
  readonly token: string;
  readonly bridgeToken: string;
  readonly bootId: string;
  readonly devices: DeviceStore;
  readonly accountMailbox: AccountMailbox;
  readonly accountIntroductions: AccountIntroductions;
  readonly accountHolds: AccountHolds;
  readonly preferences: PreferenceStore;
  readonly herdrSidebar: HerdrSidebarConfig;
  /** `loginPath`: the request states a Tailscale login, so the PC's own login must be known, not merely cached as unknown */
  readonly identityOf: (grantPath: boolean, host: string | null, loginPath?: boolean) => Promise<TailnetIdentity>;
  readonly serveOnly: boolean;
  readonly portalGuards: () => { tokenSet: boolean; serveOnly: boolean };
  readonly shellAgents: ShellAgentLocator;
  readonly agentDetector: AgentDetector;
  readonly agentOffered: (kind: string) => Promise<boolean>;
  readonly agentInstaller: AgentInstaller;
  readonly openCodeState: OpenCodePromptState;
  readonly cliProxyRoutes: CLIProxyRoutes;
  readonly usageLogin: UsageLoginService;
  readonly usage: UsageService;
  readonly usageAccounts: UsageAccountList;
  readonly systemSampler: SystemSampler | null;
  /** the state folder's fonts/, served to every device that may read this PC (server/user-fonts.ts) */
  readonly fontsDir: string;
  readonly voice: VoiceService;
  readonly browserSnapshot: <S extends SessionSnapshot>(snapshot: S) => S;
  readonly core: ReturnType<typeof createCore>;
  readonly seen: SeenStore;
  readonly piReader: PiSessionReader;
  readonly orderSequence: OrderSequence;
  readonly clientConnectionLog: ClientConnectionLog;
  readonly requestLog: RequestLog;
  readonly portalStartupResult: PortalStartup | undefined;
  readonly portalStartup: Promise<PortalStartup>;
}

/** The transport operations a request needs; peer kinds are extended with relay authentication. */
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
   * The request came to the opt-in LAN HTTPS listener (server/lan-https.ts), from a private IPv4 peer:
   * it gets in only with the token or a paired device, never as an open install, by the bridge token,
   * and its wrong tokens share one budget with every other peer there.
   */
  readonly lanHttps?: boolean;
}

/** The routes that read or write files and folders on this disk (or run git and gh in them) for a pane, a workspace or a picker. */
const OTHER_MACHINE_FILES = /^\/api\/(?:fs\/|pane\/(?:files|docs|image)$|workspace\/(?:diff\/|git\/|directories$|pr(?:$|\/)))/;

export async function handleRequest(request: Request, ctx: ServerContext): Promise<Response | undefined> {
  const { options, hostname, token, bridgeToken, bootId, devices, preferences, herdrSidebar, identityOf, serveOnly, portalGuards, shellAgents, agentDetector, agentOffered, agentInstaller, openCodeState, cliProxyRoutes, usageLogin, usage, voice, browserSnapshot, core, seen, piReader, orderSequence, clientConnectionLog, requestLog, portalStartupResult, portalStartup } = ctx.services;
  const { sidecar, serialize, push, alertWebhook, logPushError, omo, claudeAgents, opencodeAgents, plans, clientSnapshot, machines, broadcastAll, collector, queueFirstMessage } = core;
  return requestLog.handle(request, async (headers) => {
  const startup = portalStartupResult ?? await portalStartup;
  if (!startup.ok) {
    setRequestRoute("startup");
    return compressResponse(request, errorResponse(startup.error));
  }
  // the route's answer, gzipped for a browser that takes it (server/compress.ts)
  return compressResponse(request, await (async (): Promise<Response | undefined> => {
  const url = new URL(request.url);
  let { pathname } = url;
  const relayPeer = ctx.peer.kind === "relay" ? ctx.peer.device : undefined;
  const bridgeAuthorized = relayPeer === undefined && ctx.lanHttps !== true && isAuthenticated(request, bridgeToken);
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
    pairedDevice = relayPeer ?? devices.match(deviceAuthorizationValue(request) ?? deviceCookieValue(parseCookies(request.headers.get("cookie"))));
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
  const access = decideAccess({
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
  const authenticated = access.level === "full" || (bridgePath && bridgeAuthorized);

  if (requiresAuth(pathname) && !authenticated) {
    setRequestRoute("auth-refusal");
    // a script's Bearer guess is told to wait; a browser's cookie gets the usual 401 and its sign-in form
    if (presented === "held" && pathname !== "/ws" && request.headers.has("authorization")) return presentedTokenHeld(client);
    // The WS client never parses a body, so the upgrade refusal stays plain text.
    return pathname === "/ws" ? new Response("unauthorized", { status: 401 }) : unauthorizedJson(access.level === "none" ? access.reason : "token_required");
  }

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
  if (readOnly && (fileRead || directoryListing || repositoryDiff || pullRequest || sessionHistory || commandRows || paneFiles || pluginRun || worktreeList || pairingDigits || mutating && !ownPreferences)) {
    setRequestRoute("watch-refusal");
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
  if (access.level === "full" && (access.via === "open" || access.via === "portal") && pathname.startsWith("/api/account/")) {
    setRequestRoute("owner-refusal");
    return jsonResponse({ error: { code: "owner_only", message: "Manage the account from this PC itself, or from a paired device." } }, 403);
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
    if (!machines) return jsonResponse({ error: { code: "bridge_only", message: "Manage PCs on the connection server" } }, 404);
    // /local aliases preserve every existing endpoint without a self-proxy.
    if (pathname.startsWith("/api/machines/local/")) {
      if (!sameOrigin(request) || (request.method !== "GET" && request.headers.get("x-herdr-machine") !== "1")) return jsonResponse({ error: { code: "invalid_origin", message: "Use PC controls from this app" } }, 403);
      pathname = pathname.replace("/api/machines/local/", "/api/");
      if (!/^\/api\/(session|agents|agent-catalog$|agent-catalog\/(?:install|sign-in)$|integrations|pane\/|workspace\/|worktree\/|tab\/|layout\/ratio$|agent\/(?:rename|commands)$|plugins\/actions$|plugin\/action$|sessions\/(?:history|resume)$)/.test(pathname)) return badRequest("invalid_route", "Unknown PC endpoint");
      url.pathname = pathname;
    } else {
      // a worktree made with an agent waits on git and then agent.start, up to 150 s on the PC, and a
      // resume on agent.start and then its store check (machine-api.ts slowMachinePath)
      // a move's install there is waited for 200 s (machine-api.ts): this connection is held a little longer still
      const machinePathAsked = pathname.split("/").slice(4).join("/");
      ctx.timeout(request, pathname === "/api/machines/events" ? 0 : machinePathAsked === "runtime/move/install" ? 210 : slowMachinePath(machinePathAsked) ? 180 : 80);
      const deviceId = access.level === "full" ? access.device?.id : undefined;
      // a device's enrollment is news to every stream but the new device's own: one the stream's
      // device cookie names, or one this browser asked for itself (its stream key, server/devices.ts),
      // which a stream opened before that device existed cannot know by its cookie. A browser
      // without a key gets one with this stream; a key is a cookie of its own name, so tabs that
      // open at once each add theirs and the pairing later carries all of them
      const presentedKeys = streamKeys(request);
      const issuedKey = presentedKeys.length === 0 && pathname === "/api/machines/events" ? newStreamKey() : null;
      const keys = issuedKey === null ? presentedKeys : [issuedKey];
      // a stream that came in through the open LAN is told nothing: every enrollment follows the write
      // that closed the gate, which ends the stream (endWithGate below), so whoever held it has no access left
      // by the time there is news
      const openAccess = access.level === "full" && access.via === "open";
      // a relay pairing waiting for approval reaches only a window that may approve it (server/relay/routes.ts):
      // driving, direct to this PC, and not a Portal visitor
      const approver = access.level === "full" && access.role === "drive" && access.via !== "open" && access.via !== "relay" && access.via !== "portal";
      // and through the relay to a drive account member, with three candidates instead of the digits (docs/account.md)
      const remoteApprover = ctx.peer.kind === "relay" && devices.isAccountApproverSession(ctx.peer.device.id, ctx.peer.key);
      const pairings = { subscribe: (listener: (event: DevicePairedEvent | DeviceRemovedEvent | RelayPairingsEvent | RemotePairingsEvent) => void) => {
        const stopPaired = devices.onPaired((event, origin) => { if (!openAccess && event.device_id !== deviceId && !sameBrowser(origin, keys)) listener(event); });
        // removals go to streams that may drive, as the client lane's device list needs (docs/account.md)
        const stopRemoved = !openAccess && access.level === "full" && access.role === "drive" ? devices.onRemoved(listener) : undefined;
        // a window that may not approve is told the list is empty, so one that lost the right (drive to watch) drops its prompts
        const stopRelay = approver ? ctx.services.relay.approvals.subscribe((list) => listener({ type: "relay-pairings", pairings: list }))
          : remoteApprover ? ctx.services.relay.approvals.subscribeRemote((list) => listener({ type: "remote-pairings", pairings: list })) : undefined;
        if (!approver) listener({ type: "relay-pairings", pairings: [] });
        return () => { stopPaired(); stopRemoved?.(); stopRelay?.(); };
      } };
      // a stream ends with what let it in: a device's revoke, the gate closing on one the open LAN let in, Portal's recheck
      const response = await handleMachineRequest(request, machines, deviceId ? (close) => devices.onRevoke(deviceId, close) : openAccess ? (close) => devices.endWithGate(close) : portalRecheckMs !== undefined ? (close) => { const timer = setTimeout(close, portalRecheckMs); return () => clearTimeout(timer); } : undefined, preferences, readOnly, herdrSidebar, seen, pairings, ctx.relayBodyBudget, ownerAccess(access));
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
          (browser) => ctx.services.relayReceiptIds.scope(machineId, principal, browser));
        await relay.ready;
        const upgraded = ctx.upgrade(request, { headers, data: connectionData({ relay, deviceId, readOnly, ...(access.level === "full" && access.via === "open" && !bridgeAuthorized ? { open: true } : {}), ...recheck }) });
        if (upgraded) return undefined;
        relay.close();
      } catch { relay?.close(); return new Response("remote websocket unavailable", { status: 502 }); }
      return new Response("websocket upgrade required", { status: 426 });
    }
    // what the daily active message counts of this visit: the page's kind of screen and the way it came in;
    // nothing for another server's bridge, or for a surface no page names (visitSurface)
    const observed = observedIngress({ ...requestShape, ...identity, peerKnown: ip !== null, forwardingHeaders: forwardingHeaders(request.headers) });
    const surface = bridgeAuthorized ? false : visitSurface(url.searchParams.get("surface"));
    const ingress: TelemetryIngress = observed === "direct" ? (loopback ? "local" : "lan") : observed;
    // Reuse the terminal socket for the same authorized event document as /api/machines/events.
    // A server-side switch keeps the old SSE path available for immediate transport rollback.
    const useMachineEvents = machines && !bridgeAuthorized && process.env["OVIS_MACHINE_EVENTS_WS"] !== "0";
    const presentedKeys = streamKeys(request);
    const issuedKey = useMachineEvents && presentedKeys.length === 0 ? newStreamKey() : null;
    const keys = issuedKey === null ? presentedKeys : [issuedKey];
    if (issuedKey !== null) headers.append("set-cookie", streamCookie(issuedKey, isSecureRequest(request)));
    const openAccess = access.level === "full" && access.via === "open";
    // relay pairings waiting for approval reach only a window that may approve one, as on /api/machines/events
    const approver = access.level === "full" && access.role === "drive" && access.via !== "open" && access.via !== "relay" && access.via !== "portal";
    const machineEvents = useMachineEvents ? {
      manager: machines, preferences, herdrSidebar, seen,
      pairings: { subscribe: (listener: (event: DevicePairedEvent | DeviceRemovedEvent | RelayPairingsEvent | RemotePairingsEvent) => void) => {
        const stopPaired = devices.onPaired((event, origin) => {
          if (!openAccess && event.device_id !== deviceId && !sameBrowser(origin, keys)) listener(event);
        });
        const stopRemoved = !openAccess && access.level === "full" && access.role === "drive" ? devices.onRemoved(listener) : undefined;
        // and through the relay to a drive account member holding its row's current key, as on /api/machines/events
        const remoteApprover = ctx.peer.kind === "relay" && devices.isAccountApproverSession(ctx.peer.device.id, ctx.peer.key);
        // a window that may not approve is told the list is empty, so one that lost the right (drive to watch) drops its prompts
        const stopRelay = approver ? ctx.services.relay.approvals.subscribe((list) => listener({ type: "relay-pairings", pairings: list }))
          : remoteApprover ? ctx.services.relay.approvals.subscribeRemote((list) => listener({ type: "remote-pairings", pairings: list })) : undefined;
        if (!approver) listener({ type: "relay-pairings", pairings: [] });
        return () => { stopPaired(); stopRemoved?.(); stopRelay?.(); };
      } },
    } : undefined;
    const upgraded = ctx.upgrade(request, { headers, data: connectionData({ machineEvents, deviceId, readOnly, ...(openAccess && !bridgeAuthorized ? { open: true } : {}), bridge: bridgeAuthorized, ...(surface ? { surface } : {}), ...(surface === false ? {} : { ingress }), ...recheck }) });
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
  if (pathname === "/api/devices" || pathname.startsWith("/api/devices/")) {
    try {
      // one device, or all of them: the registry names what was revoked, and the cleanup follows its ids
      return await handleDeviceRequest(request, pathname, devices, access, ctx.peer.kind === "relay" ? ctx.peer.key : null, (revoked) => {
        for (const id of revoked) {
          // The device registry is the delivery authority even if cleaning the push file fails.
          try { push.revokeDevice(id); } catch (error) { logPushError(error); }
          // and every page media address its renders were given
          forgetPageMedia({ device: id });
        }
      }, ctx.lanHttps === true, { list: () => ctx.services.relay.connections(), check: (ms) => ctx.services.relay.checkConnections(ms) });
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
    // the port is this server's own; a tailscale that cannot be read only leaves the https address out
    const where = bridgeAuthorized ? async () => {
      const port = ctx.port ?? DEFAULT_PORT;
      const serving = await remoteAccess(port).then((access) => access.tailscale.serving_url, () => null);
      return { port, serving_url: serving };
    } : undefined;
    return handleUpdateRequest(request, pathname, options.updates, where);
  }
  if (pathname === "/api/herdr/update") { setRequestRoute(pathname); return handleHerdrUpdateRequest(request, options.herdrUpdate); }
  if (pathname === "/api/portal" || pathname.startsWith("/api/portal/")) {
    return handlePortalRequest(request, pathname, options.portal, { port: ctx.port ?? DEFAULT_PORT, ...portalGuards() });
  }
  if (pathname.startsWith("/api/account/")) return handleAccountRequest(request, pathname, ctx, access);
  if (pathname === "/api/relay" || pathname.startsWith("/api/relay/")) {
    return handleRelayRequest(request, pathname, ctx);
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
    const auth: HealthAuth = access.level === "full"
      ? { required: false, authenticated: true, via: access.via, role: access.role, ...(access.via === "token" && bearerMatches(request, token) ? { bearer: true as const } : {}), ...(access.portal ? { portal: access.portal } : {}) }
      : { required: true, authenticated, ...(authenticated ? {} : { reason: access.reason }) };
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
    // per request, so never stored. The ingress is this request's, proven or `unknown`.
    // Portal's proof says how the request came even when the token or a paired device signed it in.
    // A Portal with no sign-in has no proof to send: a request from this PC in the shape it forwards
    // (X-Forwarded-Proto https) to an address it serves is all there is. Another program here could
    // send the same and would only mislabel its own answer; nothing here lets anyone in
    const portalForwarded = portalProven || (loopback && request.headers.get("x-forwarded-proto") === "https" && (options.portal?.serves(requestHost) ?? false));
    const ingress = relayPeer !== undefined ? "relay" : portalForwarded ? "portal" : observedIngress({ ...requestShape, ...identity, peerKnown: ip !== null, forwardingHeaders: forwardingHeaders(request.headers) });
    const security: SecuritySummary | undefined = access.level === "full" ? {
      token_configured: token !== "",
      pairing_gate: devices.error !== null ? "unavailable" : devices.gated ? "closed" : "open",
      bind_scope: bindScope(hostname),
      observed_ingress: ingress,
      public_exposure: ingress === "funnel" ? "observed" : "unknown",
    } : undefined;
    const securityHeaders: Record<string, string> = security ? { "cache-control": "no-store" } : {};
    const relay = access.level === "full" ? { relay: ctx.services.relay.status() } : {};
    // this PC's relay ID, for a PC that lists it over SSH: a device turns its alerts off by it (shared/machines.ts pcAlertKey)
    const serverId = access.level === "full" && access.via !== "open" ? ctx.services.relay.serverId() : undefined;
    // what this PC has of the Herdr app's runtime, for Settings: never waited for, no path in it.
    // Only a driving owner is told: a session name can name a project, which a watching device, a
    // stranger on an open install or a Portal visitor (who may not switch it) has no need to read
    const owner = access.level === "full" && access.role === "drive" && access.via !== "open" && access.via !== "portal";
    // the connection server that reaches this PC with its bridge token shows its move badge from them
    const herdr_runtime = owner || bridgeAuthorized ? options.runtimeService?.facts() : undefined;
    // the boot id lets the launcher know its own new bridge without waiting on herdr (server/supervisor.ts);
    // the runtime facts ride along, so Settings can switch back while herdr's TUI is stopped
    if (url.searchParams.get("scope") === "bridge") return jsonResponse({ ok: true, auth, bridge_protocol: BRIDGE_PROTOCOL, ...relay, ...(security ? { security } : {}), web_ui: { boot_id: bootId }, runtime: runtime(), ...(options.launchAccepted ? { accepted: options.launchAccepted() } : {}), ...(herdr_runtime ? { herdr_runtime } : {}) }, 200, securityHeaders);
    const herdr_core = owner ? options.herdrCoreFacts?.() : undefined;
    try {
      const info = await ping();
      // a forced answer (tests) and a runtime without the PTY sidecar are told the way a Windows herdr's own would be
      const herdr = attachableIdentity(info, sidecar);
      return jsonResponse({ ok: true, herdr, auth, ...relay, ...exposure, ...(security ? { security } : {}), ...(herdr_core ? { herdr_core } : {}), ...(herdr_runtime ? { herdr_runtime } : {}),
        web_ui: { boot_id: bootId, revision: process.env["OVIS_REVISION"] ?? null, ...(serverId ? { server_id: serverId } : {}) } }, 200, securityHeaders);
    } catch (error) {
      const failed = errorResponse(error);
      if (!lan_exposure && !direct_exposure) return failed;
      // herdr away says nothing of this PC's network listeners: they are told all the same
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
    // a move to herdr-core switches by itself once everything is built there; checked after the body's
    // await, right before the switch, so a move that started meanwhile is seen
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
      // another Ovis server of this herdr session (the PC's own, or a connection server's bridge) moves it
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

  if (pathname === "/api/access") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    return jsonResponse({ ...await remoteAccess(ctx.port ?? DEFAULT_PORT), relay: ctx.services.relay.status() }, 200, { "cache-control": "no-store" });
  }

  if (pathname === "/api/session") {
    setRequestRoute(pathname);
    try {
      // another Ovis server reading this PC (its bridge token) applies its own rows; a browser gets this server's
      const snapshot = await clientSnapshot();
      return jsonResponse({ snapshot: bridgeAuthorized ? snapshot : browserSnapshot(snapshot) });
    } catch (error) {
      return errorResponse(error);
    }
  }

  const agentsResponse = await handleAgentsRequest(request, pathname, shellAgents, agentOffered);
  if (agentsResponse) return agentsResponse;

  const installResponse = await agentInstaller.handle(request, pathname);
  if (installResponse) return installResponse;
  const catalogResponse = await handleAgentCatalogRequest(request, pathname, agentDetector);
  if (catalogResponse) return catalogResponse;

  const integrationsResponse = await handleIntegrationsRequest(request, pathname);
  if (integrationsResponse) return integrationsResponse;

  const filesResponse = await handleFileRequest(request, url, pathname, { bridgeAuthorized, requestHost, forwarded, client, access });
  if (filesResponse) return filesResponse;

  const workspaceResponse = await handleWorkspaceRequest(request, url, pathname, ctx, broadcastAll, queueFirstMessage, () => {
    // the receipt first, then the roster read that can show it: not waited for, and its failure changes no answer
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

  // the pane's transcript as its conversation finds it: a pane that runs no OMP session, or one not written yet, has none
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

  if (pathname.startsWith("/api/pane/prompt")) {
    try {
      const response = await handlePromptRequest(request, url, { serialize, codexHome: options.codexHome, claudeTranscript: (paneId) => claudeAgents.sessionOf(paneId)?.path ?? null, readOnly, openCodeStateDir: options.openCodeStateDir, openCodeState, onAnswered: () => options.telemetry?.tally("prompt_answers") });
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

/** Why a stop of a busy pane did nothing, in the words the move's dialog shows. */
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
