import type { AgentCatalogEntry, AgentCatalogRow } from "../../shared/agent-catalog.ts";
import type { SecuritySummary } from "../../shared/access.ts";
import type { HealthAuth, PairedDevice, RelayStatus } from "../../shared/protocol.ts";
import type { SetupStep } from "./agentSetup.ts";
import type { ProviderUsage } from "../../shared/usage.ts";
import { isSignIn } from "./usage.ts";
import type { NotificationState } from "./notifications.ts";
import type { PushHealth } from "./pushHealth.ts";

export interface GuideState {
  step: "welcome" | "setup";
  reopened?: true;
  at?: "theme" | "phone";
}

export type GuideEvent = { type: "moved" };

export const FIRST_RUN: GuideState = { step: "setup" };
export const REOPENED: GuideState = { step: "setup", reopened: true };

export function guideStep(state: GuideState, event: GuideEvent): GuideState {
  return event.type === "moved" && state.at !== undefined ? REOPENED : state;
}

/** Plan usage turns on by itself for a signed-in account on a first run only: a reopened guide leaves the user's choice alone. */
export function turnsUsageOn(state: GuideState): boolean {
  return state.reopened !== true;
}

export interface PcCheck {
  checking: boolean;
  catalog: readonly AgentCatalogRow[] | null;
  failed: boolean;
}

export const CHECK_SETTLE_MS = 300;

export function settleDelay(startedAt: number, answeredAt: number): number {
  return Math.max(0, CHECK_SETTLE_MS - (answeredAt - startedAt));
}

export function foundAgents(catalog: readonly AgentCatalogRow[]): AgentCatalogRow[] {
  return catalog.filter((row) => row.kind === "harness" && row.state.installed === true);
}

export function setupView(check: PcCheck): "checking" | "agents" | "failed" {
  if (check.failed) return "failed";
  if (check.checking || check.catalog === null) return "checking";
  return "agents";
}

export function installedHere(row: AgentCatalogRow, ready: readonly string[]): boolean {
  return row.state.installed === true || ready.includes(row.id);
}

const FIRST = ["claude", "codex"];

export function agentRows(catalog: readonly AgentCatalogRow[] | null, ready: readonly string[]): AgentCatalogRow[] {
  const harness = (catalog ?? []).filter((row) => row.kind === "harness");
  const first = FIRST.flatMap((id) => harness.filter((row) => row.id === id));
  const rest = harness.filter((row) => !FIRST.includes(row.id));
  return [...first, ...rest.filter((row) => installedHere(row, ready)), ...rest.filter((row) => !installedHere(row, ready))];
}

/**
 * Which way the guide's Connect your phone box leads with: the Ovis relay where it is offered here (a
 * server with the route, a direct page, not the hosted shell), this browser may control it (not a
 * watching device, not a Portal visitor: the server refuses both) and nothing blocks it (a serve-only
 * install, an unreadable identity); else the other ways (phoneBoxMode). It waits for the relay's first
 * answer, so a page on the PC's loopback is not sent to Settings before the relay could lead.
 */
export function phoneWay(relay: { unsupported: boolean; status: Pick<RelayStatus, "blocked"> | null }, shell: boolean, auth: HealthAuth | null): "wait" | "relay" | "other" {
  if (shell || relay.unsupported) return "other";
  if (auth === null) return "wait";
  if (auth.role === "watch" || auth.via === "portal") return "other";
  if (relay.status === null) return "wait";
  return relay.status.blocked === null ? "relay" : "other";
}

/** Device table T70: other devices reach this PC only through the relay when it is bound to its loopback and this page came in on it directly; any other or unnamed ingress may be a route of its own (SSH this setup cannot see). */
export function relayOnlyPc(summary: Pick<SecuritySummary, "bind_scope" | "observed_ingress">): boolean {
  return summary.bind_scope === "loopback" && summary.observed_ingress === "direct";
}

export type PhoneBoxOpening = "tap" | "first-run";

export function phoneBoxOpensFirst(state: GuideState, onThisPc: boolean): boolean {
  return state.reopened !== true && onThisPc;
}

/**
 * Whether the box stays open: one that came open by itself leads with the relay only, so where the
 * relay cannot lead it closes again rather than sending the page to Settings → Phone untapped.
 */
export function phoneBoxStays(opening: PhoneBoxOpening, way: "wait" | "relay" | "other", led: boolean): boolean {
  return opening === "tap" || led || way !== "other";
}

