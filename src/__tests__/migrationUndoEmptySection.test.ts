/**
 * Undoing a filing into a collection whose tasks section was empty. Filing into a section
 * with nothing in it adds a blank line above the task and, when a heading follows
 * directly, one below it (`insertBelow`); an undo that takes out only the task's
 * line left those blank lines behind. `## Tasks\n## Notes\n` and
 * `## Tasks\n\n## Notes\n` both file to `## Tasks\n\n- [ ] X\n\n## Notes\n`, so the text
 * alone cannot say which blank lines the filing wrote: the filing records them.
 *
 * **Every assertion compares a whole text with the text before the filing**, and
 * each case first asserts that filing changed the collection, so an undo that did
 * nothing, or a filing that wrote nothing, fails here. The three collections the
 * ticket names come back byte for byte only if the undo removes exactly what the
 * filing added: an undo that takes out only the task leaves one or two blank lines
 * (the first two cases), and one that always takes out a blank line above and below
 * eats the second collection's own blank line and the third's.
 *
 * The existing undo tests (`migrationUndo.test.ts`, `migrationUndoActiveCollection.test.ts`)
 * file into a collection that already holds a task, the one case that always came
 * back exactly, so none of them could have failed on this.
 *
 * Every folder, name and task is invented.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView, Notice, WorkspaceLeaf } from "./__mocks__/obsidian";
import type { Plugin } from "./__mocks__/obsidian";
import { NoteWriter } from "../core/noteWriter";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { fileInto } from "../features/migration/fileInto";
import { readFiled, readFrozen, removeFromCollection, restoreInLog, restoredLines, undoFilings } from "../features/migration/undo";
import type { UndoWorld } from "../features/migration/undo";
import { FakeEditor, LOG, LOG_PATH, SHED, installMigrationHooks, lastChooser, read, startMigration } from "./migrationHarness";

installMigrationHooks();

const SHED_PATH = "Projects/Garden shed.md";
const LOG_LINK = "[[2031-04-05]]";
const ID = "abc123";
const DONE_LOG = ["# Notes", "", "- [x] Order more tea", "- [ ] Mend the gate", "", "## Today", "", "- [ ] Water the plants", ""].join("\n");

function layout(): VaultLayout {
	const data = defaultData();
	return { ...data.core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
}

/** The same text with every line ending a carriage return and a line feed, the way a file written on Windows is. */
const crlf = (text: string): string => text.replace(/\n/g, "\r\n");

/** The collections the ticket names, each with a tasks section that holds no task or only one. */
const OPEN_CASES: readonly [string, string][] = [
	["a tasks heading with a heading directly under it", "## Tasks\n## Notes\n"],
	["a tasks heading with one blank line under it", "## Tasks\n\n## Notes\n"],
	["a tasks section that already holds a task", "## Tasks\n\n- [ ] a\n\n## Notes\n"],
];

/** Shapes of a note's end and of the neighbours a filing lays out around, each an empty tasks section. */
const EDGE_CASES: readonly [string, string][] = [
	["a tasks heading that is the last line, with no line break after it", "## Tasks"],
	["a tasks heading that is the last line, with a line break after it", "## Tasks\n"],
	["a tasks heading and one blank line at the end of the note", "## Tasks\n\n"],
	["a title above, and the tasks section empty at the end of the note", "# Garden shed\n\n## Tasks\n"],
];

/** Done tasks go under the completed-tasks heading, which the filing writes when it is missing. */
const DONE_CASES: readonly [string, string][] = [
	["a done task, the completed heading missing and a heading following", "## Tasks\n\n- [ ] a\n\n## Notes\n"],
	["a done task, the completed heading missing and a task directly above the next heading", "## Tasks\n- [ ] a\n## Notes\n"],
	["a done task, the completed heading missing and the tasks section the end of the note", "## Tasks\n\n- [ ] a\n"],
	["a done task, the completed heading missing and the tasks section empty", "## Tasks\n## Notes\n"],
	["a done task under an existing completed heading with nothing under it", "## Tasks\n\n- [ ] a\n\n## Completed tasks\n## Notes\n"],
	["a done task under an existing completed heading with a blank line under it", "## Tasks\n\n- [ ] a\n\n## Completed tasks\n\n## Notes\n"],
	["a done task under an existing completed heading that already holds one", "## Tasks\n\n- [ ] a\n\n## Completed tasks\n\n- [x] b\n\n## Notes\n"],
];

