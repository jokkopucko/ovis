import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConversationPart } from "../shared/protocol.ts";
import { createClaudeTranscriptParser, forgetTranscriptState, parseClaudeTranscript, transcriptPage, transcriptToolOutput } from "./conversation.ts";

// Recorded from OmO (senpi 2026.10, anthropic-subscription) driving Claude Code 2.1.295 through its SDK; only the
// home directory and two settings' pre-Ovis names are renamed. senpi runs each tool on its host: Claude Code records the call with senpi's
// PreToolUse denial, then the host's result arrives as the next prompt's text, `Tool result (<tool>, id=<id>):`.
// The first record answers a call made before the recording starts; the last prompt carries two results and a
// message the lead typed meanwhile.
const FIXTURE = fileURLToPath(new URL("./fixtures/claude-senpi-host-tools-2.1.295.jsonl", import.meta.url));
const recorded = readFileSync(FIXTURE, "utf8");
const LEAD = "[LEAD] done claim recorded for fixrev-plugin: this lane closes automatically at 06:44Z (5 minutes) unless the lead objects with reasons. Stay idle until then; an objection arrives here as [LEAD] not done.";

type Tool = Extract<ConversationPart, { kind: "tool" }>;
const tools = (turns: { parts: ConversationPart[] }[]): Tool[] => turns.flatMap((turn) => turn.parts.filter((part): part is Tool => part.kind === "tool"));
const said = (turns: { role: string; parts: ConversationPart[] }[]): string[] =>
  turns.filter((turn) => turn.role === "user").flatMap((turn) => turn.parts.flatMap((part) => part.kind === "text" ? [part.text] : []));

