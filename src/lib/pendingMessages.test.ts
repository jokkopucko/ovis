import { describe, expect, it } from "bun:test";
import type { PendingMessage } from "../../shared/protocol.ts";
import { PendingMessageStore } from "./pendingMessages.ts";

const storage = () => {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
};
const message = (id: string, state: PendingMessage["state"] = "queued", text = "check the tests"): PendingMessage => ({ id, request_id: 1, text, state, created_at: "2026-10-06T00:00:00Z" });

describe("pending message ownership", () => {
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
    expect(restored.state).toBe("held");
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
    expect(restored.read("pc:pane").map(({ id, state, serverOwned }) => [id, state, serverOwned])).toEqual([["q", "uncertain", false], ["s", "uncertain", false], ["h", "held", false]]);
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
    expect(store.read("p").map(({ state, serverOwned }) => [state, serverOwned])).toEqual([["uncertain", false], ["held", false]]);
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
    expect(restored.read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["h", "held"]]);
    expect(new PendingMessageStore(() => port).read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["h", "uncertain"]]);
    restored.fail("pc:pane", "h", { code: "agent_blocked", message: "menu" }, false);
    restored.end("pc:pane", "h");
    expect(new PendingMessageStore(() => port).read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["h", "held"]]);
  });
  it("keeps a copy being sent again not confirmed through another row's write", () => {
    const port = storage(), live = new PendingMessageStore(() => port);
    live.accept("pc:pane", message("a", "held"), "connection-1");
    live.accept("pc:pane", message("b", "held"), "connection-1");
    const restored = new PendingMessageStore(() => port);
    expect(restored.begin("pc:pane", "a")).toBe(true);
    restored.unconfirm("pc:pane", "a");
    restored.removeCopy("pc:pane", "b");
    expect(restored.read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["a", "held"]]);
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
    expect(store.read("remote:pc:w2%3Ap1").map((row) => [row.id, row.state])).toEqual([["live", "held"], ["saved", "held"]]);
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
