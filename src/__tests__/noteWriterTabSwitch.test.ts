/**
 * `NoteWriter.edit` for a note a board shows in a tab the person then switches
 * away from.
 *
 * #1164's own sentence is that the file stays unchanged *until the board's note is
 * left*. A board in a tab that was selected and no longer is is still an open,
 * loaded leaf naming the note, but nothing of it is on screen: the person has left
 * it, as #1117 counted. A view counts as showing the note only while its element
 * is shown (`HTMLElement.isShown`, `node_modules/obsidian/obsidian.d.ts:104`, on
 * `View.containerEl`, `:7615`) — a tab group hides the elements of its unselected
 * tabs. Whether Obsidian actually hides them is established by the drive
 * (`docs/acceptance-shots/issue-1192-tab-switch-drive.txt`), not by this fake.
 *
 * Obsidian fires `active-leaf-change` when the person switches tabs
 * (`obsidian.d.ts:8071`) and `file-open` only when the active file changes
 * (`:8078`), so the fake fires only the events a switch fires: a switch to a tab
 * with no file fires `active-leaf-change` alone.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Plugin, TFile, Vault } from "obsidian";
import { MarkdownView, WorkspaceLeaf } from "./__mocks__/obsidian";
import { NoteWriter, openNoteFromWorkspace } from "../core/noteWriter";

const PATH = "Journal/2026-10-04.md";
const OTHER = "Journal/2026-10-05.md";
const NOTE = { path: PATH } as unknown as TFile;
const ASKED = { askedFor: true } as const;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

class FakeVault {
	readonly files = new Map<string, string>();

	async process(file: TFile, fn: (data: string) => string): Promise<string> {
		const after = fn(this.files.get(file.path) ?? "");
		this.files.set(file.path, after);
		return after;
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

/** A tab with its own element, shown or not as its tab group has it. */
function tab(view: object, shown: boolean) {
	const state = { shown };
	const containerEl = { isShown: () => state.shown };
	return { leaf: new WorkspaceLeaf(Object.assign(view, { containerEl }) as never), state };
}

/**
 * A board on `PATH` (its tab selected) and a markdown tab on `OTHER` in the same tab
 * group, in the background; with `sideNote`, a second group beside it whose markdown
 * tab on `OTHER` is on screen and active. `select` is the person clicking a tab of
 * the board's group: that tab's element is shown and the group's others are hidden,
 * the active file follows the tab, and the events Obsidian fires for it go out —
 * `file-open` only when the active file actually changed.
 */
function tabWorkspace(options: { sideNote?: boolean } = {}) {
	let activeFile = options.sideNote ? OTHER : PATH;
	const listeners = new Map<string, Array<() => void>>();
	const fire = (name: string) => {
		for (const listener of listeners.get(name) ?? []) listener();
	};
	const markdown = (path: string) =>
		Object.assign(new MarkdownView({ path } as never, "", "source"), { requestSave: () => undefined });
	// `save` as every `TextFileView` has it (`obsidian.d.ts:7081`); this board has
	// nothing unsaved, so asking it to save before a write changes nothing.
	const board = tab(
		{ getViewType: () => "kanban-board", file: { path: PATH }, requestSave: () => undefined, save: async () => undefined },
		true,
	);
	const editor = tab(markdown(OTHER), false);
	const side = tab(markdown(OTHER), true);
	const group = [board, editor];
	const tabs = options.sideNote ? [board, editor, side] : [board, editor];
	const workspace = {
		getActiveFile: () => ({ path: activeFile }),
		getLeavesOfType: (type: string) => tabs.map((t) => t.leaf).filter((leaf) => leaf.view.getViewType() === type),
		iterateAllLeaves: (callback: (leaf: WorkspaceLeaf) => void) => {
			for (const t of [...tabs]) callback(t.leaf);
		},
		on: (name: string, listener: () => void) => {
			listeners.set(name, [...(listeners.get(name) ?? []), listener]);
			return null;
		},
	};
	return {
		plugin: { app: { workspace }, registerEvent: () => undefined } as unknown as Plugin,
		select: (to: (typeof group)[number], file: string) => {
			for (const t of group) t.state.shown = t === to;
			const changed = file !== activeFile;
			activeFile = file;
			fire("active-leaf-change");
			if (changed) fire("file-open");
		},
		/** The person moves the board's tab beside the markdown tab, both on screen. */
		bothShown: () => {
			board.state.shown = true;
			editor.state.shown = true;
			activeFile = OTHER;
			fire("active-leaf-change");
			fire("file-open");
		},
		board,
		editor,
	};
}

describe("NoteWriter.edit, for a note a board shows in a tab the person switches away from", () => {
	let vault: FakeVault;

	beforeEach(() => {
		vault = new FakeVault();
		vault.files.set(PATH, "before");
	});

	function writerOver(workspace: ReturnType<typeof tabWorkspace>): NoteWriter {
		return new NoteWriter(vault as unknown as Vault, openNoteFromWorkspace(workspace.plugin));
	}

	// If wrong (a loaded leaf counts as showing the note, as in 221ba53): the board's
	// leaf still names the note in the background tab, so the write stays parked after
	// the switch for as long as the board's tab stays open.
	it("releases a parked write when the person switches to a markdown tab on another note", async () => {
		const workspace = tabWorkspace();
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);
		expect(await settled(write)).toBe(false);
		expect(vault.files.get(PATH)).toBe("before");
		workspace.select(workspace.editor, OTHER);

		expect(await write).toBe("before + date");
		expect(vault.files.get(PATH)).toBe("before + date");
	});

	// If wrong (the release waits for `file-open`): the markdown tab in the second
	// group is already the active file, so the switch leaves the active file where it
	// was and fires `active-leaf-change` alone.
	it("releases a parked write on `active-leaf-change` alone, when the active file does not change", async () => {
		const workspace = tabWorkspace({ sideNote: true });
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);
		expect(await settled(write)).toBe(false);
		workspace.select(workspace.editor, OTHER);

		expect(await write).toBe("before + date");
	});

	// If wrong (the release is a one-way latch, or the hold ignores visibility):
	// once the board's tab is back on screen the note is held again.
	it("holds again when the person switches back to the board", async () => {
		const workspace = tabWorkspace();
		const writer = writerOver(workspace);
		workspace.select(workspace.editor, OTHER);
		workspace.select(workspace.board, PATH);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);

		expect(await settled(write)).toBe(false);
		expect(vault.files.get(PATH)).toBe("before");
		workspace.select(workspace.editor, OTHER);
		await write;
	});

	// If wrong (any switch releases): a board still on screen beside the tab switched
	// to keeps holding.
	it("keeps holding while the board is still on screen beside the tab switched to", async () => {
		const workspace = tabWorkspace();
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);
		expect(await settled(write)).toBe(false);
		workspace.bothShown();

		expect(await settled(write)).toBe(false);
		expect(vault.files.get(PATH)).toBe("before");
	});

	// If wrong (the hold ignores visibility for a write nobody is waiting behind): a
	// board in a background tab would park the write.
	it("writes at once when the board's tab is already in the background", async () => {
		const workspace = tabWorkspace();
		workspace.select(workspace.editor, OTHER);
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);

		expect(await settled(write)).toBe(true);
		expect(vault.files.get(PATH)).toBe("before + date");
	});
});
