/**
 * Three defects the reviews of wave 1 found in the undo code #986 and #994 added.
 *
 * 1. **A filing's record of the lines it added is applied only while it is still
 *    what that filing left.** A second filing lands directly under the first, so
 *    undoing the first must not take out the heading or blank line the second now
 *    sits under. Every case compares a whole collection with the one text that is
 *    right: the two filings' collection with the first task's line removed and
 *    nothing else.
 * 2. **Today's log is resolved before the undo writes anything.** A daily-log
 *    filename that is blank throws; the throw must come before the note is written.
 * 3. **Putting today's log back checks it still reads as the undo left it** when
 *    the undo only removed the live copy's lines.
 *
 * Every folder, name and task is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView, Notice, WorkspaceLeaf } from "./__mocks__/obsidian";
import type { Plugin } from "./__mocks__/obsidian";
import { NoteWriter } from "../core/noteWriter";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { fileInto } from "../features/migration/fileInto";
import { ORDINARY_NOTE } from "../features/migration/filable";
import { copyIn } from "../features/taskConsistency/copyIn";
import { readFiled, readFrozen, removeFromCollection, undoFilings } from "../features/migration/undo";
import type { UndoWorld } from "../features/migration/undo";
import { FakeEditor, LOG_PATH, SHED, installMigrationHooks, read, startMigration } from "./migrationHarness";

installMigrationHooks();

const SHED_PATH = "Projects/Garden shed.md";
const LOG_LINK = "[[2031-04-05]]";
const FIRST = "abc123";
const SECOND = "def456";

function layout(): VaultLayout {
	return { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
}

const DONE_LOG = ["# Notes", "", "- [x] Order more tea", "- [x] Mend the gate", "", "## Today", ""].join("\n");
const OPEN_LOG = ["# Notes", "", "- [ ] Order more tea", "- [ ] Mend the gate", "", "## Today", ""].join("\n");

/** Files line 2, then line 3, of `logText` into `collection`, each under its own id; answers the collection after each. */
function fileTwice(collection: string, logText: string): { afterFirst: string; afterSecond: string; log: string } {
	const first = fileInto({ logText, lineIndex: 2, collectionText: collection, collectionLink: "[[Garden shed]]", logLink: LOG_LINK, id: FIRST, layout: layout() });
	if (!first.ok) throw new Error(first.reason);
	const second = fileInto({ logText: first.log, lineIndex: 3, collectionText: first.collection, collectionLink: "[[Garden shed]]", logLink: LOG_LINK, id: SECOND, layout: layout() });
	if (!second.ok) throw new Error(second.reason);
	return { afterFirst: first.collection, afterSecond: second.collection, log: second.log };
}

/** `text` with every line carrying `id` removed: the first filing's task taken out and nothing else. */
const withoutTask = (text: string, id: string): string =>
	text
		.split("\n")
		.filter((each) => !each.includes(id))
		.join("\n");

/** Undoes the filing `id` in `collection` the way the note writer's route does, over the text alone. */
function undoIn(collection: string, id: string, log: string): string {
	const frozen = readFrozen(log, id);
	if (frozen === null) throw new Error("the frozen line was not found again");
	const filed = readFiled(collection, id, frozen.hash, frozen.indent);
	if (!filed.ok) throw new Error(`the filing was not found again: ${filed.why}`);
	return removeFromCollection(collection, filed);
}

