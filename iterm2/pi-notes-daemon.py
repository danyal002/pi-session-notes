#!/usr/bin/env python3
"""Registers save_selection_to_pi_notes() as an iTerm2 script function.

Setup:
  1. Enable Python API: Settings > General > Magic > Enable Python API
     (grant access to the Scripts folder when prompted).
  2. Keep this file in Scripts/AutoLaunch/ so the daemon starts with iTerm2.
  3. Bind a key: Settings > Keys > Key Bindings > + > Keyboard Shortcut,
     Action "Invoke Script Function", function: save_selection_to_pi_notes()

Pressing the key appends the current text selection (read from the screen
buffer, never the clipboard) to the notes file of the pi session that owns
this terminal. The pi session-notes extension watches that file and shows
the confirmation toast. Without a pi session on this tty, notes land in
~/.pi/notes/inbox.md.
"""

import datetime
import json
import os

import iterm2

TTY_MAP = os.path.expanduser("~/.pi/agent/session-notes/tty-map.json")
INBOX = os.path.expanduser("~/.pi/notes/inbox.md")


def notes_file_for(tty):
    # iTerm2 reports "/dev/ttys001"; the pi extension keys the map with "ttys001" (ps format)
    short = tty.rsplit("/", 1)[-1] if tty else tty
    try:
        with open(TTY_MAP) as f:
            mapping = json.load(f)
        return mapping.get(short) or mapping.get(tty)
    except (OSError, ValueError):
        return None


def needs_code_fence(text):
    # Markdown collapses indentation and runs of spaces outside fenced blocks,
    # which destroys ASCII diagrams and column-aligned captures.
    if any(c in text for c in "─│┌┐└┘├┤┬┴┼▼▲►◄"):
        return True
    return any("  " in line or line[:4].strip() == "" and line.strip() for line in text.splitlines())


async def append_note(target, text):
    os.makedirs(os.path.dirname(target), exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    body = "\n".join(line.rstrip() for line in text.strip().splitlines())
    if needs_code_fence(body):
        body = f"```\n{body}\n```"
    with open(target, "a") as f:
        if f.tell() > 0:
            f.write("\n")
        f.write(f"## {stamp}\n\n{body}\n")


async def main(connection):
    app = await iterm2.async_get_app(connection)

    @iterm2.RPC
    async def save_selection_to_pi_notes(session_id=iterm2.Reference("id")):
        session = app.get_session_by_id(session_id)
        if not session:
            return
        selection = await session.async_get_selection()
        text = await session.async_get_selection_text(selection)
        if not text.strip():
            await session.async_set_variable("user.piNotes", "nothing selected")
            return
        tty = await session.async_get_variable("tty")
        target = notes_file_for(tty) or INBOX
        await append_note(target, text)
        await session.async_set_variable("user.piNotes", os.path.basename(target))

    await save_selection_to_pi_notes.async_register(connection)


iterm2.run_forever(main)
