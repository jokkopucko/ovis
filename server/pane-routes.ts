/**
 * The pane routes: what the browser reads from a pane (its screen, scroll, selection, commands,
 * files and native conversation) and what it does to one (type, rename, close, split, zoom, swap,
 * resize, clear, focus, paste an image). Each answers from herdr alone, so none needs the
 * server's own state. The dispatcher in index.ts runs the access gate first.
 */
import type { AgentRenameRequest, PaneDirection, PaneResized, PaneSplit, PaneSwapped, PaneZoomed, ReadFormat, ReadSource } from "../shared/protocol.ts";
import { mergeCatalogSources } from "./catalog-sources.ts";
import { rememberPaneCommands, scanPaneCommands } from "./commands.ts";
import { paneFiles } from "./files.ts";
import { badRequest, conflictResponse, errorResponse, isCount, isJsonObject, jsonResponse, readJsonObject, requestIdContext, setRequestRoute } from "./http.ts";
import { conversationImage, ConversationReadPending, ConversationUnavailable, forgetPaneTranscriptState, HistoryChanged, paneConversation, paneProcessRoots, paneTranscript, toolOutput } from "./conversation.ts";
import { OPENCODE_TOOL_REF } from "./opencode.ts";
import { openCodeFlagVersion, openCodeInstalledVersion } from "./opencode-service.ts";
import { DevinHistoryChanged } from "./devin.ts";
import { agentRename, HerdrError, layoutSetSplitRatio, paneClear, paneClose, paneFind, paneFocus, paneRead, paneRename, paneResize, paneScroll, paneScrollInfo, paneSelectionRead, paneSendKeys, paneSendText, paneSplit, paneSwap, paneSwapWith, paneZoom } from "./herdr/client.ts";
import { paneContext, resolveAgent, versionSourceOf } from "./pane-context.ts";
import { ompScreenContext } from "./omp-status.ts";
import { PasteImageError, readImageBody, savePaneImage } from "./paste.ts";
import { CLAUDE_REWIND_OPEN_MESSAGE } from "./dialogs/claude.ts";
import { claudeRewindOpen } from "./prompt.ts";
import { expandedDirectory } from "./workspace-routes.ts";
import { ConversationDiagnostics } from "./conversation-diagnostics.ts";

const conversationDiagnostics = new ConversationDiagnostics();

/** the native stores createServer was given; unset, each reader finds its own */
export type PaneStores = { codexHome?: string; grokHome?: string; museData?: string; opencodeDb?: string; devinDbPath?: string; hermesHome?: string; openCodeStateDir?: string };

/** the sides herdr's pane.swap and pane.resize take; anything else is refused before the RPC, which would answer invalid_request */
const isPaneDirection = (value: unknown): value is PaneDirection => value === "left" || value === "right" || value === "up" || value === "down";
/** pane.read's own enums; a read outside them is refused here rather than sent to herdr as a guess (the generated types are open-ended) */
const READ_SOURCES = new Set<ReadSource>(["detection", "recent", "recent_unwrapped", "visible"]);
const READ_FORMATS = new Set<ReadFormat>(["ansi", "text"]);
/** pane.read's `lines` is a uint32 */
const UINT32_MAX = 4294967295;

