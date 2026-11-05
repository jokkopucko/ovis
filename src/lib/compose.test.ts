import { describe, expect, it } from "bun:test";

import { skillSyntax } from "../../shared/skill-syntax.ts";
import { agentDisplayLabel, claudeMainAtRest, composerDelivery, composerMessage, composerSendShown, composerPayload, composerModelDraw, composerStatusCompact, composerStatusHint, composerStatusWord, COMPOSER_STATUS_COMPACT_BELOW, contextLeftPercent, formatTokens, imageMention, insertLeadingMention, insertNote, MAX_COMPOSER_CHARS, QUEUE_READY_STATUS, rankSlashCommands, submitNote, submitNotTyped, submitRefusal, sameMessage, pendingActionUncertain, draftSendNote, endsWithTurn, stoppedTurn } from "./compose.ts";
import { briefDescription, COMMAND_GROUPS, commandGroup, commandsForTrigger, slashCommandReplacement, terminalCommand, typedTerminalCommand } from "./compose.ts";
import type { ConversationTurn, SlashCommand } from "../../shared/protocol.ts";
import { activeTrigger, applyCompletion, type ActiveTrigger } from "./mentions.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneCommands } from "../../server/commands.ts";
import { NO_AGENT_MESSAGE, PASTED_NOT_SENT_MESSAGE } from "../../shared/submit-outcome.ts";
import { setCurrentLanguage, translate } from "./i18n.ts";

describe("menu rows", () => {
  it("keeps a description's first sentence, without its full stop", () => {
    expect(briefDescription("Drives a real browser through omowright. Use for any interactive browser task; not for a plain search.")).toBe("Drives a real browser through omowright");
    expect(briefDescription("Explains any senpi tip in depth, including Tip: lines in the TUI. Use when the user asks about a tip.")).toBe("Explains any senpi tip in depth, including Tip: lines in the TUI");
    expect(briefDescription("Set thinking level")).toBe("Set thinking level");
    expect(briefDescription("Show changelog entries.")).toBe("Show changelog entries");
    // a stop before a lowercase word, inside a version or in an ellipsis ends no sentence
    expect(briefDescription("Fetch docs, e.g. for react. Then stop.")).toBe("Fetch docs, e.g. for react");
    expect(briefDescription("Upgrade to v1.2 now")).toBe("Upgrade to v1.2 now");
    expect(briefDescription("Loading...")).toBe("Loading...");
    expect(briefDescription("\uC2A4\uD0AC\uC744 \uCC3E\uB294\uB2E4. \uADF8\uB9AC\uACE0 \uC124\uCE58\uD55C\uB2E4.")).toBe("\uC2A4\uD0AC\uC744 \uCC3E\uB294\uB2E4");
    expect(briefDescription("\u30B9\u30AD\u30EB\u3092\u63A2\u3059\u3002\u6B21\u306B\u5165\u308C\u308B\u3002")).toBe("\u30B9\u30AD\u30EB\u3092\u63A2\u3059");
  });

  it("groups a skill by where it comes from, and anything else by its source", () => {
    expect(commandGroup({ name: "skill:mine", description: "", source: "skill", origin: "user" })).toBe("skill-user");
    expect(commandGroup({ name: "deploy", description: "", source: "skill", origin: "project" })).toBe("skill-project");
    expect(commandGroup({ name: "skill:mass-ulw", description: "", source: "skill", origin: "bundled" })).toBe("skill-bundled");
    expect(commandGroup({ name: "hud:setup", description: "", source: "skill", origin: "plugin" })).toBe("skill-plugin");
    expect(commandGroup({ name: "review", description: "", source: "skill" })).toBe("skill");
    expect(commandGroup({ name: "model", description: "", source: "builtin" })).toBe("builtin");
    // a plugin's command file is not a skill: it keeps its own group
    expect(commandGroup({ name: "hud:configure", description: "", source: "plugin" })).toBe("plugin");
  });
});

