import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileManager as MockFileManager, Notice, Vault as MockVault } from "./__mocks__/obsidian";
import type { FileManager, Plugin, TFile, Vault } from "obsidian";
import { NoteWriter, openNoteFromWorkspace } from "../core/noteWriter";
import type { OpenNote } from "../core/noteWriter";
import { reasonOf } from "../core/reason";
import { dailyLogPath } from "../core/vaultLayout";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";

/** A vault of in-memory files whose `process` is atomic but not instant. */
class FakeVault {
	readonly files = new Map<string, string>();

	async process(file: TFile, fn: (data: string) => string): Promise<string> {
		const before = this.files.get(file.path) ?? "";
		// A real write is not synchronous, so yield before storing. Two writes
		// that both read `before` and then store would lose one of them; the
		// queue is what stops that happening.
		await Promise.resolve();
		const after = fn(before);
		this.files.set(file.path, after);
		return after;
	}

	/** Not synchronous either, and rejects the way Obsidian's own read does
	 * when nothing is at `file.path` — a real vault error, for the writer to
	 * carry through rather than swallow. */
	async read(file: TFile): Promise<string> {
		await Promise.resolve();
		if (!this.files.has(file.path)) {
			throw new Error(`File not found: ${file.path}`);
		}
		return this.files.get(file.path) as string;
	}
}

// The writer only ever reads `path`, so a stand-in with just that is enough.
const file = (path: string): TFile => ({ path }) as unknown as TFile;

describe("NoteWriter", () => {
	let vault: FakeVault;
	let openNote: FakeOpenNote;
	let writer: NoteWriter;

	beforeEach(() => {
		vault = new FakeVault();
		// Built with a port, because that is the only writer the plugin builds. This suite does not care which note is on screen, so the
		// port answers "none" and the queueing rules are the same rules the real
		// writer runs — rather than the rules of a writer with the
		// never-overwrite-typing check switched off.
		openNote = new FakeOpenNote();
		writer = new NoteWriter(vault as unknown as Vault, openNote);
	});

	// The port is a required constructor argument. This is the check
	// that says so: `@ts-expect-error` is itself an error when the line below
	// compiles, so making the argument optional again fails `npm run lint` here
	// rather than silently reinstating a writer with the never-overwrite-typing
	// rule switched off. It never runs.
	it.skip("cannot be built without an open-note port", () => {
		// @ts-expect-error the open-note port is required
		new NoteWriter(vault as unknown as Vault);
	});

	it("lets each queued write see the one before it", async () => {
		const note = file("Journal/2026-09-01.md");
		vault.files.set(note.path, "start");

		await Promise.all([
			writer.edit(note, (text) => `${text}+a`),
			writer.edit(note, (text) => `${text}+b`),
			writer.edit(note, (text) => `${text}+c`),
		]);

		expect(vault.files.get(note.path)).toBe("start+a+b+c");
	});

	it("does not make writes to different notes wait for each other", async () => {
		const order: string[] = [];
		const slow = file("slow.md");
		const quick = file("quick.md");

		const first = writer.edit(slow, (text) => {
			order.push("slow");
			return text;
		});
		const second = writer.edit(quick, (text) => {
			order.push("quick");
			return text;
		});

		await Promise.all([first, second]);
		expect(order).toHaveLength(2);
	});

	it("reports a failed write to its caller rather than swallowing it", async () => {
		const note = file("note.md");
		await expect(
			writer.edit(note, () => {
				throw new Error("nope");
			}),
		).rejects.toThrow("nope");
	});

	it("still runs the write queued behind a failed one", async () => {
		const note = file("note.md");
		vault.files.set(note.path, "start");

		const failing = writer.edit(note, () => {
			throw new Error("nope");
		});
		const following = writer.edit(note, (text) => `${text}+b`);

		await expect(failing).rejects.toThrow("nope");
		await expect(following).resolves.toBe("start+b");
	});
});

/** A vault that also remembers its folders, so creating a log can be watched. */
class FakeCreatingVault extends FakeVault {
	readonly folders = new Set<string>();
	/** Every path handed to `create`, in order — so a second creation shows up. */
	readonly created: string[] = [];

	getFileByPath(path: string): TFile | null {
		return this.files.has(path) ? file(path) : null;
	}

	getFolderByPath(path: string): unknown | null {
		return this.folders.has(path) ? { path } : null;
	}

	/** Obsidian's own `createFolder` rejects when the folder is already there. */
	async createFolder(path: string): Promise<unknown> {
		await Promise.resolve();
		if (this.folders.has(path)) throw new Error(`Folder already exists: ${path}`);
		this.folders.add(path);
		return { path };
	}

	async create(path: string, data: string): Promise<TFile> {
		await Promise.resolve();
		if (this.files.has(path)) throw new Error(`already exists: ${path}`);
		this.created.push(path);
		this.files.set(path, data);
		return file(path);
	}
}

/** Stands in for the person's open tab. */
class FakeOpenNote implements OpenNote {
	private readonly listeners: Array<() => void> = [];
	private open: string | null = null;

