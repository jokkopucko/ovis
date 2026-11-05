import "./adopt-legacy-env.ts";
import type { RelaySocket } from "../shared/relay-channel.ts";
import { createCore, type SocketData } from "./core/index.ts";
import { ClientConnectionLog } from "./client-connection-log.ts";
import { RequestLog } from "./request-log.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { OrderSequence } from "./order-sequence.ts";
import { readHerdrProfiles, type HerdrMachineProfile } from "./herdr-profiles.ts";
import { accessSync, constants, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PendingMessage, SessionSnapshot } from "../shared/protocol.ts";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import { isLoopbackBind, lanExposed } from "./access.ts";
import { DeviceStore } from "./devices.ts";
import { PreferenceStore } from "./preferences.ts";
import { SeenStore } from "./seen.ts";
import type { SeenFinish } from "../shared/seen.ts";
import { TailnetIdentitySource } from "./tailscale.ts";
import { SHELL_AGENTS, ShellAgentLocator } from "./shell-agent.ts";
import { AgentDetector, catalogLocator, defaultLoginProbe } from "./agent-catalog-detect.ts";
import { InstalledLookup } from "./installed-lookup.ts";
import { agentCatalogFor } from "./agent-catalog-routes.ts";
import { AGENT_CATALOG, catalogPlatform } from "../shared/agent-catalog.ts";
import { AgentInstaller } from "./agent-catalog-install.ts";
import { type BackgroundAgentDeps } from "./background-agent.ts";
import { herdrSocketPath, ping } from "./herdr/client.ts";
import { coreConnection, coreSeenMarker, hcBin, NoHerdrCoreError, servingCore, setRuntime, startRuntime } from "./herdr-core/runtime.ts";
import { chooseRuntime, runtimeService, type RuntimeChoice, type RuntimeService } from "./herdr-core/runtime-choice.ts";
import { bridgePins } from "./herdr-core/pin-label.ts";
import { herdrCoreFacts } from "./herdr-core/discovery.ts";
import { type HerdrCoreFacts, LOCAL_MACHINE } from "../shared/machines.ts";
import { type AlertTiming, defaultStateDir } from "./push.ts";
import { mergeSiblingState, siblingStateDir } from "./state-merge.ts";
import { moveLegacyStateDir } from "./update-state.ts";
import { sweepSshDirs } from "./ssh.ts";
import { OpenCodePromptState } from "./prompt.ts";
import { connectUpdater, type UpdateService } from "./update-api.ts";
import { HerdrUpdater } from "./herdr-update.ts";
import { PortalService } from "./portal.ts";
import { RelayService } from "./relay/service.ts";
import { Telemetry } from "./telemetry.ts";
import { UsageService } from "./usage.ts";
import { CLIProxyService } from "./cliproxy.ts";
import { CLIProxyRoutes } from "./cliproxy-routes.ts";
import { UsageLoginService } from "./usage-login.ts";
import { UsageAccountList } from "./usage-account-list.ts";
import { VoiceService } from "./voice.ts";
import { loopbackRelay, registerBridge, relayTarget } from "./bridge.ts";
import { PiSessionReader } from "./pi-session-metadata.ts";
import { HerdrSidebarConfig, herdrConfigPath, snapshotWithoutHiddenTokens } from "./herdr-sidebar.ts";
import { closeCodexDaemonSources } from "./codex-daemon.ts";
import { holdOpenCodeNative } from "./opencode-native.ts";
import { holdCommandHistory } from "./claude-command-history.ts";
import { holdFilePool } from "./file-pool.ts";
import { handleRequest, type RequestServices, type ServerContext } from "./dispatch.ts";



/** The gap between a composer message's text and its Enter (see submitText). */
export const SUBMIT_DELAY_MS = 120;
/**
 * herdr holds a lone ESC typed through the attach pty ~150ms (measured) to tell it from
 * an Alt+key: a composer message waits this long after the pane's last keystroke, so a
 * Stop tapped just before Send still reaches the pane first.
 */
export const TYPED_SETTLE_MS = 300;
/**
 * A terminal key (WS `keys`) goes through herdr's RPC, around the attach pty: it waits this long
 * after the pane's last pty keystroke so it never overtakes typing on its way through the
 * sidecar and the attach, and the whole TYPED_SETTLE_MS when that keystroke ended in an ESC
 * herdr may still be holding. Short enough that a held arrow between typed letters shows no lag.
 */
