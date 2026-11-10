import { describe, expect, it, spyOn } from "bun:test";
import type { PendingMessage } from "../../shared/protocol.ts";
import { PendingMessageStore, frameRemovals } from "./pendingMessages.ts";

const storage = () => {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
};
/** a held receipt frame as the bridge sends it now (its clock = this page's): each ID with the ms it has left */
const heldFrame = (left: Record<string, unknown>, sentAt = Date.now()) => ({ held: Object.keys(left), held_ms: left, server_time: sentAt,
  held_until: Object.fromEntries(Object.entries(left).map(([id, ms]) => [id, typeof ms === "number" ? sentAt + ms : ms])) });
/** why the bridge holds a message it was not asked to hold: every such hold names its reason (server/pending-input.ts) */
const HELD_REASON = { code: "pending_lease_lost", message: "The pane connection changed; send this message explicitly after reviewing it" };
/** A message as the bridge sends it. One it holds for a reason of its own carries that reason; `requested` is the other kind. */
const message = (id: string, state: PendingMessage["state"] = "queued", text = "check the tests"): PendingMessage => ({ id, request_id: 1, text, state, created_at: "2026-10-06T00:00:00Z", ...(state === "held" ? { error: HELD_REASON } : {}) });
/** A message its sender asked the bridge to hold (`delivery: "hold"`: Alt+Enter, or automatic sending off): held, with no reason. */
const requested = (id: string, text = "check the tests"): PendingMessage => ({ id, request_id: 1, text, state: "held", created_at: "2026-10-06T00:00:00Z" });