/** Files line 2 of the log into `collection` and undoes the filing, over the two texts; answers the collection before and after. */
function fileAndUndo(collection: string, logText: string): { filed: string; undone: string; log: string } {
	const filed = fileInto({ logText, lineIndex: 2, collectionText: collection, collectionLink: "[[Garden shed]]", logLink: LOG_LINK, id: ID, layout: layout() });
	if (!filed.ok) throw new Error(filed.reason);
	const frozen = readFrozen(filed.log, ID);
	if (frozen === null) throw new Error("the frozen line was not found again");
	const inCollection = readFiled(filed.collection, ID, frozen.hash, frozen.indent);
	if (!inCollection.ok) throw new Error(`the filing was not found again: ${inCollection.why}`);
	return {
		filed: filed.collection,
		undone: removeFromCollection(filed.collection, inCollection),
		log: restoreInLog(filed.log, frozen, restoredLines(inCollection)),
	};
}

describe("#986: undoing a filing gives the collection back byte for byte, over the texts filing wrote", () => {
	// If wrong: the two empty-section cases come back with one or two extra blank
	// lines under the heading, and the third comes back with a blank line missing.
	describe.each([
		["with line feeds", (text: string) => text],
		["with carriage returns and line feeds", crlf],
	])("%s", (_, shape) => {
		it.each(OPEN_CASES)("an open task, %s", (_case, before) => {
			const collection = shape(before);
			const result = fileAndUndo(collection, LOG);

			expect(result.filed, "filing wrote nothing, so the test cannot fail").not.toBe(collection);
			expect(result.filed).toContain("Order more tea");
			expect(result.undone).toBe(collection);
			expect(result.log).toBe(LOG);
		});

		it.each(EDGE_CASES)("an open task, %s", (_case, before) => {
			const collection = shape(before);
			const result = fileAndUndo(collection, LOG);

			expect(result.filed, "filing wrote nothing, so the test cannot fail").not.toBe(collection);
			expect(result.undone).toBe(collection);
		});

		// If wrong: the completed heading, the blank line under it or the blank lines
		// around the task stay behind; or, for the last case, an undo that takes the
		// heading out along with the task takes out the other done task's heading.
		it.each(DONE_CASES)("%s", (_case, before) => {
			const collection = shape(before);
			const result = fileAndUndo(collection, DONE_LOG);

			expect(result.filed, "filing wrote nothing, so the test cannot fail").not.toBe(collection);
			expect(result.filed).toContain("Order more tea");
			expect(result.undone).toBe(collection);
		});
	});

	// If wrong: the person's own task under the created completed heading goes with
	// it, or the heading is left with nothing above it but blank lines.
	it("leaves the completed heading a filing wrote alone when the person has put a task under it since", () => {
		const collection = "## Tasks\n\n- [ ] a\n\n## Notes\n";
		const filed = fileInto({ logText: DONE_LOG, lineIndex: 2, collectionText: collection, collectionLink: "[[Garden shed]]", logLink: LOG_LINK, id: ID, layout: layout() });
		if (!filed.ok) throw new Error(filed.reason);
		const added = filed.collection.replace("\n## Notes", "- [x] c\n\n## Notes");
		expect(added, "the person's task was not added, so the test cannot fail").not.toBe(filed.collection);
		const frozen = readFrozen(filed.log, ID);
		const inCollection = readFiled(added, ID, frozen?.hash ?? "", frozen?.indent ?? "");
		if (!inCollection.ok) throw new Error("the filing was not found again");

		const undone = removeFromCollection(added, inCollection);

		expect(undone).toContain("- [x] c");
		expect(undone).not.toContain("Order more tea");
		expect(undone).toContain("## Completed tasks");
	});

	// If wrong: a filing an earlier build wrote has no record of what it added, and an
	// undo that guessed would take out a blank line the person wrote; it must take out
	// the task's line and nothing else, as before this ticket.
	it("undoes a filing an earlier build wrote as it always did, taking out the task and nothing else", () => {
		const collection = "## Tasks\n\n## Notes\n";
		const filed = fileInto({ logText: LOG, lineIndex: 2, collectionText: collection, collectionLink: "[[Garden shed]]", logLink: LOG_LINK, id: ID, layout: layout() });
		if (!filed.ok) throw new Error(filed.reason);
		// The marker as an earlier build wrote it: no word after the link flag.
		const earlier = filed.collection.replace(/( L) \S+( %%)/, "$1$2");
		const frozen = readFrozen(filed.log, ID);
		const inCollection = readFiled(earlier, ID, frozen?.hash ?? "", frozen?.indent ?? "");
		if (!inCollection.ok) throw new Error("the filing was not found again");

		expect(earlier).toContain(" L %%");
		expect(removeFromCollection(earlier, inCollection)).toBe("## Tasks\n\n\n## Notes\n");
	});
});

