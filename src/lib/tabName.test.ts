import { describe, expect, it } from "bun:test";

import { autoTabLabel, customTabLabel, tabLabel } from "./tabName.ts";

const t = (key: string, vars?: Record<string, string | number>): string => key.replace("{n}", String(vars?.["n"]));

describe("tab names", () => {
  it("reads a tab herdr names by its number as Tab n", () => {
    expect(tabLabel({ label: "2", number: 2 }, t)).toBe("Tab 2");
    expect(tabLabel({ label: "", number: 3 }, t)).toBe("Tab 3");
    expect(customTabLabel({ label: " 2 ", number: 2 })).toBeNull();
  });

  it("keeps a given name, trimmed", () => {
    expect(tabLabel({ label: " build ", number: 2 }, t)).toBe("build");
    expect(customTabLabel({ label: "build", number: 2 })).toBe("build");
  });

  it("follows the tab's place once a tab before it closed: herdr relabels it and keeps its number", () => {
    // tab 1 of two closed: herdr reports { number: 2, label: "1" } for the one left
    expect(customTabLabel({ label: "1", number: 2 }, 1)).toBeNull();
    expect(tabLabel({ label: "1", number: 2 }, t, 1)).toBe("Tab 1");
    // a name that only looks like another place is a name
    expect(tabLabel({ label: "7", number: 2 }, t, 1)).toBe("7");
  });

  it("keeps a numeric custom name when its stable number differs from its place", () => {
    expect(customTabLabel({ label: "3", number: 3 }, 2)).toBe("3");
    expect(tabLabel({ label: "3", number: 3 }, t, 2)).toBe("3");
  });

  it("treats an empty label as herdr's automatic name", () => {
    expect(customTabLabel({ label: "", number: 3 }, 2)).toBeNull();
    expect(tabLabel({ label: "", number: 3 }, t, 2)).toBe("Tab 2");
  });

  describe("a label from the first message (#2019)", () => {
    const panes = [{ pane_id: "w1:p2", terminal_id: "term_b" }];
    const labels = { "w1:p2|term_b": "Fix the login redirect…" };

    it("names a tab herdr names by its number", () => {
      for (const label of ["2", ""]) expect(autoTabLabel({ label, number: 2 }, panes, "local", labels)).toBe("Fix the login redirect…");
    });

    it("never covers a name someone gave the tab, an agent's name included", () => {
      for (const label of ["build", "claude", "claude-2", "3"]) expect(autoTabLabel({ label, number: 2 }, panes, "local", labels)).toBeNull();
    });

    it("reads the label of this PC's pane on its terminal only", () => {
      expect(autoTabLabel({ label: "2", number: 2 }, panes, "pc-2", labels)).toBeNull();
      expect(autoTabLabel({ label: "2", number: 2 }, [{ pane_id: "w1:p2", terminal_id: "term_new" }], "local", labels)).toBeNull();
      expect(autoTabLabel({ label: "2", number: 2 }, panes, "pc-2", { "remote:pc-2:w1%3Ap2|term_b": "Ship it" })).toBe("Ship it");
    });
  });

  describe("an agent's own name for its conversation (#2637)", () => {
    const tab = { label: "2", number: 2 };
    const labels = { "w1:p2|term_b": "Fix the login redirect\u2026" };
    const pane = (fields: Record<string, string | null>) => ({ pane_id: "w1:p2", terminal_id: "term_b", agent: "codex", cwd: "/Users/me/app", ...fields });

    it("names the tab over its first message", () => {
      expect(autoTabLabel(tab, [pane({ terminal_title_stripped: "Fix login footer overlap | app" })], "local", labels)).toBe("Fix login footer overlap");
      expect(autoTabLabel(tab, [pane({ agent: "claude", terminal_title_stripped: "\u2733 Review the parser" })], "local", labels)).toBe("Review the parser");
      expect(autoTabLabel(tab, [pane({ title: "Retry budget", terminal_title_stripped: "Other thread | app" })], "local", labels)).toBe("Retry budget");
      expect(autoTabLabel(tab, [pane({ label: "Payments", terminal_title_stripped: "Other thread | app" })], "local", labels)).toBe("Payments");
      expect(autoTabLabel(tab, [pane({ terminal_title_stripped: "Investigate the flaky retry test in CI | app" })], "local", {})).toBe("Investigate the flaky\u2026");
      // a title that starts with the agent's name still names the conversation
      expect(autoTabLabel(tab, [pane({ terminal_title_stripped: "Codex login failure | app" })], "local", labels)).toBe("Codex login failure");
      // the title herdr reports names any agent's tab, without the chrome a terminal title has
      expect(autoTabLabel(tab, [pane({ agent: "omp", title: "\u03c0 \u280b Review parser" })], "local", labels)).toBe("Review parser");
      // an attachment in a title an agent made from the first message leaves with its path; "Code" alone is a title
      expect(autoTabLabel(tab, [pane({ terminal_title_stripped: "@/Users/me/Library/Mobile Documents/.ovis/paste-20261104-101500-0a1b2c3d.png Fix footer | app" })], "local", labels)).toBe("Fix footer");
      expect(autoTabLabel(tab, [pane({ terminal_title_stripped: "Code | app" })], "local", labels)).toBe("Code");
      // a pane's name is kept whole, as a tab's is
      expect(autoTabLabel(tab, [pane({ label: "/api" })], "local", labels)).toBe("/api");
    });

    it("leaves the first message's label where the agent's title only says which agent runs where", () => {
      for (const [agent, title] of [["claude", "\u2733 Claude Code"], ["codex", "codex"], ["codex", "codex --yolo"], ["codex", " | app"], ["omp", "\u03c0 \u280b app"], ["codex", "/Users/me/app"], ["codex", "/Users/me/other"], ["codex", "~/app"], ["claude", "claude --resume 3f2a"], ["codex", "codex resume 12345"], ["hermes", "/usr/local/bin/hermes chat"], ["opencode", "opencode run --model gpt"], ["codex", "\u280b"], ["codex", null], ["codex", "node"], ["claude", "zsh"]] as const) {
        expect(autoTabLabel(tab, [pane({ agent, terminal_title_stripped: title })], "local", labels)).toBe("Fix the login redirect\u2026");
      }
      expect(autoTabLabel(tab, [pane({ cwd: null })], "local", {})).toBeNull();
      expect(autoTabLabel(tab, [pane({ agent: "omp", title: "\u03c0 \u280b app" })], "local", labels)).toBe("Fix the login redirect\u2026");
    });

    it("never takes the terminal title of an agent that says its state there, not the conversation", () => {
      for (const [agent, title] of [["gemini", "\u25c7  Ready (app)"], ["gemini", "\u2726  Working\u2026 (app)"], ["droid", "Factory Droid"], ["cursor", "Cursor Agent"], ["omp", "\u03c0 \u280b Review parser"]] as const) {
        expect(autoTabLabel(tab, [pane({ agent, terminal_title_stripped: title })], "local", labels)).toBe("Fix the login redirect\u2026");
        // herdr-core reports the terminal title as the pane's title too
        expect(autoTabLabel(tab, [pane({ agent, title, terminal_title: title })], "local", labels)).toBe("Fix the login redirect\u2026");
      }
      expect(autoTabLabel(tab, [pane({ title: "Fix footer | app", terminal_title: "Fix footer | app" })], "local", labels)).toBe("Fix footer");
    });

    it("never shows an attachment's path an earlier version learned", () => {
      for (const old of ["@/Users/example/Library/\u2026", "See @/Users/example/Library/\u2026"]) expect(autoTabLabel(tab, [pane({})], "local", { "w1:p2|term_b": old })).toBeNull();
    });

    it("never names a shell's tab by its title, nor covers a name someone gave the tab", () => {
      expect(autoTabLabel(tab, [pane({ agent: null, terminal_title_stripped: "vim notes.md" })], "local", {})).toBeNull();
      expect(autoTabLabel({ label: "build", number: 2 }, [pane({ terminal_title_stripped: "Fix login footer overlap | app" })], "local", labels)).toBeNull();
    });
  });
});
