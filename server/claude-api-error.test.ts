import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeTurnEnd, parseClaudeTranscript } from "./claude-transcript.ts";

// Claude Code 2.1.321 at an API rate limit, as recorded: its answer entry is the error (isApiErrorMessage), the prompt before it shortened
const recorded = readFileSync(join(import.meta.dir, "fixtures", "claude-api-error-2.1.321.jsonl"), "utf8");

test("shows the API error Claude Code recorded as a failed request, not as its answer", () => {
  const turns = parseClaudeTranscript(recorded);
  expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(turns[1]!.parts).toEqual([{ kind: "text", failed: true,
    text: "API Error: Request rejected (429) · All credentials for model claude-fable-5-2 are cooling down (last error: rate_limit_error: This request would exceed your account's rate limit. Please try again later.) (reset after 1m28s)" }]);
});

test("keeps an answer that only quotes an error as the answer it is", () => {
  const [user, error] = recorded.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const { isApiErrorMessage: _flag, ...answer } = error!;
  const turns = parseClaudeTranscript(`${JSON.stringify(user)}\n${JSON.stringify(answer)}\n`);
  expect(turns[1]!.parts.some((part) => part.kind === "text" && part.failed === true)).toBe(false);
});

test("reads a turn whose last entry is the API error as failed, and one a retry answered after it as answered", () => {
  const entry = (value: unknown) => `${JSON.stringify(value)}\n`;
  const answer = entry({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done" }] } });
  expect(claudeTurnEnd(recorded)).toBe("failed");
  expect(claudeTurnEnd(`${recorded}${answer}`)).toBe("answered");
  expect(claudeTurnEnd(`${recorded}${entry({ type: "user", origin: { kind: "human" }, message: { role: "user", content: "again" } })}`)).toBe("running");
  expect(claudeTurnEnd(`${answer}${entry({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } })}`)).toBe("running");
  const own = [
    entry({ type: "user", isMeta: true, message: { role: "user", content: "caveat" } }),
    entry({ type: "user", message: { role: "user", content: "<local-command-stdout>ok</local-command-stdout>" } }),
    entry({ type: "assistant", isSidechain: true, message: { role: "assistant", stop_reason: "end_turn", content: [] } }),
    entry({ type: "system", subtype: "turn_duration" }),
  ].join("");
  expect(claudeTurnEnd(`${recorded}${own}`)).toBe("failed");
  expect(claudeTurnEnd("")).toBeNull();
});

const entry = (value: unknown) => `${JSON.stringify(value)}\n`;

test("reads a person's prompt that holds bash mode's tags as a prompt, and only the runtime's own bash lines as none", () => {
  const human = (content: string) => entry({ type: "user", origin: { kind: "human" }, permissionMode: "default", message: { role: "user", content } });
  expect(claudeTurnEnd(`${recorded}${human("<bash-stdout>ok</bash-stdout> please explain this output")}`)).toBe("running");
  expect(claudeTurnEnd(`${recorded}${human("please explain this <bash-stdout>ok</bash-stdout> output")}`)).toBe("running");
  // bash mode's own lines, which Claude Code writes with no origin, tell nothing of the turn
  expect(claudeTurnEnd(`${recorded}${entry({ type: "user", message: { role: "user", content: "<bash-input>ls</bash-input>" } })}${entry({ type: "user", message: { role: "user", content: "<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>" } })}`)).toBe("failed");
});

test("reads a person's prompt taken in from the queue as the turn under way", () => {
  const answer = entry({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done" }] } });
  const queued = entry({ type: "attachment", attachment: { type: "queued_command", commandMode: "prompt", prompt: "and this", origin: { kind: "human" } } });
  expect(claudeTurnEnd(`${answer}${queued}`)).toBe("running");
  expect(claudeTurnEnd(`${answer}${queued}${recorded.trim().split("\n").at(-1)!}\n`)).toBe("failed");
});
