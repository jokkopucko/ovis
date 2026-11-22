import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, herdrSocketPath, pluginLogList, sessionSnapshot, workspaceClose, workspaceCreate, type WorkspaceCreateResult, type WorktreeOpenResult } from "./herdr/client.ts";
import { disposableConfig } from "../scripts/disposable-config.ts";
import { MACHINE_PROXY_PATH } from "./machine-api.ts";
import type { ApiError, PluginActionResult, PluginActionsResponse } from "../shared/protocol.ts";

/**
 * herdr keeps linked plugins per user, not per session (`$XDG_CONFIG_HOME/herdr/plugins.json`), so
 * a session of the test's own isolates nothing here. This runs only where `bun run check` (and so
 * CI) says the config directory is the run's own and will be thrown away
 * (scripts/disposable-config.ts); anywhere else it is skipped and no registry is written to.
 */
const disposable = disposableConfig(process.env, herdrSocketPath());
const PLUGIN = "ovis-test.actions";
if (disposable === null) console.warn("server/plugins.contract.test.ts skipped: it links a plugin into herdr's per-user registry, so it runs only in a check run's disposable config: bun run check run bun test --timeout 15000 ./server/plugins.contract.test.ts");

describe.skipIf(disposable === null || process.platform === "win32")("plugin actions API", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-plugin-")));
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-plugin-state-"));
  const impatientStateDir = mkdtempSync(join(tmpdir(), "ovis-plugin-state-"));
  const marker = join(root, "marker.json");
  let server: { port: number; stop: () => void };
  let impatient: { port: number; stop: () => void };
  let created: WorkspaceCreateResult;
  const EMPTY_WORKTREE = { repo_key: "", repo_name: "", repo_root: "", checkout_path: "", is_linked_worktree: false };

  async function until(probe: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> {
    for (const deadline = Date.now() + ms; !(await probe());) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(50);
    }
  }

  const base = () => `http://localhost:${server.port}`;
  const invoke = (body: unknown, headers: Record<string, string> = { "x-herdr-machine": "1" }) =>
    fetch(`${base()}/api/plugin/action`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  beforeAll(async () => {
    writeFileSync(join(root, "herdr-plugin.toml"), `id = "${PLUGIN}"
name = "Web UI test actions"
version = "0.1.0"
min_herdr_version = "0.9.0"
description = "Linked by server/plugins.contract.test.ts"
platforms = ["linux", "macos", "windows"]

[[actions]]
id = "mark"
title = "Write marker"
description = "Writes its invocation context"
contexts = ["pane"]
command = ["sh", "mark.sh"]

[[actions]]
id = "fail"
title = "Always fails"
contexts = ["global"]
command = ["sh", "-c", "echo boom >&2; exit 3"]

[[actions]]
id = "slow"
title = "Slow, opens nothing"
contexts = ["pane"]
command = ["sh", "-c", "sleep 2; echo slow-done"]

[[actions]]
id = "late"
title = "Fails late"
contexts = ["global"]
command = ["sh", "-c", "sleep 2; echo boom >&2; exit 3"]

[[actions]]
id = "board"
title = "Open board"
contexts = ["workspace"]
command = ["sh", "-c", "exec \\"$HERDR_BIN_PATH\\" plugin pane open --plugin ${PLUGIN} --entrypoint board --placement split --target-pane \\"$HERDR_PANE_ID\\" --focus"]
platforms = ["linux", "macos"]

[[actions]]
id = "elsewhere"
title = "Another platform"
contexts = ["global"]
command = ["true"]
platforms = ["${process.platform === "linux" ? "macos" : "linux"}"]

[[panes]]
id = "board"
title = "Test board"
placement = "split"
command = ["sh", "-c", "exec sleep 600"]
platforms = ["linux", "macos"]
`);
    writeFileSync(join(root, "mark.sh"), `printf '%s' "$HERDR_PLUGIN_CONTEXT_JSON" > marker.json.tmp && mv marker.json.tmp marker.json\n`);
    await herdrRpc("plugin.link", { path: root });
    created = await workspaceCreate({ cwd: root, label: "ovis-test-plugin-actions" });
    server = createServer({ port: 0, stateDir });
    impatient = createServer({ port: 0, stateDir: impatientStateDir, pluginActionWaitMs: 300 });
  });

  afterAll(async () => {
    server?.stop();
    impatient?.stop();
    if (created) await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
    await herdrRpc("plugin.unlink", { plugin_id: PLUGIN }).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(impatientStateDir, { recursive: true, force: true });
  });

  it("lists each plugin with its enabled state and the actions this platform can run, without their command lines", async () => {
    const response = await fetch(`${base()}/api/plugins/actions`);
    expect(response.status).toBe(200);
    const { plugins } = (await response.json()) as PluginActionsResponse;
    const plugin = plugins.find((entry) => entry.plugin_id === PLUGIN)!;
    expect(plugin).toEqual({
      plugin_id: PLUGIN,
      name: "Web UI test actions",
      version: "0.1.0",
      description: "Linked by server/plugins.contract.test.ts",
      enabled: true,
      actions: [
        { action_id: "board", title: "Open board", description: null, contexts: ["workspace"] },
        { action_id: "fail", title: "Always fails", description: null, contexts: ["global"] },
        { action_id: "late", title: "Fails late", description: null, contexts: ["global"] },
        { action_id: "mark", title: "Write marker", description: "Writes its invocation context", contexts: ["pane"] },
        { action_id: "slow", title: "Slow, opens nothing", description: null, contexts: ["pane"] },
      ],
    });
  });

  it("runs an action with the named pane's workspace, tab and pane as its context, not herdr's focus", async () => {
    const paneId = created.root_pane.pane_id;
    expect((await sessionSnapshot()).focused_pane_id).not.toBe(paneId);
    const response = await invoke({ plugin_id: PLUGIN, action_id: "mark", pane_id: paneId });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ log_id: expect.any(String), status: "succeeded", exit_code: 0, output: null, opened_pane_id: null });
    expect(existsSync(marker)).toBe(true);
    const context = JSON.parse(readFileSync(marker, "utf8")) as Record<string, unknown>;
    expect(context).toMatchObject({
      workspace_id: created.workspace.workspace_id,
      workspace_label: "ovis-test-plugin-actions",
      tab_id: created.tab.tab_id,
      tab_label: created.tab.label,
      focused_pane_id: paneId,
      invocation_source: "ovis",
    });
  });

  // herdr fills what a context leaves out from its own focus: the checkout and the agent of
  // another workspace would reach an action run against this shell pane
  it("hands a shell pane outside a repository none of the worktree and agent herdr focuses elsewhere", async () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ovis-plugin-repo-")));
    const repo = join(scratch, "repo");
    const checkout = join(scratch, "checkout");
    for (const args of [["init", "-q", repo], ["-C", repo, "-c", "user.email=test@example.invalid", "-c", "user.name=test", "commit", "-q", "--allow-empty", "-m", "init"]]) {
      expect(Bun.spawnSync(["git", ...args]).exitCode).toBe(0);
    }
    const source = await workspaceCreate({ cwd: repo, label: "ovis-test-plugin-repo" });
    let elsewhere: WorktreeOpenResult | undefined;
    try {
      // focused on purpose: herdr's own focus is what this is about. A workspace only carries a
      // worktree once herdr made or opened one for its repository.
      elsewhere = await herdrRpc<WorktreeOpenResult>("worktree.create", { workspace_id: source.workspace.workspace_id, branch: "ovis-test-plugin", path: checkout, label: "ovis-test-plugin-focus", focus: true }, undefined, 60_000);
      const focused = elsewhere;
      await herdrRpc("pane.report_agent", { pane_id: focused.root_pane.pane_id, source: "manual", agent: "claude", state: "working" });
      await until(async () => {
        const snapshot = await sessionSnapshot();
        return snapshot.focused_pane_id === focused.root_pane.pane_id
          && snapshot.workspaces.find((entry) => entry.workspace_id === focused.workspace.workspace_id)?.worktree?.checkout_path === checkout
          && snapshot.panes.find((entry) => entry.pane_id === focused.root_pane.pane_id)?.agent === "claude";
      }, "herdr to focus an agent pane in a git worktree");
      const shell = (await sessionSnapshot()).panes.find((entry) => entry.pane_id === created.root_pane.pane_id)!;
      expect(shell.agent ?? null).toBeNull();
      rmSync(marker, { force: true });
      const response = await invoke({ plugin_id: PLUGIN, action_id: "mark", pane_id: shell.pane_id });
      expect(((await response.json()) as PluginActionResult).status).toBe("succeeded");
      const context = JSON.parse(readFileSync(marker, "utf8")) as Record<string, unknown>;
      expect(context).toMatchObject({
        workspace_id: created.workspace.workspace_id,
        workspace_label: "ovis-test-plugin-actions",
        focused_pane_id: shell.pane_id,
        focused_pane_agent: "",
        focused_pane_status: shell.agent_status,
        worktree: EMPTY_WORKTREE,
      });
      expect(JSON.stringify(context)).not.toContain(scratch);
    } finally {
      if (elsewhere) await herdrRpc("worktree.remove", { workspace_id: elsewhere.workspace.workspace_id, force: true }, undefined, 60_000).catch(() => undefined);
      await workspaceClose(source.workspace.workspace_id).catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("answers a command that failed with its exit code and its own words", async () => {
    const response = await invoke({ plugin_id: PLUGIN, action_id: "fail" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ log_id: expect.any(String), status: "failed", exit_code: 3, output: "boom", opened_pane_id: null });
  });

  it("says a command that outlasts the wait is running, and how it ended when asked again", async () => {
    const started = await fetch(`http://localhost:${impatient.port}/api/plugin/action`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ plugin_id: PLUGIN, action_id: "late" }) });
    expect(started.status).toBe(200);
    const running = (await started.json()) as PluginActionResult;
    expect(running).toEqual({ log_id: expect.any(String), status: "running", exit_code: null, output: null, opened_pane_id: null });
    const status = async (): Promise<PluginActionResult> => {
      const response = await fetch(`${base()}/api/plugin/action?plugin_id=${encodeURIComponent(PLUGIN)}&log_id=${encodeURIComponent(running.log_id)}`);
      expect(response.status).toBe(200);
      return (await response.json()) as PluginActionResult;
    };
    let ended = await status();
    await until(async () => (ended = await status()).status !== "running", "the late command to end");
    expect(ended).toEqual({ log_id: running.log_id, status: "failed", exit_code: 3, output: "boom", opened_pane_id: null });

    const unknown = await fetch(`${base()}/api/plugin/action?plugin_id=${encodeURIComponent(PLUGIN)}&log_id=plugin-log-none`);
    expect([unknown.status, ((await unknown.json()) as ApiError).error.code]).toEqual([404, "plugin_log_not_found"]);
    const bare = await fetch(`${base()}/api/plugin/action?plugin_id=${encodeURIComponent(PLUGIN)}`);
    expect([bare.status, ((await bare.json()) as ApiError).error.code]).toEqual([400, "missing_log_id"]);
  });

  it("takes no pane made in herdr while the command ran for the action's", async () => {
    const rootPane = created.root_pane.pane_id;
    const known = new Set((await pluginLogList(PLUGIN, 50)).map((entry) => entry.log_id));
    const pending = invoke({ plugin_id: PLUGIN, action_id: "slow", pane_id: rootPane });
    await until(async () => (await pluginLogList(PLUGIN, 50)).some((entry) => !known.has(entry.log_id) && entry.action_id === "slow" && entry.status === "running"), "the slow command to start");
    const split = await herdrRpc<{ pane: { pane_id: string } }>("pane.split", { target_pane_id: rootPane, direction: "right", focus: true });
    expect((await sessionSnapshot()).focused_pane_id).toBe(split.pane.pane_id);
    const result = (await (await pending).json()) as PluginActionResult;
    expect((await sessionSnapshot()).focused_pane_id).toBe(split.pane.pane_id);
    expect(result).toEqual({ log_id: expect.any(String), status: "succeeded", exit_code: 0, output: null, opened_pane_id: null });
  });

  // the action itself says where its pane goes: herdr's `plugin pane open` uses herdr's focus unless told
  it("names the pane an action opened and focused", async () => {
    const before = (await sessionSnapshot()).panes.map((pane) => pane.pane_id);
    const response = await invoke({ plugin_id: PLUGIN, action_id: "board", pane_id: created.root_pane.pane_id });
    expect(response.status).toBe(200);
    const result = (await response.json()) as PluginActionResult;
    expect(result.status).toBe("succeeded");
    expect(result.opened_pane_id).not.toBeNull();
    expect(before).not.toContain(result.opened_pane_id!);
    const opened = (await sessionSnapshot()).panes.find((pane) => pane.pane_id === result.opened_pane_id);
    expect(opened?.workspace_id).toBe(created.workspace.workspace_id);
  });

  it("refuses what it cannot run with herdr's own code, and a pane that is not there", async () => {
    const cases: [unknown, number, string][] = [
      [{ plugin_id: PLUGIN, action_id: "nope" }, 404, "plugin_action_not_found"],
      [{ plugin_id: "ovis-test.none", action_id: "mark" }, 404, "plugin_not_found"],
      [{ plugin_id: PLUGIN, action_id: "elsewhere" }, 404, "platform_unsupported"],
      [{ plugin_id: PLUGIN, action_id: "mark", pane_id: "w0:p0-gone" }, 404, "pane_not_found"],
      [{ plugin_id: PLUGIN }, 400, "missing_action_id"],
      [{ action_id: "mark" }, 400, "missing_plugin_id"],
      [{ plugin_id: PLUGIN, action_id: "mark", pane_id: 7 }, 400, "invalid_pane_id"],
      [[], 400, "invalid_body"],
    ];
    for (const [body, status, code] of cases) {
      const response = await invoke(body);
      expect([body, response.status]).toEqual([body, status]);
      expect(((await response.json()) as ApiError).error.code).toBe(code);
    }
    expect((await fetch(`${base()}/api/plugin/action`)).status).toBe(400);
    expect((await fetch(`${base()}/api/plugins/actions`, { method: "POST", headers: { "x-herdr-machine": "1" } })).status).toBe(400);
  });

  it("runs nothing for a page of another origin", async () => {
    rmSync(marker, { force: true });
    const response = await invoke({ plugin_id: PLUGIN, action_id: "mark", pane_id: created.root_pane.pane_id }, { origin: "https://elsewhere.example", "sec-fetch-site": "cross-site" });
    expect(response.status).toBe(403);
    expect(((await response.json()) as ApiError).error.code).toBe("invalid_origin");
    expect(existsSync(marker)).toBe(false);
  });

  it("lists a disabled plugin as disabled and passes on herdr's refusal to run it", async () => {
    await herdrRpc("plugin.disable", { plugin_id: PLUGIN });
    try {
      const { plugins } = (await (await fetch(`${base()}/api/plugins/actions`)).json()) as PluginActionsResponse;
      const plugin = plugins.find((entry) => entry.plugin_id === PLUGIN)!;
      expect(plugin.enabled).toBe(false);
      expect(plugin.actions.map((action) => action.action_id)).toEqual(["board", "fail", "late", "mark", "slow"]);
      const response = await invoke({ plugin_id: PLUGIN, action_id: "mark" });
      expect(response.status).toBe(404);
      expect(((await response.json()) as ApiError).error.code).toBe("plugin_disabled");
    } finally {
      await herdrRpc("plugin.enable", { plugin_id: PLUGIN });
    }
  });

  it("answers on the local PC's explicit alias as on the plain path", async () => {
    const listed = await fetch(`${base()}/api/machines/local/plugins/actions`);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as PluginActionsResponse).plugins.map((entry) => entry.plugin_id)).toContain(PLUGIN);
    const ran = await fetch(`${base()}/api/machines/local/plugin/action`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ plugin_id: PLUGIN, action_id: "fail" }) });
    expect(ran.status).toBe(200);
    const failed = (await ran.json()) as PluginActionResult;
    expect(failed).toMatchObject({ status: "failed", exit_code: 3, output: "boom" });
    const asked = await fetch(`${base()}/api/machines/local/plugin/action?plugin_id=${encodeURIComponent(PLUGIN)}&log_id=${encodeURIComponent(failed.log_id)}`);
    expect([asked.status, await asked.json()]).toEqual([200, failed]);
    // a POST without the app's header never reaches the route, and no other plugin path is aliased
    const bare = await fetch(`${base()}/api/machines/local/plugin/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plugin_id: PLUGIN, action_id: "fail" }) });
    expect([bare.status, ((await bare.json()) as ApiError).error.code]).toEqual([403, "invalid_origin"]);
    const other = await fetch(`${base()}/api/machines/local/plugin/link`, { method: "POST", headers: { "x-herdr-machine": "1" } });
    expect([other.status, ((await other.json()) as ApiError).error.code]).toEqual([400, "invalid_route"]);
  });

  it("is forwarded to a remote PC's bridge", () => {
    expect(MACHINE_PROXY_PATH.test("plugins/actions")).toBe(true);
    expect(MACHINE_PROXY_PATH.test("plugin/action")).toBe(true);
    expect(MACHINE_PROXY_PATH.test("plugin/link")).toBe(false);
  });
});
