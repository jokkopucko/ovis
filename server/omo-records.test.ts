import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, closeSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmoAskReader } from "./omo-ask.ts";
import { noTurn, omoTurnAfter } from "./omo-status.ts";
import { readOmoLines, type OmoLine } from "./omo-records.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-omo-records-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const call = (id: string, incomplete = false) => ({ type: "toolCall", id, name: "ask_user_question", arguments: { waitForAnswer: false, questions: [{ header: "QA", question: "Which?", options: [{ label: "A" }] }] }, incomplete });
const assistant = (...content: unknown[]) => ({ type: "message", message: { role: "assistant", content, stopReason: "stop" } });
const record = (entry: unknown) => JSON.stringify(entry) + "\n";
const read = (path: string): OmoLine[] => {
  const fd = openSync(path, "r");
  const found: OmoLine[] = [];
  try { readOmoLines(fd, 0, statSync(path).size, (line) => found.push(line)); }
  finally { closeSync(fd); }
  return found;
};

describe("OmO question replay", () => {
  test("keeps an old open question across large tool output, append, restart and settlement", () => {
    const path = join(root, "old.jsonl");
    writeFileSync(path, record(assistant(call("old"))) + record({ type: "message", message: { role: "toolResult", toolCallId: "bash", content: [{ type: "text", text: "x".repeat(1_200_000) }] } }) + record(assistant({ type: "text", text: "done" })));
    const reader = new OmoAskReader();
    expect(reader.read(path).map((ask) => ask.id)).toEqual(["old"]);
    expect(read(path).reduce(omoTurnAfter, noTurn()).asks.map((ask) => ask.id)).toEqual(["old"]);
    expect(new OmoAskReader().read(path).map((ask) => ask.id)).toEqual(["old"]);
    const settlement = record({ type: "custom", customType: "ask-user:settlement", data: { requestId: "old" } });
    appendFileSync(path, settlement.slice(0, -1));
    expect(reader.read(path)).toHaveLength(1);
    appendFileSync(path, "\n");
    expect(reader.read(path)).toEqual([]);
    writeFileSync(path, record(assistant(call("replacement"))));
    expect(reader.read(path).map((ask) => ask.id)).toEqual(["replacement"]);
  });

  test("finds a call between huge strings and ignores incomplete and quoted fake calls", () => {
    const path = join(root, "middle.jsonl");
    const fake = JSON.stringify(call("fake"));
    writeFileSync(path, record(assistant(
      { type: "thinking", thinking: ('한😀\\"' + fake).repeat(4000) },
      call("real"), call("aborted", true),
      { type: "toolCall", id: "bash", name: "bash", arguments: { command: "z".repeat(300_000) } },
    )));
    const lines = read(path);
    expect(lines).toHaveLength(1);
    expect("record" in lines[0]! && lines[0].record!.length).toBeLessThan(150_000);
    expect(new OmoAskReader().read(path).map((ask) => ask.id)).toEqual(["real"]);
    expect(lines.reduce(omoTurnAfter, noTurn()).asks.map((ask) => ask.id)).toEqual(["real"]);
  });

  test("keeps a waiting question through newer assistant narration until the result", () => {
    const path = join(root, "waiting.jsonl");
    const ask = call("waiting");
    ask.arguments.waitForAnswer = true;
    writeFileSync(path, record(assistant(ask)) + record(assistant({ type: "thinking", thinking: "still thinking" })));
    const reader = new OmoAskReader();
    expect(reader.read(path)).toHaveLength(1);
    appendFileSync(path, record({ type: "message", message: { role: "toolResult", toolCallId: "waiting", content: [] } }));
    expect(reader.read(path)).toEqual([]);
  });
});
