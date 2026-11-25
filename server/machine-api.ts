import { subscribeMachineEvents } from "./machine-events.ts";
import { wireMachine, wireMachineEvent, type WireMachine } from "../shared/compact-agents.ts";
import { LOCAL_MACHINE, type AgentToolPanesEvent, type DevicePairedEvent, type DevicePairedSeenEvent, type DeviceRemovedEvent, type Machine, type MachineRoster, type PcInstallJob, type PcInstallRequest, type PcUpdateAll, type PcUpdateStarted, type PendingRedemptionsEvent, type RelayPairingsEvent, type RemotePairingsEvent, type SetupAction, type SetupRequest } from "../shared/machines.ts";
import type { AgentRowTokens } from "../shared/pane-tokens.ts";
import type { SharedPreferences } from "../shared/preferences.ts";
import type { PanePromptResponse, SessionSnapshot } from "../shared/protocol.ts";
import type { SeenFinish } from "../shared/seen.ts";
import type { DeviceStore } from "./devices.ts";
import { AccountPcError, MachineActionRequired, MachineManager, PcUpdateRefused, type AccountPcFailure } from "./machines.ts";
import { TypedCodeError, type TypedCodeFailure } from "../shared/relay-code-offer.ts";
import { TargetAccountPcError } from "../shared/relay-channel.ts";
import { TailnetPcError } from "./tailnet-pcs.ts";
import { canSendSecret, sameOrigin } from "./machine-security.ts";
import { isJsonObject, jsonResponse, setRequestRoute } from "./http.ts";
import { updateRequestAllowed } from "./update-api.ts";
import { crossSiteFileRead, FILE_POLICY, pagePolicy } from "./file-view.ts";
import { snapshotWithoutHiddenTokens, withoutHiddenTokens } from "./herdr-sidebar.ts";
import { parseJson, readCapped, REMOTE_LIMITS, RemoteResponseInvalid, RemoteResponseTooLarge } from "./remote-json.ts";
import { answerCode, moveAll, moveAllPlans, PC_MOVE_PATH, PC_UPDATE_REQUIRED, tooOldToMove } from "./remote-move.ts";
import { ADDRESS_PC_WORDS, AddressPcError } from "./address-pc.ts";

const fail = (code: string, message: string, status: number) => jsonResponse({ error: { code, message } }, status);

/** The PCs an account-joined device is told, over its terminal socket or GET /api/machines: this PC's own row alone. */
export const accountRoster = (layout: AgentRowTokens | null, machines: Machine[]): Machine[] =>
  withoutHiddenTokens(layout, machines.filter((machine) => machine.id === LOCAL_MACHINE));
/**
 * Updating this PC's PCs, as switching its own runtime (dispatch.ts): only its owner, from this app's own page (the
 * update header, same origin, no query).
 */
const OWNER_ONLY = "Only the owner's own signed-in or paired devices can change this PC's PCs, from this app's own page.";
const MOVE_OWNER_ONLY = "Only the owner, from a device signed in or paired to drive this PC, can move another PC";
const MOVE_FROM_PAGE = "A move must come from this app's own page";
/** Who may have a PC pair itself with another PC of the account: this PC's own routes (dispatch.ts) and another PC's through it. */
export const ACCOUNT_PC_OWNER_ONLY = "Add PCs of your account on this PC itself, or from a device paired with it.";
/**
 * Another PC's own "Adding a PC of your account" routes (docs/account.md), asked through this PC: that PC answers by
 * this server's row there, which for a PC added from the account only watches (read_only), as for any write.
 */
const ACCOUNT_PC_PATH = /^machines\/relay\/account\/(?:check|start|pair)$/;

/** POST /api/machines/relay/account/*: the status each refusal answers, as `account_pc_<failure>`. */
const ACCOUNT_PC_STATUS: Record<AccountPcFailure, number> = {
  invalid: 400, added: 409, self: 409, outdated: 409, offline: 502, gone: 410, busy: 409, refused: 403, declined: 403, unanswered: 504, cancelled: 499,
};

/** POST /api/machines/relay/code: why a typed code found no PC, as `typed_code_<failure>` (the app words each one). */
const CODE_FAILURES: Record<TypedCodeFailure, [string, number]> = {
  "not-a-code": ["A code has ten letters and digits", 400],
  "no-pc": ["No PC shows this code", 404],
  wrong: ["That code did not work", 400],
  expired: ["That code ran out", 410],
  busy: ["Another device is trying this code", 409],
  unreachable: ["The relay could not be reached", 502],
  forged: ["The answer did not come from a PC this app can pair with", 502],
};

/**
 * How far one browser's machine events may fall behind before its stream is ended (it reconnects and
 * reads the roster afresh). Counted in bytes, not frames: a burst of status changes from 20 or more
 * agents queues more small frames than a frame count allowed before the browser has read any.
 * A frame larger than this (the roster of thousands of panes) is let through on top of it while it
 * is still queued, never afterwards, so a stream opening with one does not end at its next frame.
 */
