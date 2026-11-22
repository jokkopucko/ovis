import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { commandInvocations, commandOutcome } from "./outcome.ts";

const at = Date.parse("2026-10-20T00:00:00Z");
const piCompaction = {
  type: "compaction", id: "c1", parentId: "u1", timestamp: new Date(at + 10).toISOString(),
  summary: "## Session Goal\n- fold the older turns", firstKeptEntryId: "u1", tokensBefore: 178366,
};
const handoff = JSON.parse(readFileSync(new URL("./fixtures/omp-handoff-18.8.7-session.jsonl", import.meta.url), "utf8")
  .split("\n").find(line => line.includes('"type":"compaction"'))!);

for (const agent of ["pi", "omp", "gjc", "omo"]) {
  it(`does not invent a ${agent} compact completion from a user message and an unattributed native fold`, () => {
    const sent = { id: "compact", at, agent, identity: "fixture", text: "/compact", screen: "", form: null,
      invocations: commandInvocations(agent, "/compact", []) };
    for (const entry of [piCompaction, { ...handoff, timestamp: new Date(at + 10).toISOString() }]) {
      const fold = JSON.stringify(entry);
      expect(commandOutcome("pane", sent, { now: at + 100, transcript: fold })).toMatchObject({ state: "accepted", evidence: [] });
      const message = JSON.stringify({ type: "message", id: "u1", parentId: null,
        timestamp: new Date(at + 5).toISOString(), message: { role: "user", content: [{ type: "text", text: "/compact" }] } });
      // A command-shaped conversation turn does not add native causality to an automatic fold.
      expect(commandOutcome("pane", sent, { now: at + 100, transcript: `${message}\n${fold}` }))
        .toMatchObject({ state: "accepted", evidence: [] });
    }
  });
}

it("does not enable Codex compact completion without a verified native cause record", () => {
  const sent = { id: "compact", at, agent: "codex", identity: "fixture", text: "/compact", screen: "", form: null,
    invocations: commandInvocations("codex", "/compact", []) };
  const transcript = [
    { type: "event_msg", timestamp: new Date(at + 5).toISOString(), payload: { type: "user_message", message: "/compact" } },
    { type: "compacted", timestamp: new Date(at + 10).toISOString() },
  ].map(entry => JSON.stringify(entry)).join("\n");
  expect(commandOutcome("pane", sent, { now: at + 100, transcript })).toMatchObject({ state: "accepted", evidence: [] });
});

it("recognizes the captured omp handoff record without a command echo", () => {
  const sent = { id: "handoff", at, agent: "omp", identity: "fixture", text: "/handoff", screen: "", form: null,
    invocations: commandInvocations("omp", "/handoff", []) };
  const transcript = JSON.stringify({ ...handoff, timestamp: new Date(at + 10).toISOString() });
  expect(commandOutcome("pane", sent, { now: at + 100, transcript }))
    .toMatchObject({ state: "result-observed", evidence: [{ kind: "transcript" }] });
});