describe("pending message ownership", () => {
  it("keeps a hold its sender asked for held, with Send now, through a lost connection, a reload, a restarted bridge and a refused send; it takes no receipt's end", () => {
    let now = Date.parse("2026-11-10T00:00:00Z");
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const port = storage(), page = new PendingMessageStore(() => port);
      const shown = (store: PendingMessageStore) => store.read("p").map(({ id, state, serverOwned, heldByRequest, heldUntil }) => [id, state, serverOwned, heldByRequest ?? false, heldUntil ?? null]);
      // Alt+Enter, or a follow-up with automatic sending off: the bridge holds it at once, with no reason
      page.publish("p", [requested("asked")], [], "first");
      expect(shown(page)).toEqual([["asked", "held", true, true, null]]);
      // the connection is lost
      page.suspendScope("first");
      expect(shown(page)).toEqual([["asked", "held", false, true, null]]);
      // a reload, and another tab, read it from what was saved
      expect(shown(new PendingMessageStore(() => port))).toEqual([["asked", "held", false, true, null]]);
      // a bridge that restarted knows nothing of it: an empty snapshot and no receipt
      page.publish("p", [], [], "second");
      expect(shown(page)).toEqual([["asked", "held", false, true, null]]);
      // a bridge that kept its held receipt tells it: the copy takes no end from it, so ten minutes later it is still held
      page.publish("p", [], frameRemovals(heldFrame({ asked: 60_000 }, now)), "second");
      expect(shown(page)).toEqual([["asked", "held", false, true, null]]);
      now += 10 * 60 * 1000 + 1;
      expect(shown(page)).toEqual([["asked", "held", false, true, null]]);
      expect(shown(new PendingMessageStore(() => port))).toEqual([["asked", "held", false, true, null]]);
      // the old connection's answer coming late, with no connection left to prove it, changes nothing
      page.accept("p", requested("asked"), null);
      expect(shown(page)).toEqual([["asked", "held", false, true, null]]);
      // its Send now refused with nothing typed (a menu is up): held as it was, now with the reason, after a reload too
      expect(page.begin("p", "asked")).toBe(true);
      expect(page.unconfirm("p", "asked")).toBe(true);
      expect(new PendingMessageStore(() => port).read("p")[0]).toMatchObject({ state: "uncertain", resendInFlight: true });
      page.fail("p", "asked", { code: "agent_blocked", message: "The agent is waiting for an answer in the terminal" }, false, 0);
      page.end("p", "asked");
      expect(page.read("p")[0]).toMatchObject({ state: "held", heldByRequest: true, error: { code: "agent_blocked" } });
      expect(new PendingMessageStore(() => port).read("p")[0]).toMatchObject({ state: "held", heldByRequest: true, error: { code: "agent_blocked" } });
      // the bridge giving it a reason while it holds it (its pane changed) does not make it another kind of hold
      const live = new PendingMessageStore(() => storage());
      live.publish("p", [requested("asked")], [], "first");
      live.publish("p", [{ ...requested("asked"), error: HELD_REASON }], [], "first");
      live.suspendScope("first");
      expect(shown(live)).toEqual([["asked", "held", false, true, null]]);
    } finally { clock.mockRestore(); }
  });
  it("never offers a hold its sender asked for again once its send may have typed it, or once it was discarded", () => {
    const port = storage(), page = new PendingMessageStore(() => port);
    page.publish("p", [requested("going"), requested("gone")], [], "first");
    page.suspendScope("first");
    // Send now left the page and the connection dropped before any answer: it may have been typed
    expect(page.begin("p", "going")).toBe(true);
    expect(page.unconfirm("p", "going")).toBe(true);
    page.fail("p", "going", { code: "disconnected", message: "The connection closed before the send was confirmed" }, true, 0);
    page.end("p", "going");
    expect(page.read("p").find((row) => row.id === "going")).toMatchObject({ state: "uncertain", resendInFlight: true });
    expect(new PendingMessageStore(() => port).read("p").find((row) => row.id === "going")?.state).toBe("uncertain");
    // a held receipt that still names it does not hold it again either
    page.publish("p", [], [{ id: "going", outcome: "held", resumed: true, until: Date.now() + 60_000 }], "second");
    expect(page.read("p").find((row) => row.id === "going")?.state).toBe("uncertain");
    // discarded here, then written back by a tab that still had it: not held again on this page
    const stale = port.getItem("ovis:pending:p")!;
    page.removeCopy("p", "gone");
    expect(page.read("p").map((row) => row.id)).toEqual(["going"]);
    port.setItem("ovis:pending:p", stale);
    page.refresh("p");
    expect(page.read("p").find((row) => row.id === "gone")?.state).toBe("uncertain");
  });
  it("ends a receipt's proof with the connection that brought it, not with another PC's", () => {
    const port = storage(), page = new PendingMessageStore(() => port);
    const state = (owner: string) => page.read(owner).map((row) => row.state);
    // a page that shows two PCs: PC B's queued follow-up was held as B's connection closed, and B's next connection proved it
    page.accept("pc-a:pane", message("a"), "A");
    page.accept("pc-b:pane", message("b"), "B-old");
    page.suspendScope("B-old");
    page.publish("pc-b:pane", [], frameRemovals(heldFrame({ b: 60_000 })), "B-new");
    // B also told held IDs for panes whose copies this page has not read yet
    page.publish("pc-b:later", [], frameRemovals(heldFrame({ later: 60_000 })), "B-new");
    page.publish("pc-b:gone", [], frameRemovals(heldFrame({ gone: 60_000 })), "B-new");
    expect(page.read("pc-b:pane")[0]).toMatchObject({ state: "held", heldBy: "B-new" });
    // PC A's connection drops: A's own row is uncertain, and everything B's connection proved stays
    page.suspendScope("A");
    expect(state("pc-a:pane")).toEqual(["uncertain"]);
    expect(state("pc-b:pane")).toEqual(["held"]);
    port.setItem("ovis:pending:pc-b:later", JSON.stringify({ messages: [message("later")] }));
    page.refresh("pc-b:later");
    expect(state("pc-b:later")).toEqual(["held"]);
    // saved, a receipt's copy is uncertain whichever connection brought it
    expect(new PendingMessageStore(() => port).read("pc-b:pane").map((row) => row.state)).toEqual(["uncertain"]);
    // B's own connection drops: its proofs end, the remembered one too
    page.suspendScope("B-new");
    expect(state("pc-b:pane")).toEqual(["uncertain"]);
    expect(state("pc-b:later")).toEqual(["uncertain"]);
    port.setItem("ovis:pending:pc-b:gone", JSON.stringify({ messages: [message("gone")] }));
    page.refresh("pc-b:gone");
    expect(state("pc-b:gone")).toEqual(["uncertain"]);
  });
  it("keeps a requested hold's mark when a tab on an older bundle saves the list without it", () => {
    const port = storage(), page = new PendingMessageStore(() => port);
    const refused = { code: "agent_blocked", message: "The agent is waiting for an answer in the terminal" };
    page.publish("p", [requested("asked"), requested("going"), requested("other")], [], "first");
    page.suspendScope("first");
    // A tab opened before the update shares the storage and drops the fields it does not know. Its Send now of one
    // was refused with nothing typed (held, now with a reason); another's connection dropped mid-send; and under the
    // third ID it saved another text
    port.setItem("ovis:pending:p", JSON.stringify({ version: 1, messages: [
      { ...requested("asked"), error: refused, resendGeneration: 1 },
      { ...requested("going"), state: "uncertain", resendInFlight: true },
      { ...requested("other", "another text"), error: refused },
    ] }));
    page.refresh("p");
    // this page knows the first two were asked for: the refused one is held as it was, the ambiguous one stays uncertain
    expect(page.read("p").map(({ id, state, heldByRequest }) => [id, state, heldByRequest ?? false]))
      .toEqual([["asked", "held", true], ["going", "uncertain", true], ["other", "uncertain", false]]);
    expect(page.read("p")[0]?.error).toEqual(refused);
    // and the mark is saved again, so a page opened later reads the refused one held too
    expect(new PendingMessageStore(() => port).read("p").map(({ id, state, heldByRequest }) => [id, state, heldByRequest ?? false]))
      .toEqual([["asked", "held", true], ["going", "uncertain", true], ["other", "uncertain", false]]);
    // one this page discarded is not held again by the older tab's stale copy
    page.removeCopy("p", "asked");
    port.setItem("ovis:pending:p", JSON.stringify({ version: 1, messages: [{ ...requested("asked"), error: refused }] }));
    page.refresh("p");
    expect(page.read("p").map(({ id, state }) => [id, state])).toEqual([["asked", "uncertain"]]);
  });
  it("tells the two kinds of held copy apart by the bridge's reason: only the one its sender asked for is held on its saved copy's word", () => {
    const port = storage(), page = new PendingMessageStore(() => port);
    // a follow-up queued and then held as its connection closed, one the bridge held for its own reason, and one its sender asked to hold
    page.publish("p", [message("queued"), message("faulted", "held"), requested("asked")], [], "first");
    expect(page.read("p").map(({ id, state, heldByRequest }) => [id, state, heldByRequest ?? false])).toEqual([["queued", "queued", false], ["faulted", "held", false], ["asked", "held", true]]);
    page.suspendScope("first");
    const states = (store: PendingMessageStore) => store.read("p").map(({ id, state }) => [id, state]);
    expect(states(page)).toEqual([["queued", "uncertain"], ["faulted", "uncertain"], ["asked", "held"]]);
    expect(states(new PendingMessageStore(() => port))).toEqual([["queued", "uncertain"], ["faulted", "uncertain"], ["asked", "held"]]);
    // the bridge's held receipt proves the other two untyped, on this page only and until its end
    page.publish("p", [], frameRemovals(heldFrame({ queued: 60_000, faulted: 60_000, asked: 60_000 })), "second");
    expect(page.read("p").map(({ id, state, heldUntil }) => [id, state, heldUntil !== undefined])).toEqual([["queued", "held", true], ["faulted", "held", true], ["asked", "held", false]]);
    expect(states(new PendingMessageStore(() => port))).toEqual([["queued", "uncertain"], ["faulted", "uncertain"], ["asked", "held"]]);
    // any later disconnect ends those proofs, and leaves the asked one held
    page.suspendScope("second");
    expect(states(page)).toEqual([["queued", "uncertain"], ["faulted", "uncertain"], ["asked", "held"]]);
    // copies an older release saved carry no mark: held with no reason is one its sender asked for, held with a reason is not
    const old = storage();
    old.setItem("ovis:pending:p", JSON.stringify({ version: 1, messages: [requested("asked"), message("faulted", "held"), message("queued")] }));
    expect(new PendingMessageStore(() => old).read("p").map(({ id, state, heldByRequest }) => [id, state, heldByRequest ?? false]))
      .toEqual([["asked", "held", true], ["faulted", "uncertain", false], ["queued", "uncertain", false]]);
  });
  it("settles a follow-up's exact resumed receipt after reload, never a same-text or live-owned row (#2421)", () => {
    const port = storage(), before = new PendingMessageStore(() => port);
    before.accept("p", message("delivered", "sending", "same"), "old");
    before.accept("p", message("unproved", "sending", "same"), "old");
    before.suspendScope("old");
    const store = new PendingMessageStore(() => port);
    store.accept("p", message("live", "sending", "same"), "other");
    // a plain receipt for a saved copy proves nothing about it
    store.publish("p", [], [{ id: "unproved", outcome: "sent" }], "new");
    expect(store.read("p").map((row) => row.id)).toEqual(["delivered", "unproved", "live"]);
    store.publish("p", [], [{ id: "delivered", outcome: "sent", resumed: true }, { id: "live", outcome: "sent", resumed: true }], "new");
    expect(store.read("p").map((row) => row.id)).toEqual(["unproved", "live"]);
    // an old tab's saved copy and a late acceptance cannot bring the settled id back
    port.setItem("ovis:pending:p", JSON.stringify({ messages: [message("delivered", "sending", "same")] }));
    store.refresh("p");
    store.accept("p", message("delivered", "sending", "same"), "late");
    // (that tab's save replaced the other saved row; the live connection's row stays)
    expect(store.read("p").map((row) => row.id)).toEqual(["live"]);
    // another pane's receipt settles nothing here
    store.publish("other", [], [{ id: "live", outcome: "sent", resumed: true }], "new");
    expect(store.read("p").map((row) => row.id)).toEqual(["live"]);
  });
  it("keeps a resumed receipt that came before another tab saved its copy (#2421)", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    store.publish("p", [], [{ id: "early", outcome: "sent", resumed: true }], "new");
    port.setItem("ovis:pending:p", JSON.stringify({ messages: [message("early", "sending"), message("other", "sending")] }));
    store.refresh("p");
    expect(store.read("p").map((row) => row.id)).toEqual(["other"]);
  });
  it("recovers a disconnected queued message as held when its resumed held receipt arrives, without rearming an in-flight resend", () => {
    const port = storage(), before = new PendingMessageStore(() => port);
    before.accept("p", message("queued"), "old");
    before.accept("p", message("unproved"), "old");
    before.suspendScope("old");
    expect(before.read("p").map(({ id, state, serverOwned }) => [id, state, serverOwned])).toEqual([
      ["queued", "uncertain", false], ["unproved", "uncertain", false],
    ]);
    before.publish("p", [], [{ id: "queued", outcome: "held", resumed: true, until: Date.now() + 60_000 }, { id: "early", outcome: "held", resumed: true, until: Date.now() + 60_000 }], "new");
    expect(before.read("p").map(({ id, state, serverOwned }) => [id, state, serverOwned])).toEqual([
      ["queued", "held", false], ["unproved", "uncertain", false],
    ]);
    // The receipt's proof is this page's alone: saved, the copy is uncertain until a new receipt proves it after a reload.
    // An early resumed held receipt recovers a copy saved later by another tab.
    const reloaded = new PendingMessageStore(() => port);
    expect(reloaded.read("p").map(({ id, state, serverOwned }) => [id, state, serverOwned])).toEqual([
      ["queued", "uncertain", false], ["unproved", "uncertain", false],
    ]);
    // another tab saves the list: its copy of the one this page holds on a receipt is uncertain, as every page saves it
    port.setItem("ovis:pending:p", JSON.stringify({ messages: [message("queued", "uncertain"), message("early", "queued")] }));
    before.refresh("p");
    expect(before.read("p").map(({ id, state, serverOwned }) => [id, state, serverOwned])).toEqual([
      ["queued", "held", false], ["early", "held", false],
    ]);
    // Once a held copy's explicit resend starts, a duplicate resumed held receipt never clears its unconfirmed mark.
    expect(before.begin("p", "queued")).toBe(true);
    expect(before.unconfirm("p", "queued")).toBe(true);
    before.publish("p", [], [{ id: "queued", outcome: "held", resumed: true, until: Date.now() + 60_000 }], "new");
    expect(new PendingMessageStore(() => port).read("p").find((row) => row.id === "queued")?.state).toBe("uncertain");
    before.end("p", "queued");
    // A terminal resumed receipt settles the held copy.
    before.publish("p", [], [{ id: "early", outcome: "sent", resumed: true }], "new");
    expect(before.read("p").map((row) => row.id)).toEqual(["queued"]);
  });
  it("applies a resumed held ID once: another tab's later send of that copy is never offered again", () => {
    const port = storage(), tab = new PendingMessageStore(() => port);
    tab.accept("p", message("saved"), "old");
    tab.suspendScope("old");
    tab.publish("p", [], [{ id: "saved", outcome: "held", resumed: true, until: Date.now() + 60_000 }], "new");
    expect(tab.read("p").map(({ id, state }) => [id, state])).toEqual([["saved", "held"]]);
    // the other tab sends it, and the outcome is not confirmed
    for (const state of ["sending", "uncertain"] as const) {
      port.setItem("ovis:pending:p", JSON.stringify({ messages: [{ ...message("saved", state), error: { code: "pasted_not_sent", message: "not confirmed" } }] }));
      tab.refresh("p");
      expect(tab.read("p").map(({ id, state }) => [id, state])).toEqual([["saved", "uncertain"]]);
    }
    expect(new PendingMessageStore(() => port).read("p").map(({ id, state }) => [id, state])).toEqual([["saved", "uncertain"]]);
  });
  it("holds a copy only on a fresh receipt: one older than the bridge's ten minutes proves nothing", () => {
    let now = Date.parse("2026-11-08T00:00:00Z");
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const port = storage(), tab = new PendingMessageStore(() => port);
      // an early receipt, for a copy another tab saves only after the bridge's window has passed
      tab.publish("p", [], [{ id: "late", outcome: "held", resumed: true, until: Date.now() + 60_000 }], "new");
      now += 10 * 60 * 1000 + 1;
      port.setItem("ovis:pending:p", JSON.stringify({ messages: [message("late", "queued")] }));
      tab.refresh("p");
      expect(tab.read("p").map(({ id, state }) => [id, state])).toEqual([["late", "uncertain"]]);
      // a fresh one still holds it, and another tab's unrelated save keeps it held on this page only
      tab.publish("p", [], [{ id: "late", outcome: "held", resumed: true, until: Date.now() + 60_000 }], "newer");
      expect(tab.read("p").map(({ id, state }) => [id, state])).toEqual([["late", "held"]]);
      port.setItem("ovis:pending:p", JSON.stringify({ messages: [message("late", "uncertain"), message("other", "uncertain")] }));
      tab.refresh("p");
      expect(tab.read("p").map(({ id, state }) => [id, state])).toEqual([["late", "held"], ["other", "uncertain"]]);
      expect(new PendingMessageStore(() => port).read("p").map(({ id, state }) => [id, state])).toEqual([["late", "uncertain"], ["other", "uncertain"]]);
    } finally { clock.mockRestore(); }
  });
  it("keeps a receipt's held copy this page's alone: a late held answer saves it uncertain, another tab's send is never held again", () => {
    const port = storage(), tab = new PendingMessageStore(() => port);
    tab.accept("p", message("late"), "old");
    tab.accept("p", message("sent"), "old");
    tab.suspendScope("old");
    tab.publish("p", [], [{ id: "late", outcome: "held", resumed: true, until: Date.now() + 60_000 }, { id: "sent", outcome: "held", resumed: true, until: Date.now() + 60_000 }], "new");
    expect(tab.read("p").map(({ id, state }) => [id, state])).toEqual([["late", "held"], ["sent", "held"]]);
    // the old connection's late answer says held: still no proof for the next page
    tab.accept("p", message("late", "held"), null);
    expect(tab.read("p").find((row) => row.id === "late")?.state).toBe("held");
    expect(new PendingMessageStore(() => port).read("p").map(({ id, state }) => [id, state])).toEqual([["late", "uncertain"], ["sent", "uncertain"]]);
    // another tab saves the copy as being sent, with no mark or error: this page does not hold it again
    // (the late answer's copy is saved as this page left it: uncertain, with the bridge's reason)
    port.setItem("ovis:pending:p", JSON.stringify({ messages: [{ ...message("late", "held"), state: "uncertain" }, message("sent", "sending")] }));
    tab.refresh("p");
    expect(tab.read("p").map(({ id, state }) => [id, state])).toEqual([["late", "held"], ["sent", "uncertain"]]);
  });
  it("ends a receipt's held copy with the bridge's receipt: uncertain once its time passes, one timer to it, cleared on discard", () => {
    let now = Date.parse("2026-11-08T00:00:00Z");
    const timers: Array<{ run: () => void; ms: number; cleared: boolean }> = [];
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const set = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, ms: number) => {
      const timer = { run, ms, cleared: false };
      timers.push(timer);
      return timer;
    }) as unknown as typeof setTimeout);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((timer: { cleared: boolean } | undefined) => { if (timer) timer.cleared = true; }) as unknown as typeof clearTimeout);
    const active = () => timers.filter((timer) => !timer.cleared);
    try {
      const port = storage(), tab = new PendingMessageStore(() => port);
      let told = 0;
      tab.subscribe(() => { told++; });
      for (const id of ["read", "timed", "discarded"]) tab.accept("p", message(id), "old");
      tab.suspendScope("old");
      tab.publish("p", [], frameRemovals(heldFrame({ read: 60_000, timed: 90_000, discarded: 120_000 })), "new");
      expect(tab.read("p").map(({ id, state }) => [id, state])).toEqual([["read", "held"], ["timed", "held"], ["discarded", "held"]]);
      // one timer, to the first proof's end
      expect(active().map(({ ms }) => ms)).toEqual([60_000]);
      now += 59_999;
      expect(tab.read("p")[0]!.state).toBe("held");
      // past it, the next read (a render, or the Send now press reading the row) finds it uncertain, timer or not
      now += 1;
      expect(tab.read("p").map(({ id, state }) => [id, state])).toEqual([["read", "uncertain"], ["timed", "held"], ["discarded", "held"]]);
      // the timer ends the next one when its time comes, and tells the page
      now += 30_000;
      const before = told;
      for (const timer of active()) { timer.cleared = true; timer.run(); }
      expect(told).toBeGreaterThan(before);
      expect(tab.read("p").map(({ id, state }) => [id, state])).toEqual([["read", "uncertain"], ["timed", "uncertain"], ["discarded", "held"]]);
      expect(active().map(({ ms }) => ms)).toEqual([30_000]);
      // a discarded copy's timer goes with it
      tab.removeCopy("p", "discarded");
      expect(active()).toEqual([]);
      // the saved copies were never held
      expect(new PendingMessageStore(() => port).read("p").map(({ id, state }) => [id, state])).toEqual([["read", "uncertain"], ["timed", "uncertain"]]);
    } finally { clock.mockRestore(); set.mockRestore(); clear.mockRestore(); }
  });
  it("never lets a proof outlive the bridge's receipt: a late held answer, a shorter replay, a frame that waited", () => {
    let now = Date.parse("2026-11-08T00:00:00Z");
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const port = storage(), tab = new PendingMessageStore(() => port);
      for (const id of ["late", "short", "waited"]) tab.accept("p", message(id), "old");
      tab.suspendScope("old");
      // a frame that waited 20 s (for its snapshot) still ends when the bridge's receipt does
      const waited = frameRemovals(heldFrame({ waited: 30_000 }));
      now += 20_000;
      tab.publish("p", [], [...frameRemovals(heldFrame({ late: 1_000, short: 60_000 })), ...waited], "new");
      expect(tab.read("p").map(({ id, state }) => [id, state])).toEqual([["late", "held"], ["short", "held"], ["waited", "held"]]);
      // a replay that ends sooner shortens the proof
      tab.publish("p", [], frameRemovals(heldFrame({ short: 5_000 })), "newer");
      now += 10_001;
      expect(tab.read("p").map(({ id, state }) => [id, state])).toEqual([["late", "uncertain"], ["short", "uncertain"], ["waited", "uncertain"]]);
      // the old connection's late held answer for an ended proof is no proof
      tab.accept("p", message("late", "held"), null);
      expect(tab.read("p").find((row) => row.id === "late")?.state).toBe("uncertain");
    } finally { clock.mockRestore(); }
  });
  it("shows a held row without a live proof as uncertain: after its connection ends, in another tab, after a reload", () => {
    const port = storage(), live = new PendingMessageStore(() => port);
    live.accept("p", message("held", "held"), "connection");
    expect(live.read("p").map(({ state }) => state)).toEqual(["held"]);
    // another tab, or the page after a reload: the saved copy proves nothing
    expect(new PendingMessageStore(() => port).read("p").map(({ state }) => state)).toEqual(["uncertain"]);
    // the connection ends: no proof is left on this page either
    live.suspendScope("connection");
    expect(live.read("p").map(({ state }) => state)).toEqual(["uncertain"]);
    // and that connection's late held answer, with no connection left to prove it, is no proof either
    live.accept("p", message("held", "held"), null);
    expect(live.read("p").map(({ state }) => state)).toEqual(["uncertain"]);
  });
  it("takes a held ID only with a valid time left: any other shape proves nothing", () => {
    const ids = (frame: Parameters<typeof frameRemovals>[0]) => frameRemovals(frame).map((removal) => removal.id);
    expect(ids({ ...heldFrame({ held: 1_000 }), held: "held" })).toEqual([]);
    expect(ids({ ...heldFrame({ held: 1_000 }), held: ["held", 4] })).toEqual([]);
    expect(ids({ held: ["held"] })).toEqual([]);
    expect(ids({ ...heldFrame({ held: 1_000 }), held_ms: "1000" })).toEqual([]);
    for (const ms of [Number.NaN, Infinity, 0, -1, 10 * 60 * 1000 + 1, "1000"]) expect(ids({ ...heldFrame({ held: 1_000 }), held_ms: { held: ms } })).toEqual([]);
    // no end on the PC's clock, or no clock to reckon it by (a bridge that names neither): no proof
    const { held_until: _until, ...noEnd } = heldFrame({ held: 1_000 });
    const { server_time: _time, ...noClock } = heldFrame({ held: 1_000 });
    expect(ids(noEnd)).toEqual([]);
    expect(ids(noClock)).toEqual([]);
    expect(ids({ ...heldFrame({ held: 1_000 }), held_until: { held: Date.now() + 10 * 60 * 1000 + 1 } })).toEqual([]);
    expect(ids({ ...heldFrame({ held: 1_000 }), held: ["held", "other"] })).toEqual(["held"]);
    // a frame with no held proof leaves a saved copy uncertain
    const port = storage(), tab = new PendingMessageStore(() => port);
    tab.accept("p", message("held"), "old");
    tab.suspendScope("old");
    tab.publish("p", [], frameRemovals(heldFrame({ held: 10 * 60 * 1000 + 1 })), "new");
    expect(tab.read("p").map(({ state }) => state)).toEqual(["uncertain"]);
  });
  it("never holds a copy past the bridge's own end: a late features frame, a late held frame, one that came after the end", () => {
    let now = Date.parse("2026-11-08T00:00:00Z");
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      // the PC's clock runs an hour behind this page's; the bridge's receipt ends at bridgeEnd on its clock
      const behind = 60 * 60 * 1000, pc = () => now - behind, bridgeEnd = pc() + 10 * 60 * 1000;
      const until = (removals: ReturnType<typeof frameRemovals>) => removals.map((removal) => removal.outcome === "held" ? removal.until : undefined);
      // a features frame that took 60 s gives an offset 60 s too high: a held frame on time gives the true one, and the least wins
      const lateFeatures = behind + 60_000;
      now += 9 * 60 * 1000;
      expect(until(frameRemovals({ held: ["a"], held_ms: { a: 60_000 }, held_until: { a: bridgeEnd }, server_time: pc() }, lateFeatures))).toEqual([bridgeEnd + behind]);
      // a held frame that took 60 s, after a features frame on time: the features frame's offset wins
      const sent = pc();
      now += 60_000;
      expect(until(frameRemovals({ held: ["b"], held_ms: { b: 60_000 }, held_until: { b: bridgeEnd }, server_time: sent }, behind))).toEqual([bridgeEnd + behind]);
      // with nothing better, never later than its arrival plus the time the bridge said was left
      expect(until(frameRemovals({ held: ["c"], held_ms: { c: bridgeEnd - sent }, held_until: { c: bridgeEnd }, server_time: sent }))).toEqual([now + (bridgeEnd - sent)]);
      // a held frame sent 30 s before the end that arrives after it: nothing to send
      const port = storage(), tab = new PendingMessageStore(() => port);
      tab.accept("p", message("d"), "old");
      tab.suspendScope("old");
      const sentLate = bridgeEnd - 30_000;
      now = bridgeEnd + behind + 1_000;
      tab.publish("p", [], frameRemovals({ held: ["d"], held_ms: { d: 30_000 }, held_until: { d: bridgeEnd }, server_time: sentLate }, behind), "new");
      expect(tab.read("p").map(({ id, state }) => [id, state])).toEqual([["d", "uncertain"]]);
    } finally { clock.mockRestore(); }
  });
  it("ends every receipt's proof with any disconnect: a reconnect to a bridge that kept no receipt leaves the copy uncertain", () => {
    const port = storage(), tab = new PendingMessageStore(() => port);
    tab.accept("p", message("x"), "c1");
    tab.suspendScope("c1");
    tab.publish("p", [], frameRemovals(heldFrame({ x: 60_000, early: 60_000 })), "c2");
    expect(tab.read("p").map(({ id, state }) => [id, state])).toEqual([["x", "held"]]);
    // the second connection drops; the next one is to a restarted bridge, which kept no receipt
    tab.suspendScope("c2");
    tab.publish("p", [], [], "c3");
    expect(tab.read("p").map(({ id, state }) => [id, state])).toEqual([["x", "uncertain"]]);
    // the remembered early ID ended with it: another tab's copy saved now is not held either
    port.setItem("ovis:pending:p", JSON.stringify({ messages: [message("x", "uncertain"), message("early", "queued")] }));
    tab.refresh("p");
    expect(tab.read("p").map(({ id, state }) => [id, state])).toEqual([["x", "uncertain"], ["early", "uncertain"]]);
    // only a receipt on the new connection holds it again
    tab.publish("p", [], frameRemovals(heldFrame({ x: 60_000 })), "c3");
    expect(tab.read("p").map(({ id, state }) => [id, state])).toEqual([["x", "held"], ["early", "uncertain"]]);
    // a Send now that leaves while the connection drops, refused with nothing typed: not held again without a new receipt
    expect(tab.begin("p", "x")).toBe(true);
    expect(tab.unconfirm("p", "x")).toBe(true);
    tab.suspendScope("c3");
    tab.fail("p", "x", { code: "not_transmitted", message: "the connection dropped before this message was sent" }, false, 0);
    tab.end("p", "x");
    expect(tab.read("p").find((row) => row.id === "x")?.state).toBe("uncertain");
  });
  it("never offers a discarded copy again: a later resumed held ID leaves another tab's stale copy or a late acceptance uncertain", () => {
    const port = storage(), tab = new PendingMessageStore(() => port);
    tab.accept("p", message("saved"), "old");
    tab.suspendScope("old");
    tab.publish("p", [], [{ id: "saved", outcome: "held", resumed: true, until: Date.now() + 60_000 }], "new");
    tab.removeCopy("p", "saved");
    tab.publish("p", [], [{ id: "saved", outcome: "held", resumed: true, until: Date.now() + 60_000 }], "newer");
    port.setItem("ovis:pending:p", JSON.stringify({ messages: [message("saved", "queued")] }));
    tab.refresh("p");
    expect(tab.read("p").map(({ id, state }) => [id, state])).toEqual([["saved", "uncertain"]]);
    tab.removeCopy("p", "saved");
    tab.publish("p", [], [{ id: "saved", outcome: "held", resumed: true, until: Date.now() + 60_000 }], "newest");
    tab.accept("p", message("saved", "sending"), null);
    expect(tab.read("p").map(({ id, state }) => [id, state])).toEqual([["saved", "uncertain"]]);
    // nor does a stale held copy or a late held acceptance
    tab.removeCopy("p", "saved");
    port.setItem("ovis:pending:p", JSON.stringify({ messages: [message("saved", "held")] }));
    tab.refresh("p");
    expect(tab.read("p").map(({ id, state }) => [id, state])).toEqual([["saved", "uncertain"]]);
    tab.removeCopy("p", "saved");
    tab.accept("p", message("saved", "held"), null);
    expect(tab.read("p").map(({ id, state }) => [id, state])).toEqual([["saved", "uncertain"]]);
  });
  it("settles only the exact resumed Pi ID after reload, never same-text or unrelated rows", () => {
    const port = storage(), first = new PendingMessageStore(() => port);
    const receipt = { ...message("pi:one", "uncertain", "same"), error: { code: "pi_transcript_pending", message: "waiting" } };
    first.accept("p", receipt, "old");
    first.accept("p", { ...receipt, id: "pi:two" }, "old");
    first.accept("p", message("held", "held", "same"), null);
    first.suspendScope("old");
    const reloaded = new PendingMessageStore(() => port);
    reloaded.publish("p", [], [{ id: "pi:one", outcome: "consumed" }], "new");
    expect(reloaded.read("p").map((row) => row.id)).toEqual(["pi:two", "held"]);
    expect(new PendingMessageStore(() => port).read("p").map((row) => row.id)).toEqual(["pi:two", "held"]);
    reloaded.publish("p", [], [{ id: "pi:two", outcome: "discarded" }], "new");
    expect(reloaded.read("p").map((row) => row.id)).toEqual(["pi:two", "held"]);
    reloaded.publish("other", [], [{ id: "pi:two", outcome: "consumed" }], "new");
    expect(reloaded.read("p")).toHaveLength(2);
    // A stale tab's subsequent storage event or acceptance cannot resurrect a consumed ID.
    port.setItem("ovis:pending:p", JSON.stringify({ messages: [receipt] }));
    reloaded.refresh("p");
    expect(reloaded.read("p")).toEqual([]);
    reloaded.accept("p", receipt, "late");
    expect(reloaded.read("p")).toEqual([]);
  });
  it("does not remove a live Pi receipt on a different connection's consumed removal", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    const receipt = { ...message("pi:one", "uncertain"), error: { code: "pi_transcript_pending", message: "waiting" } };
    store.accept("p", receipt, "live");
    store.publish("p", [], [{ id: receipt.id, outcome: "consumed" }], "other");
    expect(store.read("p")).toHaveLength(1);
    store.refresh("p");
    expect(store.read("p")).toHaveLength(1);
  });
  it("drops a first message delivered while its connection was down once the new connection's receipt says so", () => {
    const store = new PendingMessageStore(() => storage());
    // listed on the first connection, which then drops: kept, as not confirmed (a first message: no connection's request id)
    store.publish("p", [{ ...message("first", "queued", "Plan the config file"), request_id: -1 }], [], "connection-1");
    store.suspendScope("connection-1");
    expect(store.read("p")[0]!.state).toBe("uncertain");
    // the next connection is told it went: no copy is left uncertain
    store.publish("p", [], [{ id: "first", outcome: "sent" }], "connection-2");
    expect(store.read("p")).toEqual([]);
  });
  it("keeps a row a live connection proves when another connection's receipt names it (control)", () => {
    const store = new PendingMessageStore(() => storage());
    store.publish("p", [message("own")], [], "connection-1");
    store.publish("p", [], [{ id: "own", outcome: "sent" }], "connection-2");
    expect(store.read("p").map((row) => row.id)).toEqual(["own"]);
  });
  it("regression: advances a persisted attempt only on a definitive no-input refusal", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    store.accept("p", message("h", "held"), null);
    store.begin("p", "h"); store.unconfirm("p", "h");
    store.fail("p", "h", { code: "agent_blocked", message: "nothing typed" }, false, 0);
    store.end("p", "h");
    expect(new PendingMessageStore(() => port).read("p")[0]!.resendGeneration).toBe(1);
    store.begin("p", "h"); store.unconfirm("p", "h");
    store.fail("p", "h", { code: "submit_changed", message: "uncertain" }, true, 1);
    store.end("p", "h");
    const restored = new PendingMessageStore(() => port).read("p")[0]!;
    expect(restored.resendGeneration).toBe(1);
    expect(restored.state).toBe("uncertain");
  });
  it("regression: duplicate refusal receipts advance once and an older uncertain receipt cannot poison the retry", () => {
    const port = storage(), a = new PendingMessageStore(() => port), b = new PendingMessageStore(() => port);
    a.accept("p", message("h", "held"), "owner-a");
    a.begin("p", "h"); b.begin("p", "h"); b.unconfirm("p", "h");
    a.fail("p", "h", { code: "agent_blocked", message: "nothing typed" }, false, 0);
    b.fail("p", "h", { code: "agent_blocked", message: "nothing typed" }, false, 0);
    a.end("p", "h"); b.end("p", "h");
    a.fail("p", "h", { code: "submit_changed", message: "old receipt" }, true, 0);
    const restored = new PendingMessageStore(() => port).read("p")[0]!;
    expect(restored.resendGeneration).toBe(1);
    // saved, a held copy has no proof: uncertain until a receipt proves it again
    expect(restored.state).toBe("uncertain");
  });
  it("regression: an uncertain reply keeps its generation and survives another live owner's suspension", () => {
    const port = storage(), a = new PendingMessageStore(() => port), b = new PendingMessageStore(() => port);
    a.accept("p", message("h", "held"), "owner-a");
    b.begin("p", "h"); b.unconfirm("p", "h");
    b.fail("p", "h", { code: "submit_changed", message: "uncertain" }, true, 0);
    b.end("p", "h"); a.refresh("p"); a.suspend("p", "owner-a");
    const restored = new PendingMessageStore(() => port).read("p")[0]!;
    expect(restored.state).toBe("uncertain");
    expect(restored.resendGeneration).toBe(0);
  });
  it("regression: preserves another tab's resend mark when a live owner suspends", () => {
    const port = storage(), first = new PendingMessageStore(() => port);
    first.accept("p", message("h", "held"), "scope-a");
    const second = new PendingMessageStore(() => port);
    second.begin("p", "h");
    expect(second.unconfirm("p", "h")).toBe(true);
    first.refresh("p");
    first.suspend("p", "scope-a");
    expect(new PendingMessageStore(() => port).read("p")[0]!.state).toBe("uncertain");
  });
  it("regression: keeps another tab's resend mark through an authoritative row update", () => {
    const port = storage(), first = new PendingMessageStore(() => port);
    first.accept("p", message("h", "held"), "scope-a");
    const second = new PendingMessageStore(() => port);
    second.begin("p", "h"); second.unconfirm("p", "h");
    first.accept("p", message("h", "held"), "scope-a");
    first.suspend("p", "scope-a");
    expect(new PendingMessageStore(() => port).read("p")[0]!.state).toBe("uncertain");
  });
  it("regression: an unsaved owner preserves a recovered storage resend mark", () => {
    const port = storage();
    let full = false;
    const first = new PendingMessageStore(() => ({ ...port, setItem: (key, value) => {
      if (full) throw new Error("full");
      port.setItem(key, value);
    } }));
    first.accept("p", message("h", "held"), "scope-a");
    full = true;
    first.accept("p", message("other", "held"), "scope-a");
    const second = new PendingMessageStore(() => port);
    second.begin("p", "h"); second.unconfirm("p", "h");
    full = false;
    first.suspend("p", "scope-a");
    const rows = new PendingMessageStore(() => port).read("p");
    expect(rows.find((row) => row.id === "h")!.state).toBe("uncertain");
    expect(rows.find((row) => row.id === "other")!.text).toBe("check the tests");
  });
  it("regression: refuses resend when both storage reads and writes throw", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    store.accept("p", message("h", "held"), null);
    let blocked = false;
    const tab = new PendingMessageStore(() => blocked ? {
      getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {},
    } : port);
    tab.begin("p", "h");
    blocked = true;
    expect(tab.unconfirm("p", "h")).toBe(false);
  });
  it("restores saved queued and sending text as uncertain, without arming delivery", () => {
    const port = storage(), live = new PendingMessageStore(() => port);
    live.accept("pc:pane", message("q"), "connection-1");
    live.accept("pc:pane", message("s", "sending"), "connection-1");
    live.accept("pc:pane", message("h", "held"), "connection-1");
    const restored = new PendingMessageStore(() => port);
    expect(restored.read("pc:pane").map(({ id, state, serverOwned }) => [id, state, serverOwned])).toEqual([["q", "uncertain", false], ["s", "uncertain", false], ["h", "uncertain", false]]);
    restored.publish("pc:pane", [], [], "connection-2");
    expect(restored.read("pc:pane")).toHaveLength(3);
  });
  it("keeps owner isolation and requires a matching connection proof for removal receipts", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    store.accept("local:p1", message("one"), "scope-1");
    store.accept("remote:p1", message("two"), "scope-2");
    store.publish("local:p1", [], [{ id: "one", outcome: "sent" }], "scope-2");
    expect(store.read("local:p1")).toHaveLength(1);
    store.publish("local:p1", [], [{ id: "one", outcome: "sent" }], "scope-1");
    expect(store.read("local:p1")).toEqual([]);
    expect(store.read("remote:p1")[0]!.id).toBe("two");
  });
  it("suspends unconfirmed deliveries, retains confirmed held items, and cannot be rearmed by a late ACK", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    store.accept("p", message("q"), "old");
    store.accept("p", message("h", "held"), "old");
    store.suspendScope("old");
    store.accept("p", message("q"), null);
    // a held row lost with its connection is uncertain until a receipt proves it again
    expect(store.read("p").map(({ state, serverOwned }) => [state, serverOwned])).toEqual([["uncertain", false], ["uncertain", false]]);
    store.publish("p", [], [{ id: "q", outcome: "sent" }], "new");
    expect(store.read("p")).toHaveLength(2);
  });
  it("retains identical texts with different IDs and serializes actions on one ID", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    store.accept("p", message("a"), "scope");
    store.accept("p", message("b"), "scope");
    expect(store.read("p")).toHaveLength(2);
    expect(store.begin("p", "a")).toBe(true);
    expect(store.begin("p", "a")).toBe(false);
    store.publish("p", [], [{ id: "a", outcome: "discarded" }], "scope");
    store.end("p", "a");
    expect(store.read("p").map((row) => row.id)).toEqual(["b"]);
  });
  it("does not resurrect an already delivered ID when its acceptance ACK arrives late", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    store.accept("p", message("a"), "scope");
    store.publish("p", [], [{ id: "a", outcome: "sent" }], "scope");
    store.accept("p", message("a"), "scope");
    expect(store.read("p")).toEqual([]);
  });
  it("does not let another tab's saved copy discard a live server-owned request", () => {
    const port = storage(), own = new PendingMessageStore(() => port);
    own.accept("p", message("a"), "scope");
    const other = new PendingMessageStore(() => port);
    expect(other.read("p")[0]!.state).toBe("uncertain");
    other.removeCopy("p", "a");
    own.refresh("p");
    expect(own.read("p")[0]!.serverOwned).toBe(true);
  });
  it("keeps another tab's saved message when a removal receipt arrives before that tab's storage event", () => {
    const port = storage(), first = new PendingMessageStore(() => port), second = new PendingMessageStore(() => port);
    first.accept("pc:pane", message("x"), "connection-a");
    second.read("pc:pane");
    second.accept("pc:pane", message("y"), "connection-b");
    first.publish("pc:pane", [], [{ id: "x", outcome: "sent" }], "connection-a");
    expect(first.read("pc:pane").map((item) => item.id)).toEqual(["y"]);
    expect(new PendingMessageStore(() => port).read("pc:pane").map((item) => item.id)).toEqual(["y"]);
  });
  it("saves a held copy as not confirmed while it is sent again, and as held once that is refused", () => {
    const port = storage(), live = new PendingMessageStore(() => port);
    live.accept("pc:pane", message("h", "held"), "connection-1");
    const restored = new PendingMessageStore(() => port);
    expect(restored.begin("pc:pane", "h")).toBe(true);
    restored.unconfirm("pc:pane", "h");
    // another tab's copy of a live held row proves nothing here: uncertain
    expect(restored.read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["h", "uncertain"]]);
    expect(new PendingMessageStore(() => port).read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["h", "uncertain"]]);
    restored.fail("pc:pane", "h", { code: "agent_blocked", message: "menu" }, false);
    restored.end("pc:pane", "h");
    // the not-confirmed mark comes off; a copy with no receipt's proof is not held again by a refusal: uncertain
    expect(JSON.parse(port.getItem("ovis:pending:pc:pane")!).messages.map(({ id, state, resendInFlight }: { id: string; state: string; resendInFlight?: true }) => [id, state, resendInFlight ?? false])).toEqual([["h", "uncertain", false]]);
    expect(new PendingMessageStore(() => port).read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["h", "uncertain"]]);
  });
  it("keeps a copy being sent again not confirmed through another row's write", () => {
    const port = storage(), live = new PendingMessageStore(() => port);
    live.accept("pc:pane", message("a", "held"), "connection-1");
    live.accept("pc:pane", message("b", "held"), "connection-1");
    const restored = new PendingMessageStore(() => port);
    expect(restored.begin("pc:pane", "a")).toBe(true);
    restored.unconfirm("pc:pane", "a");
    restored.removeCopy("pc:pane", "b");
    expect(restored.read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["a", "uncertain"]]);
    expect(new PendingMessageStore(() => port).read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["a", "uncertain"]]);
  });
  it("keeps another tab's saved message when a held copy is marked before that tab's storage event", () => {
    const port = storage(), seed = new PendingMessageStore(() => port);
    seed.accept("pc:pane", message("h", "held"), "connection-0");
    const first = new PendingMessageStore(() => port), second = new PendingMessageStore(() => port);
    first.read("pc:pane"); second.read("pc:pane");
    second.accept("pc:pane", message("y"), "connection-b");
    expect(first.begin("pc:pane", "h")).toBe(true);
    first.unconfirm("pc:pane", "h");
    expect(new PendingMessageStore(() => port).read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["h", "uncertain"], ["y", "uncertain"]]);
  });
  it("keeps another tab's mark when this tab writes the list for a row of its own", () => {
    const port = storage(), seed = new PendingMessageStore(() => port);
    seed.accept("pc:pane", message("h", "held"), "connection-0");
    seed.accept("pc:pane", message("b", "held"), "connection-0");
    const first = new PendingMessageStore(() => port), second = new PendingMessageStore(() => port);
    first.read("pc:pane"); second.read("pc:pane");
    expect(first.begin("pc:pane", "h")).toBe(true);
    expect(first.unconfirm("pc:pane", "h")).toBe(true);
    second.removeCopy("pc:pane", "b");
    expect(second.read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["h", "uncertain"]]);
    expect(new PendingMessageStore(() => port).read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["h", "uncertain"]]);
  });
  it("does not send a held copy again when its mark cannot be saved over the saved copy", () => {
    const port = storage(), seed = new PendingMessageStore(() => port);
    seed.accept("pc:pane", message("h", "held"), "connection-0");
    const full = new PendingMessageStore(() => ({ ...port, setItem: () => { throw new Error("quota"); } }));
    expect(full.begin("pc:pane", "h")).toBe(true);
    expect(full.unconfirm("pc:pane", "h")).toBe(false);
    // with nothing saved there is no copy a reload could offer again
    const none = new PendingMessageStore(() => ({ getItem: () => null, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} }));
    none.accept("pc:pane", message("m", "held"), null);
    expect(none.begin("pc:pane", "m")).toBe(true);
    expect(none.unconfirm("pc:pane", "m")).toBe(true);
  });
  it("keeps a typed Pi receipt through reload as a dismissible, non-resendable local copy", () => {
    const port = storage(), live = new PendingMessageStore(() => port);
    const waiting = { ...message("pi:1", "uncertain", "same"), error: { code: "pi_transcript_pending", message: "waiting" } };
    live.accept("pc:pane", waiting, "connection-1");
    const restored = new PendingMessageStore(() => port);
    expect(restored.read("pc:pane")[0]).toMatchObject({ id: "pi:1", state: "uncertain", serverOwned: false, error: { code: "transcript_unconfirmed" } });
    // Only an explicitly owner-scoped server snapshot may restore live confirmation authority.
    restored.publish("pc:pane", [waiting], [], "connection-2");
    expect(restored.read("pc:pane")[0]).toMatchObject({ state: "uncertain", serverOwned: true, error: { code: "pi_transcript_pending" } });
    restored.publish("pc:pane", [], [{ id: "pi:1", outcome: "consumed" }], "connection-2");
    expect(restored.read("pc:pane")).toEqual([]);
  });
  it("keeps unsaved text in memory when storage fails", () => {
    const store = new PendingMessageStore(() => ({ getItem: () => null, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("full"); } }));
    store.accept("p", message("a"), "scope");
    expect(store.isUnsaved("p")).toBe(true);
    store.refresh("p");
    expect(store.read("p")[0]!.text).toBe("check the tests");
  });
});

