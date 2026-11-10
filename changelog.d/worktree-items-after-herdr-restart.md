### Fixed
- After herdr restarts, the sidebar's row menu and the command palette no longer offer New worktree
  and Open worktree… for a moment on the earlier herdr's answer, which may be about another folder
  under the same workspace ID: the items come back once the new herdr's folder is checked.
- A workspace folder whose check for a git repository failed is no longer checked again each time
  workspaces change places or its PC is selected, only when the PC's workspaces change, the PC
  reconnects or herdr restarts.
