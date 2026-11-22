import { describe, expect, it } from "bun:test";

import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus, InteractivePrompt } from "../../shared/protocol.ts";
import machinesFixture from "../../site/demo/fixtures/machines.json";
import { inboxOrder } from "./agentInbox.ts";
import type { SidebarActivity } from "./sidebarActivity.tsx";
import { QUESTION_READS_AT_ONCE, QUESTION_RETRY_MS, QuestionReads, questionTargets, type QuestionTarget } from "./useInboxQuestions.ts";

const fixture: Machine[] = JSON.parse(JSON.stringify(machinesFixture.machines));

function prompt(question: string): InteractivePrompt {
  return { question } as InteractivePrompt;
}

function harness(words: (asked: InteractivePrompt, language: string) => string = (asked) => asked.question) {
  const calls: { paneId: string; resolve(answer: { prompt: InteractivePrompt | null }): void; reject(error: Error): void }[] = [];
  const waits: { ms: number; run(): void; cancelled: boolean }[] = [];
  const reads = new QuestionReads(
    (paneId) => new Promise((resolve, reject) => { calls.push({ paneId, resolve, reject }); }),
    words,
    (run, ms) => {
      const wait = { ms, run, cancelled: false };
      waits.push(wait);
      return () => { wait.cancelled = true; };
    },
  );
  let notified = 0;
  reads.subscribe(() => { notified++; });
  return { reads, calls, waits, notified: () => notified };
}

const target = (key: string, seq = 1, lifetime = ""): QuestionTarget => ({ key, machineId: "local", paneId: `pane-${key}`, seq, lifetime });
const settled = () => new Promise<void>((resolve) => queueMicrotask(resolve)).then(() => undefined);

