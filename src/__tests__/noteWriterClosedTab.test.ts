/**
 * `NoteWriter.edit` with `{ askedFor: true }` over the port Obsidian gives
 * (`openNoteFromWorkspace`), for a note whose tab was closed. Obsidian's
 * `getActiveFile` goes on naming the note after its tab is gone
 * (`node_modules/obsidian/obsidian.d.ts:7991-7996`), so a write the person asked
 * for must not wait for them to leave a note that no tab shows for editing: a
 * note nobody can type in has nothing for the hold to protect.
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

/**
 * A workspace whose tabs are `tabs` (each a mode, and the note it shows) and
 * whose active file is `active` — which, as in Obsidian, may name a note no tab
 * shows. `leave` makes another note the active one and fires `file-open`.
 */
function workspaceOver(active: string | null, ...tabs: Array<["source" | "preview", string?]>) {
	let activeFile = active;
	const listeners: Array<() => void> = [];
	const leaves = tabs.map(([mode, path]) => new WorkspaceLeaf(new MarkdownView({ path: path ?? PATH } as never, "", mode)));
	const workspace = {
		getActiveFile: () => (activeFile === null ? null : { path: activeFile }),
		getLeavesOfType: (type: string) => leaves.filter((leaf) => leaf.view.getViewType() === type),
		iterateAllLeaves: (callback: (leaf: WorkspaceLeaf) => void) => leaves.forEach(callback),
		on: (_name: string, listener: () => void) => {
			listeners.push(listener);
			return null;
		},
	};
	const plugin = { app: { workspace }, registerEvent: () => undefined } as unknown as Plugin;
	return {
		plugin,
		leave: (to: string | null) => {
			activeFile = to;
			for (const listener of listeners) listener();
		},
	};
}

describe("NoteWriter.edit, for an asked-for write to a note whose tab was closed", () => {
	let vault: FakeVault;

	beforeEach(() => {
		vault = new FakeVault();
		vault.files.set(PATH, "before");
	});

	function writerOver(workspace: ReturnType<typeof workspaceOver>): NoteWriter {
		return new NoteWriter(vault as unknown as Vault, openNoteFromWorkspace(workspace.plugin));
	}

	// If wrong (the hold as it was): the note is still the active file, no tab
	// shows it, and the write stays parked — `settled` is false and the file
	// still reads "before".
	it("writes at once to the active file that no tab shows, with nothing parked", async () => {
		const workspace = workspaceOver(PATH);
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);

		expect(await settled(write)).toBe(true);
		expect(vault.files.get(PATH)).toBe("before + date");
	});

	// If wrong (any source-mode tab holds, whichever note it shows): this one is
	// parked behind a tab that shows another note.
	it("writes at once when the only tab in source mode shows another note", async () => {
		const workspace = workspaceOver(PATH, ["source", OTHER]);
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);

		expect(await settled(write)).toBe(true);
		expect(vault.files.get(PATH)).toBe("before + date");
	});

	// If wrong (the hold dropped for the active file altogether): the write
	// lands at once under the cursor and the file reads "before + date".
	it("still holds a note shown in source mode until the person leaves it", async () => {
		const workspace = workspaceOver(PATH, ["source"]);
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);

		expect(await settled(write)).toBe(false);
		expect(vault.files.get(PATH)).toBe("before");
		workspace.leave(OTHER);
		expect(await write).toBe("before + date");
	});

	// If wrong (one tab in reading view lets the write through): the person is
	// typing in the other tab and the file already reads "before + date".
	it("still holds a note one tab shows in reading view and another in source mode", async () => {
		const workspace = workspaceOver(PATH, ["preview"], ["source"]);
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);

		expect(await settled(write)).toBe(false);
		expect(vault.files.get(PATH)).toBe("before");
		workspace.leave(null);
		await write;
	});

	it("writes at once to a note shown in reading view, as before", async () => {
		const workspace = workspaceOver(PATH, ["preview"]);
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);

		expect(await settled(write)).toBe(true);
		expect(vault.files.get(PATH)).toBe("before + date");
	});

	// If wrong (the exemption reaches every write): a background write to the
	// closed-tab note lands at once and the file reads "after".
	it("still holds a write nobody asked for, whatever the tabs show", async () => {
		const workspace = workspaceOver(PATH);
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, () => "after");

		expect(await settled(write)).toBe(false);
		expect(vault.files.get(PATH)).toBe("before");
		workspace.leave(OTHER);
		await write;
	});

	// If wrong: a `\r\n` becomes `\n`, a final line break is added or lost, or the
	// field is still blank. This route has no undo of its own — the editor route's
	// undo is one editor transaction (`src/features/review/editorRoute.ts`), which a
	// note with no tab never reaches — so the bytes of the write are the whole check.
	it.each([
		["no final line break", "---\r\nprocessed:\r\ntitle: Pier note\r\n---\r\n- [ ] one task\r\n- [ ] second task"],
		["a final line break", "---\r\nprocessed:\r\ntitle: Quay note\r\n---\r\n- [ ] one task\r\n"],
	])("writes the date into a Windows-endings note with %s, changing only that line", async (_name, original) => {
		vault.files.set(PATH, original);
		const workspace = workspaceOver(PATH);
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => markProcessedText(text, "processed", "2026-10-13"), ASKED);

		expect(await settled(write)).toBe(true);
		expect(vault.files.get(PATH)).toBe(original.replace("processed:\r\n", "processed: 2026-10-13\r\n"));
	});
});
