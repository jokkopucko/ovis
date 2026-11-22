import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { omoPanes, omoSessionFolder } from "../server/omo.ts";
import { startShellAgent } from "../server/shell-agent.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-omo-browser-")));
const launchers = join(root, "launchers");
mkdirSync(launchers, { recursive: true });

// A neutral-named launcher that holds a native session the way senpi does: it publishes
// session-holders/<id>/<pid>.json and, while its control file names another id, releases
// the old one and holds the new — the pane's /new, with no transcript written.
const fixture = `import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processStartedAt } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "../server/process-start.ts")).href)};
const sessionDir = process.argv[2];
const controlFile = process.argv[4];
const cwd = process.argv[5];
const pid = process.pid;
const record = JSON.stringify({ pid, bootAtMs: 0, processStartedAtMs: processStartedAt(pid) ?? 0, cwd });
let held = null;
const hold = (id) => {
  if (held !== null) rmSync(join(sessionDir, "session-holders", encodeURIComponent(held), pid + ".json"), { force: true });
  const dir = join(sessionDir, "session-holders", encodeURIComponent(id));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, pid + ".json"), record);
  held = id;
};
hold(process.argv[3]);
setInterval(() => {
  let next = "";
  try { next = readFileSync(controlFile, "utf8").trim(); } catch { return; }
  if (next !== "" && next !== held) hold(next);
}, 40);
setInterval(() => {}, 1000);
`;

const SHARED_ID = "shared-omo-session-0001";
const LEGACY_ID = "legacy-omo-session-0002";
const AFTER_NEW_ID = "after-new-omo-session-0003";
const textA = "the alpha store's own answer, bound nowhere else";
const textB = "the beta store's answer under the same session id";
const textL = "the legacy launcher's answer";
const textNew = "the first answer of the session after the reset";
const modelA = "synthetic-model-alpha";
const modelB = "synthetic-model-beta";
const modelL = "synthetic-model-legacy";