describe("omo command completion", () => {
  const builtin = { name: "model", description: "", source: "builtin" as const };
  const skill = { name: "skill:mass-ulw", description: "", source: "skill" as const };
  const commands = [builtin, skill];
  const slash: ActiveTrigger = { kind: "slash", query: "", start: 0, end: 1 };
  const dollar: ActiveTrigger = { ...slash, prefix: "$" };

  it("offers only skills for dollar triggers at the start or inside a message", () => {
    expect(commandsForTrigger(commands, "omo", dollar)).toEqual([skill]);
    expect(commandsForTrigger(commands, "omo", { ...dollar, start: 4, end: 5 })).toEqual([skill]);
  });

  it("offers commands and skills for leading slash triggers but nothing inline", () => {
    expect(commandsForTrigger(commands, "omo", slash)).toEqual(commands);
    expect(commandsForTrigger(commands, "omo", { ...slash, start: 4, end: 5 })).toEqual([]);
  });

  it("matches skills by a bare name or a namespaced prefix", () => {
    for (const query of ["mas", "skill:mas"]) {
      expect(rankSlashCommands(commandsForTrigger(commands, "omo", dollar), query, {}, true)).toEqual([skill]);
    }
  });

  it("inserts omo slash and dollar skills with their namespace and trailing space", () => {
    for (const text of ["/skill:mas", "$skill:mas", "use $skill:mas"]) {
      const trigger = activeTrigger(text, text.length, { skills: true, namespaced: true });
      if (trigger === null) throw new Error("Expected omo skill trigger");
      const replacement = slashCommandReplacement(skill, "omo", trigger);
      const completed = applyCompletion(text, trigger, replacement);
      const expected = text.replace("skill:mas", "skill:mass-ulw ");
      expect(completed).toEqual({ text: expected, caret: expected.length });
    }
    expect(slashCommandReplacement(builtin, "omo", slash)).toBe("/model ");
  });

  it("keeps Claude, Codex and pi filtering and insertion unchanged", () => {
    const claudeSkill = { name: "delegate", description: "", source: "skill" as const };
    const codexSkill = { ...claudeSkill, trigger: "$" as const };
    const inline = { ...slash, start: 4, end: 5 };
    expect(commandsForTrigger([builtin, claudeSkill], "claude", slash)).toEqual([builtin, claudeSkill]);
    expect(commandsForTrigger([builtin, claudeSkill], "claude", inline)).toEqual([claudeSkill]);
    expect(commandsForTrigger([builtin, codexSkill], "codex", slash)).toEqual([builtin]);
    expect(commandsForTrigger([builtin, codexSkill], "codex", dollar)).toEqual([codexSkill]);
    expect(commandsForTrigger([builtin, codexSkill], "codex", inline)).toEqual([codexSkill]);
    expect(commandsForTrigger([builtin, codexSkill], "codex", { ...inline, prefix: "$" })).toEqual([codexSkill]);
    expect(commandsForTrigger(commands, "pi", slash)).toEqual(commands);
    expect(commandsForTrigger(commands, "pi", inline)).toEqual([]);
    expect(activeTrigger("$", 1)).toBeNull();
    expect(slashCommandReplacement(claudeSkill, "claude", inline)).toBe("/delegate ");
    expect(slashCommandReplacement(codexSkill, "codex", inline)).toBe("$delegate ");
    expect(slashCommandReplacement(skill, "pi", slash)).toBe("/skill:mass-ulw ");
  });

  it("keeps a Claude, Codex or pi menu open past the colon of a namespaced name", () => {
    const options = (agent: string) => ({ skills: skillSyntax(agent).skillTriggers.includes("$"), namespaced: skillSyntax(agent).namespaced });
    expect(activeTrigger("/plugin:bra", 11, options("claude"))).toEqual({ kind: "slash", query: "plugin:bra", start: 0, end: 11 });
    expect(activeTrigger("/prompts:rev", 12, options("codex"))).toEqual({ kind: "slash", query: "prompts:rev", start: 0, end: 12 });
    expect(activeTrigger("/skill:pd", 9, options("pi"))).toEqual({ kind: "slash", query: "skill:pd", start: 0, end: 9 });
    expect(activeTrigger("x $", 3, options("pi"))).toBeNull();
    // the whole namespaced name is what Enter writes, for a pi skill as for an omo one
    expect(applyCompletion("/skill:pd", activeTrigger("/skill:pd", 9, options("pi"))!, slashCommandReplacement(skill, "pi", slash))).toEqual({ text: "/skill:mass-ulw ", caret: 16 });
  });

  it("keeps Command Code mode completion open after a colon", () => {
    const syntax = skillSyntax("cmd");
    const options = { skills: syntax.skillTriggers.includes("$"), namespaced: syntax.namespaced };
    for (const text of ["/mode:", "/mode:pl"]) {
      expect(activeTrigger(text, text.length, options)).toEqual({ kind: "slash", query: text.slice(1), start: 0, end: text.length });
    }
  });

  it("offers omp inline /skill: but not /model or dollar triggers", () => {
    const syntax = skillSyntax("omp");
    const options = { skills: syntax.skillTriggers.includes("$"), namespaced: syntax.namespaced };
    const text = "please /skill:mas";
    const trigger = activeTrigger(text, text.length, options);
    if (trigger === null) throw new Error("Expected omp skill trigger");
    expect(rankSlashCommands(commandsForTrigger(commands, "omp", trigger), trigger.query, {}, true)).toEqual([skill]);
    const model = "please /model";
    const modelTrigger = activeTrigger(model, model.length, options);
    if (modelTrigger === null) throw new Error("Expected slash trigger");
    expect(rankSlashCommands(commandsForTrigger(commands, "omp", modelTrigger), modelTrigger.query, {}, true)).toEqual([]);
    expect(activeTrigger("x $", 3, options)).toBeNull();
  });
});

