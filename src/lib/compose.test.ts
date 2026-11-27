import { describe, expect, it } from "bun:test";

import { skillSyntax } from "../../shared/skill-syntax.ts";
import { AGENT_INPUT_DRAFT_MESSAGE, CLAUDE_FOLDED_DRAFT_MESSAGE, GROK_SEND_UNCONFIRMED_MESSAGE } from "../../shared/submit-outcome.ts";
import { agentDisplayLabel, claudeMainAtRest, composerDelivery, composerMessage, composerSendShown, composerPayload, composerModelDraw, composerStatusCompact, composerStatusHint, composerStatusWord, COMPOSER_STATUS_COMPACT_BELOW, contextLeftPercent, editBetween, followPlace, formatTokens, imageMention, insertMentionAt, insertNote, placedMention, removeMention, followMention, mentionWhole, MAX_COMPOSER_CHARS, QUEUE_READY_STATUS, rankSlashCommands, submitNote, submitNotTyped, submitRefusal, sameMessage, pendingActionUncertain, draftSendNote, endsWithTurn, stoppedTurn } from "./compose.ts";
import { briefDescription, COMMAND_GROUPS, commandGroup, commandsForTrigger, namesHiddenCommand, sendsBarePick, slashCommandReplacement, terminalCommand, typedTerminalCommand } from "./compose.ts";
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

  it("sends a picked OpenCode built-in that takes no argument bare, and every other pick with its space (#3813)", () => {
    const row = (name: string, source: SlashCommand["source"] = "builtin"): SlashCommand => ({ name, description: "", source });
    expect(sendsBarePick(row("new"), "opencode")).toBeTrue();
    expect(sendsBarePick(row("compact"), "opencode")).toBeTrue();
    // OpenCode's own menu only types these, with their space, for Enter to send
    for (const name of ["rename", "cd", "btw"]) expect(sendsBarePick(row(name), "opencode")).toBeFalse();
    for (const name of ["init", "review", "hello"]) expect(sendsBarePick(row(name), "opencode")).toBeFalse();
    for (const source of ["user", "project", "plugin", "skill"] as const) expect(sendsBarePick(row("hello", source), "opencode")).toBeFalse();
    expect(sendsBarePick({ ...row("customize-opencode", "skill"), trigger: "@" }, "opencode")).toBeFalse();
    for (const agent of ["claude", "codex", "omo", "pi", null]) expect(sendsBarePick(row("new"), agent)).toBeFalse();
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
    // line breaks that do not end the message are read in one pass, by the rule the server reads them with
    // (withoutTrailingBreaks): as a pattern they cost their count squared, a third of a second for the 20,000 the
    // composer takes
    expect(composerMessage(`${"\n".repeat(60_000)}a\n\n`).length).toBe(60_001);
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
    expect(submitNote("agent_not_ready", NO_AGENT_MESSAGE)).toBe("Not sent: no agent is running in this pane. Your message stayed here.");
    expect(submitNote("agent_not_ready", "The agent's current input state is not known")).toBe("Not sent: The agent's current input state is not known");
    expect(submitNote("pasted_not_sent", PASTED_NOT_SENT_MESSAGE)).toBe("Not sent: the message is in the terminal's input line. Clear it there, or press Enter there to send it.");
    expect(submitNotTyped("pasted_not_sent")).toBe(false);
  });

  it("knows a refusal that typed nothing from a message that may have reached the pane", () => {
    expect(["submit_timeout", "agent_blocked", "read_only"].map(submitNotTyped)).toEqual([true, true, true]);
    expect(["disconnected", "timeout", "submit_failed"].map(submitNotTyped)).toEqual([false, false, false]);
    expect(["pending_input_unsupported", "invalid_delivery", "invalid_submit_text", "agent_not_ready", "pending_limit"].map(submitNotTyped)).toEqual([true, true, true, true, true]);
    expect(["pane_not_found", "retired_submit_id"].map(submitNotTyped)).toEqual([true, true]);
    expect(submitNotTyped("input_draft")).toBe(true);
    expect(submitNotTyped("held_input")).toBe(true);
    expect(submitNotTyped("not_transmitted")).toBe(true);
    expect(submitNote("not_transmitted", "the connection dropped before this message was sent")).toBe("Not sent: the connection dropped before this message left. Send it again.");
    expect(submitNotTyped("capabilities_unknown")).toBe(true);
    expect(submitNote("capabilities_unknown", "this PC has not said yet what it supports; nothing was sent")).toBe("Not sent: this PC has not said yet what it supports. Send it again.");
    expect(insertNote("invalid_insert_text", "the text holds a control character")).toBe("Not inserted: the line holds a control character. Remove it, then insert again.");
    expect(insertNote("capabilities_unknown", "this PC has not said yet what it supports; nothing was sent")).toBe("Not inserted: this PC has not said yet what it supports. Insert it again.");
    expect(pendingActionUncertain("not_transmitted", "held")).toBe(false);
    expect(pendingActionUncertain("not_transmitted", "queued")).toBe(true);
    expect(pendingActionUncertain("pending_not_found", "held")).toBe(true);
    expect(pendingActionUncertain("agent_blocked", "queued")).toBe(false);
    expect(pendingActionUncertain("disconnected", "held")).toBe(true);
    expect(submitNote("held_input", "x")).toBe("Not sent: send or discard the held input first.");
    expect(submitNote("pending_input_unsupported", "x")).toBe("Update this PC to send messages in the next turn. Your draft stayed here.");
    expect(submitNotTyped("pending_hold_unsupported")).toBe(true);
    expect(submitNote("pending_hold_unsupported", "x")).toBe("Update this PC to hold messages. Your draft stayed here.");
    expect(submitNotTyped("first_message_launch_ended")).toBe(true);
    const ended = "The agent started for this message has ended; review the message before sending it";
    const changed = "The pane's terminal or agent session changed; review the message before sending it again";
    expect(submitNote("first_message_launch_ended", ended)).not.toContain(ended);
    expect(submitNote("pending_target_changed", changed)).not.toContain(changed);
    expect(submitNote("first_message_launch_ended", "x")).not.toBe(submitNote("pending_target_changed", "x"));
    expect(submitNote("typed_while_waiting", "x")).toBe("Not sent: something was typed in the terminal while omp was starting. Check its input line there, then send this message.");
    expect(submitNotTyped("submit_changed")).toBe(false);
    expect(submitNotTyped("pending_uncertain")).toBe(false);
    expect(submitNotTyped("submit_partial")).toBe(false);
  });

  it("offers to clear a terminal draft only when the server named one", () => {
    expect(submitRefusal("input_draft", "x", "ㅔ")).toEqual({ note: "Not sent: Claude Code's input box in the terminal already holds “ㅔ”.", draft: "ㅔ" });
    expect(submitRefusal("input_draft", "x")).toBe(submitNote("input_draft", "x"));
    expect(submitRefusal("agent_blocked", "x", "ㅔ")).toBe(submitNote("agent_blocked", "x"));
  });

  it("reports an unconfirmed Grok delivery without claiming it was never sent", () => {
    expect(submitRefusal("submit_changed", GROK_SEND_UNCONFIRMED_MESSAGE)).toStartWith("Not confirmed:");
  });

  it("names the draft after a Send it that did not go, and offers another draft's buttons", () => {
    const other = submitRefusal("input_draft", "x", "other draft");
    expect(draftSendNote(other, "fix the tests")).toBe(other);
    for (const result of [submitNote("submit_partial", "x"), submitNote("agent_not_ready", "x"), submitRefusal("input_draft", "x", undefined, "! ls")]) {
      const note = draftSendNote(result, "fix the tests");
      expect(typeof note).toBe("string");
      expect(note as string).toStartWith(`${typeof result === "string" ? result : submitNote("input_draft", "x")}\n`);
      expect(note as string).toContain("fix the tests");
    }
  });

  it("offers to send anyway only when the server showed the box and named no draft", () => {
    // a refusal over another agent's box keeps its note where herdr labels the pane Claude Code (an OmO with its SDK child)
    expect(submitNote("input_draft", AGENT_INPUT_DRAFT_MESSAGE, "claude")).toBe(submitNote("input_draft", "x", "gjc"));
    expect(submitNote("input_draft", "x", "claude")).not.toBe(submitNote("input_draft", "x", "gjc"));
    // Claude Code's box holding a folded paste has a note of its own, saying why nothing can be sent over it
    expect(submitNote("input_draft", CLAUDE_FOLDED_DRAFT_MESSAGE, "claude")).not.toBe(submitNote("input_draft", "x", "claude"));
    expect(submitRefusal("input_draft", "x", undefined, "! ls")).toEqual({ note: "Not sent: Claude Code's input box in the terminal may not be empty. It shows “! ls”.", anyway: true });
    expect(submitRefusal("input_draft", "x", undefined, "")).toBe(submitNote("input_draft", "x"));
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
    expect(endsWithTurn([turn("assistant", "earlier answer, edited", "2026-11-01T00:00:01Z"), { ...page[1]! }], stopped)).toBe(true);
    expect(endsWithTurn([...page, turn("assistant", "answer", "2026-11-01T00:00:03Z")], stopped)).toBe(false);
    expect(endsWithTurn([page[0]!, turn("user", words, "2026-11-01T00:00:04Z")], stopped)).toBe(false);
    expect(stoppedTurn(page, "other words")).toBeNull();
  });

  it("taken while the copy was in the box, still names it after a read that answers no copy", () => {
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
    expect(composerMessage("a\u001b[20\u001b[201~0~b")).toBe("ab");
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

describe("insertMentionAt (#3216)", () => {
  const mention = imageMention("/tmp/1.png");

  it("goes where the paste was made, with one space on each side", () => {
    expect(insertMentionAt("before after", mention, 7)).toEqual({ text: "before @/tmp/1.png after", at: 7, length: 12 });
    expect(insertMentionAt("before after", mention, 6)).toEqual({ text: "before @/tmp/1.png after", at: 6, length: 12 });
    expect(insertMentionAt("before after", mention, 12)).toEqual({ text: "before after @/tmp/1.png ", at: 12, length: 13 });
    expect(insertMentionAt("", mention, 0)).toEqual({ text: "@/tmp/1.png ", at: 0, length: 12 });
  });

  it("never goes inside a character", () => {
    expect(insertMentionAt("\u{1F603}b", mention, 1).text).toBe("@/tmp/1.png \u{1F603}b");
    expect(insertMentionAt("ae\u0301y", mention, 2).text).toBe("a @/tmp/1.png e\u0301y");
  });

  it("keeps a leading slash command whole and first", () => {
    expect(insertMentionAt("/review the menu", mention, 3)).toEqual({ text: "/review @/tmp/1.png the menu", at: 7, length: 12 });
    expect(insertMentionAt("/review", mention, 0)).toEqual({ text: "/review @/tmp/1.png ", at: 7, length: 13 });
  });

  it("goes in whole or not at all: a cut path would name a file that does not exist", () => {
    const full = "x".repeat(MAX_COMPOSER_CHARS - 2);
    expect(insertMentionAt(full, mention, 4)).toEqual({ text: full, at: 4, length: 0, missing: 11 });
    const room = "x".repeat(MAX_COMPOSER_CHARS - mention.length);
    expect(insertMentionAt(room, mention, 0)).toEqual({ text: `${mention}${room}`, at: 0, length: mention.length });
  });
});

describe("followPlace (#3216)", () => {
  it("stays before text typed at it and moves with text typed or removed before it", () => {
    expect(followPlace(7, { start: 12, removed: 0, inserted: 5 }, "before after more")).toBe(7);
    expect(followPlace(7, { start: 7, removed: 0, inserted: 1 }, "before xafter")).toBe(7);
    expect(followPlace(7, { start: 0, removed: 0, inserted: 3 }, "so before after")).toBe(10);
    expect(followPlace(7, { start: 5, removed: 1, inserted: 0 }, "befor after")).toBe(6);
  });

  it("goes to the start of a word typed on straight from it, never into it", () => {
    // "scree|" pasted at, then "n" typed: the path goes before the word, not inside "screen"
    expect(followPlace(5, { start: 5, removed: 0, inserted: 1 }, "screen")).toBe(0);
    expect(followPlace(12, { start: 12, removed: 0, inserted: 1 }, "look at this,")).toBe(8);
    // after a space, the typed word goes after the place
    expect(followPlace(8, { start: 8, removed: 0, inserted: 1 }, "look at nthis")).toBe(8);
  });

  it("goes to where an edit across it began, also when it ends where text was typed over", () => {
    expect(followPlace(7, { start: 3, removed: 6, inserted: 0 }, "befter")).toBe(3);
    // "this" (4..8) typed over by "t": the place after it goes before the new word
    expect(followPlace(8, { start: 4, removed: 4, inserted: 1 }, "fix t bug")).toBe(4);
    // only removed before it: it moves back with the text
    expect(followPlace(8, { start: 4, removed: 4, inserted: 0 }, "fix  bug")).toBe(4);
    expect(followPlace(12, { start: 0, removed: 13, inserted: 1 }, "n")).toBe(0);
  });
});

describe("removeMention (#3216)", () => {
  const mention = imageMention("/tmp/1.png");
  const removed = (text: string, place: number) => {
    const next = insertMentionAt(text, mention, place);
    return removeMention(next.text, placedMention(next, mention)).text;
  };

  it("takes out the path where it was put, with the spaces the upload added", () => {
    expect(removed("before after", 7)).toBe("before after");
    expect(removed("ab", 1)).toBe("ab");
    expect(removed("before\nafter", 6)).toBe("before\nafter");
    expect(removed("before\tafter", 6)).toBe("before\tafter");
  });

  it("keeps a space the user typed before the mention, and a copy of the path the user typed elsewhere", () => {
    expect(removed("before \nafter", 7)).toBe("before \nafter");
    expect(removed("see @/tmp/1.png x", 17)).toBe("see @/tmp/1.png x");
  });

  it("keeps one space when taking both of its own would glue another placed path to a word", () => {
    const second = imageMention("/tmp/2.png");
    const first = insertMentionAt("see", mention, 3);
    const both = insertMentionAt(first.text, second, first.text.length);
    expect(both.text).toBe("see @/tmp/1.png @/tmp/2.png ");
    const kept = placedMention(both, second);
    expect(removeMention(both.text, placedMention(first, mention), [kept]).text).toBe("see @/tmp/2.png ");
    // with no other path beside it, the word split by the paste comes back as it was
    expect(removeMention(first.text, placedMention(first, mention), [kept]).text).toBe("see");
  });
});

describe("followMention (#3216)", () => {
  const mention = imageMention("/tmp/1.png");
  const next = insertMentionAt("look at this", mention, 8);
  const placed = placedMention(next, mention);

  it("moves with text typed before it, stays for text typed after it, and stays whole", () => {
    const moved = followMention(placed, { start: 0, removed: 0, inserted: 3 })!;
    expect(moved.start).toBe(placed.start + 3);
    expect(mentionWhole(`so ${next.text}`, moved)).toBe(true);
    expect(followMention(placed, { start: next.text.length, removed: 0, inserted: 3 })).toEqual(placed);
  });

  it("keeps what is left of it once an edit takes a character of it, and is whole again once it is put back", () => {
    const cut = followMention(placed, { start: placed.start + 3, removed: 1, inserted: 0 })!;
    const damaged = next.text.slice(0, placed.start + 3) + next.text.slice(placed.start + 4);
    expect([cut.end - cut.start, mentionWhole(damaged, cut)]).toEqual([placed.bare.length - 1, false]);
    const undone = followMention(cut, { start: placed.start + 3, removed: 0, inserted: 1 })!;
    expect(mentionWhole(next.text, undone)).toBe(true);
  });

  it("is gone once an edit takes all of it, and is not whole with a character glued to it", () => {
    expect(followMention(placed, { start: 0, removed: next.text.length, inserted: 3 })).toBeNull();
    const glued = next.text.slice(0, placed.end) + "x" + next.text.slice(placed.end);
    expect(mentionWhole(glued, followMention(placed, { start: placed.end, removed: 0, inserted: 1 })!)).toBe(false);
  });
});

describe("editBetween (#3216)", () => {
  it("reads the edit from the selection it replaced and the caret it left", () => {
    // select all and type: the edit is the whole text, though the new one begins with the old one's letter
    expect(editBetween("please look", "p", { caret: 1, selected: { start: 0, end: 11 } })).toEqual({ start: 0, removed: 11, inserted: 1 });
    // typed at the start of repeated words: the caret says which copy grew
    expect(editBetween("go go now", "go go go now", { caret: 3, selected: { start: 0, end: 0 } })).toEqual({ start: 0, removed: 0, inserted: 3 });
    expect(editBetween("before after", "befor after", { caret: 5, selected: { start: 6, end: 6 } })).toEqual({ start: 5, removed: 1, inserted: 0 });
  });

  it("compares the texts around the caret where the selection does not describe the edit", () => {
    expect(editBetween("go go now", "go go go now", { caret: 3, selected: { start: 6, end: 6 } })).toEqual({ start: 0, removed: 0, inserted: 3 });
    expect(editBetween("before \u314Eafter", "before \uD558after", { caret: 8 })).toEqual({ start: 7, removed: 1, inserted: 1 });
  });

  it("never begins inside a character or a word", () => {
    expect(editBetween("\u{1F600}a", "\u{1F603}", { caret: 2 })).toEqual({ start: 0, removed: 3, inserted: 2 });
    expect(editBetween("x ae\u0301x", "x ae\u0300y", { caret: 6 })).toEqual({ start: 2, removed: 4, inserted: 4 });
    // an autocorrect: the word, not its first letter on
    expect(editBetween("fix teh bug", "fix the bug", { caret: 7 })).toEqual({ start: 4, removed: 3, inserted: 3 });
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
    expect(composerStatusCompact(374)).toBe(true);
    expect(composerStatusCompact(588)).toBe(true);
    expect(composerStatusCompact(COMPOSER_STATUS_COMPACT_BELOW - 1)).toBe(true);
    expect(composerStatusCompact(COMPOSER_STATUS_COMPACT_BELOW)).toBe(false);
    expect(composerStatusCompact(672)).toBe(false);
    expect(composerStatusCompact(820)).toBe(false);
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

  it("queues a message for a pane shown blocked only where the server shows a card's wait so", () => {
    expect(composerDelivery("codex", "blocked", true)).toBe("queue");
    for (const state of ["idle", "done", "unknown"] as const) expect(composerDelivery("codex", state, true)).toBe("immediate");
    expect(composerDelivery(null, "blocked", true)).toBe("immediate");
  });

  it("says the reconnecting sentence in the status content only once there is a draft", () => {
    expect(composerStatusHint({ uploading: false, connected: false, text: "" })).toBe(null);
    expect(composerStatusHint({ uploading: false, connected: false, text: " " })).toBe("offline");
    expect(composerStatusHint({ uploading: false, connected: false, text: "draft" })).toBe("offline");
    expect(composerStatusHint({ uploading: false, connected: true, text: "draft" })).toBe(null);
    expect(composerStatusHint({ uploading: true, connected: true, text: "" })).toBe("uploading");
    expect(composerStatusHint({ uploading: true, connected: false, text: "" })).toBe("uploading");
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
    expect(find("brain")).toEqual(["my-brainstorm-helper", "superpowers:brainstorming"]);
    expect(find("review")).toEqual(["review", "reviewer-notes", "code-review"]);
    expect(find("ainst")).toEqual(["my-brainstorm-helper", "superpowers:brainstorming"]);
    expect(find("spbr")).toEqual(["superpowers:brainstorming"]);
    expect(find("diff")).toEqual(["review"]);
    expect(find("zzz")).toEqual([]);
    expect(find("")).toHaveLength(commands.length);
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
    expect([model, resume, plain, skill].map(terminalCommand)).toEqual([false, false, false, false]);
    expect(commandGroup(config)).toBe("terminal");
    expect(commandGroup(tree)).toBe("terminal");
    expect(commandGroup(resume)).toBe("builtin");
    expect(commandGroup(skill)).toBe("skill-project");
    expect(COMMAND_GROUPS[COMMAND_GROUPS.length - 1]).toBe("terminal");
  });

  it("never lists an agent-hidden row, and lists terminal rows at a bare slash", () => {
    const listed = commandsForTrigger(commands, "claude", slash).map((command) => command.name);
    expect(listed).toEqual(["config", "tree", "model", "resume", "compact", "deploy"]);
    expect(terminalCommand(heapdump)).toBe(false);
    expect(commandsForTrigger([plain, skill], "claude", slash)).toEqual([plain, skill]);
  });

  it("finds the terminal command a message types, in the form it was typed", () => {
    expect(typedTerminalCommand(commands, "/config")).toBe(config);
    expect(typedTerminalCommand(commands, "  /CONFIG  ")).toBe(config);
    expect(typedTerminalCommand(commands, "/tree")).toBe(tree);
    expect(typedTerminalCommand(commands, "/tree w13:p2")).toBe(tree);
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
    expect(typedTerminalCommand([plain, skill], "/compact")).toBeNull();
  });

});

describe("the menu over a catalog the server built", () => {
  function codexRows(): SlashCommand[] {
    const home = mkdtempSync(join(tmpdir(), "compose-catalog-"));
    try {
      mkdirSync(join(home, ".codex", "skills", "deploy"), { recursive: true });
      writeFileSync(join(home, ".codex", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Ship it\n---\n");
      return JSON.parse(JSON.stringify(paneCommands("codex", null, home))) as SlashCommand[];
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  const slash: ActiveTrigger = { kind: "slash", query: "", start: 0, end: 1 };

  it("keeps terminal handoffs and drawable controls but hides unsupported ordinary live controls", () => {
    const rows = codexRows();
    const listed = commandsForTrigger(rows, "codex", slash);
    const names = new Set(listed.map((row) => row.name));
    const terminal = new Set(listed.filter((row) => commandGroup(row) === "terminal").map((row) => row.name));
    for (const name of ["config", "resume", "permissions", "setup-default-sandbox", "mcp", "status", "review"]) expect(terminal.has(name)).toBeTrue();
    for (const name of ["model", "compact", "init"]) expect(names.has(name) && !terminal.has(name)).toBeTrue();
    expect(names.has("plan")).toBeFalse();
    expect(typedTerminalCommand(rows, "/plan")).toBeNull();
    expect(typedTerminalCommand(rows, "/permissions")?.name).toBe("permissions");
    for (const name of ["apps", "debug-config", "debug-m-drop", "debug-m-update"]) {
      expect(rows.some((row) => row.name === name && row.visibility === "agent-hidden")).toBeTrue();
      expect(names.has(name)).toBeFalse();
    }
    expect(commandsForTrigger(rows, "codex", { ...slash, prefix: "$" }).map((row) => [row.name, commandGroup(row)])).toEqual([["deploy", "skill-user"]]);
  });

  it("offers no other command for a hidden control typed whole, so Enter sends it as typed", () => {
    const rows = codexRows();
    expect(commandsForTrigger(rows, "codex", { ...slash, query: "plan", end: 5 })).toEqual([]);
    expect(namesHiddenCommand(rows, "plan", "/")).toBeTrue();
    expect(commandsForTrigger(rows, "codex", { ...slash, query: "pla", end: 4 }).some((row) => row.name === "plan")).toBeFalse();
    expect(namesHiddenCommand(rows, "pla", "/")).toBeFalse();
    const skill: SlashCommand = { name: "plan-review", description: "", source: "skill", trigger: "$" };
    // inline, `use /plan` still offers the skill: only a leading command typed whole is sent as typed
    expect(commandsForTrigger([...rows, skill], "codex", { kind: "slash", query: "plan", start: 4, end: 9 }).some((row) => row.name === "plan-review")).toBeTrue();
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

it("takes a word naming a command the menu hides for a command, never for one no command matches", () => {
  const commands: SlashCommand[] = [
    { name: "heapdump", description: "Write a heap snapshot", source: "builtin", visibility: "agent-hidden" },
    { name: "apps", description: "Apps", source: "builtin", visibility: "agent-hidden" },
    { name: "help", description: "Show help", source: "builtin" },
  ];
  expect(namesHiddenCommand(commands, "heapdump")).toBe(true);
  expect(namesHiddenCommand(commands, "Heap")).toBe(true);
  expect(namesHiddenCommand(commands, "apps", "/")).toBe(true);
  expect(namesHiddenCommand(commands, "apps", "$")).toBe(false);
  expect(namesHiddenCommand(commands, "help")).toBe(false);
  expect(namesHiddenCommand(commands, "deploy")).toBe(false);
  expect(namesHiddenCommand(commands, "")).toBe(false);
});
