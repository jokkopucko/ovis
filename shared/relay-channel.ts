/**
 * A relay client's side of a connection to a PC: Noise NK to its key, then Ovis Mux v1 admission with a device key
 * (docs/relay.md).
 */
import { PENDING_MS, pairFingerprint, signPairProof } from "./pair-fingerprint.ts";
import { channelBinding, openClientSecureChannel } from "./relay-e2ee.ts";
import { fromBase64Url, PAIR_APPROVAL_MS, pairCommitment, pairDigits, randomPairNonce, toBase64Url } from "./relay-pair-sas.ts";
import type { SecureChannel, Transport } from "./relay-e2ee.ts";
import { ACCOUNT_FEATURE, ACCOUNT_LIST_ALLOW, ACCOUNT_LIST_FEATURE, ACCOUNT_LISTING_ERRORS, ACCOUNT_OPENS_ALL_FEATURE, decodeFrame, DIRECT_CARRIER, DIRECT_TAILNET, FrameType, isDirectCarrier, isTailnetCarrier, KEY_PROOF_FEATURE, LARGE_WS_MESSAGES, LIMITS_V1, MuxProtocolError, PAIR_INTENT_ACCOUNT, PAIR_INTENT_PC, PAIR_INTENT_VOUCHED, PAIR_PC_PROOF, PAIR_SAS_FEATURE, PC_CODE_ACCOUNT_ONLY, RELAY_HINTS, RELAY_PROTOCOL, SERVER_TIME_HEADER } from "./relay-mux.ts";
import { hintedRelay } from "./relay-regions.ts";
import { MuxEngine, MUX_SETUP_MS } from "./relay-mux-engine.ts";
import type { MuxOptions, SessionFrame } from "./relay-mux-engine.ts";
import type { PairApprover } from "./relay-mux.ts";
import { isWssOrigin, SERVER_ID_PATTERN } from "./relay-offer.ts";
import type { RelayOffer } from "./relay-offer.ts";
import { relayFallback } from "./relay-regions.ts";
import { getDevice, sign } from "./relay-device.ts";
import { RELAY_NEW_SESSIONS_CLOSE } from "./relay-pass.ts";
import type { RelayDevice, RelayDeviceStore } from "./relay-device.ts";

export class AccountOpenUnsupportedError extends Error {
  constructor() {
    super("The PC did not negotiate account open");
    this.name = "AccountOpenUnsupportedError";
  }
}

/** A sign-in with the key the account's signed list holds for this device met a PC that follows no list: it takes that feature from nobody. */
export class AccountListUnsupportedError extends Error {
  constructor() {
    super("The PC does not let devices in by the account's signed list");
    this.name = "AccountListUnsupportedError";
  }
}

/** A join that brought this device's card met a PC that follows another list than the one the card is for: nothing was compared with it. */
export class ListMismatchError extends Error {
  constructor() {
    super("The PC follows another list than this device's account's");
    this.name = "ListMismatchError";
  }
}

export class UnsafeRelayDestinationError extends Error {
  readonly code = "unsafe_relay_destination";
  constructor(readonly field: "relay" | "server_id") {
    super(`Invalid relay destination: ${field}`);
    this.name = "UnsafeRelayDestinationError";
  }
}

export class TargetAccountPcError extends Error {
  constructor() { super("That PC is in an account. Add it from that account."); }
}

export class RelayUnreachableError extends Error {
  readonly code = "relay_unreachable";
  constructor(readonly closeCode: number | null, readonly silent = false) {
    super(silent ? "The relay did not answer" : closeCode === null ? "The relay could not be reached"
      // 1006 is the browser's word for a connection that failed or dropped without a close frame
      : closeCode === 1006 ? "The relay connection failed (1006)" : `The relay closed the connection (${closeCode})`);
    this.name = "RelayUnreachableError";
  }
}

/**
 * The relay's closes that turn a client away (relay/core.ts CLOSE): TRY_AGAIN (busy: too many clients for the PC) and
 * POLICY. Only before the relay assigns a socket are they read as its refusal; a close after it is read as any other.
 */
const RELAY_REFUSALS: ReadonlySet<number> = new Set([1008, 1013]);

/** The relay reached and turned this device away before assigning it (busy, or a policy): nothing is known of the PC. */
export class RelayRefusedError extends RelayUnreachableError {
  constructor(closeCode: number) {
    super(closeCode);
    this.message = `The relay turned this device away (${closeCode})`;
    this.name = "RelayRefusedError";
  }
}

/**
 * The relay closed this client RELAY_NEW_SESSIONS_CLOSE: the PC named it as a device new to it while its relay pass
 * allows no new sessions (relay/README.md, "New sessions"). Only a device that was pairing hears it; ones the PC
 * knows still sign in.
 */
export class RelayNewSessionsRefusedError extends Error {
  readonly code = "new_sessions_refused";
  constructor() {
    super("The relay takes no new devices for this PC");
    this.name = "RelayNewSessionsRefusedError";
  }
}

export class RelayAdmissionTimeoutError extends Error {
  readonly code = "admission_timeout";
  constructor(readonly phase: "handshake" | "welcome" | "auth") {
    super(`The PC did not finish the connection (${phase})`);
    this.name = "RelayAdmissionTimeoutError";
  }
}

export class RelayPcOfflineError extends MuxProtocolError {
  constructor() {
    super("timeout", "The PC did not answer through the relay");
    this.name = "RelayPcOfflineError";
  }
}

