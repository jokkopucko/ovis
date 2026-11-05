import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as herdr from "./herdr/client.ts";
import { HerdrError } from "./herdr/client.ts";
import type { HerdrPane } from "../shared/protocol.ts";
import { claudeArtifacts, forgetArtifacts, handleArtifactsRequest } from "./claude-artifacts.ts";
import { ClaudeSubagentStatus } from "./claude-subagents.ts";
import { createServer } from "./index.ts";

// the records Claude Code 2.1.312 writes for an Artifact call and its answer (synthetic content)
const call = (id: string, input: Record<string, unknown>, at = "2026-10-29T10:00:00.000Z") => JSON.stringify({ type: "assistant", timestamp: at, message: { role: "assistant", content: [{ type: "tool_use", id, name: "Artifact", input }] } });
const answer = (id: string, text: string, result?: Record<string, unknown>, at = "2026-10-29T10:00:05.000Z", error = false) => JSON.stringify({
  type: "user", timestamp: at, message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: text, ...(error ? { is_error: true } : {}) }] }, ...(result ? { toolUseResult: result } : {}),
});
const page = (id: string) => `https://claude.ai/code/artifact/${id}`;

describe("claudeArtifacts", () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "ovis-artifacts-")); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => forgetArtifacts());

  it("lists each published page once, newest publish first, and only what a publish answered", () => {
    const path = join(dir, "session.jsonl");
    writeFileSync(path, [
      call("toolu_a", { file_path: "/tmp/scratchpad/report.html", description: "A report", icon: "chart" }),
      answer("toolu_a", `Published /tmp/scratchpad/report.html at ${page("aaa")}`, { url: page("aaa"), path: "/tmp/scratchpad/report.html", title: "Weekly report", artifact_id: "aaa", updated: false }, "2026-10-29T10:00:05.000Z"),
      // an answer written without its record: the URL from its text, after a long path, the title from the file
      call("toolu_b", { file_path: `/tmp/${"deep/".repeat(80)}notes.html` }),
      answer("toolu_b", [{ type: "text", text: `Published /tmp/${"deep/".repeat(80)}notes.html at https://claude.ai/artifact/bbb_1\n\nTo update: …` }] as unknown as string, undefined, "2026-10-29T10:01:00.000Z"),
      // calls that publish nothing, a failed publish, and a record whose url is no page
      call("toolu_read", { action: "read", url: page("ccc") }),
      answer("toolu_read", "<html>…</html>", { url: page("ccc"), title: "Read only" }),
      call("toolu_list", { action: "list" }),
      answer("toolu_list", `${page("ddd")} Listed`),
      call("toolu_asset", { url: page("aaa"), file_path: "/tmp/chart.png", asset: true }),
      answer("toolu_asset", `Uploaded at ${page("aaa")}/assets/1`, { url: page("aaa"), title: "Asset" }),
      call("toolu_failed", { file_path: "/tmp/scratchpad/broken.html" }),
      answer("toolu_failed", "<tool_use_error>File not found</tool_use_error>", undefined, undefined, true),
      call("toolu_odd", { file_path: "/tmp/scratchpad/odd.html" }),
      answer("toolu_odd", "Published nowhere", { url: "javascript:alert(1)", title: "Odd" }),
      "",
    ].join("\n"));
    expect(claudeArtifacts(path)).toEqual([
      { url: "https://claude.ai/artifact/bbb_1", title: "notes.html", at: "2026-10-29T10:01:00.000Z" },
      { url: page("aaa"), title: "Weekly report", at: "2026-10-29T10:00:05.000Z" },
    ]);

    // a republish moves the page up with its new title; what was appended is read, and a line still being written waits
    appendFileSync(path, [
      call("toolu_c", { file_path: "/tmp/scratchpad/report.html" }, "2026-10-29T11:00:00.000Z"),
      answer("toolu_c", `Published /tmp/scratchpad/report.html at ${page("aaa")}`, { url: page("aaa"), title: "Weekly report v2", updated: true }, "2026-10-29T11:00:02.000Z"),
      "",
    ].join("\n") + call("toolu_d", { file_path: "/tmp/x.html" }).slice(0, 40));
    expect(claudeArtifacts(path).map((artifact) => [artifact.title, artifact.at])).toEqual([
      ["Weekly report v2", "2026-10-29T11:00:02.000Z"],
      ["notes.html", "2026-10-29T10:01:00.000Z"],
    ]);
    expect(claudeArtifacts(join(dir, "missing.jsonl"))).toEqual([]);
  });
});