export const KEY_SETTLE_MS = 40;
/**
 * Nothing of a composer message is typed once this long has passed since it reached the
 * server (it can wait behind a stalled one in the pane's queue): it answers submit_timeout
 * instead. A send that starts in time ends within two more 10s RPCs, before the client
 * stops waiting (SUBMIT_TIMEOUT_MS in src/lib/ws.ts), so a message it gave up on never
 * reaches the pane later.
 */
export const SUBMIT_DEADLINE_MS = 45_000;
/** How long a cleared Claude input box may take to read empty before the send is refused after all. */
const DRAFT_CLEAR_WAIT_MS = 1_500;
const DRAFT_CLEAR_POLL_MS = 50;


/**
 * What Bun.serve admits before a route runs (64 MiB). The ~55.9 MB body of a 40 MiB file is under it,
 * so the attachment route answers it with its JSON reason. The browser refuses a file over
 * MAX_ATTACHMENT_BYTES before it uploads (src/lib/api.ts), so only a non-browser client that sends
 * more than this can still see Bun's own empty 413.
 */
const BUN_BODY_CEILING = 64 * 1024 * 1024;

export interface ServerInstance {
  /** A socket context with this server's services, also usable with transport operations replaced. */
  readonly context: ServerContext;
  port: number;
  hostname: string;
  statusReady: Promise<void>;
  focusReady: Promise<void>;
  alertsSettled: () => Promise<void>;
  /** Start background version reads; only the real entrypoints opt in. */
  warmAgentCatalog: () => void;
  /**
   * queues a create request's first message for a pane's agent, as POST /api/workspace/create and /api/tab/create do with
   * `first_message` and `first_message_connection` (`requester`, a connection's id from its first snapshot): for tests that start no agent
   */
  queueFirstMessage: (paneId: string, text: string, kind: string, requester?: string | null, launchedPid?: number | null) => Promise<PendingMessage>;
  stop: () => void;
}

