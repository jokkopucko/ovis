import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CommandOutcome } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { toTranscriptMessages } from "../lib/transcript.ts";
import { ChatFallback } from "./ChatView.tsx";

const raw = "❯ Thought TPS Todo are my words\n\nThought: keep this\n\nTPS 2\n\nTodo\n[ ] task\nContext 10%\n──────\n  indented  \n";
const outcome: CommandOutcome = {
  id: "sent-1", pane_id: "w1:p1", text: "Thought TPS Todo are my words", state: "accepted", evidence: [],
  created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z",
};

function render(scrollback: string, outcomes: CommandOutcome[] = []) {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(ChatFallback, {
      paneId: "w1:p1", agent: null, visible: true, messages: toTranscriptMessages(scrollback), scrollback,
      outcomes, restored: null, actions: null, skills: null,
    }) }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

describe("terminal scrollback snapshot", () => {
  it("shows every raw line once, with one copy control and no inferred assistant turns", () => {
    const html = render(raw);
    expect(html).toContain(raw);
    expect(html.match(/class="chat-terminal-snapshot"/g)).toHaveLength(1);
    expect(html.match(/aria-label="Copy as plain text"/g)).toHaveLength(1);
    expect(html).not.toContain("chat-turn-agent");
    expect(html).not.toContain("Copy as markdown");
  });

  it("retains a matched command's outcome as a named chip, not a second bubble", () => {
    const html = render(raw, [outcome]);
    expect(html).toContain('data-outcome-state="accepted"');
    expect(html).not.toContain("chat-turn-sent");
    expect(html).toContain('<span class="chat-outcome-command" title="Thought TPS Todo are my words">Thought TPS Todo are my words</span>');
  });

  it("names each chip's command, so two sends shown in the snapshot stay apart", () => {
    const html = render("$ ls\nREADME.md\n$ pwd\n/home/me\n", [
      { ...outcome, id: "ls", text: "ls" },
      { ...outcome, id: "pwd", text: "pwd", state: "unknown" },
    ]);
    expect(html).toContain('<span class="chat-outcome-command" title="ls">ls</span>');
    expect(html).toContain('<span class="chat-outcome-command" title="pwd">pwd</span>');
  });

  it("labels an unmatched send's status with its command, without adding a provisional bubble", () => {
    const html = render(raw, [{ ...outcome, text: "an unmatched command", state: "unknown" }]);
    expect(html).toContain('data-outcome-state="unknown"');
    expect(html).not.toContain("chat-turn-sent");
    expect(html).toContain('<span class="chat-outcome-command" title="an unmatched command">an unmatched command</span>');
  });

  it("names a shell command by its line, not by a path or variable in it", () => {
    const html = render("$ pwd\n/home/me\n", [
      { ...outcome, id: "cd", text: "cd /var/log" },
      { ...outcome, id: "ls", text: "ls /var/log" },
      { ...outcome, id: "echo", text: "echo $HOME" },
    ]);
    expect(html).toContain('<span class="chat-outcome-command" title="cd /var/log">cd /var/log</span>');
    expect(html).toContain('<span class="chat-outcome-command" title="ls /var/log">ls /var/log</span>');
    expect(html).toContain('<span class="chat-outcome-command" title="echo $HOME">echo $HOME</span>');
  });

  it("takes a multi-line result as shown despite trailing spaces", () => {
    const html = render("$ run\nfirst\nsecond\n", [
      { ...outcome, id: "run", text: "run", state: "result-observed", evidence: [{ kind: "recognized-result", at: outcome.created_at }], result_text: "first  \nsecond" },
    ]);
    expect(html).not.toContain("chat-outcome-result");
  });

  it("does not take a short result as shown from a word inside another line", () => {
    const html = render("$ make tools\nbuild ok, 3 warnings\n", [
      { ...outcome, id: "ls", text: "ls", state: "result-observed", evidence: [{ kind: "recognized-result", at: outcome.created_at }], result_text: "ok" },
    ]);
    expect(html).toContain('<span class="chat-outcome-command" title="ls">ls</span>');
    expect(html).toContain("chat-outcome-result");
  });

  it("shows a recorded result the snapshot does not hold", () => {
    const html = render("another screen", [
      { ...outcome, id: "result", state: "result-observed", evidence: [{ kind: "recognized-result", at: outcome.created_at }], result_text: "result scrolled away" },
    ]);
    expect(html.match(/result scrolled away/g)).toHaveLength(1);
    expect(html).toContain("chat-outcome-result");
  });

  it("keeps outcome states without repeating preview or result text", () => {
    const html = render("preview in screen\nresult in screen", [
      { ...outcome, id: "preview", preview: "preview in screen" },
      { ...outcome, id: "result", state: "result-observed", evidence: [{ kind: "recognized-result", at: outcome.created_at }], result_text: "result in screen" },
    ]);
    expect(html.match(/preview in screen/g)).toHaveLength(1);
    expect(html.match(/result in screen/g)).toHaveLength(1);
    expect(html).toContain('data-outcome-state="accepted"');
    expect(html).toContain('data-outcome-state="result-observed"');
  });

  it("does not draw an empty snapshot", () => {
    expect(render("")).not.toContain("chat-terminal-snapshot");
    expect(render("\n   \n")).not.toContain("chat-terminal-snapshot");
  });
});
