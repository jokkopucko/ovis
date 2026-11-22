import { describe, expect, test } from "bun:test";
import { parseClaudeTranscript } from "./conversation.ts";
import { parseOmpTranscript } from "./transcript-records.ts";
import { turnSegments } from "../src/lib/workBlocks.ts";
import type { ConversationTurn } from "../shared/protocol.ts";

const jsonl = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");

const answerWordsAndWorkTools = (turn: ConversationTurn) => turnSegments(turn.parts).map((segment) => segment.kind === "answer"
  ? segment.parts.map((part) => part.text).join(" ")
  : `work: ${segment.parts.flatMap((part) => part.kind === "tool" ? [part.name] : []).join(", ")}`);

describe("a turn keeps the agent's order of words and tools", () => {
  test("OmO/pi: words before the tool calls of the same message stay above them", () => {
    const message = (role: string, extra: Record<string, unknown>) => ({ type: "message", message: { role, ...extra } });
    const turns = parseOmpTranscript(jsonl(
      message("user", { content: [{ type: "text", text: "Update the test server." }] }),
      message("assistant", { stopReason: "toolUse", content: [
        { type: "thinking", thinking: "Check what it runs first." },
        { type: "text", text: "I read this as: bring the test server up to date." },
        { type: "toolCall", id: "one", name: "eval", arguments: { summary: "Checking the revision" } },
      ] }),
      message("toolResult", { toolCallId: "one", content: [{ type: "text", text: "rev a" }] }),
      message("assistant", { stopReason: "toolUse", content: [{ type: "toolCall", id: "two", name: "eval", arguments: { summary: "Checking the service" } }] }),
      message("toolResult", { toolCallId: "two", content: [{ type: "text", text: "active" }] }),
      message("assistant", { stopReason: "toolUse", content: [{ type: "thinking", thinking: "Restart it." }, { type: "toolCall", id: "three", name: "eval", arguments: { summary: "Restarting" } }] }),
      message("toolResult", { toolCallId: "three", content: [{ type: "text", text: "restarted" }] }),
      message("assistant", { stopReason: "stop", content: [{ type: "text", text: "The test server runs the latest main." }] }),
    ));
    const turn = turns.find((candidate) => candidate.role === "assistant")!;
    expect(answerWordsAndWorkTools(turn)).toEqual([
      "work: ",
      "I read this as: bring the test server up to date.",
      "work: eval, eval, eval",
      "The test server runs the latest main.",
    ]);
  });

  test("Claude: a reply between two tool calls stays between them", () => {
    const turns = parseClaudeTranscript(jsonl(
      { type: "user", message: { content: "Check the catalog." } },
      { type: "assistant", message: { content: [{ type: "text", text: "Checking the catalog first." }, { type: "tool_use", id: "a", name: "Bash", input: { command: "ls" } }], stop_reason: "tool_use" } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "books" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Three books. Now the loans." }, { type: "tool_use", id: "b", name: "Read", input: { file_path: "loans.md" } }], stop_reason: "tool_use" } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b", content: "none" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "No book is on loan." }], stop_reason: "end_turn" } },
    ));
    expect(answerWordsAndWorkTools(turns.at(-1)!)).toEqual([
      "Checking the catalog first.",
      "work: Bash",
      "Three books. Now the loans.",
      "work: Read",
      "No book is on loan.",
    ]);
  });
});