	path(): string | null {
		return this.open;
	}

	onChange(listener: () => void): void {
		this.listeners.push(listener);
	}

	/** What the person does: opens a note, or leaves for another one. */
	looksAt(path: string | null): void {
		this.open = path;
		for (const listener of this.listeners) listener();
	}
}

/** Lets the microtask queue run `count` times, so a hang shows up as a hang. */
async function turns(count: number): Promise<void> {
	for (let i = 0; i < count; i += 1) await Promise.resolve();
}

/** Filled in, so a day's log has somewhere to go. */
function testLayout(): VaultLayout {
	return {
		...defaultData().core.layout,
		dailyLogFolder: "Journal",
		dailyLogFilename: "YYYY/YYYY-MM-DD",
	};
}

describe("NoteWriter — the one place a day's log is created", () => {
	let vault: FakeCreatingVault;
	let openNote: FakeOpenNote;
	let writer: NoteWriter;

	beforeEach(() => {
		vault = new FakeCreatingVault();
		// The whole of this path used to be exercised with no port at all, so
		// creating a day was never tested with a note open. Every
		// test below now runs against the writer the plugin builds; the ones
		// that care say which note the person is in.
		openNote = new FakeOpenNote();
		writer = new NoteWriter(vault as unknown as Vault, openNote);
	});

	it("creates the missing log with the day's frame, making the folders on the way", async () => {
		const log = await writer.createDailyLog(new Date(2026, 8, 6), testLayout());

		expect(log.path).toBe("Journal/2026/2026-09-06.md");
		expect(vault.files.get(log.path)).toBe(
			"# Notes\n\n## Overdue\n\n## Today\n\n## Calendar\n\n```schema\n| Time | Meeting |\n| --- | --- |\n```\n\n# Diary\n\n",
		);
		expect(Array.from(vault.folders)).toEqual(["Journal", "Journal/2026"]);
	});

	it("hands back the log that is already there without rewriting it", async () => {
		vault.files.set("Journal/2026/2026-09-06.md", "a day of work");

		const log = await writer.createDailyLog(new Date(2026, 8, 6), testLayout());

		expect(vault.files.get(log.path)).toBe("a day of work");
		expect(vault.created).toEqual([]);
	});

	it("creates the folder once when two different days are asked for at once", async () => {
		// Different days are different paths, so they do not share a queue — but
		// they do share the folder tree. Building the days ahead in one pass is
		// the job the per-device switch exists for.
		const layout = testLayout();
		const results = await Promise.allSettled([
			writer.createDailyLog(new Date(2026, 8, 6), layout),
			writer.createDailyLog(new Date(2026, 8, 7), layout),
		]);

		expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
		expect([...vault.created].sort()).toEqual([
			"Journal/2026/2026-09-06.md",
			"Journal/2026/2026-09-07.md",
		]);
		expect(Array.from(vault.folders)).toEqual(["Journal", "Journal/2026"]);
	});

	it("creates one file when two callers ask for the same day at once", async () => {
		const layout = testLayout();
		await Promise.all([
			writer.createDailyLog(new Date(2026, 8, 6), layout),
			writer.createDailyLog(new Date(2026, 8, 6), layout),
		]);

		expect(vault.created).toEqual(["Journal/2026/2026-09-06.md"]);
	});

	it("hands back a day's log that is there while the person is typing in it", async () => {
		// Today's log is the note most likely to be open, and a write to it is
		// held until the person leaves. Asking for a day that already exists
		// writes nothing, so it must not wait behind that held write.
		const path = "Journal/2026/2026-09-06.md";
		vault.files.set(path, "a day of work");
		openNote.looksAt(path);

		const held = writer.edit(file(path), (text) => `${text}+queued`);
		const answered = await Promise.race([
			writer.createDailyLog(new Date(2026, 8, 6), testLayout()),
			turns(20).then(() => "still waiting" as const),
		]);

		expect(answered).not.toBe("still waiting");

		openNote.looksAt(null);
		await expect(held).resolves.toBe("a day of work+queued");
	});

	it("creates a day that is the note on screen when it is not there yet", async () => {
		// A path the person is reported to be in with no file behind it — the
		// moment before today's log exists, which is exactly when something asks
		// for it. There is nothing to overwrite, so the day is created rather
		// than held: the never-overwrite-typing rule guards `edit`, and creating
		// a day writes to no existing text.
		openNote.looksAt("Journal/2026/2026-09-06.md");

		const answered = await Promise.race([
			writer.createDailyLog(new Date(2026, 8, 6), testLayout()),
			turns(20).then(() => "still waiting" as const),
		]);

		expect(answered).not.toBe("still waiting");
		expect(vault.created).toEqual(["Journal/2026/2026-09-06.md"]);
		expect(vault.files.get("Journal/2026/2026-09-06.md")).toBe(
			"# Notes\n\n## Overdue\n\n## Today\n\n## Calendar\n\n```schema\n| Time | Meeting |\n| --- | --- |\n```\n\n# Diary\n\n",
		);
	});

	it("does not make a day's log wait for a write parked on a different note", async () => {
		// The write queues are keyed by path, so a write held because the person
		// is typing in one note must not delay a day being built somewhere else.
		const elsewhere = "Projects/Roof.md";
		vault.files.set(elsewhere, "typing");
		openNote.looksAt(elsewhere);

		const parked = writer.edit(file(elsewhere), (text) => `${text}+queued`);

		const answered = await Promise.race([
			writer.createDailyLog(new Date(2026, 8, 6), testLayout()),
			turns(20).then(() => "still waiting" as const),
		]);

		expect(answered).not.toBe("still waiting");
		expect(vault.created).toEqual(["Journal/2026/2026-09-06.md"]);

		openNote.looksAt(null);
		await expect(parked).resolves.toBe("typing+queued");
	});

	it("creates the shared folder once for two days built while the person is in one", async () => {
		// The folder chain, driven with a port present. Two days are two paths
		// and so two queues, but one folder tree — and `createFolder` rejects a
		// folder that is already there. The person sitting in one of the days
		// must not change that.
		const layout = testLayout();
		openNote.looksAt("Journal/2026/2026-09-06.md");

		const results = await Promise.allSettled([
			writer.createDailyLog(new Date(2026, 8, 6), layout),
			writer.createDailyLog(new Date(2026, 8, 7), layout),
		]);

		expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
		expect(Array.from(vault.folders)).toEqual(["Journal", "Journal/2026"]);
		expect([...vault.created].sort()).toEqual([
			"Journal/2026/2026-09-06.md",
			"Journal/2026/2026-09-07.md",
		]);
	});
});

