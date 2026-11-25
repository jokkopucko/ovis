import { randomBytes } from "node:crypto";
import { channelBinding } from "../../shared/relay-e2ee.ts";
import type { SecureChannel } from "../../shared/relay-e2ee.ts";
import { commitmentHolds, fromBase64Url, PAIR_APPROVAL_MS, pairDigits, randomPairNonce, toBase64Url } from "../../shared/relay-pair-sas.ts";
import { deriveServerId, proofKey, serverChallenge, verifyServerProof } from "../../shared/relay-server-proof.ts";
import { MuxEngine, MuxStreamError } from "../../shared/relay-mux-engine.ts";
import type { HttpStream, MuxClock, SessionFrame, WsStream } from "../../shared/relay-mux-engine.ts";
import { ACCOUNT_FEATURE, ACCOUNT_LIST_ALLOW, ACCOUNT_LIST_FEATURE, ACCOUNT_LISTING_ERRORS, ACCOUNT_OPENS_ALL_FEATURE, AUTH_RECEIPTS_MAX, DIRECT_CARRIER, DIRECT_TAILNET, FrameType, KEY_PROOF_FEATURE, LARGE_WS_MESSAGES, LIMITS_V1, MuxProtocolError, PAIR_INTENT_ACCOUNT, PAIR_INTENT_PC, PAIR_INTENT_VOUCHED, PAIR_PC_PROOF, PAIR_SAS_FEATURE, RELAY_HINTS, RELAY_PROTOCOL, REQUEST_HEADERS, RESPONSE_HEADERS, SERVER_TIME_HEADER, WS_CONTINUATION_CAPACITY } from "../../shared/relay-mux.ts";
import type { HeaderList, PairApprover, SessionError } from "../../shared/relay-mux.ts";
import { PC_CODE_ACCOUNT_ONLY } from "../../shared/relay-mux.ts";
import type { BlockReceipt } from "../../shared/account-devices-api.ts";
import { PairingRateLimitedError, type DeviceMatch, type PairingPath } from "../devices.ts";
import { accountDeviceId } from "../../shared/account-records.ts";
import type { KeyProofPairings } from "../account/key-proof.ts";
import { bytesToHex } from "@noble/hashes/utils.js";
import { SIGN_IN_WAIT_MS, type ListingVerdict } from "../account/mailbox.ts";
import { LIST_ALLOW_MS, type AllowRefusal } from "../account/list-follow.ts";
import { PENDING_MS } from "../account/pending.ts";
import { pullForRefusedSignIn } from "./refused-signin.ts";
import { accountSignInRefusal } from "../account/account-signin.ts";
import { handleRequest } from "../dispatch.ts";
import type { RequestServices, ServerContext } from "../dispatch.ts";
import { jsonResponse } from "../http.ts";
import type { EventStreamBudget } from "../machine-api.ts";
import { VirtualSocket, type RelaySocketHandlers } from "./virtual-socket.ts";
import { logAccess } from "../connection-diagnostics.ts";

/** The PC a first join waits on, as the phone names it (PAIR_CHALLENGE `approve_on`); any other system is a PC. */
const APPROVER_OF: Partial<Record<NodeJS.Platform, PairApprover>> = { darwin: "mac", win32: "windows", linux: "linux" };

export const RELAY_ORIGIN = "https://relay.ovis.invalid";
/** How long a sign-in waits for the account service's word on this PC's listing: with a refused sign-in's pull before it, still inside the device's ADMISSION_MS. */
export const LISTING_WAIT_MS = 4_000;
/**
 * How long a join waits for the account service's word on its admission (accountJoin). Past it the service did not
 * answer in time, and the join hears that while the person still looks at it; the read goes on for the next try.
 */
export const JOIN_ADMISSION_WAIT_MS = 8_000;
const SOURCE_LIMIT = 3 * 1024 * 1024;
const SESSION_LIMIT = 32 * 1024 * 1024;
export const relayClock: MuxClock = {
  now: () => performance.now(),
  setTimeout: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};

/** Shared by HTTP and the WebSocket adapter; client identity headers never become Request headers. */
export function relayHeaders(list: HeaderList): Headers {
  const headers = new Headers();
  const allowed: readonly string[] = REQUEST_HEADERS;
  for (const [name, value] of list) if (allowed.includes(name)) headers.append(name, value);
  headers.set("origin", RELAY_ORIGIN);
  headers.set("sec-fetch-site", "same-origin");
  headers.set("accept-encoding", "identity");
  return headers;
}

/**
 * The calls a device may make while it waits to link (it paired with a code made for a PC in no account and
 * has not linked; docs/account.md): reading its own account status, sending its link, and, for an account that keeps
 * a signed list, naming that list in the link's place. This is the whole list.
 * Whatever is not one of the two is refused before any route runs, a path that exists nowhere included.
 */
function linkStep(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return (request.method === "GET" && pathname === "/api/account/status") || (request.method === "POST" && (pathname === "/api/account/link" || pathname === "/api/account/list/named"));
}

/**
 * How long a session waits for the answers already on their way once its device went before it linked
 * (RelaySession.leave); after that it ends without them.
 */
export const LEAVING_MS = 5_000;

/** What a device that waits to link is answered for everything else. */
function linkRequired(): Response {
  return jsonResponse({ error: { code: "link_required", message: "This device paired with a code that adds this PC to an Ovis account. It gets nothing here until it has linked itself into an account: sign in on it, then scan the code again." } }, 403, { "cache-control": "no-store" });
}

/**
 * What the session of a join that the list let in answers for every call: it told the device its place in the list
 * (AUTH_OK `list`) and serves nothing else, whichever store holds a row for its id. The key came with the comparison
 * and was never signed with here; the device signs in with it.
 */
function listSignInRequired(): Response {
  return jsonResponse({ error: { code: "sign_in_required", message: "This device was let into its account's list. It signs in with its list key now." } }, 403, { "cache-control": "no-store" });
}

/**
 * Why the list did not take a join that brought its card, as SESSION_ERROR `auth_failed` says it in its message
 * (docs/account.md, "A PC allows a device into the list"). `list_not_claimed`: no sign-in of the account claimed the
 * key, so the device signs in again. `list_service_away`, `list_head_lost`: the entry could not be placed in time, and
 * asking again may work. `list_not_in`: a member allowed the device and no entry for it reached this PC.
 * `list_needs_keys`: this PC came in as its account moved and has no key of its own in the list. `list_held_here`:
 * this PC itself keeps that key out, whatever the list holds. Anything else is `list_refused`.
 */
const LIST_ALLOW_CAUSES: Partial<Record<AllowRefusal, string>> = {
  not_claimed: "list_not_claimed", service_away: "list_service_away", head_lost: "list_head_lost", not_in_list: "list_not_in", behind: "list_pc_behind",
  // a PC that joined by an invite signs nobody into the list: the device is pointed to another device of the account
  not_signer: "list_not_signer",
  // a PC the account's move carried in with no key of its own: the same, and `ovis add` there gives it its keys
  needs_keys: "list_needs_keys",
  // this PC itself keeps the key out (a block here): the list may hold the device, and this PC lets it in once that ends
  held_here: "list_held_here",
};

export interface RelaySessionOptions {
  readonly channel: SecureChannel;
  readonly services: RequestServices;
  /** The server's listening port, resolved after binding (including port: 0). */
  readonly port: number;
  readonly serverId: string;
  readonly serverVersion: string;
  readonly minSupportedClient: string;
  readonly routingOverhead: number;
  readonly maxWireMessageBytes: number;
  readonly clock?: MuxClock;
  readonly dispatch?: typeof handleRequest;
  /** The core's SocketLike handlers. Without either adapter, WS_OPEN is refused. */
  readonly websocket?: RelaySocketHandlers;
  /** Owns the upgrade and socket lifecycle, including stream disposal. Absent adapters refuse WS_OPEN. */
  readonly onWs?: (stream: WsStream, exchange: RelayWebSocketRequest) => void;
  readonly onClose?: (code: SessionError) => void;
  readonly onAuthenticated?: (deviceId: string) => void;
  readonly onChosen?: () => void;
  readonly relayHints?: () => readonly string[];
  /**
   * This PC's direct carriers (server/relay/direct.ts), told in AUTH_OK to a phone that offered DIRECT_CARRIER;
   * with `tailnet` (it also offered DIRECT_TAILNET) its Tailscale one too.
   */
  readonly directCarriers?: (tailnet: boolean) => readonly string[];
  /**
   * A carrier that came straight to this PC rather than through the relay: devices sign in on it, and
   * nothing pairs (a code or a comparison), so pairing and its guesses stay on the relay.
   */
  readonly signInOnly?: boolean;
  /**
   * Asked once a pairing on this carrier would make a device new to this PC (a code that holds, or a comparison both
   * people confirmed), before the device is made: true when its relay refuses new client sessions to this PC now
   * (server/relay/link.ts). The session then makes no device and says nothing more: the relay closes the client.
   */
  readonly refuseNewDevice?: () => boolean;
}

