import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrRuntimeFacts } from "../shared/machines.ts";
import type { MovePlanResponse, MoveStatus } from "../shared/runtime-move.ts";
import { herdrRpc, paneProcessInfo, paneSendKeys, paneSendText, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { RuntimeService } from "./herdr-core/runtime-choice.ts";
import { createServer } from "./index.ts";

const SECRET = "test-runtime-move-stop-secret";
const WAIT_MS = 20_000;
const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-runtime-move-stop-")));
const facts: HerdrRuntimeFacts = { serving: "herdr", source: "detected", tui: { installed: true, running: true }, app_installed: false, switch_to: "herdr-core", locked: null };
const runtimeService: RuntimeService = { facts: () => facts, request: () => ({ ok: true }), switching: () => false };
const workspaces: string[] = [];
let server: ReturnType<typeof createServer>;

const headers = { authorization: `Bearer ${SECRET}`, "content-type": "application/json", "x-herdr-update": "1" };
const read = async (): Promise<Extract<MovePlanResponse, { available: true }>> => (await (await fetch(`http://127.0.0.1:${server.port}/api/runtime/move`, { headers })).json()) as Extract<MovePlanResponse, { available: true }>;
const stop = async (body: unknown): Promise<{ status: number; code: string | null }> => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/runtime/move/stop`, { method: "POST", headers, body: JSON.stringify(body) });
  const answer = (await response.json()) as { error?: { code: string } };
  return { status: response.status, code: answer.error?.code ?? null };
};

async function until<T>(what: string, look: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (const deadline = Date.now() + WAIT_MS; ;) {
    const value = await look();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`${what} stayed ${JSON.stringify(value)}`);
    await Bun.sleep(100);
  }
}

async function newPane(label: string): Promise<string> {
  const created = await workspaceCreate({ cwd: root, label });
  workspaces.push(created.workspace.workspace_id);
  return created.root_pane.pane_id;
}

async function running(label: string, command: string): Promise<string> {
  const pane = await newPane(label);
  await until("the new shell", () => paneProcessInfo(pane).catch(() => undefined), (info) => info?.shell_pid != null && info.foreground_process_group_id === info.shell_pid);
  await paneSendText(pane, command);
  await paneSendKeys(pane, ["enter"]);
  await until(`${label}'s verdict`, async () => (await read()).plan.panes.find((entry) => entry.pane_id === pane)?.verdict, (verdict) => verdict?.kind === "busy" && verdict.reason === "command_running" && verdict.command === "sleep");
  return pane;
}

const shellInFront = async (pane: string): Promise<boolean> => {
  const info = await paneProcessInfo(pane);
  return info?.shell_pid != null && info.foreground_process_group_id === info.shell_pid;
};

async function waitingMove(): Promise<void> {
  const { plan, status } = await read();
  if (status.state === "waiting") return;
  const started = await fetch(`http://127.0.0.1:${server.port}/api/runtime/move`, { method: "POST", headers, body: JSON.stringify({ revision: plan.revision }) });
  expect(started.status).toBe(202);
  expect((await read()).status.state).toBe("waiting");
}

let agentPane: string;

