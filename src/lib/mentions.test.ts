import { describe, expect, it } from "bun:test";

import { activeTrigger, applyCompletion } from "./mentions.ts";
import { atSkillCommands, atSkillReplacement, rankSlashCommands } from "./compose.ts";
import type { SlashCommand } from "../../shared/protocol.ts";

describe("activeTrigger", () => {
  it("opens slash completion at the start of the text, including an empty query", () => {
    expect(activeTrigger("/", 1)).toEqual({ kind: "slash", query: "", start: 0, end: 1 });
    expect(activeTrigger("/sta", 4)).toEqual({ kind: "slash", query: "sta", start: 0, end: 4 });
  });

  it("opens slash completion after whitespace anywhere in the message", () => {
    expect(activeTrigger("hello\n/res", 10)).toEqual({ kind: "slash", query: "res", start: 6, end: 10 });
    expect(activeTrigger("hello /res", 10)).toEqual({ kind: "slash", query: "res", start: 6, end: 10 });
    expect(activeTrigger("hello\t/", 7)).toEqual({ kind: "slash", query: "", start: 6, end: 7 });
  });

  it("does not keep a slash trigger open after whitespace", () => {
    expect(activeTrigger("/review this", 12)).toBeNull();
  });

  it("ignores slashes inside words, paths and URLs", () => {
    for (const text of ["a/b", "http://", "https://example.test/path", "see ./file", "see ~/file", "see /usr/bin"]) {
      expect(activeTrigger(text, text.length)).toBeNull();
    }
  });

  it("finds file mentions with at least one query character anywhere on a line", () => {
    expect(activeTrigger("see @src/com", 12)).toEqual({ kind: "file", query: "src/com", start: 4, end: 12 });
    expect(activeTrigger("@", 1)).toBeNull();
    expect(activeTrigger("one\nopen @lib", 13)).toEqual({ kind: "file", query: "lib", start: 9, end: 13 });
  });

  it("uses the caret prefix as the query while replacing the complete token", () => {
    expect(activeTrigger("open @src/file.ts now", 10)).toEqual({
      kind: "file",
      query: "src/",
      start: 5,
      end: 17,
    });
  });

  it("rejects invalid caret positions", () => {
    expect(activeTrigger("/go", -1)).toBeNull();
    expect(activeTrigger("/go", 4)).toBeNull();
  });

  it("keeps namespaced slash and dollar queries active only when opted in", () => {
    expect(activeTrigger("/skill:ul", 9, { namespaced: true }))
      .toEqual({ kind: "slash", query: "skill:ul", start: 0, end: 9 });
    expect(activeTrigger("$skill:mas", 10, { skills: true, namespaced: true }))
      .toEqual({ kind: "slash", prefix: "$", query: "skill:mas", start: 0, end: 10 });
    expect(activeTrigger("/skill:ul", 9)).toBeNull();
    expect(activeTrigger("$skill:mas", 10, { skills: true })).toBeNull();
    expect(activeTrigger("$skill:mas", 10, { namespaced: true })).toBeNull();
  });

  it("replaces the full namespaced token when the caret precedes its colon or suffix", () => {
    for (const prefix of ["/", "$"] as const) {
      const text = `use ${prefix}skill:mass-ulw, next`;
      for (const caret of [7, 14]) {
        const trigger = activeTrigger(text, caret, { skills: true, namespaced: true });
        expect(trigger?.end).toBe(19);
        if (trigger === null) throw new Error("Expected namespaced trigger");
        expect(applyCompletion(text, trigger, `${prefix}skill:ultrawork `))
          .toEqual({ text: `use ${prefix}skill:ultrawork, next`, caret: 20 });
      }
    }
  });
});

describe("applyCompletion", () => {
  it("inserts a slash command and places the caret after its trailing space", () => {
    const trigger = activeTrigger("/sta", 4);
    expect(trigger).not.toBeNull();
    expect(applyCompletion("/sta", trigger!, "/status ")).toEqual({ text: "/status ", caret: 8 });
  });

  it("replaces the whole file token without disturbing surrounding text", () => {
    const text = "open @src/oldd.ts please";
    const trigger = activeTrigger(text, 10);
    expect(trigger).not.toBeNull();
    expect(applyCompletion(text, trigger!, "@src/new.ts ")).toEqual({
      text: "open @src/new.ts please",
      caret: 17,
    });
  });

  it("replaces a mid-message skill token at the caret, preserving the suffix", () => {
    const text = "run tests then /delegate afterwards";
    const trigger = activeTrigger(text, 19);
    expect(trigger).toEqual({ kind: "slash", query: "del", start: 15, end: 24 });
    expect(applyCompletion(text, trigger!, "$delegate ")).toEqual({ text: "run tests then $delegate afterwards", caret: 25 });
  });

  it("keeps punctuation after a mid-message skill token", () => {
    const text = "run /del, next";
    const trigger = activeTrigger(text, 8);
    expect(trigger).toEqual({ kind: "slash", query: "del", start: 4, end: 8 });
    expect(applyCompletion(text, trigger!, "/delegate ")).toEqual({ text: "run /delegate, next", caret: 13 });
  });
});

