/**
 * The plugin routes: the actions herdr's plugins offer on this PC (GET /api/plugins/actions), running
 * one (POST /api/plugin/action) and how a run stands (GET /api/plugin/action). The dispatcher in
 * index.ts runs the access gate first.
 */
import type { PluginActionsResponse } from "../shared/plugins.ts";
import { HerdrError, pluginActionInvoke, pluginActionList, pluginList, pluginLogList, type PluginInvocationContext, sessionSnapshot } from "./herdr/client.ts";
import { badRequest, errorResponse, jsonResponse, readJsonObject, setRequestRoute } from "./http.ts";
import { PLUGIN_LOG_LIMIT, pluginActionResult, pluginLogEntry, pluginPaneContext, waitForPluginAction } from "./plugin-actions.ts";

/** How herdr's plugin manifests name the platform this server (and so its herdr) runs on. */
const PLUGIN_PLATFORM = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
const PLUGIN_ACTION_WAIT_MS = 5_000;
const livePaneIds = async (timeoutMs?: number): Promise<string[]> => (await sessionSnapshot(undefined, timeoutMs)).panes.map((pane) => pane.pane_id);

export async function handlePluginRequest(request: Request, url: URL, pathname: string, options: { pluginActionWaitMs?: number }): Promise<Response | null> {
  if (pathname === "/api/plugins/actions") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    try {
      const [plugins, actions] = await Promise.all([pluginList(), pluginActionList()]);
      const body: PluginActionsResponse = {
        plugins: plugins.map((plugin) => ({
          plugin_id: plugin.plugin_id,
          name: plugin.name,
          version: plugin.version,
          description: plugin.description ?? null,
          enabled: plugin.enabled,
          // herdr lists another platform's actions too and refuses them: platform_unsupported
          actions: actions
            .filter((action) => action.plugin_id === plugin.plugin_id && (!action.platforms || action.platforms.includes(PLUGIN_PLATFORM)))
            .map((action) => ({ action_id: action.action_id, title: action.title, description: action.description ?? null, contexts: action.contexts ?? [] })),
        })),
      };
      return jsonResponse(body);
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api/plugin/action" && request.method === "GET") {
    setRequestRoute(pathname);
    const pluginId = url.searchParams.get("plugin_id");
    const logId = url.searchParams.get("log_id");
    if (!pluginId) return badRequest("missing_plugin_id", "plugin_id is required");
    if (!logId) return badRequest("missing_log_id", "log_id is required");
    try {
      const log = await pluginLogEntry(logId, (limit) => pluginLogList(pluginId, limit));
      return jsonResponse(await pluginActionResult(log, () => livePaneIds()));
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api/plugin/action") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use GET or POST");
    const payload = await readJsonObject<{ plugin_id?: unknown; action_id?: unknown; pane_id?: unknown }>(request);
    if (payload instanceof Response) return payload;
    if (typeof payload.plugin_id !== "string" || payload.plugin_id.length === 0) return badRequest("missing_plugin_id", "plugin_id is required");
    if (typeof payload.action_id !== "string" || payload.action_id.length === 0) return badRequest("missing_action_id", "action_id is required");
    if (payload.pane_id !== undefined && (typeof payload.pane_id !== "string" || payload.pane_id.length === 0)) return badRequest("invalid_pane_id", "pane_id must be a pane's ID");
    try {
      let context: PluginInvocationContext | undefined;
      if (payload.pane_id !== undefined) {
        const snapshot = await sessionSnapshot();
        const pane = snapshot.panes.find((entry) => entry.pane_id === payload.pane_id);
        // herdr would run the action with whatever ID it was handed
        if (!pane) throw new HerdrError("pane_not_found", `pane ${payload.pane_id} not found`);
        context = pluginPaneContext(snapshot, pane);
      }
      const pluginId = payload.plugin_id;
      const invoked = await pluginActionInvoke(pluginId, payload.action_id, context);
      return jsonResponse(await waitForPluginAction(
        invoked.log,
        options.pluginActionWaitMs ?? PLUGIN_ACTION_WAIT_MS,
        (timeoutMs) => pluginLogList(pluginId, PLUGIN_LOG_LIMIT, undefined, timeoutMs),
        livePaneIds,
      ));
    } catch (error) {
      return errorResponse(error);
    }
  }
  return null;
}
