"""Owned test pane: capture actual terminal stdin without shell/TUI interpretation."""
import os
import signal
import sys
import termios
import tty

path, mode = sys.argv[1:]


# SIGUSR1 / SIGUSR2: the program turns application cursor keys on / off, as a shell does around a command it runs.
def cursor_keys(application):
    name = "APPLICATION" if application else "NORMAL"
    return lambda *_: os.write(1, ("\x1b[?1" + ("h" if application else "l") + "CURSOR KEYS " + name + "\r\n").encode())


signal.signal(signal.SIGUSR1, cursor_keys(True))
signal.signal(signal.SIGUSR2, cursor_keys(False))
before = termios.tcgetattr(0)
try:
    tty.setraw(0)
    # Disambiguation + report all keys; no release/repeat reporting in this probe.
    if mode == "kitty":
        os.write(1, b"\x1b[>9u")
    os.write(1, ("PROBE READY " + mode + "\r\n").encode())
    with open(path, "a", buffering=1) as output:
        while True:
            data = os.read(0, 4096)
            if not data:
                break
            output.write(data.hex())
            output.flush()
finally:
    if mode == "kitty":
        os.write(1, b"\x1b[<u")
    termios.tcsetattr(0, termios.TCSANOW, before)
