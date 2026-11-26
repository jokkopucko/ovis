### Added
- An agent setup skill, `skills/ovis-setup/SKILL.md`: a coding agent on a new PC installs Ovis, leaves it
  running and adds the PC to your Ovis account with an invite you made (or a sign-in when there is
  none), with no questions in a terminal, and checks it with `ovis status --json`. It keeps the invite
  in a file only you can read and deletes it after. [docs/agent-setup.md](docs/agent-setup.md) has the
  one sentence to paste to the agent.
