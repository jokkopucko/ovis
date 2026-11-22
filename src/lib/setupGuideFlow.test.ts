import { describe, expect, it } from "bun:test";

import { AGENT_CATALOG, catalogRow, type AgentCatalogRow, type AgentInstallState } from "../../shared/agent-catalog.ts";
import type { SecuritySummary } from "../../shared/access.ts";
import type { HealthAuth, RelayStatus } from "../../shared/protocol.ts";
import type { ProviderUsage } from "../../shared/usage.ts";
import { onSetupGuideRequest, openSetupGuide } from "./setupGuide.ts";
import { agentRows, alertsFailed, alertsHere, alertsSurfaces, type AlertsFacts, type AlertsHere, autoOpen, CHECK_SETTLE_MS, checkList, checkStatus, foundAgents, guideStep, INSTALL_GIVE_UP_MS, installedHere, openInFolder, otherDevice, phoneBoxMode, phoneBoxOpensFirst, phoneBoxStays, phoneWay, preferredAgent, relayOnlyPc, GUIDE_STORAGE_KEY, readGuide, readSignedIn, relayStep, REOPENED, saveGuide, settleDelay, setupLeft, setupView, signedInAgents, tileState, turnsUsageOn, FIRST_RUN, type FreshFacts, type PcCheck } from "./setupGuideFlow.ts";

const FRESH: FreshFacts = { workspaces: 0, savedSettings: false, sharedRevision: 0, pairingGate: "open", watching: false };

const memory = (): Pick<Storage, "getItem" | "setItem"> & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
};

describe("autoOpen", () => {
  it("opens the welcome on a fresh install only", () => {
    expect(autoOpen(FRESH)).toBe(true);
    expect(autoOpen({ ...FRESH, pairingGate: "unavailable" })).toBe(true);
  });

  it("stays shut once anything shows Ovis was used here before", () => {
    expect(autoOpen({ ...FRESH, workspaces: 1 })).toBe(false);
    expect(autoOpen({ ...FRESH, savedSettings: true })).toBe(false);
    expect(autoOpen({ ...FRESH, sharedRevision: 3 })).toBe(false);
    expect(autoOpen({ ...FRESH, pairingGate: "closed" })).toBe(false);
    expect(autoOpen({ ...FRESH, watching: true })).toBe(false);
  });

  it("does not guess while a fact is still unknown", () => {
    expect(autoOpen({ ...FRESH, workspaces: null })).toBe(false);
    expect(autoOpen({ ...FRESH, sharedRevision: null })).toBe(false);
  });
});

describe("guideStep", () => {
  it("opens a first run on the setup screen, and Settings opens the same screen marked as opened again", () => {
    expect(FIRST_RUN).toEqual({ step: "setup" });
    expect(REOPENED).toEqual({ step: "setup", reopened: true });
  });

  it("forgets the step Setup: N left named once the user moves, and changes nothing else", () => {
    expect(guideStep({ ...REOPENED, at: "theme" }, { type: "moved" })).toBe(REOPENED);
    expect(guideStep(FIRST_RUN, { type: "moved" })).toBe(FIRST_RUN);
  });

  it("resumes a record saved at the welcome, which is gone, at the first step", () => {
    const saved = JSON.stringify({ status: "open", state: { step: "welcome" } });
    expect(readGuide({ getItem: () => saved })).toEqual({ status: "open", state: FIRST_RUN });
  });
});

