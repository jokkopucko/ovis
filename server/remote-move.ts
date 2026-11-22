import type { Machine, MoveAllResponse, PcMoveOffer, PcMoveStatus } from "../shared/machines.ts";
import type { MoveUnavailable } from "../shared/runtime-move.ts";
import { isJsonObject } from "./http.ts";
import type { MachineManager } from "./machines.ts";
import { discard, parseJson, readCapped, REMOTE_LIMITS } from "./remote-json.ts";

export const PC_MOVE_PATH = /^runtime\/move(?:\/(?:stop|stop-all|install))?$/;
export const PC_UPDATE_REQUIRED = "Update Ovis on that PC first, then move it.";
const MOVE_UNKNOWN = "That PC did not answer in time; it may have started. Look at its move status before trying again.";

export function answerCode(body: Uint8Array | null): string | null {
  if (!body || body.byteLength === 0) return null;
  try {
    const answer = parseJson<{ error?: { code?: unknown } }>(body);
    return typeof answer.error?.code === "string" ? answer.error.code : null;
  } catch { return null; }
}

/**
 * Whether a PC's answer to a move route says its Ovis predates moves from another PC: it knows no such
 * route (`not_found`, its answer to every unknown one; a herdr error on a known route is a 404 too), or,
 * over SSH, it does not take the bridge token there. A relay PC's 401 or 403 is that PC refusing this
 * server's device, which an update would not change.
 */
export function tooOldToMove(kind: Machine["kind"] | undefined, status: number, code: string | null): boolean {
  return status === 404 ? code === "not_found" : kind === "ssh" && (status === 401 || status === 403);
}

const MOVE_STEPS = new Set(["ending_agents", "building", "starting_agents", "switching"]);
/** the reasons this version knows (shared/runtime-move.ts MoveUnavailable): any other words of that PC are not carried */
const MOVE_REASONS = new Set<string>(["not_herdr", "no_herdr_core", "runtime_locked", "herdr_app"] satisfies MoveUnavailable[]);
/** What of a PC's move status the roster carries (PcMoveStatus): no reason or agent's words, which name folders. */
function moveSummary(status: Record<string, unknown>): PcMoveStatus | null {
  const { state } = status;
  if (state === "idle" || state === "waiting" || state === "done") return { state };
  if (state === "moving") {
    const { step, done, total } = status;
    if (typeof step !== "string" || !MOVE_STEPS.has(step) || typeof done !== "number" || typeof total !== "number") return null;
    return { state, step: step as Extract<PcMoveStatus, { state: "moving" }>["step"], done, total };
  }
  if (state === "rolled_back" || state === "interrupted") return { state, left: Array.isArray(status.left) ? status.left.length : 0 };
  return null;
}

/**
 * A PC's move badge from its own plan answer: null when it cannot tell (an Ovis without the route, one
 * that does not take this server's credential there, or one with no runtime to switch), undefined when it
 * did not answer now (herdr away, a timeout), so the badge it had stays.
 */
