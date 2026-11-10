import { errorResponse, jsonResponse, readJsonObject, setRequestRoute } from "../http.ts";
import type { ServerContext } from "../dispatch.ts";
import { updateRequestAllowed } from "../update-api.ts";

/** Drive authority and the outer origin gate are shared with Portal in dispatch.ts. */
export async function handleRelayRequest(request: Request, pathname: string, context: ServerContext): Promise<Response> {
  const service = context.services.relay;
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  const fail = (code: string, message: string, status: number) => reply({ error: { code, message } }, status);
  if (pathname === "/api/relay" && request.method === "GET") {
    setRequestRoute("/api/relay");
    return reply(service.status());
  }
  const peer = context.peer;
  // one admission rule (docs/account.md): this PC itself, or a drive account member through the relay
  const remoteApprover = peer.kind === "relay" && context.services.devices.isAccountApproverSession(peer.device.id, peer.key) ? peer.device : null;
  if (pathname === "/api/relay/pairings" && request.method === "GET") {
    setRequestRoute("/api/relay/pairings");
    if (peer.kind === "relay") return remoteApprover ? reply({ pairings: service.approvals.remoteList() }) : fail("account_required", "Approve pairings on this PC, or from a device linked to your account.", 403);
    return reply({ pairings: service.approvals.list() });
  }
  if (request.method !== "POST") return fail("method_not_allowed", "Use GET for status and POST for relay actions.", 405);
  if (pathname === "/api/relay/pairing" && peer.kind === "relay") {
    setRequestRoute("/api/relay/pairing");
    if (!remoteApprover) return fail("account_required", "Approve pairings on this PC, or from a device linked to your account.", 403);
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    if (typeof body.id !== "string" || (body.decision !== "approve" && body.decision !== "decline")
      || (body.decision === "approve" && (typeof body.digits !== "string" || !/^[0-9]{6}$/.test(body.digits)))) {
      return fail("invalid_relay_pairing", "Send the pairing's id, a decision of approve or decline, and the digits the new device shows.", 400);
    }
    const outcome = service.approvals.decideRemote(body.id, body.decision === "approve", typeof body.digits === "string" ? body.digits : "", remoteApprover);
    if (outcome.outcome !== "decided") {
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
  try {
    switch (pathname) {
      case "/api/relay/start": {
        setRequestRoute("/api/relay/start");
        const status = service.start();
        // an existing link in "error" is retrying, not a failed start; a start that left no link failed
        return reply(status, status.blocked ? 409 : !service.linked ? 500 : 200);
      }
      case "/api/relay/stop":
        setRequestRoute("/api/relay/stop");
        return reply(await service.stop());
      case "/api/relay/offer":
        setRequestRoute("/api/relay/offer");
        if (service.status().phase === "off" || service.status().blocked) return fail("relay_off", "Start the relay before pairing.", 409);
        // While connecting, a client the offer reaches waits at the relay for this PC; in error nothing may answer it.
        if (service.status().phase === "error") return fail("relay_offline", "The relay is not reachable; wait until it is online before pairing.", 409);
        return reply(service.offer());
      case "/api/relay/code": {
        setRequestRoute("/api/relay/code");
        if (service.status().phase === "off" || service.status().blocked) return fail("relay_off", "Start the relay before pairing.", 409);
        if (service.status().phase === "error") return fail("relay_offline", "The relay is not reachable; wait until it is online before pairing.", 409);
        const code = await service.pairCode();
        if (code === null) return fail("code_unavailable", "Pairing with a typed code works through Ovis's relay only; scan the QR code instead.", 409);
        return reply(code);
      }
      case "/api/relay/code/cancel":
        setRequestRoute("/api/relay/code/cancel");
        service.cancelPairCode();
        return reply({ ok: true });
      case "/api/relay/link":
        setRequestRoute("/api/relay/link");
        if (service.status().phase === "off" || service.status().blocked) return fail("relay_off", "Start the relay before pairing.", 409);
        // the PC's own screen waiting to be added to an account: what that link brings is approved here only
        // a query string is refused for every relay control (updateRequestAllowed), so the flag travels as a header,
        // which another site cannot set without a preflight the PC never answers
        return reply(service.pairingLink({ localOnly: request.headers.get("x-ovis-local-only") === "1" }));
      case "/api/relay/link/close":
        setRequestRoute("/api/relay/link/close");
        // the owner stopped waiting: nothing more is taken, whatever the relay's state
        if (!service.approvals.closeWindow()) return fail("internal_error", "The pairing window is closed, but its saved state could not be cleared.", 500);
        return reply({ ok: true });
      case "/api/relay/pairing": {
        setRequestRoute("/api/relay/pairing");
        const body = await readJsonObject(request);
        if (body instanceof Response) return body;
        if (typeof body.id !== "string" || (body.decision !== "approve" && body.decision !== "decline")) {
          return fail("invalid_relay_pairing", "Send the pairing's id and a decision of approve or decline.", 400);
        }
        if (!service.approvals.decide(body.id, body.decision === "approve")) {
          return fail("relay_pairing_gone", "That phone is no longer waiting: it left, was decided, or its time ran out.", 404);
        }
        return reply({ ok: true });
      }
      case "/api/relay/direct": {
        setRequestRoute("/api/relay/direct");
        const body = await readJsonObject(request);
        if (body instanceof Response) return body;
        if (!service.directAvailable) return fail("direct_unavailable", "This server does not take direct connections.", 409);
        if (typeof body.on !== "boolean") return fail("invalid_relay_direct", "Send { on: true } or { on: false }.", 400);
        return reply(await service.setDirect(body.on));
      }
      case "/api/relay/reset-identity": {
        setRequestRoute("/api/relay/reset-identity");
        const status = await service.resetIdentity();
        return reply(status, status.blocked ? 409 : 200);
      }
      default: return fail("method_not_allowed", "Unknown relay action.", 405);
    }
  } catch (error) { return errorResponse(error); }
}