describe("readGuide and saveGuide", () => {
  it("keeps an open guide to resume and a closed one to stay shut", () => {
    const storage = memory();
    expect(readGuide(storage)).toBeNull();
    saveGuide(storage, REOPENED);
    expect(readGuide(storage)).toEqual({ status: "open", state: REOPENED });
    saveGuide(storage, { ...REOPENED, at: "phone" });
    expect(readGuide(storage)).toEqual({ status: "open", state: { ...REOPENED, at: "phone" } });
    storage.setItem(GUIDE_STORAGE_KEY, JSON.stringify({ status: "open", state: { ...REOPENED, at: "elsewhere" } }));
    expect(readGuide(storage)).toEqual({ status: "closed" });
    saveGuide(storage, null);
    expect(readGuide(storage)).toEqual({ status: "closed" });
  });

  it("reads a damaged record as closed, never as a guide to show", () => {
    const storage = memory();
    for (const raw of ["{", "[]", "{\"status\":\"open\",\"state\":{\"step\":\"nowhere\"}}", "{\"status\":\"open\"}", "{\"status\":\"open\",\"state\":{\"step\":\"agent\"}}", "{\"status\":\"open\",\"state\":{\"step\":\"welcome\",\"outcomes\":{},\"plan\":null,\"agent\":null,\"signedIn\":false}}"]) {
      storage.values.set("ovis:setup-guide", raw);
      expect(readGuide(storage)).toEqual({ status: "closed" });
    }
  });

});

const MISSING: AgentInstallState = { installed: false, binary: null, on_path: null, version: null, version_error: null, meets_min_version: null };
const row = (id: string, state: Partial<AgentInstallState> = {}): AgentCatalogRow => catalogRow(AGENT_CATALOG.find((entry) => entry.id === id)!, "linux", { ...MISSING, ...state });
const installed = (id: string, version: string | null = "1.0.0"): AgentCatalogRow => row(id, { installed: true, binary: id, on_path: true, version });
const answer = (...found: AgentCatalogRow[]): AgentCatalogRow[] => AGENT_CATALOG.map((entry) => found.find((one) => one.id === entry.id) ?? row(entry.id));
const check = (patch: Partial<PcCheck>): PcCheck => ({ checking: false, catalog: null, failed: false, ...patch });