export interface RelayWebSocketRequest {
  readonly request: Request;
  readonly context: ServerContext;
  upgrade?: Parameters<ServerContext["upgrade"]>[1];
}

/**
 * One protected carrier, one immutable principal, no replay. The carrier wires its plaintext
 * onmessage callback to receive(); construction requires the Noise handshake to have completed.
 */
export class RelaySession {
  readonly mux: MuxEngine;
  readonly sessionId = randomBytes(16).toString("hex");
  private state: "hello" | "auth" | "pair-commit" | "pair-wait" | "key-proof" | "key-wait" | "verifying" | "refused" | "ready" | "closed" = "hello";
  private readonly nonce = randomBytes(32);
  /** This session's channel binding, when the phone offered pairing by comparing digits and this PC selected it. */
  private sasBinding: Uint8Array | undefined;
  private intent: "pc" | "account" | "vouched" = "pc";
  private proofNegotiated = false;
  private proofChallenge?: { readonly id: string; readonly expected: string; readonly frame: string };
  private welcomed = false;
  private sas: {
    label: string; publicKey: string; commitment: Uint8Array; pcNonce: Uint8Array; expiresAt: number;
    phoneConfirmed: boolean; approved: boolean; approvedBy?: string; approvedOwn?: boolean; ended: boolean; membersOnly: boolean; localOnly: boolean; firstJoin: boolean; closes: number; withdraw?: () => void; confirmed?: () => void; cancelDeadline?: () => void; stopRevokeAll?: () => void; stopApprover?: () => void;
  } | undefined;
  private device: DeviceMatch | undefined;
  private closingReason: SessionError | undefined;
  /** The key this session's device signed in or paired with: a `link` must start from it (docs/account.md). */
  private key = "";
  /** Whether the device signed in with AUTH, the only admission that proves it holds its key. */
  private keyProven = false;
  /** the device offered KEY_PROOF_FEATURE: it can prove the key it pairs with (server/account/key-proof.ts) */
  private keyProof = false;
  private pcCodeAdd = false;
  /** this session's pairing that waits for the proof, then for this PC's screen */
  private keyProofSession: string | undefined;
  private authReceipts = false;
  private hinting = false;
  /** The app offered the account-opens-all mux feature on a PC with Step 2 on: it reads the account refusal codes. */
  private accountCodes = false;
  private directing = false;
  private tailnet = false;
  /** ACCOUNT_LIST_ALLOW was selected: a join's PAIR_REQUEST may carry the device's card, and it is then let in by the list or not at all */
  private listAllow = false;
  /** the client offered ACCOUNT_LIST_ALLOW: it knows a join into a signed list, whether or not this PC takes its card */
  private knowsListJoin = false;
  /** The list a card is taken for, as it stood at HELLO (ListFollow.takesCardsFor). */
  private listFor: string | null = null;
  /** the card of the device that asks to join, from its PAIR_REQUEST */
  private listCard: { readonly enc: string; readonly card: string } | undefined;
  /** where the list let the device of this session in, told in its AUTH_OK */
  private listPlace: { readonly id: string; readonly seq: number; readonly hash: string } | undefined;
  /** the client offered ACCOUNT_LIST_FEATURE and this PC was pinned to its list then; and whether the client required it */
  private listOffered = false;
  private listRequired = false;
  /** the phone offered ACCOUNT_LISTING_ERRORS: one that did not gets the older code that forgets no key over an outage */
  private listingErrors = false;
  /** this PC left its account and waits to be added again: a device that proves a key it knew is told so */
  /** the service binding whose listing answer let this session's device in: its AUTH_OK commits only while that answer stands */
  private listedFor: string | undefined;
  /** the phone offered SERVER_TIME_HEADER: one that did not refuses the header */
  private serverTime = false;
  private unwatch: (() => void) | undefined;
  private sourceBytes = 0;
  private readonly clock: MuxClock;
  private readonly activity = new Map<number, () => void>();
  private readonly sockets = new Map<WsStream, VirtualSocket | undefined>();
  private readonly requests = new Set<HttpStream>();
  /** The row went before it linked (leave): set while the answers on their way go out, to what calls off their deadline; then the session ends. */
  private leaving: (() => void) | undefined;
  private chosen = false;
  /** The channel under this session closed: the device's side went away (a reload, the app put away, the network gone). */
  private carrierGone = false;

  constructor(private readonly options: RelaySessionOptions) {
    if (!options.channel.isOpen() || options.channel.securityMode() !== "protected") {
      throw new Error("Relay sessions require an open protected channel");
    }
    this.clock = options.clock ?? relayClock;
    this.mux = new MuxEngine({
      role: "server", clock: this.clock,
      send: (bytes) => {
        if (this.state === "ready") options.services.checkAccountFreshness();
        // Revocation can start here, after the mux selected a frame. Only teardown may still go on the wire.
        if (options.services.devices.opensAll() && this.state === "closed" && bytes[1] !== FrameType.SESSION_ERROR && bytes[1] !== FrameType.WS_CLOSE
          && bytes[1] !== FrameType.RESET && bytes[1] !== FrameType.RECEIVED && bytes[1] !== FrameType.CREDIT) {
          throw new MuxProtocolError("auth_changed", "Session closed before frame delivery");
        }
        this.touch(bytes);
        return options.channel.send(bytes.slice().buffer);
      },
      outboundWireByteLength: (bytes) => options.channel.outboundWireByteLength(bytes.slice().buffer),
      routingOverhead: options.routingOverhead, maxWireMessageBytes: options.maxWireMessageBytes,
      requestTimeoutMs: () => 0,
      filterRequestHeaders: true,
      close: (code) => options.channel.close(code),
      onClose: (error) => {
        // a session nobody ended, whose channel went away, is no error of this PC's: logged as `carrier_lost`, never as the
        // `internal_error` the mux stands in with for it (MuxEngine.carrierLost)
        logAccess({ event: "relay.session.closed", reason: this.closingReason ?? this.mux.failureCode ?? (this.carrierGone ? "carrier_lost" : error.code) });
        this.state = "closed";
        this.leaveKeyProof();
        this.endPairing(false);
        this.unwatch?.();
        this.unwatch = undefined;
        options.onClose?.(error.code);
      },
      onSession: (frame) => {
        void this.admit(frame).catch((error: unknown) => {
          if (error instanceof PairingRateLimitedError) { this.mux.fail("auth_failed", error.message); return; }
          // the device hears only internal_error: what it was is said here, on this PC
          console.error(`[relay] a session ended on an error of this PC's: ${error instanceof Error ? error.message : String(error)}`);
          this.close("internal_error");
        });
      },
      onHttp: (stream) => { this.choose(); void this.http(stream); },
      onWs: (stream) => {
        const device = this.principal();
        if (!device) { stream.reset("refused"); return; }
        // a device that waits to link opens no socket: refused here, where every stream of a device starts, on the relay and on a direct carrier alike
        if (device.provisional || this.listPlace !== undefined) {
          void this.refuseSocket(stream, device.provisional ? linkRequired() : listSignInRequired()).catch((error: unknown) => { if (stream.live) stream.reset(error instanceof MuxStreamError ? error.code : "internal_error"); });
          return;
        }
        this.choose();
        if (!options.onWs && !options.websocket) { stream.reset("refused"); return; }
        this.sockets.set(stream, undefined);
        const abort = new AbortController();
        let timer: (() => void) | undefined;
        const exchange: RelayWebSocketRequest = {
          request: new Request(RELAY_ORIGIN + stream.request.target, {
            headers: relayHeaders(stream.request.headers), signal: abort.signal,
          }),
          context: this.context(device, (_request, seconds) => {
            timer?.();
            timer = seconds > 0 ? this.clock.setTimeout(() => stream.reset("upstream_lost"), seconds * 1000) : undefined;
          }, (_request, upgrade) => {
            if (!stream.live || this.state !== "ready") return false;
            exchange.upgrade = upgrade;
            return true;
          }),
        };
        stream.onDispose = () => {
          timer?.();
          abort.abort();
          exchange.upgrade?.data.relay?.close();
          this.sockets.delete(stream);
        };
        if (options.onWs) options.onWs(stream, exchange);
        else void this.websocket(stream, exchange);
      },
    });
    // only while the session stands: an end the device or this PC made closes the carrier too, and keeps its own reason
    options.channel.onClose(() => { if (this.mux.active) this.carrierGone = true; this.mux.carrierLost(); });
    // A WELCOME with no feature rides right behind the protected handshake's answer, so a phone signing in
    // gets its nonce one round trip sooner. It is provisional: HELLO is still required, and checked, before
    // AUTH or PAIR, and a HELLO that offers pairing by comparing digits gets the final WELCOME. Only while no
    // comparison can be under way: a phone from before `provisional` reads the first WELCOME as the answer.
    if (!options.services.relay.approvals.windowOpen()) this.welcome([], true);
  }

