/**
 * The workspace routes: a folder's listing and a new folder, a repository's changes, and the
 * workspaces, tabs and worktrees herdr makes, renames, moves and closes. They answer from herdr
 * and the disk; the dispatcher in index.ts runs the access gate first.
 */
import type { ServerContext } from "./dispatch.ts";
import { isAbsolute, resolve } from "node:path";
import { MAX_LABEL_CHARS } from "../shared/labels.ts";
import { MAX_INVENTORY_WORKSPACES, type WorktreeInventoryEntry } from "../shared/workspace-lifecycle.ts";
import { argumentText, firstMessageFault } from "../shared/launch-rules.ts";
import type { DirectoryCreated, PendingMessage, ServerMessage, TabMoved, TabMovedToWorkspace, WorkspaceMoved } from "../shared/protocol.ts";
import type { MoveReceipt } from "./order-sequence.ts";
import { agentFault, agentLaunch, type AgentPayload } from "./agent-launch.ts";
import { createDirectory, expandedDirectory, listDirectories } from "./directories.ts";
import { HerdrError, paneMoveToNewTab, sessionSnapshot, tabClose, tabCreate, tabMove, tabRename, workspaceClose, workspaceCreate, workspaceMove, workspaceRename, worktreeCreate, worktreeList, worktreeOpen, worktreeRemove } from "./herdr/client.ts";
import { badRequest, conflictResponse, errorResponse, isJsonObject, jsonResponse, readJsonObject, setRequestRoute } from "./http.ts";
import { paneContext } from "./pane-context.ts";
import { PullRequestError, mergeInputOf, mergePullRequest, pullRequestLog, pullRequestView } from "./pull-request.ts";
import { repoDiffResponse } from "./repo-diff.ts";
import { repoLogResponse } from "./repo-log.ts";
import type { ShellAgentLocator } from "./shell-agent.ts";

/**
 * The folder a repository route reads: the pane's own, or `directory` (absolute, `~/…`, or relative to
 * the pane's folder). A refusal in the API's envelope when there is none.
 */
async function routeFolder(paneId: string | null, directory: string): Promise<string | Response> {
  if (!paneId && directory === "") return badRequest("missing_directory", "pane_id or directory query parameter is required");
  let base: string | undefined;
  if (paneId) {
    try { base = (await paneContext(paneId)).cwd; } catch (error) {
      // a named folder is still read; the pane's own folder is gone with the pane
      if (directory === "") return errorResponse(error);
    }
  }
  let cwd = base;
  if (directory !== "") {
    const relative = directory !== "~" && !directory.startsWith("~/") && !isAbsolute(directory);
    if (relative && base === undefined) return badRequest("invalid_cwd", "a relative directory needs the pane it belongs to");
    cwd = expandedDirectory(relative ? resolve(base!, directory) : directory, [base === undefined ? null : resolve(base)]) ?? undefined;
  }
  return cwd ?? badRequest("invalid_cwd", "directory must be a directory this user can read");
}

/** the most variables a create request's `env` may set */
export const MAX_ENV_VARS = 64;
/** the most a create request's `env` may hold, its names and values in UTF-8 bytes */
export const MAX_ENV_BYTES = 32 * 1024;
/** an environment variable's name as a shell takes it in `NAME=value` */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * How long one inventory read keeps asking herdr: a workspace still unread then is answered as a timed-out
 * read, so a stalled herdr (10 s per call) cannot hold the answer past the request's 60 s idle limit.
 */
export const INVENTORY_BUDGET_MS = 30_000;

/**
 * What is wrong with a create request's `env`, in the API's words; null when herdr can set it (or there
 * is none). Values are text without control characters, a tab or line break included; the answer
 * never repeats a value, which may be a key.
 */
function envFault(env: unknown): string | null {
  if (env === undefined) return null;
  if (!isJsonObject(env)) return "env must be an object of names to string values";
  const entries = Object.entries(env);
  if (entries.length > MAX_ENV_VARS) return `env may set at most ${MAX_ENV_VARS} variables`;
  let bytes = 0;
  for (const [name, value] of entries) {
    // the name is quoted and cut: before this check it may hold anything
    if (!ENV_NAME.test(name)) return `env name ${JSON.stringify(name.slice(0, 64))} must be letters, digits and _, not starting with a digit`;
    if (typeof value !== "string" || !argumentText(value)) return `env.${name} must be a string without control characters`;
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
  }
  if (bytes > MAX_ENV_BYTES) return `env may hold at most ${MAX_ENV_BYTES} bytes`;
  return null;
}

