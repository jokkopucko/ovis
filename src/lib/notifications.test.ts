import { afterEach, describe, expect, it } from "bun:test";
import type { AgentStatus } from "../../shared/protocol.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { alertKindAllowed, parseAlerts } from "../../shared/notify-policy.ts";
import { alertPcAllowed, alertStatus, alertsAllow, paneAlertsMuted, shouldNotifyStatus, showPaneEndedNotification, showPaneStatusNotification } from "./notifications.ts";

describe("alertStatus", () => {
  it("takes a pane at rest that waits on its turn's background work for working, and leaves the rest as they are", () => {
    expect(["done", "idle", "unknown"].map((status) => alertStatus(status, true))).toEqual(["working", "working", "working"]);
    expect(alertStatus("blocked", true)).toBe("blocked");
    expect(alertStatus("done", false)).toBe("done");
    expect(alertStatus("done", undefined)).toBe("done");
    expect(shouldNotifyStatus(alertStatus("done", true), alertStatus("done", false))).toBe(true);
  });
});

describe("shouldNotifyStatus", () => {
  it("notifies when a known pane becomes blocked", () => {
    expect(shouldNotifyStatus("working", "blocked")).toBe(true);
  });

  it("notifies when a known pane becomes done", () => {
    expect(shouldNotifyStatus("blocked", "done")).toBe(true);
  });

  it("does not notify for the busy baseline states", () => {
    expect(shouldNotifyStatus("idle", "working")).toBe(false);
    expect(shouldNotifyStatus("working", "idle")).toBe(false);
  });

  it("does not notify when the status does not change", () => {
    expect(shouldNotifyStatus("blocked", "blocked")).toBe(false);
  });

  it("does not notify on first sight of a pane", () => {
    expect(shouldNotifyStatus(undefined, "blocked")).toBe(false);
  });

  it("carries unknown future statuses through without notifying", () => {
    expect(shouldNotifyStatus("working", "teleporting" as AgentStatus)).toBe(false);
  });
});

describe("alertsAllow", () => {
  it("lets through what the device chose, and nothing that is not an alert", () => {
    expect(alertsAllow({ input: true, done: "off" }, "blocked")).toBe(true);
    expect(alertsAllow({ input: false, done: "always" }, "blocked")).toBe(false);
    expect(alertsAllow({ input: false, done: "long" }, "done")).toBe(true);
    expect(alertsAllow({ input: true, done: "off" }, "done")).toBe(false);
    expect(alertsAllow({ input: true, done: "always" }, "working")).toBe(false);
  });

  it("tells a permission by its own choice, which follows questions until the device makes it", () => {
    expect(alertsAllow({ input: true, done: "off" }, "blocked", "permission")).toBe(true);
    expect(alertsAllow({ input: false, done: "off" }, "blocked", "permission")).toBe(false);
    expect(alertsAllow({ input: false, done: "off", permission: true }, "blocked", "permission")).toBe(true);
    expect(alertsAllow({ input: true, done: "off", permission: false }, "blocked", "permission")).toBe(false);
    expect(alertsAllow({ input: true, done: "off", permission: false }, "blocked", "question")).toBe(true);
    expect(alertsAllow({ input: false, done: "off", permission: true }, "blocked")).toBe(false);
  });
});

describe("alert kinds and PCs", () => {
  it("wants an error only when asked, and nothing of a PC turned off", () => {
    expect(alertKindAllowed({ input: true, done: "always" }, "error")).toBe(false);
    expect(alertKindAllowed({ input: false, done: "off", error: true }, "error")).toBe(true);
    expect(alertKindAllowed({ input: true, done: "off" }, "ended")).toBe(false);
    expect(alertPcAllowed({ input: true, done: "long", pcs_off: ["Home PC"] }, "Home PC")).toBe(false);
    expect(alertPcAllowed({ input: true, done: "long", pcs_off: ["Home PC"] }, "Desk")).toBe(true);
  });

  it("keeps only known choices from a subscription, so an older device keeps today's alerts", () => {
    expect(parseAlerts({ input: false, done: "always" })).toEqual({ input: false, done: "always" });
    expect(parseAlerts({ input: true, done: "long", permission: false, error: true, pcs_off: ["Desk", "Desk", 7, ""] }))
      .toEqual({ input: true, done: "long", permission: false, error: true, pcs_off: ["Desk"] });
    expect(parseAlerts({ permission: "no", error: 1, pcs_off: "Desk" })).toEqual({ input: true, done: "long" });
  });
});

