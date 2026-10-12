#!/usr/bin/env python3
"""Drive Pi's real interactive TUI through a pseudo-terminal (no model).

Runs `pi --no-session --offline -ne ... -e test/real-test/real-dialog-command.ts`
at a fixed terminal size, types `/ask-user-real-check <scenario>`, waits for
the real dialog to render, sends real keystrokes, and reads the result the
command appends to $ASK_USER_REAL_RESULTS. Prints one JSON object with what it
observed; test/real-test/real-dialogs.mjs decides pass/fail.

Usage: python3 real-tui.py <results.jsonl>
"""

import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ROWS, COLS = 45, 120
ANSI = re.compile(
    rb"\x1b\[[0-9;?<>=!]*[ -/]*[@-~]"  # CSI
    rb"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"  # OSC
    rb"|\x1b[P_^X][^\x1b]*\x1b\\"  # DCS / APC / PM / SOS
    rb"|\x1b[()][0-9A-Za-z]"  # charset
    rb"|\x1b[@-Z\\-_]"  # other two-byte escapes
)
KEYS = {"down": b"\x1b[B", "enter": b"\r", "esc": b"\x1b"}

# Each scenario: the keys to press once the menu is up, whether a text box opens,
# and the keys for the rule 16 follow-up ("Apply ... to similar questions this session?")
# that appears after a new answer: Enter = "Just this time", Down+Enter = "Also for similar".
CUSTOM_TEXT = "  Play a sound — naïve café 日本語  "
SCENARIOS = [
    {"name": "recommended", "keys": ["down", "enter"], "followup": ["enter"]},
    {"name": "esc-menu", "keys": ["esc"]},
    {"name": "custom", "keys": ["down", "down", "down", "enter"], "textbox": {"type": CUSTOM_TEXT, "then": "enter"}, "followup": ["enter"]},
    {"name": "empty", "keys": ["down", "down", "down", "enter"], "textbox": {"type": "", "then": "enter"}},
    {"name": "esc-textbox", "keys": ["down", "down", "down", "enter"], "textbox": {"type": "", "then": "esc"}},
    {"name": "scope-similar", "keys": ["down", "enter"], "followup": ["down", "enter"]},
    {"name": "scope-esc", "keys": ["enter"], "followup": ["esc"]},
]


class Screen:
    def __init__(self, fd):
        self.fd = fd
        self.raw = b""

    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([self.fd], [], [], 0.05)
            if ready:
                try:
                    chunk = os.read(self.fd, 65536)
                except OSError:
                    return
                if not chunk:
                    return
                self.raw += chunk

    def text(self, start=0):
        return ANSI.sub(b"", self.raw[start:]).decode("utf-8", "replace")

    def wait_for(self, needles, start, timeout):
        """Pump until every needle appears in the output since `start`; return the missing ones."""
        end = time.time() + timeout
        while True:
            seen = self.text(start)
            missing = [n for n in needles if n not in seen]
            if not missing or time.time() > end:
                return missing
            self.pump(0.1)

    def send(self, data, settle=0.4):
        os.write(self.fd, data)
        self.pump(settle)


