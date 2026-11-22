import { afterEach, describe, expect, test } from "bun:test";
import type { SlashCommand } from "../shared/protocol.ts";
import { type CatalogPane, mergeCatalogSources, registerCatalogSource } from "./catalog-sources.ts";

const pane = {} as CatalogPane;
const row = (name: string, source: SlashCommand["source"], transport: "scan" | "static" = "scan"): SlashCommand => ({
  name, description: name, source, provenance: { transport, verified: false },
});
const base = [row("clear", "builtin", "static"), row("mine", "user"), row("skill-a", "skill")];

const undo: Array<() => void> = [];
const register = (provider: Parameters<typeof registerCatalogSource>[0]) => { undo.push(registerCatalogSource(provider)); };
afterEach(() => { while (undo.length > 0) undo.pop()?.(); });

describe("catalog sources", () => {
  test("a provider's rows replace the scanned ones and are marked native", async () => {
    register({ agent: "x", rows: async () => [row("one", "user"), row("two", "skill")] });
    const merged = await mergeCatalogSources("x", pane, "/w", base);
    expect(merged.map((r) => r.name)).toEqual(["clear", "one", "two"]);
    for (const r of merged.filter((r) => r.source !== "builtin")) expect(r.provenance).toEqual({ transport: "native", verified: true });
    expect(merged.find((r) => r.name === "clear")?.provenance?.transport).toBe("static");
  });

  test("a provider never removes or adds a builtin", async () => {
    register({ agent: "x", rows: async () => [row("clear", "builtin"), row("new", "builtin")] });
    expect(await mergeCatalogSources("x", pane, "/w", base)).toEqual(base);
  });

  test("a rows kind the provider did not answer keeps its scanned rows", async () => {
    register({ agent: "x", rows: async () => [row("one", "skill")] });
    expect((await mergeCatalogSources("x", pane, "/w", base)).map((r) => r.name)).toEqual(["clear", "mine", "one"]);
  });

  test("a provider's identified rows collapse by trigger, name and id; idless rows stay", async () => {
    const skill = (id?: string): SlashCommand => ({ ...row("native", "skill"), trigger: "$", ...(id === undefined ? {} : { id }) });
    register({ agent: "x", rows: async () => [skill("/same/SKILL.md"), skill("/same/SKILL.md"), skill("/other/SKILL.md"), skill(), skill()] });
    const merged = (await mergeCatalogSources("x", pane, "/w", base)).filter((r) => r.name === "native");
    expect(merged.map((r) => r.id)).toEqual(["/same/SKILL.md", "/other/SKILL.md", undefined, undefined]);
  });

  test("a native skill replaces a retained scanned command with the same identity, not one with another id", async () => {
    const scanned = (id: string): SlashCommand => ({ ...row("dup", "user"), trigger: "$", id });
    register({ agent: "x", rows: async () => [{ ...row("dup", "skill"), trigger: "$", id: "/a" }] });
    const merged = await mergeCatalogSources("x", pane, "/w", [...base, scanned("/a"), scanned("/b")]);
    const dup = merged.filter((r) => r.name === "dup");
    expect(dup.map((r) => [r.id, r.provenance?.transport])).toEqual([["/a", "native"], ["/b", "scan"]]);
  });

  test("a provider whose rows the agent runs first hides the scanned rows typed the same, and only those", async () => {
    // pi: an extension's /mine runs before the prompt template mine.md expands
    register({ agent: "x", owns: [], shadows: true, rows: async () => [row("mine", "plugin"), row("clear", "plugin")] });
    const merged = await mergeCatalogSources("x", pane, "/w", base);
    expect(merged.map((r) => [r.name, r.source])).toEqual([["clear", "builtin"], ["clear", "plugin"], ["mine", "plugin"], ["skill-a", "skill"]]);
  });

  test("a slow provider times out, is aborted and the rows fall back", async () => {
    let aborted = false;
    register({
      agent: "x",
      rows: (_pane, _cwd, signal) => new Promise<null>((resolve) => { signal.addEventListener("abort", () => { aborted = true; resolve(null); }); }),
    });
    const started = performance.now();
    expect(await mergeCatalogSources("x", pane, "/w", base, 20)).toEqual(base);
    expect(aborted).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("an empty answer from a provider that owns skills removes the scanned skills; null keeps them", async () => {
    register({ agent: "x", owns: ["skills"], rows: async () => [] });
    expect((await mergeCatalogSources("x", pane, "/w", base)).map((r) => r.name)).toEqual(["clear", "mine"]);
    undo.pop()?.();
    register({ agent: "x", owns: ["skills"], rows: async () => null });
    expect(await mergeCatalogSources("x", pane, "/w", base)).toEqual(base);
  });

  test("a provider that throws or answers null falls back", async () => {
    register({ agent: "x", rows: async () => { throw new Error("boom"); } });
    register({ agent: "x", rows: () => { throw new Error("sync"); } });
    register({ agent: "x", rows: async () => null });
    expect(await mergeCatalogSources("x", pane, "/w", base)).toEqual(base);
  });

  test("a failing provider does not discard another's rows, and other agents are untouched", async () => {
    register({ agent: "x", rows: async () => { throw new Error("boom"); } });
    register({ agent: "x", rows: async () => [row("one", "user")] });
    register({ agent: "y", rows: async () => [row("other", "user")] });
    expect((await mergeCatalogSources("x", pane, "/w", base)).map((r) => r.name)).toEqual(["clear", "one", "skill-a"]);
    expect(await mergeCatalogSources(null, pane, "/w", base)).toEqual(base);
  });
});