  private welcome(features: readonly string[], provisional: boolean, list?: string | null): void {
    this.welcomed = true;
    this.mux.sendSession({
      type: FrameType.WELCOME, flags: 0, stream_id: 0,
      payload: {
        protocol: "ovis-mux", version: 1, features, limits: LIMITS_V1,
        nonce: this.nonce.toString("base64url"), server_version: this.options.serverVersion,
        relay_protocol: RELAY_PROTOCOL, min_supported_client: this.options.minSupportedClient,
        ...(provisional ? { provisional: true as const } : {}),
        // a PC pinned to its account's list says which, to a client that knows of lists: it signs in by the key that list holds for it
        ...(list == null ? {} : { list }),
      },
    });
  }

  get verifying(): boolean { return this.state === "verifying"; }

  /** A join both sides confirmed waits for its entry in the account's list (allowIntoList): up to LIST_ALLOW_MS, which the carrier's own deadline must leave it. */
  get placing(): boolean { return this.placingList && this.state !== "closed"; }
  private placingList = false;

  /** a pairing under way, a key proof and its wait for the PC's screen too: the relay link keeps it past its setup deadline */
  get pairing(): boolean { return this.state === "pair-commit" || this.state === "pair-wait" || this.state === "key-proof" || this.state === "key-wait"; }

  get bufferedBytes(): number { return this.sourceBytes + this.mux.stats.bufferedBytes; }

  receive(data: string | ArrayBuffer): void {
    if (typeof data === "string") { this.close("protocol_error"); return; }
    if (this.state === "ready") this.options.services.checkAccountFreshness();
    const bytes = new Uint8Array(data);
    this.mux.receive(bytes);
    for (const socket of this.sockets.values()) socket?.drain();
    if (this.mux.active) this.touch(bytes);
  }

