---
name: ovis-setup
description: Installs Ovis on this PC, leaves it running, and adds the PC to the person's Ovis account, with an invite they made (ovis join, no sign-in on the PC) or with a sign-in when there is no invite (ovis add), then checks it with ovis status --json. Use when the person asks to install or set up Ovis on a PC, to add this PC to their Ovis account, to use an Ovis invite (a line that starts with ovis-join:1:), or why a PC does not show in My PCs.
---

# ovis-setup

Run this on the PC to add, as the person who uses it: never as root, never with `sudo`. Every step is safe
to run again: the installer keeps what is there, and a PC already in the account stays in it. Nothing below
waits for anyone to type in a terminal: you pass the answers as flags, and what only the person may decide,
you ask them in the chat. The guides for people are [INSTALL.md](../../INSTALL.md) and
[docs/agent-setup.md](../../docs/agent-setup.md).

## What you need from the person

- **Their Ovis account's id.** In the Ovis app: **Settings → Manage account → Account ID**; or `ovis status
  --json` on a PC already in the account (`account`). The whole id, or its first 12 characters. Never guess
  it, and never take it from an invite.
- **An invite, if they have one.** One line that starts with `ovis-join:1:`, made in Ovis on a device signed
  in to their account. It works once, for 15 minutes. Without one, follow [No invite](#no-invite).

If you lack the id, ask for it (and for an invite) in one message before you install anything.

## Rules

- **The invite is a key to the account's list of PCs.** Never print it, repeat it, put it on a command line
  (`--join <line>` shows in the process list to every user of the PC), in a log, a commit or a message.
  It goes into a file only the person can read, and you delete that file when you are done.
- **Never run `ovis logout` on a PC that is in another account**, or anything else that takes a PC out of
  an account, unless the person says so for this PC, after you told them which account it is in.
- **Never pass `--takeover`** to anything: it cuts off whoever holds a terminal.
- **Never answer for the person.** A sign-in code, an **Add** press, a `yes`, six digits or a number to
  confirm are theirs to enter. Relay what Ovis prints and wait.
- **Never use `sudo`, and never stop herdr** (`herdr server stop`) or the person's terminals. When the
  installer names an administrator's command (lingering), tell the person; do not run it.
- **On Windows, never pass `-Headless` without asking:** herdr then runs with no desktop, where programs in
  its terminals cannot use one and some Codex commands fail.

## With no terminal

Your tool's shell is no terminal: nobody can type there. Ovis asks a person to confirm the account a PC goes
into (whoever made an invite, or signed in with a code, chose that account), and only a terminal can answer.
So, without the account's id:

- a join (`--join-file`, `OVIS_JOIN`) is refused before anything is installed: `a join where nobody can answer
  needs the account the invite is for: add --account <id> …`;
- `--add` installs and then only prints the command to add the PC;
- `ovis join` and `ovis add` run alone refuse in one line (`ovis join` exits 4).

`--account <id>` (Windows `-Account <id>`) is that confirmation: the id the person gave you. Never pipe
`yes` or anything else into Ovis to answer a question. If a line says the step **needs a terminal** (over
SSH, `ssh -t`), the person runs it at the PC themselves.

## Steps

1. **Which system.** `uname -s`: `Linux` or `Darwin` use the `sh` commands below. `$env:OS` is `Windows_NT`
   in PowerShell, or `uname -s` starts with `MINGW`, `MSYS` or `CYGWIN`: use the PowerShell commands, run in
   PowerShell. Anything else: tell the person Ovis installs on Linux, macOS and Windows x64, and stop.
2. **Already set up?** Run `~/.local/bin/ovis status --json` (Windows:
   `& "$env:LOCALAPPDATA\ovis\cmd\ovis.cmd" status --json`).
   - Not found, `"running": false`, or `"account": null`: go on.
   - `account` is the person's id: the PC is in. Do not use the invite (tell the person it stays unused, and
     runs out by itself); go to step 6.
   - Another `account`: stop. Tell the person its first 12 characters and ask what to do (see the rules).
3. **The invite file.** Make an empty file only the person can read, then write the one line into it with
   your file-writing tool (never `echo`, `printf` or a heredoc in a shell command):
   `install -m 600 /dev/null ~/.ovis-invite`, then check `ls -l ~/.ovis-invite` reads `-rw-------`.
   On Windows write `$HOME\.ovis-invite` (the profile folder is the person's own). If the person gave you a
   file that holds the invite, use its path instead.
4. **Install and join**, in the background with the output in a file: an invite that needs **Add** waits up to
   10 minutes for it, and a tool call can end before.

   ```bash
   nohup sh -c 'curl -fsSL https://ovis.sh/install.sh | sh -s -- --join-file "$HOME/.ovis-invite" --account <id>; echo "install-exit=$?"' >"$HOME/ovis-install.log" 2>&1 </dev/null &
   ```

   ```powershell
   Start-Process powershell -WindowStyle Hidden -RedirectStandardOutput "$HOME\ovis-install.log" -RedirectStandardError "$HOME\ovis-install.err" -ArgumentList '-NoProfile -Command try { & ([scriptblock]::Create((irm https://ovis.sh/install.ps1))) -JoinFile $HOME\.ovis-invite -Account <id>; Write-Output install-exit=0 } catch { Write-Output $_; Write-Output install-exit=1 }'
   ```

   (Keep the `-ArgumentList` string free of double quotes: Windows PowerShell joins it unquoted.) Read the
   log every few seconds (`tail -n 30 ~/ovis-install.log`; Windows `Get-Content $HOME\ovis-install.log
   -Tail 30`) until its last line is `install-exit=<n>`, for at most 15 minutes.
   - It says `press Add for <name>`: tell the person to open Ovis on a phone or computer signed in to that
     account and press **Add** for `<name>` (its card shows for 10 minutes).
   - `install-exit=0`, and the last `Ovis:` line reads `this PC is in the Ovis account the invite is for`:
     go on.
   - Anything else: [When it fails](#when-it-fails), by the last `Ovis:` line.
5. **Delete the invite file** (`rm -f ~/.ovis-invite`; Windows `Remove-Item $HOME\.ovis-invite`) once the PC
   is in the account, or once the invite cannot work any more (used, refused, or 15 minutes gone). Keep it
   only to run the same line again within those 15 minutes.
6. **Check.** `ovis status --json` as in step 2. Done when all of these hold:
   - `"running": true`;
   - `"account_known": true`, and `account` is the person's id (all of it, or it starts with the 12
     characters they gave);
   - `relay.connected` is `true` (`relay.phase` is `"online"`). It turns true within about 30 seconds of the
     join: ask again every 5 seconds for up to a minute. If it stays false, the PC is in the account all the
     same: report it as added, its relay still connecting;
   - `waiting_for_add` is `false` (`true` means a card still waits for **Add**).
7. **Report** (below).

To install with no account at all, run the same line with no flags.

## No invite

Steps 1, 2 and 6 as above, with no file. The line adds the PC with a sign-in instead:

```bash
nohup sh -c 'curl -fsSL https://ovis.sh/install.sh | sh -s -- --add --account <id>; echo "install-exit=$?"' >"$HOME/ovis-install.log" 2>&1 </dev/null &
```

On Windows, the PowerShell line of step 4 with `-Add -Account <id>` in place of `-JoinFile … -Account <id>`.
As soon as the log shows `1. On any device, open: <address>` and `2. Enter this code: <code>` (or `Opening
your browser at:` on a PC with a desktop), give the person both in one message: they open the address on any
device, check the code, sign in with GitHub or Google, and then press **Add** for this PC in Ovis on a device
of that account. `install-exit=0` and `Added. Open (this PC) from My PCs.` mean the PC is in: check it as in
step 6.
On an account with a signed member list, the add then shows a number: the person compares it with the one
their device shows and confirms it at this PC with `ovis add --confirm <number>`; relay the number, and never
type it for them.

## When it fails

The installer exits 1 (on Windows it throws: `install-exit=1`) whenever the PC did not join, or was not added;
its last `Ovis:` line says why, and the lines above it hold what `ovis join` or `ovis add` said. The Windows
lines read the same with `-Account`, and `Settings -> Updates`; there, what is refused before anything is
installed is the error line itself, just before `install-exit=1`, with no `Ovis:` and a capital first letter
(`That is not an Ovis invite`, `A join where nobody can answer …`). Match the lines regardless of case.

| The last `Ovis:` line starts with | What to do |
| --- | --- |
| `that is not an Ovis invite` (nothing installed) | The file does not hold one whole line: the copy lost a part, or broke it. Ask the person for the invite again (a new one after 15 minutes). |
| `a join where nobody can answer needs the account` (nothing installed) | Add `--account <id>`; ask for the id if you do not have it. |
| `give the invite one way only`, `--join-file names no file`, `a join adds this PC with an invite, and --add` (nothing installed) | Fix the line: one `--join-file` with the path of the file you wrote, and no `--add` or `OVIS_ADD`. |
| `the invite did not work: it is mistyped, used or expired` | Ask the person for a new invite; never run the same one again. |
| `the invite is for another Ovis account than --account names` | Stop and ask: the id and the invite do not belong together (a mistyped id, or someone else's invite). Nothing was used. |
| `this PC is in another Ovis account` | Stop and ask, naming the first 12 characters of `account` from `ovis status --json`. Only on the person's word for this PC: `ovis logout`, then the same line again within the invite's 15 minutes (it was not used). |
| `the account service did not answer` | Run the same line again in a minute, while the invite's 15 minutes last; after that, ask for a new invite. |
| `the account service asks this PC to wait` | Wait as long as the line above it says, then run it again; a new invite once 15 minutes are gone. |
| `your Ovis account has added as many PCs as it may for now` | Tell the person; it works again later, with a new invite. |
| `your Ovis account holds as many PCs as it can` | Tell the person to remove a PC in the Ovis app, then ask for a new invite. |
| `nobody pressed Add for this PC while its card showed` | Ask for a new invite, and tell the person to press **Add** as soon as the card shows. |
| `the account the invite is for was not confirmed` | Nobody answered yes at a terminal: run the line with `--account <id>`. |
| `the relay or the account service is off on this PC` | Tell the person what `ovis join` said above it (a setting of theirs turns the account service off); do not change their settings. |
| `the app is not running`, `the app stopped running`, `herdr did not start` | Read the installer's herdr lines above. On Windows, `nobody of this account is signed in at this PC`: ask the person to sign in at the PC, or ask before `-Headless`. Once `ovis status --json` says `"running": true`, run the `ovis join --invite-file …` (or `ovis add --account …`) the line names. |
| `this Ovis release has no ovis join`, `this Ovis release does not check the account` | The Ovis that runs is older than 0.5.10: tell the person to update it (**Settings → Updates**), then run the command the line names. |
| `this PC was not added to your Ovis account` | Quote the add's own line above it. A sign-in or **Add** that did not come in 10 minutes: run the line again, and give the person the new code. |
| `this PC did not join your Ovis account` | Quote the `ovis join` line above it to the person. |
| `… needs a terminal` (in `ovis join`'s or `ovis add`'s line) | The person runs that step at the PC, in a terminal (over SSH, `ssh -t`). |

Not a failure: a line about lingering (`sudo loginctl enable-linger <user>`) means Ovis runs now and will not
start by itself after a restart until an administrator turns lingering on: tell the person, never run it.

## Report

Tell the person, for this PC: the system; the installer's `Ovis runs now at …` line and what it says starts
herdr again; the account (the first 12 characters of `account`); whether the relay is connected; and anything
left for them to do (an **Add** to press, a number to confirm, an administrator's command). Quote the failing
`Ovis:` line when there is one. Never include the invite, a token, or the log's other lines.