/** WebSocket.OPEN, so an injected socket need not be a WebSocket */
const OPEN = 1;

export const ASSIGNMENT_MS = 10_000;
export const PC_ANSWER_MS = 15_000;
export const ADMISSION_MS = MUX_SETUP_MS;
const PAIR_APPROVAL_GRACE_MS = 5_000;
/**
 * How long a PC that took a join's card keeps the join open after both sides said yes, for the entry of its account's
 * list that lets the device in (server/account/list-follow.ts LIST_ALLOW_MS): the entry its own window signs, or the
 * half minute it waits for a member's and its last read. A join that brought the card waits that long on top of the
 * comparison's own time.
 */
export const LIST_JOIN_PLACING_MS = 90_000;
/**
 * A join that brought the card may wait longer than the relay keeps a socket that sent nothing (relay/core.ts IDLE_MS,
 * 120 s): while it waits it sends the relay's own keepalive this often. The relay answers it itself, and no PC, of any
 * version, ever sees it.
 */
export const LIST_JOIN_KEEPALIVE_MS = 60_000;
/** The relay's own keepalive and its answer (relay/core.ts KEEPALIVE_PING, KEEPALIVE_PONG). */
const RELAY_PING = '{"type":"ping"}';
const RELAY_PONG = '{"type":"pong"}';

export interface RelaySocket {
  binaryType: BinaryType;
  /** a WebSocket's: 1 while open; 2 once it is closing, before any close event */
  readonly readyState: number;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
}
export interface RelayChannelOptions {
  readonly store: RelayDeviceStore;
  readonly socket?: (url: string) => RelaySocket;
  readonly label?: string;
  readonly signal?: AbortSignal;
  readonly onClose?: (error: Error) => void;
  readonly pcAnswerMs?: number;
  /** the relay took the socket and waits for the PC: from here, no answer is the PC away, not the network */
  readonly onAssigned?: () => void;
  readonly carrier?: string;
  readonly requestTimeoutMs?: MuxOptions["requestTimeoutMs"];
  /**
   * A new device with no pairing code pairs by comparing digits (shared/relay-pair-sas.ts): this
   * shows them, and resolves once the person says the PC shows the same. Without it such a device
   * cannot pair. The PC's owner still has to approve it there. `approveOn`: the PC itself approves it on its own screen
   * (a first join), named by its system; absent when a device of the account may. `intoList`: the PC took this device's
   * card (listCard), so the join is one into the account's signed list, and only the person's own press here says the
   * numbers match: a member signs the device in on that word.
   */
  readonly compare?: (digits: string, approveOn?: PairApprover, intoList?: true) => Promise<void>;
  /**
   * A signed-in client's account key: a new pairing signs in with it instead of a key of its own
   * for this PC, so the row it gets is the account's to link (docs/account.md, rule 2).
   */
  readonly accountKey?: { readonly private_key: CryptoKey; readonly public_spki: string };
  /**
   * What a comparison asks for, shown in the approval prompt: this PC only, or the account; `pc` by default.
   * `vouched`: a PC's server pairing with another PC of its account (PAIR_INTENT_VOUCHED).
   */
  readonly intent?: "pc" | "account" | "vouched";
  readonly pcProof?: { readonly publicKey: string; answer(frame: string, binding: string): string | null; waiting(): void };
  readonly pcCodeAdd?: boolean;
  /**
   * A comparison only: told what the PC selected in its answer to HELLO, before PAIR_REQUEST goes out. A throw
   * ends the attempt there with that error, and nothing is sent to pair.
   */
  readonly beforeRequest?: (server: RelayServerInfo) => void;
  /**
   * Open the channel on one of the PC's direct carriers (`ws://<private IPv4>:<port>`, docs/relay.md
   * "Direct on the same network") instead of through the relay: signing in only, never a pairing.
   */
  readonly direct?: string;
  /**
   * Offer ACCOUNT_OPENS_ALL_FEATURE in HELLO (device table T34, G5): a client signing in with its registered sign-in
   * key, so a PC with the release on may answer held, not_listed or admission instead of a bare auth failure.
   */
  readonly accountOpensAll?: boolean;
  /**
   * This sign-in is with the key the account's signed list holds for the device (docs/account.md, "How an app signs in
   * to a pinned PC"): it requires ACCOUNT_LIST_FEATURE, so a PC that follows no list refuses it
   * (AccountListUnsupportedError) and the caller falls back to the ways from before. Every sign-in that is no pairing
   * offers that feature, required or not: a pinned PC then tells a client that came with another key so
   * (`account_list_required`), which a client that did not offer it would take for a protocol error.
   */
  readonly accountListKey?: boolean;
  /**
   * A join of the account by a device that claimed its key for the account's signed list (docs/account.md, "A PC
   * allows a device into the list"): the list, its encryption key and its card for that list. The join then offers
   * ACCOUNT_LIST_ALLOW, and to a PC that selects it (one pinned to its list) sends the card with PAIR_REQUEST. Such a
   * PC names the list it follows in its challenge, and the attempt ends there, before any digits are shown, when that
   * is another list than the card's (ListMismatchError). The PC's AUTH_OK then names the place of the entry that let
   * the device in (RelayChannel.listPlace), and no pairing is saved: the list lets the key in, not a row of the PC's.
   */
  readonly listCard?: { readonly list: string; readonly enc: string; readonly card: string };
  /**
   * Offer KEY_PROOF_FEATURE (device table T71, T72): a pairing by code proves its key over the PC's KEY_CHALLENGE and
   * on KEY_PENDING reports the fingerprint it computed from this offer's server_id, that challenge and its own key.
   * Nothing the PC or the relay sends is shown as a fingerprint.
   */
  readonly keyProof?: (fingerprint: string) => void;
  /** Offer DIRECT_CARRIER, so the PC names its direct carriers in AUTH_OK: only a client that can open them. */
  readonly offerDirect?: boolean;
  /** With offerDirect, also offer DIRECT_TAILNET: only a client that can open a carrier on a Tailscale address. */
  readonly offerTailnet?: boolean;
}
export interface RelayChannel {
  readonly mux: MuxEngine;
  readonly device: RelayDevice;
  readonly connectionId: string;
  readonly sessionId: string;
  readonly role: "drive" | "watch";
  readonly server: RelayServerInfo;
  /**
   * False once the relay socket has left OPEN, possibly with no close event yet: a socket closed
   * under the page waits for the relay's answer to its close, and a browser drops what is sent meanwhile.
   */
  readonly carrierOpen: boolean;
  readonly directCarriers?: readonly string[];
  readonly direct?: string;
  /**
   * A join that brought the device's card (RelayChannelOptions.listCard): the list the PC let the device into and the
   * place of the entry that did, as the PC says. The device reads the list up to that place itself. Such a session
   * serves nothing else: the caller closes it and signs in with the key the list now holds.
   */
  readonly listPlace?: { readonly id: string; readonly seq: number; readonly hash: string };
  close(): void;
}