export async function readMoveOffer(endpoint: { url: string; token: string }): Promise<PcMoveOffer | null | undefined> {
  const response = await fetch(`${endpoint.url}/api/runtime/move`, { headers: { authorization: `Bearer ${endpoint.token}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    const code = answerCode(await readCapped(response, REMOTE_LIMITS.bridgeError).catch(() => null));
    const cannotTell = response.status === 401 || response.status === 403 || response.status === 404 && code === "not_found" || response.status === 409 && code === "runtime_locked";
    return cannotTell ? null : undefined;
  }
  const answer = parseJson<{ available?: unknown; reason?: unknown; install?: unknown; status?: unknown }>(await readCapped(response, REMOTE_LIMITS.proxy));
  if (!isJsonObject(answer) || !isJsonObject(answer.status)) return null;
  const status = moveSummary(answer.status);
  const reason = answer.available === true ? null : answer.reason;
  if (status === null || reason !== null && (typeof reason !== "string" || !MOVE_REASONS.has(reason))) return null;
  return { serving: reason === "not_herdr" ? "herdr-core" : "herdr", offered: answer.available === true || answer.install !== undefined, reason: reason as MoveUnavailable | null, status };
}

type StartOutcome = { outcome: "started" } | { outcome: "refused"; code: string; message: string } | { outcome: "unknown"; message: string };

async function startMove(manager: MachineManager, id: string, revision: string): Promise<StartOutcome> {
  const machine = manager.list().find((entry) => entry.id === id);
  if (!machine) return { outcome: "refused", code: "machine_not_found", message: "This PC is not in the list." };
  if (machine.kind === "local") return { outcome: "refused", code: "move_unavailable", message: "Move this PC from Settings > About." };
  if (machine.kind === "hc") return { outcome: "refused", code: "move_unavailable", message: "This PC is a machine of herdr-core: it has no herdr session to move." };
  const endpoint = manager.endpoint(id);
  if (!endpoint) return { outcome: "refused", code: "machine_offline", message: "This PC is disconnected." };
  let response: Response;
  try {
    response = await fetch(`${endpoint.url}/api/runtime/move`, {
      method: "POST", body: JSON.stringify({ revision }), redirect: "error", signal: AbortSignal.timeout(75_000),
      headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json", "x-herdr-update": "1" },
    });
  } catch {
    // the start may have reached that PC before its answer was lost: not a refusal
    return { outcome: "unknown", message: MOVE_UNKNOWN };
  }
  if (response.status === 202) { await discard(response); manager.moveOfferSoon(id); return { outcome: "started" }; }
  // a gateway between here and that PC (the relay, a tunnel) may lose the answer after the PC took the start
  if (response.status === 502 || response.status === 504) { await discard(response); manager.moveOfferSoon(id); return { outcome: "unknown", message: MOVE_UNKNOWN }; }
  const body = await readCapped(response, REMOTE_LIMITS.bridgeError).catch(() => null);
  const code = answerCode(body);
  if (tooOldToMove(machine.kind, response.status, code)) return { outcome: "refused", code: "pc_update_required", message: PC_UPDATE_REQUIRED };
  let message: unknown;
  try { message = body ? parseJson<{ error?: { message?: unknown } }>(body).error?.message : undefined; } catch { message = undefined; }
  return {
    outcome: "refused",
    code: code?.slice(0, 64) ?? "move_failed",
    message: typeof message === "string" ? message.slice(0, 300) : `That PC answered ${response.status}.`,
  };
}

export async function moveAll(manager: MachineManager, plans: { machine_id: string; revision: string }[]): Promise<MoveAllResponse> {
  const answers = await Promise.all(plans.map(async ({ machine_id, revision }) => ({ machine_id, ...await startMove(manager, machine_id, revision) })));
  const answer: MoveAllResponse = { started: [], refused: [], unknown: [] };
  for (const entry of answers) {
    if (entry.outcome === "started") answer.started.push(entry.machine_id);
    else if (entry.outcome === "refused") answer.refused.push({ machine_id: entry.machine_id, code: entry.code, message: entry.message });
    else answer.unknown.push({ machine_id: entry.machine_id, message: entry.message });
  }
  return answer;
}

export function moveAllPlans(body: unknown, most: number): { machine_id: string; revision: string }[] | null {
  if (!isJsonObject(body) || !Array.isArray(body.plans) || body.plans.length > most) return null;
  const plans: { machine_id: string; revision: string }[] = [];
  for (const plan of body.plans) {
    if (!isJsonObject(plan) || typeof plan.machine_id !== "string" || plan.machine_id === "" || typeof plan.revision !== "string" || plan.revision === "") return null;
    if (plans.some((seen) => seen.machine_id === plan.machine_id)) return null;
    plans.push({ machine_id: plan.machine_id, revision: plan.revision });
  }
  return plans;
}
