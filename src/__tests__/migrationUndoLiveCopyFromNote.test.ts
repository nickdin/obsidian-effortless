/**
 * Migration's undo and Task consistency's live copy meet in today's log
 * (#994, a finding against
 * #983, after
 * #886). Task consistency copies
 * an open, dated collection task into **today's log**, never into the note the
 * task was filed from. So an undo from a meeting note has to reach today's log,
 * and has to leave every other line of the meeting note alone. Filing goes through
 * the command, `copyIn` runs over the two texts it left, and the undo is chosen
 * from the right-click entry. Every note, collection and task is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView, Menu, Notice, WorkspaceLeaf } from "./__mocks__/obsidian";
import type { Plugin } from "./__mocks__/obsidian";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { UNDO_ENTRY_TITLE } from "../features/migration/menu";
import { copyIn } from "../features/taskConsistency/copyIn";
import { FakeEditor, LOG_PATH, SHED, installMigrationHooks, lastChooser, read, startMigration } from "./migrationHarness";
import { pressLineAwayFromCursor } from "./editorMenu";

installMigrationHooks();

const TODAY = new Date(2031, 3, 5);
const TODAY_KEY = "2031-04-05";
const MEETING_PATH = "Meetings/Lantern committee.md";
const YESTERDAY_PATH = "Journal/2031-04-04.md";
const OARS = "- [ ] Varnish the spare oars";
const IRIS = "- [ ] Ring Iris %% ask Iris %%";

const layout: VaultLayout = { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
/** A day's log with the frame Task consistency copies into. */
const logWith = (...lines: string[]): string => ["# Notes", "", ...lines, "", "## Overdue", "", "## Today", ""].join("\n");
const meetingWith = (task: string): string => ["# Lantern committee", "", "Present: [[Ada Fenwick]]", "", task, ""].join("\n");

type CheckCallback = (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } | null }) => boolean | void;

beforeEach(() => {
	Notice.messages.length = 0;
	// Only the date is faked: Task consistency reads the clock for "today", and so does undo.
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(TODAY);
});

afterEach(() => {
	vi.useRealTimers();
});

interface Filed {
	readonly plugin: Plugin;
	/** The note the task was filed from, as filing left it. */
	readonly source: string;
	readonly collection: string;
}