describe("senpi host tool results in a Claude Code transcript", () => {
  it("reads each host result as its call's output, never as the person's message", () => {
    const turns = parseClaudeTranscript(recorded);
    expect(said(turns)).toEqual([LEAD]);
    expect(turns.map((turn) => turn.role)).toEqual(["assistant", "user", "assistant"]);
    expect(tools(turns).map((tool) => [tool.name, tool.call_id, tool.state, tool.error ?? false])).toEqual([
      ["mcp__custom-tools__eval", "toolu_01FSxdroiRvixwBG2JJ3B9FW", "ok", false],
      ["mcp__custom-tools__eval", "toolu_012w5d2nn5pdAknCBscThLjd", "ok", false],
      ["mcp__custom-tools__eval", "toolu_01Qo5kjwt5xeTtJZsdyeWNjA", "ok", false],
      ["mcp__custom-tools__memory", "toolu_01KFTjjPGDR37MWB1CVj2AfU", "ok", false],
    ]);
    const [before, removed, detached, memory] = tools(turns);
    expect(before!.output).toStartWith("# jq .done /home/user/.dori/reports/fixrev-plugin.json");
    expect(removed!.output).toStartWith("# herdr worktree remove --workspace w3C9 2>&1 | head -c 600\n[exit 0]\n");
    expect(detached!.output).toStartWith("Eval cell toolu_01Qo5kjwt5xeTtJZsdyeWNjA detached and is running");
    expect(memory!.output).toBe("Memory create committed locally (eed429e).");
    expect(tools(turns).some((tool) => tool.output.includes("hook error"))).toBe(false);
  });

  it("keeps a call senpi took to its host running until its result arrives", () => {
    const lines = recorded.split("\n");
    const parser = createClaudeTranscriptParser();
    parser.write(lines.slice(0, lines.findIndex((line) => line.includes("\"tool_use_id\":\"toolu_012w5d2nn5pdAknCBscThLjd\"")) + 1).join("\n"));
    const call = tools(parser.snapshot()).find((tool) => tool.call_id === "toolu_012w5d2nn5pdAknCBscThLjd");
    expect(call).toMatchObject({ state: "pending", output: "" });
    expect(call?.error).toBeUndefined();
  });

  describe("read in pages, as the chat reads a file", () => {
    const roots: string[] = [];
    afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); forgetTranscriptState(); });
    const file = (): string => { const root = mkdtempSync(join(tmpdir(), "ovis-host-tools-")); roots.push(root); return join(root, "session.jsonl"); };
    const lines = recorded.split("\n").filter(Boolean);
    const expected = parseClaudeTranscript(recorded);

    it("keeps each host result on the page of the call it answers", () => {
      const path = file();
      writeFileSync(path, recorded);
      const { turns } = transcriptPage("claude-transcript", path);
      expect(said(turns)).toEqual([LEAD]);
      expect(tools(turns).map((tool) => [tool.call_id, tool.state])).toEqual(tools(expected).map((tool) => [tool.call_id, "ok"]));
    });

    it("fills a call already on the live page when its host result is appended", () => {
      const path = file();
      const result = lines.findIndex((line) => line.includes("Tool result (mcp__custom-tools__eval, id=toolu_012w5d2nn5pdAknCBscThLjd)"));
      writeFileSync(path, `${lines.slice(0, result).join("\n")}\n`);
      expect(tools(transcriptPage("claude-transcript", path).turns).find((tool) => tool.call_id === "toolu_012w5d2nn5pdAknCBscThLjd")?.state).toBe("pending");
      appendFileSync(path, `${lines.slice(result).join("\n")}\n`);
      const { turns } = transcriptPage("claude-transcript", path);
      expect(said(turns)).toEqual([LEAD]);
      expect(tools(turns).map((tool) => [tool.call_id, tool.state])).toEqual(tools(expected).map((tool) => [tool.call_id, "ok"]));
    });
  });

  describe("a message senpi sent along with host results, read in pages", () => {
    const roots: string[] = [];
    afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); forgetTranscriptState(); });
    const page = (records: unknown[]) => {
      const root = mkdtempSync(join(tmpdir(), "ovis-host-tools-")); roots.push(root);
      const path = join(root, "session.jsonl");
      writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
      return said(transcriptPage("claude-transcript", path).turns);
    };
    const text = (value: string) => ({ type: "text", text: value });
    const prompt = (uuid: string, parentUuid: string | null, content: unknown) => ({ type: "user", uuid, parentUuid, message: { role: "user", content } });
    const sent = (uuid: string, parentUuid: string, content: unknown[]) => ({ ...prompt(uuid, parentUuid, content), promptSource: "sdk", entrypoint: "sdk-ts" });
    const answer = (uuid: string, parentUuid: string, content: unknown[], stop = "end_turn") => ({ type: "assistant", uuid, parentUuid, message: { role: "assistant", content, stop_reason: stop } });
    const call = { type: "tool_use", id: "toolu_x", name: "Read", input: { file_path: "a.ts" } };
    const result = [text("Tool result (Read, id=toolu_x):\n"), text("output"), text("\n\n")];

    it("forks the branch when it hangs from before the turns it leaves behind", () => {
      expect(page([
        prompt("u1", null, "old prompt"), answer("a1", "u1", [text("old answer")]),
        { ...sent("u2", "", [...result, text("new prompt")]), parentUuid: null }, answer("a2", "u2", [text("new answer")]),
      ])).toEqual(["new prompt"]);
    });

    it("gives way to its re-send when it was cancelled before any reply", () => {
      expect(page([
        prompt("u0", null, "initial"), answer("a0", "u0", [call], "tool_use"),
        sent("u1", "a0", [...result, text("cancelled")]), sent("u2", "a0", [text("resent")]), answer("a1", "u2", [text("answer")]),
      ])).toEqual(["initial", "resent"]);
    });
  });

  it("serves a host result's whole output by its call id, not senpi's denial", () => {
    expect(transcriptToolOutput("claude-transcript", FIXTURE, "toolu_012w5d2nn5pdAknCBscThLjd")).toStartWith("# herdr worktree remove --workspace w3C9");
    expect(transcriptToolOutput("claude-transcript", FIXTURE, "toolu_01KFTjjPGDR37MWB1CVj2AfU")).toBe("Memory create committed locally (eed429e).");
  });

  it("keeps a person's message that only quotes a host result's header", () => {
    const quote = "Tool result (Read, id=toolu_quoted):\n";
    const user = (content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "user", ...extra, message: { role: "user", content } });
    const turns = parseClaudeTranscript([
      user(`${quote}why does this show up?`, { promptSource: "typed", entrypoint: "cli" }),
      user([{ type: "text", text: quote }, { type: "text", text: "is this mine?" }], { entrypoint: "cli" }),
      user([{ type: "text", text: `${quote}a quoted result` }], { promptSource: "sdk", entrypoint: "sdk-ts" }),
    ].join("\n"));
    expect(said(turns)).toEqual([`${quote}why does this show up?`, `${quote}\nis this mine?`, `${quote}a quoted result`]);
    expect(tools(turns)).toEqual([]);
  });
});
