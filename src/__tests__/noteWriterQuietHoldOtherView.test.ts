/**
 * The quiet hold
 * over the port Obsidian gives (`openNoteFromWorkspace`), for a note a view of
 * another type shows.
 *
 * #1117 made a board or a drawing that shows a note hold an asked-for write;
 * #1139 made the diary-date write hold without its waiting notice. The two meet
 * here. The hold of a write nobody asked for is decided by the open note's path
 * alone (`untilLeft`, `src/core/noteWriter.ts`), so the board decides nothing
 * for it: the quiet hold holds, and stays silent, while a board shows the active
 * note, exactly as the loud hold does, and only the notice differs. Each
 * ticket's own tests use a port of their own, so this is the one test that runs
 * both together through the port Obsidian gives. The clock is faked; every path
 * is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plugin, TFile, Vault } from "obsidian";
import { Notice, WorkspaceLeaf } from "./__mocks__/obsidian";
import { NoteWriter, openNoteFromWorkspace } from "../core/noteWriter";

/** The writer's wait before its notice (`HELD_WRITE_NOTICE_MS`, `src/core/noteWriter.ts:201`, not exported). */
const HELD_WRITE_NOTICE_MS = 30_000;

const PATH = "Journal/2026-10-04.md";
const OTHER = "Journal/2026-10-05.md";
const NOTE = { path: PATH } as unknown as TFile;
const WAITING_NOTICE = `Effortless: a background write to ${PATH} is waiting. It will happen as soon as the note's tab is closed, sent to another note or put in the background.`;

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

/** A Kanban-type board showing `PATH`, the active file, and nothing else open. */
function boardOverTheNote() {
	let activeFile: string | null = PATH;
	const listeners: Array<() => void> = [];
	const board = { getViewType: () => "kanban-board", file: { path: PATH }, requestSave: () => undefined };
	const leaves = [new WorkspaceLeaf(board as never)];
	const workspace = {
		getActiveFile: () => (activeFile === null ? null : { path: activeFile }),
		getLeavesOfType: (type: string) => leaves.filter((leaf) => leaf.view.getViewType() === type),
		iterateAllLeaves: (callback: (leaf: WorkspaceLeaf) => void) => {
			for (const leaf of leaves) callback(leaf);
		},
		on: (_name: string, listener: () => void) => {
			listeners.push(listener);
			return null;
		},
	};
	const plugin = { app: { workspace }, registerEvent: () => undefined } as unknown as Plugin;
	return {
		plugin,
		leave: () => {
			// The board's tab goes to the next note with the person, as in Obsidian;
			// left showing `PATH` it would still hold the write.
			board.file = { path: OTHER };
			activeFile = OTHER;
			for (const listener of listeners) listener();
		},
	};
}

describe("a quiet hold, while a board shows the active note", () => {
	let vault: FakeVault;

	beforeEach(() => {
		vi.useFakeTimers();
		Notice.messages = [];
		vault = new FakeVault();
		vault.files.set(PATH, "before");
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// If wrong (the quiet option skips the hold rather than the notice, or the
	// board is not seen as showing the note): the file reads "before + date"
	// before the person leaves. If the notice is not the only thing dropped, the
	// loud write below differs from the quiet one in more than its notice.
	it("holds the write until the person leaves the board, and raises no notice, where the same write held loudly does", async () => {
		const quiet = boardOverTheNote();
		const quietWrite = new NoteWriter(vault as unknown as Vault, openNoteFromWorkspace(quiet.plugin)).edit(
			NOTE,
			(text) => `${text} + date`,
			{ quietHold: true },
		);
		await vi.advanceTimersByTimeAsync(HELD_WRITE_NOTICE_MS + 1000);
		expect(vault.files.get(PATH)).toBe("before");
		expect(Notice.messages).toEqual([]);
		quiet.leave();
		expect(await quietWrite).toBe("before + date");

		vault.files.set(PATH, "before");
		const loud = boardOverTheNote();
		const loudWrite = new NoteWriter(vault as unknown as Vault, openNoteFromWorkspace(loud.plugin)).edit(
			NOTE,
			(text) => `${text} + date`,
		);
		await vi.advanceTimersByTimeAsync(HELD_WRITE_NOTICE_MS + 1000);
		expect(vault.files.get(PATH)).toBe("before");
		expect(Notice.messages).toEqual([WAITING_NOTICE]);
		loud.leave();
		expect(await loudWrite).toBe("before + date");
	});
});