beforeAll(async () => {
  server = createServer({ port: 0, hostname: "127.0.0.1", token: SECRET, stateDir: join(root, "state"), runtimeService });
  agentPane = await newPane("move-stop-agent");
  await herdrRpc("pane.report_agent", { pane_id: agentPane, source: "manual", agent: "codex", state: "working" });
});
afterAll(async () => {
  await fetch(`http://127.0.0.1:${server.port}/api/runtime/move`, { method: "DELETE", headers }).catch(() => undefined);
  server.stop();
  for (const workspace of workspaces) await workspaceClose(workspace).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("ending a busy pane from the move's wait", () => {
  it("is refused while no move waits", async () => {
    const pane = await running("move-stop-idle", "sleep 600");
    expect((await read()).status.state).toBe("idle");
    expect(await stop({ pane_id: pane })).toEqual({ status: 409, code: "not_waiting" });
    expect(await shellInFront(pane)).toBe(false);
  }, WAIT_MS * 3);

  it("sends Ctrl+C to that pane only, and never to an agent's", async () => {
    const pane = await running("move-stop-one", "sleep 600");
    const other = await running("move-stop-other", "sleep 600");
    await waitingMove();
    expect(await stop({ pane_id: agentPane })).toEqual({ status: 409, code: "not_running" });
    expect(await stop({ pane_id: pane, command: "top" })).toEqual({ status: 409, code: "changed" });
    expect(await shellInFront(pane)).toBe(false);
    expect(await stop({ pane_id: pane, command: "sleep" })).toEqual({ status: 200, code: null });
    await until("the stopped pane", () => shellInFront(pane), (front) => front);
    expect(await shellInFront(other)).toBe(false);
    expect((await read()).status.state).toBe("waiting");
  }, WAIT_MS * 3);

  it("refuses a request that is not this app's own or names no pane", async () => {
    const pane = await running("move-stop-refusals", "sleep 600");
    await waitingMove();
    const foreign = { authorization: headers.authorization, "content-type": headers["content-type"] };
    const response = await fetch(`http://127.0.0.1:${server.port}/api/runtime/move/stop`, { method: "POST", headers: foreign, body: JSON.stringify({ pane_id: pane }) });
    expect(response.status).toBe(403);
    expect(await stop({})).toEqual({ status: 400, code: "invalid_pane" });
    expect(await stop({ pane_id: pane, force: "yes" })).toEqual({ status: 400, code: "invalid_force" });
    expect(await shellInFront(pane)).toBe(false);
  }, WAIT_MS * 3);

  it("offers End again for a new command once the one it stopped has ended", async () => {
    const pane = await running("move-stop-again", "sleep 600");
    await waitingMove();
    expect(await stop({ pane_id: pane })).toEqual({ status: 200, code: null });
    await until("the stopped pane", () => shellInFront(pane), (front) => front);
    await paneSendText(pane, "sleep 600");
    await paneSendKeys(pane, ["enter"]);
    await until("the new command", () => shellInFront(pane), (front) => !front);
    const { status } = await read();
    expect(status.state === "waiting" && (status.stopping ?? []).some((entry) => entry.pane_id === pane)).toBe(false);
    expect(await stop({ pane_id: pane })).toEqual({ status: 200, code: null });
    await until("the new command's end", () => shellInFront(pane), (front) => front);
  }, WAIT_MS * 3);

  it("ends all only for the list it offered, and refuses once a pane changed", async () => {
    const first = await running("move-stop-all-a", "sleep 600");
    const second = await running("move-stop-all-b", "sleep 600");
    await waitingMove();
    const all = async (body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/runtime/move/stop-all`, { method: "POST", headers, body: JSON.stringify(body) });
      return { status: response.status, answer: (await response.json()) as { token?: string; panes?: { pane_id: string }[]; error?: { code: string } } };
    };
    const offered = await all({});
    expect(offered.status).toBe(200);
    expect(offered.answer.panes?.map((pane) => pane.pane_id)).toEqual(expect.arrayContaining([first, second]));
    await paneSendKeys(first, ["ctrl+c"]);
    await until("the pane ended by hand", () => shellInFront(first), (front) => front);
    const refused = await all({ token: offered.answer.token });
    expect([refused.status, refused.answer.error?.code]).toEqual([409, "changed"]);
    expect(await shellInFront(second)).toBe(false);
    const again = await all({});
    expect((await all({ token: again.answer.token })).status).toBe(200);
    await until("the second pane", () => shellInFront(second), (front) => front);
  }, WAIT_MS * 4);

  it("forces only after Ctrl+C was tried and the command still runs, and only that pane's group", async () => {
    const stubborn = await running("move-stop-stubborn", "sh -c 'trap \"\" INT; exec sleep 600'");
    const other = await running("move-stop-bystander", "sleep 600");
    await waitingMove();
    expect(await stop({ pane_id: stubborn, force: true })).toEqual({ status: 409, code: "not_tried" });
    expect(await stop({ pane_id: stubborn })).toEqual({ status: 200, code: null });
    const offered = await until("the stop's offer", async () => (await read()).status, (status: MoveStatus) => status.state === "waiting" && (status.stopping ?? []).some((entry) => entry.pane_id === stubborn && entry.force));
    expect(offered.state).toBe("waiting");
    expect(await shellInFront(stubborn)).toBe(false);
    expect(await stop({ pane_id: stubborn, force: true })).toEqual({ status: 200, code: null });
    await until("the forced pane", () => shellInFront(stubborn), (front) => front);
    expect(await shellInFront(other)).toBe(false);
  }, WAIT_MS * 4);
});
