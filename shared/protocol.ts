/**
 * Ovis's own HTTP/WebSocket contract, shared by the Bun server and the React client.
 *
 * The herdr WIRE types are NOT hand-written here: they are generated from herdr's
 * published API schema into ./herdr-api.generated.ts and re-exported below, so a
 * herdr upgrade shows up as a failing `bun run generate:types --check` instead of
 * types that quietly disagree with the server.
 *
 * HTTP responses and successful WebSocket handshakes carry X-Request-Id, a fresh
 * server UUID. A client's optional X-Request-Id (1-64 ASCII letters, digits, dot,
 * underscore or hyphen) is correlation data only, never the response's identity.
 * Same-origin API calls generate a client UUID unless explicitly supplied.
 * X-Content-Type-Options: nosniff and Referrer-Policy: no-referrer are absent-only
 * defaults; route CSP, framing, MIME, caching and compression policies still win.
 */

export type {
  AgentInfo,
  AgentSessionInfo,
  AgentStatus,
  PaneInfo,
  PaneLayoutPane,
  PaneLayoutRect,
  PaneLayoutSnapshot,
  PaneReadResult,
  PaneScrollInfo,
  ReadFormat,
  ReadSource,
  Subscription as HerdrSubscriptionSpec,
  TabInfo,
  WorkspaceInfo,
} from "./herdr-api.generated.ts";

import type { AgentStatus, PaneInfo, SessionSnapshot as HerdrSnapshot, TabInfo, WorkspaceInfo } from "./herdr-api.generated.ts";

/** GET /api/herdr-ui: the herdr client preferences of the PC serving the web UI, never the rest of its config. */
export interface HerdrUiConfig {
  copy_on_select: boolean;
}

/** Friendly aliases used across the UI. */
export type HerdrWorkspace = WorkspaceInfo;
export type HerdrTab = TabInfo;
/**
 * `background_tasks`: an OmO pane's `task` children, or a Claude Code pane's subagents and background commands, still running, counted by the server; absent when none.
 * `background_wait`: the pane is at rest while work its turn started still runs, and the turn goes on when it ends (server/background-wait.ts); absent when not.
 * `plan`: how far the pane's agent's task list or checklist has progressed; absent when it keeps none.
 */
export type HerdrPane = PaneInfo & {
  background_tasks?: number; background_wait?: true; plan?: PlanSummary;
  /** This bridge's counter of transitions into displayed DONE, scoped by finish_epoch. */
  finish_id?: number;
};
/** Missing finish fields on an older bridge mean no finish can be acknowledged here. */
export type SessionSnapshot = Omit<HerdrSnapshot, "panes"> & {
  panes: HerdrPane[];
  /** Random per bridge start and observed herdr socket/marker replacement, independently per PC. */
  finish_epoch?: string;
  /**
   * An opaque digest of the herdr this snapshot was read from (server/finishes.ts): the same across
   * server restarts, new once herdr itself is replaced and gives its pane IDs out again. Absent when
   * the read could not prove one herdr, and from older servers. A browser keeps each pane's drafts
   * and lens for the lifetime they were made in (src/lib/paneLifetime.ts).
   */
  herdr_lifetime?: string;
  /**
   * Workspace-order evidence of the server that read this snapshot (server/order-sequence.ts):
   * `order_epoch` is that server's `web_ui.boot_id`, and `read_seq` the number of workspace moves
   * it had confirmed when this read started. Both or neither; a snapshot without them comes from an
   * older server. Relays, caches and status patches carry the pair unchanged and never make one.
   */
  order_epoch?: string;
  read_seq?: number;
};
export type { WorkspaceMoved } from "./workspace-lifecycle.ts";

export type { DevicePairedEvent, Machine, MachineEvent, MachineRoster, PaneTarget, SetupJob, SetupRequest, SetupAction, BridgeIdentity, BridgeHealth } from "./machines.ts";

/** Machine API (same token gate; mutations require X-Herdr-Machine: 1 + same origin)
 * GET /api/health?scope=bridge -> BridgeHealth, never waits for herdr
 * GET /api/bridge -> authenticated BridgeIdentity (socket + runtime compatibility)
 * GET /api/machines -> MachineRoster { machines: Machine[] }; GET /api/machines/events -> MachineEvent SSE
 * GET /api/machines?verify_source_boot=:id -> MachineRoster with verified_source_boot { machine_id, boot_id }:
 *   the boot id of the server behind that PC, asked for during this request (the local one directly,
 *   a remote one by the manager's authenticated GET /api/health over its connection), never a cached
 *   answer. 400 for an empty or repeated query, 404 for an unknown PC, 503 source_unverified when no
 *   fresh proof came (failed, superseded, or a call already running when the request came), and 503
 *   with Retry-After: 1 when that PC's last health call started under a second ago. The manager runs
 *   at most one such call per PC at a time and starts them at least 1000 ms apart: that, not the
 *   client's coalescing or the 15 s deadline, is what bounds the load on a remote PC. The browser asks
 *   only after a workspace move's receipt when a roster names another epoch (src/lib/workspaceOrder.ts).
 *   An older server ignores the query and sends no verified_source_boot, which proves nothing.
 * Machine action_required=connect: a saved herdr PC awaits explicit POST /api/machines/setup before SSH.
 * Connection permission survives successful setup; installation/startup approval remains separate.
 * SetupJob/Machine action_required=bridge_conflict: align app versions, then retry setup without update_remote.
 * POST /api/machines/setup -> SetupJob; GET/POST/DELETE /api/machines/setup/:job_id
 * PATCH /api/machines/:id { name?, enabled? }; DELETE /api/machines/:id
 * /api/machines/:id/{session,agents,pane/*,workspace/*} -> existing target-local API
 * /ws?machine_id=:id -> immutable target, unchanged role + output ACK protocol
 * Legacy paths and missing machine IDs continue to mean local.
 */

