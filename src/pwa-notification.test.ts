import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Selection = { type: string; pane_id: string; machine_id: string; view?: "chat" | "terminal"; workspace_id?: string };
type SelectedPane = Omit<Selection, "view">;
type WindowClient = { url: string; focused: boolean; postMessage: (data: Selection) => void; focus: () => Promise<void> };

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const APP = "https://herdr.test/";

function loadWorker(self: unknown): { isAppWindow: (url: string) => boolean } {
  return new Function("self", `${readFileSync(join(import.meta.dir, "..", "public", "sw.js"), "utf8")}\nreturn { isAppWindow };`)(self);
}

/** Execute the shipped worker, including its asynchronous notificationclick listener. */
function notifications(
  windows: WindowClient[],
  matchAll = async () => windows,
  openWindow: (url: string) => Promise<WindowClient | null> = async () => null,
  scope?: string,
) {
  const listeners = new Map<string, (event: unknown) => void>();
  const opened: string[] = [];
  const shown: Array<{ title: string; options: { data: unknown } }> = [];
  let closed = 0;
  const self = {
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    clients: { matchAll, openWindow: async (url: string) => { opened.push(url); return openWindow(url); } },
    registration: { scope, showNotification: async (title: string, options: { data: unknown }) => { shown.push({ title, options }); } },
  };
  loadWorker(self);
  const push = (payload: unknown): Promise<void> => {
    let completion!: Promise<void>;
    listeners.get("push")!({ data: { json: () => payload, text: () => JSON.stringify(payload) }, waitUntil: (promise: Promise<void>) => { completion = promise; } });
    return completion;
  };
  const click = (paneId: string | null = "pane-a", machineId = "local", workspaceId?: string): Promise<void> => {
    let completion!: Promise<void>;
    listeners.get("notificationclick")!({
      notification: { data: { pane_id: paneId, machine_id: machineId, ...(workspaceId ? { workspace_id: workspaceId } : {}) }, close: () => { closed++; } },
      waitUntil: (promise: Promise<void>) => { completion = promise; },
    });
    return completion;
  };
  return { click, push, shown, opened, closed: () => closed };
}

function client(focus = async () => {}, focused = false, url = APP) {
  const selected: SelectedPane[] = [];
  const views: Array<Selection["view"]> = [];
  return {
    url,
    focused,
    focus,
    selected,
    views,
    postMessage: (data: Selection) => {
      const { view, ...pane } = data;
      selected.push(pane);
      views.push(view);
    },
  };
}

