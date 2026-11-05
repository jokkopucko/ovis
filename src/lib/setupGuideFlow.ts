/**
 * Where the first-run setup guide stands (components/SetupGuide.tsx): the welcome, then one setup
 * screen that checks the PC for coding agents and either starts the first workspace with one it found
 * or installs one, with Connect your phone beside Start: the Ovis relay's QR code first where the relay
 * can lead (phoneWay), else the page's own address or Settings → Phone (phoneBoxMode). It opens by
 * itself only on a fresh install, and once: the record in this browser says it was closed, or that it
 * was left open.
 */
import type { AgentCatalogEntry, AgentCatalogRow } from "../../shared/agent-catalog.ts";
import type { HealthAuth, RelayStatus } from "../../shared/protocol.ts";
import type { SetupStep } from "./agentSetup.ts";
import type { ProviderUsage } from "../../shared/usage.ts";

export interface GuideState {
  step: "welcome" | "setup";
  /** opened again from Settings: it changes no setting by itself (turnsUsageOn) */
  reopened?: true;
}

/** I'm new to Ovis */
export type GuideEvent = { type: "begin" };

export const WELCOME: GuideState = { step: "welcome" };
/** Settings → Agents' Open setup guide opens the setup screen itself */
export const REOPENED: GuideState = { step: "setup", reopened: true };

export function guideStep(state: GuideState, event: GuideEvent): GuideState {
  return event.type === "begin" && state.step === "welcome" ? { step: "setup" } : state;
}

/** Plan usage turns on by itself for a signed-in account on a first run only: a reopened guide leaves the user's choice alone. */
export function turnsUsageOn(state: GuideState): boolean {
  return state.reopened !== true;
}

/** The setup screen's look at the PC: GET /api/agent-catalog, as far as it got. */
export interface PcCheck {
  /** a check in flight, or its answer still settling on screen */
  checking: boolean;
  /** the last answer */
  catalog: readonly AgentCatalogRow[] | null;
  /** the last check failed */
  failed: boolean;
}

/** how long the check is on screen at least, so an instant answer is still seen */
export const CHECK_SETTLE_MS = 300;

/** How long an answer stays before the step moves on: what is left of CHECK_SETTLE_MS since the check began. */
export function settleDelay(startedAt: number, answeredAt: number): number {
  return Math.max(0, CHECK_SETTLE_MS - (answeredAt - startedAt));
}

/** The coding agents the PC surely has, in the catalog's order. */
export function foundAgents(catalog: readonly AgentCatalogRow[]): AgentCatalogRow[] {
  return catalog.filter((row) => row.kind === "harness" && row.state.installed === true);
}

/** What the setup screen shows: the check while it runs, then the one list of agents; or that it failed. */
export function setupView(check: PcCheck): "checking" | "agents" | "failed" {
  if (check.failed) return "failed";
  if (check.checking || check.catalog === null) return "checking";
  return "agents";
}

/** Whether the PC has this agent: it said so, or it was installed from the setup screen since (`ready`). */
export function installedHere(row: AgentCatalogRow, ready: readonly string[]): boolean {
  return row.state.installed === true || ready.includes(row.id);
}

/** the agents listed first, and picked first: Claude Code, then Codex */
const FIRST = ["claude", "codex"];

/**
 * The setup screen's tiles: every coding agent, Claude Code and Codex first, then the others the PC
 * has (or that were installed from the tiles, `ready`), then the rest.
 */
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

/** How Connect your phone's box came open: a tap on it, or by itself (phoneBoxOpensFirst). */
export type PhoneBoxOpening = "tap" | "first-run";

/**
 * Whether Connect your phone's box is open when the setup screen first shows: on a first run on the
 * PC itself (its loopback: the desktop app, or a browser on the PC), where a phone is the next device
 * to add. Not on a guide reopened from Settings, nor on a page another device opened (a phone).
 */
export function phoneBoxOpensFirst(state: GuideState, onThisPc: boolean): boolean {
  return state.reopened !== true && onThisPc;
}

/**
 * Whether the box stays open: one that came open by itself leads with the relay only, so where the
 * relay cannot lead it closes again rather than sending the page to Settings → Phone untapped. Once
 * the relay led in it (`led`), the box is the user's, who may have tapped Turn on: a relay blocked
 * since shows the other ways there, and never closes it.
 */
export function phoneBoxStays(opening: PhoneBoxOpening, way: "wait" | "relay" | "other", led: boolean): boolean {
  return opening === "tap" || led || way !== "other";
}

/**
 * What the relay part of the box shows: the button that turns it on; its state while it connects (or
 * retries); a start that failed before its link existed (the relay is off and nothing retries it,
 * server/relay/service.ts), with Try again; the pairing QR code once it is online.
 */
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

/** How long a tile's install may run without the PC listing the agent before it stops spinning (a prompt, a closed tab). */
export const INSTALL_GIVE_UP_MS = 10 * 60_000;

