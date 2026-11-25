import { describe, expect, test } from "bun:test";

import type { SlashCommand } from "../../shared/protocol.ts";
import { closeTabCommand, closeTabMessage, sanitizeCloseTabSkill } from "./closeTabSkill.ts";

const skill = (name: string, extra: Partial<SlashCommand> = {}): SlashCommand => ({ name, description: "", source: "skill", ...extra });

describe("sanitizeCloseTabSkill", () => {
  test("keeps a skill name, trimmed and without its trigger", () => {
    expect(sanitizeCloseTabSkill(" close-tab ")).toBe("close-tab");
    expect(sanitizeCloseTabSkill("/jokko:close-tab")).toBe("jokko:close-tab");
    expect(sanitizeCloseTabSkill("$close_tab.v2")).toBe("close_tab.v2");
  });

  test("drops what no skill name has, so a typed space does not empty the field", () => {
    expect(sanitizeCloseTabSkill(undefined)).toBe("");
    expect(sanitizeCloseTabSkill(42)).toBe("");
    expect(sanitizeCloseTabSkill("close tab")).toBe("closetab");
    expect(sanitizeCloseTabSkill("close-tab\n/other")).toBe("close-tabother");
    expect(sanitizeCloseTabSkill("x".repeat(129))).toBe("x".repeat(128));
  });
});

describe("closeTabCommand", () => {
  test("nothing configured: no command", () => {
    expect(closeTabCommand([skill("close-tab")], "")).toBeNull();
  });

  test("the exact name wins over a namespaced one", () => {
    const exact = skill("close-tab");
    expect(closeTabCommand([skill("jokko:close-tab"), exact], "close-tab")).toBe(exact);
  });

  test("a bare name finds the one plugin skill of that name", () => {
    const plugin = skill("jokko:close-tab");
    expect(closeTabCommand([skill("jokko:other"), plugin], "close-tab")).toBe(plugin);
  });

  test("a bare name does not match a longer last segment", () => {
    expect(closeTabCommand([skill("jokko:auto-close-tab")], "close-tab")).toBeNull();
  });

  test("two plugins with that name: none, rather than a guess", () => {
    expect(closeTabCommand([skill("a:close-tab"), skill("b:close-tab")], "close-tab")).toBeNull();
  });

  test("a namespaced setting matches only that exact name", () => {
    expect(closeTabCommand([skill("other:close-tab")], "jokko:close-tab")).toBeNull();
  });

  test("a builtin of that name is never the close command", () => {
    expect(closeTabCommand([skill("close-tab", { source: "builtin" })], "close-tab")).toBeNull();
  });
});

describe("closeTabMessage", () => {
  test("Claude's slash, Codex's dollar", () => {
    expect(closeTabMessage(skill("jokko:close-tab"))).toBe("/jokko:close-tab");
    expect(closeTabMessage(skill("jokko:close-tab", { trigger: "$" }))).toBe("$jokko:close-tab");
  });
});