describe("notification clicks", () => {
  it("counts a tapped pane alert with the server only while its counts are on and their notice was shown", async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let status: Response | Error = new Error("signed out");
    loadWorker({
      addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
      clients: { matchAll: async () => [], openWindow: async () => null },
      fetch: async (url: string, init: RequestInit = {}) => {
        requests.push({ url, init });
        if ((init.method ?? "GET") !== "GET") return new Response(null, { status: 200 });
        if (status instanceof Error) throw status;
        return status.clone();
      },
    });
    const tap = async (paneId: string | null) => {
      requests.length = 0;
      const waits: Promise<unknown>[] = [];
      listeners.get("notificationclick")!({ notification: { data: { pane_id: paneId, machine_id: "local" }, close: () => {} }, waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
      await Promise.all(waits);
      return requests.map((request) => [request.url, request.init.method ?? "GET", request.init.body ?? null, (request.init.headers as Record<string, string> | undefined)?.["x-herdr-update"] ?? null]);
    };
    const asked = ["/api/telemetry", "GET", null, null];
    // signed out, off, blocked by the environment or before the notice: asked, never told
    expect(await tap("w1:p1")).toEqual([asked]);
    for (const counts of [{ enabled: false, blocked_by_env: false, notice_seen: true }, { enabled: true, blocked_by_env: true, notice_seen: true }, { enabled: true, blocked_by_env: false, notice_seen: false }]) {
      status = Response.json(counts);
      expect(await tap("w1:p1")).toEqual([asked]);
    }
    status = Response.json({ enabled: true, blocked_by_env: false, notice_seen: true });
    expect(await tap("w1:p1")).toEqual([asked, ["/api/telemetry", "POST", JSON.stringify({ alert_opened: true }), "1"]]);
    // a generic notification is not a pane alert
    expect(await tap(null)).toEqual([]);
  });

  it("tells app windows from the reader, raw file and static tabs the app also opens", () => {
    const { isAppWindow } = loadWorker({ addEventListener: () => {} });
    expect(isAppWindow(APP)).toBe(true);
    expect(isAppWindow(`${APP}?machine=pc2&pane=w1%3Ap1&view=chat`)).toBe(true);
    expect(isAppWindow(`${APP}?settings=general`)).toBe(true);
    // the shell answers any other path too
    expect(isAppWindow(`${APP}index.html`)).toBe(true);
    expect(isAppWindow(`${APP}?read=docs%2Fguide.md&machine=local`)).toBe(false);
    // an empty `read` is no reader (lib/fileReader.ts readerFromSearch): App runs there
    expect(isAppWindow(`${APP}?read=%20`)).toBe(true);
    expect(isAppWindow(`${APP}api/fs/file?path=notes.md&pane=w1%3Ap1`)).toBe(false);
    expect(isAppWindow(`${APP}api/machines/pc2/fs/file?path=index.html&render=1`)).toBe(false);
    expect(isAppWindow(`${APP}icons/icon-192.png`)).toBe(false);
    expect(isAppWindow(`${APP}assets/index-abc.js`)).toBe(false);
    // any shipped file is no app window, listed in the worker's cache rules or not
    expect(isAppWindow(`${APP}social-preview.png`)).toBe(false);
    expect(isAppWindow(`${APP}THIRD_PARTY_NOTICES.md`)).toBe(false);
    expect(isAppWindow(`${APP}manifest.webmanifest`)).toBe(false);
    expect(isAppWindow(`${APP}sw.js`)).toBe(false);
    expect(isAppWindow(`${APP}favicon.ico`)).toBe(false);
    expect(isAppWindow("not a url")).toBe(false);
  });

  it("never focuses a markdown reader tab: the app window takes the pane, else it opens", async () => {
    const reader = client(undefined, false, `${APP}?read=notes.md&machine=local`);
    const app = client();
    // matchAll lists the most recently focused first: the reader was used last
    const worker = notifications([reader, app]);
    await worker.click("pane-a");
    expect(reader.selected).toEqual([]);
    expect(app.selected).toHaveLength(2);
    expect(worker.opened).toEqual([]);

    let focused = 0;
    const lone = client(async () => { focused++; }, true, `${APP}?read=notes.md&machine=local`);
    const raw = client(undefined, false, `${APP}api/fs/file?path=notes.md`);
    const cold = notifications([lone, raw]);
    await cold.click("pane-b", "pc2");
    expect(focused).toBe(0);
    expect(lone.selected).toEqual([]);
    expect(raw.selected).toEqual([]);
    expect(cold.opened).toEqual(["/?machine=pc2&pane=pane-b&view=chat"]);
  });

  it("keeps a PC's pane out of the hosted shell's request: a cold start names it in the fragment, and a reader there is no app window", async () => {
    const shell = "https://app.example";
    const scope = `/s/${"ab".repeat(16)}/`;
    const reader = client(undefined, true, `${shell}${scope}#read=notes.md&machine=local`);
    const cold = notifications([reader], undefined, undefined, `${shell}${scope}`);
    await cold.click("w1:p9", "pc2", "w1");
    expect(reader.selected).toEqual([]);
    expect(cold.opened).toEqual([`${scope}#machine=pc2&ws=w1&pane=w1%3Ap9&view=chat`]);
    const { isAppWindow } = loadWorker({ addEventListener: () => {}, registration: { scope: `${shell}${scope}` } });
    expect(isAppWindow(`${shell}${scope}#read=notes.md&machine=local`)).toBe(false);
    expect(isAppWindow(`${shell}${scope}#machine=pc2&pane=w1%3Ap9`)).toBe(true);
  });

  it("names the workspace an alert's pane was last seen in, to an open window and a cold start", async () => {
    const quiet = notifications([]);
    await quiet.push({ pane_id: "w1:p9", workspace_id: "w1", title: "t", body: "terminal ended", tag: "x" });
    await quiet.push({ pane_id: "w1:p9", title: "t", body: "b", tag: "y" });
    expect(quiet.shown.map((shown) => shown.options.data)).toEqual([
      { pane_id: "w1:p9", machine_id: "local", workspace_id: "w1" },
      { pane_id: "w1:p9", machine_id: "local", workspace_id: null },
    ]);

    const app = client();
    const worker = notifications([app]);
    await worker.click("w1:p9", "pc2", "w1");
    expect(app.selected).toEqual([
      { type: "select-pane", pane_id: "w1:p9", machine_id: "pc2", workspace_id: "w1" },
      { type: "select-pane", pane_id: "w1:p9", machine_id: "pc2", workspace_id: "w1" },
    ]);
    const cold = notifications([]);
    await cold.click("w1:p9", "pc2", "w1");
    expect(cold.opened).toEqual(["/?machine=pc2&ws=w1&pane=w1%3Ap9&view=chat"]);
  });

  it("selects the pane before a delayed focus and repeats after the page resumes", async () => {
    const pending = deferred();
    const target = client(() => pending.promise);
    const worker = notifications([target]);
    const done = worker.click("remote pane/?", "remote&pc");
    await Promise.resolve();
    const selection = { type: "select-pane", pane_id: "remote pane/?", machine_id: "remote&pc" };
    expect(target.selected).toEqual([selection]);
    expect(worker.opened).toEqual([]);
    pending.resolve();
    await done;
    expect(target.selected).toEqual([selection, selection]);
    expect(worker.opened).toEqual([]);
    expect(worker.closed()).toBe(1);
  });

  it("keeps selection on focus rejection and opens the exact remote pane once", async () => {
    const target = client(async () => { throw new Error("NotAllowedError"); });
    const worker = notifications([target]);
    await worker.click("remote pane/?", "remote&pc");
    expect(target.selected).toEqual([{ type: "select-pane", pane_id: "remote pane/?", machine_id: "remote&pc" }]);
    expect(worker.opened).toEqual(["/?machine=remote%26pc&pane=remote%20pane%2F%3F&view=chat"]);
  });

  it("chooses the focused window and does not open another after a successful focus", async () => {
    const background = client();
    const foreground = client(undefined, true);
    const worker = notifications([background, foreground]);
    await worker.click();
    expect(background.selected).toEqual([]);
    expect(foreground.selected).toHaveLength(2);
    expect(worker.opened).toEqual([]);
  });

  it("opens a pane URL when no app window exists, and root when no pane was supplied", async () => {
    const worker = notifications([]);
    await worker.click("pane-b", "remote");
    await worker.click(null);
    expect(worker.opened).toEqual(["/?machine=remote&pane=pane-b&view=chat", "/"]);
  });

  it("opens a pane notification in the Agent chat view in existing and cold windows", async () => {
    const existing = client();
    const openWorker = notifications([existing]);
    await openWorker.click("pi-pane", "local");
    expect(existing.views).toEqual(["chat", "chat"]);
    expect(openWorker.opened).toEqual([]);

    const coldWorker = notifications([]);
    await coldWorker.click("pi-pane", "local");
    expect(coldWorker.opened).toEqual(["/?machine=local&pane=pi-pane&view=chat"]);
  });

  it("focuses a generic notification without sending an empty pane selection", async () => {
    let focused = 0;
    const target = client(async () => { focused++; });
    const worker = notifications([target]);
    await worker.click(null);
    expect(focused).toBe(1);
    expect(target.selected).toEqual([]);
    expect(worker.opened).toEqual([]);
  });

  it("a late focus cannot switch away from a more recently tapped notification", async () => {
    const pending = deferred();
    let focuses = 0;
    const target = client(() => ++focuses === 1 ? pending.promise : Promise.resolve());
    const worker = notifications([target]);
    const first = worker.click("pane-a");
    await Promise.resolve();
    await worker.click("pane-b");
    pending.resolve();
    await first;
    expect(target.selected.map((selection) => selection.pane_id)).toEqual(["pane-a", "pane-b", "pane-b", "pane-b"]);
    expect(worker.opened).toEqual([]);
  });

  it("a superseded focus rejection cannot open a stale duplicate window", async () => {
    const pending = deferred();
    let focuses = 0;
    const target = client(() => ++focuses === 1 ? pending.promise : Promise.resolve());
    const worker = notifications([target]);
    const first = worker.click("pane-a");
    await Promise.resolve();
    await worker.click("pane-b");
    pending.reject(new Error("NotAllowedError"));
    await first;
    expect(target.selected.map((selection) => selection.pane_id)).toEqual(["pane-a", "pane-b", "pane-b"]);
    expect(worker.opened).toEqual([]);
  });

  it("a slow client lookup cannot deliver an older tap after the newer one", async () => {
    const pending = deferred();
    let lookups = 0;
    const target = client();
    const worker = notifications([target], async () => {
      if (++lookups === 1) await pending.promise;
      return [target];
    });
    const first = worker.click("pane-a");
    await worker.click("pane-b");
    pending.resolve();
    await first;
    expect(target.selected.map((selection) => selection.pane_id)).toEqual(["pane-b", "pane-b"]);
    expect(worker.opened).toEqual([]);
  });

  it("an older client foregrounded last shows the newest notification's exact PC and pane", async () => {
    const pending = deferred();
    let foreground = "";
    let focuses = 0;
    const older = client(async () => { focuses++; await pending.promise; foreground = "older"; });
    const newer = client(async () => { focuses++; foreground = "newer"; }, true);
    let lookups = 0;
    const worker = notifications([older], async () => ++lookups === 1 ? [older] : [newer, older]);
    const first = worker.click("pane-a", "local");
    await Promise.resolve();
    const selection = { type: "select-pane", pane_id: "latest pane/?", machine_id: "remote&pc" };
    // The newer focus must finish even while the older window's focus is hung.
    await worker.click(selection.pane_id, selection.machine_id);
    expect(foreground).toBe("newer");
    pending.resolve();
    await first;
    expect(foreground).toBe("older");
    expect(older.selected.at(-1)).toEqual(selection);
    expect(newer.selected.at(-1)).toEqual(selection);
    expect(focuses).toBe(2); // one focus per tap, no repair focus loop
    expect(worker.opened).toEqual([]);
  });

  it("repairs an old focused client while the newest notification's lookup is still pending", async () => {
    const focus = deferred();
    const lookup = deferred();
    let foreground = "";
    const older = client(async () => { await focus.promise; foreground = "older"; });
    const newer = client(async () => { foreground = "newer"; }, true);
    let lookups = 0;
    const worker = notifications([older], async () => {
      if (++lookups === 1) return [older];
      await lookup.promise;
      return [newer, older];
    });
    const first = worker.click("pane-a");
    await Promise.resolve();
    const selection = { type: "select-pane", pane_id: "pane-b", machine_id: "second/pc" };
    const second = worker.click(selection.pane_id, selection.machine_id);
    focus.resolve();
    await first;
    expect(foreground).toBe("older");
    expect(older.selected.at(-1)).toEqual(selection);
    expect(newer.selected).toEqual([]);
    lookup.resolve();
    await second;
    expect(foreground).toBe("newer");
    expect(newer.selected.at(-1)).toEqual(selection);
    expect(worker.opened).toEqual([]);
  });

  it("a rejected old client does not reopen its pane after another client was focused", async () => {
    const pending = deferred();
    let foreground = "";
    const older = client(() => pending.promise);
    const newer = client(async () => { foreground = "newer"; }, true);
    let lookups = 0;
    const worker = notifications([older], async () => ++lookups === 1 ? [older] : [newer, older]);
    const first = worker.click("pane-a");
    await Promise.resolve();
    await worker.click("pane-b", "remote");
    pending.reject(new Error("NotAllowedError"));
    await first;
    expect(foreground).toBe("newer");
    expect(newer.selected.at(-1)).toEqual({ type: "select-pane", pane_id: "pane-b", machine_id: "remote" });
    expect(older.selected).toEqual([{ type: "select-pane", pane_id: "pane-a", machine_id: "local" }]);
    expect(worker.opened).toEqual([]);
  });

  for (const fallback of [false, true]) {
    it(`a delayed ${fallback ? "focus fallback" : "cold app"} window shows the latest tap when it opens last`, async () => {
      const opening = deferred();
      const ready = deferred();
      let foreground = "";
      let focuses = 0;
      const refused = client(async () => { focuses++; throw new Error("NotAllowedError"); });
      const newer = client(async () => { focuses++; foreground = "newer"; }, true);
      const opened = client();
      let lookups = 0;
      const worker = notifications([], async () => {
        if (++lookups > 1) return [newer];
        return fallback ? [refused] : [];
      }, async () => {
        opening.resolve();
        await ready.promise;
        foreground = "opened";
        return opened;
      });
      const first = worker.click("older pane/?", "first&pc");
      await opening.promise;
      const selection = { type: "select-pane", pane_id: "latest pane/?", machine_id: "remote&pc" };
      // A frozen open must not hold up a later click on an existing window.
      await worker.click(selection.pane_id, selection.machine_id);
      expect(foreground).toBe("newer");
      ready.resolve();
      await first;
      expect(foreground).toBe("opened");
      expect(opened.selected.at(-1)).toEqual(selection);
      expect(newer.selected.at(-1)).toEqual(selection);
      expect(worker.opened).toEqual(["/?machine=first%26pc&pane=older%20pane%2F%3F&view=chat"]);
      expect(focuses).toBe(fallback ? 2 : 1);
    });
  }

  it("repairs an opened window while the newest notification's client lookup is still pending", async () => {
    const opening = deferred();
    const ready = deferred();
    const lookup = deferred();
    const opened = client();
    const newer = client();
    let lookups = 0;
    const worker = notifications([], async () => {
      if (++lookups === 1) return [];
      await lookup.promise;
      return [newer];
    }, async () => {
      opening.resolve();
      await ready.promise;
      return opened;
    });
    const first = worker.click("pane-a");
    await opening.promise;
    const selection = { type: "select-pane", pane_id: "pane-b", machine_id: "second/pc" };
    const second = worker.click(selection.pane_id, selection.machine_id);
    ready.resolve();
    await first;
    expect(opened.selected.at(-1)).toEqual(selection);
    expect(newer.selected).toEqual([]);
    lookup.resolve();
    await second;
    expect(newer.selected.at(-1)).toEqual(selection);
    expect(worker.opened).toEqual(["/?machine=local&pane=pane-a&view=chat"]);
  });
});