/** HTTP API
 *  GET    /api/health                    -> { ok: true, herdr: HerdrIdentity (shared/machines.ts; terminal_attach false on a
 *                                          Windows herdr and on a bridge that cannot run the PTY sidecar; terminal_mirror: its
 *                                          terminal lens is the pane's screen, repainted; /api/bridge tells the same herdr), auth: HealthAuth,
 *                                          web_ui: { boot_id: string, revision: string | null },
 *                                          security?: SecuritySummary (authenticated only, no-store) } (boot_id: this server
 *                                          lifetime's id, the supervisor's when managed; older servers sent null unmanaged)
 *  GET    /api/session                   -> { snapshot: SessionSnapshot }
 *  GET    /api/herdr-ui                  -> HerdrUiConfig (this server PC's herdr [ui] copy_on_select,
 *         for local and remote panes alike), no-store
 *  GET    /api/access                    -> RemoteAccess (how a phone can reach this server: what
 *         Tailscale on this PC already serves, or the command to run), no-store
 *  GET    /api/portal                    -> PortalStatus (an optional public HTTPS address through
 *         Portal, server/portal.ts), no-store
 *  POST   /api/portal/start              -> 202 { accepted: true }; body { relay }; 400 invalid_relay,
 *         409 token_required / serve_only / portal_busy / portal_state_in_use / portal_unsupported
 *  POST   /api/portal/stop               -> 202 { accepted: true }; 409 portal_unsupported
 *         Portal POSTs require X-Herdr-Update: 1 and same-origin, like the update POSTs:
 *         403 invalid_portal_request (or invalid_origin from the outer origin gate).
 *         Unsupported methods/actions get 405 method_not_allowed; a watch-only device gets
 *         403 read_only. Startup holds HTTP/WS requests until leftover Portal cleanup completes;
 *         unreadable saved state or unverifiable cleanup fails closed with 500 internal_error.
 *  GET    /api/updates                   -> UpdateStatus (shared/update.ts), no-store; to the bridge
 *         token (which cannot read /api/access) also `port` and `serving_url`, where it answers
 *  POST   /api/updates/check             -> 202 { accepted: true }
 *  POST   /api/updates/install           -> 202 { accepted: true }; UpdateInstallRequest JSON body
 *         (at most 1 KiB): 400 invalid_update_install for a missing or malformed revision,
 *         409 update_restart_required where the supervisor does not advertise
 *         revision_bound_install, 409 update_offer_changed when the offer is no longer that
 *         revision. A release that moves after the 202 ends in UpdateStatus.error_code.
 *         Update POSTs require X-Herdr-Update: 1, same-origin browser requests,
 *         and the usual token gate. Managed starts only; status is polled during restart.
 *  POST   /api/connection-diagnostics    -> 204; ClientConnectionTrace, metadata only, same-origin
 *         and authenticated (watch devices included). 400 invalid_trace, 408 trace_timeout (the
 *         body took over 10 s to arrive), 413 trace_too_large, 429 trace_rate_limited. At most 16
 *         events and 8192 bytes; never input or credentials.
 *  GET    /api/telemetry                 -> TelemetryStatus (shared/telemetry.ts), no-store
 *  POST   /api/telemetry                 -> TelemetryStatus; TelemetryChange (shared/telemetry.ts):
 *         { enabled?, notice_seen?: true, notice_version?, settings? }. A notice acknowledgement
 *         requires the current NOTICE_VERSION. X-Herdr-Update: 1 and same-origin.
 *         404 from a server that sends no telemetry.
 *  GET    /api/agents                    -> { agents: AgentKind[] } (herdr's agent manifests: the
 *         kinds `agent.start` accepts, plus omo and gjc when they are on this server's PATH,
 *         each with `installed`: whether its command is on this server's PATH; for the
 *         new-session dialog)
 *  GET    /api/agent-catalog             -> AgentCatalogResponse (shared/agent-catalog.ts: every agent
 *         Ovis can install, with this PC's platform's official commands and whether each is
 *         installed here, at which version, read by running its version flag (5 s limit; kept until
 *         the executable file changes). Read only, no-store; a watch device may read it. A remote PC
 *         from before the endpoint answers 404 through /api/machines/<id>/agent-catalog)
 *  GET    /api/integrations              -> IntegrationsResponse (herdr's `integration.list`, in
 *         herdr's order; read only: nothing here installs or removes one, Settings shows the
 *         `herdr integration install` command instead)
 *  GET    /api/plugins/actions           -> PluginActionsResponse (plugin.list + plugin.action.list:
 *         every installed plugin with its enabled state and the manifest actions this PC's
 *         platform can run; herdr lists a disabled plugin's actions too, and refuses to run them)
 *  POST   /api/plugin/action { plugin_id, action_id, pane_id? } -> PluginActionResult
 *         (plugin.action.invoke. With pane_id the action gets that pane's whole context: herdr
 *         fills a field the caller left out from its OWN focus, not from the pane named, so what
 *         the pane does not have (an agent, a git checkout, a cwd) goes as empty strings, never
 *         left out. Without pane_id herdr uses its focus throughout. herdr answers as soon as the
 *         command started, so the server waits a few seconds for its log entry: `running` means it
 *         had not ended by then, and the GET below says how it ended. A failed command is a 200
 *         with status `failed`; a refused invoke is herdr's own error: plugin_not_found,
 *         plugin_action_not_found, plugin_disabled, platform_unsupported)
 *  GET    /api/plugin/action?plugin_id=&log_id= -> PluginActionResult (plugin.log.list: where the
 *         run a POST answered `running` for stands now; `log_id` is that answer's. 404
 *         plugin_log_not_found once herdr's log no longer holds it)
 *  GET    /api/sessions/history?workspace_id=&agent=&pane_id= -> SessionHistoryResponse (earlier
 *         sessions of one agent in the workspace's folder, newest first, from the agent's own store;
 *         at most 50. First messages are prompt text: a watch-only device gets 403 read_only. 400
 *         missing_workspace_id / invalid_agent / invalid_pane_id / pane_not_in_workspace, 404
 *         workspace_not_found, 409 no_folder. Claude with `pane_id`: the store of that pane's Claude,
 *         each row's resume carrying its `source`; 409 claude_store_unknown when it cannot be told)
 *  POST   /api/sessions/resume  SessionResumeRequest -> SessionResumeResponse (a listed Claude
 *         session started in the store it was listed from, or the workspace's pane that already
 *         shows it on that store. 403 read_only; 400 invalid_agent / invalid_session_id /
 *         invalid_store_key / pane_not_in_workspace; 404 workspace_not_found / session_not_found;
 *         409 stale_source / claude_store_unknown / launch_unsupported / no_folder, each before any
 *         tab is made)
 *  GET    /api/pane/read?pane_id=&source=&format=&lines=  -> { read: PaneReadResult }
 *         (pane.read. `lines` is herdr's uint32: an integer from 0 to 4294967295 written in
 *         plain decimal digits (leading zeros allowed). Left out it is left out of the RPC, and 0
 *         is sent as 0: herdr decides what either reads, the server adds no default or cap. Any
 *         other spelling (blank, signed, fractional such as 0.99999999999999999, exponent such
 *         as 1e3, non-finite) or a larger value is 400 invalid_lines before any RPC, whatever the
 *         pane; 400 missing_pane_id / invalid_source / invalid_format; an unknown pane is herdr's
 *         pane_not_found)
 *  GET    /api/pane/scroll?pane_id=      -> { scroll: PaneScrollInfo | null } (where the
 *         viewport sits: its top row in the history is max_offset_from_bottom - offset_from_bottom)
 *  POST   /api/pane/scroll { pane_id, offset_from_bottom } -> { scroll } (pane.scroll; herdr
 *         redraws every attached terminal)
 *  POST   /api/pane/find -> PaneFindResponse; PaneFindRequest searches literal text in herdr's
 *         stored history and scrolls the shared viewport to the match, unless jump:false only
 *         reads the native match window. No copy mode is entered. The answer includes at most
 *         1024 matches around the current result and the shared scroll position; total is exact.
 *         A previous match is reused only while content_revision still matches; 409 stale_content
 *         means output or the viewport changed during the read, so the user can search again.
 *  GET    /api/pane/selection?pane_id=&anchor_row=&anchor_col=&cursor_row=&cursor_col=
 *         -> { text } (pane.selection.read: both cells inclusive, rows from the top of the
 *         history, soft-wrapped lines joined; a terminal selection that outlives one screen)
 *  POST   /api/pane/input  { pane_id, text }   -> { ok: true }
 *  GET    /api/pane/conversation?pane_id=    -> ConversationResponse (structured agent
 *         transcript turns - claude, codex, omp, omo, gjc, pi, devin, OpenCode, hermes, grok or agy;
 *         source:"scrollback" when the pane has no recognized, readable store.
 *         Copilot page reads that fail while fresh ownership, file generation and the requested
 *         history_id (or bound cursor) still match answer 503 conversation_read_pending:
 *         retain the displayed view and retry, not fallback. A mismatched history_id answers 409.
 *         Grok requires exact live process/session evidence, Agy live process/session evidence;
 *         rewinds invalidate cursors.
 *         Grok/Agy optional activity describes the latest native turn, independently of pane status.)
 *  POST   /api/pane/close { pane_id }         -> { ok: true } (pane.close RPC; the collector's
 *         session-changed broadcast removes it from every client's sidebar)
 *  POST   /api/pane/rename { pane_id, label } -> { ok: true } (pane.rename; empty label clears it)
 *  POST   /api/pane/focus { pane_id } -> { ok: true } (pane.focus: herdr brings its workspace,
 *         tab and pane to the front, also while the tab is zoomed)
 *  POST   /api/agent/rename { pane_id, name } -> { ok: true } (agent.rename on the pane's live agent:
 *         the name other tools address it by, `herdr agent prompt <name>`; null clears it. herdr
 *         owns the rule (shared/agent-name.ts) and answers invalid_agent_name, agent_name_taken or,
 *         for a pane without a live agent, agent_not_found; the name is read back from
 *         `snapshot.agents[].name`, and pane.updated carries the change to every client)
 *  POST   /api/pane/split  { pane_id, direction: right|down, focus? } -> PaneSplit { ok: true, pane }
 *         (pane.split beside that pane, herdr's prefix+v and prefix+-: `pane` is the new one; focus
 *         false, the default, leaves herdr's focus where it is, true moves it to the new pane as --focus does)
 *  POST   /api/pane/zoom   { pane_id, mode?: toggle|on|off } -> PaneZoomed { ok: true, zoomed, changed, reason }
 *         (pane.zoom, prefix+z: the tab shows that pane alone; herdr focuses the pane it zooms; changed
 *         false names why: single_pane, already_zoomed, already_unzoomed)
 *  POST   /api/pane/swap   { pane_id, direction: left|right|up|down } OR { pane_id, target_pane_id }
 *         -> PaneSwapped { ok: true, changed, reason, target_pane_id } (pane.swap with the neighbour
 *         on that side, prefix+shift+hjkl, or an explicit pane; exactly one destination is required;
 *         changed false names no_neighbor, same_pane, cross_tab or not_found)
 *  POST   /api/pane/resize { pane_id, direction: left|right|up|down, amount? } -> PaneResized { ok: true, changed, reason }
 *         (pane.resize, herdr's resize mode: the border the pane shares with a neighbour moves that way
 *         by `amount` of the split the border belongs to, not of the tab (0 < amount <= 0.5, herdr's
 *         own cap; its 0.05 when absent); changed false, reason unchanged, when no border of the
 *         pane can move that way)
 *  POST   /api/pane/clear  { pane_id } -> { ok: true } (pane.clear: clears the pane's terminal screen)
 *  POST   /api/layout/ratio { tab_id, path: boolean[], ratio } -> { ok: true }
 *         (layout.set_split_ratio: a split in that tab, root at [], false follows the first child,
 *         true the second; finite ratio in 0.1..0.9; an absent split answers split_not_found)
 *  POST   /api/pane/image  { pane_id, content_type, data_base64, name? } -> { ok: true, path }
 *         pasted image -> file under <pane cwd>/.ovis/ (under OVIS_PASTE_DIR when the
 *         server's environment sets it), path for the prompt. An image/png, image/jpeg, image/gif or
 *         image/webp upload is named paste-<stamp>.<png|jpg|gif|webp> after the signature of its
 *         bytes, whichever of the four it claims; bytes with none of those signatures answer 400
 *         invalid_image ("file does not contain a supported raster image", never the upload's name
 *         or content) before the pane is looked up or anything is written. A signature check, not
 *         a decode. Any other type keeps its sanitised `name` (.bin without a usable extension).
 *         empty_image 400 and image_too_large 413 are checked first.
 *  GET    /api/pane/commands?pane_id=   -> { commands: SlashCommand[] } (the agent's slash
 *         commands: built-ins per agent kind + the user's and the project's custom commands)
 *  GET    /api/pane/omo-tasks?pane_id=  -> OmoActivity (the background tasks and workflows the
 *         pane's OmO session started, or a Claude Code pane's subagents (no workflows): running ones, then
 *         those that ended in the last day; empty for any other pane or one whose session is not
 *         known yet. server_time: that PC's clock, which the times are on)
 *  GET    /api/pane/plan?pane_id=       -> PanePlan (the plan the pane's Claude Code, Codex or OmO session
 *         keeps: its task list or checklist, read from the transcript; null when it keeps none)
 *  GET    /api/pane/files?pane_id=&q=&limit=  -> { files: string[] } (paths relative to the pane
 *         cwd matching q, for @-mentions; git ls-files when the cwd is a repo, bounded walk otherwise)
 *  GET    /api/workspace/diff/files?pane_id=&directory=&scope=&base=&head= -> RepoDiffFileList
 *         (what changed in the git repository the pane's folder, or `directory`, is inside: read
 *         only, on the PC that owns the pane. `directory` is absolute, `~/…`, or relative to the
 *         pane's folder; one of pane_id and directory is required. scope: workspace (the default:
 *         working tree against the index, plus untracked files), staged (index against HEAD),
 *         commit (`base` against `head`, HEAD when absent; each one commit) or branch (the working
 *         tree, untracked files included, against the merge base of `base` and HEAD: what this
 *         branch changed, never what `base` went on to change; `base` is required, `head` is not
 *         taken). The list is capped (`limits`), and `truncated` says when it was. 400
 *         invalid_scope / invalid_revision / invalid_cwd / missing_directory, 404
 *         revision_not_found, 409 not_a_repository / unborn_head (branch: no commit to compare
 *         from) / no_common_ancestor (branch: `base` and HEAD share no history; nothing is
 *         compared in its place), 503 git_unavailable, 504 git_timeout; 403 read_only for a
 *         watching device, as a file read)
 *  GET    /api/workspace/diff/file?pane_id=&directory=&scope=&base=&head=&comparison=&path=&old_path=
 *         -> RepoDiffFilePatch (one file of that comparison as a standard `diff --git` unified
 *         patch; `path` and, for a rename, `old_path` are the list's own, relative to the
 *         repository root. The patch is whole or null: `unavailable` says why it is null, and no
 *         cut hunk is ever sent. 400 invalid_path, 404 not_found when nothing changed there. In
 *         the branch scope `comparison` carries the list's RepoBranchComparison as JSON instead of
 *         `base`: the patch is read from its pinned merge base, so a base branch that moved on
 *         changes nothing, and 409 comparison_changed says the repository or HEAD is no longer
 *         the one listed (refresh the list); 400 invalid_comparison for one of another shape)
 *  GET    /api/workspace/diff/refs?pane_id=&directory= -> RepoDiffRefs (the local and remote
 *         branches of that repository, as full refnames with their commits, for choosing a base:
 *         at most `limits.max_refs`, sorted, a remote's symbolic HEAD left out; nothing is fetched)
 *  GET    /api/pane/prompt?pane_id=     -> PanePromptResponse
 *         (the agent's TUI question/approval menu currently on screen, parsed from the visible pane
 *         text; with no menu, the next prompt Claude Code suggests, grey in its empty input box, and
 *         `restored`: the chat's last message when Claude Code put it back as typed text in that box,
 *         as it does for a send cancelled before any reply; older servers send neither)
 *  POST   /api/pane/prompt/answer { pane_id, prompt_id, option_index?, option_indices?, custom_text? }
 *         -> { ok: true } | 409 prompt_changed (the screen no longer shows that prompt)
 *  POST   /api/workspace/create { cwd?, label?, agent?: { kind, name?, args? } }
 *         -> WorkspaceCreated (workspace.create, then agent.start in the root pane when `agent` is given;
 *         omo and gjc, which herdr cannot start, are typed into the root pane's shell)
 *  POST   /api/tab/create { workspace_id, cwd?, label?, agent?: { kind, name?, args? }, first_message?, first_message_connection? }
 *         -> TabCreated (tab.create in that workspace, then the same agent launch in the tab's root
 *         pane; without cwd herdr uses the workspace's folder, without label the tab's number)
 *         Both creates trim `label`; a blank one counts as not given, one over MAX_LABEL_CHARS
 *         (shared/labels.ts) is refused with 400 label_too_long.
 *  POST   /api/tab/rename { tab_id, label } -> { ok: true } (tab.rename; an empty label is refused:
 *         herdr would keep it as the name; over MAX_LABEL_CHARS: 400 label_too_long)
 *  POST   /api/tab/move { tab_id, insert_index } -> TabMoved
 *         (tab.move: an insertion boundary in the original workspace tab order, 0..tab count;
 *         preserves the active tab/pane and returns the authoritative workspace tab order)
 *  POST   /api/tab/move-to-workspace { tab_id, workspace_id } -> TabMovedToWorkspace (pane.move of
 *         the tab's one pane into a new tab at the end of that workspace, its label and process
 *         kept, herdr's focus unchanged; the pane gets a new ID, and the tab, or a workspace, it
 *         leaves empty closes. 409 multi_pane_tab for a split tab, 409 same_workspace)
 *  POST   /api/tab/close  { tab_id } -> { ok: true } (tab.close: every pane in the tab closes, and
 *         a workspace's last tab takes the workspace with it)
 *  POST   /api/workspace/rename { workspace_id, label } -> { ok: true } (trimmed; empty: 400
 *         missing_label, over MAX_LABEL_CHARS: 400 label_too_long)
 *  POST   /api/workspace/move   { workspace_id, insert_index } -> WorkspaceMoved (sidebar reorder; the receipt's
 *         order_epoch/moved_seq let the browser keep its order until a snapshot read after the move arrives)
 *  POST   /api/workspace/close  { workspace_id, close_group? } -> { ok: true } (close_group takes the
 *         repository's open worktree workspaces with it; without it herdr refuses: workspace_group_close_required)
 *  POST   /api/worktree/create { workspace_id, branch, base?, label?, path?, agent?: { kind, name?, args? } } -> WorktreeOpened
 *         (worktree.create: a git worktree of that workspace's repo, checked out under herdr's
 *         worktree directory unless `path` says where, and opened as a new workspace grouped with it;
 *         409 repository_without_commits when no base is named and the repository has no commit yet;
 *         both worktree routes refuse a label over MAX_LABEL_CHARS with 400 label_too_long)
 *  GET    /api/worktree/list?workspace_id= -> WorktreeListing (worktree.list: the repo's checkouts)
 *  POST   /api/worktree/open   { workspace_id, path | branch, label? } -> WorktreeOpened
 *         (worktree.open: an existing checkout as a workspace; already_open names the one it has)
 *  POST   /api/worktree/remove { workspace_id, force? } -> WorktreeRemoved (worktree.remove: deletes the
 *         checkout and closes its workspace, keeps the branch; a dirty checkout is refused without force:
 *         dirty_worktree_requires_force)
 *  POST   /api/auth        { token }     -> 204 + Set-Cookie ovis_token (401 invalid_token on mismatch)
 *  DELETE /api/auth                      -> 204, clears the token and the device cookies
 *  GET    /api/devices                   -> { devices: PairedDevice[] } (the paired devices; `current` marks the caller's)
 *  POST   /api/devices/pair/start        -> PairingCode: a six-digit code good for ten minutes, replacing any pending one
 *         (X-Herdr-Machine: 1 + same origin, from a client with full access)
 *  POST   /api/devices/pair { code, label? } -> 204 + Set-Cookie ovis_device (public, like /api/auth;
 *         401 invalid_code when the code is wrong, spent after five tries, or expired)
 *  PATCH  /api/devices/:id  { label }    -> PairedDevice;  DELETE /api/devices/:id -> 204 (revoked at its next request)
 *  POST   /api/devices/revoke-all        -> DevicesRevokedAll + Set-Cookie clearing ovis_device and its old name
 *         (X-Herdr-Machine: 1 + same origin, a client that can drive: 403 invalid_origin / read_only;
 *         500 internal_error when the write fails, and then nothing was revoked)
 *  GET    /api/push                      -> PushKey (the VAPID application server key)
 *  POST   /api/push/subscribe { subscription }  -> 204 (a browser PushSubscription JSON; upsert by endpoint;
 *         a browser without a stream key is issued one: "Browser stream keys" below)
 *         | 410 subscription_gone (its push service answered 404/410 for that endpoint since the server
 *         started: the browser must unsubscribe and subscribe anew; an older server never says it)
 *  DELETE /api/push/subscribe { endpoint }      -> 204
 *  POST   /api/push/test      { endpoint }      -> 204 | 404 subscription_not_found | 410 subscription_gone | 502 push_failed
 *  POST   /api/push/status    { subscription }  -> PushSubscriptionStatus: this browser's own subscription (its JSON, never an
 *         endpoint in a URL or a list); 404 subscription_not_found alike for an unknown one, another owner's
 *         and one whose keys do not match, so nothing is enumerated; 403 status_unavailable to the open LAN, which
 *         signs in as no device and so owns no record (asked before any subscription is looked at)
 *  GET    /api/usage[?refresh=1]         -> UsageReport (plan limits of the AI subscriptions signed in on this PC)
 *  Errors: non-2xx with { error: { code, message } }
 *
 *  Access: every route above except /api/health, /api/auth and /api/devices/pair, plus the
 *  /ws upgrade, needs the request to be one of: from this PC itself (no proxy in front);
 *  the PC's own Tailscale login, as `tailscale serve` states it — or, where
 *  OVIS_TAILSCALE_SERVE_ONLY=1 declares serve the only ingress on a tailnet one login
 *  owns with no tagged node, a serve request that states no login; a paired device's cookie;
 *  the shared token (OVIS_TOKEN) as cookie or `Authorization: Bearer <token>`. With a
 *  token configured, only the last two count, this PC and its Tailscale login included. Without one, and while no
 *  device is paired, anything that reaches the server is let in as before (the startup
 *  warning says so). Refusals answer 401 `unauthorized` (403 `other_user` for another Tailscale
 *  login, when no token is configured); the upgrade is refused. Static files are always public.
 */
