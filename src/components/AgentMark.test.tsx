import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMark, hasBrandColors } from "./AgentMark.tsx";

describe("agent marks", () => {
  it("tells the marks with brand colors from those riding currentColor, for Mono to grey only the former", () => {
    expect(["claude", "omp", "opencode", "gjc", "omo", "amp", "gemini", "letta"].every(hasBrandColors)).toBe(true);
    expect(["codex", "cursor", "cline", "pi", "unknown-agent"].some(hasBrandColors)).toBe(false);
    expect(renderToStaticMarkup(createElement(AgentMark, { agent: "claude" }))).toContain('class="agent-mark claude is-brand"');
    expect(renderToStaticMarkup(createElement(AgentMark, { agent: "codex" }))).toContain('class="agent-mark codex"');
    expect(renderToStaticMarkup(createElement(AgentMark, { agent: "zed" }))).toContain('class="agent-mark zed"');
  });
});
