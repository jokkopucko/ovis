import { expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { contextLeftPercent } from "../src/lib/compose.ts";
import { claudeProjectDir } from "./claude-store.ts";
import { forgetPaneTranscriptState, forgetTranscriptState, transcriptPage } from "./conversation.ts";
import * as herdr from "./herdr/client.ts";
import { handlePaneRequest } from "./pane-routes.ts";

it("uses the matching Claude window in HTTP responses and invalidates a 304 without a transcript append", async () => {
  const home = mkdtempSync(join(tmpdir(), "ovis-claude-context-"));
  const previous = { HOME: process.env["HOME"], CLAUDE_CONFIG_DIR: process.env["CLAUDE_CONFIG_DIR"] };
  const session = "0b9d6a52-7a5e-4f8e-9a51-2f3c4d5e6f70";
  const configDir = join(home, ".claude");
  const cwd = join(home, "project");
  const project = join(configDir, "projects", claudeProjectDir(cwd));
  mkdirSync(project, { recursive: true });
  const transcript = join(project, session + ".jsonl");
  writeFileSync(transcript, [
    { type: "user", uuid: "user", timestamp: "2026-10-29T08:00:00Z", message: { role: "user", content: "Hello" } },
    { type: "assistant", uuid: "assistant", parentUuid: "user", timestamp: "2026-10-29T08:00:01Z",
      message: { role: "assistant", model: "claude-test", content: [{ type: "text", text: "Hi" }], usage: { input_tokens: 702, cache_read_input_tokens: 40_000 } } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const captureDir = join(home, ".herdr", "statusline-context");
  mkdirSync(captureDir, { recursive: true });
  const capture = join(captureDir, session + ".json");
  const pane = { pane_id: "claude-context-fixture", cwd, agent: "claude" as const };
  const snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({ panes: [pane], agents: [] } as unknown as SessionSnapshot);
  const rpc = spyOn(herdr, "herdrRpc").mockImplementation(async (method: string) => (method === "agent.get"
    ? { agent: { agent_session: { value: session } } }
    : { process_info: { foreground_processes: [] } }) as never);
  process.env["HOME"] = home;
  process.env["CLAUDE_CONFIG_DIR"] = configDir;
  const url = new URL("http://x/api/pane/conversation?pane_id=" + pane.pane_id);
  const ask = async (etag?: string) => (await handlePaneRequest(new Request(url, { headers: etag ? { "if-none-match": etag } : {} }), url, "/api/pane/conversation", {}))!;
  const save = (window: number, model = "claude-test", session_id = session) => writeFileSync(capture, JSON.stringify({ session_id, model, window }));
  try {
    const initial = await ask();
    expect(initial.status).toBe(200);
    expect((await initial.json()).metadata.context).toEqual({ used: 40_702, window: null });
    const stamp = statSync(transcript).mtimeMs;
    save(1_000_000);
    const changed = await ask(initial.headers.get("etag")!);
    expect(changed.status).toBe(200);
    const context = (await changed.json()).metadata.context;
    expect(context).toEqual({ used: 40_702, window: 1_000_000 });
    expect(contextLeftPercent(context)).toBe(96);
    expect((await ask(changed.headers.get("etag")!)).status).toBe(304);
    save(200_000);
    const smaller = await ask(changed.headers.get("etag")!);
    expect(smaller.status).toBe(200);
    expect((await smaller.json()).metadata.context.window).toBe(200_000);
    expect(statSync(transcript).mtimeMs).toBe(stamp);
    expect(transcriptPage("claude-transcript", transcript).metadata.context?.window).toBeNull();
    save(1_000_000, "another-model");
    expect((await (await ask()).json()).metadata.context.window).toBeNull();
    save(1_000_000, "claude-test", "another-session");
    expect((await (await ask()).json()).metadata.context.window).toBeNull();
    rmSync(capture);
    expect((await (await ask()).json()).metadata.context.window).toBeNull();
  } finally {
    snapshot.mockRestore(); rpc.mockRestore();
    forgetPaneTranscriptState(pane.pane_id); forgetTranscriptState();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