export interface ApiError {
  error: { code: string; message: string };
}

export type { PaneFindMatch, PaneFindRequest, PaneFindResponse } from "./find.ts";

export type { UsageProviderId, UsageWindow, UsageProblem, ProviderUsage, UsageReport } from "./usage.ts";

export type { CLIProxyStatus, CLIProxyProvider, CLIProxyLogin, CLIProxyLoginStatus } from "./cliproxy.ts";

export type { AccessVia, AccessRefusal, DeviceRole, HealthAuth, LanExposure, BindScope, ObservedIngress, SecuritySummary, PairedDevice, PairingCode, RemoteAccess, TailscaleAccess } from "./access.ts";

/**
 * Browser stream keys: how the server tells one browser from another without a credential, so a
 * device a browser pairs itself is not announced back to it (`DevicePairedEvent`, and the push
 * "New device paired" notice).
 *
 * - Issuance: an answer to GET /api/machines/events or POST /api/push/subscribe that is served
 *   (2xx) to a request carrying no valid key adds one: `Set-Cookie: ovis_stream_<key>=1;
 *   Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000` (plus `Secure` over https), `<key>` 32
 *   lowercase hex characters from 16 random bytes. A request that carries one is issued nothing.
 * - Format: the key is in the cookie's NAME and the value is always `1`. Tabs that open at once,
 *   before the browser held a key, each get one; since the names differ the browser keeps them
 *   all, and every later request carries every key. At most eight are read from one request. A
 *   cookie with the prefix whose key is not 32 lowercase hex, or whose value is not `1`, is not a
 *   key and is ignored (never refused); a request with none is treated as a browser without one.
 * - Lifetime: one year, like the device cookie, so a push subscription and the browser that made
 *   it keep matching. Nothing revokes a key: it names a browser and grants nothing.
 * - No authority: a key never lets a request in, never selects an owner or a role, and is not read
 *   by the gate. Losing one only means that browser may hear of its own next pairing.
 * - Role in POST /api/devices/pair: the keys the pairing request carries are the enrollment's
 *   origin (kept with a first-pair credential until its first return). The `device-paired` event
 *   then skips every machines event stream opened with one of those keys, and the push notice
 *   skips every subscription registered with one, whatever access it came through (token, this
 *   PC, Tailscale or a paired device).
 */
