/**
 * Session notes: one notes file per pi session, named after the session.
 *
 * Cross-process contract: the iTerm2 daemon
 * (~/Library/Application Support/iTerm2/Scripts/AutoLaunch/pi-notes-daemon.py)
 * reads ~/.pi/agent/session-notes/tty-map.json to map the terminal's tty to the
 * active notes file and appends highlighted text to it. This extension owns
 * that map, watches the notes file, and shows a toast when the daemon appends.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const NOTES_DIR = path.join(os.homedir(), ".pi", "notes");
const STATE_DIR = path.join(os.homedir(), ".pi", "agent", "session-notes");
const BINDINGS_FILE = path.join(STATE_DIR, "bindings.json");
const TTY_MAP_FILE = path.join(STATE_DIR, "tty-map.json");

interface Binding {
	notesFile: string;
	tty: string;
	declined?: boolean;
}

type Bindings = Record<string, Binding>;

function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function writeJson(file: string, data: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function sanitizeName(name: string): string {
	const cleaned = name
		.trim()
		.replace(/[/\\:*?"<>|]/g, "-")
		.replace(/\s+/g, " ")
		.slice(0, 80);
	return cleaned || "untitled";
}

function uniqueNotesFile(baseName: string): string {
	fs.mkdirSync(NOTES_DIR, { recursive: true });
	let candidate = path.join(NOTES_DIR, baseName);
	let n = 2;
	while (fs.existsSync(candidate)) {
		const ext = path.extname(baseName);
		candidate = path.join(NOTES_DIR, `${path.basename(baseName, ext)}-${n}${ext}`);
		n += 1;
	}
	return candidate;
}

function noteCount(content: string): number {
	return content.split("\n").filter((line) => /^## \d{4}-/.test(line)).length;
}

function readNoteCount(file: string): number {
	try {
		return noteCount(fs.readFileSync(file, "utf8"));
	} catch {
		return 0;
	}
}

export default function sessionNotesExtension(pi: ExtensionAPI) {
	let active: { sessionFile: string; notesFile: string; tty: string } | null = null;
	let watcher: fs.FSWatcher | null = null;
	let watchTimer: ReturnType<typeof setTimeout> | null = null;
	let ownWriteUntil = 0;
	let sessionWatcher: fs.FSWatcher | null = null;
	let sessionTimer: ReturnType<typeof setTimeout> | null = null;
	let sessionOffset = 0;
	let sessionTail = "";

	function setStatus(ctx: ExtensionContext): void {
		if (!active) {
			ctx.ui.setStatus("notes", undefined);
			return;
		}
		ctx.ui.setStatus("notes", `📝 ${readNoteCount(active.notesFile)}`);
	}

	function persistBinding(): void {
		if (!active) return;
		const bindings = readJson<Bindings>(BINDINGS_FILE) ?? {};
		bindings[active.sessionFile] = { notesFile: active.notesFile, tty: active.tty };
		writeJson(BINDINGS_FILE, bindings);
	}

	function updateTtyMap(): void {
		const map = readJson<Record<string, string>>(TTY_MAP_FILE) ?? {};
		for (const [tty, file] of Object.entries(map)) {
			if (active && file === active.notesFile && tty !== active.tty) delete map[tty];
		}
		if (active?.tty) map[active.tty] = active.notesFile;
		writeJson(TTY_MAP_FILE, map);
	}

	function deactivate(ctx: ExtensionContext): void {
		watcher?.close();
		watcher = null;
		sessionWatcher?.close();
		sessionWatcher = null;
		if (watchTimer) {
			clearTimeout(watchTimer);
			watchTimer = null;
		}
		if (sessionTimer) {
			clearTimeout(sessionTimer);
			sessionTimer = null;
		}
		if (active?.tty) {
			const map = readJson<Record<string, string>>(TTY_MAP_FILE) ?? {};
			delete map[active.tty];
			writeJson(TTY_MAP_FILE, map);
		}
		active = null;
		setStatus(ctx);
	}

	function applySessionName(pi: ExtensionAPI, ctx: ExtensionContext, rawName: string | undefined): void {
		if (!active) return;
		const desired = `${sanitizeName(rawName ?? `untitled-${new Date().toISOString().slice(0, 16).replace("T", "-")}`)}.md`;
		if (path.basename(active.notesFile) === desired) return;

		const target = uniqueNotesFile(desired);
		const previous = active.notesFile;
		ownWriteUntil = Date.now() + 1500;
		try {
			fs.renameSync(previous, target);
		} catch {
			ctx.ui.notify(`Could not rename notes to ${desired}`, "error");
			return;
		}
		active.notesFile = target;
		persistBinding();
		updateTtyMap();
		watchNotes(pi, ctx);
		ctx.ui.notify(`Notes renamed to ${path.basename(target)}`, "info");
	}

	// The session selector's rename writes a session_info entry straight into the
	// session file without calling setSessionName, so session_info_changed never
	// fires for it. Watch the file and apply renames from appended entries.
	function pollSessionInfo(pi: ExtensionAPI, ctx: ExtensionContext, file: string): void {
		let size = 0;
		try {
			size = fs.statSync(file).size;
		} catch {
			return;
		}
		if (size < sessionOffset) {
			sessionOffset = 0;
			sessionTail = "";
		}
		let delta = "";
		try {
			const fd = fs.openSync(file, "r");
			const buf = Buffer.alloc(size - sessionOffset);
			fs.readSync(fd, buf, 0, buf.length, sessionOffset);
			fs.closeSync(fd);
			delta = buf.toString("utf8");
			sessionOffset = size;
		} catch {
			return;
		}
		sessionTail += delta;
		const lines = sessionTail.split("\n");
		sessionTail = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.includes("session_info")) continue;
			try {
				const entry = JSON.parse(line);
				if (entry?.type === "session_info" && typeof entry.name === "string") {
					applySessionName(pi, ctx, entry.name);
				}
			} catch {
			// Non-JSON line in session file; skip.
			}
		}
	}

	function watchSessionFile(pi: ExtensionAPI, ctx: ExtensionContext): void {
		sessionWatcher?.close();
		sessionWatcher = null;
		if (!active) return;
		const file = active.sessionFile;
		try {
			sessionOffset = fs.statSync(file).size;
		} catch {
			sessionOffset = 0;
		}
		sessionTail = "";
		try {
			sessionWatcher = fs.watch(file, () => {
				if (sessionTimer) return;
				sessionTimer = setTimeout(() => {
					sessionTimer = null;
					pollSessionInfo(pi, ctx, file);
				}, 300);
			});
		} catch {
		// Session file may not exist yet on a brand-new session.
		}
	}

	function watchNotes(pi: ExtensionAPI, ctx: ExtensionContext): void {
		watcher?.close();
		watcher = null;
		if (!active) return;
		const file = active.notesFile;
		try {
			watcher = fs.watch(file, () => {
				if (Date.now() < ownWriteUntil || watchTimer) return;
				watchTimer = setTimeout(() => {
					watchTimer = null;
					ctx.ui.notify(`Saved to ${path.basename(file)} (📝 ${readNoteCount(file)})`, "info");
					setStatus(ctx);
				}, 400);
			});
		} catch {
			// File may not exist yet; it is created on activation.
		}
	}

	async function activate(pi: ExtensionAPI, ctx: ExtensionContext, sessionFile: string, notesFile: string): Promise<void> {
		let tty = "";
		try {
			const res = await pi.exec("ps", ["-o", "tty=", "-p", String(process.pid)]);
			const out = res.stdout.trim();
			if (out && out !== "?" && out !== "??") tty = out;
		} catch {
			// Non-interactive or exec unavailable; saves fall back to the inbox file.
		}
		active = { sessionFile, notesFile, tty };
		persistBinding();
		updateTtyMap();
		if (!fs.existsSync(notesFile)) {
			fs.mkdirSync(NOTES_DIR, { recursive: true });
			fs.writeFileSync(notesFile, `# Notes — ${path.basename(notesFile, ".md")}\n`);
		}
		watchNotes(pi, ctx);
		watchSessionFile(pi, ctx);
		const name = ctx.sessionManager.getSessionName();
		if (name) {
			applySessionName(pi, ctx, name);
		}
		setStatus(ctx);
	}

	const CREATE = "Create a new notes file";
	const EXISTING = "Use an existing notes file";

	async function promptForNotes(pi: ExtensionAPI, ctx: ExtensionContext, sessionFile: string, midSession = false): Promise<void> {
		const options = midSession ? [CREATE, EXISTING] : [CREATE, EXISTING, "Don't use notes this session"];
		const choice = await ctx.ui.select("Session notes", options);
		if (choice === undefined) return;

		if (choice === "Don't use notes this session") {
			const bindings = readJson<Bindings>(BINDINGS_FILE) ?? {};
			bindings[sessionFile] = { notesFile: "", tty: "", declined: true };
			writeJson(BINDINGS_FILE, bindings);
			return;
		}

		if (choice === EXISTING) {
			fs.mkdirSync(NOTES_DIR, { recursive: true });
			const files = fs.readdirSync(NOTES_DIR).filter((f) => f.endsWith(".md")).sort();
			if (files.length === 0) {
				ctx.ui.notify(`No notes files in ${NOTES_DIR} yet`, "warning");
				return;
			}
			const picked = await ctx.ui.select("Pick a notes file", files);
			if (picked === undefined) return;
			await activate(pi, ctx, sessionFile, path.join(NOTES_DIR, picked));
			return;
		}

		const name = ctx.sessionManager.getSessionName() ?? `untitled-${new Date().toISOString().slice(0, 16).replace("T", "-")}`;
		const notesFile = uniqueNotesFile(`${sanitizeName(name)}.md`);
		await activate(pi, ctx, sessionFile, notesFile);
		ctx.ui.notify(`Notes: ${path.basename(notesFile)}`, "info");
	}

	pi.on("session_start", async (event, ctx) => {
		deactivate(ctx);
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;

		const binding = readJson<Bindings>(BINDINGS_FILE)?.[sessionFile];
		if (binding?.notesFile && fs.existsSync(binding.notesFile)) {
			await activate(pi, ctx, sessionFile, binding.notesFile);
			return;
		}
		if (binding?.declined && event.reason === "resume") return;
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		await promptForNotes(pi, ctx, sessionFile);
	});

	pi.on("session_info_changed", async (event, ctx) => {
		applySessionName(pi, ctx, event.name);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		deactivate(ctx);
	});

	function removeLastNote(file: string): { stamp: string; preview: string } | undefined {
		const lines = fs.readFileSync(file, "utf8").split("\n");
		let start = -1;
		for (let i = lines.length - 1; i >= 0; i--) {
			if (/^## \d{4}-/.test(lines[i])) {
				start = i;
				break;
			}
		}
		if (start === -1) return undefined;
		let end = lines.length;
		for (let i = start + 1; i < lines.length; i++) {
			if (/^## /.test(lines[i])) {
				end = i;
				break;
			}
		}
		const removed = lines.splice(start, end - start);
		while (lines.length && lines[lines.length - 1] === "") lines.pop();
		fs.writeFileSync(file, `${lines.join("\n")}\n`);
		const preview = removed.slice(1).find((l) => l.trim() !== "" && l.trim() !== "```")?.trim().slice(0, 60) ?? "";
		return { stamp: removed[0].replace(/^## /, ""), preview };
	}

	pi.registerCommand("notes", {
		description: "Open this session's notes file in an editor; 'undo [n]' removes the last n saved notes",
		getArgumentCompletions: (prefix) => {
			const filtered = ["undo"].filter((o) => o.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((o) => ({ value: o, label: o })) : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim();
			const undoMatch = /^undo(?:\s+(\d+))?$/.exec(arg);
			if (arg !== "" && !undoMatch) {
				ctx.ui.notify("Usage: /notes undo [count]", "warning");
				return;
			}
			if (undoMatch) {
				const count = undoMatch[1] !== undefined ? Number.parseInt(undoMatch[1], 10) : 1;
				if (!Number.isInteger(count) || count < 1) {
					ctx.ui.notify("Usage: /notes undo [count]", "warning");
					return;
				}
				if (!active) {
					ctx.ui.notify("No notes file for this session", "info");
					return;
				}
				const removed: { stamp: string; preview: string }[] = [];
				for (let i = 0; i < count; i++) {
					const r = removeLastNote(active.notesFile);
					if (!r) break;
					removed.push(r);
				}
				if (removed.length === 0) {
					ctx.ui.notify("No saved notes to undo", "info");
					return;
				}
				ownWriteUntil = Date.now() + 1500;
				setStatus(ctx);
				if (removed.length === 1) {
					const r = removed[0];
					ctx.ui.notify(`Removed note from ${r.stamp}${r.preview ? ` — ${r.preview}` : ""}`, "info");
				} else {
					const times = removed.map((r) => r.stamp.slice(11)).join(", ");
					const shortfall = count !== removed.length ? ` (requested ${count}, only ${removed.length} existed)` : "";
					ctx.ui.notify(`Removed ${removed.length} notes: ${times}${shortfall}`, "info");
				}
				return;
			}
			if (!active) {
				const sessionFile = ctx.sessionManager.getSessionFile();
				if (sessionFile) await promptForNotes(pi, ctx, sessionFile, true);
				else ctx.ui.notify("No notes file for this session", "info");
				return;
			}
			const content = fs.readFileSync(active.notesFile, "utf8");
			const edited = await ctx.ui.editor(`Notes — ${path.basename(active.notesFile, ".md")}`, content);
			if (edited !== undefined && edited !== content) {
				ownWriteUntil = Date.now() + 1500;
				fs.writeFileSync(active.notesFile, edited);
				setStatus(ctx);
			}
		},
	});
}
