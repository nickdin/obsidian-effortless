/**
 * `NoteWriter.edit` over the port Obsidian gives (`openNoteFromWorkspace`), for a
 * note a view of another type shows in a split while a different note is the
 * active file.
 *
 * #1117 held a write while such a view showed the note, but only when the note was
 * also Obsidian's active file. A board keeps its own copy of the text
 * (`TextFileView.data`, `node_modules/obsidian/obsidian.d.ts:7053`) and saves it
 * later (`requestSave`, `:7059`), so a write reaching the file under a board that
 * sits beside another, more recently active note lost the board's unsaved edit.
 * The hold now asks every open view, and ends when no such view shows the note.
 *
 * Closing a tab fires `layout-change` (`:8084`), not `file-open` (`:8078`), so the
 * fake workspace below fires only the event Obsidian fires for each act; a writer
 * listening to the wrong one would never release.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Plugin, TFile, Vault } from "obsidian";
import { MarkdownView, WorkspaceLeaf } from "./__mocks__/obsidian";
import { NoteWriter, openNoteFromWorkspace } from "../core/noteWriter";
import { markProcessedText } from "../features/review/markProcessed";

const PATH = "Journal/2026-10-04.md";
const OTHER = "Journal/2026-10-05.md";
const NOTE = { path: PATH } as unknown as TFile;
const ASKED = { askedFor: true } as const;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

class FakeVault {
	readonly files = new Map<string, string>();

	async process(file: TFile, fn: (data: string) => string): Promise<string> {
		const before = this.files.get(file.path) ?? "";
		await Promise.resolve();
		const after = fn(before);
		this.files.set(file.path, after);
		return after;
	}
}

/** Whether `promise` has settled, without waiting on it for ever. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
	let done = false;
	void promise.then(
		() => (done = true),
		() => (done = true),
	);
	await settle();
	return done;
}

type Board = { getViewType: () => string; file: { path: string } | null; requestSave: () => void };

function board(path: string): Board {
	return { getViewType: () => "kanban-board", file: { path }, requestSave: () => undefined };
}

/**
 * A workspace of two splits: a board showing `PATH` and a markdown tab in source
 * mode showing `OTHER`, which is the active file. `closeBoard` removes the board's
 * leaf and fires `layout-change`; `boardGoesTo` points the board at another note and
 * fires `file-open`; `activate` makes a note the active file and fires `file-open`.
 */
function splitWorkspace(extra: WorkspaceLeaf[] = []) {
	let activeFile: string | null = OTHER;
	const listeners = new Map<string, Array<() => void>>();
	const fire = (name: string) => {
		for (const listener of listeners.get(name) ?? []) listener();
	};
	const theBoard = board(PATH);
	const boardLeaf = new WorkspaceLeaf(theBoard as never);
	const editor = new WorkspaceLeaf(
		Object.assign(new MarkdownView({ path: OTHER } as never, "", "source"), { requestSave: () => undefined }),
	);
	const leaves: WorkspaceLeaf[] = [boardLeaf, editor, ...extra];
	const workspace = {
		getActiveFile: () => (activeFile === null ? null : { path: activeFile }),
		getLeavesOfType: (type: string) => leaves.filter((leaf) => leaf.view.getViewType() === type),
		iterateAllLeaves: (callback: (leaf: WorkspaceLeaf) => void) => {
			for (const leaf of [...leaves]) callback(leaf);
		},
		on: (name: string, listener: () => void) => {
			listeners.set(name, [...(listeners.get(name) ?? []), listener]);
			return null;
		},
	};
	const plugin = { app: { workspace }, registerEvent: () => undefined } as unknown as Plugin;
	return {
		plugin,
		closeBoard: () => {
			leaves.splice(leaves.indexOf(boardLeaf), 1);
			fire("layout-change");
		},
		boardGoesTo: (path: string) => {
			theBoard.file = { path };
			fire("file-open");
		},
		activate: (path: string) => {
			activeFile = path;
			fire("file-open");
		},
	};
}

