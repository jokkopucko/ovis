# Set up a PC with a coding agent

A coding agent on a new PC (Claude Code, Codex, any agent with a shell) can install Ovis there, leave it
running and add the PC to your Ovis account, with nothing for you to type on that PC. It follows the
[ovis-setup skill](../skills/ovis-setup/SKILL.md), which it reads from this repository.

## What to give it

- **Your account's id**: **Settings → Manage account → Account ID** in the Ovis app, or `ovis status` on a PC
  already in your account.
- **An invite**, the quickest way: on a device signed in to your account, make one. It is one line that starts
  with `ovis-join:1:`, and it works once, for 15 minutes. With it the PC joins your account with no sign-in.

Then paste this to the agent on the new PC, with your id and the invite in place of the brackets:

> Set up Ovis on this PC and add it to my Ovis account, following
> https://github.com/devswha/ovis/blob/main/skills/ovis-setup/SKILL.md. My account id is `<id>`. The invite is
> `<ovis-join:1:…>`.

Without an invite, leave out the last sentence: the agent then gives you an address and a code, you sign in
there on any device, and press **Add** for the PC in Ovis.

## What happens

The agent puts the invite in a file only your user can read and runs the one-line installer with it in the
background (on Linux and macOS `install.sh --join-file <file> --account <id>`, on Windows `install.ps1
-JoinFile <file> -Account <id>`). The installer leaves Ovis running and runs `ovis join`, which takes the
invite from that file, never from a command line. An invite that asks for **Add** shows a card on your
devices: the agent tells you to press it. Then the agent deletes the file, checks the PC with `ovis status
--json` (the account it is in, and its relay online), and tells you what runs.

When something goes wrong, it says what in one line and does what the skill says for it: a used or expired
invite needs a new one, a PC already in another account waits for your word, and an account service that
did not answer is tried again within the invite's 15 minutes.

The agent never shows the invite again (it works once, so the copy in your chat is spent once the PC
joined), never takes a PC out of an account without asking you, never answers a question that is yours
(an **Add**, a code, a number), and never uses `sudo`.

## Keeping the skill at hand

An agent that reads skills from a folder finds it there by itself, so "set up Ovis on this PC" is enough:

```bash
# Claude Code
mkdir -p ~/.claude/skills/ovis-setup && curl -fsSL https://raw.githubusercontent.com/devswha/ovis/main/skills/ovis-setup/SKILL.md -o ~/.claude/skills/ovis-setup/SKILL.md
# Codex, OpenCode and other agents that read ~/.agents/skills
mkdir -p ~/.agents/skills/ovis-setup && curl -fsSL https://raw.githubusercontent.com/devswha/ovis/main/skills/ovis-setup/SKILL.md -o ~/.agents/skills/ovis-setup/SKILL.md
```

[INSTALL.md](../INSTALL.md) covers every other way to install, step by step.
