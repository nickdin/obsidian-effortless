/**
 * Migration's undo, run through its real right-click route, over a task Task
 * consistency has copied into the day's log
 * (#886,
 * #890,
 * #891, findings against
 * #885). The filing goes
 * through the command, Task consistency's `copyIn` runs over the two texts it
 * left, and the undo is pressed on the log that results. Every note, collection
 * and task is invented.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Menu, Notice } from "./__mocks__/obsidian";
import type { Plugin } from "./__mocks__/obsidian";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { copyIn } from "../features/taskConsistency/copyIn";
import { FakeEditor, LOG_PATH, installMigrationHooks, lastChooser, read, startMigration } from "./migrationHarness";
import { pressLineAwayFromCursor } from "./editorMenu";

installMigrationHooks();

const SHED_PATH = "Projects/Garden shed.md";
const TODAY = new Date(2031, 3, 5);
const TODAY_KEY = "2031-04-05";
const GATE = "- [ ] Mend the gate";

const layout: VaultLayout = { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
const logWith = (task: string): string => ["# Notes", "", task, GATE, "", "## Overdue", "", "## Today", ""].join("\n");

type CheckCallback = (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } | null }) => boolean | void;

beforeEach(() => {
	Notice.messages.length = 0;
});

/** Files line 2 of `log` into Garden shed through the command; the texts before and after are read back. */
async function file(log: string): Promise<{ plugin: Plugin; collectionBefore: string; log: string; collection: string }> {
	const { plugin } = await startMigration({ log });
	const collectionBefore = await read(plugin, SHED_PATH);
	const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:file-task`);
	expect(command, "the file-task command was not registered").toBeDefined();
	const editor = new FakeEditor(log, 2);
	(command as unknown as { editorCheckCallback: CheckCallback }).editorCheckCallback(false, editor, { file: { path: LOG_PATH } });
	await lastChooser().chooseAt("shed", 0);
	await vi.waitFor(() => expect(Notice.messages.some((each) => each.startsWith("Put this task in"))).toBe(true));
	return { plugin, collectionBefore, log: editor.getValue(), collection: await read(plugin, SHED_PATH) };
}

/** Puts `collection` in the vault, right-clicks line 2 of `log` and chooses the undo entry; answers the log's text and the collection's afterwards. */
async function undo(plugin: Plugin, log: string, collection: string): Promise<{ log: string; collection: string; said: string }> {
	plugin.app.vault.readableContents()?.set(SHED_PATH, collection);
	const editor = new FakeEditor(log, 2);
	const menu = new Menu();
	pressLineAwayFromCursor(editor, editor.getCursor().line);
	plugin.app.workspace.fire("editor-menu", menu, editor, { file: { path: LOG_PATH } });
	const entry = menu.items.find((each) => each.title === "Undo migration");
	expect(entry, "the undo entry was not added on the frozen line").toBeDefined();
	Notice.messages.length = 0;
	entry?.click();
	await vi.waitFor(() => expect(Notice.messages.some((each) => each.startsWith("Undone") || each.includes("nothing was undone") || each.includes("did not finish"))).toBe(true));
	return { log: editor.getValue(), collection: await read(plugin, SHED_PATH), said: Notice.messages[Notice.messages.length - 1] };
}

describe("#886: undo after Task consistency has copied the task into the day's log", () => {
	it("leaves the day's log exactly as it was before filing, the live copy included", async () => {
		const before = logWith(`- [ ] Order more tea 📅 ${TODAY_KEY}`);
		const filed = await file(before);
		const copied = copyIn(filed.collection, filed.log, TODAY, layout, "Garden shed");
		// Were nothing copied in, the log would carry no live copy and this test could not fail.
		expect(copied.copied).toBe(1);
		expect(copied.log.split("\n").filter((line) => line.includes("task-consistency:"))).toHaveLength(1);

		const undone = await undo(filed.plugin, copied.log, copied.collection);

		expect(undone.said).toBe("Undone. The task is back in the day's log and no longer in Garden shed.");
		expect(undone.log).toBe(before);
		expect(undone.collection).toBe(filed.collectionBefore);
	});

	it("takes the live copy from the overdue heading too, when the task was dated earlier", async () => {
		const before = logWith("- [ ] Order more tea 📅 2031-04-01");
		const filed = await file(before);
		const copied = copyIn(filed.collection, filed.log, TODAY, layout, "Garden shed");
		expect(copied.copied).toBe(1);

		const undone = await undo(filed.plugin, copied.log, copied.collection);

		expect(undone.log).toBe(before);
	});

	it("leaves a line elsewhere in the log that only resembles the live copy", async () => {
		const before = logWith(`- [ ] Order more tea 📅 ${TODAY_KEY}`).replace("## Today\n", "## Today\n\n- [ ] Order more tea 📅 2031-04-05 [[Garden shed]]\n");
		const filed = await file(before);
		const copied = copyIn(filed.collection, filed.log, TODAY, layout, "Garden shed");

		const undone = await undo(filed.plugin, copied.log, copied.collection);

		// Only the line carrying the copy's own marker goes; one with the same words and no marker is the person's.
		expect(undone.log).toBe(before);
	});
});

describe("#886: Task consistency marked the copy but wrote no live copy into the log", () => {
	// The usual case in the real app while the day's log is open in a tab (docs/acceptance-shots/issue-892-undo-redrive.txt).
	it("leaves the day's log exactly as it was before filing, with none of Task consistency's marker on the restored line", async () => {
		const before = logWith(`- [ ] Order more tea 📅 ${TODAY_KEY}`);
		const filed = await file(before);
		const copied = copyIn(filed.collection, filed.log, TODAY, layout, "Garden shed");
		expect(copied.collection).toContain("task-consistency:");

		// The collection carries the mark and marker; the log is as filing left it.
		const undone = await undo(filed.plugin, filed.log, copied.collection);

		expect(undone.said).toBe("Undone. The task is back in the day's log and no longer in Garden shed.");
		expect(undone.log).toBe(before);
		expect(undone.collection).toBe(filed.collectionBefore);
	});
});

describe("#890: a comment the person added to the filed copy", () => {
	it.each([
		["a word and a colon", "%% note: ring after 5 %%"],
		["a time", "%% 12:30 call %%"],
		["an address", "%% https://example.com/x %%"],
		["no colon", "%% just a thought %%"],
	])("comes back on the restored line, %s", async (_, comment) => {
		const before = logWith("- [ ] Call Bob");
		const filed = await file(before);
		// Inserted after the link back Migration appends, the way a person editing
		// after filing would type beside the plugin's own trailing marker.
		const touched = filed.collection.replace(" %% migration:", ` ${comment} %% migration:`);
		expect(touched).not.toBe(filed.collection);

		const undone = await undo(filed.plugin, filed.log, touched);

		expect(undone.said).toContain("Undone");
		expect(undone.log).toBe(before.replace("- [ ] Call Bob", `- [ ] Call Bob ${comment}`));
	});

	it.each([
		["a word and a colon", "%% note: ring after 5 %%"],
		["a time", "%% 12:30 call %%"],
		["an address", "%% https://example.com/x %%"],
		["no colon", "%% just a thought %%"],
	])("comes back on the restored line when typed right after the task's own words, before the link back, %s", async (_, comment) => {
		const before = logWith("- [ ] Call Bob");
		const filed = await file(before);
		// The #890 placement #906 moved off (`migrationUndoAfterCopyIn.test.ts`
		// before this ticket): right after the words, ahead of the link back
		// Migration itself appends, rather than after it.
		const touched = filed.collection.replace("- [ ] Call Bob ", `- [ ] Call Bob ${comment} `);
		expect(touched).not.toBe(filed.collection);

		const undone = await undo(filed.plugin, filed.log, touched);

		expect(undone.said).toContain("Undone");
		expect(undone.log).toBe(before.replace("- [ ] Call Bob", `- [ ] Call Bob ${comment}`));
	});

	it("comes back when Task consistency's own marker is on the copy beside it", async () => {
		const before = logWith(`- [ ] Order more tea 📅 ${TODAY_KEY}`);
		const filed = await file(before);
		const copied = copyIn(filed.collection, filed.log, TODAY, layout, "Garden shed");
		// Inserted after the link back, before Task consistency's own marker.
		const noted = copied.collection.replace(" %% task-consistency:", " %% note: ring after 5 %% %% task-consistency:");
		expect(noted).not.toBe(copied.collection);

		const undone = await undo(filed.plugin, copied.log, noted);

		// The live copy and Task consistency's marker go; the person's note stays on the restored line.
		expect(undone.log).toBe(before.replace(`📅 ${TODAY_KEY}`, `📅 ${TODAY_KEY} %% note: ring after 5 %%`));
	});
});

describe("#891: a copy the person set to [/] when the task was filed in another state", () => {
	it.each([
		["done", "x"],
		["cancelled", "-"],
		["forwarded", ">"],
	])("is refused, both files unchanged, when the task was filed %s", async (_, box) => {
		const before = logWith(`- [${box}] Order more tea`);
		const filed = await file(before);
		const set = filed.collection.replace(`- [${box}] Order more tea`, "- [/] Order more tea");
		expect(set).not.toBe(filed.collection);

		const undone = await undo(filed.plugin, filed.log, set);

		expect(undone.said).toContain("changed or ticked since it was put there");
		expect(undone.log).toBe(filed.log);
		expect(undone.collection).toBe(set);
	});
});
