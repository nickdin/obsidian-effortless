/**
 * `NoteWriter.read` while a write is parked for a note a view of another type shows
 * in a split beside a different active note.
 *
 * `read` documents that it never waits behind a held write: reading does not
 * conflict with typing, so it must answer at once whenever the write's own hold
 * (`isHeld`) applies, not only when the note is the active file. A board in a split
 * holds the note without being the active file, and a read joining the queue behind
 * the parked write would wait until the board is gone.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Plugin, TFile, Vault } from "obsidian";
import { MarkdownView, WorkspaceLeaf } from "./__mocks__/obsidian";
import { NoteWriter, openNoteFromWorkspace } from "../core/noteWriter";

const PATH = "Journal/2026-10-04.md";
const OTHER = "Journal/2026-10-05.md";
const NOTE = { path: PATH } as unknown as TFile;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

class FakeVault {
	readonly files = new Map<string, string>();

	async read(file: TFile): Promise<string> {
		return this.files.get(file.path) ?? "";
	}

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

/** A board showing `PATH` in one split, a markdown tab on `OTHER` active in the other. */
function splitWorkspace() {
	const board = { getViewType: () => "kanban-board", file: { path: PATH }, requestSave: () => undefined };
	const leaves = [
		new WorkspaceLeaf(board as never),
		new WorkspaceLeaf(Object.assign(new MarkdownView({ path: OTHER } as never, "", "source"), { requestSave: () => undefined })),
	];
	const workspace = {
		getActiveFile: () => ({ path: OTHER }),
		getLeavesOfType: (type: string) => leaves.filter((leaf) => leaf.view.getViewType() === type),
		iterateAllLeaves: (callback: (leaf: WorkspaceLeaf) => void) => {
			for (const leaf of [...leaves]) callback(leaf);
		},
		on: () => null,
	};
	return { plugin: { app: { workspace }, registerEvent: () => undefined } as unknown as Plugin };
}

describe("NoteWriter.read, for a note a board shows in a split beside another active note", () => {
	let vault: FakeVault;

	beforeEach(() => {
		vault = new FakeVault();
		vault.files.set(PATH, "before");
	});

	// If wrong (the read skips the queue only for the active file): the write parked
	// for the board holds the queue, and the read never settles while the board is
	// there.
	it("reads the file's current text at once while a write is parked", async () => {
		const writer = new NoteWriter(vault as unknown as Vault, openNoteFromWorkspace(splitWorkspace().plugin));
		const write = writer.edit(NOTE, () => "after", { askedFor: true });
		expect(await settled(write)).toBe(false);

		const read = writer.read(NOTE);

		expect(await settled(read)).toBe(true);
		expect(await read).toBe("before");
		expect(vault.files.get(PATH)).toBe("before");
	});
});
