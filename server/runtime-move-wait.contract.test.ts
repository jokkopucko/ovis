import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrRuntimeFacts } from "../shared/machines.ts";
import type { MovePlanResponse, MoveStatus } from "../shared/runtime-move.ts";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { findHc } from "./herdr-core/discovery.ts";
import type { RuntimeService } from "./herdr-core/runtime-choice.ts";
import { createServer } from "./index.ts";

// A move asked for while a pane of the test session works: it waits, a cancel leaves everything as
// it was, and once the pane is done it goes by itself. No herdr-core is reachable here, so a move
// that goes stops before any agent is ended. The runtime switch is a stand-in that records asks.
const SECRET = "test-runtime-move-wait-secret";
const WAIT_MS = 20_000;
const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-runtime-move-wait-")));
const facts: HerdrRuntimeFacts = { serving: "herdr", source: "detected", tui: { installed: true, running: true }, app_installed: false, switch_to: "herdr-core", locked: null };
const asked: unknown[] = [];
let switching = false;
const runtimeService: RuntimeService = { facts: () => facts, request: (target) => { asked.push(target); return { ok: true }; }, switching: () => switching };
const workspaces: string[] = [];
let server: ReturnType<typeof createServer>;
// with an hc on this PC a move would build there for real: that is the gated test in runtime-move-service.contract.test.ts
const hcHere = await findHc() !== null;

const read = async (): Promise<MovePlanResponse> => (await (await fetch(`http://127.0.0.1:${server.port}/api/runtime/move`, { headers: { authorization: `Bearer ${SECRET}` } })).json()) as MovePlanResponse;
const send = (method: "POST" | "DELETE", body?: unknown) => fetch(`http://127.0.0.1:${server.port}/api/runtime/move`, {
  method, headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json", "x-herdr-update": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
/** reads the status until `done` says so, within WAIT_MS */
async function statusUntil(done: (status: MoveStatus) => boolean): Promise<MoveStatus> {
  for (const deadline = Date.now() + WAIT_MS; ;) {
    const { status } = await read();
    if (done(status)) return status;
    if (Date.now() > deadline) throw new Error(`the move's status stayed ${JSON.stringify(status)}`);
    await Bun.sleep(100);
  }
}
/** a pane herdr says an agent is working in */
async function busyPane(): Promise<string> {
  const created = await workspaceCreate({ cwd: root, label: "move-wait" });
  workspaces.push(created.workspace.workspace_id);
  const pane = created.root_pane.pane_id;
  await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "codex", state: "working" });
  return pane;
}
/** the person ended the agent: herdr names none in the pane */
const ended = (pane: string) => herdrRpc("pane.release_agent", { pane_id: pane, source: "manual", agent: "codex" });

beforeAll(() => {
  server = createServer({ port: 0, hostname: "127.0.0.1", token: SECRET, stateDir: join(root, "state"), runtimeService });
});
afterAll(async () => {
  server.stop();
  for (const workspace of workspaces) await workspaceClose(workspace).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("a move while the runtime switches", () => {
  it("is refused before anything is ended once a runtime switch was asked for", async () => {
    const created = await workspaceCreate({ cwd: root, label: "move-switching" });
    workspaces.push(created.workspace.workspace_id);
    const { plan } = (await read()) as Extract<MovePlanResponse, { available: true }>;
    switching = true;
    try {
      const refused = await send("POST", { revision: plan.revision });
      expect([refused.status, ((await refused.json()) as { error: { code: string } }).error.code]).toEqual([409, "runtime_switching"]);
      expect((await read()).status).toEqual({ state: "idle" });
    } finally {
      switching = false;
    }
  });
});

describe("a move while a pane works", () => {
  it("waits, and a cancel leaves herdr as it was and moves nothing once the pane is done", async () => {
    const pane = await busyPane();
    const { plan } = (await read()) as Extract<MovePlanResponse, { available: true }>;
    expect(plan.ready).toBe(false);
    expect(plan.panes.find((entry) => entry.pane_id === pane)?.verdict).toEqual({ kind: "busy", reason: "agent_working", agent: "codex", command: null });
    expect((await send("POST", { revision: plan.revision })).status).toBe(202);
    expect((await read()).status).toEqual({ state: "waiting", revision: plan.revision });
    // a runtime switch asked meanwhile is refused: the move switches by itself
    const switching = await fetch(`http://127.0.0.1:${server.port}/api/runtime`, { method: "POST", headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify({ runtime: "herdr-core" }) });
    expect(switching.status).toBe(409);
    expect((await send("DELETE")).status).toBe(200);
    expect((await read()).status).toEqual({ state: "idle" });
    await ended(pane);
    // fixed wait: proving that nothing arrives - the cancelled wait looked every 2 s and must not go
    await Bun.sleep(4_500);
    expect((await read()).status).toEqual({ state: "idle" });
    expect(asked).toEqual([]);
    expect(existsSync(join(root, "state", `runtime-move-${server.port}.json`))).toBe(false);
    expect((await sessionSnapshot()).panes.some((entry) => entry.pane_id === pane)).toBe(true);
  }, WAIT_MS + 10_000);

  it.skipIf(hcHere)("goes by itself once the pane is done, and with no herdr-core ends nothing and switches nothing", async () => {
    const pane = await busyPane();
    const { plan } = (await read()) as Extract<MovePlanResponse, { available: true }>;
    expect((await send("POST", { revision: plan.revision })).status).toBe(202);
    expect((await read()).status.state).toBe("waiting");
    await ended(pane);
    const status = await statusUntil((now) => now.state !== "waiting" && now.state !== "moving");
    expect(status).toEqual({ state: "rolled_back", reason: "failed: no herdr-core found", left: [] });
    expect(asked).toEqual([]);
    expect((await sessionSnapshot()).panes.some((entry) => entry.pane_id === pane)).toBe(true);
  }, WAIT_MS + 10_000);
});
