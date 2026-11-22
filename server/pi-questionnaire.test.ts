import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pendingPiQuestionnaires } from "./pi-questionnaire.ts";

const entry = (id: string, parentId: string | null, message: object) => ({ type: "message", id, parentId, message });
const call = (id: string, parentId: string | null, toolId: string) => entry(id, parentId, {
  role: "assistant", content: [{ type: "toolCall", id: toolId, name: "questionnaire", arguments: { questions: [] } }],
});
const result = (id: string, parentId: string, toolId: string) => entry(id, parentId, { role: "toolResult", toolCallId: toolId });
const user = entry("root", null, { role: "user", content: "Synthetic branch fixture" });

function withTranscript(run: (path: string, write: (entries: object[]) => void, append: (item: object) => void) => void) {
  const root = mkdtempSync(join(tmpdir(), "ovis-questionnaire-branch-"));
  const path = join(root, "session.jsonl");
  const write = (entries: object[]) => writeFileSync(path, [
    { type: "session", id: "session", version: 3, cwd: root }, ...entries,
  ].map(item => JSON.stringify(item)).join("\n") + "\n");
  try { run(path, write, item => appendFileSync(path, JSON.stringify(item) + "\n")); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("pending questionnaires follow the indexed Pi branch, including branch summaries and results", () => {
  withTranscript((path, write, append) => {
    write([user, call("old", "root", "abandoned")]);
    expect(pendingPiQuestionnaires(path)?.map(call => call.id)).toEqual(["abandoned"]);
    append({ type: "branch_summary", id: "summary", parentId: "root", fromId: "old", summary: "Interrupted" });
    append(call("new", "summary", "current"));
    expect(pendingPiQuestionnaires(path)?.map(call => call.id)).toEqual(["current"]);
    expect(pendingPiQuestionnaires(path)?.map(call => call.id)).toEqual(["current"]);
    append(result("settled", "new", "current"));
    expect(pendingPiQuestionnaires(path)).toEqual([]);
    append(entry("returned", "new", { role: "user", content: "Continue" }));
    expect(pendingPiQuestionnaires(path)?.map(call => call.id)).toEqual(["current"]);
    write([user, call("replaced", "root", "replacement")]);
    expect(pendingPiQuestionnaires(path)?.map(call => call.id)).toEqual(["replacement"]);
  });
});

test("native dialogs on a new branch do not inherit abandoned pending calls", () => {
  withTranscript((path, write) => {
    write([user, call("old", "root", "abandoned"), entry("new", "root", { role: "user", content: "Choose a model" })]);
    expect(pendingPiQuestionnaires(path)).toEqual([]);
  });
});

test("questionnaire authorization refuses broken, cyclic, duplicate and missing entry ancestry", () => {
  withTranscript((path, write) => {
    for (const entries of [
      [user, call("orphan", "unknown", "unverified")],
      [user, call("cycle", "cycle", "unverified")],
      [user, call("repeat", "root", "first"), call("repeat", "repeat", "second")],
      [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "no-entry", name: "questionnaire", arguments: {} }] } }],
      [user, { ...call("missing-parent", null, "unverified"), parentId: undefined }],
    ]) {
      write(entries);
      expect(pendingPiQuestionnaires(path)).toBeNull();
    }
  });
});