describe("composerMessage and submitNote", () => {
  it("keeps the message as written for agent.prompt: inner newlines stay, the composer's own trailing ones go", () => {
    expect(composerMessage("line one\r\nline two\n\n")).toBe("line one\nline two");
  });

  it("keeps pasted Markdown, blank lines and code indentation in one submitted message", () => {
    const message = "# Reply\n\n- first\n- second\n\n```ts\n  run();\n```";
    expect(composerMessage(message.replaceAll("\n", "\r\n"))).toBe(message);
    expect(composerPayload(message, true)).toBe("\u001b[200~" + message.replaceAll("\n", "\r") + "\u001b[201~");
  });

  it("says why a message did not go, and never claims a lost one was sent", () => {
    expect(submitNote("agent_blocked", "x")).toBe("Not sent: the agent is waiting for an answer in the terminal. Answer it first.");
    expect(submitNote("read_only", "x")).toBe("Not sent: this view only watches the pane.");
    expect(submitNote("submit_timeout", "x")).toMatch(/^Not sent: .*nothing was typed/);
    expect(submitNote("disconnected", "x")).toMatch(/^Not confirmed: .*Check the terminal/);
    expect(submitNote("pane_not_found", "pane w1:p9 not found")).toBe("Not sent: pane w1:p9 not found");
    // #511: the no-agent sentence is for the bridge's no-agent refusal alone; an unknown input state keeps its own words
    expect(submitNote("agent_not_ready", NO_AGENT_MESSAGE)).toBe("Not sent: no agent is running in this pane. Your message stayed here.");
    expect(submitNote("agent_not_ready", "The agent's current input state is not known")).toBe("Not sent: The agent's current input state is not known");
    // a paste left in the input line says so, and is never taken for a refusal that typed nothing
    expect(submitNote("pasted_not_sent", PASTED_NOT_SENT_MESSAGE)).toBe("Not sent: the message is in the terminal's input line. Clear it there, or press Enter there to send it.");
    expect(submitNotTyped("pasted_not_sent")).toBe(false);
  });

  it("knows a refusal that typed nothing from a message that may have reached the pane", () => {
    expect(["submit_timeout", "agent_blocked", "read_only"].map(submitNotTyped)).toEqual([true, true, true]);
    expect(["disconnected", "timeout", "submit_failed"].map(submitNotTyped)).toEqual([false, false, false]);
    expect(["pending_input_unsupported", "invalid_delivery", "invalid_submit_text", "agent_not_ready", "pending_limit"].map(submitNotTyped)).toEqual([true, true, true, true, true]);
    expect(["pane_not_found", "retired_submit_id"].map(submitNotTyped)).toEqual([true, true]);
    // refused before the paste because Claude's input box held a draft (#609)
    expect(submitNotTyped("input_draft")).toBe(true);
    // refused by the view while the terminal holds input, before anything reached the socket
    expect(submitNotTyped("held_input")).toBe(true);
    // regression #541: a send dropped before its frame left the browser typed nothing
    expect(submitNotTyped("not_transmitted")).toBe(true);
    expect(submitNote("not_transmitted", "the connection dropped before this message was sent")).toBe("Not sent: the connection dropped before this message left. Send it again.");
    // a send whose wait ended before the PC said what it supports typed nothing, and the note names that, not a drop (#1806)
    expect(submitNotTyped("capabilities_unknown")).toBe(true);
    expect(submitNote("capabilities_unknown", "this PC has not said yet what it supports; nothing was sent")).toBe("Not sent: this PC has not said yet what it supports. Send it again.");
    // an Insert refused for a control character says so, not that the terminal is not ready: a retry would be refused the same
    expect(insertNote("invalid_insert_text", "the text holds a control character")).toBe("Not inserted: the line holds a control character. Remove it, then insert again.");
    expect(insertNote("capabilities_unknown", "this PC has not said yet what it supports; nothing was sent")).toBe("Not inserted: this PC has not said yet what it supports. Insert it again.");
    // a Send now that never left proves a held row unsent, not a queued one its turn's end may still type
    expect(pendingActionUncertain("not_transmitted", "held")).toBe(false);
    expect(pendingActionUncertain("not_transmitted", "queued")).toBe(true);
    expect(pendingActionUncertain("pending_not_found", "held")).toBe(true);
    expect(pendingActionUncertain("agent_blocked", "queued")).toBe(false);
    expect(pendingActionUncertain("disconnected", "held")).toBe(true);
    expect(submitNote("held_input", "x")).toBe("Not sent: send or discard the held input first.");
    expect(submitNote("pending_input_unsupported", "x")).toBe("Update this PC to send messages in the next turn. Your draft stayed here.");
    // a first message held because its launched agent ended typed nothing, and says so apart from a changed terminal or session, in the client's words (#1547)
    expect(submitNotTyped("first_message_launch_ended")).toBe(true);
    const ended = "The agent started for this message has ended; review the message before sending it";
    const changed = "The pane's terminal or agent session changed; review the message before sending it again";
    expect(submitNote("first_message_launch_ended", ended)).not.toContain(ended);
    expect(submitNote("pending_target_changed", changed)).not.toContain(changed);
    expect(submitNote("first_message_launch_ended", "x")).not.toBe(submitNote("pending_target_changed", "x"));
    expect(submitNotTyped("submit_changed")).toBe(false);
    expect(submitNotTyped("pending_uncertain")).toBe(false);
    expect(submitNotTyped("submit_partial")).toBe(false);
  });

  it("offers to clear a terminal draft only when the server named one", () => {
    expect(submitRefusal("input_draft", "x", "ㅔ")).toEqual({ note: "Not sent: Claude Code's input box in the terminal already holds “ㅔ”.", draft: "ㅔ" });
    // bash mode, a clipped box or an older bridge name none: the note alone
    expect(submitRefusal("input_draft", "x")).toBe(submitNote("input_draft", "x"));
    expect(submitRefusal("agent_blocked", "x", "ㅔ")).toBe(submitNote("agent_blocked", "x"));
  });

  it("names the draft after a Send it that did not go, and offers another draft's buttons", () => {
    const other = submitRefusal("input_draft", "x", "other draft");
    expect(draftSendNote(other, "fix the tests")).toBe(other);
    // cleared and not confirmed, refused, or a box shown with no draft named: the reason, then the draft
    for (const result of [submitNote("submit_partial", "x"), submitNote("agent_not_ready", "x"), submitRefusal("input_draft", "x", undefined, "! ls")]) {
      const note = draftSendNote(result, "fix the tests");
      expect(typeof note).toBe("string");
      expect(note as string).toStartWith(`${typeof result === "string" ? result : submitNote("input_draft", "x")}\n`);
      expect(note as string).toContain("fix the tests");
    }
  });

  it("offers to send anyway only when the server showed the box and named no draft", () => {
    expect(submitRefusal("input_draft", "x", undefined, "! ls")).toEqual({ note: "Not sent: Claude Code's input box in the terminal may not be empty. It shows “! ls”.", anyway: true });
    // a box the server could not read whole is shown nothing to send over: the plain note
    expect(submitRefusal("input_draft", "x", undefined, "")).toBe(submitNote("input_draft", "x"));
    // a named draft is cleared, not sent over
    expect(submitRefusal("input_draft", "x", "ㅔ", "❯ ㅔ")).toEqual({ note: "Not sent: Claude Code's input box in the terminal already holds “ㅔ”.", draft: "ㅔ" });
    expect(submitRefusal("agent_blocked", "x", undefined, "! ls")).toBe(submitNote("agent_blocked", "x"));
  });
});

