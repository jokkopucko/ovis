import type { PcUpdateOffer } from "../shared/machines.ts";
import { REVISION, type UpdateStatus, INSTALL_ID } from "../shared/update.ts";
import { discard, readCappedJson, REMOTE_LIMITS } from "./remote-json.ts";


export const OWN_UPDATE_LIMIT_MS = 15 * 60_000;
const STEPS: Record<string, string> = { download: "downloading", dependencies: "installing dependencies", typecheck: "type-checking", build: "building", restart: "restarting" };
const BRIDGE_ANSWER_MS = 15_000;
const CHANGED = "That PC offers another release now than the one shown. Look at it again, then update.";

type Endpoint = { url: string; token: string };
export const releaseVersion = (value: unknown): string | null => typeof value === "string" && /^\d{1,6}\.\d{1,6}\.\d{1,6}(-beta\.\d{1,6})?$/.test(value) ? value : null;
const words = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value.trim().replace(/\s+/g, " ").slice(0, 300) : null;
const installing = (status: Partial<UpdateStatus> | null): boolean => status?.phase === "building" || status?.phase === "restarting";

export function offerFromStatus(status: unknown): PcUpdateOffer | null {
  if (status === null || typeof status !== "object") return null;
  const told = status as Partial<UpdateStatus>;
  if (told.available !== true || typeof told.latest_revision !== "string" || !REVISION.test(told.latest_revision)) return null;
  const offer = (reason: string | null): PcUpdateOffer => ({ how: "own", current_version: releaseVersion(told.current_version), latest_version: releaseVersion(told.latest_version), updatable: reason === null, reason });
  if (told.managed !== true) return offer(`That PC's Ovis does not update itself: ${words(told.blocked_reason) ?? "it was not started by its updater."}`);
  const blocked = words(told.blocked_reason);
  if (blocked) return offer(`That PC's Ovis cannot update itself now: ${blocked}`);
  if (told.revision_bound_install !== true) return offer("That PC's Ovis is too old to take an update asked for from another PC.");
  return offer(null);
}

/** Its update status through its connection, or null when it does not answer readably. Redirects are never followed. */
export async function readOwnStatus(endpoint: Endpoint, signal?: AbortSignal): Promise<Partial<UpdateStatus> | null> {
  const response = await fetch(`${endpoint.url}/api/updates`, { headers: { authorization: `Bearer ${endpoint.token}` }, redirect: "manual",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(BRIDGE_ANSWER_MS)]) : AbortSignal.timeout(BRIDGE_ANSWER_MS) });
  if (!response.ok) { await discard(response); return null; }
  return await readCappedJson<Partial<UpdateStatus> | null>(response, REMOTE_LIMITS.ownUpdates);
}

export interface OwnUpdateOptions {
  endpoint(): Endpoint | undefined;
  refused?(): string | null;
  /** the release the person was shown (its latest_revision): another one on offer now is refused, not installed */
  revision?: string;
  signal: AbortSignal;
  /** whether the abort was a cancel asked for here (never this server stopping): only then is that PC asked to stop */
  cancelled?(): boolean;
  onStep(step: string): void;
  pollMs?: number;
  startMs?: number;
  checkMs?: number;
}

/** Never followed out of the tunnel, and bounded in time. */
export async function cancelOwnUpdate(endpoint: Endpoint | undefined, last: Partial<UpdateStatus> | null, installId: string | null, confirmMs = 10_000): Promise<"stopped" | "continues" | "none"> {
  // only the install this app asked for, by the id its 202 gave: without it (its answer cut off, an older Ovis) nothing is asked
  if (!endpoint || last?.install_cancellable !== true || !installId) return "continues";
  try {
    const response = await fetch(`${endpoint.url}/api/updates/cancel`, { method: "POST", redirect: "manual", body: JSON.stringify({ install_id: installId }),
      headers: { authorization: `Bearer ${endpoint.token}`, "x-herdr-update": "1", "content-type": "application/json" }, signal: AbortSignal.timeout(BRIDGE_ANSWER_MS) });
    await discard(response);
    if (response.status !== 202) return "continues";
    for (const until = Date.now() + confirmMs; Date.now() < until;) {
      const status = await readOwnStatus(endpoint, AbortSignal.timeout(BRIDGE_ANSWER_MS)).catch(() => null);
      if (status?.error_code === "update_cancelled") return "stopped";
      if (status && !installing(status)) return "continues";
      await Bun.sleep(250);
    }
    return "continues";
  } catch { return "continues"; }
}
export async function installIdOf(response: Response): Promise<string | null> {
  const body = await readCappedJson<{ install_id?: unknown } | null>(response, REMOTE_LIMITS.bridgeError).catch(() => null);
  return typeof body?.install_id === "string" && INSTALL_ID.test(body.install_id) ? body.install_id : null;
}
export class OwnUpdateCancelled extends Error {
  constructor(readonly there: "stopped" | "continues" | "none") { super(cancelledWords(there)); }
}
export const cancelledWords = (there: "stopped" | "continues" | "none"): string => there === "stopped"
  ? "Update cancelled: that PC's own Ovis stopped it before it was installed."
  : there === "continues" ? "Update cancelled here, but that PC's own Ovis may still finish it there (it had started, and did not confirm it stopped): look at its Settings → Updates." : "Update cancelled";

