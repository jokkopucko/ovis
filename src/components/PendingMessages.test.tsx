import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { translate } from "../lib/i18n.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { PendingMessages } from "./PendingMessages.tsx";

const render = (code: string, message: string, languages: string[], serverOwned = true, state: "held" | "uncertain" = "held"): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: languages });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(PendingMessages, {
      messages: [{ id: "p1", request_id: 1, text: "ls", state, created_at: "2026-10-14T00:00:00.000Z", serverOwned, error: { code, message } }],
      connected: true, blocked: false, unsaved: false, isBusy: () => false,
      onSendNow: async () => {}, onEdit: async () => {}, onDiscard: async () => {},
    }) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

describe("a pending row's refusal note", () => {
  it("does not offer Edit on another tab's saved held copy", () => {
    const html = render("held_input", "held", ["en"], false);
    expect(html).not.toContain("Edit queued message");
    expect(html).toContain("pending-message-send");
  });
  it("offers a labeled Edit only for unsent input, in every supported language", () => {
    for (const language of ["en", "ja", "ko", "zh"] as const) {
      const label = translate(language, "Edit queued message");
      if (language !== "en") expect(label).not.toBe("Edit queued message");
      expect(render("held_input", "held", [language])).toContain(`aria-label="${label}: ls"`);
      expect(render("transcript_unconfirmed", "sent", [language], false, "uncertain")).not.toContain(`aria-label="${label}`);
    }
  });

  it.each(["en", "ko", "ja", "zh"] as const)("shows a confirmed agent change on an uncertain message in %s", (language) => {
    const fields = { from: "Build", to: "Plan" };
    const message = `Tab switched OpenCode's agent from ${JSON.stringify(fields.from)} to ${JSON.stringify(fields.to)}. Nothing more was typed.`;
    const note = translate(language, "Tab switched OpenCode's agent from {from} to {to}. Nothing more was typed. Check the terminal before sending again.", fields);
    const expected = renderToStaticMarkup(createElement("span", null, note)).slice("<span>".length, -"</span>".length);
    expect(render("submit_changed", message, [language], true, "uncertain")).toContain(expected);
  });

  it.each(["en", "ko", "ja", "zh"] as const)("shows that Tab attached another skill on an uncertain message in %s", (language) => {
    const message = "OpenCode attached another skill. Your chat text stayed here. Check the terminal before sending again.";
    const expected = renderToStaticMarkup(createElement("span", null, translate(language, message))).slice("<span>".length, -"</span>".length);
    const html = render("submit_changed", message, [language], true, "uncertain");
    expect(html).toContain(expected);
    expect(html).not.toContain(translate(language, "Not confirmed. Check the terminal before sending again."));
  });

  it("says a held-input refusal in the reader's language, not the raw English reason", () => {
    const held = translate("ko", "Not sent: send or discard the held input first.");
    expect(held).not.toBe("Not sent: send or discard the held input first.");
    const html = render("held_input", "send or discard the held input first", ["ko"]);
    expect(html).toContain(held);
    expect(html).not.toContain("send or discard the held input first");
  });

  it("keeps Send now on a saved copy whose send never left the browser, and says it was not sent (regression #541)", () => {
    const note = translate("ko", "Not sent: the connection dropped before this message left. Send it again.");
    expect(note).not.toBe("Not sent: the connection dropped before this message left. Send it again.");
    const html = render("not_transmitted", "the connection dropped before this message was sent", ["ko"], false);
    expect(html).toContain(note);
    expect(html).toContain("pending-message-send");
    expect(html).not.toContain("the connection dropped before this message was sent");
  });

  it("says a resend refused before the bridge said what it supports in the reader's language (#1809)", () => {
    for (const language of ["ko", "ja", "zh"] as const) {
      const note = translate(language, "Not sent: this PC has not said yet what it supports. Send it again.");
      expect(note).not.toBe("Not sent: this PC has not said yet what it supports. Send it again.");
      const html = render("capabilities_unknown", "this PC has not said yet what it supports; nothing was sent", [language], false);
      expect(html).toContain(note);
      expect(html).toContain("pending-message-send");
      expect(html).not.toContain("this PC has not said yet what it supports; nothing was sent");
    }
  });

  it("tells a first message whose launched agent ended apart from a changed terminal or session, in the reader's language (#1547)", () => {
    for (const language of ["ko", "ja", "zh"] as const) {
      const ended = translate(language, "Not sent: the agent started for this message has ended. Review the message before sending it.");
      const changed = translate(language, "Not sent: the pane's terminal or agent session changed. Review the message before sending it again.");
      const endedHtml = render("first_message_launch_ended", "The agent started for this message has ended; review the message before sending it", [language]);
      expect(endedHtml).toContain(ended);
      expect(endedHtml).not.toContain("has ended; review the message");
      const changedHtml = render("pending_target_changed", "The pane's terminal or agent session changed; review the message before sending it again", [language]);
      expect(changedHtml).toContain(changed);
      expect(changedHtml).not.toContain("agent session changed; review the message");
    }
  });

  // #511: a held message whose paste was left in the terminal's input line tells where it is, in every language
  it("says plainly that a held message sits in the terminal's input line", () => {
    for (const language of ["en", "ko", "ja", "zh"] as const) {
      const html = render("pasted_not_sent", "The message is in the terminal's input line, not sent; clear it or press Enter there", [language], true, "uncertain");
      // uncertain: copied or discarded, never sent again from here
      expect(html).not.toContain("pending-message-send");
      expect(html).toContain(translate(language, "Not sent: the message is in the terminal's input line. Clear it there, or press Enter there to send it.").replace(/'/g, "&#x27;"));
    }
  });

  it("shows the still-open note as the composer wrote it, once", () => {
    const note = translate("ko", "Not sent: {command} is still open in the terminal.", { command: "/btw" });
    const html = render("still_open", note, ["ko"]);
    expect(html).toContain(note);
    expect(html).not.toContain(translate("ko", "Not sent: {message}", { message: note }));
  });

  it("keeps the server's reason for other refusals", () => {
    expect(render("agent_blocked", "the agent is busy", ["en"])).toContain("Not sent: the agent is busy");
  });

  it("encodes a live Pi receipt as the existing non-resendable uncertain state", () => {
    const html = render("pi_transcript_pending", "waiting", ["en"], true, "uncertain");
    expect(html).toContain("Sent to Pi · waiting for transcript");
    expect(html).not.toContain("pending-message-send");
    expect(html).not.toContain("Discard saved copy");
    expect(html).not.toContain("Edit queued message");
  });
});