/** Files the line `task` of `sourceText`, a note at `sourcePath`, into Garden shed, with today's log holding `todaysLog`. */
async function fileFrom(sourcePath: string, sourceText: string, task: string, todaysLog: string): Promise<Filed> {
	const { plugin } = await startMigration({ log: todaysLog, extraNotes: { [sourcePath]: sourceText } });
	const editor = new FakeEditor(sourceText, sourceText.split("\n").indexOf(task));
	const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:file-task`);
	expect(command, "the file-task command was not registered").toBeDefined();
	(command as unknown as { editorCheckCallback: CheckCallback }).editorCheckCallback(false, editor, { file: { path: sourcePath } });
	await lastChooser().chooseAt("shed", 0);
	await vi.waitFor(() => expect(Notice.messages.some((each) => each.startsWith("Put this task in"))).toBe(true));
	const source = editor.getValue();
	expect(source, "filing froze nothing, so the test cannot fail").toContain("- [>]");
	return { plugin, source, collection: await read(plugin, SHED.path) };
}

/** Puts `text` at `path` in the vault as the world stands when the undo is chosen. */
function put(plugin: Plugin, path: string, text: string): void {
	plugin.app.vault.readableContents()?.set(path, text);
}

/** Right-clicks the frozen line of `sourceText` at `sourcePath`, chooses the undo entry and waits for the notice. */
async function undo(plugin: Plugin, sourcePath: string, sourceText: string): Promise<{ source: string; said: string }> {
	const editor = new FakeEditor(sourceText, sourceText.split("\n").findIndex((each) => each.startsWith("- [>]")));
	const menu = new Menu();
	pressLineAwayFromCursor(editor, editor.getCursor().line);
	plugin.app.workspace.fire("editor-menu", menu, editor, { file: { path: sourcePath } });
	const entry = menu.items.find((each) => each.title === UNDO_ENTRY_TITLE);
	expect(entry, "the undo entry was not added on the frozen line").toBeDefined();
	Notice.messages.length = 0;
	entry?.click();
	await vi.waitFor(() => expect(Notice.messages.some((each) => each.startsWith("Undone") || each.includes("nothing was undone") || each.includes("did not finish"))).toBe(true));
	return { source: editor.getValue(), said: Notice.messages[Notice.messages.length - 1] };
}

describe("#994: undo takes Task consistency's live copy out of today's log, from any note", () => {
	// If wrong: the live copy stays. Today's log then holds the line "→ [[Garden shed]] %% task-consistency:… %%"
	// under "## Today" and differs from its text before filing, which is what the last assertion compares.
	it("from a meeting note, leaves today's log exactly as it was before filing", async () => {
		const before = logWith("- [ ] Mend the gate");
		const filed = await fileFrom(MEETING_PATH, meetingWith(`${OARS} 📅 ${TODAY_KEY}`), `${OARS} 📅 ${TODAY_KEY}`, before);
		const copied = copyIn(filed.collection, before, TODAY, layout, "Garden shed");
		expect(copied.log, "Task consistency copied nothing into today's log, so the test cannot fail").toContain("task-consistency:");
		put(filed.plugin, LOG_PATH, copied.log);
		put(filed.plugin, SHED.path, copied.collection);

		const undone = await undo(filed.plugin, MEETING_PATH, filed.source);

		expect(undone.said).toBe("Undone. The task is back in the note and no longer in Garden shed.");
		expect(await read(filed.plugin, LOG_PATH)).toBe(before);
		expect(undone.source).toBe(meetingWith(`${OARS} 📅 ${TODAY_KEY}`));
		expect(await read(filed.plugin, SHED.path)).not.toContain("Varnish the spare oars");
	});

	// If wrong: a scan of the meeting note deletes each line carrying "%% ask Iris %%", the copy's comment: the
	// ordinary line, the one in the fence and the one in the frontmatter all go, and the note differs from `expected`.
	// Today's log carries the same comment on a task of its own, which must stay too.
	it("from a meeting note, leaves every other task carrying the same comment untouched, in a fence and in frontmatter too", async () => {
		const meeting = ["---", IRIS, "---", "# Lantern committee", "", `${OARS} 📅 ${TODAY_KEY}`, IRIS, "", "```", IRIS, "```", ""].join("\n");
		const before = logWith("- [ ] Mend the gate", IRIS);
		const filed = await fileFrom(MEETING_PATH, meeting, `${OARS} 📅 ${TODAY_KEY}`, before);
		// The person adds a comment to the collection's copy after filing; it is masked out of the hash, so undo still runs.
		const touched = filed.collection.replace(" %% migration:", " %% ask Iris %% %% migration:");
		expect(touched, "the comment was not added, so the test cannot fail").not.toBe(filed.collection);
		put(filed.plugin, SHED.path, touched);

		const undone = await undo(filed.plugin, MEETING_PATH, filed.source);

		expect(undone.said).toBe("Undone. The task is back in the note and no longer in Garden shed.");
		expect(undone.source).toBe(meeting.replace(`${OARS} 📅 ${TODAY_KEY}`, `${OARS} 📅 ${TODAY_KEY} %% ask Iris %%`));
		expect(await read(filed.plugin, LOG_PATH)).toBe(before);
	});

	// Guard: undo from today's own log, where #886 promised it. If wrong the live copy stays under "## Today".
	it("from today's log, still removes the live copy, as before", async () => {
		const before = logWith(`- [ ] Order more tea 📅 ${TODAY_KEY}`);
		const filed = await fileFrom(LOG_PATH, before, `- [ ] Order more tea 📅 ${TODAY_KEY}`, before);
		const copied = copyIn(filed.collection, filed.source, TODAY, layout, "Garden shed");
		expect(copied.log, "Task consistency copied nothing into today's log, so the test cannot fail").toContain("task-consistency:");
		put(filed.plugin, SHED.path, copied.collection);

		const undone = await undo(filed.plugin, LOG_PATH, copied.log);

		expect(undone.source).toBe(before);
	});

	// A past day's log: Task consistency's copy is in today's log there too, so undo takes it from today's log, and
	// the past day's log comes back as it was. If wrong the live copy stays in today's log, which then differs from `before`.
	it("from a past day's log, takes the live copy out of today's log and puts the past log back", async () => {
		const before = logWith("- [ ] Mend the gate");
		const past = logWith(`- [ ] Order more tea 📅 ${TODAY_KEY}`);
		const filed = await fileFrom(YESTERDAY_PATH, past, `- [ ] Order more tea 📅 ${TODAY_KEY}`, before);
		const copied = copyIn(filed.collection, before, TODAY, layout, "Garden shed");
		expect(copied.log, "Task consistency copied nothing into today's log, so the test cannot fail").toContain("task-consistency:");
		put(filed.plugin, LOG_PATH, copied.log);
		put(filed.plugin, SHED.path, copied.collection);

		const undone = await undo(filed.plugin, YESTERDAY_PATH, filed.source);

		expect(undone.source).toBe(past);
		expect(await read(filed.plugin, LOG_PATH)).toBe(before);
	});

	// No live copy: Task consistency has not run. Today's log is not written at all: rewriting it with the same
	// bytes would still wake anything watching the file, so the assertion is on the write, not only on the text.
	// If wrong (a write of identical text) the spy sees today's log written.
	it("from a meeting note with no live copy, does not write today's log", async () => {
		const before = logWith("- [ ] Mend the gate");
		const filed = await fileFrom(MEETING_PATH, meetingWith(`${OARS} 📅 ${TODAY_KEY}`), `${OARS} 📅 ${TODAY_KEY}`, before);
		const written = vi.spyOn(filed.plugin.app.vault, "process");

		const undone = await undo(filed.plugin, MEETING_PATH, filed.source);

		expect(undone.said).toBe("Undone. The task is back in the note and no longer in Garden shed.");
		expect(written.mock.calls.map((each) => (each[0] as { path: string }).path)).not.toContain(LOG_PATH);
		expect(await read(filed.plugin, LOG_PATH)).toBe(before);
	});
});

describe("#994: today's log open in a tab, and a collection write that is refused", () => {
	/** Files from a meeting note and lets Task consistency copy into `before`, with today's log shown in a tab when `inTab`. */
	async function copiedIn(inTab: boolean): Promise<{ filed: Filed; before: string; copied: string; tab: FakeEditor | null }> {
		const before = logWith("- [ ] Mend the gate");
		const filed = await fileFrom(MEETING_PATH, meetingWith(`${OARS} 📅 ${TODAY_KEY}`), `${OARS} 📅 ${TODAY_KEY}`, before);
		const copied = copyIn(filed.collection, before, TODAY, layout, "Garden shed");
		expect(copied.log, "Task consistency copied nothing into today's log, so the test cannot fail").toContain("task-consistency:");
		put(filed.plugin, LOG_PATH, copied.log);
		put(filed.plugin, SHED.path, copied.collection);
		let tab: FakeEditor | null = null;
		if (inTab) {
			tab = new FakeEditor(copied.log, 0);
			const view = new MarkdownView({ path: LOG_PATH }, copied.log);
			view.editor = tab as never;
			filed.plugin.app.workspace.leaves.push(new WorkspaceLeaf(view));
		}
		return { filed, before, copied: copied.log, tab };
	}

	// If wrong: the write goes to the note writer, which holds a write to the note on screen until the person leaves it, so the tab still shows the live copy; or it leaves a blank line where the copy was.
	it("takes the live copy out through the editor of the tab showing today's log", async () => {
		const { filed, before, tab } = await copiedIn(true);

		const undone = await undo(filed.plugin, MEETING_PATH, filed.source);

		expect(undone.said).toBe("Undone. The task is back in the note and no longer in Garden shed.");
		expect(tab?.getValue()).toBe(before);
	});

	// If wrong: the log is left without its live copy while the collection still holds the task, or the meeting note stays restored.
	it.each([
		["by the note writer", false],
		["through the tab's editor", true],
	])("puts today's log and the meeting note back as they were when the collection's write is refused, %s", async (_, inTab) => {
		const { filed, copied, tab } = await copiedIn(inTab);
		const process = filed.plugin.app.vault.process.bind(filed.plugin.app.vault);
		vi.spyOn(filed.plugin.app.vault, "process").mockImplementation((file, edit) =>
			file.path === SHED.path ? Promise.reject(new Error("disk full")) : process(file, edit),
		);

		const undone = await undo(filed.plugin, MEETING_PATH, filed.source);

		expect(undone.said).toBe("Garden shed could not be written (disk full), so nothing was undone. The note and Garden shed are as they were.");
		expect(undone.source).toBe(filed.source);
		expect(tab === null ? await read(filed.plugin, LOG_PATH) : tab.getValue()).toBe(copied);
	});
});