describe("GET /api/pane/artifacts", () => {
  let server: ReturnType<typeof createServer>;
  let stateDir: string;
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  const error = async (response: Response) => [response.status, ((await response.json()) as { error: { code: string } }).error.code];

  beforeAll(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ovis-artifacts-route-"));
    server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", machines: false, sidecar: false });
  });
  afterAll(() => {
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("wants GET and a pane, and answers none for a pane that runs no Claude Code", async () => {
    expect(await error(await fetch(url("/api/pane/artifacts?pane_id=w1:p1"), { method: "POST", headers: { origin: url("") } }))).toEqual([400, "method_not_allowed"]);
    expect(await error(await fetch(url("/api/pane/artifacts")))).toEqual([400, "missing_pane_id"]);
    const get = spyOn(herdr, "paneGet").mockImplementation(async (paneId) => { throw new HerdrError("pane_not_found", `pane ${paneId} not found`); });
    try {
      const response = await fetch(url("/api/pane/artifacts?pane_id=w9:p9"));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ artifacts: [] });
    } finally {
      get.mockRestore();
    }
  });

  it("answers the pages of the session the pane runs now, looked up at each ask", async () => {
    // one transcript per session, each with one page named after it
    const transcript = (session: string): string => {
      const path = join(stateDir, `${session}.jsonl`);
      writeFileSync(path, `${call(`toolu_${session}`, { file_path: "/tmp/a.html" })}\n${answer(`toolu_${session}`, "Published", { url: page(session), title: `Page of ${session}` })}\n`);
      return path;
    };
    const claudeAgents = new ClaudeSubagentStatus({ resolve: async (seen) => ({ path: transcript(seen.agent_session?.value ?? ""), startedAt: null, pid: null }), onChange: () => {} });
    // herdr answers the pane as it is at each ask
    let now = { agent: "claude", session: "first" };
    const get = spyOn(herdr, "paneGet").mockImplementation(async (paneId) => {
      if (paneId !== "w1:p1") throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
      return { pane_id: paneId, workspace_id: "w1", agent: now.agent, agent_status: "idle", agent_session: { kind: "id", value: now.session } } as unknown as HerdrPane;
    });
    const ask = async (pane: string) => (await (await handleArtifactsRequest(new Request(`http://localhost/api/pane/artifacts?pane_id=${pane}`), new URL(`http://localhost/api/pane/artifacts?pane_id=${pane}`), "/api/pane/artifacts", { claudeAgents }))!.json() as { artifacts: { title: string }[] }).artifacts.map((artifact) => artifact.title);
    try {
      expect(await ask("w1:p1")).toEqual(["Page of first"]);
      // a new Claude session in the same pane: its own pages, never the first session's
      now = { agent: "claude", session: "second" };
      expect(await ask("w1:p1")).toEqual(["Page of second"]);
      // another agent in the pane, and a pane herdr does not have: none
      now = { agent: "codex", session: "second" };
      expect(await ask("w1:p1")).toEqual([]);
      expect(await ask("w2:p2")).toEqual([]);
    } finally {
      get.mockRestore();
    }
    expect(await handleArtifactsRequest(new Request("http://localhost/api/pane/plan"), new URL("http://localhost/api/pane/plan"), "/api/pane/plan", { claudeAgents })).toBeNull();
  });
});
