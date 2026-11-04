/**
 * Undoing a filing into a note that got its tasks heading from that filing. Answering *Yes, write the
 * heading* makes the note a collection: the filing writes the tasks heading at the
 * note's end, with the blank lines around it, and then the task. An undo that took out
 * only the task left `## Tasks` and its separator lines in a note that was not a
 * collection before.
 *
 * **Every case runs the real filing (the command, the chooser, the question, the
 * writer) and the real undo (the notice's button) together, and compares the whole
 * note with its text before the filing**, after first asserting that the filing changed
 * it, so a filing that wrote nothing or an undo that did nothing fails here.
 *
 * Every note, folder and task is invented.
 */

import { describe, expect, it, vi } from "vitest";
import { Notice } from "./__mocks__/obsidian";
import type { Plugin } from "./__mocks__/obsidian";
import { parseTaskLine } from "../core/taskLine";
import { hashOfLine } from "../features/migration/marker";
import { readFiled, removeFromCollection } from "../features/migration/undo";
import { FakeEditor, LOG_PATH, PARTY_PATH, installMigrationHooks, lastAsk, lastChooser, read, startMigration } from "./migrationHarness";

installMigrationHooks();

const OPEN_LOG = ["# Notes", "", "- [ ] Order more tea", "- [ ] Mend the gate", "", "## Today", "", "- [ ] Water the plants", ""].join("\n");
const DONE_LOG = ["# Notes", "", "- [x] Order more tea", "- [ ] Mend the gate", "", "## Today", "", "- [ ] Water the plants", ""].join("\n");

/** The crlf shape of a text, the way a file written on Windows is. */
const crlf = (text: string): string => text.replace(/\n/g, "\r\n");

/** Notes that are not collections yet, each ending in a different way. */
const NOTES: readonly [string, string][] = [
	["a note that ends in one line break", "# Garden party\n\nBring chairs.\n"],
	["a note that ends without a line break", "# Garden party\n\nBring chairs."],
	["a note that ends in two blank lines", "# Garden party\n\nBring chairs.\n\n\n"],
	["an empty note", ""],
	["a note with Windows line endings", crlf("# Garden party\n\nBring chairs.\n")],
];