def read_records(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def excerpt(text):
    """The dialog part of a rendered screen chunk, trailing spaces trimmed."""
    lines = [line.rstrip() for line in text.replace("\r", "").split("\n")]
    lines = [line for line in lines if line.strip()]
    return "\n".join(lines[-40:])


def main():
    results_path = sys.argv[1]
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(ROOT)
        env = dict(os.environ, TERM="xterm-256color", ASK_USER_REAL_RESULTS=results_path)
        os.execvpe(
            "pi",
            ["pi", "--no-session", "--offline", "-ne", "-ns", "-np", "-nc",
             "-e", "./src/index.ts", "-e", "./test/real-test/real-dialog-command.ts"],
            env,
        )
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    screen = Screen(fd)
    out = {"terminal": f"{COLS}x{ROWS}", "startup": None, "scenarios": []}
    try:
        # Ready when the footer (cwd line) has rendered and output has settled.
        missing = screen.wait_for(["Ask_user_Pi_extension"], 0, 30)
        screen.pump(1.5)
        out["startup"] = "ok" if not missing else f"footer not seen: {missing}"

        for sc in SCENARIOS:
            entry = {"scenario": sc["name"], "keysPressed": [], "screen": {}, "record": None, "problems": []}
            before = len(read_records(results_path))
            mark = len(screen.raw)
            command = f"/ask-user-real-check {sc['name']}"
            screen.send(command.encode(), settle=0.8)
            screen.send(KEYS["enter"], settle=0.2)
            entry["keysPressed"].append(f"type {command!r} + Enter")

            menu = ["Why it matters:", "1. SQLite", "2. [Recommended] Postgres", "3. In-memory", "4. Write my own answer"]
            missing = screen.wait_for(menu, mark, 20)
            entry["screen"]["menuMissing"] = missing
            entry["screen"]["menu"] = excerpt(screen.text(mark))
            if missing:
                entry["problems"].append(f"menu did not render: {missing}")
            screen.pump(0.5)

            mark2 = len(screen.raw)  # before the keys: the text box renders in response to them
            for key in sc["keys"]:
                screen.send(KEYS[key], settle=0.6 if key == "esc" else 0.3)
                entry["keysPressed"].append(key.capitalize() if key != "esc" else "Esc")

            box = sc.get("textbox")
            if box:
                missing = screen.wait_for(["submit", "cancel"], mark2, 15)
                entry["screen"]["textboxMissing"] = missing
                entry["screen"]["textbox"] = excerpt(screen.text(mark2))
                if missing:
                    entry["problems"].append("text box did not render")
                if box["type"]:
                    screen.send(box["type"].encode("utf-8"), settle=0.6)
                    entry["keysPressed"].append(f"type {box['type']!r}")
                mark3 = len(screen.raw)  # the follow-up renders in response to this key
                screen.send(KEYS[box["then"]], settle=0.6 if box["then"] == "esc" else 0.3)
                entry["keysPressed"].append("Esc" if box["then"] == "esc" else "Enter")
            else:
                mark3 = mark2

            followup = sc.get("followup")
            if followup:
                missing = screen.wait_for(["to similar questions this session?", "1. Just this time", "2. Also for similar questions this session"], mark3, 15)
                entry["screen"]["followupMissing"] = missing
                entry["screen"]["followup"] = excerpt(screen.text(mark3))
                if missing:
                    entry["problems"].append(f"follow-up did not render: {missing}")
                screen.pump(0.4)
                for key in followup:
                    screen.send(KEYS[key], settle=0.6 if key == "esc" else 0.3)
                    entry["keysPressed"].append(("Esc" if key == "esc" else key.capitalize()) + " (follow-up)")

            deadline = time.time() + 20
            while time.time() < deadline and len(read_records(results_path)) <= before:
                screen.pump(0.2)
            records = read_records(results_path)
            entry["record"] = records[before] if len(records) > before else None
            if entry["record"] is None:
                entry["problems"].append("no result recorded")
            screen.pump(0.8)
            out["scenarios"].append(entry)
    finally:
        stop(pid, fd, screen)
    print(json.dumps(out, ensure_ascii=False))


def stop(pid, fd, screen):
    """Quit Pi. Keep reading its output while it exits (a full pty buffer blocks its exit), then reap it."""
    for _ in range(2):
        try:
            os.write(fd, b"\x03")
        except OSError:
            break
        screen.pump(0.4)
    deadline = time.time() + 5
    while time.time() < deadline:
        screen.pump(0.1)
        try:
            done, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            done = pid
        if done == pid:
            break
    else:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    os.close(fd)  # hang up the terminal so a blocked write fails instead of waiting forever
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass


if __name__ == "__main__":
    main()