export const STREAM_COOKIE_PREFIX = "ovis_stream_";

export type { PortalStatus } from "./portal.ts";

/**
 * POST /api/devices/revoke-all: every paired device lost its pairing access in one durable write,
 * the caller's own included (its device cookie is cleared by the answer). Only pairing ends: the
 * access token, this PC itself and the PC's Tailscale login get in as before, and the gate stays
 * closed to strangers.
 */
export interface DevicesRevokedAll {
  /** how many devices were paired before */
  readonly revoked: number;
}

export type { PushDeliveryFailure, PushKey, PushPayload, PushSubscriptionStatus } from "./push.ts";

/** One turn of a structured agent conversation (the chat lens source). */
export interface ConversationTurn {
  role: "user" | "assistant";
  ts: string | null;
  /** Last recorded assistant activity, never the next user's timestamp. */
  end_ts?: string;
  parts: ConversationPart[];
}

/** Evidence of skill activity, not a claim that the skill's workflow completed. */
export interface SkillActivity {
  name: string;
  evidence: "invocation" | "instructions";
  status: "requested" | "loaded" | "failed";
  path?: string;
}

export type ConversationPart =
  | { kind: "text"; text: string; phase?: "commentary" | "final_answer" }
  /** the agent's reasoning block; the client folds it and shows it only on request */
  | { kind: "thinking"; text: string }
  | { kind: "skill"; skill: SkillActivity }
  /** `error`: the call failed (the agent recorded it so, or its output says a command exited non-zero) */
  | {
    kind: "tool"; name: string; summary: string; input: string; output: string; error?: boolean;
    /** Hermes could not load a tool-call list whose arguments exceeded its page limit. */
    arguments_omitted?: true;
    skill?: SkillActivity;
    /** set when `output` was cut: an opaque ref for GET /api/pane/conversation/tool-output, and the whole output's length */
    output_ref?: string; output_size?: number;
    /** images the call returned (pi reads a picture into the result); same fetch as a user image */
    images?: { media_type: string; ref: string }[];
    /** the agent's own id for the call (Claude `tool_use.id`, Codex `call_id`, gjc `toolCall.id`); absent from other agents and older servers */
    call_id?: string;
    /**
     * What the transcript itself records of the call's outcome, never guessed from its output text.
     * Claude: `pending` until its tool_result, then `ok`, or `error` when the result is flagged so.
     * Codex: `pending` until its output record, then absent (it records no failure flag: done, outcome
     * unknown). Absent for other agents and older servers.
     */
    state?: "pending" | "ok" | "error";
  }
  /** A native Claude/Codex user image, addressed by an opaque ref and fetched on demand: GET /api/pane/conversation/image?pane_id=…&ref=… */
  | { kind: "image"; media_type: string; ref: string }
  /** the summary a compaction left; the conversation before it is what it sums up */
  | { kind: "compact"; text: string }
  /** a message the agent's runtime put in the user's seat (gjc's background-job result): it starts a turn, nobody typed it.
   * `source`: the runtime's name for it (pi's customType, e.g. "async-result", "irc:incoming", "omo-model-profile:unavailable") */
  | { kind: "notice"; text: string; source?: string }
  /** a shell command the user ran without the model (Claude Code's `!` bash mode), and what it printed: no stdout or
   * stderr until the agent records them */
  | { kind: "shell"; command: string; stdout?: string; stderr?: string }
  /** OmO's background tasks that ended, as OmO reported them back to the agent, or a Claude Code subagent that ended (its task notification): it starts a turn, nobody typed it */
  | { kind: "task_result"; tasks: OmoTaskResult[] };