describe("NoteWriter — creating a day's log from a template", () => {
	let vault: FakeCreatingVault;
	let openNote: FakeOpenNote;
	let writer: NoteWriter;

	beforeEach(() => {
		vault = new FakeCreatingVault();
		openNote = new FakeOpenNote();
		writer = new NoteWriter(vault as unknown as Vault, openNote);
	});

	/** `testLayout()` with a template note named. */
	function layoutWithTemplate(templatePath: string): VaultLayout {
		return { ...testLayout(), dailyLogTemplate: templatePath };
	}

	it("is byte-identical to the generic frame when the template setting is blank", async () => {
		const log = await writer.createDailyLog(new Date(2026, 8, 6), testLayout());
		expect(vault.files.get(log.path)).toBe(
			"# Notes\n\n## Overdue\n\n## Today\n\n## Calendar\n\n```schema\n| Time | Meeting |\n| --- | --- |\n```\n\n# Diary\n\n",
		);
	});

	it("builds the day from the template note's own text, with its placeholders filled for that day", async () => {
		const templatePath = "Templates/Day.md";
		vault.files.set(templatePath, "# {{date:YYYY-MM-DD}}\n\n# Notes\n\n## Overdue\n\n## Today\n\n## Calendar\n\n```schema\n| Time | Meeting |\n| --- | --- |\n```\n\n# Diary\n");

		const log = await writer.createDailyLog(new Date(2026, 8, 6), layoutWithTemplate(templatePath));

		// The block in front is the mark of the empty diary section:
		// `fingerprintOf("")`, taken once.
		expect(vault.files.get(log.path)).toBe(
			'---\neffortless-built-diary: "0:bdcb81aee8d83"\n---\n# 2026-09-06\n\n# Notes\n\n## Overdue\n\n## Today\n\n## Calendar\n\n```schema\n| Time | Meeting |\n| --- | --- |\n```\n\n# Diary\n',
		);
	});

	it("rejects, naming the template, when no note is there", async () => {
		await expect(
			writer.createDailyLog(new Date(2026, 8, 6), layoutWithTemplate("Templates/Day.md")),
		).rejects.toThrow('The day\'s-log template "Templates/Day.md" does not exist.');
		expect(vault.created).toEqual([]);
	});

	it("rejects, naming the template, when the note is there but cannot be read", async () => {
		const templatePath = "Templates/Day.md";
		vault.files.set(templatePath, "# {{date:YYYY-MM-DD}}\n");
		const realRead = vault.read.bind(vault);
		vault.read = (file) =>
			file.path === templatePath ? Promise.reject(new Error("permission denied")) : realRead(file);

		await expect(
			writer.createDailyLog(new Date(2026, 8, 6), layoutWithTemplate(templatePath)),
		).rejects.toThrow('The day\'s-log template "Templates/Day.md" could not be read: permission denied.');
		expect(vault.created).toEqual([]);
	});

	it("carries the template builder's own message, word for word, for a placeholder it does not know", async () => {
		const templatePath = "Templates/Day.md";
		vault.files.set(templatePath, "{{nextWeek:YYYY-MM-DD}}");

		await expect(
			writer.createDailyLog(new Date(2026, 8, 6), layoutWithTemplate(templatePath)),
		).rejects.toThrow('a placeholder Effortless does not know: "{{nextWeek:YYYY-MM-DD}}"');
		expect(vault.created).toEqual([]);
	});

	it("never reads the template for a day that already exists, whatever the template setting names", async () => {
		vault.files.set("Journal/2026/2026-09-06.md", "a day of work");

		const log = await writer.createDailyLog(
			new Date(2026, 8, 6),
			// Names a template that does not exist, on purpose: reading it
			// would throw, so a resolved promise here proves it was never
			// asked for. Creating a day writes nothing to a file that
			// exists, and reading a template belongs to that write.
			layoutWithTemplate("Templates/Missing.md"),
		);

		expect(vault.files.get(log.path)).toBe("a day of work");
		expect(vault.created).toEqual([]);
	});
});

