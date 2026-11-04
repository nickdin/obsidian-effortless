/**
 * `NoteWriter.trashIf`: the one way a feature's note goes. Through
 * `FileManager.trashFile`, which honours the person's own trash setting, and
 * only after the note's text — read at the front of its queue, never from an
 * earlier snapshot — still passes the caller's check.
 */

import { describe, expect, it } from "vitest";
import type { FileManager, TFile, Vault } from "obsidian";
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

	async read(file: TFile): Promise<string> {
		await Promise.resolve();
		const text = this.files.get(file.path);
		if (text === undefined) throw new Error(`File not found: ${file.path}`);
		return text;
	}
}

class FakeFileManager {
	readonly trashed: string[] = [];

	constructor(private readonly vault: FakeVault) {}

	async trashFile(file: TFile): Promise<void> {
		await Promise.resolve();
		this.trashed.push(file.path);
		this.vault.files.delete(file.path);
	}
}

class FakeOpenNote implements OpenNote {
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

function setUp(): { vault: FakeVault; manager: FakeFileManager; openNote: FakeOpenNote; writer: NoteWriter } {
	const vault = new FakeVault();
	const manager = new FakeFileManager(vault);
	const openNote = new FakeOpenNote();
	const writer = new NoteWriter(vault as unknown as Vault, openNote, manager as unknown as FileManager);
	return { vault, manager, openNote, writer };
}

async function turns(count: number): Promise<void> {
	for (let i = 0; i < count; i += 1) await Promise.resolve();
}

describe("NoteWriter.trashIf", () => {
	it("trashes the note through the file manager when the check passes on its current text", async () => {
		const { vault, manager, writer } = setUp();
		vault.files.set("Meetings/a.md", "as written");
		const seen: string[] = [];

		const trashed = await writer.trashIf(file("Meetings/a.md"), (text) => {
			seen.push(text);
			return true;
		});

		expect(trashed).toBe(true);
		expect(seen).toEqual(["as written"]);
		expect(manager.trashed).toEqual(["Meetings/a.md"]);
		expect(vault.files.has("Meetings/a.md")).toBe(false);
	});

	it("keeps the note when the check fails", async () => {
		const { vault, manager, writer } = setUp();
		vault.files.set("Meetings/a.md", "as written\n- a line the person added");

		const trashed = await writer.trashIf(file("Meetings/a.md"), (text) => text === "as written");

		expect(trashed).toBe(false);
		expect(manager.trashed).toEqual([]);
		expect(vault.files.get("Meetings/a.md")).toBe("as written\n- a line the person added");
	});

	it("checks the text a write queued ahead of it left, not the text before that write", async () => {
		const { vault, manager, writer } = setUp();
		vault.files.set("Meetings/a.md", "as written");

		const edited = writer.edit(file("Meetings/a.md"), (text) => `${text}\n- typed`);
		const trashed = writer.trashIf(file("Meetings/a.md"), (text) => text === "as written");
		await edited;

		expect(await trashed).toBe(false);
		expect(manager.trashed).toEqual([]);
	});

	it("waits while the person has the note open, and checks the text they leave behind", async () => {
		const { vault, manager, openNote, writer } = setUp();
		vault.files.set("Meetings/a.md", "as written");
		openNote.looksAt("Meetings/a.md");

		let settled = false;
		const trashed = writer.trashIf(file("Meetings/a.md"), (text) => text === "as written").then((answer) => {
			settled = true;
			return answer;
		});
		await turns(20);
		expect(settled).toBe(false);
		expect(manager.trashed).toEqual([]);

		vault.files.set("Meetings/a.md", "as written\n- typed while it waited");
		openNote.looksAt(null);

		expect(await trashed).toBe(false);
		expect(manager.trashed).toEqual([]);
	});

	it("rejects, naming the gap, when the writer was built without a file manager", async () => {
		const vault = new FakeVault();
		vault.files.set("Meetings/a.md", "as written");
		const writer = new NoteWriter(vault as unknown as Vault, new FakeOpenNote());

		await expect(writer.trashIf(file("Meetings/a.md"), () => true)).rejects.toThrow(
			"NoteWriter.trashIf needs a FileManager, and none was given to this writer.",
		);
		expect(vault.files.get("Meetings/a.md")).toBe("as written");
	});
});