/** One OmO background task that ended (the `senpi-task.completion` OmO wakes its agent with). */
export interface OmoTaskResult {
  id: string;
  /** the summary the `task` call gave it, else its name, else the agent it ran as, else its id */
  title: string;
  /** the agent type or category it ran as */
  agent: string | null;
  model: string | null;
  /** `failed`: OmO reported an error (its `result` says which) */
  status: "completed" | "failed" | "cancelled";
  duration_ms: number | null;
  turns: number | null;
  tool_calls: number | null;
  tokens: number | null;
  /** the task's last answer, or why it failed; at most 16,000 characters, `result_cut` when there was more */
  result: string;
  result_cut?: boolean;
}

/** Latest model settings actually recorded by this agent. */
export interface ConversationMetadata {
  model: string | null;
  /** Recorded reasoning effort / thinking level; null means not reported. */
  reasoning_effort: string | null;
  /**
   * How much of the model's context the last request filled, in tokens; absent until a
   * response reports its usage. `window` is null when the transcript does not say it.
   */
  context?: { used: number; window: number | null };
}

export type { OmoTask, OmoRunNode, OmoRun, OmoActivity, PaneBackgroundAgentDetail } from "./tasks.ts";

export type { PlanStep, PanePlan } from "./plans.ts";

/** How far a pane's plan has got, for the sidebar: `current` names the step in progress. */
export interface PlanSummary {
  done: number;
  total: number;
  current: string | null;
}

/**
 * GET /api/pane/conversation: native conversation with settings, or scrollback fallback.
 * A refresh may echo history_id as a query parameter to identify the view it would retain on failure.
 */
export interface ConversationResponse {
  /** Grok/Agy latest native turn; display feedback only, never input-delivery authority. */
  activity?: "thinking" | "working" | "idle";
  /** Stable across appends; changes on transcript replacement or native context clear. */
  history_id?: string;
  source: "copilot-transcript" | "grok-transcript" | "agy-transcript" | "muse-transcript" | "letta-transcript" | "claude-transcript" | "omp-transcript" | "omo-transcript" | "gjc-transcript" | "pi-transcript" | "cmd-transcript" | "codex-transcript" | "devin-transcript" | "opencode-transcript" | "hermes-transcript" | "scrollback";
  turns: ConversationTurn[];
  metadata?: ConversationMetadata;
  /**
   * `metadata` was read off the agent's own screen: a conversation not begun, or a Codex that has
   * reported no session (whose scrollback answer carries `metadata` only so). No file records it
   * and the pane's output can change it, so the chat re-reads on terminal output.
   */
  screen?: true;
  /**
   * Where the first turn sits in the transcript: pass it as `before` for the page
   * of turns before these (with `since`, never reaching back past that cursor), or
   * as `from` to keep polling from it. A `from` answer starts later than `from` when
   * the newest page has moved past it: the turns in between come from `before` +
   * `since`. null at the conversation's beginning; absent for scrollback and from
   * bridges without pages. A cursor the transcript no longer knows answers 409
   * `history_changed`.
   */
  cursor?: string | null;
  /**
   * Turns the transcript holds on paths a `/tree` walked away from, which no page of this
   * conversation can reach. pi moves its leaf pointer without writing an entry, so those turns
   * would otherwise leave the chat with no sign they were ever there. `summary` is pi's own account
   * of the abandoned path, kept when the user answered `/tree`'s "Summarize branch?" with one.
   * `branches` is how many separate paths were left behind — the places a live entry was given a
   * child that is not live — because the count alone reads the same for one abandoned path of four
   * turns and two of two, and the reader pluralizes on it. A session no `/tree` touched answers
   * zeroes — drawn as nothing — since zero and "unknown" are different answers. Absent for every
   * agent that keeps no entry tree.
   */
  abandoned?: { count: number; branches: number; summary: string | null };
}

export type { PluginActionContext, PluginAction, PluginActions, PluginActionsResponse, PluginActionRequest, PluginActionResult } from "./plugins.ts";

export type { DirectoryListing, CreateDirectoryRequest, DirectoryCreated } from "./directories.ts";

export type { FileKind, FileInfo, ProjectFavicon } from "./files.ts";

export type { RepoDiffScope, RepoBranchComparison, RepoDiffRefs, RepoDiffStatus, RepoDiffRepository, RepoDiffFile, RepoDiffFileList, RepoDiffFilePatch } from "./repo-diff.ts";

export type { AgentKind } from "./agents.ts";

export type { AgentIntegration, IntegrationsResponse } from "./integrations.ts";

export type { CreateWorkspaceRequest, MoveTabRequest, TabMoved, MoveTabToWorkspaceRequest, TabMovedToWorkspace, CreateTabRequest, CreateWorktreeRequest, OpenWorktreeRequest, WorktreeOpened, RemoveWorktreeRequest, WorktreeRemoved, WorktreeEntry, WorktreeListing, WorkspaceCreated, TabCreated } from "./workspace-lifecycle.ts";

/** POST /api/agent/rename: the live name of the agent in the pane; null clears it. */
export interface AgentRenameRequest {
  pane_id: string;
  name: string | null;
}

export type { SplitPaneDirection, PaneDirection, SplitPaneRequest, PaneSplit, ZoomPaneRequest, PaneZoomed, FocusPaneRequest, SwapPaneRequest, PaneSwapped, ResizePaneRequest, PaneResized, SetSplitRatioRequest } from "./pane-layout.ts";

/** GET /api/pane/commands: one slash command the pane's agent understands. */
export interface SlashCommand {
  /** without the leading slash (or `$`) */
  name: string;
  description: string;
  source: "builtin" | "user" | "project" | "skill" | "plugin";
  /** `$`: typed as `$name` (Codex skills); `@`: typed as `@name`; otherwise `/name` */
  trigger?: "$" | "@";
  /**
   * where a skill comes from, for every agent: `user` is the person's own (the agent's own
   * directory or ~/.agents/skills), `project` the checkout's, `bundled` ships with the agent,
   * `plugin` comes with one of its plugins
   */
  origin?: "user" | "project" | "bundled" | "plugin";
  /** how the command behaves per typed form (bare, with a subcommand, anything else) */
  forms?: CommandForm[];
  /** `terminal`: only works in the terminal; `agent-hidden`: the agent's own menu hides it, it still sends when typed */
  visibility?: "offered" | "terminal" | "agent-hidden";
  /** where this row came from, and whether it was checked against the running agent version */
  provenance?: {
    /** how the row was found: `scan` read from disk, `static` shipped with the bridge, `native` asked of the agent */
    transport: "scan" | "static" | "native";
    /** whether the row was checked against the running agent's version */
    verified: boolean;
  };
  /** a skill or custom command that has the same name as a builtin */
  shadows?: "builtin";
  /** stable identity: the canonical path for a skill or custom command file, the qualified name otherwise */
  id?: string;
}