describe("the setup screen after the PC check", () => {
  it("shows the check while it runs, and before it has started", () => {
    expect(setupView(check({ checking: true }))).toBe("checking");
    expect(setupView(check({}))).toBe("checking");
    expect(setupView(check({ checking: true, catalog: answer(installed("claude")) }))).toBe("checking");
  });

  it("shows one list of agents whatever the PC has, and says when the check failed", () => {
    expect(setupView(check({ catalog: answer(installed("codex")) }))).toBe("agents");
    expect(setupView(check({ catalog: answer() }))).toBe("agents");
    expect(setupView(check({ failed: true }))).toBe("failed");
  });

  it("lists every coding agent: Claude Code and Codex first, then the others installed, then the rest", () => {
    const catalog = [row("codex"), installed("pi"), row("claude"), installed("hermes"), row("opencode"), row("devin", { installed: null })];
    expect(agentRows(catalog, []).map((agent) => agent.id)).toEqual(["claude", "codex", "pi", "opencode", "devin"]);
    expect(agentRows(null, [])).toEqual([]);
  });

  it("keeps an agent installed here with the installed ones, before the PC is read again", () => {
    const catalog = [row("claude"), row("opencode"), row("pi")];
    expect(agentRows(catalog, ["pi"]).map((agent) => agent.id)).toEqual(["claude", "pi", "opencode"]);
    expect(installedHere(catalog[2]!, ["pi"])).toBe(true);
    expect(installedHere(catalog[0]!, ["pi"])).toBe(false);
    expect(installedHere(installed("claude"), [])).toBe(true);
  });

  it("picks Claude Code, else Codex, else the first installed, and the agent just set up over all", () => {
    expect(preferredAgent(foundAgents(answer(installed("codex"), installed("claude"), installed("pi"))), null)?.id).toBe("claude");
    expect(preferredAgent(foundAgents(answer(installed("pi"), installed("codex"))), null)?.id).toBe("codex");
    expect(preferredAgent(foundAgents(answer(installed("pi"), installed("omo"))), null)?.id).toBe("omo");
    expect(preferredAgent(foundAgents(answer(installed("claude"), installed("codex"))), "codex")?.id).toBe("codex");
    expect(preferredAgent([], null)).toBeNull();
  });

  it("names the agents signed in on this PC from its plan usage, not one to sign in again", () => {
    const account = (id: ProviderUsage["id"], key: string, problem: ProviderUsage["problem"]): ProviderUsage => ({ id, key, account: null, plan: null, windows: [], problem, checked_at: null });
    expect(signedInAgents([])).toEqual([]);
    expect(signedInAgents([account("claude", "a", null), account("claude", "b", "rate_limited"), account("codex", "c", "expired"), account("copilot", "d", null)])).toEqual(["claude", "copilot"]);
    const recorded = (signedIn: boolean, problem: ProviderUsage["problem"] = null): ProviderUsage =>
      ({ ...account("claude", "r", problem), checked_at: "2026-09-29T12:00:00Z", recorded: { by: "omp", stale: false, signed_in: signedIn } });
    expect(signedInAgents([recorded(false), account("copilot", "d", null)])).toEqual(["copilot"]);
    expect(signedInAgents([recorded(true), account("copilot", "d", null)])).toEqual(["claude", "copilot"]);
    expect(signedInAgents([recorded(true, "rate_limited")])).toEqual(["claude"]);
    expect(signedInAgents([recorded(true, "expired")])).toEqual([]);
  });

  it("keeps an instant answer on screen briefly, and adds nothing to a slow check", () => {
    expect(settleDelay(1000, 1000)).toBe(CHECK_SETTLE_MS);
    expect(settleDelay(1000, 1000 + CHECK_SETTLE_MS - 100)).toBe(100);
    expect(settleDelay(1000, 1000 + CHECK_SETTLE_MS)).toBe(0);
    expect(settleDelay(1000, 3000)).toBe(0);
  });

  it("says for each agent whether it is still being looked for, there, or not", () => {
    expect(checkStatus(undefined)).toEqual({ kind: "looking" });
    expect(checkStatus(installed("claude", "2.1.311"))).toEqual({ kind: "installed", version: "2.1.311" });
    expect(checkStatus(installed("claude", null))).toEqual({ kind: "installed", version: null });
    expect(checkStatus(row("claude"))).toEqual({ kind: "missing" });
    expect(checkStatus(row("claude", { installed: null }))).toEqual({ kind: "unknown" });
  });

  it("lists every coding agent while looking, then each as the PC answered", () => {
    const listed = checkList(AGENT_CATALOG, null);
    expect(listed.map((one) => one.id)).toEqual(AGENT_CATALOG.filter((entry) => entry.kind === "harness").map((entry) => entry.id));
    expect(listed.every((one) => one.status.kind === "looking")).toBe(true);
    const answered = checkList(AGENT_CATALOG, answer(installed("codex", "0.163.0")));
    expect(answered.find((one) => one.id === "codex")).toEqual({ id: "codex", name: "Codex", status: { kind: "installed", version: "0.163.0" } });
    expect(answered.find((one) => one.id === "claude")?.status).toEqual({ kind: "missing" });
    const extra = { ...installed("claude"), id: "newcomer", name: "Newcomer" };
    expect(checkList(AGENT_CATALOG, [...answer(), extra]).at(-1)).toEqual({ id: "newcomer", name: "Newcomer", status: { kind: "installed", version: "1.0.0" } });
  });
});

describe("openSetupGuide", () => {
  it("reaches every listener until it unsubscribes", () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
    try {
      const asked: unknown[] = [];
      const stop = onSetupGuideRequest((at) => { asked.push(at); });
      openSetupGuide();
      openSetupGuide("phone");
      expect(asked).toEqual([undefined, "phone"]);
      stop();
      openSetupGuide();
      expect(asked).toHaveLength(2);
    } finally {
      if (saved) Object.defineProperty(globalThis, "window", saved);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});

describe("readSignedIn", () => {
  const scheduler = () => {
    const waiting: (() => void)[] = [];
    let cancelled = 0;
    return { waiting, cancelled: () => cancelled, schedule: (run: () => void) => { waiting.push(run); return () => { cancelled += 1; }; } };
  };
  const settled = () => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));

  it("tries a failed read again, and reports the count once one answers", async () => {
    const answers = [Promise.reject(new Error("offline")), Promise.resolve(2)];
    const found: number[] = [];
    const timer = scheduler();
    readSignedIn(() => answers.shift()!, (count) => found.push(count), timer.schedule);
    await settled();
    expect(timer.waiting.length).toBe(1);
    timer.waiting.shift()!();
    await settled();
    expect(found).toEqual([2]);
  });

  it("stops when cancelled: no retry runs and a late answer changes nothing", async () => {
    let reads = 0;
    const found: number[] = [];
    const timer = scheduler();
    const late = Promise.withResolvers<number>();
    const cancel = readSignedIn(() => { reads += 1; return reads === 1 ? Promise.reject(new Error("offline")) : late.promise; }, (count) => found.push(count), timer.schedule);
    await settled();
    cancel();
    expect(timer.cancelled()).toBe(1);
    expect(reads).toBe(1);

    const second = scheduler();
    const stop = readSignedIn(() => late.promise, (count) => found.push(count), second.schedule);
    stop();
    late.resolve(3);
    await settled();
    expect(found).toEqual([]);
  });
});

