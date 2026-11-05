/** Owned workspace lifecycle; agent readiness is controlled, so no paid agent process starts. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, devices } from "playwright-core";
import type { Machine } from "../shared/machines.ts";
import type { WorkspaceCreated } from "../shared/protocol.ts";
import { sessionSnapshot, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { passingFolder } from "../src/lib/recent-directories.ts";
import { chromePath } from "./chrome-path.ts";
// machine events stay on SSE here: these checks hold or watch /api/machines/events (the socket transport has its own checks)
process.env["OVIS_MACHINE_EVENTS_WS"] = "0";

await import("./test-herdr.ts");
const { createServer } = await import("../server/index.ts");
const { UsageService } = await import("../server/usage.ts");
// not under a folder recent folders leave out: the temporary directory, or this checkout when it
// is one of herdr's worktrees (`passingFolder`), so the fixtures live under the home's cache
const cache = join(homedir(), ".cache", "ovis-tests");
mkdirSync(cache, { recursive: true });
const root = realpathSync(mkdtempSync(join(cache, "herdr-recent-folders-")));
if (passingFolder(root)) throw new Error(`the fixtures' folder ${root} is one recent folders leave out`);
const owned = new Set<string>();
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), usage: new UsageService(undefined, []) });
try {
  const browser = await chromium.launch({
    executablePath: chromePath(),
    headless: true, args: ["--no-sandbox"],
  });
  try {
    // the browser lane passes an empty UI_EVIDENCE_DIR when it keeps no evidence (scripts/ci-browser.sh)
    const evidence = process.env["UI_EVIDENCE_DIR"] || join(root, "evidence");
    mkdirSync(evidence, { recursive: true });
    for (const width of [1440, 1920, 390]) {
      for (const theme of ["dark", "light"]) {
        const project = join(root, `${width}-${theme}`, "Alpha 프로젝트");
        const other = join(root, `${width}-${theme}`, "Beta-긴-프로젝트-폴더-이름-잘림과-줄바꿈-검증");
        mkdirSync(project, { recursive: true });
        mkdirSync(other, { recursive: true });
        const alpha = await workspaceCreate({ cwd: project, label: "Alpha", focus: false });
        owned.add(alpha.workspace.workspace_id);
        const beta = await workspaceCreate({ cwd: other, label: "Beta", focus: false });
        owned.add(beta.workspace.workspace_id);
        const context = await browser.newContext({
          ...(width === 390 ? devices["iPhone 14"] : {}),
          viewport: { width, height: 900 }, locale: "ko-KR", reducedMotion: "reduce",
        });
        const gate = Promise.withResolvers<void>();
        try {
          await context.addInitScript(({ theme, project }) => {
            const setItem = Storage.prototype.setItem;
            Storage.prototype.setItem = function (key, value) {
              setItem.call(this, key, value);
              if (this === localStorage && key === "ovis:recent-directories:local"
                && JSON.parse(value).includes(project)) console.info("RECENTS_SEEDED");
            };
            localStorage.setItem("ovis:settings", JSON.stringify({ theme, language: "ko" }));
            localStorage.setItem("ovis:new-session-agent", "codex");
            localStorage.setItem("ovis:recent-directories:remote", '["/remote-only/project"]');
            // a folder kept from before: the two the snapshot's panes are in go behind it
            if (localStorage.getItem("ovis:recent-directories:local") === null) {
              localStorage.setItem("ovis:recent-directories:local", '["/older/one"]');
            }
          }, { theme, project });
          await context.route("**/api/agents", (route) => route.fulfill({ json: { agents: [{ kind: "codex", label: "Codex" }] } }));
          await context.route("**/api/machines/events", (route) => route.abort());
          await context.route("**/api/machines", async (route) => {
            const response = await route.fetch();
            const body: { machines: Machine[] } = await response.json();
            const local = body.machines.find((machine) => machine.id === "local");
            assert.ok(local?.snapshot);
            await route.fulfill({ json: { machines: [{
              ...local, name: "QA host", snapshot: {
                ...local.snapshot,
                panes: [
                  ...local.snapshot.panes.filter((pane) => pane.cwd === project),
                  ...local.snapshot.panes.filter((pane) => pane.cwd === other),
                ],
                workspaces: local.snapshot.workspaces.filter((workspace) => owned.has(workspace.workspace_id)),
              },
            }] } });
          });
          let requests = 0;
          let failCreate = false;
          let partialFailure = false;
          await context.route("**/api/workspace/create", async (route) => {
            requests++;
            const body: { cwd: string; label: string | null; agent: { kind: string } | null } = route.request().postDataJSON();
            assert.equal(body.agent?.kind, "codex");
            if (failCreate) {
              await route.fulfill({ status: 400, json: { error: { code: "invalid_cwd", message: "Folder no longer exists" } } });
              return;
            }
            await gate.promise;
            // The real server creates an owned shell; only the agent result is controlled.
            const response = await route.fetch({ postData: JSON.stringify({ ...body, agent: null }) });
            assert.equal(response.ok(), true);
            const result: WorkspaceCreated = await response.json();
            owned.add(result.workspace_id);
            await route.fulfill({ json: { ...result, agent_started: !partialFailure,
              ...(partialFailure ? { error: { code: "agent_start_failed", message: "Controlled agent failure" } } : {}) } });
          });
          const page = await context.newPage();
          page.setDefaultTimeout(10_000);
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const seeded = page.waitForEvent("console", { predicate: (message) => message.text() === "RECENTS_SEEDED", timeout: 10_000 });
          await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(beta.root_pane.pane_id)}`);
          const alphaRow = page.locator(`[data-workspace="${alpha.workspace.workspace_id}"]`);
          const betaRow = page.locator(`[data-workspace="${beta.workspace.workspace_id}"]`);
          await alphaRow.waitFor({ state: "attached" });
          await seeded;
          const removed = alphaRow.waitFor({ state: "detached" });
          await workspaceClose(alpha.workspace.workspace_id);
          owned.delete(alpha.workspace.workspace_id);
          await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
          await removed;
          await page.reload();
          await betaRow.waitFor({ state: "attached" });
          const openNew = async () => {
            if (width === 390) await page.locator('[aria-controls="workspace-drawer"]').click();
            // the test session's lone Host has no header: its + is the New workspace row
            await page.locator(".machine-new-row").click();
            await page.getByRole("dialog").waitFor();
          };
          await openNew();
          const dialog = page.getByRole("dialog");
          const chip = dialog.getByRole("button", { name: `${project} 폴더 사용`, exact: true });
          await chip.waitFor();
          await dialog.locator(".agent-picker-trigger", { hasText: "Codex" }).waitFor();
          const chips = dialog.locator('[role="group"] .new-session-folder-chip:not(.new-session-folder-more)');
          const more = dialog.locator('[role="group"] .new-session-folder-more');
          const titles = (from: typeof chips) => from.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("title")));
          // what the dialog offers: its chips, then on a wider screen what "+N" lists, in order
          const offered = async (): Promise<(string | null)[]> => {
            const shown = await titles(chips);
            if (await more.count() === 0) return shown;
            assert.notEqual(width, 390, "a phone swipes its row and has no +N");
            await more.click();
            const menu = page.getByRole("menu", { name: "최근 폴더", exact: true });
            await menu.waitFor();
            const rest = await titles(menu.getByRole("menuitem"));
            assert.equal(await more.innerText(), `+${rest.length}`);
            await page.keyboard.press("Escape");
            await menu.waitFor({ state: "detached" });
            assert.equal(await dialog.isVisible(), true, "Escape closes the list, not the dialog");
            return [...shown, ...rest];
          };
          const pickFolder = async (path: string): Promise<void> => {
            const button = dialog.getByRole("button", { name: `${path} 폴더 사용`, exact: true });
            if (await button.count() > 0) { await button.click(); return; }
            await more.click();
            await page.getByRole("menu", { name: "최근 폴더", exact: true }).getByRole("menuitem").and(page.locator(`[title="${path}"]`)).click();
          };
          const submit = dialog.locator('button[type="submit"]');
          assert.deepEqual(await offered(), ["/older/one", other, project], "folders only seen in panes come behind the one kept");
          assert.equal(new Set(await chips.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().top))).size, 1, "recent folders stay on one row");
          // a phone swipes the row sideways; a wider screen has room for it
          if (width === 390) assert.equal(await dialog.locator(".new-session-folder-chips").evaluate((node) => getComputedStyle(node).overflowX), "auto");
          else assert.equal(await dialog.locator(".new-session-folder-chips").evaluate((node) => node.scrollWidth > node.clientWidth), false);
          assert.equal(await dialog.getByRole("button", { name: /remote-only/ }).count(), 0);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          await dialog.getByRole("button", { name: "창 닫기", exact: true }).focus();
          await page.keyboard.press("Shift+Tab");
          assert.equal(await dialog.evaluate((node) => node.contains(document.activeElement)), true);
          await dialog.screenshot({ path: join(evidence, `recent-folders-${width}-${theme}.png`) });

          const request = page.waitForRequest((request) => request.url().endsWith("/api/workspace/create"));
          const response = page.waitForResponse((response) => response.url().endsWith("/api/workspace/create"));
          await chip.click();
          assert.equal(await dialog.locator("#new-session-cwd").inputValue(), project);
          assert.equal(requests, 0, "a chip fills Directory and starts nothing");
          await submit.click();
          assert.deepEqual((await request).postDataJSON(), { cwd: project, label: null, agent: { kind: "codex" } });
          assert.equal(await chip.isDisabled(), true);
          assert.equal(await dialog.locator('[role="group"] .new-session-folder-chip:not(:disabled)').count(), 0);
          await page.keyboard.press("Escape");
          assert.equal(await dialog.isVisible(), true);
          gate.resolve();
          const created: WorkspaceCreated = await (await response).json();
          await dialog.waitFor({ state: "detached" });
          await page.locator(`.workspace-select[data-pane="${created.pane_id}"][aria-current="true"]`).waitFor({ state: "attached" });
          assert.equal(requests, 1);
          assert.equal((await sessionSnapshot()).panes.find((pane) => pane.pane_id === created.pane_id)?.cwd, project);

          await workspaceClose(created.workspace_id);
          owned.delete(created.workspace_id);
          // a fourth folder, and kept from before, a herdr worktree and a temporary folder
          await page.evaluate(() => {
            const key = "ovis:recent-directories:local";
            localStorage.setItem(key, JSON.stringify([...JSON.parse(localStorage.getItem(key)!) as string[], "/home/me/.herdr/worktrees/app/feat", "/tmp/scratch", "/older/two"]));
          });
          await page.reload();
          await betaRow.waitFor({ state: "attached" });
          await openNew();
          await chip.waitFor();
          // the folder a workspace was started in is first now; a worktree and a temporary folder are left out
          assert.deepEqual(await offered(), [project, "/older/one", other, "/older/two"]);
          if (width !== 390) assert.equal(new Set(await chips.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().top))).size, 1, "a wider screen keeps one row too, the rest under +N");
          if (width !== 390) assert.equal(await more.count(), 1, "four folders with a long name are more than the row holds: +N lists the rest");
          // the measuring row behind the chips adds no width the dialog could scroll to
          assert.equal(await dialog.locator(".modal-body").evaluate((node) => node.scrollWidth <= node.clientWidth), true, "the dialog never scrolls sideways");
          if (width === 390) assert.equal(new Set(await chips.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().top))).size, 1, "a phone keeps them on one row");
          failCreate = true;
          await pickFolder(other);
          await submit.click();
          await dialog.getByRole("alert").filter({ hasText: "폴더를 찾을 수 없습니다" }).waitFor();
          assert.equal(await chips.first().isEnabled(), true);
          assert.equal(await chips.first().getAttribute("title"), project);
          assert.equal((await offered()).length, 4);
          failCreate = false;
          partialFailure = true;
          const partialResponse = page.waitForResponse((response) => response.url().endsWith("/api/workspace/create"));
          await submit.click();
          const partial: WorkspaceCreated = await (await partialResponse).json();
          await dialog.getByRole("alert").filter({ hasText: "Controlled agent failure" }).waitFor();
          assert.equal(await dialog.locator('[role="group"] .new-session-folder-chip:not(:disabled)').count(), 0);
          assert.equal(await chips.first().getAttribute("title"), project);
          const beforeOpen = requests;
          await submit.click();
          await dialog.waitFor({ state: "detached" });
          await page.locator(`.workspace-select[data-pane="${partial.pane_id}"][aria-current="true"]`).waitFor({ state: "attached" });
          assert.equal(requests, beforeOpen, "Open after partial failure never creates another workspace");
          assert.deepEqual(errors, []);
          console.log(`PASS recent folders ${width} ${theme}: snapshot seed behind kept folders, closed workspace, reload, PC isolation, worktrees and temporary folders left out, one swiped row on a phone, one row and +N on a wider screen, chip fills Directory, a start moves its folder first, pending, focus trap, failed-start order`);
        } finally {
          gate.resolve();
          await context.close();
          for (const workspaceId of [...owned]) {
            await workspaceClose(workspaceId);
            owned.delete(workspaceId);
          }
        }
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  server.stop(true);
  for (const workspaceId of owned) await workspaceClose(workspaceId);
  rmSync(root, { recursive: true, force: true });
}
