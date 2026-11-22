import { useSyncExternalStore } from "react";
import type { PushDeliveryFailure, PushSubscriptionStatus } from "../../shared/protocol.ts";
import { ApiError, fetchPushKey, fetchPushSubscriptionStatus, routeMissing } from "./api.ts";
import { notificationState, type NotificationState } from "./notifications.ts";
import { currentPushOperation, heldPushSubscription, pushSubscriptionEpoch, pushSupported, sameServerKey } from "./push.ts";

/** Adapted from Agent of Empires' `web/src/lib/pushHealth.ts` (MIT; THIRD_PARTY_NOTICES.md), with its repair rule narrowed. */

export type PushProblem = "permission" | "missing" | "gone" | "key-mismatch" | "rejected";

export interface PushHealthInput {
  wanted: boolean;
  supported: boolean;
  permission: NotificationState;
  subscribed: boolean | null;
  keyMatches: boolean | null;
  status: PushSubscriptionStatus | "unknown" | null;
}

export interface PushHealth {
  problem: PushProblem | null;
  repair: boolean;
  transient: PushDeliveryFailure | null;
}

export const QUIET: PushHealth = { problem: null, repair: false, transient: null };

const PERMANENT: ReadonlySet<PushDeliveryFailure> = new Set(["gone", "key-mismatch", "rejected"]);
const permanent = (failure: PushDeliveryFailure): failure is "gone" | "key-mismatch" | "rejected" => PERMANENT.has(failure);

export function failureIsNewer(status: PushSubscriptionStatus): boolean {
  if (status.last_failure === null || status.last_failure_at === null) return false;
  if (status.last_success_at === null) return true;
  const failed = Date.parse(status.last_failure_at);
  const succeeded = Date.parse(status.last_success_at);
  return Number.isFinite(failed) && Number.isFinite(succeeded) && failed > succeeded;
}

export function classifyPushHealth(input: PushHealthInput): PushHealth {
  if (!input.wanted || !input.supported) return QUIET;
  if (input.permission === "denied") return { problem: "permission", repair: false, transient: null };
  if (input.permission !== "granted") return QUIET;
  // a subscription made for another server key can never receive a push from this one
  if (input.keyMatches === false) return { problem: "key-mismatch", repair: true, transient: null };
  if (input.subscribed === false) return { problem: "missing", repair: true, transient: null };
  const status = input.status;
  if (status === null || input.subscribed !== true) return QUIET;
  if (status === "unknown") return { problem: "missing", repair: true, transient: null };
  if (failureIsNewer(status)) {
    const failure = status.last_failure!;
    // the push service refused the server's signature (401/403). With the browser's key proven the server's
    // own above, subscribing anew would make the same subscription, so it is told as a refusal. A key nobody
    // can read (the phone app's, or a browser that does not say) is most likely the old one, after the
    // server's key changed and a registration with the new one failed: subscribing anew replaces a
    // subscription whose key is not proven (lib/push.ts, and the app's plugin on a changed key), so it mends it
    if (failure === "key-mismatch") return input.keyMatches === null ? { problem: "key-mismatch", repair: true, transient: null } : { problem: "rejected", repair: false, transient: null };
    if (permanent(failure)) return { problem: failure, repair: failure === "gone", transient: null };
    return { problem: status.registered ? null : "missing", repair: !status.registered, transient: failure };
  }
  if (!status.registered) return { problem: "missing", repair: true, transient: null };
  return QUIET;
}

export type PushActionResult = "sent" | "unsupported" | "permission" | "missing" | "gone" | "read-only" | "refused" | "no-worker" | "unregistered" | "failed";

const REPAIR_FAILURES: ReadonlySet<PushActionResult> = new Set(["refused", "no-worker", "unregistered"]);

export const repairFailed = (result: PushActionResult | null): boolean => result !== null && REPAIR_FAILURES.has(result);

export interface PushActionOutcome {
  result: PushActionResult;
  endpoint?: string | null;
}

export interface PushHealthState {
  health: PushHealth;
  busy: "test" | "repair" | null;
  result: PushActionResult | null;
  dismissed: PushProblem | null;
  checked: boolean;
  delivered: boolean | null;
}

const DISMISSED_KEY = "ovis:push-notice-dismissed";
const PROBLEMS: readonly PushProblem[] = ["permission", "missing", "gone", "key-mismatch", "rejected"];

function readDismissed(fallback: PushProblem | null = null): PushProblem | null {
  try {
    const value = window.localStorage.getItem(DISMISSED_KEY);
    return PROBLEMS.find((problem) => problem === value) ?? null;
  } catch { return fallback; }
}

function writeDismissed(problem: PushProblem | null): void {
  try {
    if (problem) window.localStorage.setItem(DISMISSED_KEY, problem);
    else window.localStorage.removeItem(DISMISSED_KEY);
  } catch {}
}

let state: PushHealthState = { health: QUIET, busy: null, result: null, dismissed: readDismissed(), checked: false, delivered: null };
const listeners = new Set<() => void>();
let generation = 0;
let actions = 0;
let resultFor: string | null | undefined;

