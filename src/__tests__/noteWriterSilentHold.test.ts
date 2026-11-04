/**
 * `NoteWriter.edit` with `{ quietHold: true }`: a write the
 * caller wants held while its note is on screen, without the notice that says
 * it is waiting.
 *
 * The writer holds every write to the note on screen and, after thirty seconds
 * of waiting, says so. A background write the person did not ask for and cannot
 * act on (Review's diary-date write) should not nag, so its caller asks for the
 * hold without the notice. The option changes the notice and nothing else: the
 * set of writes that are held is the same, and a held write whose plugin
 * unloads is still refused loudly. The clock is faked; every path is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TFile } from "obsidian";
import { Notice } from "./__mocks__/obsidian";
import { NoteWriter } from "../core/noteWriter";
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
	editing = true;

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

const NOTE = { path: "Journal/2026-10-04.md" } as unknown as TFile;
const append = (text: string) => (current: string) => `${current}${text}`;

const WAITING_NOTICE = `Effortless: a background write to ${NOTE.path} is waiting. It will happen as soon as the note's tab is closed, sent to another note or put in the background.`;
const UNLOADED_REASON = "Effortless: this write did not happen. The plugin was unloaded while the write was waiting for you to leave the note.";

let vault: FakeVault;
let open: FakeOpenNote;
let writer: NoteWriter;

beforeEach(() => {
	vi.useFakeTimers();
	Notice.messages = [];
	vault = new FakeVault();
	vault.files.set(NOTE.path, "start;");
	open = new FakeOpenNote();
	writer = new NoteWriter(vault as unknown as ConstructorParameters<typeof NoteWriter>[0], open);
	open.looksAt(NOTE.path);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("NoteWriter.edit with quietHold", () => {
	it("holds the write for the note on screen and raises no notice, however long it waits", async () => {
		const done = writer.edit(NOTE, append("quiet;"), { quietHold: true });

		await vi.advanceTimersByTimeAsync(30 * 60_000);

		expect(Notice.messages).toEqual([]);
		expect(vault.files.get(NOTE.path)).toBe("start;");
		open.looksAt(null);
		await done;
		expect(vault.files.get(NOTE.path)).toBe("start;quiet;");
	});

	it("still holds a write the person did not ask for where no tab shows the note for editing: the hold is the same", async () => {
		open.editing = false;
		const done = writer.edit(NOTE, append("quiet;"), { quietHold: true });

		await vi.advanceTimersByTimeAsync(60_000);
		expect(vault.files.get(NOTE.path)).toBe("start;");

		open.looksAt(null);
		await done;
		expect(vault.files.get(NOTE.path)).toBe("start;quiet;");
	});

	it("holds a write that was asked for where it is shown for editing, as before, and writes it at once where it is not", async () => {
		const held = writer.edit(NOTE, append("held;"), { askedFor: true, quietHold: true });
		await vi.advanceTimersByTimeAsync(31_000);
		expect(vault.files.get(NOTE.path)).toBe("start;");
		expect(Notice.messages).toEqual([]);
		open.looksAt(null);
		await held;

		open.looksAt(NOTE.path);
		open.editing = false;
		await writer.edit(NOTE, append("now;"), { askedFor: true, quietHold: true });
		expect(vault.files.get(NOTE.path)).toBe("start;held;now;");
	});

	it("still refuses the held write, with the reason the caller reports, when the plugin unloads", async () => {
		const done = writer.edit(NOTE, append("quiet;"), { quietHold: true });
		const refused = expect(done).rejects.toThrow(UNLOADED_REASON);

		writer.teardown();

		await refused;
		expect(vault.files.get(NOTE.path)).toBe("start;");
	});
});

describe("NoteWriter.edit without quietHold", () => {
	it("raises its notice once, thirty seconds in, and writes when the person leaves", async () => {
		const done = writer.edit(NOTE, append("asked;"), { askedFor: true });

		await vi.advanceTimersByTimeAsync(29_000);
		expect(Notice.messages).toEqual([]);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(Notice.messages).toEqual([WAITING_NOTICE]);
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(Notice.messages).toHaveLength(1);

		open.looksAt(null);
		await done;
		expect(vault.files.get(NOTE.path)).toBe("start;asked;");
	});

	it("keeps its notice for a write with no options at all", async () => {
		const done = writer.edit(NOTE, append("plain;"));

		await vi.advanceTimersByTimeAsync(31_000);

		expect(Notice.messages).toEqual([WAITING_NOTICE]);
		open.looksAt(null);
		await done;
	});

	it("keeps its notice when quietHold is false", async () => {
		const done = writer.edit(NOTE, append("loud;"), { quietHold: false });

		await vi.advanceTimersByTimeAsync(31_000);

		expect(Notice.messages).toEqual([WAITING_NOTICE]);
		open.looksAt(null);
		await done;
	});
});
