/**
 * The notices an undo ends with when a write fails after another was made, and the
 * task is left in more than one place. Each notice says what the person will find:
 * which of the three notes (the note the task came from, the collection, today's
 * log) holds the task, and in what form. Every case fails a write of the undo and
 * one put-back, so which put-back failed is what the notice must tell apart.
 *
 * Every folder, name and task is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notice } from "./__mocks__/obsidian";
import type { Plugin } from "./__mocks__/obsidian";
import { NoteWriter } from "../core/noteWriter";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { fileInto } from "../features/migration/fileInto";
import { ORDINARY_NOTE } from "../features/migration/filable";
import { copyIn } from "../features/taskConsistency/copyIn";
import { undoFilings } from "../features/migration/undo";
import type { UndoWorld } from "../features/migration/undo";
import { LOG_PATH, SHED, installMigrationHooks, read, startMigration } from "./migrationHarness";

installMigrationHooks();

const SHED_PATH = "Projects/Garden shed.md";
const MEETING_PATH = "Meetings/Lantern committee.md";
const TODAY = new Date(2031, 3, 5);
const TODAY_KEY = "2031-04-05";
const ID = "abc123";
const MEETING = ["# Lantern committee", "", "Present: [[Ada Fenwick]]", "", `- [ ] Varnish the spare oars 📅 ${TODAY_KEY}`, ""].join("\n");
const TODAYS_LOG = ["# Notes", "", "- [ ] Mend the gate", "", "## Overdue", "", "## Today", ""].join("\n");
const layout: VaultLayout = { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };

beforeEach(() => {
	Notice.messages.length = 0;
	// Only the date is faked: Task consistency reads the clock for "today", and so does undo.
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(TODAY);
});

afterEach(() => {
	vi.useRealTimers();
});

/**
 * A task filed from the meeting note, Task consistency's live copy in today's log, and the
 * undo run with the writes in `failing` rejected. `failing` names a path and which of its
 * writes (counted from 1) rejects.
 */
async function undoWithFailing(failing: readonly { path: string; call: number }[]): Promise<{ said: string; plugin: Plugin; texts: { source: string; collection: string; log: string } }> {
	const filed = fileInto({ logText: MEETING, lineIndex: 4, collectionText: "## Tasks\n\n- [ ] a\n", collectionLink: "[[Garden shed]]", logLink: `[[${TODAY_KEY}]]`, id: ID, layout });
	if (!filed.ok) throw new Error(filed.reason);
	const copied = copyIn(filed.collection, TODAYS_LOG, TODAY, layout, "Garden shed");
	expect(copied.log, "Task consistency copied nothing into today's log, so the test cannot fail").toContain("task-consistency:");
	const texts = { source: filed.log, collection: copied.collection, log: copied.log };

	const { plugin } = await startMigration({ log: texts.log, extraNotes: { [MEETING_PATH]: texts.source } });
	const vault = plugin.app.vault.readableContents();
	vault?.set(MEETING_PATH, texts.source);
	vault?.set(SHED_PATH, texts.collection);
	vault?.set(LOG_PATH, texts.log);

	const process = plugin.app.vault.process.bind(plugin.app.vault);
	const calls = new Map<string, number>();
	vi.spyOn(plugin.app.vault, "process").mockImplementation((file, edit) => {
		const call = (calls.get(file.path) ?? 0) + 1;
		calls.set(file.path, call);
		if (failing.some((each) => each.path === file.path && each.call === call)) return Promise.reject(new Error("disk full"));
		return process(file, edit);
	});

	const world: UndoWorld = {
		app: plugin.app as never,
		notes: new NoteWriter(plugin.app.vault as never, { path: () => null, onChange: () => undefined }),
		collections: { all: () => [SHED] },
	};
	const said = await undoFilings(world, MEETING_PATH, [ID], SHED_PATH, null, ORDINARY_NOTE, { layout });
	return { said, plugin, texts };
}

describe("an undo that leaves the task in more than one place says which", () => {
	// If wrong: the notice names one extra copy, or none, while the collection and today's log both still hold the task.
	it("names the collection and the live copy when today's log could not be written and the note could not be put back", async () => {
		const { said, plugin, texts } = await undoWithFailing([
			{ path: LOG_PATH, call: 1 },
			{ path: MEETING_PATH, call: 2 },
		]);

		expect(said).toContain("back in the note");
		expect(said).toContain("still in Garden shed");
		expect(said).toContain("live copy in today's log");
		expect(said).toContain("three times");
		expect(await read(plugin, SHED_PATH)).toBe(texts.collection);
		expect(await read(plugin, LOG_PATH)).toBe(texts.log);
	});

	// If wrong: the notice says the task is back in the note, but its line there is frozen again and only the live copy is missing.
	it("says the note's line is frozen again and only the live copy is missing when today's log could not be put back", async () => {
		const { said, plugin, texts } = await undoWithFailing([
			{ path: SHED_PATH, call: 1 },
			{ path: LOG_PATH, call: 2 },
		]);

		expect(said).toContain("still in Garden shed");
		expect(said).toContain("frozen again");
		expect(said).toContain("live copy in today's log was taken out and could not be put back");
		expect(said).not.toContain("back in the note");
		expect(await read(plugin, MEETING_PATH)).toBe(texts.source);
		expect(await read(plugin, LOG_PATH)).not.toBe(texts.log);
	});

	// If wrong: the notice says only the collection's copy was left, or that the note is frozen, while both are true at once.
	it("names both the collection's copy and the missing live copy when neither the note nor today's log could be put back", async () => {
		const { said } = await undoWithFailing([
			{ path: SHED_PATH, call: 1 },
			{ path: MEETING_PATH, call: 2 },
			{ path: LOG_PATH, call: 2 },
		]);

		expect(said).toContain("back in the note");
		expect(said).toContain("its copy in Garden shed was left there");
		expect(said).toContain("live copy in today's log was taken out and could not be put back");
	});

	// If wrong: the notice mentions a live copy that was never taken out, or drops the collection's copy.
	it("keeps the plain notice when only the note could not be put back and today's log was put back", async () => {
		const { said } = await undoWithFailing([
			{ path: SHED_PATH, call: 1 },
			{ path: MEETING_PATH, call: 2 },
		]);

		expect(said).toContain("back in the note");
		expect(said).toContain("its copy in Garden shed was left there");
		expect(said).toContain("Delete it by hand");
		expect(said).not.toContain("live copy");
	});
});
