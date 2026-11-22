import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { CommandOutcome, ConversationResponse } from "../../shared/protocol.ts";
import type { TranscriptMessage } from "../lib/transcript.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { ChatFallback } from "./ChatView.tsx";

const outcome = (over: Partial<CommandOutcome> & { id: string; text: string }): CommandOutcome => ({
  pane_id: "w1:p1", state: "accepted", evidence: [], created_at: "2026-10-20T10:00:00.000Z", updated_at: "2026-10-20T10:00:00.000Z", ...over,
});

const render = (props: { agent: string | null; messages: TranscriptMessage[]; outcomes: CommandOutcome[]; restored?: string | null; unavailable?: ConversationResponse["unavailable"]; onOpenTerminal?: () => void }): string => {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(ChatFallback, {
      paneId: "w1:p1", visible: true, actions: null, skills: null, restored: null, ...props,
    }) }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

describe("the chat's fallback transcript", () => {
  it("draws a tracked command the terminal-output fallback has no turn for as a sent row with its chip", () => {
    const btw = outcome({ id: "o-btw", text: "/btw is this safe?", state: "terminal-required", preview: "❯ /btw is this safe?\nyes" });
    const html = render({ agent: "claude", messages: [], outcomes: [btw] });
    expect(html).toContain('data-outcome-id="o-btw"');
    expect(html).toContain('data-outcome-state="terminal-required"');
    expect(html).toContain("chat-turn-sent");
    expect(html).toContain("chat-outcome-preview");
    expect(html.match(/chat-turn-user/g)).toHaveLength(1);
  });

  it("puts the chip on the scrollback turn that records the command, and a sent row for one no turn records", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", text: "/compact" },
      { role: "assistant", text: "Compacted." },
      { role: "status", text: "❯" },
    ] as TranscriptMessage[];
    const compact = outcome({ id: "o-compact", text: "/compact", state: "result-observed", evidence: [{ kind: "transcript", at: "2026-10-20T10:00:05.000Z" }] });
    const cost = outcome({ id: "o-cost", text: "/cost", state: "terminal-required", created_at: "2026-10-20T10:01:00.000Z", updated_at: "2026-10-20T10:01:00.000Z" });
    const html = render({ agent: null, messages, outcomes: [compact, cost] });
    expect(html).toContain('data-outcome-state="result-observed"');
    expect(html).toContain('data-outcome-id="o-cost"');
    expect(html.match(/chat-turn-sent/g)).toHaveLength(1);
    expect(html.match(/class="chat-outcome"/g)).toHaveLength(2);
    expect(html.match(/chat-turn-user/g)).toHaveLength(2);
  });

  it("says why an agent's conversation could not be read and what to do, with the terminal a tap away", () => {
    const open = () => {};
    const notFound = render({ agent: "claude", messages: [], outcomes: [], unavailable: "not_found", onOpenTerminal: open });
    expect(notFound).toContain("Claude Code has not recorded a conversation Ovis can find for this pane yet.");
    expect(notFound).toContain("Open Terminal");
    expect(render({ agent: "claude", messages: [], outcomes: [], unavailable: "no_reader" })).toContain("Ovis can&#x27;t read Claude Code conversations yet.");
    expect(render({ agent: "claude", messages: [], outcomes: [], unavailable: "unreadable" })).toContain("Ovis couldn&#x27;t find or read the file Claude Code keeps this conversation in.");
    expect(render({ agent: "claude", messages: [], outcomes: [], unavailable: "no_folder" })).toContain("herdr has not said which folder this pane is in");
    expect(render({ agent: "opencode", messages: [], outcomes: [], unavailable: "no_integration" })).toContain("OpenCode chat needs herdr&#x27;s OpenCode integration, which is not installed on this PC.");
    expect(render({ agent: "claude", messages: [], outcomes: [], unavailable: "unreadable" })).not.toContain("Open Terminal");
    expect(notFound).toContain("<summary>Show a terminal output preview</summary>");
    expect(render({ agent: "claude", messages: [], outcomes: [] })).not.toContain("chat-unavailable-reason");
  });

  it("gives a cancelled send the agent put back no row, and keeps the receipt of an earlier identical send", () => {
    const first = outcome({ id: "o-first", text: "/compact", state: "result-observed", evidence: [{ kind: "transcript", at: "2026-10-20T10:00:05.000Z" }] });
    const second = outcome({ id: "o-second", text: "/compact", created_at: "2026-10-20T10:02:00.000Z", updated_at: "2026-10-20T10:02:00.000Z" });
    const html = render({ agent: "claude", messages: [], outcomes: [first, second], restored: "/compact" });
    expect(html).toContain('data-outcome-id="o-first"');
    expect(html).not.toContain('data-outcome-id="o-second"');
  });
});
