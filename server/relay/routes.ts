import { DeviceGoneError, DeviceReadOnlyError, PairingFinishingError, PairingGoneError, PcInAccountError } from "../devices.ts";
import { MachineCodeForAccountError } from "../machine-profile.ts";
import { errorResponse, jsonResponse, readJsonObject, setRequestRoute } from "../http.ts";
import type { ServerContext } from "../dispatch.ts";
import { RELAY_CONTROLS } from "../dispatch-routes.ts";
import { accountLabel } from "../../shared/account-asker.ts";
import { updateRequestAllowed } from "../update-api.ts";
import { ACCOUNT_ID, AccountServiceOffError, NoAccountNamedError, ResetNotAskedError, ResetRegistryUnavailableError } from "./service.ts";

/**
 * Drive authority and the outer origin gate are shared with Portal in dispatch.ts. `caller`: the paired device
 * the request came from, null for this PC itself: it holds the pairing code an offer or a typed code gives it.
 */
export async function handleRelayRequest(request: Request, pathname: string, context: ServerContext, caller: string | null = null, local = false, own = false): Promise<Response> {
  const service = context.services.relay;
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  const fail = (code: string, message: string, status: number) => reply({ error: { code, message } }, status);
  if (pathname === "/api/relay" && request.method === "GET") {
    setRequestRoute("/api/relay");
    // this PC's ID and the account named for it go to its own window and CLI (`ovis status --json`, `ovis join`), not
    // to every device that reads the relay's state
    return reply(own ? { ...service.status(), server_id: service.serverId() ?? null, relay_account: service.savedRelayAccount() } : service.status());
  }
  const peer = context.peer;
  // one admission rule (docs/account.md): this PC itself, or a drive account member through the relay
  const remoteApprover = peer.kind === "relay" && context.services.devices.isAccountApproverSession(peer.device.id, peer.key) ? peer.device : null;
  // On a PC pinned to its account's list, a device that signed in with a key the list holds decides a join into the
  // list when the list holds it to drive with full power: what may add a device to the list may approve its join. Read
  // from this PC's copy of the list at each call, never from the row's age or the snapshot. False: a device of the list
  // that may not (to watch, or with bound power); null: no device of the list
  const listAllower = (): boolean | null => peer.kind === "relay" && peer.key !== "" ? context.services.accountList?.allowsJoins(peer.key) ?? null : null;
  const cannotAllow = () => fail("list_cannot_allow", "This device is in your account's list, but only a device that can add devices to the list may let one in.", 403);
  const accountRequired = () => fail("account_required", "Approve pairings on this PC, or from a device linked to your account.", 403);
  if (pathname === "/api/relay/pairings" && request.method === "GET") {
    setRequestRoute("/api/relay/pairings");
    if (peer.kind !== "relay") return reply({ pairings: service.approvals.list() });
    if (remoteApprover) return reply({ pairings: service.approvals.remoteList() });
    const allows = listAllower();
    // a device of the list sees the joins the list lets in, and no pairing of this PC's own
    return allows === true ? reply({ pairings: service.approvals.listJoins() }) : allows === false ? cannotAllow() : accountRequired();
  }
  // an account join taken outside the pairing window, listed for this PC's own window alone and never with its digits
  if (pathname === "/api/relay/joins" && request.method === "GET") {
    setRequestRoute("/api/relay/joins");
    if (!own) return fail("own_window_required", "Only this PC's own window lists account joins.", 403);
    // a join into the list that this PC cannot sign says why before anybody approves it here: its Ovis is behind the
    // list, or it joined by an invite and signs for nobody (a device of the account allows it then)
    const refusal = context.services.accountList?.allowRefusal();
    const why = refusal === "behind" ? { list_behind: true as const } : refusal === "not_signer" ? { list_not_signer: true as const } : null;
    return reply({ joins: service.approvals.ownJoins().map((join) => why !== null && join.list === true ? { ...join, ...why } : join) });
  }
  if (request.method !== "POST") return fail("method_not_allowed", "Use GET for status and POST for relay actions.", 405);
  if (pathname === RELAY_CONTROLS.pairing && peer.kind === "relay") {
    setRequestRoute("/api/relay/pairing");
    if (!remoteApprover) {
      const allows = listAllower();
      if (allows !== true) return allows === false ? cannotAllow() : accountRequired();
    }
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    const pc = typeof body.proven_server_id === "string" && /^[0-9a-f]{32}$/.test(body.proven_server_id)
      && typeof body.pc_label === "string" && body.pc_label && body.pc_label === accountLabel(body.pc_label)
      ? { id: body.proven_server_id, label: body.pc_label } : undefined;
    if (typeof body.id !== "string" || (body.decision !== "approve" && body.decision !== "decline")
      || (body.decision === "approve" && !(typeof body.digits === "string" && /^[0-9]{6}$/.test(body.digits) || body.digits === undefined && pc !== undefined))) {
      return fail("invalid_relay_pairing", "Send the pairing's id, a decision of approve or decline, and the digits the new device shows.", 400);
    }
    // asked again after the body was read: the right is the one held in the turn that decides
    let outcome: ReturnType<typeof service.approvals.decideRemote>;
    if (remoteApprover) {
      if (!context.services.devices.isAccountApproverSession(peer.device.id, peer.key)) return accountRequired();
      outcome = service.approvals.decideRemote(body.id, body.decision === "approve", typeof body.digits === "string" ? body.digits : "", remoteApprover, pc);
    } else {
      const allows = listAllower();
      if (allows !== true) return allows === false ? cannotAllow() : accountRequired();
      // a device of the list decides a join into the list, and no pairing of this PC's own: any other is not there for it
      outcome = service.approvals.decideForList(body.id, body.decision === "approve", typeof body.digits === "string" ? body.digits : "", peer.device);
    }
    if (outcome.outcome !== "decided") {
      // a join into the list is approved only once the new device confirmed its digits (`confirmed` in the list of
      // waiting joins): its approver signs the device's entry, and signs for nobody who gave up before that
      if (outcome.outcome === "not_confirmed") return fail("not_confirmed", "That device has not confirmed its digits yet. Allow it once it has.", 409);
      return outcome.outcome === "gone"
        ? fail("relay_pairing_gone", "That device is no longer waiting: it left, was decided, or its time ran out.", 404)
        : fail("wrong_digits", "Those are not the digits the new device shows; it was not let in.", 409);
    }
    // the id the new device's row takes once its person confirms too: what the approver's add record and introductions name
    return reply(body.decision === "approve" ? { ok: true, device_id: outcome.device_id } : { ok: true });
  }
  if (!updateRequestAllowed(request)) return fail("invalid_relay_request", "Use the relay controls from this app.", 403);
  // A relayed session would hold the relay it runs on; Portal visitors are refused in dispatch.ts (owner_only).
  if (context.peer.kind === "relay") return fail("local_required", "Control the relay from a direct connection to this PC.", 403);
  // the account this PC is to join, named by the call that makes the code (docs/account.md, "A code made for an
  // account"): a device that pairs with it is taken into that account alone. A header, as the two below
  const account = pathname === "/api/relay/offer" || pathname === "/api/relay/code" ? request.headers.get("x-ovis-expect-account") : null;
  const invalidAccount = () => fail("invalid_account", "x-ovis-expect-account names no account id.", 400);
  try {
    // a machine makes a code for an account only (MachineCodeForAccountError), answered before the relay's state is
    // read: the same answer while the relay reconnects, so the command line takes back nothing and a code pending stays
    if (account === null && (pathname === "/api/relay/offer" || pathname === "/api/relay/code") && context.services.options.profile === "machine") {
      setRequestRoute(pathname);
      throw new MachineCodeForAccountError();
    }
    switch (pathname) {
      case RELAY_CONTROLS.start: {
        setRequestRoute("/api/relay/start");
        const status = service.start();
        return reply(status, status.blocked ? 409 : !service.linked ? 500 : 200);
      }
      case RELAY_CONTROLS.stop:
        setRequestRoute("/api/relay/stop");
        return reply(await service.stop());
      case RELAY_CONTROLS.offer:
        setRequestRoute("/api/relay/offer");
        if (service.status().phase === "off" || service.status().blocked) return fail("relay_off", "Start the relay before pairing.", 409);
        if (service.status().phase === "error") return fail("relay_offline", "The relay is not reachable; wait until it is online before pairing.", 409);
        // the relay tab's QR code says what it is for (a header, as x-ovis-local-only below): it puts a PC in no
        // account into the account named for it, so a PC that is in one makes none (409 in_account), and neither
        // does one that no account was named for (409 no_account_named)
        if (account !== null && !ACCOUNT_ID.test(account)) return invalidAccount();
        // the code the caller made and wants this offer to carry (its `pairing.id`; 409 pairing_gone once it is no longer
        // pending, and nothing is started), or `new`: a fresh one
        const want = request.headers.get("x-ovis-pairing");
        if (want !== null && !/^(new|[0-9a-f]{32})$/.test(want)) return fail("invalid_pairing", "x-ovis-pairing names no pairing.", 400);
        const carry = want === null ? {} : { pairing: want };
        return reply(service.offer(caller, account !== null ? { account, ...carry } : { noAccountOnly: request.headers.get("x-ovis-no-account-only") === "1", ...carry }));
      case RELAY_CONTROLS.keep: {
        setRequestRoute("/api/relay/offer/keep");
        // whatever the relay's state: a code made for an account is read by the id its answer gave
        const body = await readJsonObject(request);
        if (body instanceof Response) return body;
        if (typeof body.id !== "string") return fail("invalid_body", "Send the pairing's id.", 400);
        // the device that asks may have been removed, or made one that only watches, while its body was on its way
        if (caller !== null && !context.services.devices.canHoldCode(caller)) {
          if (!context.services.devices.has(caller)) throw new DeviceGoneError();
          return fail("read_only", "this device can only watch", 403);
        }
        const state = context.services.devices.accountPairingState(body.id);
        return reply(state.state === "live" ? { ...state, service_retry_ms: context.services.accountMailbox.serviceRetryMs() } : state);
      }
      case RELAY_CONTROLS.code: {
        setRequestRoute("/api/relay/code");
        if (request.headers.get("x-ovis-pc-add") === "1" && context.services.devices.accountPolicyActive()) {
          return fail("pc_add_target_bound", "That PC is in an account. Add it from that account.", 409);
        }
        if (service.status().phase === "off" || service.status().blocked) return fail("relay_off", "Start the relay before pairing.", 409);
        if (service.status().phase === "error") return fail("relay_offline", "The relay is not reachable; wait until it is online before pairing.", 409);
        if (account !== null && !ACCOUNT_ID.test(account)) return invalidAccount();
        const code = await service.pairCode(caller, account ?? undefined);
        if (code === null) return fail("code_unavailable", "Pairing with a typed code works through Ovis's relay only; scan the QR code instead.", 409);
        return reply(code);
      }
      case RELAY_CONTROLS.cancelCode:
        setRequestRoute("/api/relay/code/cancel");
        service.cancelPairCode();
        return reply({ ok: true });
      case RELAY_CONTROLS.link:
        setRequestRoute("/api/relay/link");
        if (service.status().phase === "off" || service.status().blocked) return fail("relay_off", "Start the relay before pairing.", 409);
        // the PC's own screen waiting to be added to an account: what that link brings is approved here only
        // a query string is refused for every relay control (updateRequestAllowed), so the flag travels as a header,
        // which another site cannot set without a preflight the PC never answers
        return reply(service.pairingLink({ localOnly: request.headers.get("x-ovis-local-only") === "1" }));
      case RELAY_CONTROLS.close:
        setRequestRoute("/api/relay/link/close");
        // Automatic cleanup may name its own window. A stale close has no effect.
        if (!service.approvals.closeWindow(request.headers.get("x-ovis-window") ?? undefined)) return fail("internal_error", "The pairing window is closed, but its saved state could not be cleared.", 500);
        return reply({ ok: true });
      case RELAY_CONTROLS.pairing: {
        setRequestRoute("/api/relay/pairing");
        const body = await readJsonObject(request);
        if (body instanceof Response) return body;
        if (typeof body.id !== "string" || (body.decision !== "approve" && body.decision !== "decline")) {
          return fail("invalid_relay_pairing", "Send the pairing's id and a decision of approve or decline.", 400);
        }
        const key = service.approvals.keyOf(body.id);
        if (!service.approvals.decide(body.id, body.decision === "approve", own)) {
          return fail("relay_pairing_gone", "That phone is no longer waiting: it left, was decided, or its time ran out.", 404);
        }
        // the person at this PC declined that device: what this PC signed for it and keeps goes too
        if (own && body.decision === "decline" && key) context.services.accountList?.declinedHere(key);
        return reply({ ok: true });
      }
      case RELAY_CONTROLS.join: {
        setRequestRoute("/api/relay/join");
        if (!own) return fail("own_window_required", "Approve an account join in this PC's own window.", 403);
        const body = await readJsonObject(request);
        if (body instanceof Response) return body;
        // a first join (no member could approve it) is allowed or declined by a tap, its digits compared on this screen
        if (typeof body.id === "string" && (body.decision === "approve" || body.decision === "decline")) {
          const key = service.approvals.keyOf(body.id);
          const tapped = service.approvals.decideOwn(body.id, body.decision === "approve");
          if (tapped === "gone") return fail("relay_pairing_gone", "That device is no longer waiting: it left, was decided, or its time ran out.", 404);
          if (tapped === "typed_only") return fail("digits_required", "Type the six digits the new device shows.", 409);
          // the person at this PC declined that device: what this PC signed for it and keeps goes too
          if (body.decision === "decline" && key) context.services.accountList?.declinedHere(key);
          return reply({ ok: true });
        }
        if (typeof body.id !== "string" || typeof body.digits !== "string" || !/^[0-9]{6}$/.test(body.digits)) {
          return fail("invalid_relay_join", "Send the join's id and the six digits the new device shows, or a decision of approve or decline for a first join.", 400);
        }
        const outcome = service.approvals.decideTyped(body.id, body.digits);
        if (outcome === "gone") return fail("relay_pairing_gone", "That device is no longer waiting: it left, was decided, or its time ran out.", 404);
        if (outcome === "wrong_digits") return fail("wrong_digits", "Those are not the digits the new device shows; it was not let in.", 409);
        return reply({ ok: true });
      }
      case RELAY_CONTROLS.direct: {
        setRequestRoute("/api/relay/direct");
        const body = await readJsonObject(request);
        if (body instanceof Response) return body;
        if (!service.directAvailable) return fail("direct_unavailable", "This server does not take direct connections.", 409);
        if (typeof body.on !== "boolean") return fail("invalid_relay_direct", "Send { on: true } or { on: false }.", 400);
        return reply(await service.setDirect(body.on));
      }
      case RELAY_CONTROLS.reset: {
        setRequestRoute("/api/relay/reset-identity");
        // Reset ends every relay row: a PC under account policy requires the same local authority as Revoke all.
        if (context.services.devices.accountPolicyActive() && !local) return fail("local_required", "Resetting the relay identity is done at that PC", 403);
        // `removed`: the reset that makes a PC its account's list removed a new one names the identity the person was
        // asked about, and the account. It resets that identity alone: an answer to an old question, given after the
        // PC was reset and added again, must not reset the PC it has become
        const text = await request.text();
        let named: unknown;
        try { named = text === "" ? undefined : (JSON.parse(text) as { removed?: unknown } | null)?.removed; } catch { return fail("invalid_json", "request body must be JSON", 400); }
        let removed: { account: string; server_id: string } | undefined;
        if (named !== undefined) {
          const { account, server_id } = (typeof named === "object" && named !== null ? named : {}) as { account?: unknown; server_id?: unknown };
          if (typeof account !== "string" || typeof server_id !== "string") return fail("invalid_reset", "Name the account and the relay identity that was removed from it", 400);
          removed = { account, server_id };
        }
        // a PC that is in an account again, or another PC by now, is not reset: asked in the turn that resets (409)
        const status = await service.resetIdentity(removed);
        return reply(status, status.blocked ? 409 : 200);
      }
      default: return fail("method_not_allowed", "Unknown relay action.", 405);
    }
  } catch (error) {
    // the device that asked for an offer or a code was revoked while its request was on its way: it is handed none
    if (error instanceof DeviceGoneError) return fail(error.code, error.message, 401);
    // or made one that only watches meanwhile: it is handed none either
    if (error instanceof DeviceReadOnlyError) return fail(error.code, error.message, 403);
    // the PC joined an account since the page read it: the page asks nothing more and says how a device is added there
    if (error instanceof PcInAccountError) return fail(error.code, error.message, 409);
    // the code an offer named is no longer pending: none is started in its place, and the one pending stays
    if (error instanceof PairingGoneError) return fail(error.code, error.message, 409);
    // a device that paired with the relay tab's code may still link: the QR code asks again once its time is over
    if (error instanceof PairingFinishingError) return jsonResponse({ error: { code: error.code, message: error.message } }, 409, { "cache-control": "no-store", "retry-after": String(error.retryAfter) });
    // no account was named for this PC: its page asks for the sign-in first, and for this code only once one is named
    if (error instanceof NoAccountNamedError) return fail(error.code, error.message, 409);
    if (error instanceof ResetRegistryUnavailableError) return fail(error.code, error.message, 503);
    if (error instanceof ResetNotAskedError) return fail(error.code, error.message, 409);
    // such a code lets a device in only on its account's word, which a PC with no account service cannot ask for
    if (error instanceof AccountServiceOffError) return fail(error.code, error.message, 409);
    // a machine makes a code for an account only: its command line says how a device is added there
    if (error instanceof MachineCodeForAccountError) return fail(error.code, error.message, 409);
    return errorResponse(error);
  }
}
