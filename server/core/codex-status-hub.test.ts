import { describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as codex from "../codex.ts";
import * as conversation from "../conversation.ts";
import { handlers, hub, root } from "./status.fake.ts";

// codex-cli 0.167.0 at its usage limit, as recorded: the turn's end carries the error, and no answer
const failed = readFileSync(join(import.meta.dir, "..", "fixtures", "codex-usage-limit-0.167.0-rollout.jsonl"), "utf8");
const answered = `${JSON.stringify({ type: "event_msg", timestamp: "2026-11-12T05:56:00.000Z", payload: { type: "task_complete", last_agent_message: "Done", error: null } })}\n`;
const pane = (status: string) => ({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "codex", agent_status: status, cwd: root });

let rollouts = 0;
function codexHub(text: string) {
  const path = join(root, `rollout-${++rollouts}.jsonl`);
  writeFileSync(path, text);
  const h = hub();
  const lookups = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "codex-transcript", path } as never);
  const original = codex.codexLastTurnEnd;
  let reads = Promise.withResolvers<void>();
  const read = spyOn(codex, "codexLastTurnEnd").mockImplementation(async (file, tail) => {
    try { return await original(file, tail); } finally { reads.resolve(); }
  });
  const failures: string[] = [];
  spyOn(h.status.push, "onFailed").mockImplementation(async (paneId: string) => { failures.push(paneId); });
  const looked = async () => {
    await reads.promise;
    reads = Promise.withResolvers<void>();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const restore = () => { lookups.mockRestore(); read.mockRestore(); };
  const settled = async () => {
    await (lookups.mock.results.at(-1)?.value as Promise<unknown> | undefined)?.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return { ...h, path, lookups, read, failures, looked, settled, restore };
}

describe("a Codex pane whose turn ended in an error", () => {
  it("reads at rest and tells the failure once, never DONE first, for a turn this server saw run", async () => {
    const h = codexHub(failed);
    try {
      h.herdrSays(pane("working"));
      handlers.onStatus("w1:p1", "working", "codex");
      h.herdrSays(pane("idle"));
      handlers.onStatus("w1:p1", "idle", "codex");
      expect(h.last().status).toBe("working");
      await h.looked();
      expect(h.last().status).toBe("idle");
      expect(h.alerts).toEqual(["working", "idle"]);
      expect(h.failures).toEqual(["w1:p1"]);
      h.herdrSays(pane("done"));
      expect((await h.snapshot()).panes[0]!.agent_status).toBe("idle");
      handlers.onStatus("w1:p1", "done", "codex");
      expect(h.last().status).toBe("idle");
      expect(h.failures).toEqual(["w1:p1"]);
      handlers.onStatus("w1:p1", "working", "codex");
      expect(h.last().status).toBe("working");
    } finally { h.restore(); }
  });

  it("lets no read begun while herdr still said working undo the failed rest, or tell it twice", async () => {
    const h = codexHub(failed);
    try {
      h.herdrSays(pane("working"));
      handlers.onStatus("w1:p1", "working", "codex");
      const release = await h.heldSnapshot();
      h.herdrSays(pane("done"));
      handlers.onStatus("w1:p1", "done", "codex");
      await h.looked();
      expect(h.last().status).toBe("idle");
      await release();
      expect((await h.snapshot()).panes[0]!.agent_status).toBe("idle");
      expect(h.read).toHaveBeenCalledTimes(1);
      expect(h.failures).toEqual(["w1:p1"]);
    } finally { h.restore(); }
  });

  it("keeps a failed rest when herdr gives the pane a new ID", async () => {
    const h = codexHub(failed);
    try {
      handlers.onStatus("w1:p1", "working", "codex");
      handlers.onStatus("w1:p1", "done", "codex");
      await h.looked();
      (handlers as unknown as { onPaneMoved: (from: string, to: string) => void }).onPaneMoved("w1:p1", "w2:p1");
      h.herdrSays({ ...pane("done"), pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1" });
      expect((await h.snapshot()).panes[0]!.agent_status).toBe("idle");
      expect(h.failures).toEqual(["w1:p1"]);
    } finally { h.restore(); }
  });

  it("takes no failure from the turn before while a retry's end is not written yet", async () => {
    const h = codexHub(`${failed}${JSON.stringify({ type: "event_msg", timestamp: "2026-11-12T05:56:00.000Z", payload: { type: "task_started", turn_id: "retry" } })}\n`);
    try {
      handlers.onStatus("w1:p1", "working", "codex");
      handlers.onStatus("w1:p1", "done", "codex");
      await h.looked();
      expect(h.last().status).toBe("done");
      expect(h.failures).toEqual([]);
    } finally { h.restore(); }
  });

  it("looks again at a rollout a look could not find, a while later", async () => {
    const h = codexHub(failed);
    try {
      h.lookups.mockRejectedValueOnce(new Error("herdr did not answer"));
      handlers.onStatus("w1:p1", "working", "codex");
      handlers.onStatus("w1:p1", "done", "codex");
      await h.settled();
      expect(h.read).not.toHaveBeenCalled();
      h.herdrSays(pane("done"));
      await h.snapshot();
      expect(h.lookups).toHaveBeenCalledTimes(1);
      setSystemTime(new Date(Date.now() + 2_001));
      await h.snapshot();
      await h.looked();
      expect(h.lookups).toHaveBeenCalledTimes(2);
      expect(h.last().status).toBe("idle");
      expect(h.failures).toEqual(["w1:p1"]);
    } finally { setSystemTime(); h.restore(); }
  });

  it("finishes the turn after a failure once its rollout says it answered", async () => {
    const h = codexHub(failed);
    try {
      handlers.onStatus("w1:p1", "working", "codex");
      handlers.onStatus("w1:p1", "done", "codex");
      await h.looked();
      expect(h.last().status).toBe("idle");
      writeFileSync(h.path, `${failed}${JSON.stringify({ type: "event_msg", timestamp: "2026-11-12T05:56:00.000Z", payload: { type: "task_started", turn_id: "retry" } })}\n${JSON.stringify({ type: "event_msg", timestamp: "2026-11-12T05:56:01.000Z", payload: { type: "task_complete", turn_id: "retry", last_agent_message: "Done", error: null } })}\n`);
      h.herdrSays(pane("done"));
      await h.snapshot();
      await h.looked();
      expect(h.last().status).toBe("done");
      expect(h.alerts.at(-1)).toBe("done");
    } finally { h.restore(); }
  });

  it("tells nothing of a retry still under way, read before herdr says it works, and still fails or finishes it after", async () => {
    const h = codexHub(failed);
    try {
      handlers.onStatus("w1:p1", "working", "codex");
      handlers.onStatus("w1:p1", "done", "codex");
      await h.looked();
      expect(h.last().status).toBe("idle");
      const started = `${failed}${JSON.stringify({ type: "event_msg", timestamp: "2026-11-12T05:56:00.000Z", payload: { type: "task_started", turn_id: "retry" } })}\n`;
      writeFileSync(h.path, started);
      h.herdrSays(pane("idle"));
      await h.snapshot();
      await h.looked();
      expect(h.last().status).toBe("idle");
      expect(h.alerts).toEqual(["working", "idle"]);
      h.herdrSays(pane("unknown"));
      expect((await h.snapshot()).panes[0]!.agent_status).toBe("idle");
    } finally { h.restore(); }
  });

  it("finishes a turn that answered", async () => {
    const h = codexHub(`${failed}${answered}`);
    try {
      handlers.onStatus("w1:p1", "working", "codex");
      handlers.onStatus("w1:p1", "idle", "codex");
      await h.looked();
      expect(h.read).toHaveBeenCalledTimes(1);
      expect(h.last().status).toBe("done");
      expect(h.failures).toEqual([]);
    } finally { h.restore(); }
  });

  it("tells nothing of a failure it never saw run: a pane found already at DONE, after a restart", async () => {
    const h = codexHub(failed);
    try {
      h.herdrSays(pane("done"));
      handlers.onBaseline([pane("done")]);
      expect((await h.snapshot()).panes[0]!.agent_status).toBe("done");
      handlers.onStatus("w1:p1", "done", "codex");
      expect(h.lookups).not.toHaveBeenCalled();
      expect(h.failures).toEqual([]);
    } finally { h.restore(); }
  });
});