describe("openInFolder", () => {
  const gone = (reason: unknown): boolean => reason === "gone";
  it("opens in the folder used last", async () => {
    const asked: string[] = [];
    expect(await openInFolder((dir) => { asked.push(dir); return Promise.resolve(dir); }, "/work/app", "~", gone)).toBe("/work/app");
    expect(asked).toEqual(["/work/app"]);
  });

  it("opens in the home when the folder used last is gone", async () => {
    const asked: string[] = [];
    expect(await openInFolder((dir) => { asked.push(dir); return dir === "~" ? Promise.resolve(dir) : Promise.reject("gone"); }, "/work/old", "~", gone)).toBe("~");
    expect(asked).toEqual(["/work/old", "~"]);
  });

  it("passes any other failure on, and a failure in the home itself", async () => {
    await expect(openInFolder(() => Promise.reject("offline"), "/work/app", "~", gone)).rejects.toBe("offline");
    const asked: string[] = [];
    await expect(openInFolder((dir) => { asked.push(dir); return Promise.reject("gone"); }, "~", "~", gone)).rejects.toBe("gone");
    expect(asked).toEqual(["~"]);
  });
});

describe("tileState", () => {
  const tab = { pane_id: "w1:p2", workspace_id: "w1", command: "curl -fsSL https://claude.ai/install.sh | bash", shell: "posix" as const };
  it("a tile the PC has is installed, whatever its own install says", () => {
    expect(tileState(true, { kind: "idle" }, false, 0)).toBe("installed");
    expect(tileState(true, { kind: "installing", tab }, false, 1000)).toBe("installed");
  });

  it("a tile whose own read found the agent first is installed, before the screen hears of it", () => {
    expect(tileState(false, { kind: "installed", version: "2.1.312", onPath: true }, false, 0)).toBe("installed");
    expect(tileState(false, { kind: "ready", version: "1.0.0" }, false, 0)).toBe("installed");
  });

  it("spins from the tap until the PC has it: the request unanswered, then the install", () => {
    expect(tileState(false, { kind: "idle" }, true, 0)).toBe("installing");
    expect(tileState(false, { kind: "installing", tab }, false, 1000)).toBe("installing");
  });

  it("an install that never shows up stops spinning, to be tried again", () => {
    expect(tileState(false, { kind: "installing", tab }, false, INSTALL_GIVE_UP_MS)).toBe("stuck");
    expect(tileState(false, { kind: "failed", message: "offline", after: "install" }, false, 0)).toBe("failed");
    expect(tileState(false, { kind: "idle" }, false, 0)).toBe("missing");
    expect(tileState(false, { kind: "failed", message: "offline", after: "install" }, true, 0)).toBe("installing");
    expect(tileState(false, { kind: "idle" }, true, INSTALL_GIVE_UP_MS)).toBe("stuck");
  });
});