describe("NoteWriter — creating a note at any path", () => {
	let vault: FakeCreatingVault;
	let openNote: FakeOpenNote;
	let writer: NoteWriter;

	beforeEach(() => {
		vault = new FakeCreatingVault();
		openNote = new FakeOpenNote();
		writer = new NoteWriter(vault as unknown as Vault, openNote);
	});

	it("creates the file with exactly the given text, making missing folders first", async () => {
		const path = "Meetings/2026/Standup.md";

		const created = await writer.create(path, "# Standup\n");

		expect(created.path).toBe(path);
		expect(vault.files.get(path)).toBe("# Standup\n");
		expect(Array.from(vault.folders)).toEqual(["Meetings", "Meetings/2026"]);
	});

	it("refuses a path that already exists, naming it, and leaves the file untouched", async () => {
		const path = "Meetings/Standup.md";
		vault.files.set(path, "already here");

		await expect(writer.create(path, "new text")).rejects.toThrow(
			`A note already exists at "${path}".`,
		);
		expect(vault.files.get(path)).toBe("already here");
	});

	it("refuses the second of two creates queued on the same path, keeping the first's text", async () => {
		const path = "Meetings/Standup.md";

		const results = await Promise.allSettled([
			writer.create(path, "first"),
			writer.create(path, "second"),
		]);

		expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
		expect(vault.files.get(path)).toBe("first");
	});

	it("runs a create queued behind a pending edit on the same path only once the edit has landed", async () => {
		// Free when `create` is called, so its own pre-check does not refuse it
		// at once — only the queue, not that check, can be what makes it wait.
		// The edit ahead of it in the path's queue is what populates the very
		// path `create` asked for, once it lands: a create that genuinely waited
		// its turn then finds the path occupied and refuses it, the same as two
		// creates queued on one path above. A create that jumped the queue would
		// have created the file before the edit ever ran, and this would resolve
		// instead of rejecting.
		const path = "Meetings/Standup.md";

		const held = writer.edit(file(path), (text) => `${text}+edited`);
		const created = writer.create(path, "fresh text");

		await expect(held).resolves.toBe("+edited");
		await expect(created).rejects.toThrow(`A note already exists at "${path}".`);
		expect(vault.files.get(path)).toBe("+edited");
	});
});

describe("NoteWriter — the note the person has open", () => {
	let vault: FakeVault;
	let openNote: FakeOpenNote;
	let writer: NoteWriter;

	beforeEach(() => {
		vault = new FakeVault();
		openNote = new FakeOpenNote();
		writer = new NoteWriter(vault as unknown as Vault, openNote);
	});

	it("holds a write to the open note until the person leaves it", async () => {
		const note = file("Journal/2026-09-06.md");
		vault.files.set(note.path, "typing");
		openNote.looksAt(note.path);

		const write = writer.edit(note, (text) => `${text}+queued`);
		await Promise.resolve();
		await Promise.resolve();
		expect(vault.files.get(note.path)).toBe("typing");

		openNote.looksAt("Projects/Roof.md");
		await expect(write).resolves.toBe("typing+queued");
	});

	it("does not hold a write to a note the person is not in", async () => {
		const other = file("Projects/Roof.md");
		openNote.looksAt("Journal/2026-09-06.md");

		await expect(writer.edit(other, () => "written")).resolves.toBe("written");
	});

	it("keeps the order of the writes queued behind a held one", async () => {
		const note = file("Journal/2026-09-06.md");
		vault.files.set(note.path, "start");
		openNote.looksAt(note.path);

		const all = Promise.all([
			writer.edit(note, (text) => `${text}+a`),
			writer.edit(note, (text) => `${text}+b`),
		]);
		await Promise.resolve();
		await Promise.resolve();
		openNote.looksAt(null);

		await all;
		expect(vault.files.get(note.path)).toBe("start+a+b");
	});
});