export function relayStep(status: Pick<RelayStatus, "phase" | "error">): "off" | "not-started" | "starting" | "online" {
  if (status.phase === "online") return "online";
  if (status.phase === "off") return status.error === null ? "off" : "not-started";
  return "starting";
}

/**
 * What the guide's Connect your phone box does: wait until the address a phone can open and this
 * browser's access are known; leave it to Settings → Phone where there is no such address (the PC's
 * loopback) or the server does not say how this browser got in; pair this browser first where it is
 * in only because nothing is paired yet (a paired phone turns sign-in on); else show the QR.
 */
export function phoneBoxMode(address: string | null | undefined, auth: HealthAuth | null): "wait" | "settings" | "pair-self" | "qr" {
  if (address === undefined || auth === null) return "wait";
  if (address === null || auth.via === undefined) return "settings";
  return auth.via === "open" ? "pair-self" : "qr";
}

export const INSTALL_GIVE_UP_MS = 10 * 60_000;

export type TileState = "installed" | "installing" | "stuck" | "failed" | "missing";

export function tileState(has: boolean, step: SetupStep, pending: boolean, runningMs: number): TileState {
  if (has || step.kind === "installed" || step.kind === "ready" || step.kind === "signing-in") return "installed";
  if (pending || step.kind === "installing") return runningMs >= INSTALL_GIVE_UP_MS ? "stuck" : "installing";
  if (step.kind === "failed") return "failed";
  return "missing";
}

export function preferredAgent(agents: readonly AgentCatalogRow[], ready: string | null): AgentCatalogRow | null {
  for (const id of [ready, ...FIRST]) {
    const agent = agents.find((candidate) => candidate.id === id);
    if (agent !== undefined) return agent;
  }
  return agents[0] ?? null;
}

export async function openInFolder<T>(open: (directory: string) => Promise<T>, folder: string, home: string, gone: (reason: unknown) => boolean): Promise<T> {
  try {
    return await open(folder);
  } catch (reason: unknown) {
    if (folder !== home && gone(reason)) return open(home);
    throw reason;
  }
}

const USAGE_TRIES = 3;
const USAGE_RETRY_MS = 2000;

export function readSignedIn<T>(read: () => Promise<T>, found: (answer: T) => void, schedule: (run: () => void, ms: number) => () => void): () => void {
  let live = true;
  let cancelRetry = (): void => {};
  const attempt = (left: number): void => {
    if (!live) return;
    read().then((answer) => { if (live) found(answer); }, () => {
      if (live && left > 1) cancelRetry = schedule(() => attempt(left - 1), USAGE_RETRY_MS);
    });
  };
  attempt(USAGE_TRIES);
  return () => { live = false; cancelRetry(); };
}

/**
 * The agents this PC is signed in to, from its plan usage: one whose sign-in expired is not counted, nor an account
 * known only from another tool's record of it, which is that tool's sign-in and not the agent's.
 */
export function signedInAgents(providers: readonly ProviderUsage[]): string[] {
  return [...new Set(providers.filter((usage) => usage.problem !== "expired" && isSignIn(usage)).map((usage) => usage.id))];
}

export type CheckStatus = { kind: "looking" } | { kind: "installed"; version: string | null } | { kind: "missing" } | { kind: "unknown" };

export function checkStatus(row: AgentCatalogRow | undefined): CheckStatus {
  if (row === undefined) return { kind: "looking" };
  if (row.state.installed === true) return { kind: "installed", version: row.state.version };
  return row.state.installed === false ? { kind: "missing" } : { kind: "unknown" };
}

export function checkList(known: readonly Pick<AgentCatalogEntry, "id" | "name" | "kind">[], answer: readonly AgentCatalogRow[] | null): { id: string; name: string; status: CheckStatus }[] {
  if (answer === null) return known.filter((entry) => entry.kind === "harness").map(({ id, name }) => ({ id, name, status: checkStatus(undefined) }));
  return answer.filter((row) => row.kind === "harness").map((row) => ({ id: row.id, name: row.name, status: checkStatus(row) }));
}

export interface FreshFacts {
  workspaces: number | null;
  savedSettings: boolean;
  sharedRevision: number | null;
  pairingGate: "open" | "closed" | "unavailable" | null;
  /** a watching device sets nothing up */
  watching: boolean;
}

