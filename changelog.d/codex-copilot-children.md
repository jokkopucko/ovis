### Added
- An agent that asks another one through Ovis can now start Codex (through `codex-acp`) or the
  Copilot CLI as the helper, each in its strictest asking setup: you approve every write,
  side-effecting command, web request and tool call, except what your own allow rules in that agent (yours or a project
  folder's) already allow. Settings says so under the agents they may call.
