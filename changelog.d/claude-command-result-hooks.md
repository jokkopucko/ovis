### Changed
- In a Claude Ovis started, a `/compact`, a `/clear` and a skill or custom command sent from Chat are marked done
  as soon as Claude's own hooks say they ran (its PostCompact, SessionStart and UserPromptExpansion hooks), instead
  of waiting for the transcript; a `/compact` that finishes after the next message was sent is still marked done.