describe("NoteWriter — reading a note's current text", () => {
	let vault: FakeVault;
	let openNote: FakeOpenNote;
	let writer: NoteWriter;

	beforeEach(() => {
		vault = new FakeVault();
		openNote = new FakeOpenNote();
		writer = new NoteWriter(vault as unknown as Vault, openNote);
	});

	it("resolves a read queued behind an edit with the edited text, not the text as it stood when queued", async () => {
		// A read that skipped the queue and called `vault.read` at once would see
		// "start", the text on disk before the edit's write lands a few
		// microtasks later — the edit is genuinely still pending when `read` is
		// called, so this only passes if the read waits its turn.
		const note = file("note.md");
		vault.files.set(note.path, "start");

		const edited = writer.edit(note, (text) => `${text}+edited`);
		const read = writer.read(note);

		await expect(read).resolves.toBe("start+edited");
		await expect(edited).resolves.toBe("start+edited");
	});

	it("resolves a read of the open note at once, while an edit queued to it stays parked", async () => {
		// If the read joined the write's own held slot in the path's queue, it
		// would hang until the person left the note — the race below would time
		// out at "still waiting" instead of returning the text.
		const note = file("Journal/2026-09-06.md");
		vault.files.set(note.path, "typing");
		openNote.looksAt(note.path);

		const held = writer.edit(note, (text) => `${text}+queued`);
		const read = await Promise.race([writer.read(note), turns(20).then(() => "still waiting" as const)]);

		expect(read).toBe("typing");
		// The parked write has not touched the file.
		expect(vault.files.get(note.path)).toBe("typing");

		openNote.looksAt(null);
		await expect(held).resolves.toBe("typing+queued");
	});

	it("does not make a read of one path wait for another path's queue", async () => {
		// Were `read` keyed on one shared queue rather than per path, this read
		// would wait behind the held write below and the race would time out.
		const held = "Journal/2026-09-06.md";
		const elsewhere = "Projects/Roof.md";
		vault.files.set(held, "typing");
		vault.files.set(elsewhere, "current");
		openNote.looksAt(held);

		writer.edit(file(held), (text) => `${text}+queued`);
		const read = await Promise.race([
			writer.read(file(elsewhere)),
			turns(20).then(() => "still waiting" as const),
		]);

		expect(read).toBe("current");
	});

	it("rejects with the vault's own read error, naming it, rather than swallowing it", async () => {
		// The fake's `read` throws exactly the way a real vault does for a path
		// with nothing at it — nothing in `NoteWriter.read` catches that.
		const missing = file("nowhere.md");

		await expect(writer.read(missing)).rejects.toThrow("File not found: nowhere.md");
	});

	it("still answers a read after teardown, whether or not the file is open", async () => {
		// Read never parks, so it has nothing for teardown to reject — unlike a
		// write to the open note, which teardown does reject (covered below).
		const open = file("Journal/2026-09-06.md");
		const other = file("Projects/Roof.md");
		vault.files.set(open.path, "typing");
		vault.files.set(other.path, "notes");
		openNote.looksAt(open.path);

		writer.teardown();

		await expect(writer.read(open)).resolves.toBe("typing");
		await expect(writer.read(other)).resolves.toBe("notes");
	});
});

describe("openNoteFromWorkspace", () => {
	it("reads the open note from the workspace and follows it as it changes", () => {
		let active: TFile | null = file("Journal/2026-09-06.md");
		const opened: Array<(f: TFile | null) => void> = [];
		const registered: unknown[] = [];
		const plugin = {
			app: {
				workspace: {
					getActiveFile: () => active,
					on: (name: string, callback: (f: TFile | null) => void) => {
						if (name === "file-open") opened.push(callback);
						return { name };
					},
				},
			},
			registerEvent: (ref: unknown) => registered.push(ref),
		} as unknown as Plugin;

		const note = openNoteFromWorkspace(plugin);
		let changes = 0;
		note.onChange(() => {
			changes += 1;
		});

		expect(note.path()).toBe("Journal/2026-09-06.md");
		expect(registered).toHaveLength(3);

		active = null;
		for (const listener of opened) listener(null);
		expect(note.path()).toBeNull();
		expect(changes).toBe(1);
	});
});