export async function followOwnUpdate(options: OwnUpdateOptions): Promise<void> {
  const state = { last: null as Partial<UpdateStatus> | null, asked: false, installId: null as string | null };
  try { await followOwn(options, state); }
  catch (error) {
    if (options.signal.aborted && state.asked && options.cancelled?.() === true) throw new OwnUpdateCancelled(await cancelOwnUpdate(options.endpoint(), state.last, state.installId));
    throw error;
  }
}
async function followOwn(options: OwnUpdateOptions, state: { last: Partial<UpdateStatus> | null; asked: boolean; installId: string | null }): Promise<void> {
  const { signal } = options;
  const pollMs = options.pollMs ?? 2000, startMs = options.startMs ?? 60_000, checkMs = options.checkMs ?? 30_000;
  const pause = () => new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, pollMs);
    signal.addEventListener("abort", done, { once: true });
  });
  const cancelled = () => { if (signal.aborted) throw new Error("Update cancelled"); };
  const read = async (): Promise<Partial<UpdateStatus> | null> => {
    const endpoint = options.endpoint();
    if (!endpoint) return null;
    try { const status = await readOwnStatus(endpoint, signal); if (status) state.last = status; return status; } catch { cancelled(); return null; }
  };
  const settled = async (): Promise<Partial<UpdateStatus>> => {
    let status = await read();
    for (const until = Date.now() + checkMs; status?.phase === "checking" && Date.now() < until;) { await pause(); cancelled(); status = await read(); }
    if (!options.endpoint()) throw new Error("This PC is not connected; update it once it is back.");
    if (!status) throw new Error("That PC's Ovis did not tell its update status. Try again in a moment.");
    if (status.phase === "checking") throw new Error("That PC's Ovis is still checking for updates. Try again in a moment.");
    return status;
  };
  let before = await settled();
  const earlierError = before.phase === "error" ? words(before.error) : null;
  let started = installing(before);
  const offer = offerFromStatus(before);
  const revision = options.revision ?? before.latest_revision;
  // an install already running there of another release than the one shown is not this update's to follow
  const foreign = () => started && typeof before.latest_revision === "string" && before.latest_revision !== revision;
  if (foreign()) throw new Error(CHANGED);
  for (let attempt = 1; !started; attempt++) {
    const now = offerFromStatus(before);
    if (!now || typeof before.latest_revision !== "string") throw new Error("That PC's Ovis has no update on offer any more.");
    if (before.latest_revision !== revision) throw new Error(CHANGED);
    if (!now.updatable) throw new Error(now.reason ?? "That PC's Ovis cannot take this update.");
    const endpoint = options.endpoint();
    if (!endpoint) throw new Error("This PC is not connected; update it once it is back.");
    cancelled();
    let response: Response;
    try { response = await fetch(`${endpoint.url}/api/updates/install`, { method: "POST", redirect: "manual", body: JSON.stringify({ expected_revision: revision }),
      headers: { authorization: `Bearer ${endpoint.token}`, "x-herdr-update": "1", "content-type": "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(BRIDGE_ANSWER_MS)]) }); } catch (error) { if (signal.aborted) state.asked = true; throw error; }
    if (response.status === 202) { state.asked = true; state.installId = await installIdOf(response); break; }
    const refusal = (await readCappedJson<{ error?: { code?: unknown; message?: unknown } } | null>(response, REMOTE_LIMITS.bridgeError).catch(() => null))?.error;
    if (refusal?.code === "update_offer_changed") throw new Error(CHANGED);
    if (refusal?.code !== "update_busy" || attempt >= 3) throw new Error(`That PC's Ovis refused to update: ${words(refusal?.message) ?? `it answered ${response.status}`}`);
    before = await settled();
    started = installing(before);
    if (foreign()) throw new Error(CHANGED);
  }
  const to = offer?.latest_version ? ` to v${offer.latest_version}` : "";
  const deadline = Date.now() + OWN_UPDATE_LIMIT_MS, startBy = Date.now() + startMs;
  for (;;) {
    cancelled();
    if (Date.now() >= deadline) throw new Error(`That PC's Ovis did not come back on its new version within ${OWN_UPDATE_LIMIT_MS / 60_000} minutes. Check its Settings → Updates there.`);
    const refused = options.refused?.() ?? null;
    if (refused) throw new Error(refused);
    const status = await read();
    if (status === null) {
      if (!options.endpoint()) { started = true; options.onStep(`This PC's own Ovis is restarting${to}…`); }
    } else {
      if (typeof revision === "string" && status.current_revision === revision && !installing(status)) return;
      if (installing(status)) {
        started = true;
        options.onStep(`This PC's own Ovis is updating itself${to}: ${STEPS[status.step ?? ""] ?? status.phase}…`);
      }
      if (status.phase === "error" && (started || words(status.error) !== earlierError)) throw new Error(`That PC's Ovis could not update itself: ${words(status.error) ?? "no reason given."}`);
      if (!started && Date.now() >= startBy) throw new Error(`That PC's Ovis did not start its update within ${Math.max(1, Math.round(startMs / 1000))} seconds of being asked. Check its Settings → Updates there.`);
    }
    await pause();
  }
}
