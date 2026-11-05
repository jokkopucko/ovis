import { errorResponse, jsonResponse, setRequestRoute } from "../http.ts";
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
  if (request.method !== "POST") return fail("method_not_allowed", "Use GET for status and POST for relay actions.", 405);
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
      case "/api/relay/reset-identity": {
        setRequestRoute("/api/relay/reset-identity");
        const status = await service.resetIdentity();
        return reply(status, status.blocked ? 409 : 200);
      }
      default: return fail("method_not_allowed", "Unknown relay action.", 405);
    }
  } catch (error) { return errorResponse(error); }
}
