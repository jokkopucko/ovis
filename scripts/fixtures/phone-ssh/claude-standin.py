#!/usr/bin/python3
# Stand-in for Claude Code in the phone-ssh fixture (no network, no credentials, no real model).
# Installed as /usr/local/bin/claude, so the kernel names the process `claude` and herdr and Ovis
# take it for Claude. It keeps what Ovis reads from a real Claude:
#   - the PID record ~/.claude/sessions/<pid>.json naming its session (procStart = /proc start ticks),
#   - the transcript ~/.claude/projects/<cwd slug>/<session>.jsonl in Claude's record format,
#   - Claude 2.1.311's AskUserQuestion menu on the terminal (hint "Enter to select · ↑/↓ to navigate · Esc to cancel"),
# and reports itself to herdr (blocked while asking, idle after). Keys: 1-4, ↑/↓, Enter. An answer is
# recorded in ~/answers.log and in the transcript; at the idle prompt a typed line plus Enter is a new
# user turn, after which it asks again.
import datetime
import json
import os
import re
import select
import shutil
import signal
import subprocess
import sys
import termios
import tty
import uuid

HOME = os.path.expanduser("~")
CWD = os.getcwd()
SESSION = str(uuid.uuid4())
VERSION = "2.1.311"
PANE = os.environ.get("HERDR_PANE_ID", "")
PROJECT_DIR = os.path.join(HOME, ".claude", "projects", re.sub(r"[^a-zA-Z0-9]", "-", CWD))
TRANSCRIPT = os.path.join(PROJECT_DIR, f"{SESSION}.jsonl")
RECORD = os.path.join(HOME, ".claude", "sessions", f"{os.getpid()}.json")
ANSWERS = os.path.join(HOME, "answers.log")

QUESTION = "Which fix do you want?"
HEADER = "Fix"
OPTIONS = [
    ("Patch", "Add the missing newline to the end of the last line."),
    ("Rewrite", "Rewrite the file from scratch."),
]
ROWS = [label for label, _ in OPTIONS] + ["Type something.", "Chat about this"]

state = {"mode": "asking", "selected": 0, "draft": "", "parent": None, "tool_id": None, "lines": [], "resize": False}


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def append(record: dict) -> None:
    record = {"parentUuid": state["parent"], "isSidechain": False, **record, "uuid": str(uuid.uuid4()), "timestamp": now(),
              "userType": "external", "entrypoint": "cli", "cwd": CWD, "sessionId": SESSION, "version": VERSION, "gitBranch": "main"}
    state["parent"] = record["uuid"]
    with open(TRANSCRIPT, "a", encoding="utf-8") as file:
        file.write(json.dumps(record, ensure_ascii=False) + "\n")


def user(text: str) -> None:
    append({"type": "user", "message": {"role": "user", "content": text}})
    state["lines"].append(("user", text))


def assistant(text: str, tool: dict | None = None) -> None:
    content = [{"type": "text", "text": text}] + ([tool] if tool else [])
    append({"type": "assistant", "requestId": f"req_{uuid.uuid4().hex[:24]}", "message": {
        "id": f"msg_{uuid.uuid4().hex[:24]}", "type": "message", "role": "assistant", "model": "claude-sonnet-4-5",
        "content": content, "stop_reason": "tool_use" if tool else "end_turn", "stop_sequence": None,
        "usage": {"input_tokens": 12, "output_tokens": 48}}})
    state["lines"].append(("assistant", text))


def ask() -> None:
    state["tool_id"] = f"toolu_{uuid.uuid4().hex[:24]}"
    assistant("There are two ways to fix it. Patch adds the missing newline, a minimal edit. Rewrite regenerates the whole file.", {
        "type": "tool_use", "id": state["tool_id"], "name": "AskUserQuestion", "input": {"questions": [{
            "question": QUESTION, "header": HEADER, "multiSelect": False,
            "options": [{"label": label, "description": description} for label, description in OPTIONS]}]}})
    state["mode"], state["selected"] = "asking", 0
    report("blocked")


def report(status: str) -> None:
    if not PANE:
        return
    try:
        subprocess.run(["herdr", "pane", "report-agent", "--source", "phone-ssh-standin", "--agent", "claude", "--state", status,
                        "--agent-session-id", SESSION, "--agent-session-path", TRANSCRIPT, PANE],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        log(f"report-agent failed: {error}")


def log(text: str) -> None:
    with open(os.path.join(HOME, "logs", "claude-standin.log"), "a", encoding="utf-8") as file:
        file.write(f"{now()} {text}\n")


def answer(index: int) -> None:
    label = ROWS[index]
    if index >= len(OPTIONS):
        # the typed answer and "Chat about this" are not modelled: stay on the question
        return
    with open(ANSWERS, "a", encoding="utf-8") as file:
        file.write(f"{now()} session={SESSION} option={index + 1} label={label}\n")
    append({"type": "user", "toolUseResult": {"questions": [{"question": QUESTION}], "answers": {QUESTION: label}},
            "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": state["tool_id"],
                        "content": f'User has answered your questions: "{QUESTION}"="{label}". You can now continue with the user\'s answers in mind.'}]}})
    target = os.path.join(CWD, "a.txt")
    if label == "Patch":
        with open(target, "a+", encoding="utf-8") as file:
            file.seek(0)
            if not file.read().endswith("\n"):
                file.write("\n")
    else:
        with open(target, "w", encoding="utf-8") as file:
            file.write("first line\nlast line without a newline\n")
    state["lines"].append(("answer", f"{QUESTION} → {label}"))
    assistant(f"You chose {label}. Done: a.txt now ends with a newline ({label.lower()} applied).")
    state["mode"] = "idle"
    report("idle")


