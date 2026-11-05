import { handleWorkspaceRequest } from "./workspace-routes.ts";
import { connectionData, type createCore, type SocketData } from "./core/index.ts";
import type { ClientConnectionLog } from "./client-connection-log.ts";
import type { RequestLog } from "./request-log.ts";
import { handlePaneRequest } from "./pane-routes.ts";
import { handleIntegrationsRequest } from "./integrations-routes.ts";
import type { OrderSequence } from "./order-sequence.ts";
import type { DevicePairedEvent, HealthAuth, SecuritySummary, SessionSnapshot } from "../shared/protocol.ts";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import { authClient, deviceAuthorizationValue, deviceCookieValue, bearerMatches, handleAuthRequest, isAuthenticated, isSecureRequest, parseCookies, presentedToken, presentedTokenHeld, recordPresentedTokenFailure, requiresAuth, unauthorizedJson } from "./auth.ts";
import { bindScope, cameThroughProxy, decideAccess, forwardingHeaders, inTailnet, isLoopbackAddress, isServeOwnerRequest, lanExposed, observedIngress } from "./access.ts";
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
import type { ShellAgentLocator } from "./shell-agent.ts";
import { handleAgentsRequest } from "./agents-routes.ts";
import type { AgentDetector } from "./agent-catalog-detect.ts";
import { handleAgentCatalogRequest } from "./agent-catalog-routes.ts";
import { type AgentInstaller, INSTALL_PATH, SIGN_IN_PATH } from "./agent-catalog-install.ts";
import { forgetPageMedia } from "./file-view.ts";
import { handleFileRequest } from "./file-routes.ts";
import { BACKGROUND_AGENT_PATH, handleBackgroundAgentRequest } from "./background-agent.ts";
import { paneGet, ping } from "./herdr/client.ts";
import { handlePushRequest } from "./push.ts";
import { handlePromptRequest, type OpenCodePromptState } from "./prompt.ts";
import { attachableIdentity } from "./pty/sidecar.ts";
import { runtime } from "./herdr-core/runtime.ts";
import { handleUpdateRequest, updateRequestAllowed } from "./update-api.ts";
import { handleHerdrUpdateRequest } from "./herdr-update.ts";
import { handlePortalRequest } from "./portal.ts";
import { handleRelayRequest } from "./relay/routes.ts";
import type { RelayService } from "./relay/service.ts";
import { handleTelemetryRequest, visitSurface } from "./telemetry.ts";
import type { TelemetryIngress } from "../shared/telemetry.ts";
import { handleStatuslineRequest, handleUsageRequest } from "./usage.ts";
import type { UsageAccountList } from "./usage-account-list.ts";
import { handleVoiceRequest } from "./voice.ts";
import { BRIDGE_PROTOCOL } from "../shared/machines.ts";
import { bridgeIdentity } from "./bridge.ts";
import { handleMachineRequest, nonCanonicalPath, slowMachinePath, type EventStreamBudget } from "./machine-api.ts";
import { handleSessionHistoryRequest, handleSessionResumeRequest, SESSION_HISTORY_PATH, SESSION_RESUME_PATH } from "./session-history-routes.ts";
import type { PiSessionReader } from "./pi-session-metadata.ts";
import type { HerdrSidebarConfig } from "./herdr-sidebar.ts";
import { readHerdrUi } from "./herdr-ui.ts";
import { MachineRelay } from "./machine-relay.ts";
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
  readonly relay: RelayService;
  readonly options: NonNullable<Parameters<typeof createServer>[0]>;
  readonly hostname: string;
  readonly token: string;
  readonly bridgeToken: string;
  readonly bootId: string;
  readonly devices: DeviceStore;
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
  readonly peer: { kind: "socket" } | { kind: "relay"; device: DeviceMatch; sessionId: string };
  readonly services: RequestServices;
  readonly relayBodyBudget?: EventStreamBudget;
}