describe("sameMessage", () => {
  it("matches a message wrapped and indented by the terminal, never an empty or edited one", () => {
    expect(sameMessage("fix the login bug\nthen run tests", "fix the login\u00a0bug\n  then run tests")).toBe(true);
    expect(sameMessage("fix the login bug", "fix the logout bug")).toBe(false);
    expect(sameMessage("  ", "")).toBe(false);
  });
});

describe("a stopped send's turn", () => {
  const turn = (role: ConversationTurn["role"], text: string, ts: string): ConversationTurn => ({ role, ts, parts: [{ kind: "text", text }] });
  const words = "Rename the backup job\nand rerun it";
  const page = [turn("assistant", "earlier answer", "2026-11-01T00:00:01Z"), turn("user", words, "2026-11-01T00:00:02Z")];

  it("is the same turn in a later read whose earlier turns changed, until a newer turn", () => {
    const stopped = stoppedTurn(page, "Rename the backup job and rerun it");
    expect(stopped).not.toBeNull();
    // a new turns array: an earlier turn edited, the stopped turn a new object with the same time and words
    expect(endsWithTurn([turn("assistant", "earlier answer, edited", "2026-11-01T00:00:01Z"), { ...page[1]! }], stopped)).toBe(true);
    expect(endsWithTurn([...page, turn("assistant", "answer", "2026-11-01T00:00:03Z")], stopped)).toBe(false);
    // the same words sent again are a newer turn
    expect(endsWithTurn([page[0]!, turn("user", words, "2026-11-01T00:00:04Z")], stopped)).toBe(false);
    expect(stoppedTurn(page, "other words")).toBeNull();
  });

  it("taken while the copy was in the box, still names it after a read that answers no copy", () => {
    // the send empties the box: a read before the send's receipt answers no restored copy
    const taken = stoppedTurn(page, words);
    expect(stoppedTurn(page, null)).toBeNull();
    expect(endsWithTurn(page, taken)).toBe(true);
  });
});

describe("OpenCode agent-change refusal", () => {
  it.each(["en", "ko", "ja", "zh"] as const)("localizes the refusal fields in %s", (language) => {
    const fields = { from: 'Build "custom"', to: "Plan \\ next" };
    const message = `Tab switched OpenCode's agent from ${JSON.stringify(fields.from)} to ${JSON.stringify(fields.to)}. Nothing more was typed.`;
    setCurrentLanguage(language);
    try {
      expect(submitNote("submit_changed", message)).toBe(translate(language, "Tab switched OpenCode's agent from {from} to {to}. Nothing more was typed. Check the terminal before sending again.", fields));
    } finally {
      setCurrentLanguage("en");
    }
  });

  it.each(["en", "ko", "ja", "zh"] as const)("localizes the another-skill refusal in %s", (language) => {
    const message = "OpenCode attached another skill. Your chat text stayed here. Check the terminal before sending again.";
    setCurrentLanguage(language);
    try {
      expect(submitNote("submit_changed", message)).toBe(translate(language, message));
      expect(submitNote("submit_changed", message)).not.toContain("Not sent");
    } finally {
      setCurrentLanguage("en");
    }
  });
});

describe("composerPayload", () => {
  it("bracketed mode wraps the text as one paste, without the submit", () => {
    expect(composerPayload("hello", true)).toBe("\u001b[200~hello\u001b[201~");
  });

  it("bracketed mode keeps inner newlines literal to the TUI input box", () => {
    expect(composerPayload("line one\nline two", true)).toBe("\u001b[200~line one\rline two\u001b[201~");
  });

  it("normalizes CRLF and lone CR to the pty newline CR", () => {
    expect(composerPayload("a\r\nb\rc", true)).toBe("\u001b[200~a\rb\rc\u001b[201~");
  });

  it("drops trailing newlines: the submit CR belongs to the composer, not the text", () => {
    expect(composerPayload("cmd\n\n", true)).toBe("\u001b[200~cmd\u001b[201~");
    expect(composerPayload("cmd\n\n", false)).toBe("cmd");
  });

  it("plain mode uses classic paste semantics: every newline submits its own line", () => {
    expect(composerPayload("git status\ngit diff", false)).toBe("git status\rgit diff");
  });

  it("plain mode sends a single line; the submit CR goes on its own", () => {
    expect(composerPayload("git status", false)).toBe("git status");
  });

  it("empty text types nothing; its submit still goes on its own", () => {
    expect(composerPayload("", true)).toBe("\u001b[200~\u001b[201~");
    expect(composerPayload("", false)).toBe("");
  });

  it("drops whole paste markers from the message, so its text and its paste agree and neither ends early", () => {
    const pasted = "run this\u001b[201~\rtouch /tmp/x\n\u001b[200~next";
    expect(composerMessage(pasted)).toBe("run this\ntouch /tmp/x\nnext");
    expect(composerPayload(pasted, true)).toBe("\u001b[200~run this\rtouch /tmp/x\rnext\u001b[201~");
    expect(composerPayload(pasted, false)).toBe("run this\rtouch /tmp/x\rnext");
    // dropping one marker cannot leave another made of the bytes around it
    expect(composerMessage("a\u001b[20\u001b[201~0~b")).toBe("ab");
    // a marker at the end goes before the trailing newlines it hid
    expect(composerMessage("ls\n\u001b[201~")).toBe("ls");
  });

  it("keeps every other escape byte, which the bridge refuses rather than having it rewritten here", () => {
    expect(composerMessage("\u001b[31mred\u001b[0m")).toBe("\u001b[31mred\u001b[0m");
    expect(composerMessage("half \u001b[201")).toBe("half \u001b[201");
    expect(composerPayload("tab\there 한글 ✓", true)).toBe("\u001b[200~tab\there 한글 ✓\u001b[201~");
  });

  it("caps what one send can carry", () => {
    expect(MAX_COMPOSER_CHARS).toBeLessThanOrEqual(20_000);
    expect(composerPayload("x".repeat(MAX_COMPOSER_CHARS), false)).toHaveLength(MAX_COMPOSER_CHARS);
  });
});