/** The answer for a pane route, or null when the path is not one. */
/** `prompts=` from the chat's history-page setting; a junk value is no value. */
function pagePromptsOf(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

export async function handlePaneRequest(request: Request, url: URL, pathname: string, options: PaneStores): Promise<Response | null> {

  if (pathname === "/api/pane/rename") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const payload = await readJsonObject<{ pane_id?: unknown; label?: unknown }>(request);
    if (payload instanceof Response) return payload;
    if (typeof payload.pane_id !== "string" || payload.pane_id.length === 0) return badRequest("missing_pane_id", "pane_id is required");
    if (typeof payload.label !== "string") return badRequest("missing_label", "label is required");
    try {
      await paneRename(payload.pane_id, payload.label.length === 0 ? null : payload.label);
      return jsonResponse({ ok: true });
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api/agent/rename") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const payload = await readJsonObject<Partial<Record<keyof AgentRenameRequest, unknown>>>(request);
    if (payload instanceof Response) return payload;
    if (typeof payload.pane_id !== "string" || payload.pane_id.length === 0) return badRequest("missing_pane_id", "pane_id is required");
    if (payload.name !== null && typeof payload.name !== "string") return badRequest("invalid_name", "name must be a string, or null to clear it");
    // the rule and the uniqueness are herdr's: its refusal comes back as it is
    try {
      await agentRename(payload.pane_id, payload.name);
      return jsonResponse({ ok: true });
    } catch (error) {
      return errorResponse(error);
    }
  }

  // The commands an agent would offer in a folder before any pane runs it (the new workspace and
  // tab dialogs list its skills): the same rows GET /api/pane/commands gives a pane, read from the
  // bridge's own tables and a scan of the folder and home. No process exists, so nothing is asked
  // of an agent binary (the catalog's convention), no process roots refine the scan, and no row is
  // verified against a running version.
  if (pathname === "/api/agent/commands") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    const agent = url.searchParams.get("agent");
    if (!agent) return badRequest("missing_agent", "agent query parameter is required");
    const directory = (url.searchParams.get("cwd") ?? "").trim();
    const cwd = directory === "" ? null : expandedDirectory(directory);
    if (directory !== "" && cwd === null) return badRequest("invalid_cwd", "cwd must be an existing directory");
    try {
      // OpenCode types its skills one way per version: before any pane runs it, its service file says which
      return jsonResponse({ commands: await scanPaneCommands(agent, cwd, undefined, agent === "opencode" ? openCodeInstalledVersion(options.openCodeStateDir) : undefined, request.signal) });
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api/pane/commands" || pathname === "/api/pane/files") {
    // the commands scan's wait counts from here, its herdr lookups included (`scanPaneCommands`)
    const began = performance.now();
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    const paneId = url.searchParams.get("pane_id");
    if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
    try {
      const context = await paneContext(paneId);
      if (pathname === "/api/pane/commands") {
        const roots = await paneProcessRoots(paneId, context.agent);
        const { agent } = resolveAgent(context.pane, roots);
        // the version comes from the store this pane's own transcript names; none resolved leaves it unverified
        const store = agent === "claude" || agent === "codex" || agent === "opencode"
          ? await paneTranscript(paneId, options.codexHome, undefined, options.devinDbPath, options.opencodeDb, options.hermesHome, options.grokHome, options.museData).then(versionSourceOf, () => null)
          : null;
        const { version: stored } = resolveAgent(context.pane, roots, store);
        // a pane with no session yet has no stored version: OpenCode's service file still says how it types its skills
        // (syntax only: the catalog's pin stays unverified, since only the store or a verified service may verify it).
        // A pane with a session whose transcript is unreadable gets none: that session may be an OpenCode 1 one.
        // A TUI started without the service (--standalone, --server) has no service file: its own flags say v2 (#1551)
        const argv = roots.processes?.foreground_processes?.find((entry) => entry.pid === roots.pid)?.argv;
        const version = stored ?? (agent === "opencode" && !context.pane.agent_session ? openCodeInstalledVersion(options.openCodeStateDir) ?? openCodeFlagVersion(argv) : null);
        // on a file thread: a skill folder on a slow mount stalls only this request (#2254)
        const scanned = await scanPaneCommands(agent, context.cwd, { ...roots.omo, environ: roots.environ }, version, request.signal, began);
        const commands = await mergeCatalogSources(agent, context.pane, context.cwd, scanned, undefined, { codexHome: options.codexHome, openCodeStateDir: options.openCodeStateDir });
        rememberPaneCommands(context.pane, agent, commands);
        return jsonResponse({ commands });
      }
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw === null ? 20 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1) return badRequest("invalid_limit", "limit must be a positive integer");
      return jsonResponse({ files: await paneFiles(context.cwd, url.searchParams.get("q") ?? "", Math.min(limit, 100)) });
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api/pane/read") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    const paneId = url.searchParams.get("pane_id");
    if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
    const linesRaw = url.searchParams.get("lines");
    // herdr's pane.read takes a uint32: anything else is refused here instead of reaching the RPC.
    // The raw text is checked, not Number()'s answer: Number() reads "" as 0 and rounds a spelling
    // such as 0.99999999999999999 to 1, so only plain decimal digits are taken as a count
    if (linesRaw !== null && (!/^[0-9]+$/.test(linesRaw) || Number(linesRaw) > UINT32_MAX)) {
      return badRequest("invalid_lines", "lines must be an integer from 0 to 4294967295 in decimal digits");
    }
    const lines = linesRaw === null ? undefined : Number(linesRaw);
    // herdr knows these enums and has its own answer for a wrong one, but a read this
    // route never meant to make is refused here rather than sent on as a guess
    const source = url.searchParams.get("source") ?? "visible";
    if (!READ_SOURCES.has(source)) return badRequest("invalid_source", `source must be one of ${[...READ_SOURCES].join(", ")}`);
    const format = url.searchParams.get("format") ?? "text";
    if (!READ_FORMATS.has(format)) return badRequest("invalid_format", `format must be one of ${[...READ_FORMATS].join(", ")}`);
    try {
      const read = await paneRead({ paneId, source: source as ReadSource, format: format as ReadFormat, ...(lines === undefined ? {} : { lines }) });
      return jsonResponse({ read });
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api/pane/find") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const payload = await readJsonObject(request);
    if (payload instanceof Response) return payload;
    if (typeof payload.pane_id !== "string" || payload.pane_id.length === 0) return badRequest("missing_pane_id", "pane_id is required");
    if (typeof payload.query !== "string" || payload.query.length === 0 || payload.query.length > 1024) return badRequest("invalid_query", "query must contain 1 to 1024 characters");
    if (payload.direction !== "forward" && payload.direction !== "backward") return badRequest("invalid_direction", "direction must be forward or backward");
    if (payload.jump !== undefined && typeof payload.jump !== "boolean") return badRequest("invalid_jump", "jump must be a boolean");
    const point = (value: unknown): value is { row: number; col: number } =>
      isJsonObject(value) && isCount(value.row) && value.row <= 0xffffffff && isCount(value.col) && value.col <= 0xffff;
    const previous = payload.previous;
    if (previous !== undefined && (!isJsonObject(previous) || !point(previous.start) || !point(previous.end) || !isCount(payload.content_revision))) {
      return badRequest("invalid_previous", "previous requires two history cells and content_revision");
    }
    if (payload.content_revision !== undefined && !isCount(payload.content_revision)) return badRequest("invalid_revision", "content_revision must be a non-negative integer");
    try {
      return jsonResponse(await paneFind({
        pane_id: payload.pane_id, query: payload.query, direction: payload.direction,
        ...(payload.jump !== undefined ? { jump: payload.jump } : {}),
        ...(isJsonObject(previous) && point(previous.start) && point(previous.end) ? { previous: { start: previous.start, end: previous.end } } : {}),
        ...(payload.content_revision !== undefined ? { content_revision: payload.content_revision } : {}),
      }));
    } catch (error) {
      if (error instanceof HerdrError && error.code === "stale_content") return conflictResponse(error.code, error.message);
      return errorResponse(error);
    }
  }

  if (pathname === "/api/pane/scroll") {
    setRequestRoute(pathname);
    if (request.method === "GET") {
      const paneId = url.searchParams.get("pane_id");
      if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
      try {
        return jsonResponse({ scroll: await paneScrollInfo(paneId) });
      } catch (error) {
        return errorResponse(error);
      }
    }
    if (request.method !== "POST") return badRequest("method_not_allowed", "use GET or POST");
    const payload = await readJsonObject<{ pane_id?: unknown; offset_from_bottom?: unknown }>(request);
    if (payload instanceof Response) return payload;
    if (typeof payload.pane_id !== "string" || payload.pane_id.length === 0) return badRequest("missing_pane_id", "pane_id is required");
    if (!isCount(payload.offset_from_bottom)) return badRequest("invalid_offset", "offset_from_bottom must be a non-negative integer");
    try {
      return jsonResponse({ scroll: await paneScroll(payload.pane_id, payload.offset_from_bottom) });
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api/pane/selection") {
    setRequestRoute(pathname);
    const paneId = url.searchParams.get("pane_id");
    if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
    const [anchorRow, anchorCol, cursorRow, cursorCol] = ["anchor_row", "anchor_col", "cursor_row", "cursor_col"]
      .map((name) => { const raw = url.searchParams.get(name); return raw === null || raw === "" ? NaN : Number(raw); });
    if (![anchorRow, anchorCol, cursorRow, cursorCol].every(isCount)) {
      return badRequest("invalid_range", "anchor_row, anchor_col, cursor_row and cursor_col must be non-negative integers");
    }
    try {
      const text = await paneSelectionRead(paneId, { row: anchorRow!, col: anchorCol! }, { row: cursorRow!, col: cursorCol! });
      return jsonResponse({ text });
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api/pane/conversation/tool-output") {
    setRequestRoute(pathname);
    const paneId = url.searchParams.get("pane_id");
    const ref = url.searchParams.get("ref");
    if (!paneId || !ref) return badRequest("missing_parameter", "pane_id and ref query parameters are required");
    try {
      const output = await toolOutput(paneId, ref, options.codexHome, options.opencodeDb, options.hermesHome, options.grokHome, options.museData);
      if (output === null) return jsonResponse({ error: { code: "output_not_found", message: "no such tool call in this pane's conversation" } }, 404);
      // a tool call's id names its output for good; OpenCode's ref names a place in a row it rewrites in place
      const cacheControl = (OPENCODE_TOOL_REF.test(ref) || /^grok:/.test(ref)) ? "private, no-store" : "private, max-age=86400, immutable";
      return new Response(output, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": cacheControl, "x-content-type-options": "nosniff" } });
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api/pane/conversation/image") {
    setRequestRoute(pathname);
    const paneId = url.searchParams.get("pane_id");
    const ref = url.searchParams.get("ref");
    if (!paneId || !ref) return badRequest("missing_parameter", "pane_id and ref query parameters are required");
    try {
      const image = await conversationImage(paneId, ref, options.codexHome, options.opencodeDb, options.grokHome);
      if (image === null) return jsonResponse({ error: { code: "image_not_found", message: "no such image in this pane's conversation" } }, 404);
      // Claude and pi embed immutable bytes, and omp, Grok and Copilot name a picture by its digest; Codex files and
      // OpenCode tool-image ordinals can change, and a Codex tool's picture (`codex-tool:`) loads with its row.
      const cacheControl = ref.startsWith("codex-") || ref.startsWith("opencode:") ? "private, no-store" : "private, max-age=86400, immutable";
      return new Response(image.bytes, { headers: { "content-type": image.mediaType, "cache-control": cacheControl, "x-content-type-options": "nosniff" } });
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api/pane/conversation") {
    setRequestRoute(pathname);
    const paneId = url.searchParams.get("pane_id");
    if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
    const page = {
      before: url.searchParams.get("before") ?? undefined,
      since: url.searchParams.get("since") ?? undefined,
      from: url.searchParams.get("from") ?? undefined,
      history_id: url.searchParams.get("history_id") ?? undefined,
      prompts: pagePromptsOf(url.searchParams.get("prompts")),
    };
    try {
      const { version, ...conversation } = await paneConversation(paneId, options.codexHome, page, options.devinDbPath, options.opencodeDb, options.hermesHome, options.grokHome, options.museData);
      conversationDiagnostics.recovered(paneId, requestIdContext.getStore()?.id);
      // omp's transcript counts the tokens a request filled but never names the window; its own
      // status bar does (server/omp-status.ts), so the chat's ring gets a percent from there
      const screenContext = conversation.source === "omp-transcript" ? await ompScreenContext(paneId) : null;
      const answer = screenContext === null ? conversation
        : { ...conversation, metadata: { ...(conversation.metadata ?? { model: null, reasoning_effort: null }), context: screenContext } };
      // no-store keeps the browser's own cache out of it, so the chat sees the 304.
      // weak: the same answer goes out gzipped or plain (compress.ts), which are not the same bytes
      // the screen's figure is not in `version`, so it is named here: a changed percent is a new answer
      const etag = `W/"${version}${screenContext === null ? "" : `-ctx${screenContext.used}:${screenContext.window}`}"`;
      const headers = { etag, "cache-control": "no-store" };
      if (request.headers.get("if-none-match")?.replace(/^W\//, "") === etag.slice(2)) return new Response(null, { status: 304, headers });
      return jsonResponse(answer, 200, headers);
    } catch (error) {
      if (error instanceof HistoryChanged || error instanceof DevinHistoryChanged) return jsonResponse({ error: { code: "history_changed", message: error.message } }, 409);
      if (error instanceof ConversationReadPending) {
        conversationDiagnostics.unavailable(paneId, error, requestIdContext.getStore()?.id);
        return jsonResponse({ error: { code: "conversation_read_pending", message: error.message } }, 503, { "cache-control": "no-store" });
      }
      // an unrecognized pane is not an error: the client falls back to the
      // scrollback transcript, exactly like chatmux's terminal fallback. Its metadata is only
      // ever what the agent's own status line states
      if (error instanceof ConversationUnavailable) {
        conversationDiagnostics.unavailable(paneId, error, requestIdContext.getStore()?.id);
        return jsonResponse({ source: "scrollback", turns: [], ...(error.screen ? { metadata: error.screen, screen: true } : {}) });
      }
      return errorResponse(error);
    }
  }

  if (pathname === "/api/pane/input" || pathname === "/api/pane/keys") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const payload = await readJsonObject<{ pane_id?: string; text?: string; keys?: string[] }>(request);
    if (payload instanceof Response) return payload;
    if (typeof payload.pane_id !== "string" || !payload.pane_id.trim()) return badRequest("missing_pane_id", "pane_id is required");
    try {
      if (pathname === "/api/pane/input") {
        if (typeof payload.text !== "string") return badRequest("missing_text", "text is required");
        // text over Claude Code's rewind dialog would land in a Summarize row's add-context field
        // (core/composer.ts); keys still go, so Esc can close it
        const { agent } = await paneContext(payload.pane_id).catch(() => ({ agent: null }));
        if (agent === "claude" && claudeRewindOpen((await paneRead({ paneId: payload.pane_id, source: "detection", format: "text" })).text)) {
          return conflictResponse("rewind_dialog_open", CLAUDE_REWIND_OPEN_MESSAGE);
        }
        await paneSendText(payload.pane_id, payload.text);
      } else {
        if (!Array.isArray(payload.keys) || !payload.keys.every((key) => typeof key === "string")) return badRequest("missing_keys", "keys must be an array");
        await paneSendKeys(payload.pane_id, payload.keys);
      }
      return jsonResponse({ ok: true });
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api/pane/close") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const payload = await readJsonObject<{ pane_id?: string }>(request);
    if (payload instanceof Response) return payload;
    if (typeof payload.pane_id !== "string" || !payload.pane_id.trim()) return badRequest("missing_pane_id", "pane_id is required");
    try {
      // herdr emits pane.closed -> the collector broadcasts session-changed, so
      // every client refetches and the pane leaves sidebars on its own
      await paneClose(payload.pane_id);
      // the pane is gone: whatever its chat parsed is released with it (server/conversation.ts)
      forgetPaneTranscriptState(payload.pane_id);
      return jsonResponse({ ok: true });
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api/layout/ratio") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const payload = await readJsonObject<{ tab_id?: unknown; path?: unknown; ratio?: unknown }>(request);
    if (payload instanceof Response) return payload;
    if (typeof payload.tab_id !== "string" || !payload.tab_id.trim()) return badRequest("missing_tab_id", "tab_id is required");
    if (!Array.isArray(payload.path) || !payload.path.every((step) => typeof step === "boolean")) return badRequest("invalid_path", "path must be an array of booleans");
    if (typeof payload.ratio !== "number" || !Number.isFinite(payload.ratio) || payload.ratio < 0.1 || payload.ratio > 0.9) return badRequest("invalid_ratio", "ratio must be a number from 0.1 to 0.9");
    try {
      await layoutSetSplitRatio(payload.tab_id, payload.path, payload.ratio);
      return jsonResponse({ ok: true });
    } catch (error) { return errorResponse(error); }
  }

  // herdr's own layout operations, as its TUI has them: prefix+v and prefix+- (split), prefix+z
  // (zoom), prefix+shift+hjkl (swap), its resize mode, and pane clear. Explicit swaps also restore
  // herdr's prior focus; the browser's rearrangement must not select another workspace there. No
  // answer carries the layout: a new pane reaches every client through the collector's
  // pane.created subscription and a moved border, zoom or swap through its layout.updated one,
  // both as session-changed, the same way the TUI's own changes do.
  if (pathname === "/api/pane/split" || pathname === "/api/pane/zoom" || pathname === "/api/pane/swap" || pathname === "/api/pane/resize" || pathname === "/api/pane/clear" || pathname === "/api/pane/focus") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const payload = await readJsonObject<{ pane_id?: unknown; direction?: unknown; target_pane_id?: unknown; focus?: unknown; mode?: unknown; amount?: unknown }>(request);
    if (payload instanceof Response) return payload;
    if (typeof payload.pane_id !== "string" || !payload.pane_id.trim()) return badRequest("missing_pane_id", "pane_id is required");
    const paneId = payload.pane_id;
    try {
      if (pathname === "/api/pane/focus") {
        await paneFocus(paneId);
        return jsonResponse({ ok: true });
      }
      if (pathname === "/api/pane/split") {
        if (payload.direction !== "right" && payload.direction !== "down") return badRequest("invalid_direction", "direction must be right or down");
        if (payload.focus !== undefined && typeof payload.focus !== "boolean") return badRequest("invalid_focus", "focus must be a boolean");
        const pane = await paneSplit(paneId, payload.direction, payload.focus === true);
        return jsonResponse({ ok: true, pane } satisfies PaneSplit);
      }
      if (pathname === "/api/pane/zoom") {
        if (payload.mode !== undefined && payload.mode !== "toggle" && payload.mode !== "on" && payload.mode !== "off") return badRequest("invalid_mode", "mode must be toggle, on or off");
        const zoom = await paneZoom(paneId, payload.mode ?? "toggle");
        return jsonResponse({ ok: true, zoomed: zoom.zoomed, changed: zoom.changed, reason: zoom.reason } satisfies PaneZoomed);
      }
      if (pathname === "/api/pane/clear") {
        await paneClear(paneId);
        return jsonResponse({ ok: true });
      }
      if (pathname === "/api/pane/swap") {
        if (payload.target_pane_id !== undefined && payload.direction !== undefined) return badRequest("invalid_pane_swap", "provide exactly one of direction or target_pane_id");
        if (payload.target_pane_id !== undefined) {
          if (typeof payload.target_pane_id !== "string" || !payload.target_pane_id.trim()) return badRequest("invalid_target_pane_id", "target_pane_id must be a non-empty string");
        } else if (!isPaneDirection(payload.direction)) return badRequest("invalid_direction", "direction must be left, right, up or down");
        const swap = typeof payload.target_pane_id === "string"
          ? await paneSwapWith(paneId, payload.target_pane_id)
          : await paneSwap(paneId, payload.direction as PaneDirection);
        return jsonResponse({ ok: true, changed: swap.changed, reason: swap.reason, target_pane_id: swap.target_pane_id } satisfies PaneSwapped);
      }
      if (!isPaneDirection(payload.direction)) return badRequest("invalid_direction", "direction must be left, right, up or down");
      // a share of the split the border belongs to, as herdr counts it, and no more than the
      // half herdr would quietly cap it to (shared/protocol.ts); its own default when absent
      if (payload.amount !== undefined && !(typeof payload.amount === "number" && Number.isFinite(payload.amount) && payload.amount > 0 && payload.amount <= 0.5)) {
        return badRequest("invalid_amount", "amount must be a number above 0 and at most 0.5");
      }
      const resize = await paneResize(paneId, payload.direction, payload.amount);
      return jsonResponse({ ok: true, changed: resize.changed, reason: resize.reason } satisfies PaneResized);
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api/pane/image") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    let payload: { pane_id?: string; content_type?: string; data_base64?: string; name?: string };
    try {
      payload = JSON.parse(await readImageBody(request)) as typeof payload;
    } catch (error) {
      if (error instanceof PasteImageError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
      return badRequest("invalid_json", "request body must be JSON");
    }
    if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
    if (typeof payload.pane_id !== "string" || !payload.pane_id.trim()) return badRequest("missing_pane_id", "pane_id is required");
    if ((payload.content_type !== undefined && typeof payload.content_type !== "string")
      || (payload.data_base64 !== undefined && typeof payload.data_base64 !== "string")
      || (payload.name !== undefined && typeof payload.name !== "string")) {
      return badRequest("invalid_image", "content_type, data_base64 and name must be strings");
    }
    try {
      const path = await savePaneImage({
        paneId: payload.pane_id,
        contentType: payload.content_type ?? "",
        dataBase64: payload.data_base64 ?? "",
        name: payload.name,
      });
      return jsonResponse({ ok: true, path });
    } catch (error) {
      if (error instanceof PasteImageError) {
        return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
      }
      return errorResponse(error);
    }
  }
  return null;
}