/** One way a command can be typed and what it needs from the user. */
export interface CommandForm {
  /** `bare`: no argument; `{ sub }`: that subcommand; `other`: any other argument */
  match: "bare" | {
    /** the subcommand this form applies to */
    sub: string;
  } | "other";
  /** what the form needs from the user: `none` means its effect is persisted where the bridge reads it, `terminal` also covers output the agent never persists */
  interaction: "none" | "dialog" | "terminal" | "unknown";
  /** the dialog this form opens, when `interaction` is `dialog` */
  dialog?: string;
}

/** What the bridge knows about a command a user sent: accepted is never the same as done. */
export interface CommandOutcome {
  /** the outcome's own id */
  id: string;
  /** the pane the command was sent to */
  pane_id: string;
  /** the command text as sent */
  text: string;
  /** how far the command is known to have got; `accepted` only means the bridge sent it */
  state: "accepted" | "interaction-required" | "result-observed" | "terminal-required" | "unknown";
  /** what showed the state, and when (ISO time) */
  evidence: {
    /** where the evidence was read from */
    kind: "transcript" | "dialog" | "recognized-result" | "native" | "side-store";
    /** when it was seen (ISO time) */
    at: string;
  }[];
  /** a passing view of the result, never merged into history */
  preview?: string;
  /** what the command printed, verbatim with its line breaks, when a registered result reader recognized it (evidence `recognized-result`); bounded like `preview`, withheld from observers like it, never merged into history */
  result_text?: string;
  /** the command changed the agent's command list: refetch it */
  catalog_changed?: true;
  /** why the bridge knows the command needs the terminal, such as a skill the agent did not attach */
  note?: string;
  /** the skills the agent did not attach, so the command went as plain text: the chip names them in the user's language */
  unattached_skills?: string[];
  /** when the outcome was created (ISO time) */
  created_at: string;
  /** when the outcome last changed (ISO time) */
  updated_at: string;
}

/** GET /api/pane/prompt response; `suggestion` and `restored` are absent from older servers. */
export interface PanePromptResponse {
  /** the waiting TUI menu, or null when none is on screen */
  prompt: InteractivePrompt | null;
  /** the next prompt the agent suggests when no menu waits */
  suggestion?: string | null;
  /** the chat's last message, when the agent put it back as typed text in its input box */
  restored?: string | null;
  /** the pane's tracked command outcomes */
  outcomes?: CommandOutcome[];
}

/**
 * GET /api/pane/prompt: an agent's interactive TUI menu currently on the pane's screen
 * (Claude/omp/codex question, approval or plan prompts), parsed server-side from the
 * visible text. `id` names what the prompt says and which asking of it this is: an answer
 * names it, and one whose prompt changed between the read and the click is refused (409
 * prompt_changed) instead of misfired. The same question asked again has another id only where
 * the server saw the first asking end (a read without it, an answer through this route, the
 * agent back at work); a prompt answered outside the app and asked again unseen keeps its id.
 * The client tells one prompt from the next by the id alone.
 */
export interface InteractivePrompt {
  id: string;
  agent: string;
  kind: "question" | "approval" | "plan" | "menu";
  title: string;
  question: string;
  body: string | null;
  options: InteractivePromptOption[];
  multi_select: boolean;
  /** `markdown`: the question and the options' labels and descriptions are the agent's own Markdown
   * (omp's open ask call, once the screen's menu proves it is that call). Absent: plain text, as drawn */
  text_format?: "markdown";
  /** Native OpenCode question explicitly marked required: false; an empty answer skips it. */
  optional?: true;
  /** A multi-select whose typed answer goes with its checks in one answer (pi-ask's ask_user; OpenCode's native form says so by its agent). */
  checks_with_text?: true;
  /** Moving between steps saves the step's unsent edits on the server (pi-ask's ask_user): a step button never waits for them. */
  drafts_saved?: true;
  /** index of the "type your own answer" option, when the menu has one */
  custom_option_index: number | null;
  /** a question in Codex's queue while Codex keeps working: only the card answers it. Collapsed,
   * a message typed in the chat still goes to Codex; open in the terminal, the queue holds the
   * input, so the chat sends nothing until it is answered or closed */
  queued?: "collapsed" | "open";
  /** the questions of a form that asks several at once (omo), in order: which are answered and
   * which one the card asks now (none while the answers are reviewed). Absent for one question */
  steps?: InteractivePromptStep[];
  /** the answers a review asks to submit (Claude, omp), each question with what was picked for it,
   * read whole where the terminal wrapped them. A question cut off above the pane's top is null */
  answers?: InteractivePromptAnswer[];
  /** whether the prompt can step back to a previous question in a multi-step form */
  can_step_back?: boolean;
  /** previously selected option index for a single-select step, if any */
  default_option_index?: number | null;
  /** previously selected option indices for a multi-select step, if any */
  default_option_indices?: number[];
  /** previously entered custom text for a step, if any */
  default_custom_text?: string;
  /** the last-resort card for a blocked pane no reader knows: answered with its own buttons only,
   * so a message typed in the chat still goes to the agent as typed */
  fallback?: true;
  /** Claude's plan file behind a plan card, whose whole text is then the body: opened in the file viewer */
  plan_file?: string;
  /**
   * Claude's own words drawn over its question on the pane's screen, paragraphs parted by a blank line;
   * lines the pane wrapped are joined back only between plain prose, every other break kept as drawn. Claude Code (2.1.311) writes them to its session file only
   * with the answer, so until then the card shows them, as read off the screen. Absent when the
   * screen shows no words of Claude's right over the question, or not where they start; not part
   * of the card's id.
   */
  screen_words?: string;
  /**
   * The card's own words, which the bridge wrote rather than read off the agent's screen (an Esc
   * offered as Close, a fallback card's title): for each such field above, its English as a key with
   * its values (shared/card-text.ts), so the client shows it in the user's language. A field not
   * named here is the agent's own text, shown as it is; an older bridge names none.
   */
  own_text?: {
    title?: CardText;
    question?: CardText;
    body?: CardText;
    /** by index into `options` */
    labels?: Record<number, CardText>;
    /** by index into `options` */
    descriptions?: Record<number, CardText>;
    /** by index into `steps` */
    steps?: Record<number, CardText>;
  };
}

/** Card text the bridge wrote itself: an English key of the client's dictionaries, and the values of its `{placeholders}`, which may be card text too. */
export interface CardText {
  key: string;
  vars?: Record<string, string | number | CardText>;
}

export interface InteractivePromptStep {
  label: string;
  answered: boolean;
  current: boolean;
  /** The native widget can switch to this step without submitting an answer. */
  can_navigate?: boolean;
}

export interface InteractivePromptAnswer {
  question: string | null;
  answer: string | null;
  /** the note typed with the answer (omp) */
  note?: string;
}

export interface InteractivePromptOption {
  label: string;
  description: string | null;
}

/** POST /api/pane/prompt/answer body. One answer or navigation action; native OpenCode multiselect may combine option_indices and custom_text. */
export interface PromptAnswer {
  pane_id: string;
  prompt_id: string;
  option_index?: number;
  option_indices?: number[];
  custom_text?: string;
  step_back?: boolean;
  step_index?: number;
  /** Unsent edits for the current OpenCode step, saved only when navigating back. */
  draft?: { option_indices: number[]; custom_text: string };
}

/** WebSocket at /ws
 *
 *  Client -> server frames: attach {pane_id, cols, rows} | detach {pane_id} | input {pane_id, text}
 *    | keys {pane_id, keys} | resize {pane_id, cols, rows} | release-size {pane_id} | role {mode}
 *    | pty-ack {pane_id, stream_id, offset} | secret {id, pane_id, prompt, secret}
 *    | watch {pane_id, cols, rows} | unwatch {pane_id} | conversation-watch {pane_id, enabled}
 *    | insert {id, pane_id, text}
 *  Server -> client frames: snapshot | pty-data | pty-exit | pane-geometry | role-ack
 *    | pane-status | pane-exited | session-changed | conversation-changed | secret-result
 *    | insert-result | watch-data | watch-end | error
 *
 *  attach {flow_control:"ack"} opts into per-subscription output credit.
 *  pty-data.flow carries a stream_id and cumulative UTF-8 payload offset;
 *  pty-ack is sent AFTER xterm's write callback, never on receipt or reconnect.
 *  Slow consumers close with code 4008; the UI requires an explicit pane reopen.
 *
 *  Roles: a connection starts as `interact`. `role {mode:"observe"}` demotes it server-side:
 *  input/keys/resize then answer a `read_only` error frame and attaching never resizes the
 *  shared pty - the observer instead receives `pane-geometry` and adopts the pty's grid, so
 *  a phone watching a pane can never change the size the operator's PC sees. The client
 *  re-sends its role before the attach replay on reconnect.
 *  secret requires the "secret-input" feature, an interact attachment, a matching fresh
 *  prompt and an idle input queue. Its result contains only ok/code, never the value.
 *  watch requires the "watch" feature: a read-only view of the pane drawn for the client's grid
 *  (`herdr terminal session observe`), which, unlike an attach, leaves the pane at the size herdr's
 *  own window gives it. It is not an attach: no input, resize, ACK or input-ready. A tab out of use
 *  detaches and watches; it attaches again when the user is back. One watch per pane and connection;
 *  a second watch for the same pane starts it again at the new grid. watch-end: the view ended
 *  (unwatch does not answer one), and a pane the view could not start for gets one at once.
 */