export function createServer(
  options: {
    port?: number;
    hostname?: string;
    /** Also listen on ::1 when the primary listener is bound to 127.0.0.1. */
    ipv6Loopback?: boolean;
    token?: string;
    /** where VAPID keys and push subscriptions persist; tests pass a temp dir */
    stateDir?: string;
    /**
     * The other default state dir of an install that kept its state in two (server/state-merge.ts):
     * its devices, preferences and push subscriptions are taken over before anything reads them.
     * Only the real entrypoint passes one; a test passes a temp dir.
     */
    siblingStateDir?: string | null;
    /** the PC's own Tailscale login, for the identity check; tests set it, otherwise `tailscale status` says */
    tailscaleOwner?: string | null;
    /** the operator declares `tailscale serve` as this install's only ingress; OVIS_TAILSCALE_SERVE_ONLY=1 says the same */
    tailscaleServeOnly?: boolean;
    /** the tailnet identity behind the access check; unset, the tailscale CLI says. Tests pass one with their own status reader. */
    tailnet?: TailnetIdentitySource;
    /** Native Codex store; defaults to CODEX_HOME. Tests use an isolated store. */
    codexHome?: string;
    grokHome?: string;
    /** Muse Code's data directory; defaults to XDG_DATA_HOME/muse or ~/.local/share/muse. Tests use an isolated store. */
    museData?: string;
    /** OpenCode's database; defaults to where OpenCode finds it (OPENCODE_DB, XDG_DATA_HOME). Tests use an isolated store. */
    opencodeDb?: string;
    /** OpenCode state dir where service.json lives; tests use an isolated directory. */
    openCodeStateDir?: string;
    /** Native Devin store; tests pass an isolated SQLite database. */
    devinDbPath?: string;
    /** Native Hermes store; pane process HERMES_HOME wins when this is unset. Tests use an isolated store. */
    hermesHome?: string;
    updates?: UpdateService;
    /** updates herdr itself (server/herdr-update.ts); unset, the app offers no herdr update. Tests pass one that runs a stand-in herdr. */
    herdrUpdate?: HerdrUpdater;
    /** what this PC has of herdr-core, for Settings (server/herdr-core/discovery.ts); unset, health tells none. Tests pass a stand-in. */
    herdrCoreFacts?: () => HerdrCoreFacts | undefined;
    /** which runtime this server serves and the Settings switch (server/herdr-core/runtime-choice.ts); unset, health tells none and a switch is refused. Tests pass a stand-in. */
    runtimeService?: RuntimeService;
    /** whether the launcher took this bridge as its own after its startup check (server/supervisor.ts); unset, nothing is told */
    launchAccepted?: () => boolean;
    /** a public address through Portal (server/portal.ts); unset, the app offers none. Tests pass one that runs a stand-in portal. */
    portal?: PortalService;
    /** Relay opt-in and identity persist in stateDir; tests can supply a local physical transport. */
    relay?: RelayService;
    /** anonymous install and update counts (server/telemetry.ts); unset, the server sends none and answers 404. Only the real entrypoint passes one. */
    telemetry?: Telemetry;
    /** plan limits of the AI subscriptions signed in here; tests pass one without real sign-ins */
    usage?: UsageService;
    /** Tests supply an isolated proxy service, never a user's configured instance. */
    cliProxy?: CLIProxyService;
    /** Tests use a disposable credential home and stand-in CLI binaries. */
    usageLogin?: UsageLoginService;
    /** voice input's key, provider and models; tests pass one with their own env and fetch */
    voice?: VoiceService;
    machines?: boolean;
    /** how PCs added through the relay reach it (server/relay-pc.ts); tests point it at a local relay */
    relayPcSocket?: (url: string) => RelaySocket;
    /** a bridge this app starts on a PC (server/remote-entry.ts): its token is the credential its connection server holds, and no browser reaches it, so its snapshots go whole (#2160) */
    bridgeOnly?: boolean;
    /** Read-only saved profiles from the local herdr client; tests supply their own catalog. */
    herdrProfiles?: () => Promise<HerdrMachineProfile[]>;
    /** herdr's config.toml, for its sidebar rows (server/herdr-sidebar.ts) and its copy_on_select (server/herdr-ui.ts); unset, where herdr itself reads it. Tests pass a temp file. */
    herdrConfigPath?: string;
    registerBridge?: boolean;
    /** the token a connection server presents as this PC's bridge; random unless a test names it */
    bridgeToken?: string;
    /** PLUGIN_ACTION_WAIT_MS in server/plugin-routes.ts; a test shortens it to see a run that outlasts the wait */
    pluginActionWaitMs?: number;
    /** SUBMIT_DEADLINE_MS; tests shorten it */
    submitDeadlineMs?: number;
    /** SUBMIT_DELAY_MS; a test lengthens it to hold a second message behind the first */
    submitDelayMs?: number;
    /** How long a queued send waits for a confirmed new turn to start; tests shorten it. */
    pendingStartTimeoutMs?: number;
    /** Active Pi transcript receipts allowed per connection. Tests lower it to exercise the pre-send boundary. */
    piReceiptLimit?: number;
    /** how long a push alert waits for the pane to change first (server/push.ts); tests send at once */
    alertTiming?: Partial<AlertTiming>;
    /** accept plain-http loopback push endpoints (server/push.ts); only tests delivering to push.fake.ts set it */
    pushLoopbackHttp?: boolean;
    /** how long a turn's end is held for its background work (server/background-wait.ts); tests shorten it */
    backgroundWait?: { grace: number; limit: number };
    /** Clock for background holds and alert turn durations; tests advance it explicitly. */
    statusNow?: () => number;
    /** herdr's identity behind `herdr_lifetime`; unset, its socket's (server/finishes.ts). Tests swap one in. */
    herdrIdentity?: () => string | null;
    /** ATTACH_RETRY_FOR_MS; tests shorten it */
    attachRetryForMs?: number;
    /** ATTACH_HELD_RETRY_MS; tests shorten it */
    attachHeldRetryMs?: number;
    /** ATTACH_RELOOKUP_FOR_MS; tests shorten it */
    attachRelookupForMs?: number;
    /** ATTACH_HOLD_MS; a test lengthens it so an attach's exit always comes before its hold ends */
    attachHoldMs?: number;
    /** PI_READ_DEADLINE_MS, a Pi session listing's deadline; a test that checks what is listed, not how fast, lengthens it */
    piSessionDeadlineMs?: number;
    /** whether herdr can `terminal attach`; unset, its ping says, and this runtime's PTY sidecar has to be runnable. Tests give a Windows herdr's answer, at once or as late as a ping's. */
    terminalAttach?: boolean | (() => Promise<boolean>);
    /** GET /api/pane/background-agent's read (server/background-agent.ts); a test holds it to change the pane's session while it is out */
    backgroundAgentRead?: BackgroundAgentDeps["read"];
    /** whether this runtime can run the PTY sidecar; unset, server/pty/sidecar.ts says. Tests give a runtime without Node or node-pty, while herdr keeps its own answer, or a probe to run in place of that one. */
    sidecar?: boolean | (() => boolean);
    /** where omo and gjc are found for the offer and the start (server/shell-agent.ts); unset, this server's PATH alone. The real entrypoints (this file's and remote-entry.ts) add their user's login shell; tests pass a fixture one. */
    shellAgents?: ShellAgentLocator;
    /** what GET /api/agent-catalog finds installed; unset, the agents' binaries on this server's PATH alone. The real entrypoints (this file's and remote-entry.ts) add their user's login shell's PATH, where installers put agents. */
    agentDetector?: AgentDetector;
  } = {},
): ServerInstance {
  /**
   * This server's lifetime: the supervisor's boot id when it manages the server, else one made now. It is
   * /api/health's `web_ui.boot_id` and the epoch of the workspace order's counter (server/order-sequence.ts).
   */
  const bootId = process.env["OVIS_BOOT_ID"] || randomUUID();
  const orderSequence = new OrderSequence(bootId);
  const hostname = options.hostname ?? process.env["HOST"] ?? "127.0.0.1";
  const ipv6Loopback = (options.ipv6Loopback ?? process.env["OVIS_IPV6_LOOPBACK"] === "1") && hostname === "127.0.0.1";
  /** Empty token = gate disabled; every route then behaves exactly as it did before auth existed. */
  const token = options.token ?? process.env["OVIS_TOKEN"] ?? "";
  /** paired devices (server/devices.ts) and the PC's Tailscale login: the two ways in besides the token and this PC itself */
  // resolved once: a merge can give the old dir files of its own, after which resolving again could name the other dir
  const stateDir = options.stateDir ?? defaultStateDir();
  const ovisRelay = options.relay ?? new RelayService({ stateDir });
  const merge = options.siblingStateDir ? mergeSiblingState(stateDir, options.siblingStateDir) : null;
  const devices = new DeviceStore(stateDir, merge?.devicesBlocked ?? null);
  const preferences = new PreferenceStore(stateDir);
  // on herdr-core an agent pinned here is pinned in the Herdr app and its other clients too
  const stopPinBridge = servingCore() ? bridgePins(coreConnection(), preferences, LOCAL_MACHINE, stateDir) : null;
  // Chat's own rewind (#1500, never released) kept its rewinds here; nothing reads them since #1577
  try {
    rmSync(join(stateDir, "claude-rewinds.json"), { force: true });
  } catch (error) {
    console.error(`cannot remove the unused claude-rewinds.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  const herdrSidebar = new HerdrSidebarConfig(options.herdrConfigPath ?? herdrConfigPath());
  const cliProxy = options.cliProxy ?? new CLIProxyService(stateDir);
  const cliProxyRoutes = new CLIProxyRoutes(cliProxy);
  const usageLogin = options.usageLogin ?? new UsageLoginService();
  // a sign-in runs in a herdr tab, which outlives this server: the next one must know its home is taken (#2313)
  usageLogin.persistTo(stateDir);
  const usage = options.usage ?? new UsageService(undefined, undefined, (refresh) => cliProxy.report(refresh));
  const usageAccounts = new UsageAccountList(stateDir, usage);
  // a sign-in the browser followed ends in the server's own PTY, not a herdr pane: it says so itself
  usageLogin.onLoginEnded((account) => {
    usage.invalidate();
    if (account !== null) {
      try { usageAccounts.restore(account); }
      catch (error) { console.warn("Could not restore the signed-in account to Ovis", error instanceof Error ? error.message : String(error)); }
    }
  });
  const voice = options.voice ?? new VoiceService({ stateDir, env: process.env, fetch });
  /** a login named here is taken as it is: a tagged node has none of its own to read (OVIS_TAILSCALE_OWNER) */
  const namedOwner = options.tailscaleOwner !== undefined ? options.tailscaleOwner : process.env["OVIS_TAILSCALE_OWNER"]?.trim() || undefined;
  const tailnet = options.tailnet ?? new TailnetIdentitySource();
  const identityOf = async (grantPath: boolean, host: string | null, loginPath = false) => {
    if (namedOwner !== undefined) return { ...(grantPath ? await tailnet.freshIdentity(host) : { soleLogin: null, dnsName: null, tailnetIp: null }), owner: namedOwner, tagged: false };
    return grantPath ? tailnet.freshIdentity(host) : loginPath ? tailnet.loginIdentity() : tailnet.identity();
  };
  const serveOnly = options.tailscaleServeOnly ?? process.env["OVIS_TAILSCALE_SERVE_ONLY"] === "1";
  /** what lets Portal open an address: this server's own values, never a request's */
  const portalGuards = () => ({ tokenSet: token !== "", serveOnly });

  const shellAgents = options.shellAgents ?? new ShellAgentLocator({ probe: null });
  const agentDetector = options.agentDetector ?? new AgentDetector({ locate: catalogLocator({ probe: null }) });
  // GET /api/agents: on a PATH a pane's shell starts it from, read again once after an install put it
  // in its installer's folder (installed-lookup.ts); shell-started kinds through the locator that starts them
  const catalogPlatformHere = catalogPlatform(process.platform);
  const installFolder = (binary: string): { path: string; mark: string } | null => {
    const entry = AGENT_CATALOG.find((candidate) => candidate.detect.binaries.includes(binary));
    const dirs = entry !== undefined && catalogPlatformHere !== null ? entry.detect.install_dirs?.[catalogPlatformHere] ?? [] : [];
    const path = catalogPlatformHere === null ? null : agentDetector.inInstallFolder(binary, dirs, catalogPlatformHere);
    if (path === null) return null;
    try { return { path, mark: String(statSync(path).mtimeMs) }; } catch { return null; }
  };
  const herdrKinds = new InstalledLookup({ onPath: (binary) => agentDetector.onPath(binary), inInstallFolder: installFolder, refresh: () => agentDetector.refreshPath() });
  const shellKinds = new InstalledLookup({ onPath: (kind) => shellAgents.executable(kind), inInstallFolder: installFolder, refresh: () => shellAgents.refresh() });
  const agentOffered = async (kind: string): Promise<boolean> => {
    const entry = AGENT_CATALOG.find((candidate) => candidate.id === kind);
    // a program it needs to run (DeepSeek Harness's dsh behind dsh-tui) missing: not offered, as the catalog says
    for (const needed of entry?.detect.needs ?? []) if (!(await herdrKinds.has(needed))) return false;
    if (kind in SHELL_AGENTS) return shellKinds.has(kind);
    return herdrKinds.has(entry?.detect.binaries[0] ?? kind);
  };
  const agentInstaller = new AgentInstaller(agentDetector);
  const openCodeState = new OpenCodePromptState();
  const draftTimer = setInterval(() => openCodeState.prune(), 60_000);
  draftTimer.unref();
  // a snapshot as a browser is told it, wherever it goes: without the token values herdr's sidebar rows hide (#2160).
  // A bridge this app starts on a PC (`bridgeOnly`, server/remote-entry.ts) serves only its connection server, with
  // the credential it registered as its token: that server applies its own rows, so it gets every snapshot whole.
  const browserSnapshot = <S extends SessionSnapshot>(snapshot: S): S => options.bridgeOnly ? snapshot : snapshotWithoutHiddenTokens(herdrSidebar.get(), snapshot);
  const core = createCore({ options: { ...options, stateDir, openCodeState, orderSequence, seenMoved: (from, to, renumber) => seen.moved(LOCAL_MACHINE, from, to, renumber) }, devices, preferences, usage, usageLogin, browserSnapshot, TYPED_SETTLE_MS, KEY_SETTLE_MS, SUBMIT_DEADLINE_MS, SUBMIT_DELAY_MS, DRAFT_CLEAR_WAIT_MS, DRAFT_CLEAR_POLL_MS });
  const { machines, collector, queueFirstMessage, push } = core;
  // read finishes are kept until this server knows their herdr run ended
  const seen = new SeenStore(stateDir, (pc, epoch) => machines?.finishEnded(pc, epoch) ?? false);
  // a pane another PC's herdr moved under a new ID: what was read under the old ID is read under the new one (#1503;
  // this PC's own moves are told with their numbering above)
  machines?.subscribe((event) => {
    if (event.type !== "machine-message" || event.machine_id === LOCAL_MACHINE || event.message.type !== "pane-moved") return;
    try { seen.moved(event.machine_id, event.message.from, event.message.to); }
    catch (error) { console.warn(`seen: could not carry the reads of ${event.message.from} to ${event.message.to}:`, error); }
  });
  // on herdr-core a finish read here is read in the Herdr app and its other clients too: only the
  // pane's finish now, so a read told late never marks a turn that ended since as seen. A pane brought
  // into view writes it again (shared/seen.ts SeenPresentation); one left on screen does not
  const seenMarker = servingCore() ? coreSeenMarker() : null;
  const markSeen = (finish: SeenFinish, again: boolean) => {
    if (!seenMarker || finish.pc !== LOCAL_MACHINE || machines?.finishEnded(finish.pc, finish.epoch) !== false) return;
    const pane = machines.list().find((machine) => machine.id === LOCAL_MACHINE)?.snapshot?.panes.find((candidate) => candidate.pane_id === finish.pane);
    if (pane?.agent_status !== "done" || pane.finish_id !== finish.id) return;
    seenMarker.mark(finish.pane, again).catch((error: unknown) => console.warn(`herdr-core: could not mark ${finish.pane} seen:`, error));
  };
  if (seenMarker) {
    seen.subscribe((finish, presented) => { if (presented !== "new") markSeen(finish, false); });
    seen.onPresented((finish) => markSeen(finish, true));
  }
  // started after createCore's Node probe (server/pty/sidecar.ts), which can hold the thread up to 3 s: that wait
  // would count against the read's own 2.5 s limit, and a read cut short leaves the owner unknown for 5 minutes
  identityOf(false, null);
  const bridgeToken = options.bridgeToken ?? randomBytes(32).toString("hex");
  const piReader = new PiSessionReader({ deadlineMs: options.piSessionDeadlineMs });

  type PortalStartup = { ok: true } | { ok: false; error: unknown };
  let settlePortalStartup!: (result: PortalStartup) => void;
  let portalStartupResult: PortalStartup | undefined;
  const portalStartup = new Promise<PortalStartup>((resolve) => {
    settlePortalStartup = (result) => {
      if (portalStartupResult !== undefined) return;
      portalStartupResult = result;
      resolve(result);
    };
  });

  const envPort = process.env["PORT"];
  const clientConnectionLog = new ClientConnectionLog();
  const socketContext = (bunServer: Bun.Server<SocketData>): ServerContext => ({
    requestIP: (request) => bunServer.requestIP(request),
    timeout: (request, seconds) => { bunServer.timeout(request, seconds); },
    upgrade: (request, options) => bunServer.upgrade(request, options),
    get port() { return bunServer.port; },
    peer: { kind: "socket" },
    services,
  });
  const server = Bun.serve<SocketData>({
    port: options.port ?? (envPort ? Number(envPort) : DEFAULT_PORT),
    hostname,
    maxRequestBodySize: BUN_BODY_CEILING,

    fetch: (request, bunServer) => handleRequest(request, socketContext(bunServer)),

    websocket: core.websocket,
  });
  // bound before anything else opens, so a failed ::1 bind leaves only what a failed primary bind would
  let ipv6: Bun.Server<SocketData> | null = null;
  if (ipv6Loopback) {
    try {
      ipv6 = Bun.serve<SocketData>({
        hostname: "::1", port: server.port, maxRequestBodySize: BUN_BODY_CEILING,
        fetch: (request, bunServer) => handleRequest(request, socketContext(bunServer)),
        websocket: core.websocket,
      });
    } catch (error) {
      server.stop(true);
      // createCore already started the status hub's watchers and timers
      core.stop(() => clearInterval(draftTimer));
      piReader.close();
      throw error;
    }
  }

  const requestLog = new RequestLog(stateDir);
  const services: RequestServices = {
    options, relay: ovisRelay, hostname, token, bridgeToken, bootId, devices, preferences, herdrSidebar, identityOf, serveOnly, portalGuards, shellAgents, agentDetector, agentOffered, agentInstaller, openCodeState, cliProxyRoutes, usageLogin, usage, usageAccounts, voice, browserSnapshot, core, seen, piReader, orderSequence, clientConnectionLog, requestLog, portalStartup,
    get portalStartupResult() { return portalStartupResult; },
  };
  ovisRelay.resume(services, server.port ?? DEFAULT_PORT);

  if (options.portal) {
    // a Portal that ends on its own is started again only while this server's own token and serve-only allow it
    options.portal.authorize(portalGuards);
    let resume: Promise<void>;
    try {
      resume = options.portal.resume({ port: server.port ?? DEFAULT_PORT, ...portalGuards() });
    } catch (error) {
      resume = Promise.reject(error);
    }
    void resume.then(
      () => settlePortalStartup({ ok: true }),
      (error: unknown) => settlePortalStartup({ ok: false, error }),
    );
  } else {
    settlePortalStartup({ ok: true });
  }

  // the app's SSH tunnel reaches a bridge on the PC's 127.0.0.1 only (#1960)
  const target = options.registerBridge ? relayTarget(hostname) : null;
  const relay = target ? loopbackRelay(target, server.port ?? 0) : null;
  const registration = options.registerBridge ? registerBridge(relay?.port ?? server.port ?? 0, bridgeToken) : null;

  // OpenCode's stream and watches are shared by every server in this process: the last one to stop resets them
  const releaseOpenCodeNative = holdOpenCodeNative();
  // the file threads are shared by every server in this process too: the last one to stop ends them
  const releaseFilePool = holdFilePool();
  const releaseCommandHistory = holdCommandHistory();
  core.start();

  return {
    context: socketContext(server),
    port: server.port ?? 0,
    hostname,
    // both subscriptions live: a test may create a workspace and wait for its session-changed
    statusReady: Promise.all([collector.ready, collector.structureReady]).then(() => undefined),
    focusReady: collector.focusReady,
    /** a create request's first message for a pane's agent, as the create routes queue it (server/core/pending.ts); for tests that run no agent */
    queueFirstMessage,
    alertsSettled: () => push.settled(),
    warmAgentCatalog: () => {
      void agentCatalogFor(catalogPlatform(process.platform), agentDetector).catch((error: unknown) => {
        console.error(`agent catalog warm-up failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
    stop: () => {
      void ovisRelay.shutdown();
      settlePortalStartup({ ok: false, error: new Error("Server stopped before Portal startup cleanup completed") });
      core.stop(() => {
        clearInterval(draftTimer);
        openCodeState.clear();
        void options.portal?.shutdown();
        registration?.close();
        relay?.stop();
        closeCodexDaemonSources();
        releaseOpenCodeNative();
      });
      piReader.close();
      stopPinBridge?.stop();
      // the followed sign-ins run in this server's own terminals: no dialog could reach them once it stops
      void usageLogin.stopAll();
      void shellAgents.stop();
      agentDetector.close();
      server.stop(true);
      ipv6?.stop(true);
      releaseFilePool();
      releaseCommandHistory();
      requestLog.close();
    },
  };
}

if (import.meta.main) {
  moveLegacyStateDir();
  // SSH connection folders an earlier server left in /tmp; here, not in createServer, so tests never touch them
  void sweepSshDirs();
  // resolved once, for the same reason as in createServer
  const stateDir = defaultStateDir();
  // herdr-core's adapter is HERDR_SOCKET: it listens before anything below asks herdr
  // the launcher says when it took this bridge as its own, past its startup check: a page following a
  // runtime switch waits for that, never for a bridge the launcher may still roll back
  let launchAccepted = process.env["OVIS_MANAGED"] !== "1";
  process.on("message", (message: unknown) => {
    if (message !== null && typeof message === "object" && (message as { type?: unknown }).type === "bridge-accepted") launchAccepted = true;
  });
  // OVIS_RUNTIME, else the choice saved from Settings, else what this PC has (runtime-choice.ts)
  const startEnv = { ...process.env };
  let herdrCore: Awaited<ReturnType<typeof startRuntime>>;
  let choice: RuntimeChoice;
  let fallback: "no_herdr_core" | undefined;
  try {
    choice = await chooseRuntime({ stateDir, port: Number(startEnv["PORT"] || DEFAULT_PORT), env: startEnv });
    setRuntime(choice.runtime);
    console.log(`Runtime: ${choice.runtime} (${choice.reason})`);
    try {
      herdrCore = await startRuntime(stateDir);
    } catch (err) {
      // a choice saved from Settings whose core is gone falls back to herdr, where Settings can switch again;
      // OVIS_RUNTIME says what to serve, and its failure stays an error
      // only a missing hc: any other failure (a state folder, another Ovis) is the launcher's to roll back
      if (choice.source !== "saved" || choice.runtime !== "herdr-core" || !(err instanceof NoHerdrCoreError)) throw err;
      console.error(`The herdr-core chosen in Settings cannot start (${err instanceof Error ? err.message : String(err)}); serving herdr.`);
      choice = { ...choice, runtime: "herdr" };
      fallback = "no_herdr_core";
      setRuntime("herdr");
      herdrCore = null;
    }
  } catch (err) {
    console.error(`Ovis cannot start: ${err instanceof Error ? err.message : String(err)}.`);
    process.exit(1);
  }
  const updates = connectUpdater();
  const version = (JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }).version;
  const telemetry = new Telemetry({ stateDir, version, env: process.env, fetch, previousVersion: () => updates.installed().previous_version, runtime: herdrCore === null ? "herdr" : "herdr-core" });
  const portal = new PortalService({ stateDir });
  const relay = new RelayService({ stateDir });
  let instance: ReturnType<typeof createServer>;
  try {
    instance = createServer({ updates, herdrUpdate: new HerdrUpdater(), herdrCoreFacts,
      launchAccepted: () => launchAccepted,
      runtimeService: runtimeService({ stateDir, port: Number(startEnv["PORT"] || DEFAULT_PORT), serving: choice.runtime, source: choice.source, ...(fallback ? { fallback } : {}), env: startEnv, core: herdrCoreFacts, accepted: () => launchAccepted, restart: (id) => process.send?.({ type: "runtime-restart", id }) }),
      portal, relay, telemetry, registerBridge: true, herdrProfiles: readHerdrProfiles, shellAgents: new ShellAgentLocator(), agentDetector: new AgentDetector({ locate: catalogLocator({ probe: defaultLoginProbe() }) }), stateDir, siblingStateDir: siblingStateDir(stateDir) });
    instance.warmAgentCatalog();
  } catch (err) {
    const { code, syscall } = err as { code?: string; syscall?: string };
    // only the bind itself: a permission error reading a state file keeps its own message and path
    if (syscall !== "listen" || (code !== "EADDRINUSE" && code !== "EADDRNOTAVAIL" && code !== "EACCES")) throw err;
    const host = process.env["HOST"] ?? "127.0.0.1";
    const port = process.env["PORT"] || DEFAULT_PORT;
    const reason = code === "EADDRINUSE"
      ? `the port is in use. Another app (or Ovis) may already use it; start with another PORT=, or open http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port} if it is this app`
      : code === "EADDRNOTAVAIL"
        ? "this PC has no such address; try HOST=127.0.0.1"
        : "the port needs permission; try a PORT above 1024";
    console.error(`Ovis cannot listen on ${host}:${port}: ${reason}.`);
    herdrCore?.stop();
    process.exit(1);
  }
  telemetry.start();
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    telemetry.stop();
    instance.stop();
    // Attach sidecars need ~1.2s to release herdr's exclusive client slot; Portal unregisters from
    // its relay, and the pipes it logs to must outlive it
    // herdr-core's adapter answers what the stopping server still asks meanwhile
    void Promise.all([Bun.sleep(2000), portal.shutdown(), relay.shutdown()]).then(() => {
      herdrCore?.stop();
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  if (process.env["OVIS_MANAGED"] === "1") process.on("disconnect", shutdown);
  console.log(`Ovis listening on http://${instance.hostname}:${instance.port}`);
  const socket = herdrSocketPath();
  void ping(socket).catch(() => {
    console.error(herdrCore
      ? `herdr-core is not reachable through ${socket}: start it with \`${hcBin()} server start\`, or set OVIS_HC_BIN to hc's full path.`
      : `herdr is not reachable at ${socket}: start herdr, or set HERDR_SOCKET to its socket (named sessions: ~/.config/herdr/sessions/<name>/herdr.sock).`);
  });
  // the state folder is created on first write, so test the nearest folder that exists
  let probe = stateDir;
  while (true) {
    try {
      accessSync(probe, constants.F_OK);
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  try {
    accessSync(probe, constants.W_OK);
  } catch {
    console.error(`cannot write ${stateDir}: settings, devices and updates will not be saved; fix its permissions or set OVIS_STATE_DIR.`);
  }
  if (!isLoopbackBind(instance.hostname)) {
    if (lanExposed({ hostname: instance.hostname, tokenConfigured: (process.env["OVIS_TOKEN"] ?? "") !== "", gated: false })) {
      console.error(
        `WARNING: listening on ${instance.hostname} without OVIS_TOKEN - until a device is paired (Settings → Devices, on this PC) anyone who can reach this address can type into your terminals; pair your devices, set OVIS_TOKEN=<token>, or keep HOST=127.0.0.1 and reach it through Tailscale or an SSH tunnel.`,
      );
    }
    // The bind address says nothing about the transport: a token cookie and every keystroke
    // travel in the clear on plain http, so a listener on the same network gets them.
    if ((process.env["OVIS_TOKEN"] ?? "") !== "") {
      console.error(
        `WARNING: listening on http://${instance.hostname}:${instance.port} - OVIS_TOKEN is not confidential over cleartext http; on an untrusted network anyone who can read the traffic has the token and everything you type. Reach this PC over Tailscale, put it behind a TLS-terminating proxy, or keep HOST=127.0.0.1.`,
      );
    }
  }
}