const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;
const writeLauncher = (name: string) => { const path = join(launchers, name); writeFileSync(path, fixture); return path; };
const rows = (id: string, cwd: string, model: string, effort: string, asked: string, answered: string): unknown[] => [
  { type: "session", version: 3, id, timestamp: "2026-10-13T00:59:58.000Z", cwd },
  { type: "model_change", id: "m1", parentId: null, timestamp: "2026-10-13T00:59:59.000Z", provider: "synthetic-provider", modelId: model },
  { type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: "2026-10-13T00:59:59.100Z", thinkingLevel: effort },
  { type: "message", id: "u1", parentId: "t1", timestamp: "2026-10-13T01:00:00.000Z", message: { role: "user", content: [{ type: "text", text: asked }], timestamp: 1 } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-13T01:00:10.000Z", message: { role: "assistant", content: [{ type: "text", text: answered }], stopReason: "stop", timestamp: 2 } },
];
// omo names a session's file <start>_<id>.jsonl
const writeTranscript = (dir: string, id: string, content: unknown[], stamp = "2026-10-13T00-59-58-000Z"): string => {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${stamp}_${id}.jsonl`);
  writeFileSync(path, content.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return path;
};

interface Conversation { source?: string; turns?: unknown[]; metadata?: { model?: string | null; reasoning_effort?: string | null }; history_id?: string }
const counts = { checks: 0 };
const pass = (what: string) => { counts.checks += 1; console.log(`PASS ${what}`); };
const until = async <T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 20_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
};

const workspaceIds: string[] = [];
const home = process.env["HOME"];
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Page | undefined;
const evidence = process.env["CHECK_BROWSER_EVIDENCE_DIR"];
const shot = async (name: string) => {
  if (!evidence || page === undefined) return;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, name), fullPage: true, animations: "disabled" });
};

try {
  // every fixture file exists before any pane starts; the launcher is given its store
  // by an exported OMO_CODING_AGENT_DIR ahead of exec, so /proc/<pid>/environ carries it
  const launcherA = writeLauncher("team-runner-alpha.mjs");
  const launcherB = writeLauncher("team-runner-beta.mjs");
  const launcherL = writeLauncher("omo");
  const neutral = join(launchers, "neutral-witness.mjs");
  writeFileSync(neutral, "setInterval(() => {}, 1000);\n");
  const made = async (): Promise<string> => {
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-omo-browser" });
    workspaceIds.push(created.workspace.workspace_id);
    return created.root_pane.pane_id;
  };
  const [paneA, paneB, paneL, paneN] = [await made(), await made(), await made(), await made()];
  const paneCwd = root;

  const agentDirA = join(root, "alpha-agent");
  const agentDirB = join(root, "beta-agent");
  const dirA = join(agentDirA, "sessions", omoSessionFolder(paneCwd));
  const dirB = join(agentDirB, "sessions", omoSessionFolder(paneCwd));
  const dirL = join(root, ".omo", "agent", "sessions", omoSessionFolder(paneCwd));
  writeTranscript(dirA, SHARED_ID, rows(SHARED_ID, paneCwd, modelA, "high", "what does alpha hold?", textA));
  writeTranscript(dirB, SHARED_ID, rows(SHARED_ID, paneCwd, modelB, "low", "what does beta hold?", textB));
  writeTranscript(dirL, LEGACY_ID, rows(LEGACY_ID, paneCwd, modelL, "medium", "what does legacy hold?", textL));
  const controlA = join(root, "control-a");
  const controlB = join(root, "control-b");
  const controlL = join(root, "control-l");
  writeFileSync(controlA, `${SHARED_ID}\n`);
  writeFileSync(controlB, `${SHARED_ID}\n`);
  writeFileSync(controlL, `${LEGACY_ID}\n`);

  // the default store resolves under HOME: keep it inside the fixture root
  process.env["HOME"] = root;
  const run = (launcher: string, dir: string, id: string, control: string) =>
    `cd ${quote(root)} && exec ${quote(process.execPath)} ${quote(launcher)} ${quote(dir)} ${quote(id)} ${quote(control)} ${quote(paneCwd)}`;
  await startShellAgent("omo", paneA, [], { command: `export OMO_CODING_AGENT_DIR=${quote(agentDirA)}; ${run(launcherA, dirA, SHARED_ID, controlA)}` });
  await startShellAgent("omo", paneB, [], { command: `export OMO_CODING_AGENT_DIR=${quote(agentDirB)}; ${run(launcherB, dirB, SHARED_ID, controlB)}` });
  await startShellAgent("omo", paneL, [], { command: run(launcherL, dirL, LEGACY_ID, controlL) });
  // a process with no omo evidence at all is sent raw, never through the agent start
  await herdrRpc("pane.send_text", { pane_id: paneN, text: `cd ${quote(root)} && exec ${quote(process.execPath)} ${quote(neutral)}\n` });
  await until("the neutral fixture runs", async () => {
    const info = await herdrRpc<{ process_info?: { foreground_processes?: { argv?: string[] }[] } }>("pane.process_info", { pane_id: paneN });
    return info.process_info?.foreground_processes ?? [];
  }, (procs) => procs.some((proc) => (proc.argv ?? []).includes(neutral)));

  const snapshotPanes = (await sessionSnapshot()).panes;
  assert.ok([paneA, paneB, paneL, paneN].every((id) => snapshotPanes.find((pane) => pane.pane_id === id)?.cwd === paneCwd), "all fixture panes share the cwd after their launch commands");

  // tailscaleOwner null: the plain-HTTP page below reaches the server under a name that is not
  // loopback, which a PC running Tailscale would otherwise send to pairing
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "server-state"), tailscaleOwner: null });
  const port = server.port;
  const conversation = async (paneId: string): Promise<{ status: number; body: Conversation }> => {
    const response = await fetch(`http://127.0.0.1:${port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
    return { status: response.status, body: await response.json() as Conversation };
  };
  const omoConversation = (paneId: string, what: string) => until(what, () => conversation(paneId), (answer) => answer.body.source === "omo-transcript");

  const convA = await omoConversation(paneA, "pane A's HTTP conversation binds the alpha store transcript");
  assert.equal(convA.status, 200);
  const jsonA = JSON.stringify(convA.body.turns);
  assert.ok(jsonA.includes(textA), "pane A answers with its own store's transcript");
  assert.ok(!jsonA.includes(textB), "the same id in the beta store is not pane A's session");
  assert.equal(convA.body.metadata?.model, modelA);
  const convB = await omoConversation(paneB, "pane B's HTTP conversation binds the beta store transcript");
  const jsonB = JSON.stringify(convB.body.turns);
  assert.ok(jsonB.includes(textB), "pane B answers with its own store's transcript");
  assert.ok(!jsonB.includes(textA), "the same id in the alpha store is not pane B's session");
  assert.equal(convB.body.metadata?.model, modelB);
  const convL = await omoConversation(paneL, "the legacy pane's HTTP conversation binds its transcript");
  assert.ok(JSON.stringify(convL.body.turns).includes(textL));
  assert.equal(convL.body.metadata?.model, modelL);
  assert.ok(convA.body.history_id !== undefined && convA.body.history_id !== convB.body.history_id && convB.body.history_id !== convL.body.history_id, "each bound session answers with its own identity");
  pass("each pane's HTTP conversation is omo-transcript with only its own session and model");

  const apiSession = async () => (await (await fetch(`http://127.0.0.1:${port}/api/session`)).json()) as { snapshot: { panes: { pane_id: string; agent?: string | null }[] } };
  const labelled = await until("the server's snapshot names the fixture panes omo", apiSession, ({ snapshot }) =>
    [paneA, paneB, paneL].every((id) => snapshot.panes.find((pane) => pane.pane_id === id)?.agent === "omo"));
  assert.notEqual(labelled.snapshot.panes.find((pane) => pane.pane_id === paneN)?.agent, "omo");
  // a no-evidence process is not omo in discovery either, and HTTP falls back to scrollback
  assert.equal((await omoPanes((await sessionSnapshot()).panes, root)).has(paneN), false);
  const negative = await conversation(paneN);
  assert.equal(negative.status, 200);
  assert.equal(negative.body.source, "scrollback");
  pass("the snapshot names only the omo panes; the no-evidence pane is undiscovered and scrollback");

  browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] ?? "/opt/google/chrome/chrome", headless: process.env["HEADED"] !== "1", args: ["--no-sandbox", "--no-proxy-server"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  page = await context.newPage();
  await page.addInitScript((ids) => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
    for (const id of ids) localStorage.setItem(`ovis:view:${id}`, "chat");
  }, [paneA, paneB, paneL, paneN]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(15_000);

  const open = async (paneId: string) => {
    await page!.goto(`http://127.0.0.1:${port}/?pane=${encodeURIComponent(paneId)}`);
    await page!.locator(".conn-live").waitFor();
    return page!.locator(`.pane-frame[data-layout-pane="${paneId}"]`).getByRole("log");
  };
  const modelInfo = page.getByLabel("Model and reasoning");
  const logA = await open(paneA);
  await logA.getByText(textA, { exact: true }).waitFor();
  assert.equal(await logA.getByText(textB).count(), 0);
  assert.equal(await logA.getByText(textL).count(), 0);
  await modelInfo.getByText(modelA, { exact: true }).waitFor();
  await modelInfo.getByText("high", { exact: true }).waitFor();
  assert.equal(await modelInfo.getByText(modelB).count(), 0);
  const logB = await open(paneB);
  await logB.getByText(textB, { exact: true }).waitFor();
  assert.equal(await logB.getByText(textA).count(), 0);
  await modelInfo.getByText(modelB, { exact: true }).waitFor();
  await modelInfo.getByText("low", { exact: true }).waitFor();
  const logL = await open(paneL);
  await logL.getByText(textL, { exact: true }).waitFor();
  await modelInfo.getByText(modelL, { exact: true }).waitFor();
  pass("each chat draws only its own store's transcript and model metadata, legacy included");

  const logReset = await open(paneA);
  await logReset.getByText(textA, { exact: true }).waitFor();
  writeFileSync(controlA, `${AFTER_NEW_ID}\n`);
  const pending = await until("pane A holds an unwritten session", () => conversation(paneA), (answer) =>
    answer.body.source === "omo-transcript" && answer.body.history_id === `unwritten:${AFTER_NEW_ID}`);
  assert.deepEqual(pending.body.turns, []);
  await logReset.getByText(textA, { exact: true }).waitFor({ state: "detached" });
  assert.equal(await logReset.locator(".chat-turn-user").count(), 0);
  assert.equal(await logReset.getByText(textB).count(), 0);
  pass("/new leaves an empty pending conversation with the old transcript gone");

  writeTranscript(dirA, AFTER_NEW_ID, rows(AFTER_NEW_ID, paneCwd, modelA, "high", "what does the reset hold?", textNew), "2026-10-13T01-05-00-000Z");
  await logReset.getByText(textNew, { exact: true }).waitFor();
  assert.equal(await logReset.getByText(textA).count(), 0);
  pass("the held session's first transcript arrives through live polling, no reload");

  writeFileSync(controlA, `${SHARED_ID}\n`);
  await logReset.getByText(textA, { exact: true }).waitFor();
  assert.equal(await logReset.getByText(textNew).count(), 0);
  const steadyB = await conversation(paneB);
  assert.equal(steadyB.body.source, "omo-transcript");
  assert.ok(JSON.stringify(steadyB.body.turns).includes(textB));
  assert.equal(steadyB.body.history_id, convB.body.history_id);
  pass("resume restores the original session; the same-id pane is untouched");

  assert.deepEqual(errors, []);
  await shot("omo-chat.png");
  console.log(`omo-chat-browser-qa: ${counts.checks} scenario checks`);
} catch (error) {
  await shot("omo-chat-failure.png").catch(() => undefined);
  throw error;
} finally {
  await browser?.close();
  server?.stop();
  for (const id of workspaceIds) await workspaceClose(id);
  if (home === undefined) delete process.env["HOME"];
  else process.env["HOME"] = home;
  rmSync(root, { recursive: true, force: true });
  mkdirSync("node_modules/.cache", { recursive: true });
  writeFileSync("node_modules/.cache/omo-browser-counts.json", JSON.stringify({ checks: counts.checks }));
}