export const MACHINE_EVENTS_QUEUE_BYTES = 4 * 1024 * 1024;
export const MACHINE_EVENTS_TOTAL_BYTES = 32 * 1024 * 1024;
export const MACHINE_EVENTS_STALL_MS = 30_000;
export const MACHINE_EVENTS_CEILING_BYTES = 64 * 1024 * 1024;
export const machineEventsClock = {
  now: (): number => performance.now(),
  heartbeat: (send: () => void): ReturnType<typeof setInterval> => setInterval(send, 15_000),
};

export interface EventStreamBudget {
  reserve(bytes: number): boolean;
  release(bytes: number): void;
}

interface EventsQueue { queued: () => number; taken: () => number; drop: () => void; told: number; seenTaken: number; movedAt: number }
const observe = (queue: EventsQueue, now: number): void => {
  const taken = queue.taken();
  if (taken !== queue.seenTaken || queue.queued() === 0) { queue.seenTaken = taken; queue.movedAt = now; }
};
const eventsQueues = new Set<EventsQueue>();
let toldTotal = 0;
const forgetQueue = (queue: EventsQueue): void => {
  if (!eventsQueues.delete(queue)) return;
  toldTotal -= queue.told;
  queue.told = 0;
};
export const machineEventsQueuedBytes = (): number => {
  let total = 0;
  for (const queue of eventsQueues) total += queue.queued();
  return total;
};

/**
 * A PC route whose answer can take longer than the proxy's usual 75 s: a worktree's creation waits on
 * git and then an agent's start, and a resume on the agent's start and then the check of its store.
 */
// runtime/move/install waits 200 s here: that PC holds the request up to 180 s (dispatch.ts), so an install that ends late is still told
export const slowMachinePath = (path: string): boolean => path === "worktree/create" || path === "sessions/resume" || path === "runtime/move/install";

/**
 * A path no route is spelled as: an empty segment (`//`, or a trailing `/`) or an encoded separator.
 * Path checks match the canonical spelling, and the PC proxy drops empty segments before it
 * forwards, so such a path must be no route at all rather than "some other route".
 */
export const nonCanonicalPath = (pathname: string): boolean => pathname.includes("//") || (pathname.length > 1 && pathname.endsWith("/")) || /%2f|%5c/i.test(pathname);
export const MACHINE_PROXY_PATH = /^(?:session|sessions\/(?:history|resume)|agents|agent-catalog(?:\/(?:install|sign-in))?|integrations|system|usage\/statusline|pane\/(?:read|scroll|find|selection|conversation(?:\/image|\/tool-output)?|summary|commands|files|docs|omo-tasks|background-agent|plan|artifacts|btw|prompt|prompt\/answer|turn\/(?:cancel(?:-children)?|release)|input|keys|close|rename|image|split|zoom|swap|move|resize|clear|focus)|workspace\/(?:create|rename|move|close|directories|diff\/files|diff\/file|diff\/refs|git\/log|git\/branches|git\/show|pr|pr\/log|pr\/merge)|worktree\/(?:create|list|inventory|open|remove)|tab\/(?:create|rename|close|move|move-to-workspace)|layout\/ratio|agent\/(?:rename|commands)|plugins\/actions|plugin\/action|fs\/(?:stat|file|favicon|text))$/;