export function autoOpen(facts: FreshFacts): boolean {
  if (facts.workspaces === null || facts.sharedRevision === null || facts.watching) return false;
  return facts.workspaces === 0 && !facts.savedSettings && facts.sharedRevision === 0 && facts.pairingGate !== "closed";
}

export const GUIDE_STORAGE_KEY = "ovis:setup-guide";

export type GuideRecord = { status: "open"; state: GuideState } | { status: "closed" };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function readState(value: unknown): GuideState | null {
  if (!isObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 2 && value["step"] === "setup" && value["reopened"] === true) return REOPENED;
  if (keys.length === 3 && value["step"] === "setup" && value["reopened"] === true && (value["at"] === "theme" || value["at"] === "phone")) return { ...REOPENED, at: value["at"] };
  if (keys.length !== 1) return null;
  return value["step"] === "welcome" || value["step"] === "setup" ? FIRST_RUN : null;
}

export function readGuide(storage: Pick<Storage, "getItem">): GuideRecord | null {
  let raw: string | null;
  try { raw = storage.getItem(GUIDE_STORAGE_KEY); } catch { return null; }
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (isObject(value) && value["status"] === "open") {
      const state = readState(value["state"]);
      if (state !== null) return { status: "open", state };
    }
  } catch { /* damaged: closed */ }
  return { status: "closed" };
}

export function saveGuide(storage: Pick<Storage, "setItem">, state: GuideState | null): string | null {
  const record = JSON.stringify(state === null ? { status: "closed" } : { status: "open", state });
  try {
    storage.setItem(GUIDE_STORAGE_KEY, record);
    return record;
  } catch { return null; /* private mode: the guide lasts for the page */ }
}

export function otherDevice(devices: readonly PairedDevice[]): string | null {
  return devices.find((device) => !device.current)?.label ?? null;
}

export interface SetupFacts {
  workspace: boolean;
  phone: boolean;
  /** this browser's alerts are on and the browser allows them, or the page can have none (plain http): nothing to set */
  alerts: boolean;
}

export interface SetupLeft {
  done: number;
  total: number;
  at: "agent" | "phone" | null;
}

export function setupLeft(facts: SetupFacts): SetupLeft {
  const parts = [facts.workspace, true, facts.phone, facts.alerts];
  return { done: parts.filter(Boolean).length, total: parts.length, at: !facts.workspace ? "agent" : !facts.phone || !facts.alerts ? "phone" : null };
}

/**
 * Whether Turn on alerts left this device without alerts: anything but a confirmed push, except in the desktop app,
 * where only a refused permission does (its own notifications need no push subscription).
 */
export function alertsFailed(result: string, desktop: boolean): boolean {
  if (result === "sent") return false;
  return desktop ? result === "permission" : true;
}

export type AlertsHere = "on" | "off" | "checking" | "unavailable";

export interface AlertsFacts {
  alertsOn: boolean;
  notifications: NotificationState;
  /** the desktop app: its own notifications need no push */
  desktop: boolean;
  pushSupported: boolean;
  pushOn: boolean;
  push: { checked: boolean; problem: PushHealth["problem"]; delivered: boolean | null };
  confirmed: boolean | null;
}

export function alertsHere({ alertsOn, notifications, desktop, pushSupported, pushOn, push, confirmed }: AlertsFacts): AlertsHere {
  // no Notification API (plain http): nothing to turn on here, whatever the switch says
  if (!desktop && notifications === "unsupported") return "unavailable";
  if (!alertsOn) return "off";
  if (desktop) return notifications === "granted" ? "on" : "off";
  if (notifications !== "granted" || !pushSupported) return "off";
  if (!push.checked) return "checking";
  if (push.problem !== null) return "off";
  if (push.delivered === null) return pushOn && confirmed !== false ? "on" : "off";
  return push.delivered ? "on" : "off";
}

export function alertsSurfaces(alerts: AlertsHere): { step: "send-test" | "turn-on" | "checking" | "note"; done: "done" | "not-yet" | "checking" | "unavailable"; row: "done" | "left" | "wait" } {
  if (alerts === "on") return { step: "send-test", done: "done", row: "done" };
  if (alerts === "checking") return { step: "checking", done: "checking", row: "wait" };
  // nothing can be set up here (plain http): the row does not count it as left
  if (alerts === "unavailable") return { step: "note", done: "unavailable", row: "done" };
  return { step: "turn-on", done: "not-yet", row: "left" };
}