describe("QuestionReads", () => {
  it("stores the words of an answered prompt and tells the listener once", async () => {
    const { reads, calls, notified } = harness();
    reads.sync([target("a")]);
    expect(calls.map((call) => call.paneId)).toEqual(["pane-a"]);
    calls[0]!.resolve({ prompt: prompt("Allow command?") });
    await settled();
    expect(reads.texts().get("a")).toBe("Allow command?");
    expect(notified()).toBe(1);
  });

  it("asks once more after an empty answer and stores the answer after it", async () => {
    const { reads, calls, waits } = harness();
    reads.sync([target("a")]);
    calls[0]!.resolve({ prompt: null });
    await settled();
    expect(reads.texts().size).toBe(0);
    expect(waits.map((wait) => wait.ms)).toEqual([QUESTION_RETRY_MS]);
    expect(QUESTION_RETRY_MS).toBe(1500);
    waits[0]!.run();
    expect(calls).toHaveLength(2);
    calls[1]!.resolve({ prompt: prompt("Pick one") });
    await settled();
    expect(reads.texts().get("a")).toBe("Pick one");
  });

  it("reads a target again when its seq changes and replaces its words", async () => {
    const { reads, calls } = harness();
    reads.sync([target("a", 1)]);
    calls[0]!.resolve({ prompt: prompt("First") });
    await settled();
    reads.sync([target("a", 1)]);
    expect(calls).toHaveLength(1);
    reads.sync([target("a", 2)]);
    expect(calls).toHaveLength(2);
    calls[1]!.resolve({ prompt: prompt("Second") });
    await settled();
    expect(reads.texts().get("a")).toBe("Second");
  });

  it("keeps two reads in flight and starts the next as each answers", async () => {
    const { reads, calls } = harness();
    reads.sync(["a", "b", "c", "d", "e"].map((key) => target(key)));
    expect(QUESTION_READS_AT_ONCE).toBe(2);
    expect(calls.map((call) => call.paneId)).toEqual(["pane-a", "pane-b"]);
    calls[0]!.resolve({ prompt: prompt("A") });
    await settled();
    expect(calls.map((call) => call.paneId)).toEqual(["pane-a", "pane-b", "pane-c"]);
    calls[1]!.reject(new Error("offline"));
    await settled();
    expect(calls.map((call) => call.paneId)).toEqual(["pane-a", "pane-b", "pane-c", "pane-d"]);
    calls[2]!.resolve({ prompt: prompt("C") });
    await settled();
    expect(calls).toHaveLength(5);
    expect(calls[4]!.paneId).toBe("pane-e");
  });

  it("stores nothing for a failed read, tries it once more after the retry's wait without a sync, and not a third time", async () => {
    const { reads, calls, waits, notified } = harness();
    reads.sync([target("a")]);
    const before = reads.texts();
    calls[0]!.reject(new Error("offline"));
    await settled();
    expect(reads.texts()).toBe(before);
    expect(notified()).toBe(0);
    expect(waits.map((wait) => wait.ms)).toEqual([QUESTION_RETRY_MS]);
    waits[0]!.run();
    expect(calls).toHaveLength(2);
    calls[1]!.reject(new Error("offline"));
    await settled();
    expect(waits).toHaveLength(1);
    reads.sync([target("a")]);
    expect(calls).toHaveLength(2);
  });

  it("stores the words the retry after a failed read finds", async () => {
    const { reads, calls, waits } = harness();
    reads.sync([target("a")]);
    calls[0]!.reject(new Error("offline"));
    await settled();
    waits[0]!.run();
    calls[1]!.resolve({ prompt: prompt("Allow command?") });
    await settled();
    expect(reads.texts().get("a")).toBe("Allow command?");
  });

  it("cancels the retry of a failed read when its target leaves, and reads nothing when it fires", async () => {
    const { reads, calls, waits } = harness();
    reads.sync([target("a")]);
    calls[0]!.reject(new Error("offline"));
    await settled();
    reads.sync([]);
    expect(waits[0]!.cancelled).toBe(true);
    waits[0]!.run();
    expect(calls).toHaveLength(1);
  });

  it("releases the slot of a read whose answer cannot be worded, and reads it once more after the retry's wait", async () => {
    // bun test fails a test during which a promise rejection goes unhandled
    const { reads, calls, waits } = harness((asked) => { if (asked.question === "Broken") throw new Error("no words"); return asked.question; });
    reads.sync(["a", "b", "c"].map((key) => target(key)));
    calls[0]!.resolve({ prompt: prompt("Broken") });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls.map((call) => call.paneId)).toEqual(["pane-a", "pane-b", "pane-c"]);
    expect(reads.texts().has("a")).toBe(false);
    calls[1]!.resolve({ prompt: prompt("B") });
    await settled();
    expect(reads.texts().get("b")).toBe("B");
    waits[0]!.run();
    expect(calls.map((call) => call.paneId)).toEqual(["pane-a", "pane-b", "pane-c", "pane-a"]);
  });

  it("removes a target's words as soon as its seq changes, and shows none when the new read fails", async () => {
    const { reads, calls } = harness();
    reads.sync([target("a", 1)]);
    calls[0]!.resolve({ prompt: prompt("First") });
    await settled();
    reads.sync([target("a", 2)]);
    expect(reads.texts().has("a")).toBe(false);
    calls[1]!.reject(new Error("offline"));
    await settled();
    expect(reads.texts().has("a")).toBe(false);
  });

  it("shows no old words for a new wait whose read answers empty twice", async () => {
    const { reads, calls, waits } = harness();
    reads.sync([target("a", 1)]);
    calls[0]!.resolve({ prompt: prompt("First") });
    await settled();
    reads.sync([target("a", 2)]);
    calls[1]!.resolve({ prompt: null });
    await settled();
    waits[0]!.run();
    calls[2]!.resolve({ prompt: null });
    await settled();
    expect(calls).toHaveLength(3);
    expect(reads.texts().has("a")).toBe(false);
  });

  it("reads a target again in a new language and keeps its words until the new ones land", async () => {
    const { reads, calls } = harness((asked, language) => `${language}:${asked.question}`);
    reads.sync([target("a")], "en");
    calls[0]!.resolve({ prompt: prompt("Allow?") });
    await settled();
    reads.sync([target("a")], "ko");
    expect(calls).toHaveLength(2);
    expect(reads.texts().get("a")).toBe("en:Allow?");
    calls[1]!.resolve({ prompt: prompt("Allow?") });
    await settled();
    expect(reads.texts().get("a")).toBe("ko:Allow?");
  });

  it("drops an answer for a target that left", async () => {
    const { reads, calls, waits } = harness();
    reads.sync([target("a"), target("b")]);
    reads.sync([target("b")]);
    const before = reads.texts();
    calls[0]!.resolve({ prompt: prompt("Gone") });
    await settled();
    expect(reads.texts()).toBe(before);
    expect(reads.texts().size).toBe(0);
    expect(waits).toHaveLength(0);
  });

  it("cancels a waiting retry when its target leaves, and reads nothing when it fires", async () => {
    const { reads, calls, waits } = harness();
    reads.sync([target("a")]);
    calls[0]!.resolve({ prompt: null });
    await settled();
    reads.sync([]);
    expect(waits[0]!.cancelled).toBe(true);
    waits[0]!.run();
    expect(calls).toHaveLength(1);
  });

  it("reads every target once more when the list is shown again with the same counters, keeping its words until the answer lands", async () => {
    const { reads, calls } = harness();
    reads.sync([target("a"), target("b")]);
    calls[0]!.resolve({ prompt: prompt("A") });
    calls[1]!.resolve({ prompt: prompt("B") });
    await settled();
    reads.sync([target("a"), target("b")]);
    expect(calls).toHaveLength(2);
    reads.shownAgain();
    reads.sync([target("a"), target("b")]);
    expect(calls.map((call) => call.paneId)).toEqual(["pane-a", "pane-b", "pane-a", "pane-b"]);
    expect(reads.texts().get("a")).toBe("A");
    calls[2]!.resolve({ prompt: prompt("A, asked next") });
    await settled();
    expect(reads.texts().get("a")).toBe("A, asked next");
    expect(reads.texts().get("b")).toBe("B");
    reads.sync([target("a"), target("b")]);
    expect(calls).toHaveLength(4);
  });

  it("removes the words a read on a new showing finds no question for, after its one retry", async () => {
    const { reads, calls, waits } = harness();
    reads.sync([target("a")]);
    calls[0]!.resolve({ prompt: prompt("A") });
    await settled();
    reads.shownAgain();
    reads.sync([target("a")]);
    calls[1]!.resolve({ prompt: null });
    await settled();
    expect(reads.texts().get("a")).toBe("A");
    waits[0]!.run();
    calls[2]!.resolve({ prompt: null });
    await settled();
    expect(calls).toHaveLength(3);
    expect(reads.texts().has("a")).toBe(false);
  });

  it("starts no second read on a new showing for a read in flight, queued or waiting its retry", async () => {
    const { reads, calls, waits } = harness();
    reads.sync(["a", "b", "c"].map((key) => target(key)));
    reads.shownAgain();
    reads.sync(["a", "b", "c"].map((key) => target(key)));
    expect(calls.map((call) => call.paneId)).toEqual(["pane-a", "pane-b"]);
    calls[0]!.resolve({ prompt: null });
    await settled();
    expect(calls.map((call) => call.paneId)).toEqual(["pane-a", "pane-b", "pane-c"]);
    reads.shownAgain();
    reads.sync(["a", "b", "c"].map((key) => target(key)));
    expect(calls).toHaveLength(3);
    waits[0]!.run();
    calls[1]!.resolve({ prompt: prompt("B") });
    await settled();
    expect(calls.map((call) => call.paneId)).toEqual(["pane-a", "pane-b", "pane-c", "pane-a"]);
    reads.shownAgain();
    reads.sync(["a", "b", "c"].map((key) => target(key)));
    calls[2]!.resolve({ prompt: prompt("C") });
    await settled();
    expect(calls.map((call) => call.paneId)).toEqual(["pane-a", "pane-b", "pane-c", "pane-a", "pane-b"]);
  });

  it("reads a target once more when the list is shown again while its read is in flight, once that read lands", async () => {
    const { reads, calls } = harness();
    reads.sync([target("a")]);
    calls[0]!.resolve({ prompt: prompt("A") });
    await settled();
    reads.shownAgain();
    reads.sync([target("a")]);
    expect(calls).toHaveLength(2);
    reads.shownAgain();
    reads.shownAgain();
    reads.sync([target("a")]);
    expect(calls).toHaveLength(2);
    calls[1]!.resolve({ prompt: prompt("A") });
    await settled();
    expect(calls.map((call) => call.paneId)).toEqual(["pane-a", "pane-a", "pane-a"]);
    calls[2]!.resolve({ prompt: prompt("B") });
    await settled();
    expect(reads.texts().get("a")).toBe("B");
    expect(calls).toHaveLength(3);
  });

  it("keeps a question's words read under an absent herdr lifetime when it becomes known, while it is read again", async () => {
    const { reads, calls } = harness();
    reads.sync([target("a", 1)]);
    calls[0]!.resolve({ prompt: prompt("Asked before the proof") });
    await settled();
    reads.sync([target("a", 1, "life-1")]);
    expect(calls).toHaveLength(2);
    expect(reads.wordsFor(target("a", 1, "life-1"))).toBe("Asked before the proof");
    calls[1]!.resolve({ prompt: prompt("Asked after the proof") });
    await settled();
    expect(reads.wordsFor(target("a", 1, "life-1"))).toBe("Asked after the proof");
  });

  it("reads a target again under a new herdr lifetime with the same seq, showing none of the old pane's words", async () => {
    const { reads, calls } = harness();
    reads.sync([target("a", 1, "first")]);
    calls[0]!.resolve({ prompt: prompt("Old pane's question") });
    await settled();
    expect(reads.wordsFor(target("a", 1, "first"))).toBe("Old pane's question");
    reads.sync([target("a", 1, "second")]);
    expect(calls).toHaveLength(2);
    expect(reads.wordsFor(target("a", 1, "second"))).toBeUndefined();
    calls[1]!.resolve({ prompt: prompt("New pane's question") });
    await settled();
    expect(reads.wordsFor(target("a", 1, "second"))).toBe("New pane's question");
  });

  it("schedules no further wait after a second empty answer", async () => {
    const { reads, calls, waits } = harness();
    reads.sync([target("a")]);
    calls[0]!.resolve({ prompt: null });
    await settled();
    waits[0]!.run();
    calls[1]!.resolve({ prompt: null });
    await settled();
    expect(waits).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(reads.texts().size).toBe(0);
  });
});