describe("paneAlertsMuted", () => {
  it("all four paths suppress only the keyed pane", () => {
    const muted = [paneStorageId("local", "w1:p1"), paneStorageId("pc-2", "w1:p2")];
    expect(paneAlertsMuted(muted, "local", "w1:p1")).toBe(true);
    expect(paneAlertsMuted(muted, "pc-2", "w1:p1")).toBe(false);
    expect(paneAlertsMuted(muted, "local", "w1:p2")).toBe(false);
    expect(paneAlertsMuted(muted, "pc-2", "w1:p2")).toBe(true);
    expect(muted).not.toContain("w1:p2");
    expect(paneAlertsMuted(null, "local", "w1:p1")).toBe(false);
    expect(paneAlertsMuted(undefined, "local", "w1:p1")).toBe(false);
    expect(paneAlertsMuted([], "local", "w1:p1")).toBe(false);
  });
});

describe("tab alerts shown through the worker", () => {
  const saved = { Notification: globalThis.Notification, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"), document: Object.getOwnPropertyDescriptor(globalThis, "document") };
  afterEach(() => {
    (globalThis as { Notification?: unknown }).Notification = saved.Notification;
    for (const key of ["navigator", "document"] as const) {
      const descriptor = saved[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  function hiddenTabWithWorker(): Array<{ data: unknown }> {
    const shown: Array<{ data: unknown }> = [];
    (globalThis as { Notification?: unknown }).Notification = { permission: "granted" };
    Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: true } });
    const registration = { active: {}, showNotification: async (_title: string, options: { data: unknown }) => { shown.push({ data: options.data }); } };
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serviceWorker: { getRegistration: async () => registration } } });
    return shown;
  }

  it("names the pane's workspace, as the server's push does, so a tap after the pane ends opens it (public/sw.js)", async () => {
    const shown = hiddenTabWithWorker();
    showPaneEndedNotification("w1:p9", "Mac · claude", undefined, "local", "w1");
    showPaneStatusNotification("w2:p1", "Mac · codex", "blocked", undefined, "pc-2", "w2");
    showPaneStatusNotification("w3:p1", "Mac · codex", "done", undefined, "local");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shown.map((entry) => entry.data)).toEqual([
      { pane_id: "w1:p9", machine_id: "local", workspace_id: "w1", alert_id: expect.any(String) },
      { pane_id: "w2:p1", machine_id: "pc-2", workspace_id: "w2", alert_id: expect.any(String) },
      { pane_id: "w3:p1", machine_id: "local", alert_id: expect.any(String) },
    ]);
  });

  type Data = { pane_id?: string; machine_id?: string; workspace_id?: string; alert_id?: string };
  /** What iOS shows: one notification per show, whatever the tag, each closed on its own. */
  function iosCentre() {
    let delivered: Array<{ tag: string; data: Data; close: () => void }> = [];
    const add = (tag: string, data: Data): void => {
      const notification = { tag, data, close: () => { delivered = delivered.filter((other) => other !== notification); } };
      delivered.push(notification);
    };
    (globalThis as { Notification?: unknown }).Notification = { permission: "granted" };
    Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: true } });
    const registration = {
      active: {},
      showNotification: async (_title: string, options: { tag: string; data: Data }) => add(options.tag, options.data),
      getNotifications: async (filter?: { tag?: string }) => delivered.filter((notification) => !filter?.tag || notification.tag === filter.tag),
    };
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serviceWorker: { getRegistration: async () => registration } } });
    return { delivered: () => delivered.map((notification) => `${notification.data.machine_id ?? "local"} ${notification.data.pane_id}`) };
  }

  it("closes the pane's earlier alert, as a push does, and no other pane's", async () => {
    const centre = iosCentre();
    await showPaneStatusNotification("w1:p1", "Mac · codex", "blocked", undefined, "local", "w1");
    await showPaneStatusNotification("w1:p2", "Mac · codex", "blocked", undefined, "local", "w1");
    await showPaneStatusNotification("w1:p1", "Mac · codex", "blocked", undefined, "pc-2", "w1");
    await showPaneStatusNotification("w1:p1", "Mac · codex", "done", undefined, "local", "w1");
    expect(centre.delivered()).toEqual(["local w1:p2", "pc-2 w1:p1", "local w1:p1"]);
  });
});