// #511: a saved copy of a message for an agent alone stays one across a reload
it("keeps a saved row's agent_only across a reload", () => {
  const port = storage(), first = new PendingMessageStore(() => port);
  first.accept("p", { ...message("only", "held", "> q\nc"), agent_only: true }, null);
  first.accept("p", message("plain", "held"), null);
  expect(new PendingMessageStore(() => port).read("p").map((row) => [row.id, row.agent_only])).toEqual([["only", true], ["plain", undefined]]);
});

describe("a pane moved under a new ID (#1503)", () => {
  it("moves its rows to the new ID once, held as they were, with the live connection's proof", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    store.accept("remote:pc:w1%3Ap1", message("live", "held"), "scope");
    port.setItem("ovis:pending:remote:pc:w1%3Ap1", JSON.stringify({ messages: [message("live", "held"), message("saved", "held", "saved copy")] }));
    store.refresh("remote:pc:w1%3Ap1");
    // the server's list under the new ID came first
    store.publish("remote:pc:w2%3Ap1", [message("live", "held")], [], "scope");
    store.move("remote:pc:w1%3Ap1", "remote:pc:w2%3Ap1");
    expect(store.read("remote:pc:w1%3Ap1")).toEqual([]);
    expect(port.getItem("ovis:pending:remote:pc:w1%3Ap1")).toBeNull();
    expect(store.read("remote:pc:w2%3Ap1").map((row) => [row.id, row.state])).toEqual([["live", "held"], ["saved", "uncertain"]]);
    // its receipt under the new ID settles the live row
    store.publish("remote:pc:w2%3Ap1", [], [{ id: "live", outcome: "sent" }], "scope");
    expect(store.read("remote:pc:w2%3Ap1").map((row) => row.id)).toEqual(["saved"]);
    // moving again (another tab's word, the moving tab's own) changes nothing
    store.move("remote:pc:w1%3Ap1", "remote:pc:w2%3Ap1");
    expect(store.read("remote:pc:w2%3Ap1").map((row) => row.id)).toEqual(["saved"]);
  });

  it("leaves a row whose send this page has on its way where its answer looks for it, then moves it", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    store.accept("w1:p1", message("going", "held"), "scope");
    expect(store.begin("w1:p1", "going")).toBe(true);
    store.move("w1:p1", "w2:p1");
    expect(store.read("w1:p1").map((row) => row.id)).toEqual(["going"]);
    expect(store.read("w2:p1")).toEqual([]);
    store.fail("w1:p1", "going", { code: "submit_changed", message: "Check the terminal" }, true);
    store.end("w1:p1", "going");
    expect(store.read("w1:p1")).toEqual([]);
    expect(store.read("w2:p1").map((row) => [row.id, row.state])).toEqual([["going", "uncertain"]]);
  });

  it("keeps a moved row off the old ID when the server's lists for it come after the move", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    store.accept("w1:p1", message("queued", "queued"), "scope");
    // pane-moved first, then the server holds the row under the old ID, empties that list and lists the new one
    store.move("w1:p1", "w2:p1");
    store.publish("w1:p1", [message("queued", "held")], [], "scope");
    store.publish("w1:p1", [], [], "scope");
    store.publish("w2:p1", [message("queued", "held")], [], "scope");
    expect(store.read("w1:p1")).toEqual([]);
    expect(store.read("w2:p1").map((row) => [row.id, row.state])).toEqual([["queued", "held"]]);
    store.publish("w2:p1", [], [{ id: "queued", outcome: "discarded" }], "scope");
    expect(store.read("w1:p1")).toEqual([]);
    expect(store.read("w2:p1")).toEqual([]);
  });

  it("brings no row settled under the new ID back with the move", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    port.setItem("ovis:pending:w1:p1", JSON.stringify({ messages: [message("sent-copy", "held")] }));
    // the new ID's resumed receipt came first: the copy went out
    store.publish("w2:p1", [], [{ id: "sent-copy", outcome: "sent", resumed: true }], "scope");
    store.move("w1:p1", "w2:p1");
    expect(store.read("w1:p1")).toEqual([]);
    expect(store.read("w2:p1")).toEqual([]);
  });
});

describe("a pane moved again (#1503)", () => {
  it("takes a row whose send was on its way across two moves to the last ID", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    store.accept("a", message("going", "held"), "scope");
    expect(store.begin("a", "going")).toBe(true);
    store.move("a", "b");
    store.move("b", "c");
    store.end("a", "going");
    expect(store.read("a")).toEqual([]);
    expect(store.read("b")).toEqual([]);
    expect(store.read("c").map((row) => row.id)).toEqual(["going"]);
  });

  it("hears the server's lists again under an ID the pane moved back to", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    store.accept("a", message("row", "held"), "one");
    store.move("a", "b");
    store.move("b", "a");
    store.accept("a", message("row", "queued"), "two");
    expect(store.read("a").map((row) => [row.id, row.state])).toEqual([["row", "queued"]]);
    expect(store.isOwned("a", "row", "two")).toBe(true);
  });

  it("carries a row another connection's receipt under the new ID does not prove settled", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    store.accept("a", message("row", "held"), "one");
    store.publish("b", [], [{ id: "row", outcome: "sent" }], "two");
    store.move("a", "b");
    expect(store.read("b").map((row) => row.id)).toEqual(["row"]);
  });
});