export async function handleRequest(request: Request, ctx: ServerContext): Promise<Response | undefined> {
  const { options, hostname, token, bridgeToken, bootId, devices, preferences, herdrSidebar, identityOf, serveOnly, portalGuards, shellAgents, agentDetector, agentOffered, agentInstaller, openCodeState, cliProxyRoutes, usageLogin, usage, voice, browserSnapshot, core, seen, piReader, orderSequence, clientConnectionLog, requestLog, portalStartupResult, portalStartup } = ctx.services;
  const { sidecar, serialize, push, logPushError, omo, claudeAgents, opencodeAgents, plans, clientSnapshot, machines, broadcastAll, collector, queueFirstMessage } = core;
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
  const bridgeAuthorized = relayPeer === undefined && isAuthenticated(request, bridgeToken);
  // the connection server that reaches this one as its PC reads its update status and asks for the
  // update on offer: an Ovis run on this PC by itself is updated through its own updater, never
  // replaced (server/machines.ts ownOffer). An install still names the offered revision and the
  // custom header (update-api.ts), and whoever holds the token already drives every pane here. Only those two
  // requests, each by its own method and with no query: the token opens nothing else of these routes (#2054)
  const bridgeUpdatePath = url.search === "" && (pathname === "/api/updates" ? request.method === "GET" : pathname === "/api/updates/install" && request.method === "POST");
  const bridgePath = pathname === "/api/bridge" || pathname === "/api/session" || pathname === SESSION_HISTORY_PATH || pathname === SESSION_RESUME_PATH || pathname === "/api/agents" || pathname === "/api/agent-catalog" || pathname === INSTALL_PATH || pathname === SIGN_IN_PATH || pathname === "/api/agent/rename" || pathname === "/api/agent/commands" || pathname === "/api/integrations" || pathname === "/api/usage/statusline" || pathname === "/api/plugins/actions" || pathname === "/api/plugin/action" || pathname.startsWith("/api/pane/") || pathname.startsWith("/api/workspace/") || pathname.startsWith("/api/worktree/") || pathname.startsWith("/api/tab/") || pathname === "/api/layout/ratio" || pathname.startsWith("/api/fs/") || pathname === "/ws" || bridgeUpdatePath;
  const ip = relayPeer === undefined ? ctx.requestIP(request) : null;
  const loopback = ip !== null && isLoopbackAddress(ip.address);
  const forwarded = relayPeer === undefined && cameThroughProxy(request.headers);
  const funnel = relayPeer === undefined && request.headers.has("tailscale-funnel-request");
  const tailscaleLogin = relayPeer === undefined ? request.headers.get("tailscale-user-login") : null;
  const forwardedFor = relayPeer === undefined ? request.headers.get("x-forwarded-for") : null;
  const requestHost = request.headers.get("host");
  // the guessing budget of the address that asks (auth.ts): a token presented while it waits is not compared
  const client = relayPeer === undefined ? authClient(ip?.address ?? null, request.headers) : `relay:${relayPeer.id}`;
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
  const portalProven = relayPeer === undefined && (options.portal?.vouches(request.headers.get("x-portal-proof") ?? null) ?? false);
  const access = decideAccess({
    relayPeer,
    ...requestShape,
    host: requestHost,
    tokenMatched,
    device: pairedDevice,
    ...identity,
    tokenConfigured: token !== "",
    gated: devices.gated,
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
  // a repository's changes are file contents too: the patch of a credential file is that file
  const repositoryDiff = /^\/api\/(?:machines\/[^/]+\/)?workspace\/diff\//.test(pathname);
  // earlier sessions carry their first prompts
  const sessionHistory = /^\/api\/(?:machines\/[^/]+\/)?sessions\/history$/.test(pathname);
  // an agent's commands in a folder, and a pane's, are read from that folder's command files (each row
  // carries a file's first line and its path), as a directory listing and a file read are; the
  // composer's menu that lists them is a drive feature (#2132)
  const commandRows = /^\/api\/(?:machines\/[^/]+\/)?(?:agent|pane)\/commands$/.test(pathname);
  // the paths under a pane's folder that match a query are a directory listing too; they feed the
  // composer's @-mention picker, a drive feature (#2244)
  const paneFiles = /^\/api\/(?:machines\/[^/]+\/)?pane\/files$/.test(pathname);
  // where a plugin action's run stands carries what its command printed when it failed, asked for by a
  // log id: only the device that started the run (a POST, which a watching device cannot send) asks it
  const pluginRun = /^\/api\/(?:machines\/[^/]+\/)?plugin\/action$/.test(pathname);
  // a repository's checkouts are its folders' paths and branches, those not open in herdr too; the worktree
  // dialog that lists them is a drive feature, and the sidebar names a branch only for a driving device (#2250)
  const worktreeList = /^\/api\/(?:machines\/[^/]+\/)?worktree\/list$/.test(pathname);
  if (readOnly && (fileRead || directoryListing || repositoryDiff || sessionHistory || commandRows || paneFiles || pluginRun || worktreeList || mutating && !ownPreferences)) {
    setRequestRoute("watch-refusal");
    return jsonResponse({ error: { code: "read_only", message: "this device can only watch" } }, 403);
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
    || (request.method === "POST" && (pathname === "/api/push/subscribe" || pathname === "/api/push/status"))
  );
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

  if (pathname === "/api/bridge") {
    setRequestRoute(pathname);
    if (token === "" && !bridgeAuthorized) return unauthorizedJson();
    try { return jsonResponse(await bridgeIdentity(sidecar)); } catch (error) { return errorResponse(error); }
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
      ctx.timeout(request, pathname === "/api/machines/events" ? 0 : slowMachinePath(pathname.split("/").slice(4).join("/")) ? 180 : 80);
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
      // that closed the gate, so whoever holds it has no access left by the time there is news
      const openAccess = access.level === "full" && access.via === "open";
      const pairings = { subscribe: (listener: (event: DevicePairedEvent) => void) => devices.onPaired((event, origin) => { if (!openAccess && event.device_id !== deviceId && !sameBrowser(origin, keys)) listener(event); }) };
      const response = await handleMachineRequest(request, machines, deviceId ? (close) => devices.onRevoke(deviceId, close) : portalRecheckMs !== undefined ? (close) => { const timer = setTimeout(close, portalRecheckMs); return () => clearTimeout(timer); } : undefined, preferences, readOnly, herdrSidebar, seen, pairings, ctx.relayBodyBudget);
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
      let relay: MachineRelay | undefined;
      try {
        relay = new MachineRelay(machines, machineId, readOnly, browserSnapshot);
        await relay.ready;
        const upgraded = ctx.upgrade(request, { headers, data: connectionData({ relay, deviceId, readOnly, ...recheck }) });
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
    const machineEvents = useMachineEvents ? {
      manager: machines, preferences, herdrSidebar, seen,
      pairings: { subscribe: (listener: (event: DevicePairedEvent) => void) => devices.onPaired((event, origin) => {
        if (!openAccess && event.device_id !== deviceId && !sameBrowser(origin, keys)) listener(event);
      }) },
    } : undefined;
    const upgraded = ctx.upgrade(request, { headers, data: connectionData({ machineEvents, deviceId, readOnly, bridge: bridgeAuthorized, ...(surface ? { surface } : {}), ...(surface === false ? {} : { ingress }), ...recheck }) });
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
      return await handleDeviceRequest(request, pathname, devices, access, (revoked) => {
        for (const id of revoked) {
          // The device registry is the delivery authority even if cleaning the push file fails.
          try { push.revokeDevice(id); } catch (error) { logPushError(error); }
          // and every page media address its renders were given
          forgetPageMedia({ device: id });
        }
      });
    } catch (error) { return errorResponse(error); }
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
  if (pathname === "/api/relay" || pathname.startsWith("/api/relay/")) {
    return handleRelayRequest(request, pathname, ctx);
  }
  if (pathname === "/api/connection-diagnostics") { setRequestRoute(pathname); return clientConnectionLog.handle(request, client ?? "unknown"); }
  if (pathname === "/api/telemetry") { setRequestRoute(pathname); return handleTelemetryRequest(request, options.telemetry); }
  // what every browser of this server shares; a watching device reads it and cannot change it (above)
  if (pathname === "/api/preferences") { setRequestRoute(pathname); return handlePreferencesRequest(request, preferences); }
  // the finishes read in some browser of this server; a watching device reads them and cannot add to them (above)
  if (pathname === "/api/seen") { setRequestRoute(pathname); return handleSeenRequest(request, seen); }

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
    const lan_exposure = access.level === "full" && lanExposed({ hostname, tokenConfigured: token !== "", gated: devices.gated })
      ? { host: hostname } : undefined;
    // what protects this server, for a client that got in (a watching one too) and nobody else;
    // per request, so never stored. The ingress is this request's, proven or `unknown`.
    // Portal's proof says how the request came even when the token or a paired device signed it in
    const ingress = relayPeer !== undefined ? "relay" : portalProven ? "portal" : observedIngress({ ...requestShape, ...identity, peerKnown: ip !== null, forwardingHeaders: forwardingHeaders(request.headers) });
    const security: SecuritySummary | undefined = access.level === "full" ? {
      token_configured: token !== "",
      pairing_gate: devices.error !== null ? "unavailable" : devices.gated ? "closed" : "open",
      bind_scope: bindScope(hostname),
      observed_ingress: ingress,
      public_exposure: ingress === "funnel" ? "observed" : "unknown",
    } : undefined;
    const securityHeaders: Record<string, string> = security ? { "cache-control": "no-store" } : {};
    const relay = access.level === "full" ? { relay: ctx.services.relay.status() } : {};
    // what this PC has of the Herdr app's runtime, for Settings: never waited for, no path in it.
    // Only a driving owner is told: a session name can name a project, which a watching device or a
    // stranger on an open install has no need to read
    const owner = access.level === "full" && access.role === "drive" && access.via !== "open";
    const herdr_runtime = owner ? options.runtimeService?.facts() : undefined;
    // the boot id lets the launcher know its own new bridge without waiting on herdr (server/supervisor.ts);
    // the runtime facts ride along, so Settings can switch back while herdr's TUI is stopped
    if (url.searchParams.get("scope") === "bridge") return jsonResponse({ ok: true, auth, bridge_protocol: BRIDGE_PROTOCOL, ...relay, ...(security ? { security } : {}), web_ui: { boot_id: bootId }, runtime: runtime(), ...(options.launchAccepted ? { accepted: options.launchAccepted() } : {}), ...(herdr_runtime ? { herdr_runtime } : {}) }, 200, securityHeaders);
    const herdr_core = owner ? options.herdrCoreFacts?.() : undefined;
    try {
      const info = await ping();
      // a forced answer (tests) and a runtime without the PTY sidecar are told the way a Windows herdr's own would be
      const herdr = attachableIdentity(info, sidecar);
      return jsonResponse({ ok: true, herdr, auth, ...relay, ...(lan_exposure ? { lan_exposure } : {}), ...(security ? { security } : {}), ...(herdr_core ? { herdr_core } : {}), ...(herdr_runtime ? { herdr_runtime } : {}),
        web_ui: { boot_id: bootId, revision: process.env["OVIS_REVISION"] ?? null } }, 200, securityHeaders);
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api/runtime") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    if (!updateRequestAllowed(request)) return jsonResponse({ error: { code: "forbidden", message: "a runtime switch must come from this app's own page" } }, 403);
    // the same boundary as the facts: only a driving owner, never a watching device or a stranger on an open install
    if (!(access.level === "full" && access.role === "drive" && access.via !== "open")) return jsonResponse({ error: { code: "forbidden", message: "only a device that drives this PC can switch its runtime" } }, 403);
    if (!options.runtimeService) return jsonResponse({ error: { code: "runtime_locked", message: "this server cannot switch its runtime" } }, 409);
    let body: unknown;
    try { body = await request.json(); } catch { return badRequest("invalid_json", "send { \"runtime\": \"herdr\" | \"herdr-core\" }"); }
    const answer = options.runtimeService.request(body !== null && typeof body === "object" ? (body as Record<string, unknown>)["runtime"] : undefined);
    return answer.ok ? jsonResponse({ accepted: true }, 202) : jsonResponse({ error: { code: answer.code, message: answer.message } }, answer.status);
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
  }, shellAgents);
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
    return handleBackgroundAgentRequest(request, url, { paneGet, omoPane: (paneId) => omo.sessionOf(paneId) !== null, claudeAgents, read: options.backgroundAgentRead });
  }

  const planResponse = await handlePlanRequest(request, url, pathname, { omo, claudeAgents, plans });
  if (planResponse) return planResponse;

  const artifactsResponse = await handleArtifactsRequest(request, url, pathname, { claudeAgents });
  if (artifactsResponse) return artifactsResponse;

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
