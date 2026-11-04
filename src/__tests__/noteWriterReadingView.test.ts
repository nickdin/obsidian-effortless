/**
 * `NoteWriter.edit` with `{ askedFor: true }`: a write the person asked for, held only where
 * the person could be typing. A note in reading view cannot be typed in, so the
 * write goes to disk at once there; a note shown for editing, or one the port
 * cannot place, is held until the person leaves it, as {@link NoteWriter.edit}
 * holds every write to the note on screen.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Plugin, TFile, Vault } from "obsidian";
import { MarkdownView, WorkspaceLeaf } from "./__mocks__/obsidian";
import { NoteWriter, openNoteFromWorkspace } from "../core/noteWriter";
import type { OpenNote } from "../core/noteWriter";

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

/** The note on screen and, separately, how the tabs show it. */
class FakeOpenNote implements OpenNote {
	private readonly listeners: Array<() => void> = [];
	private open: string | null = null;
	/** Whether a tab shows the open note for editing; `false` for reading view and for no tab at all. */
	editing = false;

	path(): string | null {
		return this.open;
	}

	onChange(listener: () => void): void {
		this.listeners.push(listener);
	}

	shownForEditing(): boolean {
		return this.editing;
	}

	looksAt(path: string | null): void {
		this.open = path;
		for (const listener of this.listeners) listener();
	}
}

/** A port from before the reading-view question existed: it has no such member. */
class OldOpenNote implements OpenNote {
	private readonly listeners: Array<() => void> = [];
	private open: string | null = null;

	path(): string | null {
		return this.open;
	}

	onChange(listener: () => void): void {
		this.listeners.push(listener);
	}

	looksAt(path: string | null): void {
		this.open = path;
		for (const listener of this.listeners) listener();
	}
}

const file = (path: string): TFile => ({ path }) as unknown as TFile;
const NOTE = file("Journal/2026-10-04.md");
/** The option a press passes: the person asked for this write. */
const ASKED = { askedFor: true } as const;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

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

describe("NoteWriter.edit, for a write the person asked for", () => {
	let vault: FakeVault;
	let writer: NoteWriter;
	let openNote: FakeOpenNote;

	beforeEach(() => {
		vault = new FakeVault();
		vault.files.set(NOTE.path, "before");
		openNote = new FakeOpenNote();
		writer = new NoteWriter(vault as unknown as Vault, openNote);
	});

	it("writes at once in reading view when nothing else is queued, with the note still open", async () => {
		openNote.editing = false;
		openNote.looksAt(NOTE.path);

		const result = await writer.edit(NOTE, (text) => `${text} + date`, ASKED);

		expect(result).toBe("before + date");
		expect(vault.files.get(NOTE.path)).toBe("before + date");
		expect(openNote.path()).toBe(NOTE.path);
	});

	it("holds the write until the person leaves a note shown for editing, so typing is never overwritten", async () => {
		openNote.editing = true;
		openNote.looksAt(NOTE.path);

		const write = writer.edit(NOTE, (text) => `${text} + date`, ASKED);

		expect(await settled(write)).toBe(false);
		expect(vault.files.get(NOTE.path)).toBe("before");

		openNote.looksAt(null);
		expect(await write).toBe("before + date");
		expect(vault.files.get(NOTE.path)).toBe("before + date");
	});

	it("writes at once to a note that is still the open one but that no tab shows, since nothing can be typed in it", async () => {
		openNote.editing = false;
		openNote.looksAt(NOTE.path);

		const result = await writer.edit(NOTE, (text) => `${text} + date`, ASKED);

		expect(result).toBe("before + date");
		expect(vault.files.get(NOTE.path)).toBe("before + date");
		expect(openNote.path()).toBe(NOTE.path);
	});

	it("holds the write when the port cannot say how the note is shown", async () => {
		const old = new OldOpenNote();
		const oldWriter = new NoteWriter(vault as unknown as Vault, old);
		old.looksAt(NOTE.path);

		const write = oldWriter.edit(NOTE, () => "after", ASKED);

		expect(await settled(write)).toBe(false);
		expect(vault.files.get(NOTE.path)).toBe("before");
		old.looksAt(null);
		await write;
		expect(vault.files.get(NOTE.path)).toBe("after");
	});

	it("writes at once to a note that is not the one on screen, whatever the port says of the open note", async () => {
		openNote.editing = true;
		openNote.looksAt("Journal/2026-10-05.md");

		await writer.edit(NOTE, () => "after", ASKED);

		expect(vault.files.get(NOTE.path)).toBe("after");
	});

	it("leaves edit holding a note in reading view, as every other feature's write is held", async () => {
		openNote.editing = false;
		openNote.looksAt(NOTE.path);

		const write = writer.edit(NOTE, () => "after");

		expect(await settled(write)).toBe(false);
		expect(vault.files.get(NOTE.path)).toBe("before");
		openNote.looksAt(null);
		await write;
	});
});

describe("openNoteFromWorkspace's inReadingView", () => {
	const PATH = "Journal/2026-10-04.md";

	/** The port over a workspace whose tabs are `modes`, each showing `PATH` unless it says another note. */
	function portOver(...tabs: Array<["source" | "preview", string?]>): OpenNote {
		const leaves = tabs.map(([mode, path]) => new WorkspaceLeaf(new MarkdownView({ path: path ?? PATH } as never, "", mode)));
		const plugin = {
			app: { workspace: { getActiveFile: () => null, getLeavesOfType: (type: string) => leaves.filter((l) => l.view.getViewType() === type) } },
			registerEvent: () => undefined,
		} as unknown as Plugin;
		// The workspace stand-in has no `on`; the port only registers one event.
		(plugin.app.workspace as unknown as { on: () => null }).on = () => null;
		return openNoteFromWorkspace(plugin);
	}

	it("is true when the one tab showing the note is in reading view", () => {
		expect(portOver(["preview"]).inReadingView?.(PATH)).toBe(true);
	});

	it("is false when the one tab showing the note is in source mode", () => {
		expect(portOver(["source"]).inReadingView?.(PATH)).toBe(false);
	});

	it("is false when one tab shows the note in reading view and another for editing", () => {
		expect(portOver(["preview"], ["source"]).inReadingView?.(PATH)).toBe(false);
	});

	it("is true when two tabs both show the note in reading view", () => {
		expect(portOver(["preview"], ["preview"]).inReadingView?.(PATH)).toBe(true);
	});

	it("is false when no tab shows the note, and ignores a tab showing another note in reading view", () => {
		expect(portOver().inReadingView?.(PATH)).toBe(false);
		expect(portOver(["preview", "Journal/2026-10-05.md"]).inReadingView?.(PATH)).toBe(false);
	});
});
