/**
 * `NoteWriter.edit` with `{ askedFor: true }` over the port Obsidian gives
 * (`openNoteFromWorkspace`), for a note a view of another type shows.
 *
 * Kanban and Excalidraw open a `.md` file in a view of their own. A
 * `TextFileView` (`node_modules/obsidian/obsidian.d.ts:7046`) keeps the file's
 * text in memory (`data`, `:7053`) and saves it later (`requestSave`, `:7059`), so
 * a write that reaches the file while that view shows it is lost, or loses the
 * person's edit. Such a view is a `FileView` (`:3130`) whose `file` (`:3138`)
 * names the note, and `Workspace.iterateAllLeaves` (`:8009`) finds it where
 * `getLeavesOfType("markdown")` cannot.
 *
 * Not every view that names the note edits it: Obsidian's Outline, Backlinks and
 * Outgoing-links panes answer `file` too and keep no text of their own, so only a
 * view with a `requestSave` function holds the write.
 *
 * The stand-ins below are bare objects with a `file` (and `requestSave`, or not):
 * the code reads nothing else of a view of another type, and none is named here.
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
 * A view of a type other than `markdown` that shows `path` and edits it, the way
 * a Kanban board shows its `.md` file: it carries `requestSave`
 * (`node_modules/obsidian/obsidian.d.ts:7059`), as every `TextFileView` does.
 */
function otherView(type: string, path: string | null) {
	return { getViewType: () => type, file: path === null ? null : { path }, requestSave: () => undefined };
}

/**
 * A view that names the note in `file` and edits nothing, the way Obsidian's
 * Outline and Backlinks panes do: read back in the test Obsidian, they answer
 * `file` and have no `data` and no `requestSave`
 * (`docs/acceptance-shots/issue-1117-other-view-drive.txt`, step 3).
 */
function sidePane(type: string, path: string) {
	return { getViewType: () => type, file: { path } };
}

type Tab = ["source" | "preview", string?] | ["other", string | null, string?] | ["pane", string, string?];

/**
 * A workspace whose tabs are `tabs`: a markdown tab (a mode, and the note it
 * shows) or a view of another type (`"other"`, the note it shows, its type).
 * Both leaf finders answer from the same list, as Obsidian's do. The active file
 * is `active`; `leave` makes another note the active one, takes any view of
 * another type that showed the note left to the new one, and fires `file-open`.
 */
function workspaceOver(active: string | null, ...tabs: Tab[]) {
	let activeFile = active;
	const listeners: Array<() => void> = [];
	const leaves: WorkspaceLeaf[] = tabs.map((tab) => {
		if (tab[0] === "other") return new WorkspaceLeaf(otherView(tab[2] ?? "kanban-board", tab[1]) as never);
		if (tab[0] === "pane") return new WorkspaceLeaf(sidePane(tab[2] ?? "outline", tab[1]) as never);
		// A markdown tab is a `TextFileView` too (`obsidian.d.ts:4188`), so it has
		// `requestSave` as the real one does; the mock lacks it, and without it a
		// check that counted markdown tabs by `requestSave` alone would go unseen.
		const markdown = new MarkdownView({ path: tab[1] ?? PATH } as never, "", tab[0]);
		return new WorkspaceLeaf(Object.assign(markdown, { requestSave: () => undefined }));
	});
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
		leaves,
		leave: (to: string | null) => {
			// Leaving a note is the tab that showed it going to the next one, as in
			// Obsidian: a board's leaf follows the person, so it no longer shows the
			// note they left. A leaf left on the old note would still be a view the
			// write must wait for.
			for (const leaf of leaves) {
				const view = leaf.view as unknown as { getViewType(): string; file?: { path: string } | null };
				if (view.getViewType() !== "markdown" && view.file?.path === activeFile) {
					view.file = to === null ? null : { path: to };
				}
			}
			activeFile = to;
			for (const listener of listeners) listener();
		},
	};
}

