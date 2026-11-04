/**
 * A write the person asked for, queued behind a quietly held write for the same
 * note (ticket #1168, found
 * against #1139).
 *
 * The note's queue runs one write at a time, so an asked-for write waits for the
 * quietly held write ahead of it even where its own note would let it through.
 * It must not wait in silence: the notice comes back, counted from the moment
 * the asked-for write joined the queue. A quiet write alone stays silent. The
 * clock is faked; every path is invented.
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

class FakeOpenNote implements OpenNote {
	private readonly listeners: Array<() => void> = [];
	private open: string | null = null;
	/** Whether a tab shows the open note for editing; `false` for reading view. */
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

describe("an asked-for write queued behind a quietly held one", () => {
	it("raises the waiting notice once, thirty seconds after it joined, in reading view where its own note would let it through", async () => {
		const quiet = writer.edit(NOTE, append("quiet;"), { quietHold: true });
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(Notice.messages).toEqual([]);

		open.editing = false;
		const asked = writer.edit(NOTE, append("asked;"), { askedFor: true });
		await vi.advanceTimersByTimeAsync(29_000);
		expect(Notice.messages).toEqual([]);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(Notice.messages).toEqual([WAITING_NOTICE]);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(Notice.messages).toEqual([WAITING_NOTICE]);

		open.looksAt(null);
		await Promise.all([quiet, asked]);
		expect(vault.files.get(NOTE.path)).toBe("start;quiet;asked;");
	});

	it("raises the notice when both are called in the same tick, before the quiet write has parked", async () => {
		const quiet = writer.edit(NOTE, append("quiet;"), { quietHold: true });
		const asked = writer.edit(NOTE, append("asked;"), { askedFor: true });

		await vi.advanceTimersByTimeAsync(31_000);
		expect(Notice.messages).toEqual([WAITING_NOTICE]);

		open.looksAt(null);
		await Promise.all([quiet, asked]);
		expect(vault.files.get(NOTE.path)).toBe("start;quiet;asked;");
	});

	it("raises one notice for two quiet writes ahead of one asked-for write, and none after the person leaves", async () => {
		const first = writer.edit(NOTE, append("a;"), { quietHold: true });
		const second = writer.edit(NOTE, append("b;"), { quietHold: true });
		const asked = writer.edit(NOTE, append("asked;"), { askedFor: true });
		await vi.advanceTimersByTimeAsync(31_000);
		expect(Notice.messages).toEqual([WAITING_NOTICE]);

		open.looksAt(null);
		await Promise.all([first, second, asked]);
		expect(vault.files.get(NOTE.path)).toBe("start;a;b;asked;");
		Notice.messages = [];
		await vi.advanceTimersByTimeAsync(60_000);
		expect(Notice.messages).toEqual([]);
	});

	it("raises no notice when the person leaves the note before thirty seconds are up", async () => {
		const quiet = writer.edit(NOTE, append("quiet;"), { quietHold: true });
		const asked = writer.edit(NOTE, append("asked;"), { askedFor: true });
		await vi.advanceTimersByTimeAsync(10_000);

		open.looksAt(null);
		await Promise.all([quiet, asked]);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(Notice.messages).toEqual([]);
	});

	it("leaves a later quiet write silent once the asked-for write has landed", async () => {
		const quiet = writer.edit(NOTE, append("quiet;"), { quietHold: true });
		const asked = writer.edit(NOTE, append("asked;"), { askedFor: true });
		open.looksAt(null);
		await Promise.all([quiet, asked]);

		open.looksAt(NOTE.path);
		const later = writer.edit(NOTE, append("later;"), { quietHold: true });
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(Notice.messages).toEqual([]);
		open.looksAt(null);
		await later;
	});

	it("leaves a quiet write silent when the asked-for write is for another note", async () => {
		const other = { path: "Journal/2026-10-05.md" } as unknown as TFile;
		vault.files.set(other.path, "");
		const quiet = writer.edit(NOTE, append("quiet;"), { quietHold: true });
		const askedElsewhere = writer.edit(other, append("asked;"), { askedFor: true });
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(Notice.messages).toEqual([]);
		open.looksAt(null);
		await Promise.all([quiet, askedElsewhere]);
	});
});
