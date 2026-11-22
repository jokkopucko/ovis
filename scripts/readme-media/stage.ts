/**
 * A staged, fictional herdr session for the README media (capture.ts): its own named herdr
 * session (never the one you work in), the demo's two repositories under /tmp/herdr-demo with
 * their agent worktrees and the release shell tab, and curated chats served in place of real
 * transcripts. The real hostname never reaches the page.
 */
// with HERDR_TEST_LIVE=1 test-herdr.ts leaves the session alone, and staging would close every workspace in the one you work in
if (process.env["HERDR_TEST_LIVE"] === "1") throw new Error("readme-media/stage.ts stages its own herdr session: unset HERDR_TEST_LIVE");
process.env["HERDR_TEST_SESSION"] = "ovis-demo";
await import("../test-herdr.ts");
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { createServer } = await import("../../server/index.ts");
const { herdrRpc, workspaceCreate, workspaceClose, sessionSnapshot, tabCreate, worktreeCreate } = await import("../../server/herdr/client.ts");
const { hostname } = await import("node:os");

const REAL_HOST = hostname();
const HOST = "workstation";
const ROOT = "/tmp/herdr-demo";

import { SPECS, CHATS, PROMPT, type DemoSpec } from "../../site/demo/fixtures.ts";
export { CHATS, PROMPT };

export interface DemoPane extends DemoSpec { pane: string; workspace: string }

function releaseRepo(dir: string) {
  const sh = (cmd: string) => { const r = Bun.spawnSync(["bash", "-c", cmd], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "demo", GIT_AUTHOR_EMAIL: "demo@example.com", GIT_COMMITTER_NAME: "demo", GIT_COMMITTER_EMAIL: "demo@example.com" } }); if (r.exitCode !== 0) throw new Error(cmd + ": " + r.stderr.toString()); };
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  sh("git init -q -b main");
  const money = `export const cents = (amount: string): number => Math.round(Number(amount) * 100);\nexport const format = (cents: number): string => (cents / 100).toFixed(2);\n`;
  Bun.write(join(dir, "src/money.ts"), money); sh("git add -A && git commit -q -m 'feat: money helpers'");
  Bun.write(join(dir, "src/money.test.ts"), `import { expect, test } from "bun:test";\nimport { cents, format } from "./money.ts";\ntest("parses amounts to cents", () => expect(cents("12.34")).toBe(1234));\ntest("rounds half a cent", () => expect(cents("0.005")).toBe(1));\ntest("formats cents", () => expect(format(1234)).toBe("12.34"));\ntest("formats zero", () => expect(format(0)).toBe("0.00"));\n`);
  sh("git add -A && git commit -q -m 'test: cover money helpers'");
  sh("git checkout -q -b feat/idempotency && git commit -q --allow-empty -m 'feat(payments): replay the first response for a repeated key' && git commit -q --allow-empty -m 'test(payments): concurrent retries'");
  sh("git checkout -q main && git merge -q --no-ff feat/idempotency -m 'Merge branch feat/idempotency'");
  sh("git commit -q --allow-empty -m 'chore(release): 1.4.0' && git tag v1.4.0");
}

/** An empty repository with one commit, so herdr can add worktrees to it. */
function gitRepo(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const r = Bun.spawnSync(["bash", "-c", "git init -q -b main && git commit -q --allow-empty -m init"], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "demo", GIT_AUTHOR_EMAIL: "demo@example.com", GIT_COMMITTER_NAME: "demo", GIT_COMMITTER_EMAIL: "demo@example.com" } });
  if (r.exitCode !== 0) throw new Error("git init: " + r.stderr.toString());
}

