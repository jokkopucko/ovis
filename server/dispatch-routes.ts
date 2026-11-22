/**
 * The method/path surface dispatched for an account session. A path prefix is not a
 * registration: in particular, a new control under a known prefix gets no authority.
 * Relay controls use the same registrations to select their handler.
 */
export const RELAY_CONTROLS = {
  code: "/api/relay/code", cancelCode: "/api/relay/code/cancel",
  offer: "/api/relay/offer", keep: "/api/relay/offer/keep",
  link: "/api/relay/link", close: "/api/relay/link/close",
  start: "/api/relay/start", stop: "/api/relay/stop", reset: "/api/relay/reset-identity",
  direct: "/api/relay/direct", pairing: "/api/relay/pairing", join: "/api/relay/join",
} as const;

// P5: driving the terminal on this PC, not administering its relay or other PCs.
export const LOCAL_DRIVE_POSTS: readonly string[] = [
  "pane/input", "pane/keys", "pane/find", "pane/scroll", "pane/rename", "pane/close", "pane/image",
  "pane/split", "pane/zoom", "pane/swap", "pane/move", "pane/resize", "pane/clear", "pane/focus",
  "pane/prompt/answer", "layout/ratio", "workspace/create", "workspace/rename", "workspace/close",
  "workspace/move", "workspace/directories", "workspace/pr/merge", "worktree/create", "worktree/open",
  "worktree/remove", "tab/create", "tab/rename", "tab/close", "tab/move", "tab/move-to-workspace",
  "agent/rename", "sessions/resume", "plugin/action", "seen", "connection-diagnostics",
  "agent-catalog/install", "agent-catalog/sign-in", "usage/statusline", "usage/login", "usage/login/code",
  "usage/login/cancel", "usage/accounts", "cliproxy/login", "cliproxy/callback", "voice/transcribe", "telemetry",
].map(path => `/api/${path}`);

export const DISPATCH_MUTATIONS = {
  POST: [
    ...Object.values(RELAY_CONTROLS), ...LOCAL_DRIVE_POSTS,
    "/api/devices/pair", "/api/devices/pair/start", "/api/devices/pair/cancel", "/api/devices/revoke-all",
    "/api/account/link", "/api/account/enroll", "/api/account/introduce", "/api/account/records",
    "/api/account/relay-account", "/api/account/one-press", "/api/alerts/webhook", "/api/alerts/webhook/test",
    "/api/push/subscribe", "/api/push/status", "/api/push/test", "/api/runtime",
    "/api/runtime/move", "/api/runtime/move/install", "/api/runtime/move/stop", "/api/runtime/move/stop-all",
    "/api/updates/install", "/api/updates/check", "/api/updates/cancel", "/api/herdr/update",
    "/api/account/lock", "/api/account/unlock", "/api/account/forget", "/api/account/confirm", "/api/account/leave",
    "/api/auth", "/api/portal/start", "/api/portal/stop", "/api/portal/invite",
  ],
  PUT: ["/api/alerts/webhook", "/api/fs/text", "/api/preferences", "/api/cliproxy", "/api/voice/config"],
  PATCH: ["/api/devices/:id"],
  DELETE: ["/api/devices/:id", "/api/alerts/webhook", "/api/push/subscribe", "/api/runtime/move",
    "/api/auth", "/api/usage/accounts", "/api/cliproxy", "/api/cliproxy/login"],
} as const;

export function dispatchMutationRegistered(method: string, pathname: string): boolean {
  const row = pathname.replace(/^\/api\/devices\/[0-9a-f]{16}$/, "/api/devices/:id");
  return Object.entries(DISPATCH_MUTATIONS).some(([verb, paths]) => verb === method && paths.some(path => path === row));
}

export const DISPATCH_READS: ReadonlySet<string> = new Set([
  "preferences", "seen", "session", "sessions/history", "health", "system", "herdr-ui", "devices", "access",
  "account/introduction", "account/status", "push", "relay", "updates", "updates/notes", "updates/installed", "runtime/move",
  "usage", "usage/statusline", "usage/login", "usage/login/prompt", "voice", "fonts", "cliproxy", "cliproxy/login", "telemetry",
  "agents", "agent-catalog", "integrations", "plugins/actions", "plugin/action", "agent/commands",
  "pane/read", "pane/scroll", "pane/selection", "pane/commands", "pane/files", "pane/docs",
  "pane/conversation", "pane/conversation/search", "pane/conversation/image", "pane/conversation/tool-output",
  "pane/summary", "pane/omo-tasks", "pane/background-agent", "pane/plan", "pane/artifacts", "pane/btw", "pane/prompt",
  "workspace/directories", "workspace/diff/files", "workspace/diff/file", "workspace/diff/refs",
  "workspace/git/log", "workspace/git/branches", "workspace/git/show", "workspace/pr", "workspace/pr/log",
  "worktree/list", "worktree/inventory", "fs/stat", "fs/file", "fs/favicon", "fs/text",
].map(path => `/api/${path}`));
