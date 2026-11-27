import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCodexDelivery, CodexDeliveries } from "./codex-delivery.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const header = (id = "native-session") => JSON.stringify({ type: "session_meta", payload: { id } }) + "\n";
const user = (text: string, at = 2000, clientId = "ours") => JSON.stringify({
  type: "event_msg", timestamp: new Date(at).toISOString(),
  payload: { type: "item_completed", thread_id: "native-session",
    item: { type: "UserMessage", id: `item-${at}-${text}`, client_id: clientId, content: [{ type: "text", text }] } },
}) + "\n";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ovis-codex-delivery-")); roots.push(root);
  const path = join(root, "rollout.jsonl");
  writeFileSync(path, header() + user("same", 100));
  const deliveries = new CodexDeliveries<string>();
  const tracker = {
    add: (pane: string, text: string, anchor: Awaited<ReturnType<typeof captureCodexDelivery>>, at: number, id: string) =>
      deliveries.add(pane, text, anchor, at, id, id),
    reconcile: deliveries.reconcile.bind(deliveries), invalidate: deliveries.invalidate.bind(deliveries),
  };
  return { path, tracker, append: (text: string) => appendFileSync(path, text) };
}

describe("Codex's native delivery records", () => {
  it("confirms only a complete new native user event, independent of browser clocks", async () => {
    const f = fixture();
    f.tracker.add("p", "same", await captureCodexDelivery(f.path), 1000, "ours");
    expect(await f.tracker.reconcile("p", f.path)).toEqual([]);
    f.append(user("same"));
    expect(await f.tracker.reconcile("p", f.path)).toEqual(["ours"]);
    expect(await f.tracker.reconcile("p", f.path)).toEqual([]);
  });

  it("does not let an old buffered echo or model-context copy confirm a send", async () => {
    const f = fixture();
    f.tracker.add("p", "same", await captureCodexDelivery(f.path), 1000, "ours");
    f.append(user("same", 900) + JSON.stringify({ type: "response_item", timestamp: new Date(2000).toISOString(), payload: { type: "message", role: "user", content: [{ type: "input_text", text: "same" }] } }) + "\n");
    expect(await f.tracker.reconcile("p", f.path)).toEqual([]);
    f.append(user("same"));
    expect(await f.tracker.reconcile("p", f.path)).toEqual(["ours"]);
  });

  it("uses the bound thread's completed user item after its legacy and model-context copies", async () => {
    const f = fixture();
    const completed = (thread_id: string, at: number) => JSON.stringify({
      type: "event_msg", timestamp: new Date(at).toISOString(),
      payload: { type: "item_completed", thread_id, turn_id: "active-turn",
        item: { type: "UserMessage", id: "accepted-user-item", client_id: "ours", content: [{ type: "text", text: "same", text_elements: [] }] } },
    }) + "\n";
    f.tracker.add("p", "same", await captureCodexDelivery(f.path), 1000, "ours");
    f.append(JSON.stringify({ type: "response_item", timestamp: new Date(2000).toISOString(),
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "same" }] } }) + "\n");
    f.append(JSON.stringify({ type: "event_msg", timestamp: new Date(2000).toISOString(),
      payload: { type: "user_message", message: "same" } }) + "\n");
    f.append(completed("another-thread", 2100) + completed("native-session", 900));
    expect(await f.tracker.reconcile("p", f.path)).toEqual([]);
    f.append(completed("native-session", 2200));
    expect(await f.tracker.reconcile("p", f.path)).toEqual(["ours"]);
    expect(await f.tracker.reconcile("p", f.path)).toEqual([]);
  });

  it("does not reuse one native message for overlapping sends, including a successful ordinary send", async () => {
    const f = fixture(), anchor = await captureCodexDelivery(f.path);
    f.tracker.add("p", "same", anchor, 1000, "successful ordinary send");
    f.tracker.add("p", "same", anchor, 1100, "uncertain Send now");
    f.append(user("same"));
    expect(await f.tracker.reconcile("p", f.path)).toEqual([]);
    f.append(user("same", 2200));
    expect(await f.tracker.reconcile("p", f.path)).toEqual([]);
  });

  it("reserves an earlier ordinary send even when its transcript could not be bound", async () => {
    const f = fixture();
    f.tracker.add("p", "same", null, 900, "unbound ordinary send");
    f.tracker.add("p", "same", await captureCodexDelivery(f.path), 1000, "uncertain Send now");
    f.append(user("same"));
    expect(await f.tracker.reconcile("p", f.path)).toEqual([]);
  });

  it("consumes sequential identical sends separately when their native records precede the next anchor", async () => {
    const f = fixture();
    f.tracker.add("p", "same", await captureCodexDelivery(f.path), 1000, "first");
    f.append(user("same", 2000, "first"));
    expect(await f.tracker.reconcile("p", f.path)).toEqual(["first"]);
    f.tracker.add("p", "same", await captureCodexDelivery(f.path), 3000, "second");
    expect(await f.tracker.reconcile("p", f.path)).toEqual([]);
    f.append(user("same", 4000, "second"));
    expect(await f.tracker.reconcile("p", f.path)).toEqual(["second"]);
  });

  it("waits for a partial append and declines a partial pre-send anchor", async () => {
    const f = fixture();
    f.tracker.add("p", "same", await captureCodexDelivery(f.path), 1000, "ours");
    const entry = user("same"); f.append(entry.slice(0, -1));
    expect(await captureCodexDelivery(f.path)).toBeNull();
    expect(await f.tracker.reconcile("p", f.path)).toEqual([]);
    f.append("\n");
    expect(await f.tracker.reconcile("p", f.path)).toEqual(["ours"]);
  });

  it.each(["replacement", "truncation", "other-session"])("retains uncertainty after %s", async (change) => {
    const f = fixture();
    f.tracker.add("p", "same", await captureCodexDelivery(f.path), 1000, "ours");
    if (change === "replacement") renameSync(f.path, f.path + ".old");
    writeFileSync(f.path, header(change === "other-session" ? "another-session" : "native-session") + (change === "truncation" ? "" : user("same")));
    expect(await f.tracker.reconcile("p", f.path)).toEqual([]);
  });

  it("does not publish evidence invalidated while a native read is in flight", async () => {
    const f = fixture();
    f.tracker.add("p", "same", await captureCodexDelivery(f.path), 1000, "ours");
    f.append(user("same"));
    const reading = f.tracker.reconcile("p", f.path);
    f.tracker.invalidate("p");
    expect(await reading).toEqual([]);
  });

  it("does not resume guessing on the same native session after its tracking budget is exhausted", async () => {
    const f = fixture(), anchor = await captureCodexDelivery(f.path);
    for (let i = 0; i < 257; i++) f.tracker.add("p", `text ${i}`, anchor, 1000, `attempt ${i}`);
    f.tracker.add("p", "same", anchor, 1000, "later");
    f.append(user("same", 2000, "later"));
    expect(await f.tracker.reconcile("p", f.path)).toEqual([]);
  });

  it("scopes records to the pane and preserves meaningful internal whitespace", async () => {
    const f = fixture();
    f.tracker.add("p", "a b\r\nnext ", await captureCodexDelivery(f.path), 1000, "ours");
    f.append(user("ab\nnext"));
    expect(await f.tracker.reconcile("other-pane", f.path)).toEqual([]);
    expect(await f.tracker.reconcile("p", f.path)).toEqual([]);
    f.tracker.add("p", "a b\r\nnext ", await captureCodexDelivery(f.path), 2100, "next");
    f.append(user("a b\nnext", 2200, "next"));
    expect(await f.tracker.reconcile("p", f.path)).toEqual(["next"]);
  });

  it("leaves oversized transcript growth and unsupported native formats unconfirmed", async () => {
    const f = fixture();
    f.tracker.add("p", "same", await captureCodexDelivery(f.path), 1000, "ours");
    f.append(JSON.stringify({ type: "event_msg", timestamp: new Date(2000).toISOString(), payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "same" }] } } }) + "\n");
    expect(await f.tracker.reconcile("p", f.path)).toEqual([]);
    f.append("x".repeat(1024 * 1024));
    expect(await f.tracker.reconcile("p", f.path)).toEqual([]);
  });
});
