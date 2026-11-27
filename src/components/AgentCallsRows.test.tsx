import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { AgentCatalogRow } from "../../shared/agent-catalog.ts";
import type { HarnessToolSetting } from "../../shared/harness-tool.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AgentCallsRows } from "./AgentCallsRows.tsx";

const agent = (id: string, name: string, installed: boolean, version: string | null = null) => ({ id, name, state: { installed, version } }) as unknown as AgentCatalogRow;
const agents = [agent("opencode", "OpenCode", true, "2.2.2"), agent("claude", "Claude Code", true, "2.1.331"), agent("gjc", "GJC", false)];

describe("Settings > Agents > Let agents call other agents", () => {
  let page: Page;
  let saved: unknown[] = [];
  let fetchSpy: { mockRestore(): void } | undefined;

  beforeEach(() => {
    page = openPage();
    saved = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { settings: { agentHarnessTool: HarnessToolSetting } };
      saved.push(body.settings.agentHarnessTool);
      return Response.json({ revision: saved.length, settings: body.settings });
    }, { preconnect: globalThis.fetch.preconnect }));
  });

  afterEach(async () => {
    await page.close();
    fetchSpy?.mockRestore();
  });

  const mount = (watching = false, shown = agents) => page.render(createElement(SettingsProvider, null, createElement(AgentCallsRows, { agents: shown, watching })));
  const toggle = () => page.one<HTMLButtonElement>('[role="switch"]');
  const chips = () => [...page.container.querySelectorAll<HTMLButtonElement>('button[class="settings-chip"]')];

  it("starts on with installed ACP agents already selected", async () => {
    await mount();
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(chips().map((chip) => [chip.textContent, chip.getAttribute("aria-pressed")])).toEqual([["OpenCode", "true"], ["Claude Code", "true"]]);
  });

  it("writes this PC's grant straight to its server when an agent is unticked and delegation is turned off", async () => {
    await mount();
    const openCode = chips().find((chip) => chip.textContent === "OpenCode");
    if (!openCode) throw new Error("Expected an OpenCode chip");
    await act(async () => { openCode.click(); });
    await act(async () => { toggle().click(); });
    expect(saved).toEqual([
      { level: "start", depth: 1, harnesses: ["claude", "codex", "copilot", "agy", "gjc", "gemini", "kiro", "kimi", "qwen"] },
      { level: "view", depth: 1, harnesses: ["claude", "codex", "copilot", "agy", "gjc", "gemini", "kiro", "kimi", "qwen"] },
    ]);
    expect(chips()).toHaveLength(0);
  });

  it("offers installed ACP agents even at unknown versions but omits agents without an ACP launch", async () => {
    await mount(false, [agent("opencode", "OpenCode", true, "2.2.3"), agent("claude", "Claude Code", true), agent("pi", "pi", true)]);
    expect(chips().map((chip) => chip.textContent)).toEqual(["OpenCode", "Claude Code"]);
  });

  it("lets a person deselect GJC when it is installed", async () => {
    await mount(false, [agent("gjc", "GJC", true, "0.18.12")]);
    const gjc = chips().find((chip) => chip.textContent === "GJC");
    if (!gjc) throw new Error("Expected a GJC chip");
    expect(gjc.getAttribute("aria-pressed")).toBe("true");
    await act(async () => { gjc.click(); });
    expect(chips().map((chip) => [chip.textContent, chip.getAttribute("aria-pressed")])).toEqual([["GJC", "false"]]);
    expect(saved).toEqual([{ level: "start", depth: 1, harnesses: ["claude", "codex", "copilot", "opencode", "agy", "gemini", "kiro", "kimi", "qwen"] }]);
  });

  it("offers Codex and Copilot but not installed agents without an ACP launch", async () => {
    await mount(false, [agent("codex", "Codex", true, "0.171.0"), agent("copilot", "GitHub Copilot", true, "1.0.109"), agent("omo", "OmO", true)]);
    expect(chips().map((chip) => chip.textContent)).toEqual(["Codex", "GitHub Copilot"]);
  });

  it("offers installed agy and GJC with the other ACP harnesses", async () => {
    await mount(false, [agent("agy", "agy", true, "1.5.16"), agent("gjc", "GJC", true, "0.18.12")]);
    expect(chips().map((chip) => chip.textContent)).toEqual(["agy", "GJC"]);
  });

  it("cannot be changed from a watching device", async () => {
    await mount(true);
    expect(toggle().disabled).toBe(true);
  });
});