describe("NoteWriter.edit, for a note a board shows in a split beside another active note", () => {
	let vault: FakeVault;

	beforeEach(() => {
		vault = new FakeVault();
		vault.files.set(PATH, "before");
	});

	function writerOver(workspace: ReturnType<typeof splitWorkspace>): NoteWriter {
		return new NoteWriter(vault as unknown as Vault, openNoteFromWorkspace(workspace.plugin));
	}

	// If wrong (the hold decided from the active file only, as before #1164): the
	// active file is the other note, nothing is parked, and the file already reads
	// "before + date" while the board still holds its own unsaved copy.
	it("holds an asked-for write until the board stops showing the note, then writes", async () => {
		const workspace = splitWorkspace();
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);

		expect(await settled(write)).toBe(false);
		expect(vault.files.get(PATH)).toBe("before");
		workspace.boardGoesTo(OTHER);
		expect(await write).toBe("before + date");
		expect(vault.files.get(PATH)).toBe("before + date");
	});

	// If wrong (only `file-open` releases): closing the board fires `layout-change`
	// alone, and the write stays parked after the board is gone.
	it("releases the write when the board's tab is closed", async () => {
		const workspace = splitWorkspace();
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);
		expect(await settled(write)).toBe(false);
		workspace.closeBoard();

		expect(await write).toBe("before + date");
	});

	// If wrong (the active note decides the release): the other note stays active
	// throughout, so a write released by an `activate` would show as settled here.
	it("keeps holding while the person only moves between other notes, the board still showing the note", async () => {
		const workspace = splitWorkspace();
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);
		// Parked first: an event fired before the write joins its queue releases nothing.
		expect(await settled(write)).toBe(false);
		workspace.activate("Journal/2026-10-06.md");
		workspace.activate(OTHER);

		expect(await settled(write)).toBe(false);
		expect(vault.files.get(PATH)).toBe("before");
		workspace.closeBoard();
		await write;
	});

	// If wrong (the exemption reaches every write): a background write lands at once
	// beside the board.
	it("holds a write nobody asked for as well", async () => {
		const workspace = splitWorkspace();
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, () => "after");

		expect(await settled(write)).toBe(false);
		expect(vault.files.get(PATH)).toBe("before");
		workspace.closeBoard();
		await write;
	});

	// If wrong (a held write releases only the first): the second is still parked.
	it("releases every write parked on the note, in order", async () => {
		const workspace = splitWorkspace();
		const writer = writerOver(workspace);

		const first = writer.edit(NOTE, (text) => `${text} + one`, ASKED);
		const second = writer.edit(NOTE, (text) => `${text} + two`, ASKED);
		expect(await settled(second)).toBe(false);
		workspace.closeBoard();
		await Promise.all([first, second]);

		expect(vault.files.get(PATH)).toBe("before + one + two");
	});

	// If wrong (the new hold reaches the markdown tab): a source-mode tab showing
	// the note while another is active would now park. Passes on the old code too:
	// the markdown-editor behaviour is unchanged, since Obsidian reloads an editor
	// whose file changed.
	it("does not hold a note only a markdown tab shows, when another note is active", async () => {
		const workspace = splitWorkspace([
			new WorkspaceLeaf(Object.assign(new MarkdownView({ path: PATH } as never, "", "source"), { requestSave: () => undefined })),
		]);
		workspace.closeBoard();
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);

		expect(await settled(write)).toBe(true);
		expect(vault.files.get(PATH)).toBe("before + date");
	});

	// If wrong (any view naming the note holds): Obsidian's Outline pane answers
	// `file` and has no `requestSave`, so it would park the write.
	it("does not hold a note only a side pane names", async () => {
		const pane = { getViewType: () => "outline", file: { path: PATH } };
		const workspace = splitWorkspace([new WorkspaceLeaf(pane as never)]);
		workspace.closeBoard();
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);

		expect(await settled(write)).toBe(true);
		expect(vault.files.get(PATH)).toBe("before + date");
	});

	// If wrong: a `\r\n` becomes `\n`, a final line break is added or lost, the field
	// is written while the board still shows the note, or never written after it
	// goes. This route has no undo of its own: the editor route's undo is one editor
	// transaction (`src/features/review/editorRoute.ts`), which a view of another
	// type, having no editor, never reaches — so the bytes of the held write are the
	// whole check.
	it.each([
		["no final line break", "---\r\nprocessed:\r\ntitle: Pier note\r\n---\r\n- [ ] one task\r\n- [ ] second task"],
		["a final line break", "---\r\nprocessed:\r\ntitle: Quay note\r\n---\r\n- [ ] one task\r\n"],
	])("holds, then writes the date into a Windows-endings note with %s, changing only that line", async (_name, original) => {
		vault.files.set(PATH, original);
		const workspace = splitWorkspace();
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => markProcessedText(text, "processed", "2026-10-13"), ASKED);

		expect(await settled(write)).toBe(false);
		expect(vault.files.get(PATH)).toBe(original);
		workspace.closeBoard();
		await write;
		expect(vault.files.get(PATH)).toBe(original.replace("processed:\r\n", "processed: 2026-10-13\r\n"));
	});
});