  private touch(bytes: Uint8Array): void {
    if (bytes.byteLength >= 8) this.activity.get(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4))?.();
  }

  close(code: SessionError = "auth_revoked", receipts?: readonly BlockReceipt[], reason: SessionError = code): void {
    if (this.state === "closed") return;
    this.closingReason = reason;
    this.state = "closed";
    this.leaveKeyProof();
    this.endPairing(false);
    this.unwatch?.();
    this.unwatch = undefined;
    this.leaving?.();
    if (code !== "auth_revoked" && code !== "auth_changed") { this.mux.fail(code, code, receipts); return; }
    // Stop application work now, but let the known WS policy close reach the peer before
    // SESSION_ERROR tears down the carrier. WsStream bounds both draining and the close exchange.
    for (const stream of this.requests) stream.reset("cancelled");
    const closing: Promise<void>[] = [];
    for (const [stream, socket] of this.sockets) {
      if (!socket) { stream.reset("cancelled"); continue; }
      closing.push(socket.closed);
      socket.close(1008, "Device access revoked");
    }
    if (closing.length) void Promise.all(closing).then(() => this.mux.flush()).then(() => this.mux.fail(code, code));
    else this.mux.fail(code, code);
  }

  /** A key proof ends with its session, however the session ends: the code's held use and the waiting entry go. */
  private leaveKeyProof(): void {
    const session = this.keyProofSession;
    this.keyProofSession = undefined;
    if (session !== undefined) this.options.services.keyProofPairings?.leave(session);
  }

  /**
   * PAIR on a PC with screen proof: the code is checked and one use held for the named key, the PC then sends its
   * challenge, and the session waits (KEY_PROVE, then the screen) until the key is admitted or the pairing ends.
   */
  private pairByProof(pairings: KeyProofPairings, pair: { code: string; label: string; public_key: string }): void {
    // what a code pairing is held to before it makes a device holds before the proof too: a pairing paused for wrong
    // codes (throws, answered auth_failed), and a relay pass that lets in no new session (nothing is answered)
    this.options.services.devices.assertRelayPairing("code");
    if (!this.admitNewDevice()) return;
    const started = pairings.pair({ code: pair.code, label: pair.label, publicKey: pair.public_key, how: "code", via: "relay", keyProof: this.keyProof && !this.options.signInOnly, serverId: this.options.serverId, canAdmit: this.admitNewDevice });
    if ("refuse" in started) { this.close(started.refuse); return; }
    this.keyProofSession = started.session;
    this.state = "key-proof";
    this.mux.extendSetup(PENDING_MS + 10_000);
    this.mux.sendSession({ type: FrameType.KEY_CHALLENGE, flags: 0, stream_id: 0, payload: { challenge: started.challenge } });
    void pairings.decision(started.session).then(({ admitted }) => {
      if (this.keyProofSession !== started.session) return;
      this.keyProofSession = undefined;
      // As with direct and SAS pairing, the pass keeper closes refused carriers without a session error.
      if (admitted === null) { if (!this.refused) this.close("auth_failed"); return; }
      this.keyProven = true;
      this.enter(admitted);
    });
  }

  /** The pairing would have made a device while new client sessions are refused: nothing is answered from here on. */
  private get refused(): boolean { return this.state === "refused"; }

  /** The device store's last question before a pairing makes a device (server/devices.ts pairRelay): false makes none. */
  private readonly admitNewDevice = (): boolean => {
    if (!this.options.refuseNewDevice?.()) return true;
    this.state = "refused";
    return false;
  };

  private async admit(frame: SessionFrame): Promise<void> {
    if (this.refused) return;
    switch (frame.type) {
      case FrameType.HELLO:
        if (this.state !== "hello") { this.close("protocol_error"); return; }
        if (!frame.payload.versions.includes(1)) { this.close("unsupported_version"); return; }
        // selected only where it can finish: a protected channel to bind the digits to
        if (frame.payload.features.includes(PAIR_SAS_FEATURE) && !this.options.signInOnly) this.sasBinding = channelBinding(this.options.channel);
        this.hinting = this.options.relayHints !== undefined && frame.payload.features.includes(RELAY_HINTS);
        this.directing = this.options.directCarriers !== undefined && frame.payload.features.includes(DIRECT_CARRIER);
        this.tailnet = this.directing && frame.payload.features.includes(DIRECT_TAILNET);
        const large = frame.payload.features.includes(LARGE_WS_MESSAGES);
        if (large) this.mux.sendLargeMessages();
        this.serverTime = frame.payload.features.includes(SERVER_TIME_HEADER);
        this.keyProof = frame.payload.features.includes(KEY_PROOF_FEATURE);
        this.pcCodeAdd = frame.payload.features.includes(PC_CODE_ACCOUNT_ONLY);
        this.listingErrors = frame.payload.features.includes(ACCOUNT_LISTING_ERRORS);
        // an intent is selected only with pair-sas, and only the one offered (docs/account.md, "Negotiation")
        const intents = frame.payload.features.filter((f) => f === PAIR_INTENT_PC || f === PAIR_INTENT_ACCOUNT || f === PAIR_INTENT_VOUCHED);
        if (intents.length > 1) { this.close("protocol_error"); return; }
        // the vouched intent is selected only with pair-pc-proof offered: an older PC that offers it alone reads the
        // missing intent as this PC being outdated (its "update Ovis on that PC"), and its PAIR_REQUEST is still refused
        const offered = intents[0] === PAIR_INTENT_VOUCHED && !frame.payload.features.includes(PAIR_PC_PROOF) ? [] : intents;
        const selected = [...this.sasBinding ? [PAIR_SAS_FEATURE, ...offered] : [], ...frame.payload.features.includes(ACCOUNT_FEATURE) ? [ACCOUNT_FEATURE] : [],
          ...this.keyProof && this.options.services.keyProofPairings !== undefined && !this.options.signInOnly ? [KEY_PROOF_FEATURE] : []];
        this.proofNegotiated = !!this.sasBinding && intents[0] === PAIR_INTENT_VOUCHED && this.options.services.devices.opensAll() && frame.payload.features.includes(PAIR_PC_PROOF);
        if (this.proofNegotiated) selected.push(PAIR_PC_PROOF);
        if (this.pcCodeAdd && this.options.services.devices.accountPolicyActive()) selected.push(PC_CODE_ACCOUNT_ONLY);
        this.authReceipts = this.options.services.devices.accountPolicyActive() && frame.payload.features.includes(ACCOUNT_OPENS_ALL_FEATURE);
        // out of the account that stopped listing it: the account sign-in is taken, so the key it names can be proved and told why
        if (this.authReceipts || (this.listingErrors && frame.payload.features.includes(ACCOUNT_OPENS_ALL_FEATURE) && this.options.services.devices.readdRequired())) selected.push(ACCOUNT_OPENS_ALL_FEATURE);
        this.accountCodes = this.authReceipts;
        // a PC pinned to its account's signed list says so to a client that knows of lists: one that signs in with the
        // key the list holds for it requires this, and a PC that follows no list refuses it below
        this.listOffered = frame.payload.features.includes(ACCOUNT_LIST_FEATURE) && this.options.services.accountList?.pinned() === true;
        this.listRequired = frame.payload.required_features.includes(ACCOUNT_LIST_FEATURE);
        if (this.listOffered) selected.push(ACCOUNT_LIST_FEATURE);
        // and only a PC that can sign for its list right now takes a new device's card with a join (docs/account.md, "A
        // PC allows a device into the list"): any other PC lets nobody into the list, and says so by not selecting this
        this.knowsListJoin = frame.payload.features.includes(ACCOUNT_LIST_ALLOW);
        this.listAllow = !!this.sasBinding && intents[0] === PAIR_INTENT_ACCOUNT && frame.payload.features.includes(ACCOUNT_LIST_ALLOW)
          && !this.options.signInOnly && (this.listFor = this.options.services.accountList?.takesCardsFor() ?? null) !== null;
        if (this.listAllow) selected.push(ACCOUNT_LIST_ALLOW);
        if (frame.payload.required_features.some((feature) => !selected.includes(feature) && !(feature === RELAY_HINTS && this.hinting) && !(feature === DIRECT_CARRIER && this.directing) && !(feature === DIRECT_TAILNET && this.tailnet) && !(feature === LARGE_WS_MESSAGES && large))) { this.close("unsupported_extension"); return; }
        this.state = "auth";
        if (this.sasBinding && intents[0] === PAIR_INTENT_ACCOUNT) this.intent = "account";
        if (this.sasBinding && intents[0] === PAIR_INTENT_VOUCHED) this.intent = "vouched";
        if (!this.welcomed || selected.length > 0) this.welcome(selected, false, this.listOffered ? this.options.services.accountList?.pinnedList() : null);
        return;
      case FrameType.AUTH: case FrameType.PAIR: {
        if (this.state !== "auth") { this.close("protocol_error"); return; }
        // refused before the code is looked at: nothing is spent or counted
        if (frame.type === FrameType.PAIR && this.options.signInOnly) { this.close("auth_failed"); return; }
        this.state = "verifying";
        const devices = this.options.services.devices;
        if (this.options.services.serveOnly) { this.close("auth_failed"); return; }
        // the few seconds a sign-in may wait for the account service are counted once, from here
        const signInBegan = Date.now();
        if (frame.type === FrameType.AUTH && !await this.pullForRefusedSignIn(frame.payload.device_id, frame.payload.signature)) return;
        if (frame.type === FrameType.AUTH && this.options.services.accountList?.pinned()) {
          // a PC pinned to its signed list judges a sign-in on a copy that is fresh, or as fresh as a few seconds get it: a
          // removal that waits at the account service is read before any session opens, whichever row the device has here
          this.mux.extendSetup(SIGN_IN_WAIT_MS + 10_000);
          await this.options.services.accountList.beforeSession(Math.max(0, SIGN_IN_WAIT_MS - (Date.now() - signInBegan)));
          if (!this.mux.active) return;
        }
        // a PC with screen proof admits a code's redeemer only once its screen approves the key it proved
        const keyProofPairings = this.options.services.keyProofPairings;
        if (frame.type === FrameType.PAIR && this.pcCodeAdd && this.options.services.devices.accountPolicyActive()) { this.close("unsupported_version"); return; }
        if (frame.type === FrameType.PAIR && keyProofPairings !== undefined) { this.pairByProof(keyProofPairings, frame.payload); return; }
        this.keyProven = frame.type === FrameType.AUTH;
        const device = frame.type === FrameType.AUTH
          ? await devices.matchRelay(frame.payload.device_id, this.nonce, frame.payload.signature, this.options.serverId)
          : devices.pairRelay(frame.payload.code, frame.payload.label, frame.payload.public_key, undefined, this.admitNewDevice)?.device;
        // no auth_failed: the code held and was not spent, and the relay closes this client for the pass
        if (this.refused) return;
        if (frame.type === FrameType.AUTH && device && devices.catchingUp(device.id)) {
          // Step 2 (S2-27): a row not paired at this PC waits for the first whole read after a start (T41)
          if (!await this.readComing(device.id) || !this.mux.active) return;
          this.refuseWaiting();
          return;
        }
        if (frame.type === FrameType.AUTH && device === null && devices.opensAll()) {
          // Step 2 (S2-25): an account-joined row signs in with its registered key; its refusal is told only after the proof
          const joined = await devices.matchAccountRelay(frame.payload.device_id, this.nonce, frame.payload.signature, this.options.serverId);
          // on a PC that is not pinned the list is asked the same question beside it, and only says where it differs
          if (joined === null || !("refused" in joined)) this.options.services.accountList?.shadowSignIn({ deviceId: frame.payload.device_id, nonce: this.nonce,
            signature: frame.payload.signature, serverId: this.options.serverId, snapshot: joined === null ? "none" : "admitted" });
          if (joined !== null && "refused" in joined) {
            if (joined.refused.refused === "catching_up" && !await this.readComing(frame.payload.device_id)) return;
            if (!this.mux.active) return;
            const refusal = accountSignInRefusal(joined.refused, joined.holdUntil, this.accountCodes);
            this.mux.fail(refusal.code, refusal.message, undefined, refusal.hold);
            return;
          }
          if (joined !== null) { await this.enterProved(joined.match); return; }
          // a key the list lets in, which this PC holds only by a pairing of its own: asked for under the key's account
          // id, it is let in as the list says, over that pairing's row
          const byList = await devices.matchListKey(frame.payload.device_id, this.nonce, frame.payload.signature, this.options.serverId);
          if (!this.mux.active) return;
          if (byList !== null) {
            this.listKey = byList.key;
            this.signedInAs = frame.payload.device_id;
            await this.enterProved(byList.match);
            return;
          }
        }
        // read now, not at HELLO: the sign-in itself may have been what made this PC ask and leave
        if (!device && this.listingErrors && frame.type === FrameType.AUTH && devices.readdRequired()
          && await devices.provedFormerAccountKey(frame.payload.device_id, { nonce: this.nonce, signature: frame.payload.signature, serverId: this.options.serverId })) {
          if (this.mux.active) this.refuseListing("readd");
          return;
        }
        // a sign-in this PC knows no row for, from a client that knows of lists and did not come by its list key: the PC
        // is pinned, so the way in is that key. The client reads its list and tries again; any other client hears what it
        // always did. It says nothing of the device: only that this PC follows a list, which its WELCOME says too
        if (!device && frame.type === FrameType.AUTH && this.listOffered && !this.listRequired && this.options.services.accountList?.pinned() === true) {
          this.mux.fail("account_list_required", "This PC lets devices of its account in by the account's signed list. Sign in with the key the list holds for this device.");
          return;
        }
        if (!device && this.authReceipts && frame.type === FrameType.AUTH) {
          const receipts = await devices.refusedRelayReceipts(frame.payload.device_id, { nonce: this.nonce, signature: frame.payload.signature, serverId: this.options.serverId });
          if (!this.mux.active) return;
          // A sign-in this PC refuses with no receipt, on a PC that follows no list and does not fail closed, while no read
          // of the account that began after its id first asked here has finished (the read its sign-in started was slow,
          // failed, or could not start yet): it may be a device the account let in that this PC has not read. A client that
          // knows the account codes is told to wait, and asks again; it gets in only by the row a read brings. An id with a
          // row and a proof that does not hold is answered the same, so the answer tells nobody which ids have a row here
          if (receipts.length === 0 && !devices.failsClosed && devices.accountError === null && !devices.listFollowed()
            && this.options.services.accountMailbox.unreadKey(frame.payload.device_id)) {
            const refusal = accountSignInRefusal({ refused: "catching_up" }, null, true);
            this.mux.fail(refusal.code, refusal.message, undefined, refusal.hold);
            return;
          }
          this.close("auth_failed", receipts.slice(-AUTH_RECEIPTS_MAX));
          return;
        }
        if (device && frame.type === FrameType.AUTH) await this.enterProved(device);
        else this.enter(device);
        return;
      }
      case FrameType.KEY_PROVE: {
        const keyProofPairings = this.options.services.keyProofPairings;
        if (this.state !== "key-proof" || this.keyProofSession === undefined || keyProofPairings === undefined) { this.close("protocol_error"); return; }
        this.state = "key-wait";
        const proved = await keyProofPairings.prove(this.keyProofSession, frame.payload.signature);
        if (!this.mux.active) return;
        if ("refuse" in proved) { this.close(proved.refuse); return; }
        // its code ended between the proof and here (endPairing): the device is told no, and nothing is put on the screen
        if (!keyProofPairings.isWaiting(proved.pending.id)) { this.close("auth_failed"); return; }
        this.mux.sendSession({ type: FrameType.KEY_PENDING, flags: 0, stream_id: 0, payload: {} });
        this.options.services.askScreenForKey?.(proved.pending);
        return;
      }
      case FrameType.PAIR_REQUEST: {
        // a direct carrier pairs nothing, whatever was offered: refused as a sign-in failure, before the binding is looked at
        if (this.options.signInOnly) { this.close("auth_failed"); return; }
        if (this.state !== "auth" || !this.sasBinding) { this.close("protocol_error"); return; }
        if (this.options.services.serveOnly) { this.close("auth_failed"); return; }
        // nobody asked for a link lately: refused before any prompt, and not counted, since no person was asked,
        // unless it is an account join the account service has seen (accountJoin, docs/account.md design 5.3).
        // Another PC of the account's server is taken only that way, window or not: its admission is its whole invitation
        if (this.intent === "vouched") {
          const key = proofKey(frame.payload.server_key);
          if (!this.proofNegotiated || !key) { this.close("auth_failed"); return; }
          // on a PC pinned to its signed list, another PC is of the account only when the list holds its relay key
          this.vouchedEndpoint = bytesToHex(key);
          if (!this.vouchedInList()) { this.close("auth_failed"); return; }
          const id = deriveServerId(key);
          this.proofChallenge = { id, ...serverChallenge(key, { server_id: id, role: "vouched-pc", connection_id: toBase64Url(this.sasBinding) }) };
        }
        let membersOnly = false;
        let firstJoin = false;
        // taken under the PC's own add-me screen: this comparison stays the PC's to decide, whenever its digits show
        const localOnly = this.options.services.relay.approvals.localOnlyOpen();
        if (this.intent === "vouched" || !this.options.services.relay.approvals.windowOpen()) {
          this.state = "verifying";
          const joined = await this.accountJoin(frame.payload.public_key);
          // the account service did not answer: refused as before, saying why to a client that reads it (as an outage at a sign-in)
          if (joined === "unanswered") { if (this.mux.active) this.close(this.listingErrors ? "account_unreachable" : "auth_failed", undefined, "account_unreachable"); return; }
          if (joined === null) { this.close("auth_failed"); return; }
          if (!this.mux.active) return;
          // the one vouched join at a time is taken only once its admission held: a request the account never saw holds no
          // slot, so nobody can make a real PC's join fail by asking first
          if (this.intent === "vouched" && !this.options.services.relay.approvals.reserveVouched(this.sessionId)) { this.close("auth_failed"); return; }
          membersOnly = true;
          firstJoin = joined === "first";
        }
        this.options.services.devices.assertRelayPairing(this.path);
        this.state = "pair-commit";
        // a card counts only where the PC said it takes one; anywhere else the join is today's, and the members are
        // ignored, whatever form they have
        if (this.listAllow && this.intent === "account") {
          if (frame.payload.list_malformed === true) { this.close("protocol_error"); return; }
          if (frame.payload.list_enc !== undefined && frame.payload.list_card !== undefined) this.listCard = { enc: frame.payload.list_enc, card: frame.payload.list_card };
        }
        this.sas = {
          label: frame.payload.label, publicKey: frame.payload.public_key, commitment: fromBase64Url(frame.payload.commitment),
          pcNonce: randomPairNonce(), expiresAt: Date.now() + PAIR_APPROVAL_MS, phoneConfirmed: false, approved: false, ended: false, membersOnly, localOnly, firstJoin, closes: this.options.services.relay.approvals.closes,
        };
        this.sas.cancelDeadline = this.clock.setTimeout(() => { if (this.pairing) this.close("timeout"); }, PAIR_APPROVAL_MS);
        // revoking every device also ends a comparison under way, even one the owner already approved
        this.sas.stopRevokeAll = this.options.services.devices.onRevokeAll(() => { if (this.pairing) this.close("auth_failed"); });
        this.mux.extendSetup(PAIR_APPROVAL_MS + 1_000);
        // a first join waits on this PC's own screen: the phone is told which PC to press Allow on
        this.mux.sendSession({ type: FrameType.PAIR_CHALLENGE, flags: 0, stream_id: 0,
          payload: { nonce: toBase64Url(this.sas.pcNonce), ...(this.proofChallenge ? { server_challenge: this.proofChallenge.frame } : {}), ...(firstJoin ? { approve_on: APPROVER_OF[this.options.services.options.platform ?? process.platform] ?? "pc" } : {}),
            // the list this PC follows, where it takes the device's card for it
            ...(this.listAllow && this.intent === "account" && this.listFor !== null ? { list: this.listFor } : {}) } });
        return;
      }
      case FrameType.PAIR_REVEAL: {
        const sas = this.sas;
        if (this.state !== "pair-commit" || !sas || !this.sasBinding) { this.close("protocol_error"); return; }
        const proof = this.proofChallenge;
        delete this.proofChallenge;
        if (this.intent === "vouched" && (!proof || !verifyServerProof(frame.payload.server_proof, proof.expected))) { this.close("auth_failed"); return; }
        const phoneNonce = fromBase64Url(frame.payload.nonce);
        if (!commitmentHolds(sas.commitment, this.sasBinding, sas.publicKey, phoneNonce)) { this.close("auth_failed"); return; }
        // the window it was taken under was closed while this phone held its reveal: no prompt after a close
        // (a join shown to account members only never depended on the window)
        if (!sas.membersOnly && this.options.services.relay.approvals.closes !== sas.closes) { this.close("auth_failed"); return; }
        // a pause that began while this phone held its reveal still keeps its prompt off the owner's screen
        this.options.services.devices.assertRelayPairing(this.path);
        if (proof && (!this.vouchedEligible(sas.publicKey) || !this.options.services.relay.approvals.takeAccountJoin())) { this.close("auth_failed"); return; }
        const asked = this.options.services.relay.approvals.ask(proof?.id ?? sas.label,
          pairDigits(this.sasBinding, sas.publicKey, phoneNonce, sas.pcNonce), sas.expiresAt,
          // a PC vouched for is asked as "pair this PC": it joins this PC alone, and the approver's app signs nothing for it;
          // marked vouched, so that app shows who is asking and checks the admission, as for an account join
          { intent: this.intent === "account" ? "account" : "pc", key: sas.publicKey, deviceId: accountDeviceId(this.options.serverId, sas.publicKey), membersOnly: sas.membersOnly, localOnly: sas.localOnly, vouched: this.intent === "vouched", ...(proof ? { provenServerId: proof.id } : {}), firstJoin: sas.firstJoin, list: this.listCard !== undefined,
            // a join into the account, on a PC pinned to its list, from an app that knows no join into a list (an Ovis
            // older than 0.5.10): this PC lets it in by nothing, so its window and terminal say so rather than let it in
            listUnknown: this.intent === "account" && !this.knowsListJoin && this.options.services.accountList?.pinned() === true });
        if (!asked) { this.close("auth_failed"); return; }
        this.state = "pair-wait";
        sas.withdraw = asked.withdraw;
        sas.confirmed = asked.confirm;
        void asked.decision.then((decision) => {
          if (this.sas !== sas || this.state !== "pair-wait") return;
          if (!decision.approved) { this.close("auth_failed"); return; }
          sas.approved = true;
          if (decision.pcLabel) sas.label = decision.pcLabel;
          sas.approvedBy = decision.by?.id;
          sas.approvedOwn = decision.own === true;
          // an approver revoked or given another role before the phone confirms takes the approval with it, for good
          if (decision.by) sas.stopApprover = this.options.services.devices.onRevoke(decision.by.id, () => { if (this.pairing) this.close("auth_failed"); });
          this.finishPairing();
        }).catch(() => this.close("internal_error"));
        return;
      }
      case FrameType.PAIR_CONFIRM: {
        if (this.state !== "pair-wait" || !this.sas || this.sas.phoneConfirmed) { this.close("protocol_error"); return; }
        this.sas.phoneConfirmed = true;
        // whoever may approve the join is told: for a join into the list, its approver signs the entry only now
        this.sas.confirmed?.();
        this.finishPairing();
        return;
      }
      case FrameType.WELCOME: case FrameType.AUTH_OK: case FrameType.PAIR_CHALLENGE: case FrameType.KEY_CHALLENGE: case FrameType.KEY_PENDING:
        this.close("protocol_error");
    }
  }

  /** `provisional`: a row that waits to link is told no direct carrier of this PC. */
  private hints(provisional: boolean): { relays?: readonly string[]; direct?: readonly string[] } {
    const relays = this.hinting ? this.options.relayHints?.() ?? [] : [];
    const direct = this.directing && !provisional ? this.options.directCarriers?.(this.tailnet) ?? [] : [];
    return { ...relays.length ? { relays } : {}, ...direct.length ? { direct } : {} };
  }

  /** Both people said the digits match: the phone on its screen, the owner on this PC. */
  private finishPairing(): void {
    const sas = this.sas;
    if (!sas || !sas.phoneConfirmed || !sas.approved || this.state !== "pair-wait") return;
    // a member's approval from afar lets a device in on the account's word: asked about first, as a sign-in's is, and
    // nothing is written until the account service confirms this PC's listing
    // a join that came with the device's card is let in by the list: the account service's listing of this PC decides nothing of it
    const binding = sas.approvedBy === undefined || this.listCard !== undefined ? null : this.options.services.devices.serviceBinding();
    if (binding !== null && !this.options.services.accountMailbox.listingFresh(binding)) {
      this.state = "verifying";
      void this.listingVerdict(binding).then((verdict) => {
        if (!this.mux.active || this.sas !== sas || sas.ended) return;
        // no word of the account service is no failed pairing of this device's: it counts against nobody
        if (verdict !== "confirmed" || this.options.services.devices.serviceBinding() !== binding) { this.endPairing(true); this.refuseListing(verdict); return; }
        this.state = "pair-wait";
        this.admitCompared(sas);
      });
      return;
    }
    this.admitCompared(sas);
  }

  /** The key of a session let in by the list over a pairing of this PC's own (DeviceStore.matchListKey): the list's role for it is the session's. */
  private listKey: string | null = null;
  /** The row of another PC of the account this session is for, on a pinned PC: the list is asked about the relay key that row records. */
  private listPcRow: string | null = null;
  /** The id such a session signed in under, which its AUTH_OK names: the account id of its key, not the pairing row's. */
  private signedInAs: string | null = null;

  /**
   * The row of the session's device as it stands now (DeviceStore.sessionRow). For a session the list let in, the role
   * is the list's for its key, read now; null once the list lets that key in no more, or the row holds another key.
   */
  private rowNow(id: string): ReturnType<RequestServices["devices"]["sessionRow"]> {
    const devices = this.options.services.devices;
    const row = devices.sessionRow(id);
    if (row !== null && this.listPcRow !== null) {
      const role = devices.vouchedPcRole(this.listPcRow);
      return role == null ? null : { ...row, role };
    }
    if (row === null || this.listKey === null) return row;
    const role = devices.listRoleOf(this.listKey);
    return role === null || row.key !== this.listKey ? null : { ...row, role };
  }

  /** Ends a join the list did not take: SESSION_ERROR `auth_failed`, with the cause as its message. */
  private failJoin(cause: string): void {
    if (this.state === "closed") return;
    this.closingReason = "auth_failed";
    this.state = "closed";
    this.leaveKeyProof();
    this.endPairing(false);
    this.unwatch?.();
    this.unwatch = undefined;
    this.leaving?.();
    this.mux.fail("auth_failed", cause);
  }

  /** The relay key a PC that is vouched for proved, kept for as long as its comparison lasts. */
  private vouchedEndpoint: string | null = null;

  /** On a PC pinned to its signed list, another PC is of the account only while the list holds the relay key it proved. Any PC, where no list is followed. */
  private vouchedInList(): boolean {
    const { devices, accountList } = this.options.services;
    return !devices.listFollowed() || (this.vouchedEndpoint !== null && accountList?.holdsPc(this.vouchedEndpoint) === true);
  }

  private admitCompared(sas: NonNullable<RelaySession["sas"]>): void {
    // an answer that lands after the deadline, before its timer ran, makes no device either
    if (Date.now() > sas.expiresAt) { this.close("timeout"); return; }
    // approved on this PC, then the window it was taken under was closed before the phone confirmed: no device after a close
    if (!sas.membersOnly && this.options.services.relay.approvals.closes !== sas.closes) { this.close("auth_failed"); return; }
    this.state = "verifying";
    // a member's remote approval never lets in a key this PC holds back (removed elsewhere, or a remove for it waits here);
    // only a pairing approved on this PC itself does
    const id = accountDeviceId(this.options.serverId, sas.publicKey);
    const { devices, accountMailbox } = this.options.services;
    // the relay key it proved is asked about again in the turn that writes its row: the list may have removed that PC
    // while the comparison waited for a member
    if (this.intent === "vouched" && (!sas.approvedBy || !this.vouchedEligible(sas.publicKey) || !this.vouchedInList())) { this.close("auth_failed"); return; }
    // a join that came with the device's card for the list is let in by the list, or not at all
    if (this.listCard !== undefined) { void this.allowIntoList(sas, id, this.listCard).catch(() => this.close("internal_error")); return; }
    if (sas.approvedBy !== undefined) {
      const gates = accountMailbox.gates();
      const approverKey = devices.relayKeyOf(sas.approvedBy);
      // the recheck of the approver's standing is account work (flag on); flag off keeps main's held check only
      if (gates.held(sas.publicKey) || (devices.opensAll() && devices.has(id) && (gates.enrolling() || !approverKey || gates.removing?.(approverKey)))) {
        this.close("auth_failed"); return;
      }
    }
    let device: DeviceMatch | undefined;
    try { device = devices.pairRelayApproved(sas.label, sas.publicKey, { path: this.path, id, ...(sas.approvedBy === undefined ? {} : { addedBy: sas.approvedBy }), ...(this.intent === "vouched" && this.vouchedEndpoint !== null ? { vouchedPc: this.vouchedEndpoint } : {}) }, undefined, this.admitNewDevice)?.device; }
    catch (error) {
      if (error instanceof PairingRateLimitedError) { this.close("auth_failed"); return; }
      throw error;
    }
    // pairRelayApproved counted a refused key itself; one admitNewDevice turned away is not counted
    this.endPairing(true);
    if (this.refused) return;
    this.enter(device);
  }

  /**
   * The join of a device that sent its card: both people said the digits match. Approved on this PC itself (its own
   * window, `ovis approve`), the PC signs the entry that lets the device into the list; approved by a member from afar,
   * the PC only reads the list and lets the device in when an entry of it does. Its session is then the session of a
   * device of the list, and its AUTH_OK names the list and the place of that entry. Anything else ends the join as one
   * that was not let in: no pairing is written in its place.
   */
  private async allowIntoList(sas: NonNullable<RelaySession["sas"]>, id: string, card: { readonly enc: string; readonly card: string }): Promise<void> {
    const list = this.options.services.accountList;
    // while the relay refuses new sessions no join makes a device: nothing is signed, and nothing is answered from here on
    if (!this.admitNewDevice()) { this.endPairing(true); return; }
    this.mux.extendSetup(LIST_ALLOW_MS);
    this.placingList = true;
    // the PC signs only where a person at this PC decided: its own window, or the digits typed at its local command.
    // A member's approval, and one from another browser that drives this PC, sign nothing here
    const outcome = list ? await list.allowDevice({ key: sas.publicKey, enc: card.enc, card: card.card, label: sas.label }, sas.approvedBy === undefined && sas.approvedOwn === true) : { refused: "not_pinned" as const, detail: null };
    this.placingList = false;
    if (!this.mux.active || this.sas !== sas || sas.ended) return;
    // the service's refusal, or its silence, is no failed pairing of this device's: it counts against nobody
    this.endPairing(true);
    if ("refused" in outcome) {
      console.warn(outcome.refused === "behind" ? "[account] a device was not let into the list: this Ovis is too old to read what a member wrote into it. Update Ovis on this PC"
        : `[account] a device was not let into the list: ${outcome.refused}${outcome.detail === null ? "" : ` (${outcome.detail})`}`);
      // the refusal is `auth_failed`, as for any join that was not let in; its message says which of the causes a
      // device can act on it was (LIST_ALLOW_CAUSES), so the phone can say "sign in again" or "try again" apart
      this.failJoin(LIST_ALLOW_CAUSES[outcome.refused] ?? "list_refused");
      return;
    }
    const role = list!.role(sas.publicKey);
    if (role == null) { this.close("auth_failed"); return; }
    this.listPlace = outcome.allowed;
    const { devices, accountRows } = this.options.services;
    // A key this PC holds by a pairing under an id of its own gets no account row. Its receipt goes over that
    // pairing's row, as its sign-in by the list key will (matchListKey): the list answers for the key, and the answer
    // names the account's id for it
    const paired = accountRows?.row(id) == null ? devices.listPairing(sas.publicKey, this.options.serverId) : null;
    if (paired !== null) {
      this.listKey = sas.publicKey;
      this.signedInAs = id;
      this.enter({ id: paired.id, label: paired.label, role });
      return;
    }
    this.enter({ id, label: accountRows?.row(id)?.label ?? sas.label, role });
  }

  /** Once per comparison: one that made no device counts against relay pairing (server/devices.ts), unless admitNewDevice refused it. */
  private endPairing(counted: boolean): void {
    this.options.services.relay.approvals.releaseVouched(this.sessionId);
    delete this.proofChallenge;
    const sas = this.sas;
    if (!sas || sas.ended) return;
    sas.ended = true;
    sas.cancelDeadline?.();
    sas.stopRevokeAll?.();
    sas.stopApprover?.();
    sas.withdraw?.();
    if (!counted && (this.intent !== "vouched" || sas.withdraw)) this.options.services.devices.noteRelayFailure(this.path);
  }

  /** A plain tap never promotes an existing row, bypasses a denial, or outlives its exact admission. */
  private vouchedEligible(key: string): boolean {
    const { devices, accountMailbox, accountRows } = this.options.services;
    return devices.hasAccountApprover() && devices.accountError === null && devices.admits(key) && !devices.isTombstoned(key)
      && !devices.hasKey(key) && !accountRows?.rowsByKey(key).length && !accountMailbox.gates().held(key) && accountMailbox.currentAdmission(key);
  }

  /**
   * An account join outside the pairing window (docs/account.md, design 5.3), or another PC of the account
   * vouched for: only with the account or vouched intent, on a PC in an account with a member to approve, for a
   * key the account service has a fresh admission for, at most 5 a minute between them. Never counted as a
   * failed pairing: nobody was asked. On a PC with no member yet (added in one press), an account join is a first
   * join, which this PC's own window alone allows; a PC vouched for still needs a member.
   */
  private async accountJoin(key: string): Promise<"members" | "first" | "unanswered" | null> {
    const { devices, relay, accountMailbox } = this.options.services;
    const allowed = (): "members" | "first" | null => {
      if ((this.intent !== "account" && this.intent !== "vouched") || devices.account() === null) return null;
      if (devices.hasAccountApprover()) return "members";
      return this.intent === "account" ? "first" : null;
    };
    if (allowed() === null) return null;
    this.mux.extendSetup(PAIR_APPROVAL_MS + 1_000);
    // only a client that can hear why (account-listing-errors-1) is cut off at the bound; any other waits as it always did
    const admitted = this.listingErrors ? await this.joinAdmission(key) : await accountMailbox.admitted(key);
    if (admitted !== true) return admitted === "unanswered" ? "unanswered" : null;
    // decided again once admitted: a member who joined meanwhile approves it as ever
    const joined = allowed();
    // counted only once admitted, so refused strangers cannot spend the PC's joins
    return joined !== null && (this.intent === "vouched" || relay.approvals.takeAccountJoin()) ? joined : null;
  }

  /**
   * The account's word on the join of `key`, within JOIN_ADMISSION_WAIT_MS: an answer that comes later serves the next try.
   * At the bound it answers by what the PC has read so far: the mailbox records the admission before the rest of its read.
   */
  private async joinAdmission(key: string): Promise<boolean | "unanswered"> {
    const { accountMailbox } = this.options.services;
    let cancel = (): void => {};
    const late = new Promise<boolean | "unanswered">((resolve) => {
      cancel = this.clock.setTimeout(() => resolve(accountMailbox.currentAdmission(key) ? true : "unanswered"), JOIN_ADMISSION_WAIT_MS);
    });
    try { return await Promise.race([accountMailbox.joinAdmitted(key), late]); }
    finally { cancel(); }
  }

  /**
   * A sign-in a PC in an account would refuse: a member may have added the device on another PC a
   * moment ago, so the PC reads its mailbox first (at most once a minute and for at most 5 seconds,
   * server/account/mailbox.ts); the caller then checks the sign-in as ever. Whatever fails, an id with
   * no row here or a signature that does not hold, takes this same way, so how long the refusal takes
   * does not tell which ids have a row. A sign-in that holds calls nothing. False when the session
   * ended meanwhile.
   */
  private async pullForRefusedSignIn(deviceId: string, signature: string): Promise<boolean> {
    return pullForRefusedSignIn(this.options, { deviceId, signature, nonce: this.nonce }, this.mux);
  }

  private get path(): PairingPath { return this.intent === "account" ? "account" : this.intent === "vouched" ? "vouched" : "code"; }

  private async enterProved(device: DeviceMatch): Promise<void> {
    const { devices } = this.options.services;
    const binding = devices.serviceBinding();
    // a PC pinned to its signed list asks the account service nothing about its listing: the list says who is in
    if (binding !== null && devices.accountOnly(device.id) && !devices.listFollowed()) {
      const key = devices.sessionRow(device.id)?.key;
      const verdict = key ? await this.listingVerdict(binding) : "refused";
      if (!this.mux.active) return;
      // the hour since the last whole read may have ended while the service was asked: the row waits, its key stands
      if (verdict === "confirmed" && devices.serviceBinding() === binding && devices.waitsForRead(device.id)) { this.refuseWaiting(); return; }
      if (verdict !== "confirmed" || devices.serviceBinding() !== binding || devices.sessionRow(device.id)?.key !== key) { this.refuseListing(verdict); return; }
      this.listedFor = binding;
    }
    this.enter(device);
  }

  /** A proved row that only waits for this PC's next whole read. */
  private refuseWaiting(): void {
    const refusal = accountSignInRefusal({ refused: "catching_up" }, null, this.accountCodes);
    this.mux.fail(refusal.code, refusal.message, undefined, refusal.hold);
  }

  /**
   * Before an account device is told to wait for this PC's first read: with the account service not answering, or the
   * PC out of its account, that read is not coming, and the device hears which.
   */
  private async readComing(id: string): Promise<boolean> {
    const { devices } = this.options.services;
    const binding = devices.serviceBinding();
    // a device that knows the hold but not the two codes keeps its wait; one that knows neither would read the refusal as its removal
    if ((!this.listingErrors && this.accountCodes) || binding === null || !devices.accountOnly(id)) return true;
    const verdict = await this.listingVerdict(binding);
    if (verdict === "confirmed") return true;
    if (this.mux.active) this.refuseListing(verdict);
    return false;
  }

  /** An account service that does not answer in time is an outage to this sign-in; its answer, when it comes, serves the next. */
  private async listingVerdict(binding: string): Promise<ListingVerdict> {
    let cancel = (): void => {};
    const late = new Promise<ListingVerdict>((resolve) => { cancel = this.clock.setTimeout(() => resolve("unreachable"), LISTING_WAIT_MS); });
    try { return await Promise.race([this.options.services.accountMailbox.confirmsListing(binding), late]); }
    finally { cancel(); }
  }

  /** An outage refuses without a word against the device's key; only a client that knows the two account codes is sent them. */
  private refuseListing(verdict: ListingVerdict): void {
    if (verdict === "unreachable") this.close(this.listingErrors ? "account_unreachable" : "internal_error", undefined, "account_unreachable");
    // the answer that made this PC leave came in this very sign-in: the device that proved its key hears what its next one would
    else if (verdict === "readd" || (verdict === "refused" && this.keyProven && this.options.services.devices.readdRequired())) this.close(this.listingErrors ? "account_readd_required" : "auth_failed", undefined, "account_readd_required");
    else this.close("auth_failed");
  }

  /**
   * A verified AUTH, PAIR or approved comparison becomes this session's one principal.
   *
   * The one place where the list answers for a row of this PC's own devices: on a PC pinned to its account's list, a
   * row whose id is the account's own for its key (DeviceStore.listGoverned) opens a session only as the list says,
   * whichever way the row came here: a sign-in, a pairing confirmed on this PC's screen that reuses the row, a
   * comparison by digits, a code. The list is asked only of a key the session proved (`keyProven`): a key that was
   * sent and never signed with opens nothing under that id, so the row a comparison just made is recorded and the
   * device gets in by a sign-in. From then on the session is the list's (listKey): it ends when the list lets the key
   * in no more. A row under an id of its own is not asked about here: that pairing is the PC's own business.
   * Another PC of the account (a row that records the relay key its join proved) is the list's to answer for in its
   * own way: it is let in, to watch, while the list holds that relay key as a PC that is in, at its comparison and at
   * every later sign-in, and its session ends when the list removes that PC.
   * One session is not asked here, because the list answered for it in the same turn: the session of a join into the
   * list (`listPlace`), which carries the place of the device's own entry and serves nothing else (every call on it
   * answers `sign_in_required`): the device signs in with its list key afterwards.
   */
  private enter(device: DeviceMatch | null | undefined): void {
    const devices = this.options.services.devices;
    if (!this.mux.active) return;
    if (!device) { this.close("auth_failed"); return; }
    const pcRole = devices.vouchedPcRole(device.id);
    if (pcRole !== undefined) {
      if (pcRole === null) { this.close("auth_failed"); return; }
      this.listPcRow = device.id;
      device = { ...device, role: pcRole };
    }
    const governed = pcRole !== undefined ? null : devices.listGoverned(device.id, this.options.serverId);
    if (governed !== null && this.listPlace === undefined) {
      const role = this.keyProven ? devices.listRoleOf(governed) : null;
      if (role === null) {
        // a client that knows of lists and came without its key's proof is told to sign in with its list key
        if (!this.keyProven && this.listOffered) this.mux.fail("account_list_required", "This PC lets devices of its account in by the account's signed list. Sign in with the key the list holds for this device.");
        else this.close("auth_failed");
        return;
      }
      this.listKey = governed;
      device = { ...device, role };
    } else if (governed !== null) {
      // the receipt of a join into the list: the list answered for the key (allowIntoList), and a row this PC holds
      // under the account's id gives that session no role of its own, here as at a sign-in
      this.listKey = governed;
    }
    const unrevoke = devices.onRevoke(device.id, (waiting) => {
      if (this.state === "ready") devices.noteRelayRevoked();
      if (waiting) this.leave();
      else this.close(devices.has(device.id) ? "auth_changed" : "auth_revoked");
    });
    // a link moves the row to another key: a session signed in with the one it had ends, all but the linking one
    const unlinked = devices.onLinked(device.id, (sessionId) => { if (sessionId !== this.sessionId) this.close("auth_changed"); });
    // a session the list let in ends when the list lets its key in no more, and changes with the role the list gives it
    const unlisted = this.listKey === null && this.listPcRow === null ? () => {} : devices.onListedChange(() => {
      const role = this.listPcRow !== null ? devices.vouchedPcRole(this.listPcRow) ?? null : this.listKey === null ? null : devices.listRoleOf(this.listKey);
      if (role === null) this.close("auth_revoked");
      else if (this.device && role !== this.device.role) this.close("auth_changed");
    });
    this.unwatch = () => { unrevoke(); unlinked(); unlisted(); };
    // the row as its own session sees it: a device, or one that waits to link. What a waiting row may do is decided
    // anew for every stream (principal), never from the answer below
    const row = this.rowNow(device.id);
    if (!row || !this.mux.active) {
      // a row that began to wait for a read meanwhile (the hour ended, or it was made after it) keeps its key
      if (!row && this.mux.active && devices.opensAll() && devices.waitsForRead(device.id)) { this.unwatch(); this.refuseWaiting(); return; }
      // a row that stopped standing while its proof was checked (an account row that expired) ends the session; with
      // the flag off nothing changes
      if (!row && this.mux.active && devices.opensAll()) { this.close("auth_failed"); return; }
      this.unwatch();
      return;
    }
    if (row.role !== device.role) {
      this.close("auth_changed");
      return;
    }
    this.device = Object.freeze(device);
    // a key sent with a code or a comparison was never signed with: nothing account-side may rest on it
    this.key = this.keyProven ? row.key ?? "" : "";
    // The commit callback runs before the sink: synchronous carriers can immediately OPEN.
    // Until then OPEN is still unauthenticated, even while AUTH_OK waits behind receipt credit.
    this.mux.enqueueControl({
      type: FrameType.AUTH_OK, flags: 0, stream_id: 0,
      payload: { session_id: this.sessionId, device_id: this.signedInAs ?? device.id, role: device.role, ...this.hints(row.provisional), ...(this.listPlace ? { list: this.listPlace } : {}) },
    }, undefined, () => {
      if (!this.rowNow(device.id)) { this.close("auth_revoked"); return; }
      // the frame waited in the queue past the listing's answer: the device asks again rather than enter on an old one
      if (this.listedFor !== undefined && !this.options.services.accountMailbox.listingFresh(this.listedFor)) { this.close("timeout"); return; }
      // the id the answer named, which the app stamps on every stream it opens
      this.mux.authenticate(this.signedInAs ?? device.id);
      this.state = "ready";
      logAccess({ event: "relay.session.accepted", origin: devices.accountOnly(device.id) ? "account" : "local-pairing",
        role: device.role, device_no: devices.deviceNumber(device.id) });
      this.options.onAuthenticated?.(device.id);
    });
  }

  /**
   * The row went before it linked: its link was refused, its time ran out, its code ended. Nothing more starts on
   * this session (principal finds no row), and the answers already on their way go out first, the refused link's own
   * among them, so the device reads why. Then the session ends `auth_revoked`: at once when nothing is on its way,
   * and after LEAVING_MS whatever still is, so a request the device never finishes keeps no session.
   */
  private leave(): void {
    if (this.state === "closed" || this.leaving) return;
    if (this.requests.size === 0) { this.close("auth_revoked"); return; }
    this.leaving = this.clock.setTimeout(() => this.close("auth_revoked"), LEAVING_MS);
  }

  private choose(): void {
    if (this.chosen || this.state !== "ready") return;
    this.chosen = true;
    this.options.onChosen?.();
  }

  /**
   * The device a stream is for, as its row stands now. One that waits to link is marked `provisional` for this one
   * stream: it may make two calls (linkStep), and the routes that take them read the mark. A row that linked since
   * is a device like any other from its next stream on, in the role its row has.
   */
  private principal(): DeviceMatch | undefined {
    if (this.state === "closed") return;
    if (this.state !== "ready" || !this.device) { this.close("protocol_error"); return; }
    const row = this.rowNow(this.device.id);
    // while the last answers of a row that went are on their way, a new stream is refused and they still go out
    if (!row) { if (!this.leaving) this.close("auth_revoked"); return; }
    if (row.provisional) return { ...this.device, provisional: true };
    return row.role === this.device.role ? this.device : { ...this.device, role: row.role };
  }

  /** A socket that is not opened: the answer goes out as an HTTP response on its stream. */
  private async refuseSocket(stream: WsStream, response: Response): Promise<void> {
    const rejection = stream.reject(response.status, this.responseHeaders(response.headers));
    if (response.body) await rejection.sendBody(response.body);
    else rejection.end();
  }

  private async websocket(stream: WsStream, exchange: RelayWebSocketRequest): Promise<void> {
    try {
      const response = await (this.options.dispatch ?? handleRequest)(exchange.request, exchange.context);
      if (!stream.live || this.state !== "ready") {
        exchange.upgrade?.data.relay?.close();
        await response?.body?.cancel();
        return;
      }
      const handlers = this.options.websocket;
      if (exchange.upgrade && handlers) {
        const id = exchange.upgrade.data.deviceId;
        const listed = id !== undefined && this.options.services.accountRows?.row(id) != null;
        const socket = new VirtualSocket(exchange.upgrade.data, stream, handlers, listed);
        this.sockets.set(stream, socket);
        socket.open();
        return;
      }
      if (!response) { stream.reset("internal_error"); return; }
      await this.refuseSocket(stream, response);
    } catch (error) {
      exchange.upgrade?.data.relay?.close();
      if (stream.live) stream.reset(error instanceof MuxStreamError ? error.code : "internal_error");
    }
  }

  private responseHeaders(headers: Headers): [string, string][] {
    const allowed: readonly string[] = RESPONSE_HEADERS;
    return [...headers].filter(([name]) => allowed.includes(name) && (name !== "x-server-time" || this.serverTime));
  }

  private context(device: DeviceMatch, timeout: ServerContext["timeout"], upgrade: ServerContext["upgrade"],
    relayBodyBudget?: EventStreamBudget): ServerContext {
    return {
      services: this.options.services, port: this.options.port, requestIP: () => null, timeout, upgrade,
      peer: { kind: "relay", device, sessionId: this.sessionId, serverId: this.options.serverId, key: this.key }, relayBodyBudget,
    };
  }

  private async http(stream: HttpStream): Promise<void> {
    const device = this.principal();
    if (!device) { stream.reset("refused"); return; }
    this.requests.add(stream);
    const abort = new AbortController();
    let timer: (() => void) | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let held = 0;
    let queued = 0;
    let seconds = 60;
    const touch = () => {
      timer?.();
      timer = seconds > 0 ? this.clock.setTimeout(() => stream.reset("upstream_lost"), seconds * 1000) : undefined;
    };
    const timeout: ServerContext["timeout"] = (_request, budget) => { seconds = budget; touch(); };
    const id = stream.id;
    if (id !== undefined) this.activity.set(id, touch);
    const budget: EventStreamBudget = {
      reserve: (bytes) => {
        if (queued + bytes > SOURCE_LIMIT || this.sourceBytes + bytes + this.mux.stats.accountedBytes > SESSION_LIMIT) {
          stream.reset("resource_exhausted");
          return false;
        }
        queued += bytes;
        this.sourceBytes += bytes;
        return true;
      },
      release: (bytes) => { queued -= bytes; this.sourceBytes -= bytes; },
    };
    stream.onDispose = async () => {
      this.requests.delete(stream);
      timer?.();
      if (id !== undefined) this.activity.delete(id);
      abort.abort();
      await reader?.cancel();
      // the last answer of a row that went before it linked is out
      if (this.leaving && this.requests.size === 0) void this.mux.flush().then(() => this.close("auth_revoked"));
    };
    touch();
    try {
      const request = new Request(RELAY_ORIGIN + stream.request.target, {
        method: stream.request.method, headers: relayHeaders(stream.request.headers),
        body: stream.request.body === "stream" ? stream.body : undefined, signal: abort.signal,
      });
      const context = this.context(device, timeout, () => false, budget);
      if (stream.request.body === "stream") stream.accept();
      // a device that waits to link gets its two calls and nothing else: refused here, before any route runs
      const response = this.listPlace !== undefined ? listSignInRequired()
        : device.provisional && !linkStep(request) ? linkRequired() : await (this.options.dispatch ?? handleRequest)(request, context);
      if (!stream.live || stream.final) { await response?.body?.cancel(); return; }
      if (!response) { stream.reset("internal_error"); return; }
      reader = response.body?.getReader();
      stream.headers(response.status, this.responseHeaders(response.headers));
      if (!stream.live) return;
      if (!reader || stream.noBody) {
        await reader?.cancel();
        stream.end();
        return;
      }
      while (stream.live) {
        const chunk = await reader.read();
        if (!stream.live) return;
        if (chunk.done) { stream.end(); return; }
        held = chunk.value.byteLength;
        if (held + this.sourceBytes + this.mux.stats.accountedBytes > SESSION_LIMIT) {
          held = 0;
          stream.reset("resource_exhausted");
          return;
        }
        this.sourceBytes += held;
        for (let offset = 0; offset < chunk.value.byteLength && stream.live; offset += WS_CONTINUATION_CAPACITY) {
          await stream.write(chunk.value.subarray(offset, offset + WS_CONTINUATION_CAPACITY));
        }
        this.sourceBytes -= held;
        held = 0;
      }
    } catch (error) {
      if (stream.live) stream.reset(error instanceof MuxStreamError ? error.code : "internal_error");
    } finally {
      this.sourceBytes -= held;
      reader?.releaseLock();
      reader = undefined;
    }
  }
}