/** a create request's first message the bridge could not queue for the agent that did start: its own refusal */
const notQueued = (error: unknown): { error: { code: string; message: string } } => ({ error: {
  code: typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : "first_message_not_queued",
  message: error instanceof Error ? error.message : String(error),
} });

/** The answer for a workspace route, or null when the path is not one. */
export async function handleWorkspaceRequest(request: Request, url: URL, pathname: string, bunServer: Pick<ServerContext, "timeout">, broadcastAll: (message: ServerMessage) => void,
  queueFirstMessage: (paneId: string, text: string, kind: string, requester: string | null, launchedPid: number | null) => Promise<PendingMessage>,
  /** a move herdr confirmed: its receipt in this server's order (server/order-sequence.ts), taken at once */
  workspaceMoved: () => MoveReceipt, shellAgents?: ShellAgentLocator,
  /** false: the folders are another machine's, which hc checks as it starts the shell there */
  localFolders = true): Promise<Response | null> {
  if (pathname === "/api/workspace/directories" && request.method === "POST") {
    setRequestRoute(pathname);
    let payload: unknown;
    try { payload = await request.json(); } catch { return badRequest("invalid_json", "request body must be JSON"); }
    if (!isJsonObject(payload) || typeof payload["path"] !== "string" || typeof payload["name"] !== "string") return badRequest("invalid_body", "path and name must be strings");
    let made;
    try { made = createDirectory(payload["path"], payload["name"]); } catch (error) { return errorResponse(error); }
    if ("path" in made) return jsonResponse({ path: made.path } satisfies DirectoryCreated, 201);
    if (made.error === "folder_exists") return conflictResponse("folder_exists", "a file or folder with that name is already there");
    if (made.error === "permission_denied") return jsonResponse({ error: { code: "permission_denied", message: "this user cannot make a folder there" } }, 403);
    return made.error === "invalid_cwd"
      ? badRequest("invalid_cwd", "path must be a directory this user can read")
      : badRequest("invalid_name", "name must be one folder name: not empty, `.` or `..`, without a slash, at most 255 bytes");
  }

  if (pathname === "/api/workspace/directories") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET or POST");
    // a folder a pane's chat names is read from that pane's folder, as a file it names is
    const paneId = url.searchParams.get("pane_id");
    let base: string | undefined;
    if (paneId) {
      try { base = (await paneContext(paneId)).cwd; } catch { /* an absolute path still lists */ }
      // a relative path whose pane is gone has no folder to be read from: not the server's own
      const path = (url.searchParams.get("path") ?? "").trim();
      if (base === undefined && path !== "" && path !== "~" && !path.startsWith("~/") && !isAbsolute(path)) return badRequest("invalid_cwd", "the pane a relative path belongs to is gone");
    }
    const listing = listDirectories(url.searchParams.get("path") ?? "", url.searchParams.get("hidden") === "1", url.searchParams.get("files") === "1", base);
    return listing === null ? badRequest("invalid_cwd", "path must be a directory this user can read") : jsonResponse(listing);
  }

  if (pathname === "/api/workspace/diff/files" || pathname === "/api/workspace/diff/file" || pathname === "/api/workspace/diff/refs") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    // file contents, like /api/fs/file: this app reads them, another site's page does not
    if (request.headers.get("sec-fetch-site") === "cross-site") return jsonResponse({ error: { code: "cross_site", message: "A repository's changes are read from this app" } }, 403);
    const cwd = await routeFolder(url.searchParams.get("pane_id"), (url.searchParams.get("directory") ?? "").trim());
    if (cwd instanceof Response) return cwd;
    return repoDiffResponse(pathname.endsWith("/files") ? "files" : pathname.endsWith("/refs") ? "refs" : "file", cwd, url.searchParams);
  }

  if (pathname === "/api/workspace/git/log" || pathname === "/api/workspace/git/branches" || pathname === "/api/workspace/git/show") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    // commit messages and branch names are the repository's contents, read like its changes
    if (request.headers.get("sec-fetch-site") === "cross-site") return jsonResponse({ error: { code: "cross_site", message: "A repository's history is read from this app" } }, 403);
    const cwd = await routeFolder(url.searchParams.get("pane_id"), (url.searchParams.get("directory") ?? "").trim());
    if (cwd instanceof Response) return cwd;
    return repoLogResponse(pathname.endsWith("/log") ? "log" : pathname.endsWith("/branches") ? "branches" : "show", cwd, url.searchParams);
  }

  // The branch's pull request, through this PC's own gh sign-in: read like the changes, merged only on a POST
  if (pathname === "/api/workspace/pr" || pathname === "/api/workspace/pr/log" || pathname === "/api/workspace/pr/merge") {
    setRequestRoute(pathname);
    const merging = pathname.endsWith("/merge");
    if (request.method !== (merging ? "POST" : "GET")) return badRequest("method_not_allowed", merging ? "use POST" : "use GET");
    // review comments and job logs are the repository's contents: this app reads them, another site's page does not
    if (request.headers.get("sec-fetch-site") === "cross-site") return jsonResponse({ error: { code: "cross_site", message: "A pull request is read from this app" } }, 403);
    let paneId = url.searchParams.get("pane_id");
    let directory = (url.searchParams.get("directory") ?? "").trim();
    let merge = null;
    if (merging) {
      const payload = await readJsonObject<Record<string, unknown>>(request);
      if (payload instanceof Response) return payload;
      merge = mergeInputOf(payload);
      if (merge === null) return badRequest("invalid_body", "number, head_oid (a full commit hash) and method (merge, squash or rebase) are required");
      paneId = typeof payload["pane_id"] === "string" ? payload["pane_id"] : null;
      directory = typeof payload["directory"] === "string" ? payload["directory"].trim() : "";
    }
    const cwd = await routeFolder(paneId, directory);
    if (cwd instanceof Response) return cwd;
    try {
      if (merge !== null) {
        await mergePullRequest(cwd, merge);
        return jsonResponse({ ok: true });
      }
      const body = pathname.endsWith("/log") ? await pullRequestLog(cwd, url.searchParams.get("job_id") ?? "", url.searchParams.get("host") ?? "github.com") : await pullRequestView(cwd);
      return jsonResponse(body, 200, { "cache-control": "private, no-store" });
    } catch (error) {
      if (error instanceof PullRequestError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
      return errorResponse(error);
    }
  }

  // A tab is made the way a workspace is: herdr opens it with a shell in its root pane, and
  // the agent (if any) starts there through the one launch path, so names, retries and a
  // partial failure read the same for both.
  if (pathname === "/api/workspace/create" || pathname === "/api/tab/create") {
    setRequestRoute(pathname);
    const inWorkspace = pathname === "/api/tab/create";
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const payload = await readJsonObject<{ workspace_id?: unknown; cwd?: unknown; label?: unknown; agent?: { kind?: unknown; name?: unknown; args?: unknown } | null; first_message?: unknown; first_message_connection?: unknown; env?: unknown }>(request);
    if (payload instanceof Response) return payload;
    if (inWorkspace && (typeof payload.workspace_id !== "string" || payload.workspace_id.trim() === "")) {
      return badRequest("missing_workspace_id", "workspace_id is required");
    }
    // the client sends null for "not given": treat it exactly like an absent field
    if (payload.cwd === null) delete payload.cwd;
    if (payload.label === null) delete payload.label;
    if (payload.agent === null) delete payload.agent;
    if (payload.first_message === null) delete payload.first_message;
    if (payload.env === null) delete payload.env;
    const envProblem = envFault(payload.env);
    if (envProblem !== null) return badRequest("invalid_env", envProblem);
    if (payload.cwd !== undefined && typeof payload.cwd !== "string") return badRequest("invalid_cwd", "cwd must be an existing directory");
    // the folder of a create request is one the user picked and sees: a share too
    const cwd = payload.cwd === undefined ? undefined : localFolders ? expandedDirectory(payload.cwd, "chosen") : payload.cwd;
    if (payload.cwd !== undefined && cwd === null) return badRequest("invalid_cwd", "cwd must be an existing directory");
    if (payload.label !== undefined && typeof payload.label !== "string") return badRequest("missing_label", "label must be a string");
    if (typeof payload.label === "string") {
      // a blank name is no name: herdr names the workspace after its folder, the tab by its number
      const label = payload.label.trim();
      if (label.length > MAX_LABEL_CHARS) return badRequest("label_too_long", `label must be at most ${MAX_LABEL_CHARS} characters`);
      if (label === "") delete payload.label;
      else payload.label = label;
    }
    const fault = agentFault(payload.agent);
    if (fault !== null) return badRequest("invalid_agent", fault);
    const messageFault = firstMessageFault(payload.first_message, payload.agent);
    if (messageFault !== null) return badRequest("invalid_first_message", messageFault);
    // the page connection that asked: the only one that may type the message on its own (server/core/pending.ts)
    const requester = payload.first_message_connection ?? null;
    if (requester !== null && (typeof requester !== "string" || requester.length === 0 || requester.length > 128)) {
      return badRequest("invalid_first_message", "first_message_connection must be the id of this page's connection");
    }
    // agent.start can legitimately take a minute; Bun's default idle timeout is shorter.
    if (payload.agent) bunServer.timeout(request, 75);
    try {
      const options = {
        ...(cwd === undefined || cwd === null ? {} : { cwd }),
        ...(typeof payload.label === "string" ? { label: payload.label } : {}),
        ...(payload.env === undefined ? {} : { env: payload.env as Record<string, string> }),
      };
      const created = inWorkspace
        ? await tabCreate({ ...options, workspaceId: payload.workspace_id as string })
        : await workspaceCreate(options);
      const workspaceId = created.tab.workspace_id;
      // the page selects the pane on this answer but draws it only once the roster lists it: the roster is read as
      // the answer goes, not after the collector's debounced pane.created (500 ms). Not before the launch either:
      // herdr answers calls made at once up to 250 ms late, and the launch makes its own.
      if (!payload.agent) {
        broadcastAll({ type: "session-changed" });
        return jsonResponse({ workspace_id: workspaceId, pane_id: created.root_pane.pane_id, agent_started: false });
      }
      // the process the launch brought up, when it says: the first message is bound to it
      let launchedPid: number | null = null;
      const launched = await agentLaunch(created.root_pane.pane_id, payload.agent, (pid) => { launchedPid = pid; }, shellAgents);
      // the request's first message is the user's send: queued for the agent's first ready turn through the
      // bridge's pending path (server/core/pending.ts), never typed here; an agent that did not start gets none
      const firstMessage = launched.agent_started && typeof payload.first_message === "string"
        ? await queueFirstMessage(created.root_pane.pane_id, payload.first_message, payload.agent.kind as string, requester, launchedPid).then((message): { id: string; held?: string } | ReturnType<typeof notQueued> => ({
          id: message.id,
          // held from the start (no page to type it, #2743): said, so a client tells it from a queued one
          ...(message.state === "held" && message.error ? { held: message.error.code } : {}),
        }), (error: unknown) => {
          console.warn(`first message for ${created.root_pane.pane_id} not queued: ${error instanceof Error ? error.message : String(error)}`);
          // the agent runs and the message did not go in: told apart from an agent that did not start (null)
          return notQueued(error);
        })
        : null;
      broadcastAll({ type: "session-changed" });
      return jsonResponse({ workspace_id: workspaceId, pane_id: created.root_pane.pane_id, ...launched, ...(typeof payload.first_message === "string" ? { first_message: firstMessage } : {}) });
    } catch (error) {
      return errorResponse(error);
    }
  }

  // A worktree is a git checkout herdr opens as a workspace grouped with its repository's.
  // The workspace names the repository; herdr finds the checkout root from its folder.
  if (pathname === "/api/worktree/list") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    const workspaceId = url.searchParams.get("workspace_id") ?? "";
    if (workspaceId === "") return badRequest("missing_workspace_id", "workspace_id is required");
    try {
      const listing = await worktreeList(workspaceId);
      return jsonResponse({ source: listing.source, worktrees: listing.worktrees });
    } catch (error) {
      return errorResponse(error);
    }
  }

  // The sidebar's branch labels: every repository and unmarked git workspace of this PC in one request
  // instead of one each (#2661). herdr is still asked once per workspace, one after another: four at once
  // left about one read in four waiting ~100 ms longer, where one at a time took ~22 ms for eight.
  if (pathname === "/api/worktree/inventory") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    const asked = url.searchParams.getAll("workspace_id");
    if (asked.length === 0 || asked.includes("")) return badRequest("missing_workspace_id", "workspace_id is required");
    const workspaceIds = [...new Set(asked)];
    if (workspaceIds.length > MAX_INVENTORY_WORKSPACES) return badRequest("too_many_workspaces", `at most ${MAX_INVENTORY_WORKSPACES} workspaces per read`);
    const entries: WorktreeInventoryEntry[] = [];
    const deadline = Date.now() + INVENTORY_BUDGET_MS;
    for (const workspaceId of workspaceIds) {
      // a client that left, or a herdr too slow to finish in time: the rest is not asked (the client keeps their last branches)
      if (request.signal.aborted || Date.now() >= deadline) {
        entries.push({ workspace_id: workspaceId, error: { status: 502, code: "timeout", message: "not read: the inventory ran out of time" } });
        continue;
      }
      try {
        const listing = await worktreeList(workspaceId);
        entries.push({ workspace_id: workspaceId, listing: { source: listing.source, worktrees: listing.worktrees } });
      } catch (error) {
        // the status and words GET /api/worktree/list would have answered for it alone
        const refused = errorResponse(error);
        const body = (await refused.json()) as { error: { code: string; message: string } };
        entries.push({ workspace_id: workspaceId, error: { status: refused.status, code: body.error.code, message: body.error.message } });
      }
    }
    return jsonResponse({ entries });
  }

  if (pathname === "/api/worktree/remove") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const payload = await readJsonObject<{ workspace_id?: unknown; force?: unknown }>(request);
    if (payload instanceof Response) return payload;
    if (typeof payload.workspace_id !== "string" || payload.workspace_id.length === 0) {
      return badRequest("missing_workspace_id", "workspace_id is required");
    }
    if (payload.force !== undefined && typeof payload.force !== "boolean") return badRequest("invalid_force", "force must be a boolean");
    // git can take a while to delete a large checkout; Bun's default idle timeout is shorter.
    bunServer.timeout(request, 75);
    try {
      const removed = await worktreeRemove(payload.workspace_id, payload.force === true);
      // herdr closed the worktree's workspace: tell clients now, as the workspace close route does
      broadcastAll({ type: "session-changed" });
      return jsonResponse({ ok: true, path: removed.path, forced: removed.forced });
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api/worktree/create" || pathname === "/api/worktree/open") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const payload = await readJsonObject<{ workspace_id?: unknown; branch?: unknown; base?: unknown; label?: unknown; path?: unknown; agent?: AgentPayload | null }>(request);
    if (payload instanceof Response) return payload;
    if (typeof payload.workspace_id !== "string" || payload.workspace_id.length === 0) {
      return badRequest("missing_workspace_id", "workspace_id is required");
    }
    // the client sends null for "not given": an empty string is not given either
    const text = (value: unknown, name: string): string | undefined => {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== "string") throw badRequest(`invalid_${name}`, `${name} must be a string`);
      const trimmed = value.trim();
      return trimmed === "" ? undefined : trimmed;
    };
    let branch: string | undefined, base: string | undefined, label: string | undefined;
    try {
      branch = text(payload.branch, "branch"); base = text(payload.base, "base"); label = text(payload.label, "label");
    } catch (response) {
      return response as Response;
    }
    if (label !== undefined && label.length > MAX_LABEL_CHARS) return badRequest("label_too_long", `label must be at most ${MAX_LABEL_CHARS} characters`);
    // a checkout path is taken as git names it, spaces and all
    let path: string | undefined;
    if (payload.path !== undefined && payload.path !== null) {
      if (typeof payload.path !== "string") return badRequest("invalid_path", "path must be a string");
      if (payload.path !== "") path = payload.path;
    }
    if (path !== undefined && !isAbsolute(path)) return badRequest("invalid_path", "path must be absolute");
    const creating = pathname === "/api/worktree/create";
    // a new checkout can start an agent in its pane, as a new workspace can; null is "not given"
    const agent = creating ? payload.agent ?? undefined : undefined;
    const fault = agentFault(agent);
    if (fault !== null) return badRequest("invalid_agent", fault);
    if (creating && branch === undefined) return badRequest("missing_branch", "branch is required");
    if (!creating && branch === undefined && path === undefined) return badRequest("missing_target", "path or branch is required");
    // a checkout of a large repository can take a while; Bun's default idle timeout is shorter.
    // and agent.start after it can take a minute more.
    if (creating) bunServer.timeout(request, agent ? 150 : 75);
    try {
      const asked = payload.workspace_id;
      const from = (workspaceId: string) => creating
        ? worktreeCreate({ workspaceId, branch: branch as string, base, label, path })
        : worktreeOpen({ workspaceId, path, branch, label });
      // herdr starts a worktree only from the workspace on the repository's main checkout. Asked
      // from a workspace on another checkout (herdr does not mark one it did not open as a
      // worktree, so the row offers the action), the call goes to that workspace when it is open.
      const opened = await from(asked).catch(async (error: unknown) => {
        if (!(error instanceof HerdrError) || error.code !== "linked_worktree_source") throw error;
        const parent = await worktreeList(asked).then((listing) => listing.source.source_workspace_id, () => null);
        if (!parent || parent === asked) throw error;
        return from(parent);
      });
      const launched = agent ? await agentLaunch(opened.root_pane.pane_id, agent, undefined, shellAgents) : {};
      // as for a new tab: the roster is read as the answer goes
      broadcastAll({ type: "session-changed" });
      return jsonResponse({
        workspace_id: opened.workspace.workspace_id,
        pane_id: opened.root_pane.pane_id,
        already_open: opened.already_open === true,
        path: opened.worktree.path,
        branch: opened.worktree.branch,
        ...launched,
      });
    } catch (error) {
      // git's own words for a branch that has no commit yet (a folder just `git init`ed): with no
      // base named there is nothing to check out from, which the dialog says in its own words
      if (creating && base === undefined && error instanceof HerdrError && error.code === "worktree_create_failed" && /invalid reference: HEAD\b/u.test(error.message)) {
        return conflictResponse("repository_without_commits", "the repository has no commits yet");
      }
      return errorResponse(error);
    }
  }

  if (pathname === "/api/workspace/rename" || pathname === "/api/workspace/move" || pathname === "/api/workspace/close") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const payload = await readJsonObject<{ workspace_id?: unknown; label?: unknown; insert_index?: unknown; close_group?: unknown }>(request);
    if (payload instanceof Response) return payload;
    if (typeof payload.workspace_id !== "string" || payload.workspace_id.length === 0) {
      return badRequest("missing_workspace_id", "workspace_id is required");
    }
    if (pathname === "/api/workspace/close" && payload.close_group !== undefined && typeof payload.close_group !== "boolean") {
      return badRequest("invalid_close_group", "close_group must be a boolean");
    }
    if (pathname === "/api/workspace/rename") {
      // herdr would keep an empty label, and the sidebar row would show no name
      const label = typeof payload.label === "string" ? payload.label.trim() : "";
      if (label === "") return badRequest("missing_label", "label is required");
      if (label.length > MAX_LABEL_CHARS) return badRequest("label_too_long", `label must be at most ${MAX_LABEL_CHARS} characters`);
      payload.label = label;
    }
    if (pathname === "/api/workspace/move" && (typeof payload.insert_index !== "number" || !Number.isInteger(payload.insert_index) || payload.insert_index < 0)) {
      return badRequest("invalid_index", "insert_index must be a non-negative integer");
    }
    try {
      if (pathname === "/api/workspace/rename") await workspaceRename(payload.workspace_id, payload.label as string);
      else if (pathname === "/api/workspace/move") {
        await workspaceMove(payload.workspace_id, payload.insert_index as number);
        return jsonResponse({ ok: true, ...workspaceMoved() } satisfies WorkspaceMoved);
      } else await workspaceClose(payload.workspace_id, undefined, payload.close_group === true);
      // a closed workspace's panes send no exit: without this, clients learn of it only after
      // the collector's structure debounce, and the closed workspace stays on screen meanwhile
      if (pathname === "/api/workspace/close") broadcastAll({ type: "session-changed" });
      return jsonResponse({ ok: true });
    } catch (error) {
      return errorResponse(error);
    }
  }

  // herdr moves tabs only within their workspace: a one-pane tab goes as its pane, into a new tab there
  if (pathname === "/api/tab/move-to-workspace") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const payload = await readJsonObject<{ tab_id?: unknown; workspace_id?: unknown }>(request);
    if (payload instanceof Response) return payload;
    if (typeof payload.tab_id !== "string" || payload.tab_id.length === 0) return badRequest("missing_tab_id", "tab_id is required");
    if (typeof payload.workspace_id !== "string" || payload.workspace_id.length === 0) return badRequest("missing_workspace_id", "workspace_id is required");
    try {
      const snapshot = await sessionSnapshot();
      const tab = snapshot.tabs.find((candidate) => candidate.tab_id === payload.tab_id);
      if (!tab) return jsonResponse({ error: { code: "tab_not_found", message: "no tab has that ID" } }, 404);
      if (tab.workspace_id === payload.workspace_id) return conflictResponse("same_workspace", "the tab is already in that workspace");
      const panes = snapshot.panes.filter((pane) => pane.tab_id === tab.tab_id);
      if (panes.length !== 1 || !panes[0]) return conflictResponse("multi_pane_tab", "only a tab with one pane can move to another workspace");
      // herdr names an unnamed tab by its place in the row, which it moves up when a tab before it
      // closes while the tab keeps its number (src/lib/tabName.ts): that name is not carried over
      const place = snapshot.tabs.filter((candidate) => candidate.workspace_id === tab.workspace_id).indexOf(tab) + 1;
      const named = tab.label.trim();
      const label = named === "" || named === String(place) ? null : named;
      const moved = await paneMoveToNewTab(panes[0].pane_id, payload.workspace_id, label);
      broadcastAll({ type: "session-changed" });
      return jsonResponse({ ok: true, pane_id: moved.pane.pane_id, tab_id: moved.pane.tab_id } satisfies TabMovedToWorkspace);
    } catch (error) {
      return errorResponse(error);
    }
  }

  // herdr's prefix+shift+t and prefix+shift+x: a tab's name, and a tab closed with every pane in it
  if (pathname === "/api/tab/rename" || pathname === "/api/tab/close" || pathname === "/api/tab/move") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const payload = await readJsonObject<{ tab_id?: unknown; label?: unknown; insert_index?: unknown }>(request);
    if (payload instanceof Response) return payload;
    if (typeof payload.tab_id !== "string" || payload.tab_id.length === 0) return badRequest("missing_tab_id", "tab_id is required");
    if (pathname === "/api/tab/move" && (typeof payload.insert_index !== "number" || !Number.isSafeInteger(payload.insert_index) || payload.insert_index < 0)) {
      return badRequest("invalid_index", "insert_index must be a non-negative safe integer");
    }
    try {
      if (pathname === "/api/tab/move") {
        const moved = await tabMove(payload.tab_id, payload.insert_index as number);
        broadcastAll({ type: "session-changed" });
        return jsonResponse({ ok: true, tabs: moved.tabs } satisfies TabMoved);
      }
      if (pathname === "/api/tab/rename") {
        // herdr would keep an empty label as the tab's name, and its own tab row would show nothing
        const label = typeof payload.label === "string" ? payload.label.trim() : "";
        if (label === "") return badRequest("missing_label", "label is required");
        if (label.length > MAX_LABEL_CHARS) return badRequest("label_too_long", `label must be at most ${MAX_LABEL_CHARS} characters`);
        await tabRename(payload.tab_id, label);
        // no pane event follows a rename, so the clients are told here
        broadcastAll({ type: "session-changed" });
      } else {
        // herdr emits pane.closed for the tab's panes, and the collector tells the clients
        await tabClose(payload.tab_id);
      }
      return jsonResponse({ ok: true });
    } catch (error) {
      return errorResponse(error);
    }
  }
  return null;
}