describe("phoneBoxOpensFirst and phoneBoxStays", () => {
  it("opens Connect your phone by itself on a first run on the PC only", () => {
    expect(phoneBoxOpensFirst({ step: "setup" }, true)).toBe(true);
    expect(phoneBoxOpensFirst({ step: "setup" }, false)).toBe(false);
    expect(phoneBoxOpensFirst(REOPENED, true)).toBe(false);
  });

  it("keeps a box that came open by itself only while the relay may lead; a tapped one always", () => {
    expect(phoneBoxStays("first-run", "wait", false)).toBe(true);
    expect(phoneBoxStays("first-run", "relay", false)).toBe(true);
    expect(phoneBoxStays("first-run", "other", false)).toBe(false);
    expect(phoneBoxStays("tap", "other", false)).toBe(true);
  });

  it("keeps a box the relay led in, when the relay is blocked after Turn on", () => {
    expect(phoneBoxStays("first-run", "other", true)).toBe(true);
  });
});

describe("phoneBoxMode", () => {
  const auth = (via: HealthAuth["via"]): HealthAuth => ({ required: false, authenticated: true, via, role: "drive" });
  it("waits until it knows the address and how this browser got in", () => {
    expect(phoneBoxMode(undefined, auth("tailscale"))).toBe("wait");
    expect(phoneBoxMode("http://100.1.2.3:7317", null)).toBe("wait");
  });

  it("shows the QR where this browser is in on its own", () => {
    expect(phoneBoxMode("http://100.1.2.3:7317", auth("tailscale"))).toBe("qr");
    expect(phoneBoxMode("http://100.1.2.3:7317", auth("device"))).toBe("qr");
  });

  it("pairs this browser first where it is in only because nothing is paired yet", () => {
    expect(phoneBoxMode("http://100.1.2.3:7317", auth("open"))).toBe("pair-self");
  });

  it("leaves it to Settings with no address a phone can open, or an access the server does not name", () => {
    expect(phoneBoxMode(null, auth("tailscale"))).toBe("settings");
    expect(phoneBoxMode("http://100.1.2.3:7317", auth(undefined))).toBe("settings");
  });
});

describe("phoneWay", () => {
  const auth = (via: HealthAuth["via"], role: HealthAuth["role"] = "drive"): HealthAuth => ({ required: false, authenticated: true, via, role });
  const relay = (blocked: RelayStatus["blocked"] | "loading" | "unsupported") => ({
    unsupported: blocked === "unsupported",
    status: blocked === "loading" || blocked === "unsupported" ? null : { blocked },
  });
  it("leads with the relay where it is offered, this browser may control it and nothing blocks it", () => {
    expect(phoneWay(relay(null), false, auth("local"))).toBe("relay");
    expect(phoneWay(relay(null), false, auth("open"))).toBe("relay");
    expect(phoneWay(relay(null), false, auth("device"))).toBe("relay");
  });

  it("waits for the relay's first answer and this browser's access, so a loopback page is not sent to Settings first", () => {
    expect(phoneWay(relay("loading"), false, auth("local"))).toBe("wait");
    expect(phoneWay(relay(null), false, null)).toBe("wait");
  });

  it("keeps the other ways where the relay cannot lead: an older server, the hosted shell, a block, a read-only browser", () => {
    expect(phoneWay(relay("unsupported"), false, auth("local"))).toBe("other");
    expect(phoneWay(relay(null), true, auth("relay"))).toBe("other");
    expect(phoneWay(relay("serve_only"), false, auth("local"))).toBe("other");
    expect(phoneWay(relay("identity_unreadable"), false, auth("local"))).toBe("other");
    expect(phoneWay(relay(null), false, auth("device", "watch"))).toBe("other");
    expect(phoneWay(relay(null), false, auth("portal"))).toBe("other");
  });
});

describe("relayStep", () => {
  it("turns it on while off, follows it while it connects or retries, and shows its QR once online", () => {
    expect(relayStep({ phase: "off", error: null })).toBe("off");
    expect(relayStep({ phase: "connecting", error: null })).toBe("starting");
    expect(relayStep({ phase: "error", error: "Could not reach the relay." })).toBe("starting");
    expect(relayStep({ phase: "online", error: null })).toBe("online");
  });

  it("offers Try again for a start that failed before its link existed", () => {
    expect(relayStep({ phase: "off", error: "Could not start the relay." })).toBe("not-started");
  });
});