function transportFailure(id: string, path: string, error: unknown): Response {
  const timedOut = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
  console.error(`machine proxy ${id}${path}: ${timedOut ? "timed out" : "unreachable"}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  return timedOut
    ? fail("machine_timeout", "The PC did not answer in time; retry after reconnecting", 504)
    : fail("machine_unavailable", "The PC connection was interrupted; retry after reconnecting", 502);
}

/**
 * An answer this app will not pass on: too large to hold, or unreadable where it must be redacted.
 * Its fixed message names none of it; the browser shows it in the UI language by the code (src/lib/api.ts).
 */
function unusableAnswer(id: string, path: string, error: RemoteResponseTooLarge | RemoteResponseInvalid): Response {
  const tooLarge = error instanceof RemoteResponseTooLarge;
  console.error(`machine proxy ${id}${path}: ${tooLarge ? "answer too large" : "answer unreadable"}`);
  return fail(tooLarge ? "remote_response_too_large" : "remote_response_invalid", error.message, 502);
}

export async function handleMachineRequest(request: Request, manager: MachineManager, onRevoke?: (close: () => void) => () => void,
  preferences?: { get(): SharedPreferences; subscribe(listener: (preferences: SharedPreferences) => void): () => void }, readOnly = false,
  herdrSidebar?: { get(): AgentRowTokens | null; subscribe(listener: (agents: AgentRowTokens | null) => void): () => void },
  seen?: { list(): SeenFinish[]; subscribe(listener: (finish: SeenFinish) => void): () => void },
  /** durable device enrollments (server/devices.ts), already without the ones this stream's own device made, and relay pairings waiting for approval */
  pairings?: { subscribe(listener: (event: DevicePairedEvent | DevicePairedSeenEvent | DeviceRemovedEvent | RelayPairingsEvent | RemotePairingsEvent | PendingRedemptionsEvent | AgentToolPanesEvent) => void): () => void },
  relayBudget?: EventStreamBudget,
  /** this PC's owner (access.ts ownerAccess): only they may start or stop updates of its PCs */
  owner = false,
  /** OVIS_ACCOUNT_OPENS_ALL is on here: only then does the roster carry a block to another PC's account records */
  accountOpensAll = false, source?: Pick<DeviceStore, "accountPolicyActive" | "accountError">,
  /** an account-joined device (DeviceStore.isAccountRow): its roster is accountRoster, and no PC's boot is proved for it */
  accountRow = false): Promise<Response> {
  const url = new URL(request.url);
  // A PC's file opens as this PC's /api/fs/file does, from any navigation: reading it changes
  // nothing, and Chrome on Android shows a PDF in the viewer's frame as an "Open" button whose
  // navigation is cross-site. Every other PC route still answers only this app.
  const fileRead = ["GET", "HEAD"].includes(request.method) && /^\/api\/machines\/[^/]+\/fs\/file$/.test(url.pathname);
  if (!fileRead && !sameOrigin(request)) return fail("invalid_origin", "Use PC controls from this app", 403);
  // a navigation may open a PC's file from anywhere; another page loading it as a picture may not
  if (fileRead && crossSiteFileRead(request)) return fail("cross_site", "A file is read from this app or opened in a tab, not loaded by another page", 403);
  if (!["GET", "HEAD"].includes(request.method) && request.headers.get("x-herdr-machine") !== "1") return fail("invalid_machine_request", "Use PC controls from this app", 403);
  // an empty segment is never a route: dropping it would forward `<id>//fs/file` as `fs/file`
  if (nonCanonicalPath(url.pathname)) return fail("not_found", "not found", 404);
  const parts = url.pathname.slice("/api/machines".length).split("/").filter(Boolean);
  // one rule for every change to this PC's PCs (adding, setting up, approving, updating, turning on or off, removing,
  // its settings): the owner from any device he signed in or paired himself, from this app's own page. A PC's own
  // routes (its panes, workspaces and files, MACHINE_PROXY_PATH) are driven as this PC's are, and keep their rules
  const path = parts.slice(1).join("/");
  const accountRecords = accountOpensAll && request.method === "POST" && path === "account/records";
  // that PC would pair itself with the PC named, by this server's word: only this PC's owner asks it, as for this PC's
  // own routes (dispatch.ts); a watching device was refused before (read_only)
  const accountPc = request.method === "POST" && ACCOUNT_PC_PATH.test(path);
  const proxyPath = MACHINE_PROXY_PATH.test(path) || accountRecords || accountPc;
  if (accountRecords && !owner) return fail("owner_only", "Manage the account from this PC itself, or from a paired device.", 403);
  if (accountPc && !owner) return fail("owner_only", ACCOUNT_PC_OWNER_ONLY, 403);
  const managing = !["GET", "HEAD", "OPTIONS"].includes(request.method) && !proxyPath;
  if (managing && !(owner && updateRequestAllowed(request))) return fail("forbidden", OWNER_ONLY, 403);
  if (request.method === "POST" && (parts.join("/") === "relay" || parts.join("/") === "relay/code" || parts.join("/") === "tailnet") && source?.accountPolicyActive()) {
    if (source.accountError !== null) return fail("pc_add_account_unavailable", "Can't add a PC right now. Try again in a moment.", 409);
    return fail("pc_add_source_bound", "This PC is in an account. Add PCs from your account.", 409);
  }
  try {
    if (!parts.length && request.method === "GET") {
      setRequestRoute("/api/machines");
      const asked = url.searchParams.getAll("verify_source_boot");
      // as the machine events tell it, for every answer below: without the token values herdr's rows hide
      // (withoutHiddenTokens), and without a PC's own agent_refs (wireMachine)
      const shown = () => (accountRow ? accountRoster : withoutHiddenTokens)(herdrSidebar?.get() ?? null, manager.list()).map((machine) => wireMachine(machine, false));
      if (asked.length === 0) {
        if (url.searchParams.get("compact_agents") !== "1") return jsonResponse({ machines: shown() } satisfies MachineRoster);
        return jsonResponse({ machines: shown().map((machine) => wireMachine(machine, true)) } satisfies { machines: WireMachine[] });
      }
      if (accountRow) return fail("local_only", "An account-joined device cannot do this from afar", 403);
      if (asked.length > 1 || asked[0] === "") return fail("invalid_query", "verify_source_boot names one PC", 400);
      const machineId = asked[0]!;
      const proof = await manager.verifySourceBoot(machineId, request.signal);
      if ("refused" in proof) {
        if (proof.refused === "unknown") return fail("machine_not_found", "PC not found", 404);
        const response = fail("source_unverified", proof.refused === "interval" ? "This PC's server was asked a moment ago; ask again shortly" : "This PC's server could not be verified now", 503);
        response.headers.set("cache-control", "no-store");
        if (proof.refused === "interval") response.headers.set("retry-after", "1");
        return response;
      }
      return jsonResponse({ machines: shown(), verified_source_boot: { machine_id: machineId, boot_id: proof.boot_id } } satisfies MachineRoster, 200, { "cache-control": "no-store" });
    }
    if (parts[0] === "events" && parts.length === 1 && request.method === "GET") {
      setRequestRoute("/api/machines/events");
      let stop: (() => void) | undefined;
      let unwatchDevice: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let close = () => {};
      let drop = () => {};
      let queue: EventsQueue | undefined;
      let charged = 0;
      let accountTaken = () => {};
      const aborted = () => drop();
      const cleanup = () => {
        stop?.(); unwatchDevice?.(); clearInterval(heartbeat);
        request.signal.removeEventListener("abort", aborted);
        if (queue) forgetQueue(queue);
        relayBudget?.release(charged);
        charged = 0;
      };
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false;
          close = () => { if (closed) return; closed = true; cleanup(); try { controller.close(); } catch {} };
          // fallen behind, refused or gone: an error, not a close, so what waits is dropped instead of still delivered
          drop = () => { if (closed) return; closed = true; cleanup(); try { controller.error(new Error("machine events: stream ended")); } catch {} };
          // a revoked device that keeps up gets a clean end; one with a backlog waiting is not reading it, so that is dropped
          unwatchDevice = onRevoke?.(() => { if ((queue?.queued() ?? 0) > 0) drop(); else close(); });
          if (closed) return;
          const queued = () => MACHINE_EVENTS_QUEUE_BYTES - (controller.desiredSize ?? MACHINE_EVENTS_QUEUE_BYTES);
          accountTaken = () => {
            if (!relayBudget || closed) return;
            const remaining = Math.max(0, queued());
            relayBudget.release(charged - remaining);
            charged = remaining;
          };
          let written = 0;
          const large: { end: number; bytes: number }[] = [];
          const largeQueued = (): number => {
            const left = written - queued();
            while (large.length > 0 && large[0]!.end <= left) large.shift();
            return large.reduce((most, frame) => Math.max(most, frame.bytes), 0);
          };
          const own: EventsQueue = { queued, taken: () => written - queued(), drop, told: 0, seenTaken: 0, movedAt: machineEventsClock.now() };
          queue = own;
          eventsQueues.add(own);
          const retell = (): void => { const now = queued(); toldTotal += now - own.told; own.told = now; };
          const stalled = (other: EventsQueue, now: number): boolean => other.told > 0 && now - other.movedAt >= MACHINE_EVENTS_STALL_MS;
          const send = (text: string) => {
            if (closed) return;
            accountTaken();
            if (relayBudget) {
              const size = Buffer.byteLength(text);
              if (!relayBudget.reserve(size)) { drop(); return; }
              charged += size;
            }
            const bytes = encoder.encode(text);
            const now = machineEventsClock.now();
            retell();
            observe(own, now);
            const counted = bytes.byteLength > MACHINE_EVENTS_QUEUE_BYTES ? Math.min(bytes.byteLength, largeQueued()) : bytes.byteLength;
            if (own.told - largeQueued() + counted > MACHINE_EVENTS_QUEUE_BYTES) { drop(); return; }
            if (toldTotal + bytes.byteLength > MACHINE_EVENTS_TOTAL_BYTES) {
              toldTotal = 0;
              for (const other of eventsQueues) { other.told = other.queued(); toldTotal += other.told; observe(other, now); }
              while (toldTotal + bytes.byteLength > MACHINE_EVENTS_TOTAL_BYTES) {
                let most: EventsQueue | undefined;
                for (const other of eventsQueues) if (stalled(other, now) && (most === undefined || other.told > most.told)) most = other;
                if (most === undefined) break;
                most.drop();
                if (most === own) return;
              }
              if (toldTotal + bytes.byteLength > MACHINE_EVENTS_CEILING_BYTES && toldTotal - own.told > 0) { drop(); return; }
            }
            try { controller.enqueue(bytes); } catch { drop(); return; }
            written += bytes.byteLength;
            if (bytes.byteLength > MACHINE_EVENTS_QUEUE_BYTES) large.push({ end: written, bytes: bytes.byteLength });
            retell();
          };
          stop = subscribeMachineEvents({ manager, preferences, herdrSidebar, seen, pairings },
            (event) => send(`data: ${JSON.stringify(wireMachineEvent(event, url.searchParams.get("compact_agents") === "1"))}\n\n`));
          if (closed) { cleanup(); return; }
          heartbeat = machineEventsClock.heartbeat(() => send(": heartbeat\n\n"));
          request.signal.addEventListener("abort", aborted, { once: true });
          if (request.signal.aborted) aborted();
        },
        pull() { accountTaken(); },
        cancel() { close(); },
      }, new ByteLengthQueuingStrategy({ highWaterMark: MACHINE_EVENTS_QUEUE_BYTES }));
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
    }
    if (parts[0] === "relay" && parts.length === 1 && request.method === "POST") {
      setRequestRoute("/api/machines/relay");
      // the link holds a one-time pairing code, a secret like an SSH password
      if (!canSendSecret(request)) return fail("https_required", "A pairing link requires HTTPS or localhost", 403);
      const body: unknown = await request.json().catch(() => null);
      if (!isJsonObject(body)) return fail("invalid_body", "Expected a pairing link", 400);
      return jsonResponse({ machine: await manager.addRelay(body.link, body.name, body.found) }, 201);
    }
    // Add a connection → Direct, an https address: only a window direct to this PC that drives it gets here (dispatch.ts)
    if (parts[0] === "address" && parts.length === 1 && request.method === "POST") {
      setRequestRoute("/api/machines/address");
      // the code that PC shows is a secret, like an SSH password
      if (!canSendSecret(request)) return fail("https_required", "A pairing code requires HTTPS or localhost", 403);
      const body: unknown = await request.json().catch(() => null);
      if (!isJsonObject(body)) return fail("invalid_body", "Expected an address and a code", 400);
      try { return jsonResponse({ machine: await manager.addAddress(body.address, body.code, body.name) }, 201); }
      catch (error) {
        if (!(error instanceof AddressPcError)) throw error;
        const [message, status] = ADDRESS_PC_WORDS[error.failure];
        return fail(`address_pc_${error.failure}`, message, status);
      }
    }
    if (parts[0] === "relay" && parts[1] === "code" && parts.length === 2 && request.method === "POST") {
      setRequestRoute("/api/machines/relay/code");
      // the code is a secret, and what it finds holds the other PC's one-time pairing code, which stays on this server
      if (!canSendSecret(request)) return fail("https_required", "A pairing code requires HTTPS or localhost", 403);
      const body: unknown = await request.json().catch(() => null);
      if (!isJsonObject(body)) return fail("invalid_body", "Expected a pairing code", 400);
      try { return jsonResponse(await manager.relayFoundByCode(body.code, request.signal)); }
      catch (error) {
        if (!(error instanceof TypedCodeError)) throw error;
        const [message, status] = CODE_FAILURES[error.failure];
        return fail(`typed_code_${error.failure}`, message, status);
      }
    }
    // Add a connection → Ovis relay: another PC of the account, vouched for by this window's admission (docs/account.md,
    // "Adding a PC of your account"). Only a device that drives this PC, directly or over the relay, gets here (dispatch.ts)
    if (parts[0] === "relay" && parts[1] === "account" && parts.length === 3) {
      setRequestRoute(`/api/machines/relay/account/${parts[2]}`);
      if (readOnly) return fail("read_only", "this device can only watch", 403);
      if (request.method !== "POST") return fail("method_not_allowed", "Use POST", 405);
      const body: unknown = await request.json().catch(() => null);
      if (!isJsonObject(body)) return fail("invalid_body", "Expected a PC of the account", 400);
      const refused = (error: unknown): Response => {
        if (!(error instanceof AccountPcError)) throw error;
        return fail(`account_pc_${error.failure}`, error.message, ACCOUNT_PC_STATUS[error.failure]);
      };
      if (parts[2] === "check") {
        try { return jsonResponse({ pcs: await manager.checkAccountPcs(body.pcs) }, 200, { "cache-control": "no-store" }); }
        catch (error) { return refused(error); }
      }
      if (parts[2] === "start") {
        try { return jsonResponse(await manager.startAccountPc(body.pc)); }
        catch (error) { return refused(error); }
      }
      if (parts[2] === "pair") {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const line = (value: unknown): void => { try { controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`)); } catch {} };
            void manager.pairAccountPc(body.ticket, () => line({ waiting: true }), request.signal)
              .then((machine) => line({ machine }), (error: unknown) => {
                if (error instanceof AccountPcError) line({ error: { code: `account_pc_${error.failure}`, message: error.message } });
                else line({ error: { code: "internal_error", message: error instanceof Error ? error.message : String(error) } });
              })
              .finally(() => { try { controller.close(); } catch {} });
          },
        });
        return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" } });
      }
      return fail("not_found", "not found", 404);
    }
    if (parts[0] === "ssh-candidates" && parts.length === 1) {
      setRequestRoute("/api/machines/ssh-candidates");
      // adding a PC is a driving device's; a watching one is not told which hosts this PC knows either
      if (readOnly) return fail("read_only", "this device can only watch", 403);
      if (request.method !== "GET") return fail("method_not_allowed", "Use GET", 405);
      return jsonResponse({ pcs: await manager.listSshCandidates() }, 200, { "cache-control": "no-store" });
    }
    if (parts[0] === "tailnet" && parts.length === 1) {
      setRequestRoute("/api/machines/tailnet");
      // adding a PC is a driving device's; a watching one is not told which PCs are there either
      if (readOnly) return fail("read_only", "this device can only watch", 403);
      if (request.method === "GET") return jsonResponse({ pcs: await manager.listTailnet() }, 200, { "cache-control": "no-store" });
      if (request.method !== "POST") return fail("method_not_allowed", "Use GET or POST", 405);
      const body: unknown = await request.json().catch(() => null);
      if (!isJsonObject(body)) return fail("invalid_body", "Expected the address of a PC found on Tailscale", 400);
      try { return jsonResponse({ machine: await manager.addTailnet(body.url) }, 201); }
      catch (error) {
        if (error instanceof TypedCodeError) {
          const [message, status] = CODE_FAILURES[error.failure];
          return fail(`typed_code_${error.failure}`, message, status);
        }
        if (!(error instanceof TailnetPcError)) throw error;
        return fail(`tailnet_${error.failure}`, error.message, error.failure === "not_found" ? 404 : error.failure === "unreachable" ? 502 : 409);
      }
    }
    if (parts[0] === "setup") {
      if (parts.length === 1 && request.method === "POST") {
        setRequestRoute("/api/machines/setup");
        const body = await request.json() as SetupRequest;
        // a setup that updates what runs there is an update of that PC: the owner's only, as above
        // the addresses its one-job-per-PC check compares, resolved first (ssh -G, off the event loop, 3 s at most)
        await manager.resolveFor(body);
        return jsonResponse(manager.setup(body), 202);
      }
      if (parts.length === 2) {
        setRequestRoute("/api/machines/setup/:job_id");
        const action = request.method === "POST" ? await request.json().catch(() => null) as SetupAction | null : null;
        const job = manager.job(parts[1]!);
        if (!job) return fail("job_not_found", "Setup job not found", 404);
        if (request.method === "POST") {
          if (!isJsonObject(action)) return fail("invalid_body", "Expected a setup action", 400);
          if (action.action === "answer" && job.challenge?.kind === "secret" && !canSendSecret(request)) return fail("https_required", "Passwords and key passphrases require HTTPS or localhost", 403);
          manager.action(parts[1]!, action);
        } else if (request.method === "DELETE") manager.action(parts[1]!, { action: "cancel" });
        else if (request.method !== "GET") return fail("method_not_allowed", "Use GET, POST or DELETE", 405);
        return jsonResponse(manager.job(parts[1]!));
      }
    }
    if (parts[0] === "settings" && parts.length === 1) {
      setRequestRoute("/api/machines/settings");
      if (request.method === "GET") return jsonResponse(manager.settings());
      if (request.method !== "PATCH") return fail("method_not_allowed", "Use GET or PATCH", 405);
      const patch = await request.json();
      if (!isJsonObject(patch)) return fail("invalid_body", "Expected PC settings", 400);
      return jsonResponse(manager.updateSettings(patch));
    }
    if (parts[0] === "install" && parts.length <= 2) {
      // its jobs name SSH addresses and PCs: read by the owner only (the change itself takes the guard above)
      if (!owner) return fail("forbidden", OWNER_ONLY, 403);
      if (parts.length === 1) {
        setRequestRoute("/api/machines/install");
        if (request.method !== "POST") return fail("method_not_allowed", "Use POST", 405);
        const body: unknown = await request.json().catch(() => null);
        if (!isJsonObject(body)) return fail("invalid_body", "Expected an SSH address, or the machine_id of a PC added here", 400);
        await manager.resolveFor(body);
        try { return jsonResponse(manager.install(body as unknown as PcInstallRequest) satisfies PcInstallJob, 202); }
        catch (error) {
          if (error instanceof PcUpdateRefused) return fail("install_unavailable", error.message, 409);
          throw error;
        }
      }
      setRequestRoute("/api/machines/install/:job_id");
      if (request.method === "DELETE") manager.cancelInstall(parts[1]!);
      else if (request.method !== "GET") return fail("method_not_allowed", "Use GET or DELETE", 405);
      const job = manager.installJob(parts[1]!);
      return job ? jsonResponse(job) : fail("job_not_found", "Install job not found", 404);
    }
    if (parts[0] === "update-all" && parts.length === 1) {
      setRequestRoute("/api/machines/update-all");
      if (request.method !== "POST") return fail("method_not_allowed", "Use POST", 405);
      return jsonResponse(manager.updateAll() satisfies PcUpdateAll, 202);
    }
    if (parts[0] === "runtime" && parts[1] === "move-all" && parts.length === 2) {
      setRequestRoute("/api/machines/runtime/move-all");
      if (readOnly) return fail("read_only", "this device can only watch", 403);
      if (!owner) return fail("forbidden", MOVE_OWNER_ONLY, 403);
      if (request.method !== "POST") return fail("method_not_allowed", "Use POST", 405);
      if (!updateRequestAllowed(request)) return fail("forbidden", MOVE_FROM_PAGE, 403);
      const plans = moveAllPlans(await request.json().catch(() => null), manager.list().length);
      if (!plans) return fail("invalid_body", "Expected { plans: [{ machine_id, revision }] }, each PC once", 400);
      return jsonResponse(await moveAll(manager, plans), 202);
    }
    const id = parts[0]!;
    if (parts.length === 2 && parts[1] === "update") {
      setRequestRoute("/api/machines/:machine_id/update");
      if (request.method === "DELETE") return jsonResponse({ cancelled: manager.cancelUpdate(id) });
      if (request.method !== "POST") return fail("method_not_allowed", "Use POST or DELETE", 405);
      const text = await request.text();
      let body: unknown = {};
      if (text.trim() !== "") { try { body = JSON.parse(text); } catch { body = null; } }
      const shown = isJsonObject(body) ? body.revision : undefined;
      if (!isJsonObject(body) || shown !== undefined && typeof shown !== "string") return fail("invalid_body", "Expected nothing, or { revision } of the offer shown", 400);
      try { return jsonResponse(manager.update(id, shown as string | undefined) satisfies PcUpdateStarted, 202); }
      catch (error) {
        if (error instanceof PcUpdateRefused || error instanceof MachineActionRequired) return fail("update_unavailable", error.message, 409);
        throw error;
      }
    }
    if (parts.length === 2 && parts[1] === "update-bridge" && request.method === "POST") {
      setRequestRoute("/api/machines/:machine_id/update-bridge");
      const text = await request.text();
      const body: unknown = text.trim() === "" ? {} : (() => { try { return JSON.parse(text); } catch { return null; } })();
      const shown = isJsonObject(body) ? body.revision : undefined;
      if (!isJsonObject(body) || shown !== undefined && typeof shown !== "string") return fail("invalid_body", "Expected nothing, or { revision } of the offer shown", 400);
      await manager.resolveFor({ machine_id: id });
      return jsonResponse(manager.updateBridge(id, false, shown as string | undefined), 202);
    }
    if (parts.length === 1 && request.method === "PATCH") {
      setRequestRoute("/api/machines/:machine_id");
      const patch = await request.json();
      if (!isJsonObject(patch)) return fail("invalid_body", "Expected a PC update", 400);
      manager.patch(id, patch); return jsonResponse({ ok: true });
    }
    if (parts.length === 1 && request.method === "DELETE") { setRequestRoute("/api/machines/:machine_id"); manager.remove(id); return jsonResponse({ ok: true }); }
    // earlier sessions carry their first prompts, and a folder's command files name what is in it (the new-tab
    // dialog's agent commands, a pane's command rows), as do the paths under a pane's folder and a plugin run's
    // output, and a repository's checkouts: never asked for a watching device with the PC's credential
    if (readOnly && (path === "sessions/history" || path === "agent/commands" || path === "pane/commands" || path === "pane/files" || path === "pane/docs" || path === "plugin/action" || path === "worktree/list" || path === "worktree/inventory")) return fail("read_only", "this device can only watch", 403);
    const movePath = PC_MOVE_PATH.test(path);
    // a move's plan names every pane's folder and conversation, and the rest move or end them: a driving device's only
    if (readOnly && movePath) return fail("read_only", "this device can only watch", 403);
    if (movePath && !owner) return fail("forbidden", MOVE_OWNER_ONLY, 403);
    // that PC refuses a move route with a query (updateRequestAllowed), which would read as an Ovis too old below
    if (movePath && url.search !== "") return fail("invalid_query", "The move routes take no query", 400);
    if (movePath && request.method !== "GET" && !updateRequestAllowed(request)) return fail("forbidden", MOVE_FROM_PAGE, 403);
    if (proxyPath || movePath) {
      // `path` is a finite endpoint literal, never the machine id or an arbitrary suffix.
      setRequestRoute(`/api/machines/:machine_id/${path}`);
      // a connection that may only watch is refused here as well as at the access check, by the same rule
      // (index.ts `mutating`): it writes nothing on another PC
      if (readOnly && !["GET", "HEAD", "OPTIONS"].includes(request.method)) return fail("read_only", "this device can only watch", 403);
      const endpoint = manager.endpoint(id);
      if (!endpoint) {
        manager.retryNow(id);
        return fail("machine_offline", "This PC is disconnected", 503);
      }
      // Explicit header allowlist: cookies, browser Authorization, forwarded headers
      // and remote Set-Cookie never cross this boundary. No arbitrary target URLs.
      const headers = new Headers({ authorization: `Bearer ${endpoint.token}` });
      const contentType = request.headers.get("content-type");
      if (contentType) headers.set("content-type", contentType);
      const ifNoneMatch = request.headers.get("if-none-match");
      if (ifNoneMatch) headers.set("if-none-match", ifNoneMatch);
      // The receiver's app mutation markers; this server has already checked the caller.
      if (movePath || accountPc) headers.set("x-herdr-update", "1");
      if (accountRecords || accountPc) headers.set("x-herdr-machine", "1");
      const abort = new AbortController();
      if (path === "fs/file") {
        // a file (a video, say) streams through, with its ranges, never held here; it can
        // play for longer than any request timeout
        const range = request.headers.get("range");
        if (range) headers.set("range", range);
        try {
          const response = await fetch(`${endpoint.url}/api/${path}${url.search}`, { method: request.method, headers, redirect: "error", signal: request.signal });
          const passed = new Headers({ "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
          for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "content-disposition"]) {
            const value = response.headers.get(name);
            if (value) passed.set(name, value);
          }
          // That PC's answer opens as this app's origin, so its own policy is never what holds here.
          // A PDF is drawn by the browser's viewer (which refuses a sandbox), as the local route does;
          // only an HTML answer asked to render is a page, named as HTML and nothing else: whatever
          // policy that PC names, the page policy this server gives its own pages (as that PC's bridge
          // answers, with no media address) is added after it, and of two policies the stricter holds;
          // anything else, an SVG asked to render too, gets the local route's policy.
          const type = passed.get("content-type")?.split(";")[0]?.trim().toLowerCase();
          if (type === "application/pdf") passed.set("content-type", "application/pdf");
          else if (type === "text/html" && url.searchParams.get("render") === "1") {
            const theirs = response.headers.get("content-security-policy");
            passed.set("content-type", "text/html; charset=utf-8");
            passed.set("content-security-policy", theirs ? `${theirs}, ${pagePolicy(null)}` : pagePolicy(null));
          } else passed.set("content-security-policy", FILE_POLICY);
          return new Response(response.body, { status: response.status, headers: passed });
        } catch (error) { return transportFailure(id, path, error); }
      }
      if (accountPc) {
        // passed on as it comes, never held: `pair` is a stream of lines whose first, `waiting`, tells the person to approve
        // on another device while that PC waits for a member's approval, up to 180 s there (dispatch.ts); held 200 s here
        try {
          const response = await fetch(`${endpoint.url}/api/${path}`, { method: "POST", headers, body: request.body, redirect: "error",
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(path.endsWith("/pair") ? 200_000 : 75_000)]) });
          return new Response(response.body, { status: response.status, headers: {
            "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store", "x-accel-buffering": "no",
            "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'",
          } });
        } catch (error) { return transportFailure(id, path, error); }
      }
      // A watching device gets a plan card as the PC's screen shows it, never Claude's plan file:
      // the PC is asked for that (`plan=0`), and a PC that ignores the ask loses the file here.
      const watchedPrompt = readOnly && path === "pane/prompt";
      const target = new URL(`${endpoint.url}/api/${path}${url.search}`);
      if (watchedPrompt) target.searchParams.set("plan", "0");
      // nor has it the PC run its shell profile again: the PC sees this server's full token, not the watch
      if (readOnly && path === "agent-catalog") target.searchParams.delete("recheck");
      const untrack = manager.trackTerminal(id, () => abort.abort());
      const moved = path === "workspace/move" && request.method === "POST" ? manager.refreshAfterMove(id) : null;
      try {
        const response = await fetch(target, { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body, redirect: "error", signal: AbortSignal.any([request.signal, abort.signal, AbortSignal.timeout(path === "runtime/move/install" ? 200_000 : slowMachinePath(path) ? 165_000 : 75_000)]) });
        if (moved && response.ok) moved();
        if (movePath && request.method !== "GET" && response.ok) manager.moveOfferSoon(id);
        const etag = response.headers.get("etag");
        const serverTime = response.headers.get("x-server-time");
        const retryAfter = response.status === 503 ? response.headers.get("retry-after") : null;
        // held whole before it is passed on (and parsed, for a watcher's prompt), so only up to a size
        let body: Uint8Array<ArrayBuffer> | null = response.status === 304 ? null : await readCapped(response, watchedPrompt ? REMOTE_LIMITS.watchedPrompt : REMOTE_LIMITS.proxy);
        if (movePath && tooOldToMove(manager.list().find((machine) => machine.id === id)?.kind, response.status, answerCode(body))) return fail("pc_update_required", PC_UPDATE_REQUIRED, 409);
        if (watchedPrompt && response.ok && body) {
          const answer = parseJson<PanePromptResponse>(body);
          if (answer.prompt?.plan_file !== undefined) {
            // the body is the plan file's text and the screen's is not in the answer: the card keeps
            // its question and options, without a body
            const { plan_file: _planFile, ...card } = answer.prompt;
            answer.prompt = { ...card, body: null };
          }
          if (answer.outcomes) answer.outcomes = answer.outcomes.map(({ preview: _preview, result_text: _resultText, ...outcome }) => outcome);
          body = new TextEncoder().encode(JSON.stringify(answer));
        }
        // a PC's session as the roster tells it, without the token values this server's rows hide (#2160)
        // any method the PC answers with a body (its route takes them all); a HEAD's is empty
        if (path === "session" && response.ok && body && body.byteLength > 0) {
          const answer = parseJson<{ snapshot?: SessionSnapshot }>(body);
          const shown = answer.snapshot && snapshotWithoutHiddenTokens(herdrSidebar?.get() ?? null, answer.snapshot);
          if (shown && shown !== answer.snapshot) body = new TextEncoder().encode(JSON.stringify({ ...answer, snapshot: shown }));
        }
        return new Response(body, { status: response.status, headers: {
          "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store", ...(etag ? { etag } : {}),
          // whatever type that PC names, its answer never runs as this app's origin
          "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'",
          ...(retryAfter ? { "retry-after": retryAfter } : {}), ...(serverTime ? { "x-server-time": serverTime } : {}),
        } });
      } catch (error) {
        if (error instanceof RemoteResponseTooLarge || error instanceof RemoteResponseInvalid) return unusableAnswer(id, path, error);
        return transportFailure(id, path, error);
      }
      finally { untrack(); }
    }
    return fail("not_found", "Unknown PC endpoint", 404);
  } catch (e) {
    if (e instanceof TargetAccountPcError) return fail("pc_add_target_bound", e.message, 409);
    return fail("machine_request_failed", e instanceof Error ? e.message : String(e), 400);
  }
}
