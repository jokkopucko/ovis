import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "./index.ts";
import { herdrRpc, paneRead, paneScroll, paneScrollInfo, subscribeEvents, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { ConversationResponse } from "../shared/protocol.ts";

// A terminal-started Codex with no reported session names its model through its live footer.
const root = mkdtempSync(join(tmpdir(), "ovis-start-screen-contract-"));
const originalHome = process.env["HOME"];
const originalPiAgentDir = process.env["PI_CODING_AGENT_DIR"];
const piAgentDir = join(root, ".pi", "agent");
const workspaces: string[] = [];
let codexPane: string;
let piPane: string;
let scrolledPane: string;
let scrolledTop: number;
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  const codex = await workspaceCreate({ cwd: root, label: "ovis-test-start-screen-codex" });
  workspaces.push(codex.workspace.workspace_id);
  codexPane = codex.root_pane.pane_id;
  await herdrRpc("pane.report_agent", { pane_id: codexPane, source: "manual", agent: "codex", state: "idle" });
  const codexReady = herdrRpc("pane.wait_for_output", {
    pane_id: codexPane, source: "visible", match: { type: "substring", value: "codex_ready_contract" }, timeout_ms: 10000,
  }, undefined, 12000);
  await herdrRpc("pane.send_text", { pane_id: codexPane, text: `clear; printf '%s\\n' '  >_ OpenAI Codex (v0.163.0)' '' '› Ask Codex to do anything' '' '  GPT-6.1-Sol low · /tmp/project'; printf '? for shortcuts codex_%s\\n' ready_contract; exec cat\n` });
  await codexReady;
  const scrolled = await workspaceCreate({ cwd: root, label: "ovis-test-start-screen-scrolled" });
  workspaces.push(scrolled.workspace.workspace_id);
  scrolledPane = scrolled.root_pane.pane_id;
  await herdrRpc("pane.report_agent", { pane_id: scrolledPane, source: "manual", agent: "codex", state: "idle" });
  const scrolledReady = herdrRpc("pane.wait_for_output", {
    pane_id: scrolledPane, source: "visible", match: { type: "substring", value: "codex_live_contract" }, timeout_ms: 10000,
  }, undefined, 12000);
  const frame = (footer: string, marker: string) => `printf '%s\\n' '  >_ OpenAI Codex (v0.163.0)' '' '› Ask Codex to do anything' '' '  ${footer} · /tmp/project'; printf '? for shortcuts codex_%s\\n' ${marker}`;
  await herdrRpc("pane.send_text", { pane_id: scrolledPane, text: `clear; ${frame("GPT-6-Luna medium", "old_contract")}; for i in $(seq 1 120); do echo; done; ${frame("GPT-6.1-Sol low", "live_contract")}; exec cat\n` });
  await scrolledReady;
  scrolledTop = (await paneScrollInfo(scrolledPane))!.max_offset_from_bottom;
  expect((await paneScroll(scrolledPane, scrolledTop))?.offset_from_bottom).toBe(scrolledTop);
  const shown = (await paneRead({ paneId: scrolledPane, source: "visible", format: "text" })).text;
  expect(shown).toContain("codex_old_contract");
  expect(shown).not.toContain("codex_live_contract");
  // a Pi that has had no turn: its session file is not written yet, and its footer names the model
  const pi = await workspaceCreate({ cwd: root, label: "ovis-test-start-screen-pi" });
  workspaces.push(pi.workspace.workspace_id);
  piPane = pi.root_pane.pane_id;
  // herdr names the pane's agent from its foreground process (`exec -a pi`): heard as it happens, not polled
  const watching = Promise.withResolvers<void>();
  const detected = Promise.withResolvers<void>();
  const subscription = subscribeEvents([{ type: "pane.agent_status_changed", pane_id: piPane }], {
    onStarted: () => watching.resolve(),
    onEvent: (frame) => { if (frame.data?.agent === "pi") detected.resolve(); },
    onError: (error) => { watching.reject(error); detected.reject(error); },
  });
  let undetected: ReturnType<typeof setTimeout> | undefined;
  try {
    await watching.promise;
    const piReady = herdrRpc("pane.wait_for_output", {
      pane_id: piPane, source: "visible", match: { type: "substring", value: "pi_ready_contract" }, timeout_ms: 10000,
    }, undefined, 12000);
    await herdrRpc("pane.send_text", { pane_id: piPane, text: `clear; printf '%s\\n' '~/project' '0.0%/262k (auto)          pi-contract-model \u2022 high' 'pi_ready_contract'; HOME=${root} PI_CODING_AGENT_DIR=${piAgentDir} exec -a pi cat\n` });
    await piReady;
    undetected = setTimeout(() => detected.reject(new Error("test pi was not detected")), 10_000);
    await detected.promise;
  } finally {
    clearTimeout(undetected);
    subscription.close();
  }
  let seq = Date.now() * 1000;
  await herdrRpc("pane.report_agent", { pane_id: piPane, source: "herdr:pi", agent: "pi", state: "idle", seq: ++seq });
  await herdrRpc("pane.report_agent_session", {
    pane_id: piPane, source: "herdr:pi", agent: "pi", seq: ++seq, session_start_source: "startup",
    agent_session_path: join(piAgentDir, "sessions", `--${root.replaceAll("/", "-")}--`, "2026-11-04_fresh.jsonl"),
  });
  mkdirSync(join(piAgentDir, "sessions"), { recursive: true });
  process.env["PI_CODING_AGENT_DIR"] = piAgentDir;
  process.env["HOME"] = root;
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), codexHome: join(root, ".codex") });
}, 15000);

afterAll(async () => {
  server?.stop();
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (originalPiAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
  else process.env["PI_CODING_AGENT_DIR"] = originalPiAgentDir;
  for (const id of workspaces) await workspaceClose(id);
  rmSync(root, { recursive: true, force: true });
});

const read = async (paneId: string): Promise<ConversationResponse> => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
  expect(response.status).toBe(200);
  return await response.json() as ConversationResponse;
};

it("carries the model a Codex without a session states with the scrollback standing in", async () => {
  expect(await read(codexPane)).toEqual({
    source: "scrollback", turns: [], unavailable: "not_found", screen: true, metadata: { model: "gpt-6.1-sol", reasoning_effort: "low" },
  });
});

it("names no model while the terminal is scrolled up to an older Codex frame, and the live one once back at the bottom", async () => {
  expect(await read(scrolledPane)).toEqual({ source: "scrollback", turns: [], unavailable: "not_found" });
  expect((await paneScrollInfo(scrolledPane))?.offset_from_bottom).toBe(scrolledTop);
  expect((await paneScroll(scrolledPane, 0))?.offset_from_bottom).toBe(0);
  expect(await read(scrolledPane)).toEqual({
    source: "scrollback", turns: [], unavailable: "not_found", screen: true, metadata: { model: "gpt-6.1-sol", reasoning_effort: "low" },
  });
});

it("names the model and thinking level a Pi with no turn yet states in its footer", async () => {
  expect(await read(piPane)).toMatchObject({
    source: "pi-transcript", turns: [], screen: true, history_id: "unwritten:2026-11-04_fresh",
    metadata: { model: "pi-contract-model", reasoning_effort: "high" },
  });
});