describe("imageMention", () => {
  it("references the stored file as an editable @path with a trailing space", () => {
    expect(imageMention("/tmp/proj/.ovis/paste-1.png")).toBe(
      "@/tmp/proj/.ovis/paste-1.png ",
    );
  });
});

describe("insertLeadingMention", () => {
  const first = imageMention("/tmp/1.png");
  const second = imageMention("/tmp/2.png");

  it("puts an attachment's mention at the start, whatever is being typed further on", () => {
    expect(insertLeadingMention("", first, [])).toEqual({ text: "@/tmp/1.png ", at: 0, length: 12 });
    expect(insertLeadingMention("look at this", first, [])).toEqual({ text: "@/tmp/1.png look at this", at: 0, length: 12 });
  });

  it("keeps a leading slash command first", () => {
    expect(insertLeadingMention("/review the menu", first, [])).toEqual({ text: "/review @/tmp/1.png the menu", at: 8, length: 12 });
    expect(insertLeadingMention("/review", first, [])).toEqual({ text: "/review @/tmp/1.png ", at: 7, length: 13 });
  });

  it("goes after the mentions of files picked before it, so a batch reads in pick order however its uploads finish", () => {
    expect(insertLeadingMention(`${first}notes`, second, [first])).toEqual({ text: `${first}${second}notes`, at: 12, length: 12 });
    expect(insertLeadingMention(`${second}notes`, first, [])).toEqual({ text: `${first}${second}notes`, at: 0, length: 12 });
    // an earlier mention the user deleted no longer anchors anything
    expect(insertLeadingMention("notes", second, [first])).toEqual({ text: `${second}notes`, at: 0, length: 12 });
  });

  it("goes in whole or not at all: a cut path would name a file that does not exist", () => {
    const full = "x".repeat(MAX_COMPOSER_CHARS - 2);
    expect(insertLeadingMention(full, first, [])).toEqual({ text: full, at: 0, length: 0, missing: 10 });
    const room = "x".repeat(MAX_COMPOSER_CHARS - first.length);
    expect(insertLeadingMention(room, first, [])).toEqual({ text: `${first}${room}`, at: 0, length: first.length });
    // the separating space counts: after a command with no room for it, nothing goes in
    const command = `/review${"x".repeat(MAX_COMPOSER_CHARS - 7 - first.length)}`;
    expect(insertLeadingMention(command, first, [])).toEqual({ text: command, at: command.length, length: 0, missing: 1 });
  });
});

