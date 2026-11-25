import { jsonResponse, readJsonObject, setRequestRoute } from "../http.ts";
import { agentToolHub } from "./launch.ts";
import { paneFeed } from "./pane-grants.ts";

const ID = /^[a-f0-9]{16}$/;
const fail = (code: string, message: string, status: number) => jsonResponse({ error: { code, message } }, status);

/**
 * The owner's cards for panes hc started that asked for the agent tool, and Settings' list of the panes he allowed
 * (docs/harness-tool.md). This PC's owner alone (`owner`: access.ts ownerAccess, never a watching device): nobody else
 * learns which panes asked.
 */
export async function handleAgentPanesRequest(request: Request, pathname: string, owner: boolean): Promise<Response> {
  setRequestRoute(pathname);
  if (!owner) return fail("forbidden", "Only this PC's owner answers for its panes.", 403);
  const hub = agentToolHub();
  if (pathname === "/api/agent-tools/panes" && request.method === "GET") {
    await hub?.reconcilePanes().catch(() => undefined);
    return jsonResponse(paneFeed.view(), 200, { "cache-control": "no-store" });
  }
  if (request.method !== "POST" || (pathname !== "/api/agent-tools/panes/answer" && pathname !== "/api/agent-tools/panes/remove")) return fail("not_found", "Unknown agent tool route.", 404);
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const id = typeof body.id === "string" && ID.test(body.id) ? body.id : null;
  if (pathname.endsWith("/answer")) {
    if (!id || (body.decision !== "allow" && body.decision !== "deny")) return fail("invalid_pane_answer", "Send the card's id and a decision of allow or deny.", 400);
    const outcome = hub ? await hub.answerPane(id, body.decision === "allow") : "gone";
    return outcome === "ok" ? jsonResponse({ ok: true }) : fail("pane_card_gone", "This pane closed or was already answered.", 409);
  }
  if (!id) return fail("invalid_pane", "Send the allowed pane's id.", 400);
  return hub?.grants.remove(id) ? jsonResponse({ ok: true }) : fail("pane_gone", "This pane is no longer allowed.", 409);
}