describe("#998 and #1001: undo applies a filing's record of added lines only while it is still what that filing left", () => {
	// If wrong: the completed heading, or the blank line above the task, is taken out although the second
	// task still sits under it, and the second task ends up under the tasks heading.
	it.each([
		["a done task, no final line break after a task", "## Tasks\n\n- [ ] a", DONE_LOG],
		["a done task, an empty tasks section at the end of the note", "## Tasks", DONE_LOG],
		["a done task, a final line break after a task", "## Tasks\n\n- [ ] a\n", DONE_LOG],
		["a done task, a heading after the tasks section", "## Tasks\n\n- [ ] a\n\n## Notes\n", DONE_LOG],
		["an open task, an empty tasks section at the end of the note", "## Tasks", OPEN_LOG],
		["an open task, an empty tasks section and a heading after it", "## Tasks\n## Notes\n", OPEN_LOG],
	])("undoing the first of two filings, %s, leaves the second under the heading it was filed under", (_case, before, logText) => {
		const { afterSecond, log } = fileTwice(before, logText);
		expect(afterSecond, "the two filings wrote nothing, so the test cannot fail").not.toBe(before);
		expect(afterSecond).toContain("Mend the gate");

		expect(undoIn(afterSecond, FIRST, log)).toBe(withoutTask(afterSecond, FIRST));
	});

	// If wrong: the person's own blank lines on both sides of the moved line are taken out with it, which the
	// recorded `b/b` does from the shape of the neighbours alone.
	it("leaves the blank lines a person has on both sides of a filed line they moved into their own text", () => {
		const filed = fileInto({ logText: OPEN_LOG, lineIndex: 2, collectionText: "## Tasks\n## Notes\n", collectionLink: "[[Garden shed]]", logLink: LOG_LINK, id: FIRST, layout: layout() });
		if (!filed.ok) throw new Error(filed.reason);
		const filedLine = filed.collection.split("\n").find((each) => each.includes(FIRST)) ?? "";
		const moved = ["## Tasks", "## Notes", "First thing to remember", "", filedLine, "", "Second thing to remember", ""].join("\n");
		expect(filed.collection, "filing recorded no added lines, so the test cannot fail").toContain(" b/b@");

		expect(undoIn(moved, FIRST, filed.log)).toBe(["## Tasks", "## Notes", "First thing to remember", "", "", "Second thing to remember", ""].join("\n"));
	});

	// The same two filings, undone through the real undo on the note writer's route and through the collection's own tab.
	it.each([
		["by the note writer", false],
		["through the collection's own tab", true],
	])("undoing the first of two filings through undoFilings keeps the second task under its heading, %s", async (_, inTab) => {
		const { afterSecond, log } = fileTwice("## Tasks\n\n- [ ] a", DONE_LOG);
		const { plugin } = await startMigration({ log });
		const vault = plugin.app.vault.readableContents();
		vault?.set(LOG_PATH, log);
		vault?.set(SHED_PATH, afterSecond);
		const tab = new FakeEditor(afterSecond, 0);
		if (inTab) {
			const view = new MarkdownView({ path: SHED_PATH }, afterSecond);
			view.editor = tab as never;
			plugin.app.workspace.leaves.push(new WorkspaceLeaf(view));
		}
		const world: UndoWorld = {
			app: plugin.app as never,
			notes: new NoteWriter(plugin.app.vault as never, { path: () => null, onChange: () => undefined }),
			collections: { all: () => [SHED] },
		};

		const said = await Promise.race([undoFilings(world, LOG_PATH, [FIRST], SHED_PATH, null), new Promise<string>((settle) => setTimeout(() => settle("parked"), 200))]);

		expect(said).toBe("Undone. The task is back in the day's log and no longer in Garden shed.");
		expect(inTab ? tab.getValue() : await read(plugin, SHED_PATH)).toBe(withoutTask(afterSecond, FIRST));
	});
});

const MEETING_PATH = "Meetings/Lantern committee.md";
const TODAY = new Date(2031, 3, 5);
const TODAY_KEY = "2031-04-05";
const MEETING = ["# Lantern committee", "", "Present: [[Ada Fenwick]]", "", `- [ ] Varnish the spare oars 📅 ${TODAY_KEY}`, ""].join("\n");
const todaysLogWith = (...lines: string[]): string => ["# Notes", "", ...lines, "", "## Overdue", "", "## Today", ""].join("\n");

beforeEach(() => {
	Notice.messages.length = 0;
	// Only the date is faked: Task consistency reads the clock for "today", and so does undo.
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(TODAY);
});

afterEach(() => {
	vi.useRealTimers();
});

/** The texts after the task in `MEETING` is filed into Garden shed, and after Task consistency copied it into today's log, `before`. */
function filedFromMeeting(before: string): { source: string; collection: string; log: string } {
	const filed = fileInto({ logText: MEETING, lineIndex: 4, collectionText: "## Tasks\n\n- [ ] a\n", collectionLink: "[[Garden shed]]", logLink: LOG_LINK, id: FIRST, layout: layout() });
	if (!filed.ok) throw new Error(filed.reason);
	const copied = copyIn(filed.collection, before, TODAY, layout(), "Garden shed");
	expect(copied.log, "Task consistency copied nothing into today's log, so the test cannot fail").toContain("task-consistency:");
	return { source: filed.log, collection: copied.collection, log: copied.log };
}

