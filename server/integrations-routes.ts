/**
 * GET /api/integrations: herdr's built-in agent integrations on this PC and whether each is
 * installed, as `integration.list` reports them. The dispatcher in index.ts runs the access gate first.
 */
import type { IntegrationsResponse } from "../shared/integrations.ts";
import { integrationList } from "./herdr/client.ts";
import { badRequest, errorResponse, jsonResponse, setRequestRoute } from "./http.ts";

export async function handleIntegrationsRequest(request: Request, pathname: string): Promise<Response | null> {
  // read only: installing one changes an agent's own hooks, which stays the user's call in a terminal
  if (pathname === "/api/integrations") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    try {
      return jsonResponse({ integrations: await integrationList() } satisfies IntegrationsResponse);
    } catch (error) {
      return errorResponse(error);
    }
  }
  return null;
}