describe("composer presentation helpers", () => {
  it("holds queued messages while the agent needs an approval or answer", () => {
    expect(QUEUE_READY_STATUS.blocked).not.toBe(true);
    expect(QUEUE_READY_STATUS.working).not.toBe(true);
    expect(QUEUE_READY_STATUS.unknown).not.toBe(true);
    expect(QUEUE_READY_STATUS.done).toBe(true);
    expect(QUEUE_READY_STATUS.idle).toBe(true);
  });
  it("maps agent states to compact status words", () => {
    expect(composerStatusWord("idle")).toBe("READY");
    expect(composerStatusWord("working")).toBe("RUN");
    expect(composerStatusWord("blocked")).toBe("INPUT");
    expect(composerStatusWord("done")).toBe("DONE");
    expect(composerStatusWord("waiting")).toBe("BG");
    expect(composerStatusWord("paused")).toBe("READY");
  });

  it("makes the status row compact by the card's width, not the window's", () => {
    // a phone's card, and a laptop's with the sidebar open in a 940px window
    expect(composerStatusCompact(374)).toBe(true);
    expect(composerStatusCompact(588)).toBe(true);
    expect(composerStatusCompact(COMPOSER_STATUS_COMPACT_BELOW - 1)).toBe(true);
    // the threshold itself, a 1024px window with the sidebar open, and the full 820px card
    expect(composerStatusCompact(COMPOSER_STATUS_COMPACT_BELOW)).toBe(false);
    expect(composerStatusCompact(672)).toBe(false);
    expect(composerStatusCompact(820)).toBe(false);
    // a card that is not laid out yet has no width: it is not called narrow
    expect(composerStatusCompact(0)).toBe(false);
  });

  it("uses one Stop or Send control and queues all agents' working-turn messages", () => {
    expect(composerSendShown({ working: true, text: "" })).toBe(false);
    expect(composerSendShown({ working: true, text: " \n" })).toBe(false);
    expect(composerSendShown({ working: true, text: "check the tests" })).toBe(true);
    expect(composerSendShown({ working: false, text: "" })).toBe(true);
    for (const agent of ["codex", "claude", "pi", "omo"]) {
      expect(composerDelivery(agent, "working")).toBe("queue");
      for (const state of ["idle", "blocked", "done", "unknown"] as const) expect(composerDelivery(agent, state)).toBe("immediate");
    }
    expect(composerDelivery(null, "working")).toBe("immediate");
  });

  it("says the reconnecting sentence in the status content only once there is a draft", () => {
    // the empty box's placeholder says it
    expect(composerStatusHint({ uploading: false, connected: false, text: "" })).toBe(null);
    expect(composerStatusHint({ uploading: false, connected: false, text: " " })).toBe("offline");
    expect(composerStatusHint({ uploading: false, connected: false, text: "draft" })).toBe("offline");
    expect(composerStatusHint({ uploading: false, connected: true, text: "draft" })).toBe(null);
    expect(composerStatusHint({ uploading: true, connected: true, text: "" })).toBe("uploading");
    // an upload caught by a dropped connection: the box is empty, so the placeholder says why
    expect(composerStatusHint({ uploading: true, connected: false, text: "" })).toBe("uploading");
    // with a draft the placeholder is gone: the reconnecting sentence is the one said (the tile says Uploading)
    expect(composerStatusHint({ uploading: true, connected: false, text: "draft" })).toBe("offline");
  });

  it("counts the characters left only near the limit, and puts a path with no room first", () => {
    const near = "x".repeat(MAX_COMPOSER_CHARS - 200);
    expect(composerStatusHint({ uploading: false, connected: true, text: "x".repeat(MAX_COMPOSER_CHARS - 201) })).toBe(null);
    expect(composerStatusHint({ uploading: false, connected: true, text: near })).toBe("near-limit");
    expect(composerStatusHint({ uploading: true, connected: true, text: near })).toBe("uploading");
    expect(composerStatusHint({ uploading: true, connected: true, text: near, noRoom: true })).toBe("no-room");
    expect(composerStatusHint({ uploading: false, connected: false, text: near, noRoom: true })).toBe("offline");
  });

  it("removes the effort word before shortening the model", () => {
    expect(composerModelDraw({ modelClipped: false, effortClipped: false })).toBe("full");
    expect(composerModelDraw({ modelClipped: false, effortClipped: true })).toBe("no-effort");
    expect(composerModelDraw({ modelClipped: true, effortClipped: true })).toBe("no-effort");
    expect(composerModelDraw({ modelClipped: true, effortClipped: false })).toBe("no-effort");
  });

  it("turns machine agent ids into labels", () => {
    expect(agentDisplayLabel("claude")).toBe("Claude");
    expect(agentDisplayLabel("open_code")).toBe("Open Code");
    expect(agentDisplayLabel(null)).toBe("Shell");
  });

  it("filters slash commands by prefix and ranks frequent selections first", () => {
    const commands = [
      { name: "status", description: "Show status", source: "builtin" as const },
      { name: "start", description: "Start work", source: "project" as const },
      { name: "stop", description: "Stop work", source: "user" as const },
    ];
    expect(rankSlashCommands(commands, "st", { stop: 4, status: 2 })).toEqual([
      commands[2]!,
      commands[0]!,
      commands[1]!,
    ]);
  });

  it("also finds a command by a word of its name, a substring, its letters in order or its description", () => {
    const named = (name: string, description = "") => ({ name, description, source: "plugin" as const });
    const commands = [
      named("superpowers:brainstorming"),
      named("review", "Look over a diff"),
      named("code-review"),
      named("reviewer-notes"),
      named("my-brainstorm-helper"),
      named("unrelated", "Something else"),
    ];
    const find = (query: string) => rankSlashCommands(commands, query, {}).map((command) => command.name);
    // the namespace is not a prefix to type: the command's own word finds it
    expect(find("brain")).toEqual(["my-brainstorm-helper", "superpowers:brainstorming"]);
    // both name prefixes precede the word match
    expect(find("review")).toEqual(["review", "reviewer-notes", "code-review"]);
    expect(find("ainst")).toEqual(["my-brainstorm-helper", "superpowers:brainstorming"]);
    expect(find("spbr")).toEqual(["superpowers:brainstorming"]);
    expect(find("diff")).toEqual(["review"]);
    expect(find("zzz")).toEqual([]);
    expect(find("")).toHaveLength(commands.length);
    // a stronger kind of match beats a frequently used weaker one
    expect(rankSlashCommands(commands, "review", { "code-review": 9 }).map((command) => command.name)[0]).toBe("review");
  });

  it("keeps every match tier ahead of weaker alphabetical or frequently used results", () => {
    const commands = [
      { name: "a-preview", description: "", source: "plugin" as const },
      { name: "b-v-i-e-w", description: "", source: "plugin" as const },
      { name: "a-description", description: "view changes", source: "plugin" as const },
      { name: "z-view-notes", description: "", source: "plugin" as const },
      { name: "view", description: "", source: "plugin" as const },
    ];
    expect(rankSlashCommands(commands, "VIEW", { "a-description": 99 }).map(({ name }) => name))
      .toEqual(["view", "z-view-notes", "a-preview", "b-v-i-e-w", "a-description"]);
    expect(rankSlashCommands([{ name: "review", description: "diff", source: "builtin" }], "d", {})).toEqual([]);
  });

  it("keeps compound queries at word boundaries and applies usage within that tier", () => {
    const commands = ["a-mypdf-tools", "z:pdf-tools", "b:pdf-tools"]
      .map((name) => ({ name, description: "", source: "plugin" as const }));
    expect(rankSlashCommands(commands, "pdf-t", { "z:pdf-tools": 2 }).map(({ name }) => name))
      .toEqual(["z:pdf-tools", "b:pdf-tools", "a-mypdf-tools"]);
  });

  it("matches subsequences containing letters outside the basic multilingual plane", () => {
    const command = { name: "prefix:𐐨ab", description: "", source: "plugin" as const };
    expect(rankSlashCommands([command], "𐐀b", {})).toEqual([command]);
  });

  it("limits inline matching to name prefixes and segments after hyphens or colons", () => {
    const commands = ["deploy", "tools:deploy", "safe-deploy", "redeploy", "tools_deploy", "tools.deploy"]
      .map((name) => ({ name, description: "deployment", source: "skill" as const }));
    expect(rankSlashCommands(commands, "DEP", {}, true).map(({ name }) => name)).toEqual(["deploy", "safe-deploy", "tools:deploy"]);
    expect(rankSlashCommands(commands, "dply", {}, true)).toEqual([]);
    expect(rankSlashCommands(commands, "deployment", {}, true)).toEqual([]);
    expect(rankSlashCommands(commands, "", {}, true)).toHaveLength(6);
    const template = { name: "template-creator", description: "Create a reusable template", source: "skill" as const };
    expect(rankSlashCommands([template], "tmp", {})).toEqual([template]);
    expect(rankSlashCommands([template], "creator", {}, true)).toEqual([template]);
  });
});

