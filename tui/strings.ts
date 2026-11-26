/**
 * Every user-facing English string of the terminal screen, kept in one module so translations can
 * follow later and the wording conventions scan (src/conventions.test.ts) checks them in one place.
 */

/** A fallback key the config's own bindings hold, and what holds it. */
interface HeldKey { readonly key: string; readonly holder: string }

const heldKeys = (skipped: readonly HeldKey[]): string => skipped.map(({ key, holder }) => `${key}->${holder}`).join(", ");

export const STRINGS = {
  // Sidebar & header
  sessionHeader: (session: string): string => `hc:${session}`,
  /** herdr's lower-case words in the sidebar (C2); the switcher keeps the web's `Agents` */
  workspacesSection: "spaces",
  sidebarAgents: "agents",
  agentsSection: "Agents",
  noSpaces: "No workspaces",
  noAgents: "No agents",
  /** at the right of the agents' header: how the list is ordered */
  agentsSort: "grouped",
  /** the workspaces' footer: a new workspace at the left, the menu at the right */
  newWorkspaceButton: " new",
  sidebarToggleCollapse: "«",
  sidebarToggleExpand: "»",

  // Tab bar
  tabZoomSuffix: " Z",
  newTabButton: " + ",
  tabsBefore: " < ",
  tabsAfter: " > ",
  tabsCut: "…",

  // State words (matching src/lib/inboxRow.ts and DESIGN.md)
  stateBlocked: "Needs you",
  stateWorking: "Working",
  stateDone: "Done",
  stateIdle: "Ready",

  // State glyphs (never colour alone)
  glyphBlocked: "!",
  glyphDone: "*",
  glyphWorking: "~",
  glyphIdle: "-",
  glyphUnknown: "·",
  /** herdr's state dots in the sidebar (S8) */
  dotFull: "●",
  dotEmpty: "○",

  // Mode bar labels
  modeTerminal: "TERMINAL",
  modePrefix: "PREFIX",
  modeNavigate: "NAVIGATE",
  modeResize: "RESIZE",
  modeCopy: "COPY",
  copyNoHints: "No hints",
  modeLocked: "LOCKED",
  errorBadge: "ERROR",

  // Visible states & banners
  offlineTitle: "herdr-core is not answering",
  offlineCommand: "hc server start",
  offlineDetail: (code: string | null): string => `${STRINGS.offlineTitle}: ${STRINGS.offlineCommand}${code ? ` (${code})` : ""}`,
  offlinePaneBanner: (): string => `${STRINGS.offlineTitle} · ${STRINGS.offlineCommand}`,
  appOwnedCore: "the Herdr app arranges this core",
  emptyCoreTitle: "No workspaces yet",
  emptyCoreOffer: (folder: string, key: string | null): string => `New workspace in ${folder}${key === null ? "" : ` (${key})`}`,


  // Pane states & border notices
  endedCode: (code: number | null): string => `ended (${code ?? "none"})`,
  waitingNewShell: "waiting for its new shell",
  sizedByViewer: (cols: number, rows: number): string => `sized by another viewer (${cols}x${rows})`,
  waitingOffline: "waiting for herdr-core",
  waitingClosed: "stream closed",
  openingPane: "opening terminal",
  paintingPane: "loading screen",
  closingPane: "closing stream",
  failedPane: (reason: string): string => `failed: ${reason}`,
  idlePane: "not attached",

  // Mode bar hints (tui/model/hints.ts names them); an action the key table names keeps its word from `actions`
  modeHints: {
    cancel: "cancel",
    sendPrefix: "send prefix",
    workspaceNav: "navigate",
    keybinds: "help",
    escBack: "esc back",
    workspace: "workspace",
    pane: "pane",
    width: "width",
    height: "height",
    done: "done",
    move: "move",
    search: "search",
    repeat: "repeat",
    select: "select",
    selecting: "selecting",
    copy: "copy",
    exit: "exit",
    clearExit: "clear  q exit",
    unlock: "unlock",
  },
  copySearchFooter: "  enter search  esc cancel",

  // Overlays
  helpTitle: "Keyboard Shortcuts",
  helpUnset: "unset",
  /** the help's close button at its top right, its filter row and its foot, as herdr's */
  helpClose: "  esc close  ",
  /** while the filter is typed: the button that leaves it, and the foot's editing keys */
  helpBack: "  esc back   ",
  helpFilterFooter: " edit ←→/home/end · kill ^u/^k · yank ^y · scroll ↑↓ · back esc",
  helpFilterHint: " / press / to filter by command or shortcut",
  helpFooter: " search / · scroll j/k/↑↓/pgup/pgdn · close esc/enter",
  /** the help's section headings, in herdr's words */
  helpHeadings: { global: "global", navigation: "navigation", workspaces: "workspaces / tabs", panes: "panes" },
  /** the help's words for each command, herdr's but for its own name (C2: herdr says `keybinds`) */
  helpWords: {
    prefix: "prefix mode", help: "help", settings: "settings", detach: "detach", reload_config: "reload config",
    open_notification_target: "open notification target",
    navigate_cancel: "back", navigate_workspace_up: "workspace list", navigate_pane_left: "move focus", navigate_cycle_next: "cycle pane",
    navigate_focus: "open workspace", navigate_index: "switch workspace",
    workspace_picker: "workspace navigation", goto: "session navigator", new_workspace: "new workspace", new_worktree: "new worktree",
    open_worktree: "open worktree", remove_worktree: "delete worktree checkout", rename_workspace: "rename workspace",
    close_workspace: "close workspace", previous_workspace: "previous workspace", next_workspace: "next workspace",
    switch_workspace: "switch workspace 1-9", previous_agent: "previous agent", next_agent: "next agent", focus_agent: "focus agent 1-9",
    new_tab: "new tab", rename_tab: "rename tab", previous_tab: "previous tab", next_tab: "next tab", move_tab_previous: "move tab left",
    move_tab_next: "move tab right", switch_tab: "switch tab 1-9", close_tab: "close tab",
    split_vertical: "split vertical", split_horizontal: "split horizontal", close_pane: "close pane", rename_pane: "rename pane",
    edit_scrollback: "edit scrollback", clear_pane: "clear pane", copy_mode: "copy mode", zoom: "zoom pane", resize_mode: "resize mode",
    resize_pane_left: "resize pane left", resize_pane_down: "resize pane down", resize_pane_up: "resize pane up",
    resize_pane_right: "resize pane right", toggle_sidebar: "toggle sidebar", focus_pane_left: "focus pane left",
    focus_pane_down: "focus pane down", focus_pane_up: "focus pane up", focus_pane_right: "focus pane right",
    cycle_pane_next: "cycle pane next", cycle_pane_previous: "cycle pane previous", last_pane: "last pane",
  },
  /** a dialog's buttons, each naming its key */
  saveButton: " ↵ save ",
  clearButton: " ^c clear ",
  cancelButton: " esc cancel ",
  confirmButton: " ↵ confirm ",
  newWorktreeTitle: "new worktree",
  newWorktreeBranch: "branch",
  newWorktreeCheckout: "checkout",
  newWorktreeButton: "↵ create and open",
  removeWorktreeTitle: "delete worktree checkout?",
  removeWorktreeFolder: "This removes the checkout folder:",
  removeWorktreeKept: "The branch is not deleted. The workspace will close.",
  removeWorktreeButton: "↵ remove",
  /** the copy feedback toast: its mark and its text are the notice's own (noticeText "copied") */
  toastMark: "●",
  helpRefusalsTitle: "Config Diagnostics",
  helpMoreRefusals: (more: number): string => `+${more} more config diagnostics`,
  textRenameWorkspace: "Rename workspace",
  textRenameTab: "Rename tab",
  textRenamePane: "Rename pane",
  textNewTab: "New tab name",
  confirmCloseTitle: "Close workspace?",
  confirmCloseDetail: (name: string, panes: number): string => `${name} — ${panes} ${panes === 1 ? "pane" : "panes"}`,
  gotoTitle: "Go to",
  /** herdr's picker: its search hint, the count at its right, the mark of the terminal in front, the words of a plain terminal, and its foot */
  pickerSearchHint: " / search agents and terminals",
  pickerCount: (count: number): string => `${count} ${count === 1 ? "terminal" : "terminals"}`,
  pickerFront: "◆",
  pickerTerminal: "terminal",
  pickerShell: "shell",
  /** herdr's foot but its state filters (a/b/w/i/d), which the screen has not */
  pickerFooter: " ↑↓/j/k rows · ←→ workspace · / search · enter open · esc close",
  pickerSearchFooter: " edit ←→/home/end · kill ^u/^k · yank ^y · scroll ↑↓ · back esc",
  menuTitle: "menu",
  /** herdr's menu entries; the keys' help keeps the screen's word for it (C2: herdr says `keybinds`) */
  menuEntries: { settings: "settings", help: "help", reload_config: "reload config", detach: "detach" } as const,
  /** the right-click menus' entries (tui/model/context.ts), as herdr writes them */
  contextEntries: {
    rename_pane: "Rename pane",
    clear_pane_name: "Clear pane name",
    swap_with_focused: "Swap with focused pane",
    split_vertical: "Split right",
    split_horizontal: "Split down",
    zoom: "Zoom",
    passthrough_on: "Send right-clicks to pane",
    passthrough_off: "Use the right-click menu",
    close_pane: "Close pane",
    new_tab: "New tab",
    rename_tab: "Rename",
    close_tab: "Close",
    rename_workspace: "Rename",
    close_workspace: "Close",
    open_worktree: "Open worktree...",
    close_group: "Close group",
    new_worktree: "New worktree",
    delete_checkout: "Delete worktree checkout...",
    collapse_group: "Collapse",
    expand_group: "Expand",
  } as const,
  /** Open worktree... */
  worktreesTitle: "open worktree",
  worktreesFilterHint: " / filter worktrees",
  worktreesCount: (count: number): string => `${count} ${count === 1 ? "checkout" : "checkouts"}`,
  worktreesOpen: "open",
  worktreesOpenButton: "  ↵ open  ",
  /** a repository's workspace with its worktree workspaces: folded, unfolded */
  groupCollapsed: "▸",
  groupExpanded: "▾",
  confirmCloseGroupTitle: "Close worktree group?",
  confirmCloseGroupDetail: (name: string, spaces: number, panes: number): string => `${name} — ${spaces} ${spaces === 1 ? "workspace" : "workspaces"}, ${panes} ${panes === 1 ? "pane" : "panes"}`,
  /** at the right of the narrow screen's header, which opens the menu */
  /** herdr's narrow header and switcher */
  narrowTab: (name: string, of: string | null): string => `tab ${name}${of === null ? "" : ` · ${of}`}`,
  switchButton: "switch",
  switcherClose: "close",
  switcherCloseMark: "×",
  switcherSpaces: "spaces",
  switcherTabs: "tabs",
  switcherMenu: "menu",
  switcherNewWorkspace: "new workspace",
  switcherNewTab: "new tab",
  /** herdr's name for the PC a workspace runs on; the screen reaches this PC's herdr-core alone */
  switcherHost: "Local",
  /** what kind of place a menu entry goes to */

  // Keymap notes in help & mode bar
  notePrefixFallback: (binding: string, fallback: string): string =>
    `prefix_fallback: ${binding} cannot be typed; using ${fallback}`,
  notePrefixUnreachable: (binding: string, skipped: readonly HeldKey[]): string =>
    `prefix_unreachable: ${binding} cannot be typed and all fallbacks are held (${heldKeys(skipped)}); use menu or close terminal`,
  noteDetachFallback: (fallback: string): string =>
    `detach_fallback: detach uses ${fallback}`,
  noteDetachUnreachable: (skipped: readonly HeldKey[]): string =>
    `detach_unreachable: no key can detach (${heldKeys(skipped)}); use action detach or close terminal`,
  noteLockTaken: (holder: string): string => `lock_taken: lock key held by ${holder}`,
  noteTaken: (action: string, binding: string, holder: string): string =>
    `taken: ${action} (${binding}) held by ${holder}`,
  noteDropped: (code: string, action: string, binding: string): string =>
    `${code}: ${action} (${binding}) cannot fire`,
  noteIndexedLegacy: (entry: string): string => `indexed_legacy: [keys.indexed].${entry} is ignored`,
  noteBlankBinding: (action: string): string => `blank_binding: ${action} unbound by blank entry`,
  refusalLine: (code: string, action: string, binding: string, holder: string | null): string =>
    `${code}: ${action} = ${binding}${holder === null ? "" : ` (held by ${holder})`}`,

  // Notice messages by code
  noticeText: (code: string, data: Readonly<Record<string, string | number>>): string => {
    switch (code) {
      case "ovis_server_none":
        return `${data["action"] === "delete_checkout" ? "Delete worktree checkout" : "New worktree"} needs the Ovis server: start it with \`ovis start\``;
      case "ovis_server_address":
        return "ovis_server_address: the Ovis server's address is not this PC's loopback; it was not asked";
      case "ovis_desktop_not_running":
        return "The Ovis desktop app is not running. Open it, then reopen this terminal screen.";
      case "ovis_desktop_changed":
        return "The Ovis desktop app stopped or restarted. Reopen this terminal screen while the app is running.";
      case "ovis_server_refused":
        return `${data["code"] ?? "refused"}: ${data["message"] || "the Ovis server refused it"}`;
      case "not_linked_worktree":
        return "not_linked_worktree: this workspace is not a linked worktree";
      case "ime_prefix":
        return "ime_prefix: switch to the English keyboard for prefix keys";
      case "not_built":
        return `not_built: ${data["action"] ?? "action"} is not built in this screen`;
      case "input_refused":
        return `input_refused: pane is ${data["reason"] ?? "not ready"}`;
      case "copy_unavailable":
        return "Copy mode needs a live pane";
      case "copy_no_match":
        return "No match";
      case "copied":
        return "Copied";
      case "copy_refused":
        return "Selection exceeds the clipboard limit";
      case "paste_refused":
        return `paste_refused: paste over limit (${data["length"] ?? 0} bytes)`;
      case "keys_unread":
        return "keys_unread: herdr config could not be read; using defaults";
      case "keys_refused":
        return `keys_refused: ${data["count"] ?? 0} key bindings refused or dropped`;
      case "unlocked":
        return "unlocked: lock key was unbound on reload";
      case "lock_unbound":
        return "lock_unbound: lock key is not bound";
      case "locked":
        return `locked: screen is locked (${data["action"] ?? ""})`;
      case "nothing_focused":
        return `nothing_focused: no target for ${data["action"] ?? "action"}`;
      case "nothing_waiting":
        return "nothing_waiting: no agent needs you";
      case "view_moved":
        return "view_moved: the place this core was left at is gone; showing the nearest one";
      case "first_folder_unusable":
        return `first_folder_unusable: ${data["folder"] ?? "the folder"} could not be used; the first workspace opened in the home`;
      case "view_unread":
        return `view_unread: the view kept for this core could not be read (${data["reason"] ?? "unknown"})`;
      case "view_unsaved":
        return `view_unsaved: the view could not be kept for the next run (${data["reason"] ?? "unknown"})`;
      case "target_gone": {
        const detail = Object.entries(data).map(([k, v]) => `${k}=${v}`).join(" ");
        return `target_gone: ${detail || "target closed"}`;
      }
      default: {
        const detail = Object.entries(data).map(([k, v]) => `${k}=${v}`).join(" ");
        return detail ? `${code}: ${detail}` : code;
      }
    }
  },
} as const;