def width() -> int:
    return max(20, shutil.get_terminal_size((100, 30)).columns)


def wrap(text: str, first: str, rest: str, cols: int) -> list[str]:
    out, line, lead = [], "", first
    for word in text.split():
        if line and len(lead) + len(line) + 1 + len(word) > cols:
            out.append(lead + line)
            line, lead = word, rest
        else:
            line = f"{line} {word}" if line else word
    out.append(lead + line)
    return out


def draw() -> None:
    cols = width()
    rule = "─" * cols
    out = [" ▐▛███▜▌   Claude Code v" + VERSION + " (phone-ssh stand-in)", "▝▜█████▛▘  Fixture model · no network", "  ▘▘ ▝▝    " + CWD, ""]
    for kind, text in state["lines"]:
        if kind == "user":
            out += wrap(text, "❯ ", "  ", cols)
        elif kind == "answer":
            out += wrap(text, "  ⎿  ", "     ", cols)
        else:
            out += wrap(text, "● ", "  ", cols)
        out.append("")
    if state["mode"] == "asking":
        out += [rule, f" ☐ {HEADER}", "", QUESTION, ""]
        for index, row in enumerate(ROWS):
            mark = "❯" if index == state["selected"] else " "
            if index == len(ROWS) - 1:
                out.append(rule)
            out.append(f"{mark} {index + 1}. {row}")
            if index < len(OPTIONS):
                out.append(f"     {OPTIONS[index][1]}")
        out += ["", "Enter to select · ↑/↓ to navigate · Esc to cancel"]
    else:
        out += [rule, f"❯ {state['draft']}", rule, "  ? for shortcuts"]
    sys.stdout.write("\x1b[H\x1b[2J" + "\r\n".join(out))
    sys.stdout.flush()


def on_key(key: str) -> None:
    if state["mode"] == "asking":
        if key in ("\x1b[A", "\x1bOA", "\x10", "k"):
            state["selected"] = (state["selected"] - 1) % len(ROWS)
        elif key in ("\x1b[B", "\x1bOB", "\x0e", "j", "\t"):
            state["selected"] = (state["selected"] + 1) % len(ROWS)
        elif key in ("\r", "\n"):
            answer(state["selected"])
        elif key.isdigit() and 1 <= int(key) <= len(ROWS):
            state["selected"] = int(key) - 1
            answer(state["selected"])
        return
    if key in ("\r", "\n"):
        text = state["draft"].strip()
        state["draft"] = ""
        if text:
            user(text)
            assistant(f"Noted: {text}")
            ask()
    elif key in ("\x7f", "\x08"):
        state["draft"] = state["draft"][:-1]
    elif key.isprintable():
        state["draft"] += key


def keys(data: str) -> list[str]:
    data = data.replace("\x1b[200~", "").replace("\x1b[201~", "")
    return re.findall(r"\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b|.", data, re.S)


def main() -> None:
    # probes (Ovis asks `claude --version`) and non-interactive runs leave no session behind
    if sys.argv[1:] in (["--version"], ["-v"]):
        print(f"{VERSION} (Claude Code)")
        return
    if sys.argv[1:] or not sys.stdin.isatty():
        print("phone-ssh stand-in claude: interactive use only", file=sys.stderr)
        sys.exit(1)
    os.makedirs(PROJECT_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(RECORD), exist_ok=True)
    os.makedirs(os.path.join(HOME, "logs"), exist_ok=True)
    with open("/proc/self/stat", encoding="utf-8") as file:
        stat = file.read()
    proc_start = stat[stat.rindex(") ") + 2:].split(" ")[19]
    with open(RECORD, "w", encoding="utf-8") as file:
        json.dump({"pid": os.getpid(), "sessionId": SESSION, "cwd": CWD, "startedAt": int(datetime.datetime.now().timestamp() * 1000),
                   "kind": "interactive", "entrypoint": "cli", "procStart": proc_start}, file)
    user("a.txt has a bug: the last line is missing its trailing newline. Can you take a look?")
    assistant("I read a.txt. It has two lines, and the second one, \"last line without a newline\", has no newline at the end, so the file does not end cleanly.")
    user("What would you do about it?")
    ask()
    log(f"started pid={os.getpid()} session={SESSION} pane={PANE}")

    signal.signal(signal.SIGWINCH, lambda *_: state.update(resize=True))
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    tty.setraw(fd)
    try:
        draw()
        while True:
            try:
                ready, _, _ = select.select([fd], [], [], 1.0)
            except InterruptedError:
                ready = []
            if state["resize"]:
                state["resize"] = False
                draw()
            if not ready:
                continue
            data = os.read(fd, 4096).decode("utf-8", "replace")
            if not data:
                break
            for key in keys(data):
                if key == "\x03":
                    return
                on_key(key)
            draw()
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)
        try:
            os.remove(RECORD)
        except OSError:
            pass


if __name__ == "__main__":
    main()
