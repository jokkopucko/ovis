# Agent install catalog

[`shared/agent-catalog.ts`](../shared/agent-catalog.ts) lists every agent Ovis can install: each
supported coding agent and the always-on assistants. For each it holds the vendor's own install
command per platform (macOS, Linux, Windows), what that command needs on the PC, how Ovis tells the
agent is installed (its binary and version flag), how it is signed in to afterwards, and the oldest
version an Ovis feature for it needs. `GET /api/agent-catalog` answers it for the PC that is asked,
with what is installed there (see `shared/protocol.ts`). A version flag gets 5 s to answer; an agent
whose flag is slower (Hermes loads the whole agent for it) sets `detect.version_timeout_ms`, at most
30 s. The first catalog read waits for every agent's flag, so it can take that long.

A version is read only from what the version flag prints on stdout when it succeeds. A flag that
exits with an error or does not start is `version_error: "failed"`, and one that hangs is
`"timeout"`: such an agent is there but does not run (`agentRuns()`), as a wrapper whose target was
removed leaves it, and no screen offers it as ready. Its error text is never read for a version.

## What may go in

- **Only the vendor's own command**, copied from the vendor's current docs. `sources` names each
  page it was read from and the date (`checked`). A command from a blog, a gist or a mirror never
  goes in, even when it works.
- **Only the vendor's own addresses and packages.** Every URL a command fetches must be HTTPS and
  start with one of the entry's `url_prefixes` (a host and a path on it, never a whole shared host
  such as `raw.githubusercontent.com`), and every npm, brew, winget, uv or pipx package it installs
  must be in `packages`. No command uses `sudo`. Every command must also be in `APPROVED_COMMANDS` for its
  platform, byte for byte: no shell is parsed, so no suffix, version, argument or space can be added.
  A changed or new command is changed in that list too, after reading the vendor's page. `commandProblems()` checks all of this, and
  `shared/agent-catalog.test.ts` holds every entry to it; the install flow checks a command again
  before it runs it.
- **No command where the vendor publishes none.** That platform's `install` is `null` and
  `no_install` says why (Muse Code everywhere today).
- **What goes wrong, in plain words.** A failure on a clean PC goes in that command's
  `known_issues` with what to do instead (Letta Code on Linux: npm needs `make` and a C++ compiler),
  and what to do after installing goes in `after_install`. A workaround the vendor does not document
  (`npm install --ignore-scripts`) may be named there, never shipped as the command.

## Keeping it current

Vendors change their install commands. When one changes, or every few releases:

1. Open each `sources` page and compare its command with the catalog's, word for word. Update the
   command, `url_prefixes` or `packages`, and the `checked` date of the page you read.
2. Run the command on a clean PC of each platform it is listed for, and record the run in its
   `tested` list: the date, the PC (`docker ubuntu:24.04 x64, no Node, non-root user`), `ok` or
   `failed`, and a note. A run is `ok` only when the agent then answers its version flag.
   - Linux: a fresh container per command (`ubuntu:24.04` with only curl, git, tar and unzip; a
     `node:24-bookworm-slim` one, without build tools, for npm commands), run as a normal user.
   - macOS: the maintainers' test Mac (`ssh eamac`), with a throwaway `HOME` under `/tmp` per
     command, deleted afterwards.
   - Windows: the Windows VM (`ssh winvm`), lease it, run in its desktop session, then
     `winvm reset`. Commands run there as an elevated user.
3. `bun test shared/agent-catalog.test.ts server/agent-catalog-detect.test.ts server/agent-catalog-routes.test.ts`.

## Detection

The server looks for an agent's binary on its own `PATH`, then on the `PATH` its user's login shell
sets (read at most once a minute, and again for an agent an install just put in its installer's
folder, at most every 30 s while that PATH still misses it; not on Windows). Most installers put agents in `~/.local/bin` or
the like, which a login shell adds and a server run as a service often lacks: without the second
look, an agent that was just installed would read as not installed. It runs the binary's version
flag with no input and a 5 s limit (longer where the entry sets `detect.version_timeout_ms`), and reads the first dotted version it prints. A version is kept until the executable file changes (path, size or
modification time), so an install or update shows on the next read; a run that times out is tried
again after a minute. On Windows, Command Code's `cmd` is the name of Windows' own command prompt,
so Ovis does not say whether it is installed there.