/** A connection's authority over the shared ptys: `interact` types and resizes, `observe` only watches. */
export type ClientRole = "interact" | "observe";

/** A follow-up accepted by this bridge, scoped to the connection that submitted it. */
export interface PendingMessage {
  id: string;
  request_id: number;
  text: string;
  state: "queued" | "sending" | "held" | "uncertain";
  created_at: string;
  error?: { code: string; message: string };
  /** its submit was `agent_only`: a resend of a saved copy says so again */
  agent_only?: true;
}

export type ClientMessage =
  /** keep_size: the grid is covered (the chat lens), so the attach leaves the shared pty's size as it is */
  | { type: "attach"; pane_id: string; cols: number; rows: number; flow_control?: "ack"; keep_size?: boolean; /** Opaque browser UUID for device-bound Pi presentation receipts only; never input authority. */ receipt_resume_id?: string }
  | { type: "detach"; pane_id: string }
  /** Native invalidations require "conversation-watch" and an attachment; observers may subscribe.
   * Detaching clears interest, so reconnect/reattach must enable it again. REST remains authoritative. */
  | { type: "conversation-watch"; pane_id: string; enabled: boolean }
  /** a pane another web bridge holds (`attach_held`): take herdr's attach slot from it, here, now */
  | { type: "take-over"; pane_id: string }
  /** `stop`: the composer's Stop (text a lone ESC). The bridge sends it in the pane's turn, after typing
   * still on its way, and a message sent next waits for it; an older bridge types it like any key. */
  | { type: "input"; pane_id: string; text: string; stop?: true }
  | { type: "keys"; pane_id: string; keys: string[] }
  /** a composer message, sent to servers whose snapshot lists "submit": the server types it and
   * its own Enter after a short gap, and answers with a submit-result of the same id. `text` is
   * the message as written (agent.prompt pastes it itself), `payload` the same shaped for the
   * pane's bracketed-paste mode, typed when no agent is in front. `typed`: the terminal's own
   * input line, which types `payload` like the keyboard would even into an agent's open menu.
   * An immediate submit (no `delivery`, or `immediate`) is canonical or refused with invalid_submit_text before
   * anything is typed or a draft cleared: `text` holds no terminal control character but tab and newline (so no
   * paste marker), at most 20000 characters (32768 with `typed`) once trailing newlines are dropped and CRLF or a
   * lone CR read as LF, and `payload` is that text with each LF a CR, bare or inside exactly one ESC[200~ ESC[201~
   * pair. A queued or held message types `text` only, and `payload` is not read.
   * `delivery:queue` requires "pending-input" and a live interact attachment: while the agent
   * works the bridge keeps the message until its next turn, or the owner explicitly steers it.
   * `delivery:hold` (feature "pending-hold") is the same, except the message is kept as held, also
   * when it arrives after the turn ended: it never goes on its own, only when the owner steers it.
   * Omission keeps the legacy immediate submission. Queued messages never resume after lease loss.
   * Queue request ids increase monotonically per connection; recent duplicates replay their
   * receipt, and retired ids are rejected rather than executed after history eviction.
   * `clear_draft`: an immediate chat message only, sent again over the `draft` its input_draft
   * refusal named: the server clears Claude's input box first while it still holds exactly that,
   * and refuses again (input_draft) when it holds anything else or does not read empty after.
   * `send_anyway`: an immediate chat message only, sent again after an input_draft refusal that
   * named no draft and showed the box (`box`): the server sends once over that box, only into the same
   * Claude terminal and session that refusal was for (else pending_target_changed), and only while the
   * box still shows that `box` or reads empty (else input_draft again, with the new box). Not with
   * `clear_draft`.
   * `resend_id`: stable held-copy ID for immediate chat resends across connections; the bridge
   * shares the first outcome for 60 seconds after settlement. `resend_generation` defaults to 0;
   * only a definitive no-input refusal permits the next attempt generation. A retained withdrawal
   * overrides every generation with `pending_discarded`; the client drops that exact saved copy.
   * Older clients treat this unknown refusal as uncertain and retain non-resendable text.
   * A retained ambiguous resend or dismissed uncertain row refuses new attempts with
   * `pending_uncertain`, including other generations of the same stable ID.
   * Not with `send_anyway`:
   * that combination returns invalid_delivery before reserving or replaying an ID. No `clear_draft`.
   * Older peers ignore it.
   * `agent_only` (feature "agent-only"): the message is for an agent alone (a chat message carrying comments on
   * a reply, #511, whose `> quote` lines a shell would read as redirects). The server refuses it with
   * agent_not_ready, typing nothing, when no agent is in front of the pane as it would type it; a queued or held
   * one keeps the rule until it is typed. Not with `typed`; anything but true is invalid_delivery. */
  | { type: "submit"; id: number; pane_id: string; text: string; payload: string; typed?: boolean; delivery?: "immediate" | "queue" | "hold"; clear_draft?: string; send_anyway?: true; resend_id?: string; resend_generation?: number; agent_only?: true }
  /** `withdrawal_only`: Edit's discard may withdraw only queued/held input; uncertain text stays
   * with its owner and returns pending_uncertain, rather than being dismissed. Older servers ignore
   * this optional field and retain their existing discard behaviour, without this protection.
   * `launch_ended`: the client tells first_message_launch_ended apart; an older one, which would take that
   * unknown code as maybe typed, is answered pending_target_changed for it */
  | { type: "pending-action"; id: number; pane_id: string; pending_id: string; action: "steer" | "discard"; resend_generation?: number; launch_ended?: true; withdrawal_only?: true }
  /** the terminal's input line typed into the pane without Enter (feature "terminal-insert"), answered
   * with an insert-result of the same id once herdr has the bytes. `text` is one line of the draft,
   * as written: a line break is refused (`unsafe_multiline`), since nothing reports whether the pane's
   * program takes several lines as one bracketed paste (herdr's attach always opens with its own
   * ESC[?2004h) and a shell would run each, and an escape (a paste marker included) is refused with
   * every control byte. The bridge never adds a terminator, a key, a focus, a resize or a take-over
   * for it. Requires a live interact attachment
   * the sender is in, and refuses observe, a held or unready pane and a password prompt on screen.
   * At most 32,768 UTF-16 code units and 128 KiB of UTF-8 (shared/terminal-insert.ts). Never queued
   * or replayed: a connection that drops settles it as not confirmed, and the draft stays. */
  | { type: "insert"; id: number; pane_id: string; text: string }
  /** Masked input: revalidate the visible prompt, type literal bytes + Enter immediately.
   * Never queued, retried, sent through agent.prompt, or echoed in a result. */
  | { type: "secret"; id: number; pane_id: string; prompt: string; secret: string }
  | { type: "resize"; pane_id: string; cols: number; rows: number }
  /** this client's terminal is covered again (the chat lens): if the pty has its grid, the server sizes
   * the pty for the latest grid of another interact client still showing the terminal, or leaves it.
   * Never answered; an older server ignores it, so it needs no feature. */
  | { type: "release-size"; pane_id: string }
  /** Cumulative UTF-8 payload bytes processed by xterm, only for this subscription. */
  | { type: "pty-ack"; pane_id: string; stream_id: string; offset: number }
  | { type: "role"; mode: ClientRole }
  /** whether this page is in use: visible and focused. While any connection of a server says
   * so, that server sends no web push to any device (#751). Sent on connect and on every change,
   * also through a remote PC's socket (the connection server reads it there too); an older
   * server ignores it, so it needs no feature. */
  | { type: "presence"; active: boolean }
  /** a read-only view of the pane at this grid, for a tab out of use (feature "watch"); never resizes the pane */
  | { type: "watch"; pane_id: string; cols: number; rows: number }
  | { type: "unwatch"; pane_id: string }
  /** liveness only (feature "ping"): answered at once with a `pong` of the same id, for any role. The
   * client sends it when the page comes back, the network changes or nothing arrived for a while,
   * and drops a socket that stays silent: a half-open one still reads OPEN in the browser. A remote
   * PC's socket relays it unchanged, so the remote server's snapshot decides whether it is sent. */
  | { type: "ping"; id: number };