function setState(next: PushHealthState): void {
  state = next;
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.storageArea !== window.localStorage || event.key !== null && event.key !== DISMISSED_KEY) return;
    // Events can be queued behind a newer write: read what stands now, never replay event.newValue.
    const dismissed = readDismissed(state.dismissed);
    if (dismissed !== state.dismissed) setState({ ...state, dismissed });
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const snapshot = (): PushHealthState => state;

export function usePushHealth(): PushHealthState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function readPushHealth(): PushHealthState {
  return state;
}

async function heldEndpoint(): Promise<string | null | undefined> {
  try {
    const subscription = await heldPushSubscription();
    return subscription === undefined ? undefined : subscription?.json.endpoint ?? null;
  } catch {
    return undefined;
  }
}

async function observe(wanted: boolean): Promise<{ input: PushHealthInput; reached: boolean; endpoint: string | null | undefined }> {
  const input: PushHealthInput = { wanted, supported: pushSupported(), permission: notificationState(), subscribed: null, keyMatches: null, status: null };
  if (!input.wanted || !input.supported || input.permission !== "granted") return { input, reached: true, endpoint: undefined };
  let subscription: Awaited<ReturnType<typeof heldPushSubscription>>;
  try {
    subscription = await heldPushSubscription();
  } catch {
    return { input, reached: true, endpoint: undefined };
  }
  if (subscription === undefined) return { input, reached: true, endpoint: undefined };
  input.subscribed = subscription !== null;
  if (!subscription) return { input, reached: true, endpoint: null };
  const endpoint = subscription.json.endpoint ?? null;
  try {
    input.keyMatches = sameServerKey(subscription.key, await fetchPushKey());
    if (input.keyMatches === false) return { input, reached: true, endpoint };
    input.status = (await fetchPushSubscriptionStatus(subscription.json)) ?? "unknown";
  } catch (error) {
    // a server from before the question answers 404 for the route, and the open LAN, which signs in as no
    // device, 403 status_unavailable: nothing to go on, and nothing wrong.
    const answered = routeMissing(error) || error instanceof ApiError && error.code === "status_unavailable";
    return { input, reached: answered, endpoint };
  }
  return { input, reached: true, endpoint };
}

export async function refreshPushHealth(wanted: boolean): Promise<void> {
  const mine = ++generation;
  let subject: number;
  do {
    subject = pushSubscriptionEpoch();
    await currentPushOperation();
    if (mine !== generation) return;
  } while (subject !== pushSubscriptionEpoch());
  const { input, reached, endpoint } = await observe(wanted);
  if (mine !== generation) return;
  if (subject !== pushSubscriptionEpoch()) return refreshPushHealth(wanted);
  if (input.subscribed === true) {
    const now = await heldEndpoint();
    if (mine !== generation) return;
    if (now !== undefined && now !== endpoint) return refreshPushHealth(wanted);
  }
  if (!reached) return;
  let health = classifyPushHealth(input);
  const working = health.problem === null && input.status !== null && typeof input.status === "object";
  const keepFailure = repairFailed(state.result) && input.wanted && input.supported && input.permission === "granted"
    && !working && (health.problem === null || health.repair && (state.health.problem === null || health.problem === state.health.problem));
  if (keepFailure && health.problem === null) health = state.health;
  let result = (repairFailed(state.result) ? keepFailure : health.problem === null) ? state.result : null;
  if (result !== null && !repairFailed(result) && endpoint !== undefined) {
    if (resultFor === undefined) resultFor = endpoint;
    else if (resultFor !== endpoint) result = null;
  }
  // Read the origin's current value even if this tab has not received its storage event yet.
  const stored = readDismissed(state.dismissed);
  const dismissed = keptDismissal(stored, health, input);
  if (dismissed !== stored) writeDismissed(dismissed);
  const delivered = typeof input.status === "object" && input.status !== null ? input.status.last_success_at !== null : null;
  setState({ ...state, health, result, dismissed, checked: true, delivered });
}

function keptDismissal(dismissed: PushProblem | null, health: PushHealth, input: PushHealthInput): PushProblem | null {
  if (dismissed === null) return null;
  if (!input.wanted) return null;
  if (health.problem !== null) return health.problem === dismissed ? dismissed : null;
  return typeof input.status === "object" && input.status !== null ? null : dismissed;
}

export function dismissPushNotice(): void {
  const problem = state.health.problem;
  if (problem === null) return;
  writeDismissed(problem);
  setState({ ...state, dismissed: problem });
}

export function resetPushHealth(): void {
  generation += 1;
  actions += 1;
  resultFor = undefined;
  writeDismissed(null);
  setState({ health: QUIET, busy: null, result: null, dismissed: null, checked: false, delivered: null });
}

export async function runPushAction(kind: "test" | "repair", action: () => Promise<PushActionResult | PushActionOutcome>, wanted: () => boolean): Promise<void> {
  if (state.busy !== null) return;
  const mine = ++actions;
  setState({ ...state, busy: kind, result: null });
  let result: PushActionResult = "failed";
  let about: string | null | undefined;
  try {
    const outcome = await action();
    result = typeof outcome === "string" ? outcome : outcome.result;
    about = typeof outcome === "string" ? undefined : outcome.endpoint;
  } finally {
    if (mine === actions) {
      resultFor = about;
      setState({ ...state, busy: null, result });
    }
  }
  if (mine === actions) await refreshPushHealth(wanted());
}
