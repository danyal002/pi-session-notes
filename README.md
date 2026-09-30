# pi-session-notes

Highlight text in iTerm2, press a hotkey, and it lands in the notes file of the pi session running in that terminal. No clipboard involved — the selection is read straight from the screen buffer.

Each pi session gets its own notes file, named after the session. Rename the session, the file renames with it. Notes files live in `~/.pi/notes` by default; configure `sessionNotes.directory` in your pi settings to change it:

```
┌─────────────┐  hotkey   ┌──────────────────┐  reads selection  ┌────────────────────────┐
│  iTerm2     │──────────▶│  pi-notes-daemon │──────────────────▶│ ~/.pi/notes/<name>.md  │
│  selection  │           │  (Python API)    │  tty → file via   └───────────┬────────────┘
└─────────────┘           └──────────────────┘  tty-map.json                 │ fs.watch
                              ▲                                             ▼
                              │ tty-map maintained by          ┌─────────────────────────┐
                              └────────────────────────────────┤  session-notes          │
                                                               │  pi extension           │
                                                               └─────────────────────────┘
```

## How it works

Two halves that meet at a file:

- **pi extension** (`extension/index.ts`) — on session start it asks whether to create a new notes file, use an existing one, or skip notes for that session. It owns the notes file (in `~/.pi/notes/`), keeps a tty → file map that the daemon reads, watches the file, and shows a toast when a note arrives. `/notes` opens the file in an editor; `/notes undo [n]` removes the last n saved notes.
- **iTerm2 daemon** (`iterm2/pi-notes-daemon.py`) — registers a `save_selection_to_pi_notes()` script function. It reads the current selection via iTerm2's Python API (never the clipboard), resolves the terminal's tty to a pi session's notes file, and appends the snippet with a timestamp. Diagrams and column-aligned captures are wrapped in fenced code blocks so markdown doesn't mangle them; without a pi session on the terminal, saves fall back to `~/.pi/notes/inbox.md`.

macOS + iTerm2 with the Python API enabled. The pi extension works in any terminal; only the selection capture needs iTerm2.

## Install

### pi extension

```sh
pi install git:github.com/danyal002/pi-session-notes@v0.1.0
```

### iTerm2 daemon

```sh
./setup-iterm2.sh
```

Copies the daemon into iTerm2's `Scripts/AutoLaunch` (both the default location and a customized AppSupport directory, if present). Then, in iTerm2 — these steps are GUI-only:

1. **Settings → General → Magic → Enable Python API** (grant access to the Scripts folder when prompted)
2. **Settings → Keys → Key Bindings → +** → pick a shortcut → Action **"Invoke Script Function"** → `save_selection_to_pi_notes()`
3. Restart iTerm2

## Configuration

In `~/.pi/agent/settings.json` (or project settings):

```json
{
  "sessionNotes": {
    "directory": "~/notes/pi"
  }
}
```

Takes effect for newly created notes files on the next session; existing files stay where they are (absolute paths in the tty map keep working across a directory change). The daemon's `inbox.md` fallback follows the same setting, read at daemon startup.

## Usage

| Action | How |
|---|---|
| Save a highlight | Select text, press your hotkey |
| View / edit notes | `/notes` in pi |
| Remove the last note | `/notes undo` |
| Remove the last n notes | `/notes undo 3` |

On session start, pi asks how to set up notes for the session; the choice is remembered per session. Renaming a session (session selector) renames its notes file.

## Caveats

- In pi's fullscreen mode pi owns mouse reporting — hold **Option while dragging** to select. In regular mode, plain dragging works.
- A diagram wider than the terminal is wrapped by pi *before* it hits the screen, and the selection captures the wrapped layout. Ask the agent to write wide diagrams to a file instead.
- Renaming a **non-active** session from the selector only updates its notes file the next time that session resumes.
- The undo command only touches the active session's notes file; check `~/.pi/notes/inbox.md` for saves made outside a mapped pi session.

## AI disclosure

This project was built with an AI coding agent (Anthropic Claude, running in [pi](https://github.com/earendil-works/pi)). The agent wrote the initial implementation, the bug fixes found during live testing, and this documentation. All feature design decisions, review, approval, and testing were done by a human — nothing was committed without explicit human sign-off.

## License

MIT