/** Local-only diagnostic metadata. This contract never contains a message, URL or credential. */
export type ClientConnectionEventKind = "connect" | "open" | "connect_timeout" | "close" | "socket_error"
  | "pagehide" | "pageshow" | "hidden" | "visible" | "online" | "probe" | "probe_retry"
  | "probe_overdue" | "probe_drop" | "pong" | "submit_sent" | "submit_result" | "submit_timeout"
  | "submit_disconnect" | "input_held" | "probe_input_blocked" | "closing_wait";
export interface ClientConnectionEvent {
  seq: number;
  at: number;
  connection: number;
  kind: ClientConnectionEventKind;
  socket_state: number | null;
  visibility: "visible" | "hidden" | "unknown";
  online: boolean | null;
  code?: number;
  elapsed_ms?: number;
  pending?: number;
  request_id?: number;
  attempt?: number;
  result?: "ok" | "refused";
}
/** POST /api/updates/install: the full commit id of the release the person was offered (UpdateStatus.latest_revision). */
export interface UpdateInstallRequest {
  expected_revision: string;
}
export interface ClientConnectionTrace {
  client_id: string;
  target: "local" | "remote";
  events: ClientConnectionEvent[];
}

/** What a server supports beyond the base protocol, listed in its `features` frame and its first snapshot; older bridges list nothing. */
export type ServerFeature = "submit" | "pending-input" | "pending-hold" | "secret-input" | "input-ready" | "take-over" | "watch" | "conversation-watch" | "ping" | "terminal-insert" | "agent-only";

export type ServerMessage =
  /** the first frame of a connection, before the snapshot that can wait seconds on herdr: what this server
   * supports and this socket's `connection` id (the snapshot names the same), and the herdr it reads now
   * (`herdr_lifetime` as a snapshot names it; absent when unproven). A page acts on it before the snapshot only
   * when that herdr is the one it already knows. Older bridges never send it: their features come with the snapshot */
  | { type: "features"; features: ServerFeature[]; connection: string; herdr_lifetime?: string }
  /** `connection`: this socket's id on the PC, for a create request's `first_message_connection`; older bridges send none */
  | { type: "snapshot"; snapshot: SessionSnapshot; features?: ServerFeature[]; connection?: string }
  /** raw PTY bytes: append to the terminal, never repaint over it. A mirrored pane (HerdrIdentity.terminal_mirror) sends whole screens the same way. */
  /**
   * `replay`: these bytes are the screen from before this client attached (the first frame of a new
   * attach), drawn but never asked again for side effects such as a clipboard write. Live output and
   * older bridges omit it.
   */
  | { type: "pty-data"; pane_id: string; data: string; flow?: { stream_id: string; offset: number }; replay?: true }
  | { type: "pty-exit"; pane_id: string; code: number | null }
  /** a pane that waited for another web bridge to let go of its terminal (error `attach_held`) is attached again */
  | { type: "attach-resumed"; pane_id: string }
  /** Attachment readiness (omitted ready means true); false revokes it during retry. Never a typed-text acknowledgement. */
  | { type: "input-ready"; pane_id: string; ready?: boolean }
  /** sent to a client joining an attachment whose stream ended after it was ready, before the replay: the replay is the screen from before, so only output after the next `input-ready` shows the pane as it is. Presentation only; input readiness is unchanged */
  | { type: "output-recovering"; pane_id: string }
  /** the shared pty's grid changed: observe clients adopt it, interact clients drive it. `fixed`: the grid is the pane's own in herdr (a mirrored pane), so every client adopts it and none resizes */
  | { type: "pane-geometry"; pane_id: string; cols: number; rows: number; fixed?: boolean }
  | { type: "role-ack"; mode: ClientRole }
  /** ok after Enter delivery, or bridge acceptance (`pending`); never an agent execution acknowledgement.
   * `draft`: on an immediate send's input_draft, the one-row draft in Claude's input box that a send
   * with `clear_draft` may clear (absent when the box is not one the server clears).
   * `box`: on an immediate send's input_draft that names no draft, what the server read in Claude's
   * input box (plain rows, cut at 200 characters; empty when no whole box could be read). Present
   * only when a send with `send_anyway` may follow; an older server never sends it.
   * `submit_partial`: the explicitly confirmed terminal draft was cleared, but the send's
   * deadline then expired before the message was sent; never a nothing-typed receipt. */
  | { type: "submit-result"; id: number; pane_id: string; ok: boolean; pending?: PendingMessage; code?: string; message?: string; draft?: string; box?: string }
  | { type: "pending-result"; id: number; pane_id: string; pending_id: string; ok: boolean; code?: string; message?: string }
  /** ok once herdr accepted the inserted bytes (`pane.send_text` answered), never that the program
   * took or ran them; a refusal names why and nothing was typed, except `insert_failed`, whose bytes
   * may or may not have arrived. Older bridges never send it. */
  | { type: "insert-result"; id: number; pane_id: string; ok: boolean; code?: string; message?: string }
  /** Owner-only receipt and state; only an explicit removed outcome permits deleting a retained client message.
   * `dismissed` removes an uncertain copy, never proves withdrawal or delivery. Existing clients
   * remove owned IDs for any explicit outcome; Edit restores only `discarded`. */
  | { type: "pending-messages"; pane_id: string; messages: PendingMessage[]; removed?: Array<{ id: string; outcome: "sent" | "discarded" | "consumed" | "dismissed" }> }
  | { type: "secret-result"; id: number; pane_id: string; ok: boolean; code?: string }
  /** agent-status push for ANY pane, attached or not (server-side status collector) */
  | { type: "pane-status"; pane_id: string; agent_status: AgentStatus; finish_id?: number; finish_epoch?: string; /** a pane's running background tasks (OmO's, or a Claude Code pane's subagents and commands), when the frame is about them: it changes no status */ background_tasks?: number; /** every frame says it: absent, the pane does not wait on its turn's background work */ background_wait?: true; /** a pane's plan, when the frame is about it (null: it keeps none now); it changes no status */ plan?: PlanSummary | null }
  /** Native transcript invalidation for an interested attached pane; signature is opaque, not a REST ETag. Refetch the existing conversation endpoint. */
  | { type: "conversation-changed"; pane_id: string; signature: string }
  /** a pane's process exited (pushed even when nobody is attached to it) */
  | { type: "pane-exited"; pane_id: string }
  /** session structure changed (pane created/closed): refetch /api/session */
  | { type: "session-changed" }
  /** herdr's own focus moved to this pane (its `pane.focused`, also sent for a tab or workspace brought
   * to the front), whoever moved it: its TUI, its CLI or a script. A browser follows it only when
   * asked to (Settings → Terminal); an older bridge never sends it */
  | { type: "pane-focused"; pane_id: string }
  /** a watched pane's screen as herdr draws it for the watch's grid: whole screens and changes, written as they come; never acknowledged */
  | { type: "watch-data"; pane_id: string; data: string }
  /** the watch ended (pane gone, herdr closed it, or this herdr has no read-only view); the client keeps its last screen */
  | { type: "watch-end"; pane_id: string }
  /** the answer to a `ping`, with its id; only this frame, for a ping in flight, ends the client's liveness probe */
  | { type: "pong"; id: number }
  /** `pane_id` names the pane an error is about, when it is about one (`attach_held`) */
  | { type: "error"; code: string; message: string; pane_id?: string };

export type { SessionHistoryAgent, SessionResumeSource, SessionHistoryRow, SessionResumeRequest, SessionResumeResponse, SessionHistoryResponse } from "./session-history.ts";

/** herdr's default socket, under XDG_CONFIG_HOME when set, as herdr itself resolves it. */
export const HERDR_SOCKET_PATH = `${process.env["XDG_CONFIG_HOME"] || `${process.env["HOME"] ?? ""}/.config`}/herdr/herdr.sock`;
export const DEFAULT_PORT = 7317;