describe("context left", () => {
  it("reads tokens and what is left the short way", () => {
    expect([950, 67_723, 435_404, 1_000_000, 1_250_000].map(formatTokens)).toEqual(["950", "68k", "435k", "1M", "1.3M"]);
    expect(contextLeftPercent({ used: 67_723, window: 258_400 })).toBe(74);
    expect(contextLeftPercent({ used: 300_000, window: 258_400 })).toBe(0);
    expect(contextLeftPercent({ used: 67_723, window: null })).toBeNull();
  });
});

// The catalog says which commands run in the terminal (a row's visibility, or its bare form's
// interaction): the chat lists them apart and never sends one on its own. A row the agent's own
// menu hides (agent-hidden) mirrors that menu: never listed, and typed by hand it goes like any text.
describe("terminal commands", () => {
  const config: SlashCommand = { name: "config", description: "Open configuration", source: "builtin", visibility: "terminal" };
  const tree: SlashCommand = { name: "tree", description: "Browse the session tree", source: "builtin", forms: [{ match: "bare", interaction: "terminal" }] };
  const model: SlashCommand = { name: "model", description: "Choose a model", source: "builtin", forms: [{ match: "bare", interaction: "dialog", dialog: "model" }, { match: "other", interaction: "none" }] };
  const resume: SlashCommand = { name: "resume", description: "Resume a session", source: "builtin", forms: [{ match: "bare", interaction: "dialog" }, { match: { sub: "list" }, interaction: "terminal" }] };
  const heapdump: SlashCommand = { name: "heapdump", description: "Write a heap dump", source: "builtin", visibility: "agent-hidden", forms: [{ match: "bare", interaction: "terminal" }] };
  const plain: SlashCommand = { name: "compact", description: "Compact the context", source: "builtin" };
  const skill: SlashCommand = { name: "deploy", description: "Deploy", source: "skill", origin: "project" };
  const commands = [config, tree, model, resume, heapdump, plain, skill];
  const slash: ActiveTrigger = { kind: "slash", query: "", start: 0, end: 1 };

  it("groups a row with terminal visibility, or a bare terminal form, apart from its source", () => {
    expect(terminalCommand(config)).toBe(true);
    expect(terminalCommand(tree)).toBe(true);
    // only a subcommand needs the terminal: the command itself stays with its source
    expect([model, resume, plain, skill].map(terminalCommand)).toEqual([false, false, false, false]);
    expect(commandGroup(config)).toBe("terminal");
    expect(commandGroup(tree)).toBe("terminal");
    expect(commandGroup(resume)).toBe("builtin");
    expect(commandGroup(skill)).toBe("skill-project");
    // the group stands last: the agent's offered commands first, what needs the terminal after them
    expect(COMMAND_GROUPS[COMMAND_GROUPS.length - 1]).toBe("terminal");
  });

  it("never lists an agent-hidden row, and lists terminal rows at a bare slash", () => {
    const listed = commandsForTrigger(commands, "claude", slash).map((command) => command.name);
    expect(listed).toEqual(["config", "tree", "model", "resume", "compact", "deploy"]);
    expect(terminalCommand(heapdump)).toBe(false);
    // rows without the new fields (an older server) read as they always did
    expect(commandsForTrigger([plain, skill], "claude", slash)).toEqual([plain, skill]);
  });

  it("finds the terminal command a message types, in the form it was typed", () => {
    expect(typedTerminalCommand(commands, "/config")).toBe(config);
    expect(typedTerminalCommand(commands, "  /CONFIG  ")).toBe(config);
    expect(typedTerminalCommand(commands, "/tree")).toBe(tree);
    // takes no argument, but a stray one is still the same command typed
    expect(typedTerminalCommand(commands, "/tree w13:p2")).toBe(tree);
    // the typed form decides: /model opens a dialog and /model sonnet needs nothing, /resume list needs the terminal
    expect(typedTerminalCommand(commands, "/model")).toBeNull();
    expect(typedTerminalCommand(commands, "/model sonnet")).toBeNull();
    expect(typedTerminalCommand(commands, "/resume")).toBeNull();
    expect(typedTerminalCommand(commands, "/resume list")).toBe(resume);
    expect(typedTerminalCommand(commands, "/resume LIST\nplease")).toBe(resume);
  });

  it("sends a hand-typed agent-hidden command, prose and look-alikes like any text", () => {
    expect(typedTerminalCommand(commands, "/heapdump")).toBeNull();
    expect(typedTerminalCommand(commands, "/compact")).toBeNull();
    expect(typedTerminalCommand(commands, "/configure")).toBeNull();
    expect(typedTerminalCommand(commands, "use /config to change it")).toBeNull();
    expect(typedTerminalCommand(commands, "config")).toBeNull();
    expect(typedTerminalCommand(commands, "//config")).toBeNull();
    expect(typedTerminalCommand(commands, "")).toBeNull();
    // a row typed with another trigger is another row: Codex's $skill is never /skill
    expect(typedTerminalCommand([{ ...config, trigger: "$" }], "/config")).toBeNull();
    expect(typedTerminalCommand([{ ...config, trigger: "$" }], "$config")).toEqual({ ...config, trigger: "$" });
    // a catalog without the fields names no terminal command, as before the fields existed
    expect(typedTerminalCommand([plain, skill], "/compact")).toBeNull();
  });

});