export type TileState = "installed" | "installing" | "stuck" | "failed" | "missing";

/**
 * What an agent's tile shows: installed once the PC has it (`has`, whatever its own install says:
 * the catalog read for another agent may find it first; or its own read found it); a ring from the Install tap (`pending`, the
 * request unanswered) until then; stuck after INSTALL_GIVE_UP_MS of `runningMs`, to be tried again.
 */
export function tileState(has: boolean, step: SetupStep, pending: boolean, runningMs: number): TileState {
  // its own read of the catalog may find it before the screen hears of it
  if (has || step.kind === "installed" || step.kind === "ready" || step.kind === "signing-in") return "installed";
  // a request out (a retry included) turns the ring, over a failure before it
  if (pending || step.kind === "installing") return runningMs >= INSTALL_GIVE_UP_MS ? "stuck" : "installing";
  if (step.kind === "failed") return "failed";
  return "missing";
}

/** The agent Start picks: the one just set up here, else Claude Code, else Codex, else the first. */
export function preferredAgent(agents: readonly AgentCatalogRow[], ready: string | null): AgentCatalogRow | null {
  for (const id of [ready, ...FIRST]) {
    const agent = agents.find((candidate) => candidate.id === id);
    if (agent !== undefined) return agent;
  }
  return agents[0] ?? null;
}

/**
 * Opens the first workspace in the folder this browser used last; when that folder is gone since
 * (`gone`), in the server's home instead, as the guide has no folder pick to recover with.
 */
export async function openInFolder<T>(open: (directory: string) => Promise<T>, folder: string, home: string, gone: (reason: unknown) => boolean): Promise<T> {
  try {
    return await open(folder);
  } catch (reason: unknown) {
    if (folder !== home && gone(reason)) return open(home);
    throw reason;
  }
}

/** how many times, and how far apart, a failed read of the signed-in accounts is tried */
const USAGE_TRIES = 3;
const USAGE_RETRY_MS = 2000;

/**
 * Reads how many plan accounts are signed in, trying a failed read again. The returned cancel (the
 * guide closing) stops it: no retry runs after it, and an answer already on its way is dropped.
 */
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

/** The agents this PC is signed in to, from its plan usage: one whose sign-in expired is not counted. */
export function signedInAgents(providers: readonly ProviderUsage[]): string[] {
  return [...new Set(providers.filter((usage) => usage.problem !== "expired").map((usage) => usage.id))];
}

export type CheckStatus = { kind: "looking" } | { kind: "installed"; version: string | null } | { kind: "missing" } | { kind: "unknown" };

/** One agent's line in the check: undefined while the PC has not answered. */
export function checkStatus(row: AgentCatalogRow | undefined): CheckStatus {
  if (row === undefined) return { kind: "looking" };
  if (row.state.installed === true) return { kind: "installed", version: row.state.version };
  return row.state.installed === false ? { kind: "missing" } : { kind: "unknown" };
}

/** The check's lines: every coding agent this page knows while it looks, then each as the PC answered. */
export function checkList(known: readonly Pick<AgentCatalogEntry, "id" | "name" | "kind">[], answer: readonly AgentCatalogRow[] | null): { id: string; name: string; status: CheckStatus }[] {
  if (answer === null) return known.filter((entry) => entry.kind === "harness").map(({ id, name }) => ({ id, name, status: checkStatus(undefined) }));
  return answer.filter((row) => row.kind === "harness").map((row) => ({ id: row.id, name: row.name, status: checkStatus(row) }));
}

/** What says whether Ovis was used here before; null while it is not known yet. */
export interface FreshFacts {
  /** this PC's herdr workspaces */
  workspaces: number | null;
  /** this browser saved its settings (they are saved on the first change only) */
  savedSettings: boolean;
  /** GET /api/preferences: 0 until a browser of this server first shared a setting */
  sharedRevision: number | null;
  /** closed: a device was paired with this server */
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
  // the old multi-step guide's record (its outcomes, plan and agent) is no guide to show, even at its welcome
  const keys = Object.keys(value);
  if (keys.length === 2 && value["step"] === "setup" && value["reopened"] === true) return REOPENED;
  if (keys.length !== 1) return null;
  return value["step"] === "welcome" || value["step"] === "setup" ? { step: value["step"] } : null;
}

/** This browser's record of the guide; a damaged one reads as closed, so it never opens by itself on it. */
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

/** Keeps where the guide is (a reload resumes there), or with null that it was closed; the record written, or null when storage refused it. */
export function saveGuide(storage: Pick<Storage, "setItem">, state: GuideState | null): string | null {
  const record = JSON.stringify(state === null ? { status: "closed" } : { status: "open", state });
  try {
    storage.setItem(GUIDE_STORAGE_KEY, record);
    return record;
  } catch { return null; /* private mode: the guide lasts for the page */ }
}
