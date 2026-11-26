import { describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { appendFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as codex from "../codex.ts";
import * as served from "../approvals/codex.ts";
import * as conversation from "../conversation.ts";
import { handlers, hub, root } from "./status.fake.ts";

// codex-cli 0.167.0 at its usage limit, as recorded: the turn's end carries the error, and no answer
const failed = readFileSync(join(import.meta.dir, "..", "fixtures", "codex-usage-limit-0.167.0-rollout.jsonl"), "utf8");
const running = `${failed.trimEnd().split("\n").slice(0, -1).join("\n")}\n`;
const answered = `${JSON.stringify({ type: "event_msg", timestamp: "2026-11-12T05:56:00.000Z", payload: { type: "task_complete", last_agent_message: "Done", error: null } })}\n`;
const pane = (status: string) => ({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "codex", agent_status: status, cwd: root });

// the reader itself, taken before any test puts a spy in its place
const readTurnEnd = codex.codexLastTurnEnd;

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
    // fail before the test's own timeout, so its finally still restores the spies
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("no rollout read finished")), 1_500); });
    try { await Promise.race([reads.promise, late]); } finally { clearTimeout(timer); }
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
  it("keeps herdr's done alert when the app server never ends the announced turn", async () => {
    const h = codexHub(answered);
    try {
      h.herdrSays(pane("working"));
      handlers.onStatus("w1:p1", "working", "codex");
      h.status.hookTurn("w1:p1", "codex", { turn: "began", prompt: "u1" });
      h.status.hookTurn("w1:p1", "codex", { turn: "ended", prompt: "other", failed: true });
      h.herdrSays(pane("idle"));
      handlers.onStatus("w1:p1", "idle", "codex");
      await h.looked();
      expect(h.last().status).toBe("done");
      expect(h.alerts).toEqual(["working", "done"]);
      expect(h.failures).toEqual([]);
    } finally { h.restore(); }
  });

  it("keeps a rollout-detected failure ready for delivery at codex/unknown", async () => {
    const h = codexHub(failed);
    try {
      h.herdrSays(pane("working"));
      handlers.onStatus("w1:p1", "working", "codex");
      h.herdrSays(pane("unknown"));
      handlers.onStatus("w1:p1", "unknown", "codex");
      await h.looked();
      expect(h.failures).toEqual(["w1:p1"]);
      handlers.onStatus("w1:p1", "unknown", "codex");
      expect(h.pending.current("w1:p1")).toBe("idle");
      expect((await h.status.deliverySnapshot()).panes[0]?.agent_status).toBe("idle");
    } finally { h.restore(); }
  });

  it("does not re-alert the same served turn after an in-flight working read outlasts herdr's done event", async () => {
    const h = codexHub(failed);
    const told = spyOn(served, "servedTurnEnd").mockReturnValue("failed");
    try {
      h.herdrSays(pane("working"));
      handlers.onStatus("w1:p1", "working", "codex");
      h.status.hookTurn("w1:p1", "codex", { turn: "began", prompt: "u1" });
      h.status.hookTurn("w1:p1", "codex", { turn: "ended", prompt: "u1", failed: true });
      const release = await h.heldSnapshot();
      h.herdrSays(pane("done"));
      handlers.onStatus("w1:p1", "done", "codex");
      await release();
      expect((await h.snapshot()).panes[0]?.agent_status).toBe("idle");
      expect(h.failures).toEqual(["w1:p1"]);
    } finally { told.mockRestore(); h.restore(); }
  });

  it("shows a served failure immediately without changing the delivery snapshot", async () => {
    const h = codexHub(failed);
    try {
      h.herdrSays(pane("working"));
      handlers.onStatus("w1:p1", "working", "codex");
      const event = { turn: "ended", prompt: "u1", failed: true } as const;
      h.status.hookTurn("w1:p1", "codex", event);
      expect(h.last().status).toBe("idle");
      expect(h.failures).toEqual(["w1:p1"]);
      expect((await h.snapshot()).panes[0]?.agent_status).toBe("idle");
      expect(h.pending.current("w1:p1")).toBe("working");
      expect((await h.status.deliverySnapshot()).panes[0]?.agent_status).toBe("working");
      h.herdrSays(pane("done"));
      expect((await h.snapshot()).panes[0]?.agent_status).toBe("idle");
      handlers.onStatus("w1:p1", "done", "codex");
      h.status.hookTurn("w1:p1", "codex", event);
      await h.looked();
      expect(h.failures).toEqual(["w1:p1"]);
    } finally { h.restore(); }
  });

  it("takes the turn's end its own app server told, and reads no rollout for it", async () => {
    // the rollout says answered: only the server's word can make this turn a failure
    const h = codexHub(answered);
    const told = spyOn(served, "servedTurnEnd").mockReturnValue("failed");
    try {
      h.herdrSays(pane("working"));
      handlers.onStatus("w1:p1", "working", "codex");
      h.herdrSays(pane("idle"));
      handlers.onStatus("w1:p1", "idle", "codex");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(h.last().status).toBe("idle");
      expect(h.failures).toEqual(["w1:p1"]);
      expect(h.read).not.toHaveBeenCalled();
    } finally { told.mockRestore(); h.restore(); }
  });

  it("keeps a failure its app server told when a rollout read begun before it says answered", async () => {
    const h = codexHub(answered);
    const told = spyOn(served, "servedTurnEnd").mockReturnValue(null);
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = Promise.withResolvers<void>();
    h.read.mockImplementation(async (file, tail) => {
      reading.resolve();
      await release.promise;
      try { return await readTurnEnd(file, tail); } finally { read.resolve(); }
    });
    try {
      h.herdrSays(pane("working"));
      handlers.onStatus("w1:p1", "working", "codex");
      h.herdrSays(pane("done"));
      handlers.onStatus("w1:p1", "done", "codex");
      await reading.promise;
      told.mockReturnValue("failed");
      await h.snapshot();
      expect(h.failures).toEqual(["w1:p1"]);
      release.resolve();
      await read.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      await h.snapshot();
      expect(h.failures).toEqual(["w1:p1"]);
      expect((await h.snapshot()).panes[0]!.agent_status).toBe("idle");
    } finally { release.resolve(); told.mockRestore(); h.restore(); }
  });

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

  it.each(["idle", "unknown"])("finds a late failure when the next snapshot still says %s (#3760)", async (rest) => {
    const h = codexHub(running);
    try {
      h.herdrSays(pane("working"));
      handlers.onStatus("w1:p1", "working", "codex");
      h.herdrSays(pane(rest));
      handlers.onStatus("w1:p1", rest === "idle" ? "idle" : "unknown", "codex");
      await h.looked();
      expect(h.last().status).toBe("done");
      writeFileSync(h.path, failed);
      await h.snapshot();
      await h.looked();
      expect(h.last().status).toBe("idle");
      expect(h.failures).toEqual(["w1:p1"]);
    } finally { h.restore(); }
  }, 2_000);

  it.each([
    { text: failed, status: "idle", failures: ["w1:p1"] },
    { text: `${running}${answered}`, status: "done", failures: [] },
  ])("reads a second turn ending $status while the first read is pending (#3760)", async ({ text, status, failures }) => {
    const h = codexHub(failed);
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    h.read.mockImplementationOnce(async (file, tail) => {
      const end = await readTurnEnd(file, tail);
      reading.resolve();
      await release.promise;
      return end;
    });
    h.read.mockImplementation(async (file, tail) => {
      try { return await readTurnEnd(file, tail); } finally { finished.resolve(); }
    });
    try {
      handlers.onStatus("w1:p1", "working", "codex");
      handlers.onStatus("w1:p1", "idle", "codex");
      await reading.promise;
      handlers.onStatus("w1:p1", "working", "codex");
      writeFileSync(h.path, text);
      handlers.onStatus("w1:p1", "idle", "codex");
      release.resolve();
      h.herdrSays(pane("idle"));
      await h.snapshot();
      expect(h.lookups).toHaveBeenCalledTimes(2);
      await finished.promise;
      await h.settled();
      expect(h.last().status).toBe(status);
      expect(h.failures).toEqual([...failures]);
    } finally { release.resolve(); h.restore(); }
  });

  it("does not read the previous session's unfinished rollout for its replacement (#3760)", async () => {
    const h = codexHub(running);
    const session = (value: string) => ({ agent_session: { agent: "codex", source: "herdr:codex", kind: "id", value } });
    try {
      h.herdrSays({ ...pane("idle"), ...session("first") });
      handlers.onStatus("w1:p1", "working", "codex");
      handlers.onStatus("w1:p1", "idle", "codex");
      await h.looked();
      writeFileSync(h.path, failed);
      h.herdrSays({ ...pane("idle"), ...session("second") });
      await h.snapshot();
      await h.settled();
      expect(h.read).toHaveBeenCalledTimes(1);
      expect(h.failures).toEqual([]);
    } finally { h.restore(); }
  });

  it("stops resolving a vanished rollout for the same resting turn (#3760)", async () => {
    const h = codexHub(running);
    try {
      handlers.onStatus("w1:p1", "working", "codex");
      handlers.onStatus("w1:p1", "done", "codex");
      await h.looked();
      unlinkSync(h.path);
      h.lookups.mockRejectedValue(new Error("rollout not found"));
      h.herdrSays(pane("done"));
      for (let i = 0; i < 3; i++) {
        await h.snapshot();
        await h.settled();
        setSystemTime(new Date(Date.now() + 2_001));
      }
      expect(h.lookups).toHaveBeenCalledTimes(1);
      expect(h.last().status).toBe("done");
    } finally { setSystemTime(); h.restore(); }
  });

  it("still finds a late failure after the rollout tail contains no turn markers (#3760)", async () => {
    const h = codexHub(running);
    try {
      handlers.onStatus("w1:p1", "working", "codex");
      handlers.onStatus("w1:p1", "idle", "codex");
      await h.looked();
      appendFileSync(h.path, `${JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(256 * 1024) } })}\n`);
      h.herdrSays(pane("idle"));
      await h.snapshot();
      await h.looked();
      appendFileSync(h.path, `${failed.trimEnd().split("\n").at(-1)}\n`);
      await h.snapshot();
      // the snapshot's read begins only once the rollout's stat returns
      await h.looked();
      expect(h.read).toHaveBeenCalledTimes(3);
      expect(h.failures).toEqual(["w1:p1"]);
    } finally { h.restore(); }
  }, 2_000);

  it("does not attribute a pending rollout read to a successor agent (#3760)", async () => {
    const h = codexHub(failed);
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    h.read.mockImplementation(async () => {
      reading.resolve();
      await release.promise;
      return "failed";
    });
    try {
      handlers.onStatus("w1:p1", "working", "codex");
      handlers.onStatus("w1:p1", "idle", "codex");
      await reading.promise;
      handlers.onStatus("w1:p1", "idle", "claude");
      release.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(h.failures).toEqual([]);
    } finally { release.resolve(); h.restore(); }
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