describe("the menu over a catalog the server built", () => {
  // The rows come from the integrated server catalog, serialized as they cross the wire, so the
  // client is checked against the forms and visibility the scanners really emit (Codex: terminal
  // screens and the popup's agent-hidden rows), not against hand-written rows.
  function codexRows(): SlashCommand[] {
    const home = mkdtempSync(join(tmpdir(), "compose-catalog-"));
    try {
      mkdirSync(join(home, ".codex", "skills", "deploy"), { recursive: true });
      writeFileSync(join(home, ".codex", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Ship it\n---\n");
      return JSON.parse(JSON.stringify(paneCommands("codex", null, home))) as SlashCommand[];
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  const slash: ActiveTrigger = { kind: "slash", query: "", start: 0, end: 1 };

  it("lists the terminal screens in the terminal group and never lists the agent-hidden rows", () => {
    const rows = codexRows();
    const listed = commandsForTrigger(rows, "codex", slash);
    const names = new Set(listed.map((row) => row.name));
    const terminal = new Set(listed.filter((row) => commandGroup(row) === "terminal").map((row) => row.name));
    for (const name of ["config", "resume", "permissions", "mcp", "status", "review"]) expect(terminal.has(name)).toBeTrue();
    for (const name of ["model", "compact", "init"]) expect(names.has(name) && !terminal.has(name)).toBeTrue();
    for (const name of ["apps", "debug-config", "debug-m-drop", "debug-m-update"]) {
      expect(rows.some((row) => row.name === name && row.visibility === "agent-hidden")).toBeTrue();
      expect(names.has(name)).toBeFalse();
    }
    expect(commandsForTrigger(rows, "codex", { ...slash, prefix: "$" }).map((row) => [row.name, commandGroup(row)])).toEqual([["deploy", "skill-user"]]);
  });

  it("lists Claude's terminal screens apart and leaves out what Claude's own menu hides", () => {
    const home = mkdtempSync(join(tmpdir(), "compose-catalog-"));
    let rows: SlashCommand[];
    try { rows = JSON.parse(JSON.stringify(paneCommands("claude", null, home))) as SlashCommand[]; }
    finally { rmSync(home, { recursive: true, force: true }); }
    const listed = commandsForTrigger(rows, "claude", slash);
    const names = new Set(listed.map((row) => row.name));
    const terminal = new Set(listed.filter((row) => commandGroup(row) === "terminal").map((row) => row.name));
    for (const name of ["config", "resume", "permissions"]) expect(terminal.has(name)).toBeTrue();
    expect(names.has("compact") && !terminal.has("compact")).toBeTrue();
    for (const name of ["agents", "heapdump", "setup-bedrock"]) {
      expect(rows.some((row) => row.name === name && row.visibility === "agent-hidden")).toBeTrue();
      expect(names.has(name)).toBeFalse();
    }
    expect(typedTerminalCommand(rows, "/config")?.name).toBe("config");
    expect(typedTerminalCommand(rows, "/heapdump")).toBeNull();
  });

  it("offers the terminal for what the catalog says needs it, and sends the rest as typed", () => {
    const rows = codexRows();
    expect(typedTerminalCommand(rows, "/config")?.name).toBe("config");
    expect(typedTerminalCommand(rows, "/review")?.name).toBe("review");
    expect(typedTerminalCommand(rows, "/review the auth change")).toBeNull();
    expect(typedTerminalCommand(rows, "/apps")).toBeNull();
    expect(typedTerminalCommand(rows, "/compact")).toBeNull();
  });
});

describe("claudeMainAtRest", () => {
  // the real shape of a Claude screen whose main turn ended while two subagents ran: herdr's claude
  // manifest still says working (a braille title spinner, plus background_agents_working)
  const restingWithSubagents = [
    "  Waiting for 2 background agents to finish",
    "  ◯ impl-mismatch2-sonnet      Resume store-mismatch build        24m 28s · ↓ 132.6k tokens",
    "  ◯ qa-p00win3-sonnet          P00 Windows checks and latency     9m 8s · ↓ 91.2k tokens",
    "  ────────────────────────────────────────────────────────────────",
    "  ❯",
    "  ────────────────────────────────────────────────────────────────",
    "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 2 agents",
  ];

  it("accepts a message when the row is at rest, whatever herdr reports", () => {
    expect(composerDelivery("claude", "working")).toBe("queue");
    expect(claudeMainAtRest("ready", restingWithSubagents)).toBe(true);
  });

  it("holds the message while a turn says how to interrupt it", () => {
    expect(claudeMainAtRest("ready", ["  ✻ Forming… (3m 35s · ↓ 4.8k tokens) · esc to interrupt", ...restingWithSubagents])).toBe(false);
    expect(claudeMainAtRest("ready", ["  ● Forming… (3m 35s · ↓ 4.8k tokens · thought for 1s)", ...restingWithSubagents])).toBe(false);
    expect(claudeMainAtRest("ready", ["  enter to confirm · esc to cancel", ...restingWithSubagents])).toBe(false);
  });

  it("holds the message while the row holds a draft", () => {
    expect(claudeMainAtRest("draft", restingWithSubagents)).toBe(false);
    expect(claudeMainAtRest("gone", restingWithSubagents)).toBe(false);
    expect(claudeMainAtRest("unknown", restingWithSubagents)).toBe(false);
    expect(claudeMainAtRest(null, restingWithSubagents)).toBe(false);
  });

  it("does not read a row it cannot see as at rest", () => {
    expect(claudeMainAtRest("ready", ["  ⏵⏵ auto mode on · ← 2 agents"])).toBe(false);
    expect(claudeMainAtRest("ready", ["  ────────────────", "  ⏵⏵ auto mode on"])).toBe(false);
  });
});