export async function stage() {
  for (const ws of (await sessionSnapshot()).workspaces) await workspaceClose(ws.workspace_id).catch(() => {});
  // herdr's worktree folders from an earlier run would refuse the same paths
  rmSync(join(ROOT, "worktrees"), { recursive: true, force: true });
  const panes: DemoPane[] = [];
  const byKey = (key: string | undefined) => panes.find((p) => p.key === key);
  // a worktree is herdr's own (under the demo root, so no home path shows), and a tab joins its
  // repository's workspace
  for (const spec of SPECS) {
    const parent = byKey(spec.worktreeOf ?? spec.tabOf);
    let pane: string, workspace: string, cwd: string;
    if (spec.tabOf && parent) {
      const tab = await tabCreate({ workspaceId: parent.workspace, label: spec.label });
      ({ pane_id: pane } = tab.root_pane);
      workspace = parent.workspace;
      cwd = join(ROOT, SPECS.find((s) => s.key === spec.tabOf)!.label);
    } else if (spec.worktreeOf && spec.branch && parent) {
      const opened = await worktreeCreate({ workspaceId: parent.workspace, branch: spec.branch, label: spec.label, path: join(ROOT, "worktrees", spec.label) });
      ({ pane_id: pane } = opened.root_pane);
      workspace = opened.workspace.workspace_id;
      cwd = opened.worktree.path;
    } else {
      cwd = join(ROOT, spec.label);
      if (SPECS.some((s) => s.tabOf === spec.key && !s.agent)) releaseRepo(cwd); else gitRepo(cwd);
      const ws = await workspaceCreate({ cwd, label: spec.label });
      pane = ws.root_pane.pane_id;
      workspace = ws.workspace.workspace_id;
    }
    panes.push({ ...spec, pane, workspace });
    // a plain prompt: no user, host or home path on screen
    await herdrRpc("pane.send_text", { pane_id: pane, text: `exec env -i HOME=${cwd} TERM=xterm-256color PATH=$PATH bash --norc --noprofile\n` });
  }
  await Bun.sleep(800);
  for (const p of panes) {
    await herdrRpc("pane.send_text", { pane_id: p.pane, text: `PS1='\\[\\e[38;5;214m\\]${p.label}\\[\\e[0m\\] \\$ '; clear\n` });
    await herdrRpc("pane.rename", { pane_id: p.pane, label: p.title });
    if (p.agent) await herdrRpc("pane.report_agent", { pane_id: p.pane, source: "manual", agent: p.agent, state: p.state ?? "idle" });
  }
  // the resident workspace test-herdr keeps must not show
  for (const ws of (await sessionSnapshot()).workspaces) if (!panes.some((p) => p.workspace === ws.workspace_id)) await workspaceClose(ws.workspace_id).catch(() => {});
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-demo-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir });
  const base = `http://127.0.0.1:${server.port}`;
  const byPane = new Map(panes.map((p) => [p.pane, p]));
  let promptAnswered = false;

  async function routes(page: any) {
    const scrub = (text: string) => text.split(REAL_HOST).join(HOST);
    // the live event stream cannot be rewritten; the 5 s machines poll carries the same data
    // by path: the app asks with `?compact_agents=1`, which a glob ending in the path does not match
    await page.route((url: URL) => url.pathname === "/api/machines/events", (route: any) => route.abort());
    await page.route((url: URL) => url.pathname === "/api/machines", async (route: any) => {
      try {
        const response = await route.fetch();
        await route.fulfill({ response, body: scrub(await response.text()) });
      } catch {}
    });
    await page.route("**/api/pane/conversation?*", async (route: any) => {
      const id = new URL(route.request().url()).searchParams.get("pane_id") ?? "";
      const chat = CHATS[byPane.get(id)?.key ?? ""];
      if (!chat) return route.fallback();
      await route.fulfill({ json: { source: "claude-transcript", turns: chat.turns, metadata: chat.metadata, cursor: null, version: "demo-1" } });
    });
    await page.route("**/api/pane/prompt?*", async (route: any) => {
      const id = new URL(route.request().url()).searchParams.get("pane_id") ?? "";
      await route.fulfill({ json: { prompt: byPane.get(id)?.key === "web" && !promptAnswered ? PROMPT : null } });
    });
    await page.route("**/api/pane/prompt/answer", async (route: any) => {
      promptAnswered = true;
      const web = panes.find((p) => p.key === "web")!;
      await herdrRpc("pane.report_agent", { pane_id: web.pane, source: "manual", agent: "codex", state: "working" });
      await route.fulfill({ json: { ok: true } });
    });
  }

  async function teardown() {
    server.stop();
    for (const workspace of new Set(panes.map((p) => p.workspace))) await workspaceClose(workspace).catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
  async function reset() {
    promptAnswered = false;
    const web = panes.find((p) => p.key === "web")!;
    await herdrRpc("pane.report_agent", { pane_id: web.pane, source: "manual", agent: "codex", state: "blocked" });
  }
  return { base, panes, routes, reset, teardown, pane: (key: string) => panes.find((p) => p.key === key)! };
}