describe("a reopened guide", () => {
  it("never turns plan usage on by itself: only a first run does", () => {
    expect(turnsUsageOn(FIRST_RUN)).toBe(true);
    expect(turnsUsageOn(REOPENED)).toBe(false);
  });

  it("is still a reopened one after a reload", () => {
    const saved = new Map<string, string>();
    saveGuide({ setItem: (key, value) => { saved.set(key, value); } }, REOPENED);
    expect(readGuide({ getItem: (key) => saved.get(key) ?? null })).toEqual({ status: "open", state: REOPENED });
  });
});

describe("otherDevice", () => {
  it("names a device paired here other than this browser, and none for this browser alone", () => {
    const device = (id: string, current: boolean) => ({ id, label: `device ${id}`, role: "drive" as const, created_at: "2026-11-15T00:00:00Z", last_seen_at: null, current });
    expect(otherDevice([])).toBeNull();
    expect(otherDevice([device("self", true)])).toBeNull();
    expect(otherDevice([device("self", true), device("phone", false)])).toBe("device phone");
  });

  it("counts the user's own phone linked through the account", () => {
    const self = { id: "self", label: "this browser", role: "drive" as const, created_at: "2026-11-15T00:00:00Z", last_seen_at: null, current: true };
    const linked = { ...self, id: "phone", label: "Pixel 9", current: false, via_relay: true, account: "me@example.com" };
    expect(otherDevice([self, linked])).toBe("Pixel 9");
  });
});

describe("setupLeft", () => {
  it("counts the agent, the theme, the phone and the alerts, and opens the guide at the first one left", () => {
    expect(setupLeft({ workspace: true, phone: true, alerts: true })).toEqual({ done: 4, total: 4, at: null });
    expect(setupLeft({ workspace: true, phone: false, alerts: true })).toEqual({ done: 3, total: 4, at: "phone" });
    expect(setupLeft({ workspace: true, phone: true, alerts: false })).toEqual({ done: 3, total: 4, at: "phone" });
    expect(setupLeft({ workspace: false, phone: false, alerts: false })).toEqual({ done: 1, total: 4, at: "agent" });
  });
});

describe("alertsFailed", () => {
  it("counts every outcome but a confirmed push as no alerts, except in the desktop app, where only a refusal does", () => {
    for (const result of ["unsupported", "no-worker", "failed", "gone", "refused", "unregistered", "permission"]) expect(alertsFailed(result, false)).toBe(true);
    expect(alertsFailed("sent", false)).toBe(false);
    for (const result of ["unsupported", "no-worker", "failed", "gone", "refused", "sent"]) expect(alertsFailed(result, true)).toBe(false);
    expect(alertsFailed("permission", true)).toBe(true);
  });
});