describe("$ skills", () => {
  it("opens where a word starts with $, only when skills are asked for", () => {
    expect(activeTrigger("use $dee", 8, { skills: true })).toEqual({ kind: "slash", prefix: "$", query: "dee", start: 4, end: 8 });
    expect(activeTrigger("$", 1, { skills: true })).toEqual({ kind: "slash", prefix: "$", query: "", start: 0, end: 1 });
    expect(activeTrigger("use $dee", 8)).toBeNull();
    expect(activeTrigger("cost5$x", 7, { skills: true })).toBeNull();
    expect(applyCompletion("use $dee now", { kind: "slash", prefix: "$", query: "dee", start: 4, end: 8 }, "$deepinit ")).toEqual({ text: "use $deepinit now", caret: 14 });
  });
});

// OpenCode v2 skills are `@skill-id` attachments: a pane whose rows carry the `@` trigger lists
// them in the `@` menu beside the files, and picking one inserts the id OpenCode expects
describe("@ skills", () => {
  const pdf: SlashCommand = { name: "pdf-tools", description: "Extracts text from PDFs", source: "skill", origin: "user", trigger: "@", id: "pdf-tools" };
  const docs: SlashCommand = { name: "docs-release", description: "Writes release notes", source: "skill", origin: "project", trigger: "@" };
  const hidden: SlashCommand = { name: "internal", description: "", source: "skill", trigger: "@", visibility: "agent-hidden" };
  const slash: SlashCommand = { name: "compact", description: "Compact the context", source: "builtin" };
  const rows = [slash, pdf, docs, hidden];

  it("opens on a bare @ only where the pane has @ skills", () => {
    expect(activeTrigger("@", 1, { atSkills: true })).toEqual({ kind: "file", query: "", start: 0, end: 1 });
    expect(activeTrigger("see @", 5, { atSkills: true })).toEqual({ kind: "file", query: "", start: 4, end: 5 });
    expect(activeTrigger("see @pdf", 8, { atSkills: true })).toEqual({ kind: "file", query: "pdf", start: 4, end: 8 });
    expect(activeTrigger("@", 1)).toBeNull();
    expect(activeTrigger("mail me@", 8, { atSkills: true })).toBeNull();
  });

  it("lists the @ rows of a v2 row set, never the slash rows or an agent-hidden one", () => {
    expect(atSkillCommands(rows)).toEqual([pdf, docs]);
    expect(atSkillCommands([slash])).toEqual([]);
    expect(rankSlashCommands(atSkillCommands(rows), "pdf", {}, true)).toEqual([pdf]);
    expect(rankSlashCommands(atSkillCommands(rows), "src/", {}, true)).toEqual([]);
    expect(rankSlashCommands(atSkillCommands(rows), "", {}, true)).toEqual([docs, pdf]);
  });

  it("inserts @ and the skill's name, never the path its id holds", () => {
    expect(atSkillReplacement(pdf)).toBe("@pdf-tools ");
    expect(atSkillReplacement(docs)).toBe("@docs-release ");
    expect(atSkillReplacement({ ...pdf, id: "/home/me/.config/opencode/skills/pdf-tools/SKILL.md" })).toBe("@pdf-tools ");
    const trigger = activeTrigger("see @pdf now", 8, { atSkills: true });
    expect(applyCompletion("see @pdf now", trigger!, atSkillReplacement(pdf))).toEqual({ text: "see @pdf-tools now", caret: 15 });
  });
});

describe("inline skill matching", () => {
  it("does not offer template-creator for look at /tmp or a fuzzy $ mention", () => {
    const skill = { name: "template-creator", description: "Create a reusable template", source: "skill" as const };
    for (const text of ["look at /tmp", "look at $tmp"]) {
      const trigger = activeTrigger(text, text.length, { skills: true });
      expect(trigger).not.toBeNull();
      expect(rankSlashCommands([skill], trigger!.query, {}, true)).toEqual([]);
    }
  });
});