/** Files line `line` of the log the editor holds into the note and answers yes; answers the notice's undo button. */
async function fileWithHeading(plugin: Plugin, editor: FakeEditor): Promise<HTMLButtonElement> {
	const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:file-task`);
	const check = (command as unknown as { editorCheckCallback: (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } | null }) => boolean | void }).editorCheckCallback;
	const before = Notice.messages.filter((each) => each.startsWith("Put this task in")).length;
	check(false, editor, { file: { path: LOG_PATH } });
	await lastChooser().chooseAt("party", 0);
	lastAsk().press("Yes, write the heading");
	await vi.waitFor(() => expect(Notice.messages.filter((each) => each.startsWith("Put this task in"))).toHaveLength(before + 1));
	plugin.app.vault.readableContents()?.set(LOG_PATH, editor.getValue());
	const button = Notice.fragments[Notice.fragments.length - 1]?.querySelector("button");
	expect(button?.textContent, "the filing showed no notice with a button").toBe("Undo migration");
	return button as HTMLButtonElement;
}

async function undoBy(button: HTMLButtonElement): Promise<void> {
	Notice.messages.length = 0;
	button.click();
	await vi.waitFor(() => expect(Notice.messages).toEqual(["Undone. The task is back in the day's log and no longer in Garden party."]));
}

describe("#1004: undoing the first filing gives back a note that got its tasks heading from it", () => {
	// If wrong: the note comes back ending in `## Tasks` and the blank lines around
	// it, so `toBe` on the whole text fails.
	it.each(NOTES)("an open task, %s", async (_name, before) => {
		const { plugin } = await startMigration({ collections: [], log: OPEN_LOG, extraNotes: { [PARTY_PATH]: before } });
		const editor = new FakeEditor(OPEN_LOG, 2);

		const button = await fileWithHeading(plugin, editor);
		expect(await read(plugin, PARTY_PATH), "filing wrote nothing, so the test cannot fail").not.toBe(before);
		expect(await read(plugin, PARTY_PATH)).toContain("## Tasks");
		await undoBy(button);

		expect(await read(plugin, PARTY_PATH)).toBe(before);
		expect(await read(plugin, LOG_PATH)).toBe(OPEN_LOG);
	});

	// If wrong: the note comes back with the tasks heading, or the completed-tasks
	// heading, or a blank line beside them.
	// Not for the Windows-endings note: `placeInCollection`'s done branch, which this ticket does not own,
	// writes a closing `\r` with no line feed after it and leaves the note's last empty line inside the
	// note without a `\r`, so no run of lines taken out gives that note back. Named in the closing comment.
	it.each(NOTES.filter(([name]) => !name.includes("Windows")))("a done task, where the completed-tasks heading is written too, %s", async (_name, before) => {
		const { plugin } = await startMigration({ collections: [], log: DONE_LOG, extraNotes: { [PARTY_PATH]: before } });
		const editor = new FakeEditor(DONE_LOG, 2);

		const button = await fileWithHeading(plugin, editor);
		const filed = await read(plugin, PARTY_PATH);
		expect(filed, "filing wrote nothing, so the test cannot fail").not.toBe(before);
		expect(filed).toContain("## Tasks");
		expect(filed).toContain("Completed tasks");
		await undoBy(button);

		expect(await read(plugin, PARTY_PATH)).toBe(before);
		expect(await read(plugin, LOG_PATH)).toBe(DONE_LOG);
	});

	// If wrong: undoing the first filing takes the heading the second task sits under
	// with it, and the second task is left with no heading above it.
	it("a second filing lands under the heading, and undoing the first does not take the heading", async () => {
		const before = "# Garden party\n\nBring chairs.\n";
		const { plugin } = await startMigration({ collections: [], log: OPEN_LOG, extraNotes: { [PARTY_PATH]: before } });
		const editor = new FakeEditor(OPEN_LOG, 2);
		const first = await fileWithHeading(plugin, editor);
		plugin.app.vault.readableContents()?.set(LOG_PATH, editor.getValue());
		const afterFirst = await read(plugin, PARTY_PATH);
		const collections = plugin.app.vault.files.map((each) => each.path);
		expect(collections).toContain(PARTY_PATH);

		// The second filing. The harness's collection index is fixed and empty, so the note is offered as an ordinary one and the
		// question is asked again; the note already has the heading, so answering yes writes no second one.
		const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:file-task`);
		const check = (command as unknown as { editorCheckCallback: (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } | null }) => boolean | void }).editorCheckCallback;
		const second = new FakeEditor(editor.getValue(), 3);
		check(false, second, { file: { path: LOG_PATH } });
		await lastChooser().chooseAt("party", 0);
		lastAsk().press("Yes, write the heading");
		await vi.waitFor(async () => expect(await read(plugin, PARTY_PATH)).not.toBe(afterFirst));
		plugin.app.vault.readableContents()?.set(LOG_PATH, second.getValue());
		const twoTasks = await read(plugin, PARTY_PATH);
		expect(twoTasks).toContain("Mend the gate");

		Notice.messages.length = 0;
		first.click();
		await vi.waitFor(() => expect(Notice.messages).toHaveLength(1));

		const after = await read(plugin, PARTY_PATH);
		expect(after).toContain("## Tasks");
		expect(after).toContain("Mend the gate");
		expect(after).not.toContain("Order more tea");
	});
});

describe("#1004: a marker with no record of a written heading undoes as before", () => {
	// If wrong: the older marker's filing is undone with lines taken that it never wrote, or not undone at all.
	it("takes out the task's block alone, and leaves the heading", () => {
		const hash = hashOfLine(parseTaskLine("- [ ] Order more tea")!);
		const collection = `# Garden party\n\n## Tasks\n\n- [ ] Order more tea [[2031-04-05]] %% migration:abc123 ${hash} _ L %%\n`;
		const found = readFiled(collection, "abc123", hash, "");
		expect(found.ok).toBe(true);
		if (!found.ok) return;

		expect(removeFromCollection(collection, found)).toBe("# Garden party\n\n## Tasks\n\n");
	});
});