function worldWith(plugin: Plugin): UndoWorld {
	return {
		app: plugin.app as never,
		notes: new NoteWriter(plugin.app.vault as never, { path: () => null, onChange: () => undefined }),
		collections: { all: () => [SHED] },
	};
}

describe("#999 and #1002: today's log is resolved before the undo writes anything", () => {
	// If wrong: the meeting note has its line back and the collection keeps its copy, so the task is in two notes.
	it("leaves the meeting note, the collection and today's log as filing left them when the daily-log filename is blank", async () => {
		const filed = filedFromMeeting(todaysLogWith("- [ ] Mend the gate"));
		const { plugin } = await startMigration({ log: filed.log, extraNotes: { [MEETING_PATH]: filed.source } });
		const vault = plugin.app.vault.readableContents();
		vault?.set(MEETING_PATH, filed.source);
		vault?.set(SHED_PATH, filed.collection);
		vault?.set(LOG_PATH, filed.log);
		const blank: VaultLayout = { ...layout(), dailyLogFilename: "" };

		const said = await undoFilings(worldWith(plugin), MEETING_PATH, [FIRST], SHED_PATH, null, ORDINARY_NOTE, { layout: blank });

		expect(said).toContain("daily-log filename pattern");
		expect(await read(plugin, MEETING_PATH)).toBe(filed.source);
		expect(await read(plugin, SHED_PATH)).toBe(filed.collection);
		expect(await read(plugin, LOG_PATH)).toBe(filed.log);
	});
});

describe("#1000 and #1003: the live copy's removal is put back only if today's log still reads as the undo left it", () => {
	/** Files from the meeting note, copies in, and shows today's log in a tab when `inTab`. */
	async function copiedIn(inTab: boolean) {
		const before = todaysLogWith("- [ ] Mend the gate");
		const filed = filedFromMeeting(before);
		const { plugin } = await startMigration({ log: filed.log, extraNotes: { [MEETING_PATH]: filed.source } });
		const vault = plugin.app.vault.readableContents();
		vault?.set(MEETING_PATH, filed.source);
		vault?.set(SHED_PATH, filed.collection);
		vault?.set(LOG_PATH, filed.log);
		const tab = new FakeEditor(filed.log, 0);
		if (inTab) {
			const view = new MarkdownView({ path: LOG_PATH }, filed.log);
			view.editor = tab as never;
			plugin.app.workspace.leaves.push(new WorkspaceLeaf(view));
		}
		return { plugin, filed, before, tab };
	}

	// If wrong: the live copy goes back at the index it had, which now holds another line, so today's log reads
	// the person's line, then the live copy where an old line should be, and the notice says both notes are as they were.
	it.each([
		["through today's log's tab", true],
		["by the note writer", false],
	])("does not put the live copy back over a line written above it since, %s", async (_, inTab) => {
		const { plugin, filed, before, tab } = await copiedIn(inTab);
		const process = plugin.app.vault.process.bind(plugin.app.vault);
		vi.spyOn(plugin.app.vault, "process").mockImplementation(async (file, edit) => {
			if (file.path !== SHED_PATH) return process(file, edit);
			// The person types above the live copy in today's log between its removal and the collection's refusal.
			if (inTab) tab.replaceRange("A line written meanwhile\n", { line: 0, ch: 0 }, { line: 0, ch: 0 });
			else plugin.app.vault.readableContents()?.set(LOG_PATH, `A line written meanwhile\n${await read(plugin, LOG_PATH)}`);
			throw new Error("disk full");
		});

		const said = await undoFilings(worldWith(plugin), MEETING_PATH, [FIRST], SHED_PATH, null, ORDINARY_NOTE, { layout: layout() });

		const today = inTab ? tab.getValue() : await read(plugin, LOG_PATH);
		expect(today, "the live copy was put back at a stale line").toBe(`A line written meanwhile\n${before}`);
		expect(said, "the undo said the notes are as they were, but today's log is not").not.toContain("are as they were");
		expect(await read(plugin, MEETING_PATH)).toBe(filed.source);
	});
});
