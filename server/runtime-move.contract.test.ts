import { afterAll, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrRuntimeFacts } from "../shared/machines.ts";
import type { MovePlanResponse } from "../shared/runtime-move.ts";
import { herdrRpc, paneSplit, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { RuntimeService } from "./herdr-core/runtime-choice.ts";
import { createServer } from "./index.ts";

// One herdr workspace in the test session: a Codex the person ended, its conversation in a fictional
// Codex store, beside an idle Codex whose input line Ovis cannot read. No Codex runs; herdr is told.
const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-runtime-move-")));
const SECRET = "test-runtime-move-secret";
const ENDED = "00000000-0000-4000-8000-000000000002";
const fixture = join(import.meta.dir, "fixtures", "session-history", "codex", "dot-codex", "sessions", "2026", "10", "02", `rollout-2026-10-02T09-00-00-${ENDED}.jsonl`);
const codexHome = join(root, "codex");
const day = join(codexHome, "sessions", "2026", "10", "02");
mkdirSync(day, { recursive: true });
writeFileSync(join(day, `rollout-2026-10-02T09-00-00-${ENDED}.jsonl`), readFileSync(fixture, "utf8").replaceAll('"{{CWD}}"', JSON.stringify(root)));

let workspace: string | null = null;
afterAll(async () => {
  if (workspace) await workspaceClose(workspace);
  rmSync(root, { recursive: true, force: true });
});

const facts = (change: Partial<HerdrRuntimeFacts> = {}): HerdrRuntimeFacts => ({ serving: "herdr", source: "detected", tui: { installed: true, running: true }, app_installed: false, switch_to: "herdr-core", locked: null, ...change });

it("shows what a move to herdr-core would take along, and offers none where the Herdr app may arrange the core", async () => {
  const created = await workspaceCreate({ cwd: root, label: "move" });
  workspace = created.workspace.workspace_id;
  const ended = created.root_pane.pane_id;
  const shell = (await paneSplit(ended, "right", false)).pane_id;
  let seq = 0;
  for (const [pane, id] of [[ended, ENDED], [shell, "00000000-0000-4000-8000-000000000009"]] as const) {
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "codex", state: "idle" });
    await herdrRpc("pane.report_agent_session", { pane_id: pane, source: "herdr:codex", agent: "codex", seq: ++seq, agent_session_id: id });
  }
  await herdrRpc("pane.release_agent", { pane_id: ended, source: "manual", agent: "codex" });

  let current = facts();
  const runtimeService: RuntimeService = { facts: () => current, request: () => ({ ok: false, status: 409, code: "runtime_locked", message: "test" }) };
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: SECRET, stateDir: join(root, "state"), codexHome, runtimeService });
  const read = async (headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/runtime/move`, { headers });
    return { status: response.status, body: response.status === 200 ? await response.json() as MovePlanResponse : null };
  };
  try {
    const answer = await read();
    if (answer.body?.available !== true) throw new Error(`no move offered: ${JSON.stringify(answer)}`);
    const verdicts = Object.fromEntries(answer.body.plan.panes.filter((pane) => pane.pane_id === ended || pane.pane_id === shell).map((pane) => [pane.pane_id, pane.verdict]));
    expect(verdicts).toEqual({
      [ended]: { kind: "resume", agent: "codex", session_id: ENDED, argv: ["codex", "resume", ENDED], ended: true },
      [shell]: { kind: "needs_you", agent: "codex" },
    });
    const tab = answer.body.plan.workspaces.find((entry) => entry.workspace_id === workspace)?.tabs[0];
    expect(tab?.root).toEqual({ split: "right", ratio: 0.5, first: { pane: ended }, second: { pane: shell } });
    expect(answer.body.status).toEqual({ state: "idle" });

    const post = (body: unknown) => fetch(`http://127.0.0.1:${server.port}/api/runtime/move`, { method: "POST", headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify(body) });
    const stale = await post({ revision: "not-the-plan-shown" });
    expect([stale.status, ((await stale.json()) as { error: { code: string } }).error.code]).toEqual([409, "plan_changed"]);
    expect((await read({})).status).toBe(401);
    current = facts({ app_installed: true });
    expect((await read()).body).toEqual({ available: false, reason: "herdr_app", status: { state: "idle" } });
  } finally {
    server.stop();
  }
});
