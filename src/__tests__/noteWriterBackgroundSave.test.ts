/**
 * `NoteWriter` for a note a board shows in a tab the person has switched away
 * from, while the board still holds an edit it has not saved.
 *
 * #1192 lets a held write go when the board's tab goes to the background. The
 * drive (`docs/acceptance-shots/issue-1192-tab-switch-drive.txt`, step 2) showed
 * what that cost a board that had not saved: the write landed, the board reloaded
 * the file, and its edit was gone. So before a write touches the note, every view
 * that keeps its own copy of it and is loaded but not on screen is asked to save
 * (`TextFileView.save`, `node_modules/obsidian/obsidian.d.ts:7081`), and the write
 * waits for that save to finish.
 *
 * The fake board keeps its text in `data`, writes it to the fake vault on `save`,
 * and reloads from the vault when the vault changes under it — the stand-in board
 * of the drive, which never saves on a tab switch. Whether a real Kanban or
 * Excalidraw board saves on its own before the write lands is not established.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Plugin, TFile, Vault } from "obsidian";
import { MarkdownView, Notice, WorkspaceLeaf } from "./__mocks__/obsidian";
import { NoteWriter, openNoteFromWorkspace } from "../core/noteWriter";

const PATH = "Journal/2026-10-04.md";
const OTHER = "Journal/2026-10-05.md";
const NOTE = { path: PATH } as unknown as TFile;
const ASKED = { askedFor: true } as const;
const addDate = (text: string) => `${text} + date`;
const SAVE_FAILED = `Effortless: a write to ${PATH} is waiting. A tab in the background shows the note with changes of its own, and saving them first failed: disk full. The write will be tried again at your next change of tab, and goes at once if that tab is closed.`;
const NO_SAVE = `Effortless: a write to ${PATH} is waiting. A tab in the background shows the note with changes of its own, and saving them first failed: its view (kanban-board) keeps its own copy of the note and has no way to be asked to save it. The write will be tried again at your next change of tab, and goes at once if that tab is closed.`;
const UNLOADED_AFTER_FAILED_SAVE = `Effortless: this write did not happen. The plugin was unloaded while the write was waiting for a tab in the background to save its own changes to ${PATH}.`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

class FakeVault {
	readonly files = new Map<string, string>();
	/** Called after every write, as Obsidian's `modify` event reaches an open view. */
	onWrite: (path: string) => void = () => undefined;

	async process(file: TFile, fn: (data: string) => string): Promise<string> {
		const after = fn(this.files.get(file.path) ?? "");
		this.write(file.path, after);
		return after;
	}

	async read(file: TFile): Promise<string> {
		return this.files.get(file.path) ?? "";
	}

	write(path: string, text: string): void {
		this.files.set(path, text);
		this.onWrite(path);
	}
}

async function settled(promise: Promise<unknown>): Promise<boolean> {
	let done = false;
	void promise.then(
		() => (done = true),
		() => (done = true),
	);
	await settle();
	return done;
}

/** Resolves or rejects a promise from outside it. */
function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/**
 * A board on `PATH` and a markdown tab on `OTHER` in one tab group, the board's tab
 * selected. The board's `save` writes its `data` to the vault, or, with
 * `saveWith` set, runs that instead. `select` is the person clicking a tab:
 * that tab is shown, the other hidden, and the events Obsidian fires go out.
 * `close` removes the board's tab; the markdown tab is then shown and active.
 */
function boardWorkspace(vault: FakeVault) {
	let activeFile = PATH;
	const listeners = new Map<string, Array<() => void>>();
	const fire = (name: string) => {
		for (const listener of listeners.get(name) ?? []) listener();
	};
	const shown = { board: true, editor: false };
	const board = {
		getViewType: () => "kanban-board",
		file: { path: PATH },
		data: vault.files.get(PATH) ?? "",
		saves: 0,
		saveWith: undefined as undefined | (() => Promise<void>),
		requestSave: () => undefined,
		save: async (): Promise<void> => {
			board.saves += 1;
			if (board.saveWith) return board.saveWith();
			vault.write(PATH, board.data);
		},
		containerEl: { isShown: () => shown.board },
	};
	vault.onWrite = (path) => {
		if (path === PATH && tabs.includes(boardLeaf)) board.data = vault.files.get(PATH) ?? "";
	};
	const editorView = Object.assign(new MarkdownView({ path: OTHER } as never, "", "source"), {
		containerEl: { isShown: () => shown.editor },
	});
	const boardLeaf = new WorkspaceLeaf(board as never);
	const editorLeaf = new WorkspaceLeaf(editorView as never);
	let tabs = [boardLeaf, editorLeaf];
	const workspace = {
		getActiveFile: () => ({ path: activeFile }),
		getLeavesOfType: (type: string) => tabs.filter((leaf) => leaf.view.getViewType() === type),
		iterateAllLeaves: (callback: (leaf: WorkspaceLeaf) => void) => {
			for (const leaf of [...tabs]) callback(leaf);
		},
		on: (name: string, listener: () => void) => {
			listeners.set(name, [...(listeners.get(name) ?? []), listener]);
			return null;
		},
	};
	return {
		plugin: { app: { workspace }, registerEvent: () => undefined } as unknown as Plugin,
		board,
		/** The person clicks the markdown tab. */
		leaveBoard: () => {
			shown.board = false;
			shown.editor = true;
			activeFile = OTHER;
			fire("active-leaf-change");
			fire("file-open");
		},
		/** The person clicks the board's tab again. */
		backToBoard: () => {
			shown.board = true;
			shown.editor = false;
			activeFile = PATH;
			fire("active-leaf-change");
			fire("file-open");
		},
		/** Some other change of the layout, with the board still in the background. */
		layoutChange: () => fire("layout-change"),
		close: () => {
			tabs = tabs.filter((leaf) => leaf !== boardLeaf);
			shown.editor = true;
			activeFile = OTHER;
			fire("layout-change");
			fire("active-leaf-change");
			fire("file-open");
		},
	};
}