describe("NoteWriter — letting go of a parked write", () => {
	let vault: FakeVault;
	let openNote: FakeOpenNote;
	let writer: NoteWriter;

	beforeEach(() => {
		vault = new FakeVault();
		openNote = new FakeOpenNote();
		writer = new NoteWriter(vault as unknown as Vault, openNote);
		Notice.messages = [];
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("rejects a write parked on the open note when the plugin unloads", async () => {
		const note = file("Journal/2026-09-06.md");
		vault.files.set(note.path, "typing");
		openNote.looksAt(note.path);

		const write = writer.edit(note, (text) => `${text}+queued`);
		await turns(2);
		writer.teardown();

		await expect(write).rejects.toThrow(/unload/i);
		// The write never ran, so the note is as the person left it.
		expect(vault.files.get(note.path)).toBe("typing");
	});

	it("does not resolve a write left parked from before the unload", async () => {
		const note = file("Journal/2026-09-06.md");
		vault.files.set(note.path, "typing");
		openNote.looksAt(note.path);

		let firstRan = 0;
		const first = writer.edit(note, (text) => {
			firstRan += 1;
			return `${text}+first`;
		});
		await turns(2);
		writer.teardown();
		await expect(first).rejects.toThrow(/unload/i);

		const second = writer.edit(note, (text) => `${text}+second`);
		await expect(second).rejects.toThrow(/unload/i);

		expect(firstRan).toBe(0);
		expect(vault.files.get(note.path)).toBe("typing");
	});

	it("goes on writing a file the person does not have open", async () => {
		// After teardown every write was refused, whatever file it was for, and
		// refused with a message saying it had been waiting for the person to
		// leave the note. Such a write never waits for anything: it would have
		// resolved at once, so it still does.
		const note = file("Journal/2026-09-06.md");
		vault.files.set(note.path, "yesterday");
		openNote.looksAt("Work/Roof.md");
		writer.teardown();

		await expect(writer.edit(note, (text) => `${text}+queued`)).resolves.toBe("yesterday+queued");

		expect(vault.files.get(note.path)).toBe("yesterday+queued");
	});

	it("still refuses a write to the note the person is in", async () => {
		// The one case the message describes, and the one the swap leaves alone.
		const note = file("Journal/2026-09-06.md");
		vault.files.set(note.path, "typing");
		openNote.looksAt(note.path);
		writer.teardown();

		await expect(writer.edit(note, (text) => `${text}+queued`)).rejects.toThrow(/unload/i);

		expect(vault.files.get(note.path)).toBe("typing");
	});

	it("does nothing and throws nothing when no write is parked", () => {
		expect(() => writer.teardown()).not.toThrow();
		expect(() => writer.teardown()).not.toThrow();
	});

	it("still lands a parked write exactly once when the person leaves the note", async () => {
		const note = file("Journal/2026-09-06.md");
		vault.files.set(note.path, "typing");
		openNote.looksAt(note.path);

		let ran = 0;
		const write = writer.edit(note, (text) => {
			ran += 1;
			return `${text}+queued`;
		});
		await turns(2);
		openNote.looksAt("Projects/Roof.md");

		await expect(write).resolves.toBe("typing+queued");
		expect(ran).toBe(1);
	});

	it("says once that a write has been waiting a long time, however long it goes on", async () => {
		vi.useFakeTimers();
		const note = file("Journal/2026-09-06.md");
		vault.files.set(note.path, "typing");
		openNote.looksAt(note.path);

		const write = writer.edit(note, (text) => `${text}+queued`);
		await vi.advanceTimersByTimeAsync(1_000);
		// A moment's wait is the ordinary case and says nothing.
		expect(Notice.messages).toEqual([]);

		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain(note.path);

		// However long the person stays, they are told once and not again.
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(Notice.messages).toHaveLength(1);

		openNote.looksAt(null);
		await expect(write).resolves.toBe("typing+queued");
	});

	it("says nothing about a write that was let go before the threshold", async () => {
		vi.useFakeTimers();
		const note = file("Journal/2026-09-06.md");
		vault.files.set(note.path, "typing");
		openNote.looksAt(note.path);

		const write = writer.edit(note, (text) => `${text}+queued`);
		await turns(2);
		openNote.looksAt(null);
		await expect(write).resolves.toBe("typing+queued");

		await vi.advanceTimersByTimeAsync(60 * 60_000);
		expect(Notice.messages).toEqual([]);
	});
});

/**
 * Every public method of the writer. A mapped type over the class rather than a
 * hand-written list, so adding a public method and forgetting to audit it fails
 * to compile — the trick `SECTION_ORDER` uses in `vaultLayout.ts`.
 */
type PublicMethod = {
	[K in keyof NoteWriter]-?: NoteWriter[K] extends (...args: never[]) => unknown ? K : never;
}[keyof NoteWriter];

describe("NoteWriter — every failure arrives as a rejection", () => {
	let vault: FakeCreatingVault;
	let openNote: FakeOpenNote;
	let writer: NoteWriter;

	beforeEach(() => {
		vault = new FakeCreatingVault();
		openNote = new FakeOpenNote();
		writer = new NoteWriter(vault as unknown as Vault, openNote);
	});

	it("rejects rather than throwing when the daily-log folder is not set", async () => {
		// Both halves of the layout ship blank, so this is what an install that
		// has not been through the settings screen yet actually looks like.
		const layout = defaultData().core.layout;

		let answer!: Promise<TFile>;
		expect(() => {
			answer = writer.createDailyLog(new Date(2026, 8, 6), layout);
		}).not.toThrow();

		await expect(answer).rejects.toThrow(
			"The daily-log folder is not set. Answer it on the Effortless settings screen.",
		);
	});

	it("rejects rather than throwing when the filename pattern is not understood", async () => {
		const layout = { ...testLayout(), dailyLogFilename: "QQ" };

		let answer!: Promise<TFile>;
		expect(() => {
			answer = writer.createDailyLog(new Date(2026, 8, 6), layout);
		}).not.toThrow();

		await expect(answer).rejects.toThrow(
			'Effortless does not understand "QQ" in the daily-log filename pattern "QQ".',
		);
	});

	it("carries the path builder's own message, word for word", async () => {
		const layout = { ...testLayout(), dailyLogFilename: "QQ" };
		let fromTheBuilder = "";
		try {
			dailyLogPath(new Date(2026, 8, 6), layout);
		} catch (error) {
			fromTheBuilder = reasonOf(error);
		}
		expect(fromTheBuilder).not.toBe("");

		await expect(
			writer.createDailyLog(new Date(2026, 8, 6), layout),
		).rejects.toThrow(fromTheBuilder);
	});

	it("throws synchronously from no public method, whatever it is given", () => {
		const blank = defaultData().core.layout;
		const calls: Record<PublicMethod, () => unknown> = {
			edit: () =>
				writer.edit(file("note.md"), () => {
					throw new Error("nope");
				}),
			read: () => writer.read(file("nowhere.md")),
			createDailyLog: () => writer.createDailyLog(new Date(2026, 8, 6), blank),
			create: () => writer.create("new.md", "text"),
			rename: () => writer.rename(file("old.md"), "new.md"),
			trashIf: () => writer.trashIf(file("nowhere.md"), () => true),
			teardown: () => writer.teardown(),
		};

		for (const [name, call] of Object.entries(calls)) {
			let answer: unknown;
			expect(() => {
				answer = call();
			}, `${name} threw synchronously`).not.toThrow();
			// A rejection is the right answer here; an unheard one is not.
			void Promise.resolve(answer).catch(() => undefined);
		}
	});
});

/**
 * The mock's `Vault` and `FileManager` rather than this file's own
 * hand-rolled fakes: `rename` goes through `fileManager.renameFile`, and
 * proving it does — and that the rename follows a link — needs the mock's own
 * link rewriting (`__mocks__/obsidian.ts`'s `FileManager.renameFile`), which
 * the hand-rolled `FakeVault` above has no equivalent of.
 */
describe("NoteWriter — renaming a note through the queue", () => {
	let vault: MockVault;
	let fileManager: MockFileManager;
	let openNote: FakeOpenNote;
	let writer: NoteWriter;

	beforeEach(() => {
		vault = new MockVault();
		fileManager = new MockFileManager(vault);
		openNote = new FakeOpenNote();
		writer = new NoteWriter(vault as unknown as Vault, openNote, fileManager as unknown as FileManager);
	});

	it("moves the note; the file's path reads the new one afterwards", async () => {
		const oldPath = "Meetings/Standup.md";
		const newPath = "Meetings/2026/2026-09-21 Standup.md";
		const note = file(oldPath);
		vault.files.push(note);

		await writer.rename(note, newPath);

		expect(note.path).toBe(newPath);
		expect(vault.getFileByPath(newPath)).toBe(note);
		expect(vault.getFileByPath(oldPath)).toBeNull();
	});

	it("updates a wikilink elsewhere that named the old note, proving the call went through fileManager.renameFile and not vault.rename", async () => {
		const oldPath = "Meetings/Standup.md";
		const newPath = "Meetings/2026-09-21 Standup.md";
		const note = file(oldPath);
		vault.files.push(note);
		vault.allowReads({
			[oldPath]: "# Standup\n",
			"Journal/2026/2026-09-21.md": "## Calendar\n\n- [[Standup]] at 10:00\n",
		});

		await writer.rename(note, newPath);

		expect(vault.readableContents()?.get("Journal/2026/2026-09-21.md")).toBe(
			"## Calendar\n\n- [[2026-09-21 Standup]] at 10:00\n",
		);
	});

	it("refuses a rename to an occupied path, naming both paths, and touches neither file", async () => {
		const oldPath = "Meetings/Standup.md";
		const occupied = "Meetings/Retro.md";
		const note = file(oldPath);
		const other = file(occupied);
		vault.files.push(note, other);
		vault.allowReads({ [oldPath]: "old text", [occupied]: "occupied text" });

		await expect(writer.rename(note, occupied)).rejects.toThrow(
			`There is already a note at "${occupied}"; "${oldPath}" was not renamed.`,
		);

		expect(note.path).toBe(oldPath);
		expect(vault.readableContents()?.get(oldPath)).toBe("old text");
		expect(vault.readableContents()?.get(occupied)).toBe("occupied text");
	});

	it("runs a rename queued behind a pending edit on the same note after the edit, with the edit's text in the renamed file", async () => {
		const oldPath = "Meetings/Standup.md";
		const newPath = "Meetings/2026-09-21 Standup.md";
		const note = file(oldPath);
		vault.files.push(note);
		vault.allowReads({ [oldPath]: "start" });

		// Holds the edit the way "holds a write to the open note until the
		// person leaves it" (above) does, so the rename queued behind it has
		// something to run ahead of. A rename that reached fileManager.renameFile
		// without waiting its turn in the queue would move the file while the
		// edit is still held; the assertion below would then see the new path
		// instead of the old one, which is what makes this a test of the order
		// rather than of the end state alone. A macrotask boundary, not a fixed
		// number of microtask turns, is what is awaited before checking: a
		// rename that skipped the queue still resolves its own promise chain
		// (folder lookup, then the mocked renameFile) purely on microtasks, so
		// nothing here can prove that chain has run out except letting every
		// microtask drain first.
		openNote.looksAt(oldPath);

		const edited = writer.edit(note, (text) => `${text}+edited`);
		const renamed = writer.rename(note, newPath);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(note.path).toBe(oldPath);

		openNote.looksAt(null);
		await Promise.all([edited, renamed]);

		expect(note.path).toBe(newPath);
		expect(vault.readableContents()?.get(newPath)).toBe("start+edited");
		expect(vault.readableContents()?.has(oldPath)).toBe(false);
	});
});

describe("NoteWriter — telling of each day's log built from the template", () => {
	const templatePath = "Templates/Day.md";
	let vault: FakeCreatingVault;
	let told: Array<[string, string]>;
	let writer: NoteWriter;

	beforeEach(() => {
		vault = new FakeCreatingVault();
		told = [];
		writer = new NoteWriter(vault as unknown as Vault, new FakeOpenNote(), undefined, (date, diary) => told.push([date.toDateString(), diary]));
	});

	it("is told the day and the text the log holds under the diary heading, placeholders filled", async () => {
		vault.files.set(templatePath, "# Notes\n\n# Diary\n- What did I learn on {{date:YYYY-MM-DD}}?\n\n# After\nNot the diary.\n");

		await writer.createDailyLog(new Date(2026, 8, 6), { ...testLayout(), dailyLogTemplate: templatePath });

		expect(told).toEqual([[new Date(2026, 8, 6).toDateString(), "- What did I learn on 2026-09-06?\n"]]);
	});

	it("is told nothing for a log built from the built-in frame", async () => {
		await writer.createDailyLog(new Date(2026, 8, 6), testLayout());

		expect(told).toEqual([]);
	});

	it("is told nothing for a day whose log is already there", async () => {
		vault.files.set(templatePath, "# Notes\n\n# Diary\n- What did I learn today?\n");
		const layout = { ...testLayout(), dailyLogTemplate: templatePath };
		await writer.createDailyLog(new Date(2026, 8, 6), layout);
		told = [];

		await writer.createDailyLog(new Date(2026, 8, 6), layout);

		expect(told).toEqual([]);
	});

	it("is told nothing when the template cannot be built from, and the log is not built", async () => {
		vault.files.set(templatePath, "# Diary\n{{nonsense}}\n");

		await expect(writer.createDailyLog(new Date(2026, 8, 6), { ...testLayout(), dailyLogTemplate: templatePath })).rejects.toThrow();

		expect(told).toEqual([]);
		expect(vault.created).toEqual([]);
	});
});

describe("NoteWriter — a log built from the template carries the mark of its diary section", () => {
	const templatePath = "Templates/Day.md";
	// `fingerprintOf("- What did I learn today?")`, taken once.
	const MARK = 'effortless-built-diary: "25:13627175d8dfa1"';
	// Every section the layout names, so the builder adds none and the bytes are the template's.
	const SECTIONS = "# Notes\n\n## Overdue\n\n## Today\n\n## Calendar\n\n```schema\n| Time | Meeting |\n| --- | --- |\n```\n\n# Diary\n- What did I learn today?";
	const CRLF_SECTIONS = SECTIONS.replace(/\n/g, "\r\n");
	let vault: FakeCreatingVault;
	let writer: NoteWriter;

	beforeEach(() => {
		vault = new FakeCreatingVault();
		writer = new NoteWriter(vault as unknown as Vault, new FakeOpenNote());
	});

	it("as the last line of the template's frontmatter", async () => {
		vault.files.set(templatePath, `---\nprocessed:\n---\n${SECTIONS}\n`);

		const log = await writer.createDailyLog(new Date(2026, 8, 6), { ...testLayout(), dailyLogTemplate: templatePath });

		expect(vault.files.get(log.path)).toBe(`---\nprocessed:\n${MARK}\n---\n${SECTIONS}\n`);
	});

	it.each([
		["ending in a line break", `---\r\nprocessed:\r\n---\r\n${CRLF_SECTIONS}\r\n`, `---\r\nprocessed:\r\n${MARK}\r\n---\r\n${CRLF_SECTIONS}\r\n`],
		["not ending in one", `---\r\nprocessed:\r\n---\r\n${CRLF_SECTIONS}`, `---\r\nprocessed:\r\n${MARK}\r\n---\r\n${CRLF_SECTIONS}`],
	])("from a template with Windows line endings, %s, byte for byte", async (_case, template, expected) => {
		vault.files.set(templatePath, template);

		const log = await writer.createDailyLog(new Date(2026, 8, 6), { ...testLayout(), dailyLogTemplate: templatePath });

		expect(vault.files.get(log.path)).toBe(expected);
	});

	it("and a log built from the built-in frame carries none", async () => {
		const log = await writer.createDailyLog(new Date(2026, 8, 6), testLayout());

		expect(vault.files.get(log.path)).not.toContain("effortless-built-diary");
	});
});