describe("NoteWriter.edit, for an asked-for write to a note a view of another type shows", () => {
	let vault: FakeVault;

	beforeEach(() => {
		vault = new FakeVault();
		vault.files.set(PATH, "before");
	});

	function writerOver(workspace: ReturnType<typeof workspaceOver>): NoteWriter {
		return new NoteWriter(vault as unknown as Vault, openNoteFromWorkspace(workspace.plugin));
	}

	// If wrong (only `markdown` leaves are asked, as before #1117): the board
	// shows the note, nothing is parked, and the file already reads "before + date".
	it("holds the write until the person leaves a note a Kanban-type view shows", async () => {
		const workspace = workspaceOver(PATH, ["other", PATH]);
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);

		expect(await settled(write)).toBe(false);
		expect(vault.files.get(PATH)).toBe("before");
		workspace.leave(OTHER);
		expect(await write).toBe("before + date");
		expect(vault.files.get(PATH)).toBe("before + date");
	});

	// If wrong (the view's type is named, so only `kanban-board` holds): this one
	// is another type and the file already reads "before + date".
	it("holds the same for a view of any other type, a drawing's included", async () => {
		const workspace = workspaceOver(PATH, ["other", PATH, "excalidraw"]);
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);

		expect(await settled(write)).toBe(false);
		expect(vault.files.get(PATH)).toBe("before");
		workspace.leave(OTHER);
		await write;
	});

	// If wrong (every view of another type holds, whatever file it shows): this
	// one is parked behind a board that shows another note.
	it("writes at once when the only view of another type shows another note", async () => {
		const workspace = workspaceOver(PATH, ["other", OTHER]);
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);

		expect(await settled(write)).toBe(true);
		expect(vault.files.get(PATH)).toBe("before + date");
	});

	// If wrong (a view with no file holds, or reading `file` throws): this one is
	// parked, or the write rejects.
	it("writes at once when the only view of another type shows no file", async () => {
		const workspace = workspaceOver(PATH, ["other", null]);
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);

		expect(await settled(write)).toBe(true);
		expect(vault.files.get(PATH)).toBe("before + date");
	});

	// If wrong (a markdown tab in reading view holds once the all-leaves walk
	// finds it): the note is parked behind a tab nothing can be typed in. Passes on
	// the code before #1117 too.
	it("still writes at once to a note shown only in reading view", async () => {
		const workspace = workspaceOver(PATH, ["preview"]);
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);

		expect(await settled(write)).toBe(true);
		expect(vault.files.get(PATH)).toBe("before + date");
	});

	// If wrong (the active file alone holds, as before #1089): the note is the
	// active file, no tab of any type shows it, and the write stays parked.
	// Passes on the code before #1117 too.
	it("still writes at once to the active file that no tab of any type shows", async () => {
		const workspace = workspaceOver(PATH);
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);

		expect(await settled(write)).toBe(true);
		expect(vault.files.get(PATH)).toBe("before + date");
	});

	// If wrong (any view whose `file` is the note holds, as the first #1117 fix
	// did): the Outline pane beside the reading-view tab parks the write and the
	// file still reads "before".
	it("writes at once to a note in reading view with an Outline pane beside it", async () => {
		const workspace = workspaceOver(PATH, ["preview"], ["pane", PATH, "outline"]);
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);

		expect(await settled(write)).toBe(true);
		expect(vault.files.get(PATH)).toBe("before + date");
	});

	// If wrong (same): a Backlinks pane and an Outgoing-links pane together, with
	// no tab of any other kind showing the note.
	it("writes at once to the active file that only side panes show", async () => {
		const workspace = workspaceOver(PATH, ["pane", PATH, "backlink"], ["pane", PATH, "outgoing-link"]);
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);

		expect(await settled(write)).toBe(true);
		expect(vault.files.get(PATH)).toBe("before + date");
	});

	// If wrong (the panes' presence is read as "nothing holds"): the board still
	// shows the note, and the write must wait for it whichever panes are beside it.
	it("holds a note a board shows with an Outline pane beside it", async () => {
		const workspace = workspaceOver(PATH, ["other", PATH], ["pane", PATH, "outline"]);
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);

		expect(await settled(write)).toBe(false);
		expect(vault.files.get(PATH)).toBe("before");
		workspace.leave(OTHER);
		await write;
	});

	// If wrong (the markdown tabs are no longer asked once another type is): the
	// source-mode tab stops holding. Passes on the code before #1117 too.
	it("still holds a note shown in source mode, with a view of another type on another note beside it", async () => {
		const workspace = workspaceOver(PATH, ["source"], ["other", OTHER]);
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);

		expect(await settled(write)).toBe(false);
		expect(vault.files.get(PATH)).toBe("before");
		workspace.leave(null);
		await write;
	});

	// If wrong (the markdown tab in reading view cancels the board's hold, or is
	// counted as "another type"): nothing holds and the file already reads
	// "before + date".
	it("holds a note one tab shows in reading view and a board shows too", async () => {
		const workspace = workspaceOver(PATH, ["preview"], ["other", PATH]);
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);

		expect(await settled(write)).toBe(false);
		expect(vault.files.get(PATH)).toBe("before");
		workspace.leave(null);
		await write;
	});

	// If wrong (the leaves are kept from the first question): the first press
	// found the board showing the note and parked; the board was then closed, and
	// the second press is still parked on the kept answer, so the file reads
	// "before + date" and never "before + date + again".
	it("reads the leaves when asked, not as they were: a board closed since lets the write through", async () => {
		const workspace = workspaceOver(PATH, ["other", PATH]);
		const writer = writerOver(workspace);

		const first = writer.edit(NOTE, (text) => `${text} + date`, ASKED);
		expect(await settled(first)).toBe(false);
		workspace.leave(OTHER);
		await first;
		workspace.leaves.length = 0;
		// Back on the note, now with no board: a write is held only for the note on screen.
		workspace.leave(PATH);

		const second = writer.edit(NOTE, (text) => `${text} + again`, ASKED);

		expect(await settled(second)).toBe(true);
		expect(vault.files.get(PATH)).toBe("before + date + again");
	});

	// If wrong (the exemption reaches every write): a background write lands at
	// once under a board that shows the note.
	it("still holds a write nobody asked for", async () => {
		const workspace = workspaceOver(PATH, ["other", PATH]);
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, () => "after");

		expect(await settled(write)).toBe(false);
		workspace.leave(OTHER);
		await write;
	});

	// If wrong: a `\r\n` becomes `\n`, a final line break is added or lost, the
	// field is written while the board still shows the note, or it is never
	// written after the person leaves. This route has no undo of its own: the
	// editor route's undo is one editor transaction (`src/features/review/
	// editorRoute.ts`), which a view of another type, having no editor, never
	// reaches — so the bytes of the held write are the whole check.
	it.each([
		["no final line break", "---\r\nprocessed:\r\ntitle: Pier note\r\n---\r\n- [ ] one task\r\n- [ ] second task"],
		["a final line break", "---\r\nprocessed:\r\ntitle: Quay note\r\n---\r\n- [ ] one task\r\n"],
	])("holds, then writes the date into a Windows-endings note with %s, changing only that line", async (_name, original) => {
		vault.files.set(PATH, original);
		const workspace = workspaceOver(PATH, ["other", PATH]);
		const writer = writerOver(workspace);

		const write = writer.edit(NOTE, (text) => markProcessedText(text, "processed", "2026-10-13"), ASKED);

		expect(await settled(write)).toBe(false);
		expect(vault.files.get(PATH)).toBe(original);
		workspace.leave(OTHER);
		await write;
		expect(vault.files.get(PATH)).toBe(original.replace("processed:\r\n", "processed: 2026-10-13\r\n"));
	});
});