describe("NoteWriter, for a note a board in a background tab holds unsaved", () => {
	let vault: FakeVault;

	beforeEach(() => {
		vault = new FakeVault();
		vault.files.set(PATH, "before");
		Notice.messages = [];
	});

	function writerOver(workspace: ReturnType<typeof boardWorkspace>): NoteWriter {
		return new NoteWriter(vault as unknown as Vault, openNoteFromWorkspace(workspace.plugin));
	}

	// If wrong (the release lets the write go without asking the board to save, as
	// before #1197): the write lands on "before", the board reloads, and its edit is
	// gone — the file reads "before + date".
	it("keeps the board's unsaved edit when a held write is let go by a tab switch", async () => {
		const workspace = boardWorkspace(vault);
		const writer = writerOver(workspace);
		workspace.board.data = "before BOARD-EDIT";

		const write = writer.edit(NOTE, addDate, ASKED);
		expect(await settled(write)).toBe(false);
		workspace.leaveBoard();

		expect(await write).toBe("before BOARD-EDIT + date");
		expect(vault.files.get(PATH)).toBe("before BOARD-EDIT + date");
		expect(workspace.board.data).toBe("before BOARD-EDIT + date");
	});
	// If wrong (the write does not wait for the save it asked for): the file carries
	// the date while the board's save is still pending.
	it("does not write before a slow save has finished", async () => {
		const workspace = boardWorkspace(vault);
		const writer = writerOver(workspace);
		workspace.board.data = "before BOARD-EDIT";
		const slow = deferred();
		workspace.board.saveWith = async () => {
			await slow.promise;
			vault.write(PATH, workspace.board.data);
		};

		const write = writer.edit(NOTE, addDate, ASKED);
		workspace.leaveBoard();

		expect(await settled(write)).toBe(false);
		expect(workspace.board.saves).toBe(1);
		expect(vault.files.get(PATH)).toBe("before");
		slow.resolve();
		expect(await write).toBe("before BOARD-EDIT + date");
	});

	// If wrong (only a parked write asks for the save): a press with the board's tab
	// already in the background is let through at once (#1085's `askedFor`), and the
	// date lands on "before" without the board's edit.
	it("saves a board already in the background before a write the person asked for", async () => {
		const workspace = boardWorkspace(vault);
		const writer = writerOver(workspace);
		workspace.board.data = "before BOARD-EDIT";
		workspace.leaveBoard();

		expect(await writer.edit(NOTE, addDate, ASKED)).toBe("before BOARD-EDIT + date");
	});

	// If wrong (a board's absence is read as a failed save, or holds the write): the
	// write waits after the board's tab is closed.
	it("lets the write go without asking a board whose tab was closed", async () => {
		const workspace = boardWorkspace(vault);
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, addDate, ASKED);
		expect(await settled(write)).toBe(false);
		workspace.close();

		expect(await write).toBe("before + date");
	});

	// If wrong (`trashIf` decides without asking the board to save): it reads
	// "before" and trashes the note under the board's edit.
	it("saves a board in the background before deciding whether to trash its note", async () => {
		const workspace = boardWorkspace(vault);
		const trashed: string[] = [];
		const writer = new NoteWriter(vault as unknown as Vault, openNoteFromWorkspace(workspace.plugin), {
			trashFile: async (file: TFile) => void trashed.push(file.path),
		} as never);
		workspace.board.data = "before BOARD-EDIT";
		workspace.leaveBoard();

		expect(await writer.trashIf(NOTE, (text) => text === "before")).toBe(false);
		expect(trashed).toEqual([]);
	});
	// If wrong (a failed save is swallowed, or the write goes on regardless): the
	// date lands on "before", and nothing is said; or the write rejects and is gone.
	it("says so and keeps the write held when the board fails to save, and writes once it can", async () => {
		const workspace = boardWorkspace(vault);
		const writer = writerOver(workspace);
		workspace.board.data = "before BOARD-EDIT";
		workspace.board.saveWith = () => Promise.reject(new Error("disk full"));

		const write = writer.edit(NOTE, addDate, ASKED);
		workspace.leaveBoard();

		expect(await settled(write)).toBe(false);
		expect(vault.files.get(PATH)).toBe("before");
		expect(Notice.messages).toEqual([SAVE_FAILED]);

		workspace.board.saveWith = undefined;
		workspace.layoutChange();
		expect(await write).toBe("before BOARD-EDIT + date");
		expect(workspace.board.saves).toBe(2);
		expect(Notice.messages).toEqual([SAVE_FAILED]);
	});

	// If wrong (the retry ignores the board coming back on screen): the person
	// returns to the board and the write lands under it while they type.
	it("holds a write whose save failed for as long as the board is back on screen", async () => {
		const workspace = boardWorkspace(vault);
		const writer = writerOver(workspace);
		workspace.board.saveWith = () => Promise.reject(new Error("disk full"));
		const write = writer.edit(NOTE, addDate, ASKED);
		workspace.leaveBoard();
		expect(await settled(write)).toBe(false);

		workspace.board.saveWith = undefined;
		workspace.backToBoard();

		expect(await settled(write)).toBe(false);
		expect(workspace.board.saves).toBe(1);
		workspace.leaveBoard();
		expect(await write).toBe("before + date");
	});

	// If wrong (a write parked after a failed save is left out of teardown, or is
	// refused for the wrong cause): it never settles, or says it was waiting for the
	// person to leave a note they had already left.
	it("refuses a write still held by a failed save when the plugin unloads, naming the save", async () => {
		const workspace = boardWorkspace(vault);
		const writer = writerOver(workspace);
		workspace.board.saveWith = () => Promise.reject(new Error("disk full"));
		const write = writer.edit(NOTE, addDate, ASKED);
		workspace.leaveBoard();
		expect(await settled(write)).toBe(false);

		writer.teardown();

		await expect(write).rejects.toThrow(UNLOADED_AFTER_FAILED_SAVE);
		expect(vault.files.get(PATH)).toBe("before");
	});

	// If wrong (a view without `save` is skipped): the write lands under it.
	it("holds the write for a view that keeps its own copy and cannot be asked to save", async () => {
		const workspace = boardWorkspace(vault);
		const writer = writerOver(workspace);
		(workspace.board as { save?: unknown }).save = undefined;
		workspace.leaveBoard();

		const write = writer.edit(NOTE, addDate, ASKED);

		expect(await settled(write)).toBe(false);
		expect(vault.files.get(PATH)).toBe("before");
		expect(Notice.messages).toEqual([NO_SAVE]);
	});
	// If wrong (the hold ends on hide and the save is asked for afterwards, with no
	// look back): the person returns to the board while it saves, and the write lands
	// under it as soon as the save resolves.
	it("holds again when the person comes back to the board while it saves, and saves again when they leave", async () => {
		const workspace = boardWorkspace(vault);
		const writer = writerOver(workspace);
		workspace.board.data = "before BOARD-EDIT";
		const slow = deferred();
		workspace.board.saveWith = async () => {
			await slow.promise;
			vault.write(PATH, workspace.board.data);
		};
		const write = writer.edit(NOTE, addDate, ASKED);
		workspace.leaveBoard();
		expect(await settled(write)).toBe(false);

		workspace.backToBoard();
		slow.resolve();
		workspace.board.saveWith = undefined;

		expect(await settled(write)).toBe(false);
		expect(vault.files.get(PATH)).toBe("before BOARD-EDIT");
		workspace.board.data = "before BOARD-EDIT AGAIN";
		workspace.leaveBoard();
		expect(await write).toBe("before BOARD-EDIT AGAIN + date");
		expect(workspace.board.saves).toBe(2);
	});

	// If wrong (a read joins the queue a write parked by a failed save sits in): the
	// read waits behind it for as long as the save keeps failing.
	it("answers a read of the note while a write waits on a failed save", async () => {
		const workspace = boardWorkspace(vault);
		const writer = writerOver(workspace);
		workspace.board.saveWith = () => Promise.reject(new Error("disk full"));
		const write = writer.edit(NOTE, addDate, ASKED);
		workspace.leaveBoard();
		expect(await settled(write)).toBe(false);

		const read = writer.read(NOTE);

		expect(await settled(read)).toBe(true);
		expect(await read).toBe("before");
	});
});