describe("questionTargets", () => {
  const blockedPane = "w1D:p1";
  const activity: SidebarActivity = {
    seqs: () => new Map([[blockedPane, 7]]),
    status: (_machineId, pane) => (pane.pane_id === "w1C:p1" ? "blocked" : pane.agent_status) as AgentStatus,
  };
  const machines = (edit: (machine: Machine) => Machine = (machine) => machine): Machine[] => structuredClone(fixture).map(edit);
  const withPanes = (machine: Machine, fields: Record<string, Record<string, string>>): Machine => machine.snapshot === null ? machine : {
    ...machine,
    snapshot: { ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => ({ ...pane, ...fields[pane.pane_id] })) },
  };

  it("takes the waiting rows with their seq", () => {
    const shown = machines();
    const targets = questionTargets(inboxOrder(shown, activity), activity);
    expect(targets.map((t) => [t.machineId, t.paneId, t.seq]).sort()).toEqual([["local", "w1C:p1", 0], ["local", blockedPane, 7]]);
  });

  it("names each target's herdr lifetime", () => {
    const shown = machines((machine) => machine.snapshot === null ? machine : { ...machine, snapshot: { ...machine.snapshot, herdr_lifetime: "life-1" } });
    const targets = questionTargets(inboxOrder(shown, activity), activity);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.map((t) => t.lifetime)).toEqual(targets.map(() => "life-1"));
  });

  it("leaves out a waiting pane whose agent reported a message or a kind", () => {
    const shown = machines((machine) => withPanes(machine, { "w1C:p1": { agent_kind: "permission" }, [blockedPane]: { agent_message: "Approve the deploy?" } }));
    expect(questionTargets(inboxOrder(shown, activity), activity)).toEqual([]);
    const blank = machines((machine) => withPanes(machine, { [blockedPane]: { agent_message: "  " } }));
    expect(questionTargets(inboxOrder(blank, activity), activity).map((t) => t.paneId)).toContain(blockedPane);
  });

  it("leaves out a waiting pane of a PC that is not connected", () => {
    const shown = machines((machine) => ({ ...machine, state: "disconnected" }) as Machine);
    expect(inboxOrder(shown, activity).length).toBeGreaterThan(0);
    expect(questionTargets(inboxOrder(shown, activity), activity)).toEqual([]);
  });
});