describe("alertsHere: what the step, Done and Setup: N left say of this device's alerts", () => {
  const record = (fields: Partial<AlertsFacts["push"]> = {}): AlertsFacts["push"] => ({ checked: true, problem: null, delivered: true, ...fields });
  const base: AlertsFacts = { alertsOn: true, notifications: "granted", desktop: false, pushSupported: true, pushOn: true, push: record(), confirmed: null };
  const rows: [string, Partial<AlertsFacts>, AlertsHere][] = [
    ["the Alerts switch off", { alertsOn: false }, "off"],
    ["never subscribed: permission not asked yet", { notifications: "default", pushOn: false, push: record({ delivered: null }) }, "off"],
    ["subscribed, and a push to it delivered", {}, "on"],
    ["the confirmation push refused for good (rejected)", { push: record({ problem: "rejected", delivered: false }) }, "off"],
    ["the confirmation push refused for good (key mismatch)", { push: record({ problem: "key-mismatch", delivered: false }) }, "off"],
    ["the confirmation push failed for a while, never delivered (and after a reload)", { push: record({ delivered: false }) }, "off"],
    ["delivered once, then a push failed for a while", { push: record({ delivered: true }) }, "on"],
    ["the push service retired it (410), once a look read it (visibility, reload)", { push: record({ problem: "gone" }) }, "off"],
    ["the permission taken back, tab in view or hidden", { notifications: "denied", push: record({ problem: "permission" }) }, "off"],
    ["push health not answered yet since the load", { push: record({ checked: false, delivered: null }) }, "checking"],
    ["push health's request failed (500, the network): not checked", { push: record({ checked: false, delivered: null }) }, "checking"],
    ["the subscription missing on the PC", { push: record({ problem: "missing", delivered: null }) }, "off"],
    ["the desktop app, notifications allowed", { desktop: true, pushSupported: false, pushOn: false, push: record({ checked: false, delivered: null }) }, "on"],
    ["the desktop app, notifications refused", { desktop: true, notifications: "denied", pushSupported: false, pushOn: false }, "off"],
    ["no Notification API (plain http)", { notifications: "unsupported", pushSupported: false, pushOn: false }, "unavailable"],
    ["no Notification API (plain http), the switch off", { alertsOn: false, notifications: "unsupported", pushSupported: false, pushOn: false }, "unavailable"],
    ["a working subscription with no delivery recorded yet (an automatic re-subscription): off until one press or one alert", { push: record({ delivered: false }) }, "off"],
    ["notifications but no push (not the desktop app)", { pushSupported: false, pushOn: false, push: record({ delivered: null }) }, "off"],
    ["an older server or the open LAN: no record, the confirmation push got through", { push: record({ delivered: null }), confirmed: true }, "on"],
    ["an older server or the open LAN: no record, the confirmation push failed (and after a reload)", { push: record({ delivered: null }), confirmed: false }, "off"],
    ["an older server or the open LAN: no record, subscribed before the outcome was kept: as before", { push: record({ delivered: null }), confirmed: null }, "on"],
    ["an older server or the open LAN: no record, no subscription", { pushOn: false, push: record({ delivered: null }) }, "off"],
    ["a delivered subscription, but the permission not granted here", { notifications: "default" }, "off"],
    ["a delivered subscription, but no push in this browser", { pushSupported: false }, "off"],
    ["a delivered subscription, its health not read yet since the load", { push: record({ checked: false }) }, "checking"],
  ];
  for (const [name, facts, expected] of rows) {
    it(name, () => {
      expect(alertsHere({ ...base, ...facts })).toBe(expected);
    });
  }

  it("shows each answer the same way on the step, Done and the row", () => {
    expect(alertsSurfaces("on")).toEqual({ step: "send-test", done: "done", row: "done" });
    expect(alertsSurfaces("off")).toEqual({ step: "turn-on", done: "not-yet", row: "left" });
    expect(alertsSurfaces("checking")).toEqual({ step: "checking", done: "checking", row: "wait" });
    expect(alertsSurfaces("unavailable")).toEqual({ step: "note", done: "unavailable", row: "done" });
  });
});

describe("a guide opened at a later step", () => {
  it("forgets that step once the user leaves it, so a reload resumes where they are", () => {
    expect(guideStep({ ...REOPENED, at: "phone" }, { type: "moved" })).toEqual(REOPENED);
    expect(guideStep(REOPENED, { type: "moved" })).toBe(REOPENED);
  });
});


describe("relayOnlyPc", () => {
  const facts = (bind_scope: SecuritySummary["bind_scope"], observed_ingress: SecuritySummary["observed_ingress"]): SecuritySummary => ({ token_configured: true, pairing_gate: "closed", bind_scope, observed_ingress, public_exposure: "unknown" });

  it("T70: a PC bound to its loopback and opened on it directly has only the relay for other devices", () => {
    expect(relayOnlyPc(facts("loopback", "direct"))).toBe(true);
  });

  it("T70: a PC on the local network, on the tailnet, or fronted by Tailscale or a proxy has another route", () => {
    expect(relayOnlyPc(facts("other", "direct"))).toBe(false);
    expect(relayOnlyPc(facts("tailnet", "direct"))).toBe(false);
    expect(relayOnlyPc(facts("loopback", "tailscale"))).toBe(false);
    expect(relayOnlyPc(facts("loopback", "funnel"))).toBe(false);
    expect(relayOnlyPc(facts("loopback", "proxy"))).toBe(false);
  });

  it("T70: an ingress the PC cannot name (a forwarding proxy that says nothing) is not taken as relay-only", () => {
    expect(relayOnlyPc(facts("loopback", "unknown"))).toBe(false);
  });
});