/** A collection shown in a tab, the way Obsidian's workspace holds an open note. */
function showOnScreen(plugin: Plugin, editor: FakeEditor): void {
	const view = new MarkdownView({ path: SHED_PATH }, editor.getValue());
	view.editor = editor as never;
	plugin.app.workspace.leaves.push(new WorkspaceLeaf(view));
}

describe("#986: undo through the collection's own editor, when a tab shows it", () => {
	// If wrong: the editor route takes out only the task's line, so the collection's
	// editor reads one or two blank lines more than before filing; or, at the end of
	// the note, it takes out a line break too many or too few.
	it.each([...OPEN_CASES, ...EDGE_CASES, ...DONE_CASES.map(([name, before]) => [name, before] as [string, string])])("%s", async (name, before) => {
		const done = name.startsWith("a done task");
		for (const shape of [(text: string) => text, crlf]) {
			const collection = shape(before);
			const { plugin } = await startMigration({ log: done ? DONE_LOG : LOG });
			const filed = fileInto({ logText: done ? DONE_LOG : LOG, lineIndex: 2, collectionText: collection, collectionLink: "[[Garden shed]]", logLink: LOG_LINK, id: ID, layout: layout() });
			if (!filed.ok) throw new Error(filed.reason);
			expect(filed.collection, "filing wrote nothing, so the test cannot fail").not.toBe(collection);
			const vault = plugin.app.vault.readableContents();
			vault?.set(LOG_PATH, filed.log);
			vault?.set(SHED_PATH, filed.collection);
			const editor = new FakeEditor(filed.collection, 0);
			showOnScreen(plugin, editor);
			const world: UndoWorld = {
				app: plugin.app as never,
				notes: new NoteWriter(plugin.app.vault as never, { path: () => SHED_PATH, onChange: () => undefined }),
				collections: { all: () => [SHED] },
			};

			const said = await Promise.race([undoFilings(world, LOG_PATH, [ID], SHED_PATH, null), new Promise<string>((settle) => setTimeout(() => settle("parked"), 200))]);

			expect(said).toBe("Undone. The task is back in the day's log and no longer in Garden shed.");
			expect(editor.getValue()).toBe(collection);
			expect(await read(plugin, LOG_PATH)).toBe(done ? DONE_LOG : LOG);
		}
	});
});

describe("#986: undo from the notice's button, through the command's own filing", () => {
	beforeEach(() => {
		Notice.messages.length = 0;
		Notice.fragments.length = 0;
	});

	// If wrong: the collection on disk reads one or two blank lines more than before filing.
	it.each(OPEN_CASES.filter(([, before]) => !before.includes("- [ ] a")))("%s", async (_name, before) => {
		const { plugin } = await startMigration({ log: LOG });
		plugin.app.vault.readableContents()?.set(SHED_PATH, before);
		const editor = new FakeEditor(LOG, 2);
		const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:file-task`);
		(command as unknown as { editorCheckCallback: (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } | null }) => boolean | void }).editorCheckCallback(false, editor, { file: { path: LOG_PATH } });
		await lastChooser().chooseAt("shed", 0);
		await vi.waitFor(() => expect(Notice.messages.some((each) => each.startsWith("Put this task in"))).toBe(true));
		plugin.app.vault.readableContents()?.set(LOG_PATH, editor.getValue());
		expect(await read(plugin, SHED_PATH), "filing wrote nothing, so the test cannot fail").not.toBe(before);

		Notice.messages.length = 0;
		const button = Notice.fragments[Notice.fragments.length - 1]?.querySelector("button");
		expect(button?.textContent, "the filing showed no notice with a button").toBe("Undo migration");
		button?.click();
		await vi.waitFor(() => expect(Notice.messages).toEqual(["Undone. The task is back in the day's log and no longer in Garden shed."]));

		expect(await read(plugin, SHED_PATH)).toBe(before);
		expect(await read(plugin, LOG_PATH)).toBe(LOG);
	});
});