export class DirectCarrierUnusableError extends Error {
  readonly code = "direct_unusable";
  constructor() {
    super("Direct connections only sign a paired device in");
    this.name = "DirectCarrierUnusableError";
  }
}
export interface RelayServerInfo {
  readonly version: string;
  readonly relayProtocol: number;
  readonly features?: readonly string[];
  /** WELCOME's `min_supported_client`: the oldest client this PC supports (server/relay/client-floor.ts) */
  readonly minSupportedClient?: string;
}

/**
 * Waits for what must be read before the socket opens (the device, from a store that may never answer): an abort ends
 * the wait as it ends the socket, and it lasts no longer than the relay has to assign the socket.
 */
function beforeSocket<T>(read: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => { done(); reject(new DOMException("Relay connection aborted", "AbortError")); };
    const timer = setTimeout(() => { done(); reject(new RelayUnreachableError(null, true)); }, ASSIGNMENT_MS);
    const done = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); };
    signal?.addEventListener("abort", aborted, { once: true });
    read.then((value) => { done(); resolve(value); }, (error: unknown) => { done(); reject(error); });
  });
}

/** Resolves only after protected Noise, WELCOME and device admission all succeeded. Never retries. */
export async function openRelayChannel(offer: RelayOffer, options: RelayChannelOptions): Promise<RelayChannel> {
  if (typeof offer.relay !== "string" || !isWssOrigin(offer.relay)) throw new UnsafeRelayDestinationError("relay");
  if (options.carrier !== undefined && !isWssOrigin(options.carrier)) throw new UnsafeRelayDestinationError("relay");
  if (typeof offer.server_id !== "string" || !SERVER_ID_PATTERN.test(offer.server_id)) throw new UnsafeRelayDestinationError("server_id");
  const direct = options.direct;
  if (direct !== undefined && (!isDirectCarrier(direct) || offer.code !== undefined)) throw new DirectCarrierUnusableError();
  const url = new URL("/v1/ws", direct ?? options.carrier ?? offer.relay);
  // the PC behind a direct carrier is the one it is: nothing to route, and nothing for the network to read
  if (direct === undefined) {
    url.searchParams.set("server_id", offer.server_id);
    url.searchParams.set("role", "client");
  }
  url.searchParams.set("v", "1");
  options.signal?.throwIfAborted();
  const store = options.store;
  const device = await beforeSocket(getDevice(offer, store, options.label, options.accountKey), options.signal);
  if (direct !== undefined && device.device_id === null) throw new DirectCarrierUnusableError();
  options.signal?.throwIfAborted();
  const socket = (options.socket ?? ((address) => new WebSocket(address)))(url.href);
  socket.binaryType = "arraybuffer";
  return new Promise<RelayChannel>((resolve, reject) => {
    let phase: "assigned" | "handshake" | "welcome" | "pair" | "auth" | "ready" | "closed" = "assigned";
    const comparing = offer.code === undefined && device.device_id === null && (options.compare !== undefined || options.intent === "vouched");
    // an older PC selects none of these; a comparison names what it asks for, so the PC's prompt can say it
    const offered: readonly string[] = comparing
      ? [ACCOUNT_FEATURE, PAIR_SAS_FEATURE, options.intent === "account" ? PAIR_INTENT_ACCOUNT : options.intent === "vouched" ? PAIR_INTENT_VOUCHED : PAIR_INTENT_PC, ...(options.intent === "vouched" ? [PAIR_PC_PROOF] : []),
        // a join of the account brings the device's card for the account's list, to a PC that takes one
        ...(options.intent === "account" && options.listCard !== undefined ? [ACCOUNT_LIST_ALLOW] : []),
        // and reads why a PC refused it when the account service did not answer that PC (account_unreachable)
        ...(options.intent === "account" ? [ACCOUNT_LISTING_ERRORS] : [])]
      : [ACCOUNT_FEATURE,
        // a sign-in by the list key offers the account open too, never requires it: a PC tells the ten-second hold of a device its list let in only to a client that offered it
        ...options.accountOpensAll === true || (options.accountListKey === true && offer.code === undefined) ? [ACCOUNT_OPENS_ALL_FEATURE] : [],
        ...offer.code === undefined ? [ACCOUNT_LIST_FEATURE] : [],
        ...options.keyProof !== undefined && offer.code !== undefined ? [KEY_PROOF_FEATURE] : [],
        ...options.pcCodeAdd && offer.code !== undefined ? [PC_CODE_ACCOUNT_ONLY] : [], ...offer.code === undefined ? [ACCOUNT_LISTING_ERRORS] : []];
    const hinted: readonly string[] = [RELAY_HINTS, ...options.offerDirect ? [DIRECT_CARRIER, ...options.offerTailnet ? [DIRECT_TAILNET] : []] : []];
    let phoneNonce: Uint8Array | undefined;
    let binding: Uint8Array | undefined;
    let challenge: Uint8Array | undefined;
    /** set once PAIR_CONFIRM went out: before it, AUTH_OK would be a PC skipping the comparison on this phone */
    let confirmed = false;
    /** the PC selected ACCOUNT_LIST_ALLOW for this join: the card went with the request, and its AUTH_OK names a place in that list */
    let carded: { readonly list: string; readonly enc: string; readonly card: string } | undefined;
    let keyProof: { readonly fingerprint: string; readonly shown: boolean } | undefined;
    let secure: SecureChannel | undefined;
    let mux: MuxEngine | undefined;
    let connectionId = "";
    const limits = { ...LIMITS_V1 };
    let welcome: Uint8Array | undefined;
    let passed: Uint8Array | undefined;
    /** the nonce of a provisional WELCOME this phone signed in on, and the PC's answer to HELLO that may follow it */
    let provisionalNonce: string | undefined;
    let answered: Uint8Array | undefined;
    let server: RelayServerInfo = { version: "", relayProtocol: RELAY_PROTOCOL };
    let receipt: Uint8Array | undefined;
    let incoming = Promise.resolve();
    /** the keepalive of a join that brought the card, while it waits (LIST_JOIN_KEEPALIVE_MS); `pinged`: one went out */
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let pinged = false;
    const stop = (error: Error): void => {
      if (phase === "closed") return;
      const admitted = phase === "ready";
      phase = "closed";
      clearTimeout(deadline);
      clearInterval(keepalive);
      options.signal?.removeEventListener("abort", aborted);
      mux?.carrierLost();
      secure?.close(4000, "relay channel closed");
      socket.close(4000, "relay channel closed");
      if (admitted) options.onClose?.(error);
      else reject(error);
    };
    const aborted = (): void => stop(new DOMException("Relay connection aborted", "AbortError"));
    let deadline = setTimeout(() => stop(new RelayUnreachableError(null, true)), ASSIGNMENT_MS);
    let heardPc = false;
    const expect = (ms: number, failure: () => Error): void => {
      clearTimeout(deadline);
      deadline = setTimeout(() => stop(failure()), ms);
    };
    options.signal?.addEventListener("abort", aborted, { once: true });
    const transport: Transport = {
      // a closing socket would drop the frame without an error: fail it, so the mux and its streams end
      send: (data) => {
        if (socket.readyState !== OPEN) throw new MuxProtocolError("internal_error", "Relay socket is not open");
        socket.send(data);
      },
      close: (code = 4000, reason = "") => socket.close(code, reason),
      onmessage: null, onclose: null, onerror: null,
    };
    const send = (frame: SessionFrame): Promise<void> => {
      if (!mux || phase === "closed") throw new MuxProtocolError("protocol_error", "Relay channel is closed");
      mux.sendSession(frame);
      return mux.flush();
    };
    const receive = async (data: string | ArrayBuffer): Promise<void> => {
      if (phase === "closed") return;
      if (typeof data === "string") throw new MuxProtocolError("protocol_error", "Expected binary mux frame");
      const bytes = new Uint8Array(data);
      if (phase === "ready") { mux?.receive(bytes); return; }
      const frame = decodeFrame(bytes);
      if (options.accountOpensAll && phase === "welcome" && frame.type === FrameType.SESSION_ERROR && frame.payload.code === "unsupported_extension") throw new AccountOpenUnsupportedError();
      if (options.accountListKey && phase === "welcome" && frame.type === FrameType.SESSION_ERROR && frame.payload.code === "unsupported_extension") throw new AccountListUnsupportedError();
      if (frame.type === FrameType.SESSION_ERROR) throw new MuxProtocolError(frame.payload.code, frame.payload.message, frame.payload.receipts, frame.payload.hold);
      if (frame.type === FrameType.RECEIVED) {
        if (!mux || frame.payload > mux.stats.submitted) throw new MuxProtocolError("protocol_error", "Receipt exceeds submitted frames");
        receipt = bytes;
        return;
      }
      if (phase === "welcome" && frame.type === FrameType.WELCOME) {
        if (comparing && frame.payload.provisional && !passed) { passed = bytes; return; }
        // before any credential: a PC of another relay generation is an update, not a pairing
        if (frame.payload.relay_protocol !== RELAY_PROTOCOL) throw new MuxProtocolError("unsupported_version", `The PC speaks relay protocol ${frame.payload.relay_protocol}`);
        server = { version: frame.payload.server_version, relayProtocol: frame.payload.relay_protocol, features: frame.payload.features, minSupportedClient: frame.payload.min_supported_client };
        if (frame.payload.features.some((feature) => !offered.includes(feature))) throw new MuxProtocolError("unsupported_extension", "Server selected unoffered features");
        if (options.accountOpensAll) {
          // Account AUTH is sent only after the PC's final, authenticated feature selection.
          if (frame.payload.provisional) { passed = bytes; provisionalNonce = frame.payload.nonce; return; }
          if (provisionalNonce !== undefined && provisionalNonce !== frame.payload.nonce) throw new MuxProtocolError("protocol_error", "The PC's answer to HELLO changed its WELCOME");
          if (!frame.payload.features.includes(ACCOUNT_OPENS_ALL_FEATURE)) throw new AccountOpenUnsupportedError();
        }
        if (options.accountListKey) {
          // the list key is sent only after the PC's final, authenticated answer to HELLO says that it follows a list
          if (frame.payload.provisional) { passed = bytes; provisionalNonce = frame.payload.nonce; return; }
          if (provisionalNonce !== undefined && provisionalNonce !== frame.payload.nonce) throw new MuxProtocolError("protocol_error", "The PC's answer to HELLO changed its WELCOME");
          if (!frame.payload.features.includes(ACCOUNT_LIST_FEATURE)) throw new AccountListUnsupportedError();
        }
        phase = "auth";
        Object.assign(limits, frame.payload.limits);
        welcome = bytes;
        provisionalNonce = frame.payload.provisional ? frame.payload.nonce : undefined;
        if (comparing) {
          options.beforeRequest?.(server);
          // an older PC pairs only with a code from its QR code
          if (!frame.payload.features.includes(PAIR_SAS_FEATURE)) throw new MuxProtocolError("unsupported_extension", "The PC cannot pair without a code");
          binding = secure ? channelBinding(secure) : undefined;
          if (!binding) throw new MuxProtocolError("internal_error", "The relay channel has no binding");
          phoneNonce = randomPairNonce();
          phase = "pair";
          carded = options.intent === "account" && frame.payload.features.includes(ACCOUNT_LIST_ALLOW) ? options.listCard : undefined;
          // a join the PC takes the card for waits, after the comparison, for the entry that lets the device in
          const pairing = PAIR_APPROVAL_MS + PAIR_APPROVAL_GRACE_MS + (carded === undefined ? 0 : LIST_JOIN_PLACING_MS);
          expect(pairing, () => new RelayAdmissionTimeoutError("auth"));
          mux?.extendSetup(pairing);
          // and longer than the relay keeps a socket that sends nothing: the relay's own keepalive, which the PC never sees
          if (carded !== undefined && direct === undefined) {
            keepalive = setInterval(() => {
              if (phase === "closed" || phase === "ready" || socket.readyState !== OPEN) return;
              pinged = true;
              socket.send(RELAY_PING);
            }, LIST_JOIN_KEEPALIVE_MS);
          }
          await send({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0,
            payload: { label: device.label, public_key: device.public_spki, commitment: toBase64Url(pairCommitment(binding, device.public_spki, phoneNonce)), ...(options.pcProof ? { server_key: options.pcProof.publicKey } : {}),
              ...(carded === undefined ? {} : { list_enc: carded.enc, list_card: carded.card }) } });
        } else if (offer.code !== undefined) {
          if (options.pcCodeAdd && frame.payload.features.includes(PC_CODE_ACCOUNT_ONLY)) throw new TargetAccountPcError();
          await send({ type: FrameType.PAIR, flags: 0, stream_id: 0,
            payload: { code: offer.code, label: device.label, public_key: device.public_spki } });
        } else {
          if (device.device_id === null) throw new MuxProtocolError("auth_failed", "Pair this device first");
          const nonce = Uint8Array.from(atob(frame.payload.nonce.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
          const signature = await sign(device, nonce, offer.server_id);
          await send({ type: FrameType.AUTH, flags: 0, stream_id: 0,
            payload: { scheme: "device-key", device_id: device.device_id, signature } });
        }
        return;
      }
      if (phase === "pair" && frame.type === FrameType.PAIR_CHALLENGE && binding && phoneNonce) {
        // the PC follows another list than the one this device's card is for: nothing is compared, and nothing revealed
        if (carded !== undefined && frame.payload.list !== carded.list) throw new ListMismatchError();
        challenge = bytes;
        phase = "auth";
        if (options.intent === "vouched") {
          const proof = frame.payload.server_challenge && options.pcProof?.answer(frame.payload.server_challenge, toBase64Url(binding));
          if (!options.pcProof || !proof || !server.features?.includes(PAIR_PC_PROOF)) throw new MuxProtocolError("auth_failed", "Missing PC identity proof");
          await send({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(phoneNonce), server_proof: proof } });
          confirmed = true;
          await send({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
          options.pcProof.waiting();
          return;
        }
        const digits = pairDigits(binding, device.public_spki, phoneNonce, fromBase64Url(frame.payload.nonce));
        await send({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(phoneNonce) } });
        // never awaited here: the PC's refusal or timeout must still come through while the person looks
        void options.compare?.(digits, frame.payload.approve_on, carded === undefined ? undefined : true).then(() => {
          if (phase !== "auth") return;
          confirmed = true;
          return send({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
        }).catch(failed);
        return;
      }
      // one challenge per pairing: a second one, or one to a device that did not ask, ends the attempt
      if (phase === "auth" && frame.type === FrameType.KEY_CHALLENGE && offer.code !== undefined && options.keyProof !== undefined && keyProof === undefined) {
        const fingerprint = await pairFingerprint(offer.server_id, frame.payload.challenge, device.public_spki);
        const signature = await signPairProof(offer.server_id, frame.payload.challenge, device.public_spki, device.private_key);
        expect(PENDING_MS + PAIR_APPROVAL_GRACE_MS, () => new RelayAdmissionTimeoutError("auth"));
        mux?.extendSetup(PENDING_MS + PAIR_APPROVAL_GRACE_MS);
        await send({ type: FrameType.KEY_PROVE, flags: 0, stream_id: 0, payload: { signature } });
        keyProof = { fingerprint, shown: false };
        return;
      }
      if (phase === "auth" && frame.type === FrameType.KEY_PENDING && keyProof !== undefined) {
        if (!keyProof.shown) {
          expect(PENDING_MS + PAIR_APPROVAL_GRACE_MS, () => new RelayAdmissionTimeoutError("auth"));
          mux?.extendSetup(PENDING_MS + PAIR_APPROVAL_GRACE_MS);
          options.keyProof?.(keyProof.fingerprint);
        }
        keyProof = { ...keyProof, shown: true };
        return;
      }
      // a PC that selects something (the account feature) answers HELLO after the provisional WELCOME this
      // phone already signed in on: the same nonce, so the sign-in stands, and only what it selected is new
      if (phase === "auth" && frame.type === FrameType.WELCOME && !frame.payload.provisional && provisionalNonce !== undefined && !answered) {
        if (frame.payload.nonce !== provisionalNonce || frame.payload.relay_protocol !== RELAY_PROTOCOL) throw new MuxProtocolError("protocol_error", "The PC's answer to HELLO changed its WELCOME");
        if (frame.payload.features.some((feature) => !offered.includes(feature))) throw new MuxProtocolError("unsupported_extension", "Server selected unoffered features");
        server = { version: frame.payload.server_version, relayProtocol: frame.payload.relay_protocol, features: frame.payload.features, minSupportedClient: frame.payload.min_supported_client };
        answered = bytes;
        return;
      }
      if (phase !== "auth" || frame.type !== FrameType.AUTH_OK) {
        throw new MuxProtocolError("protocol_error", "Unexpected frame before AUTH_OK");
      }
      if (comparing && !confirmed) throw new MuxProtocolError("protocol_error", "AUTH_OK before the digits were confirmed");
      // a sign-in names this phone's own device; a pairing (a code, or digits compared) is given a new one
      if (offer.code === undefined && !comparing && frame.payload.device_id !== device.device_id) {
        throw new MuxProtocolError("auth_failed", "AUTH_OK named a different device");
      }
      // a place is taken only from a PC that took the card, and only in the list the card names
      const listPlace = carded === undefined ? undefined : frame.payload.list;
      if (listPlace !== undefined && listPlace.id !== carded?.list) throw new ListMismatchError();
      // A PC that took the card lets the device in by an entry of the list, or not at all: one that names no place made
      // no entry the device can follow, and nothing of it is saved as a pairing in its stead
      if (carded !== undefined && listPlace === undefined) throw new MuxProtocolError("auth_failed", "list_refused");
      // An entry of the list let this key in, and no row of the PC's own stands behind it: nothing is saved here as a
      // pairing. The device signs in with that key as any device of the list does.
      const admitted = listPlace !== undefined ? { ...device, device_id: frame.payload.device_id } : await store.update(offer.server_id, (current) => {
        // a first pairing's key is saved only now that the PC has admitted it (device.ts getDevice)
        const kept = current ?? (device.device_id === null ? device : undefined);
        if (!kept || kept.server_public_key !== device.server_public_key || kept.public_spki !== device.public_spki) {
          throw new MuxProtocolError("auth_changed", "Stored relay identity changed during authentication");
        }
        // the PC's answer to the relay-hints this phone offered in HELLO, inside the Noise channel the
        // PC authenticated: the relay cannot have written these
        return { ...kept, device_id: frame.payload.device_id, relay: hintedRelay(kept.relay, frame.payload.relays),
          ...(options.offerDirect ? { direct: frame.payload.direct ?? [] } : {}) };
      });
      if (options.signal?.aborted || !secure?.isOpen() || !mux || !welcome) return;
      if (passed) mux.receive(passed);
      mux.receive(welcome);
      if (answered) mux.receive(answered);
      if (challenge) mux.receive(challenge);
      mux.receive(bytes);
      if (receipt) mux.receive(receipt);
      mux.authenticate(admitted.device_id ?? frame.payload.device_id);
      phase = "ready";
      clearInterval(keepalive);
      clearTimeout(deadline);
      resolve({ mux, device: admitted, connectionId, sessionId: frame.payload.session_id, role: frame.payload.role, server,
        directCarriers: options.offerDirect ? frame.payload.direct ?? [] : [],
        ...(listPlace === undefined ? {} : { listPlace }),
        ...(direct === undefined ? {} : { direct }),
        get carrierOpen() { return phase === "ready" && socket.readyState === OPEN; },
        close: () => stop(new MuxProtocolError("internal_error", "Relay channel closed")) });
    };
    const failed = (error: unknown): void => stop(error instanceof Error ? error : new Error(String(error)));
    socket.onclose = (event) => {
      // said first: the secure channel's own close below would report a plain lost socket. Only the relay says it,
      // and only to a device that is pairing: the same code from a direct carrier's address (another host there, where
      // 4403 often means "forbidden") or to a sign-in is a lost socket like any other, so the race goes on to the relay
      const pairing = offer.code !== undefined || device.device_id === null;
      if (event.code === RELAY_NEW_SESSIONS_CLOSE && direct === undefined && pairing) stop(new RelayNewSessionsRefusedError());
      transport.onclose?.(event.code, event.reason);
      stop(phase !== "assigned" ? new MuxProtocolError("internal_error", "Relay socket closed")
        : direct === undefined && RELAY_REFUSALS.has(event.code) ? new RelayRefusedError(event.code) : new RelayUnreachableError(event.code));
    };
    socket.onerror = () => {
      const error = phase === "assigned" ? new RelayUnreachableError(null) : new MuxProtocolError("internal_error", "Relay socket failed");
      transport.onerror?.(error);
      stop(error);
    };
    socket.onmessage = (event) => {
      if (phase === "closed") return;
      // the relay's answer to the keepalive this join sent: nothing of the PC's
      if (pinged && event.data === RELAY_PONG) return;
      if (phase !== "assigned") {
        if (typeof event.data !== "string" && !(event.data instanceof ArrayBuffer)) {
          stop(new MuxProtocolError("protocol_error", "Invalid relay carrier frame"));
          return;
        }
        if (!heardPc) {
          heardPc = true;
          expect(ADMISSION_MS, () => new RelayAdmissionTimeoutError(phase === "auth" ? "auth" : phase === "welcome" ? "welcome" : "handshake"));
        }
        transport.onmessage?.({ data: event.data, isBinary: typeof event.data !== "string" });
        return;
      }
      phase = "handshake";
      incoming = incoming.then(async () => {
        if (options.signal?.aborted) return;
        const assigned: unknown = typeof event.data === "string" ? JSON.parse(event.data) : null;
        if (!assigned || typeof assigned !== "object" || !("type" in assigned) || assigned.type !== "assigned"
          || !("connection_id" in assigned) || typeof assigned.connection_id !== "string"
          || !/^[0-9a-f]{32}$/.test(assigned.connection_id)) {
          throw new MuxProtocolError("protocol_error", "Invalid relay assignment");
        }
        connectionId = assigned.connection_id;
        phase = "welcome";
        if (!heardPc) {
          if (direct === undefined) options.onAssigned?.();
          expect(options.pcAnswerMs ?? PC_ANSWER_MS, () => new RelayPcOfflineError());
        }
        const opened = Promise.withResolvers<void>();
        secure = await openClientSecureChannel(transport, {
          daemonPublicKeyB64: offer.server_public_key,
          events: {
            onopen: () => opened.resolve(),
            onmessage: (data) => { incoming = incoming.then(() => receive(data)).catch(failed); },
            onerror: (error) => { opened.reject(error); stop(error); },
            onclose: () => { const error = new MuxProtocolError("internal_error", "Secure relay channel closed"); opened.reject(error); stop(error); },
          },
        });
        await opened.promise;
        if (!secure.isOpen()) return;
        const carrier = secure;
        mux = new MuxEngine({
          role: "client", send: (bytes) => carrier.send(bytes.slice().buffer),
          close: () => stop(new MuxProtocolError("internal_error", "Relay mux closed")),
          clock: { now: () => performance.now(), setTimeout: (callback, ms) => {
            const timer = setTimeout(() => {
              if (phase === "ready") callback();
              else stop(new RelayAdmissionTimeoutError(phase === "auth" ? "auth" : "welcome"));
            }, ms);
            return () => clearTimeout(timer);
          } },
          outboundWireByteLength: (bytes) => carrier.outboundWireByteLength(bytes.slice().buffer),
          routingOverhead: 0, maxWireMessageBytes: 65536, limits, requestTimeoutMs: options.requestTimeoutMs,
          onClose: (error) => stop(error),
        });
        mux.receiveLargeMessages();
        await send({ type: FrameType.HELLO, flags: 0, stream_id: 0,
          payload: { protocol: "ovis-mux", versions: [1], features: [...hinted, LARGE_WS_MESSAGES, SERVER_TIME_HEADER, ...offered], required_features: options.accountOpensAll ? [ACCOUNT_OPENS_ALL_FEATURE] : options.accountListKey ? [ACCOUNT_LIST_FEATURE] : [] } });
      }).catch(failed);
    };
  });
}

/**
 * Whether the PC answers on a direct carrier, proven and nothing more: the socket is opened, the PC
 * assigns it, and the Noise handshake to the key the offer pins completes; then it is closed before
 * HELLO, so the PC holds no session for it. False for anything else within `ms`, a host at the
 * address that is not the PC included.
 */
export async function probeDirect(offer: RelayOffer, direct: string, socketFor: (url: string) => RelaySocket, ms: number, signal?: AbortSignal): Promise<boolean> {
  return (await probePc(offer, { direct }, socketFor, ms, signal)).kind === "answered";
}

/**
 * What a probe of the PC found: it `answered` (the Noise handshake to its pinned key completed, `ms`
 * from the carrier's `assigned` frame, so one round trip to the PC and back), the carrier assigned the
 * connection and no PC answered in time (`silent`: offline, for a relay), the relay turned this device away
 * (`refused`: a close of RELAY_REFUSALS before it assigned the connection), or the carrier failed with nothing said (`unreachable`: no assignment,
 * an error or a dropped socket; a relay's HTTP 429 before the upgrade looks the same to a browser).
 */
export type PcProbe = { readonly kind: "answered"; readonly ms: number } | { readonly kind: "silent" } | { readonly kind: "refused" } | { readonly kind: "unreachable" };

export function probePc(offer: RelayOffer, via: { readonly direct: string } | { readonly relay: string }, socketFor: (url: string) => RelaySocket, ms: number, signal?: AbortSignal): Promise<PcProbe> {
  const unreachable: PcProbe = { kind: "unreachable" };
  if (signal?.aborted) return Promise.resolve(unreachable);
  if ("direct" in via ? !isDirectCarrier(via.direct) : !isWssOrigin(via.relay) || typeof offer.server_id !== "string" || !SERVER_ID_PATTERN.test(offer.server_id)) return Promise.resolve(unreachable);
  return new Promise<PcProbe>((resolve) => {
    const url = new URL("/v1/ws", "direct" in via ? via.direct : via.relay);
    if ("relay" in via) {
      url.searchParams.set("server_id", offer.server_id);
      url.searchParams.set("role", "client");
    }
    url.searchParams.set("v", "1");
    let socket: RelaySocket;
    try { socket = socketFor(url.href); } catch { resolve(unreachable); return; }
    socket.binaryType = "arraybuffer";
    let secure: SecureChannel | undefined;
    let settled = false;
    let assignedAt: number | undefined;
    const settle = (answer: PcProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      secure?.close(4000, "probe done");
      // a handshake that never finished keeps retrying until its carrier says it closed
      transport.onclose?.(4000, "probe done");
      socket.close(4000, "probe done");
      resolve(answer);
    };
    const failed = (): void => settle(assignedAt === undefined ? unreachable : { kind: "silent" });
    const timer = setTimeout(failed, ms);
    const aborted = (): void => settle(unreachable);
    signal?.addEventListener("abort", aborted, { once: true });
    const transport: Transport = {
      // a send that throws ends the probe from a later turn, once the handshake's retry exists to be stopped
      send: (data) => {
        if (socket.readyState !== OPEN) return;
        try { socket.send(data); } catch { queueMicrotask(failed); }
      },
      close: failed,
      onmessage: null, onclose: null, onerror: null,
    };
    let assigned = false;
    socket.onerror = () => settle(unreachable);
    socket.onclose = (event) => {
      if ("relay" in via && !assigned && RELAY_REFUSALS.has(event.code)) settle({ kind: "refused" });
      else if (event.code === 1006) settle(unreachable);
      else failed();
    };
    socket.onmessage = (event) => {
      if (settled) return;
      if (assigned) { transport.onmessage?.({ data: event.data, isBinary: typeof event.data !== "string" }); return; }
      assigned = true;
      let value: unknown;
      try { value = typeof event.data === "string" ? JSON.parse(event.data) : null; } catch { value = null; }
      if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "assigned") { settle(unreachable); return; }
      const started = performance.now();
      assignedAt = started;
      // a handshake to another key is no answer from the PC: nothing is known of it
      void openClientSecureChannel(transport, {
        daemonPublicKeyB64: offer.server_public_key,
        events: { onopen: () => settle({ kind: "answered", ms: Math.round(performance.now() - started) }), onmessage: () => {}, onerror: () => settle(unreachable), onclose: failed },
      }).then((channel) => { secure = channel; if (settled) channel.close(4000, "probe done"); }, () => settle(unreachable));
    };
  });
}

export function orderDirectRoutes(carriers: readonly string[], worked?: string): string[] {
  const rank = (carrier: string): number => isTailnetCarrier(carrier) ? 1 : 0;
  return carriers.map((carrier, index) => ({ carrier, index }))
    .sort((a, b) => rank(a.carrier) - rank(b.carrier) || Number(b.carrier === worked) - Number(a.carrier === worked) || a.index - b.index)
    .map(({ carrier }) => carrier);
}

/**
 * Opens through `first` (the offer's own relay by default) and, when the offer names one of Ovis's
 * regional relays and that attempt failed before the PC answered (so no pairing code was spent),
 * through the other of the offer's relay and the global one, which such a PC is always linked to. `mayFallBack` says,
 * once the first attempt failed, whether that failure may speak for the relay (one frozen with the page does not).
 */
export async function openRelayChannelWithFallback<O extends { readonly carrier?: string }>(
  offer: RelayOffer, options: O, open: (offer: RelayOffer, options: O) => Promise<RelayChannel>, first = offer.relay,
  mayFallBack: () => boolean = () => true,
): Promise<{ channel: RelayChannel; relay: string }> {
  const attempt = async (relay: string) => ({ channel: await open(offer, relay === offer.relay ? options : { ...options, carrier: relay }), relay });
  try { return await attempt(first); }
  catch (error) {
    const fallback = relayFallback(offer.relay);
    if (!fallback || !(error instanceof RelayUnreachableError || error instanceof RelayPcOfflineError) || !mayFallBack()) throw error;
    return attempt(first === fallback ? offer.relay : fallback);
  }
}
