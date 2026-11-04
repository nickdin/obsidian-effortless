/**
 * Filing into a note with Windows line endings (`\r\n`) at the very end of the note. Every line break of a filed
 * `\r\n` note stays `\r\n`, and a note that ended without a final line break still does.
 * Every note, folder and task is invented.
 *
 * Every undo case compares the note after undo with the note before, whole: writing below a last line that
 * had no break gives that line a `\r`, which an undo has to take back.
 */

import { describe, expect, it, vi } from "vitest";
import { MarkdownView, Notice, WorkspaceLeaf } from "./__mocks__/obsidian";
import type { Plugin } from "./__mocks__/obsidian";
import { defaultData } from "../core/settings";
import { placeInCollection } from "../features/migration/fileInto";
import { headingKey, readMarker } from "../features/migration/marker";
import { readFiled } from "../features/migration/undo";
import { FakeEditor, LOG_PATH, PARTY_PATH, installMigrationHooks, lastAsk, lastChooser, read, startMigration } from "./migrationHarness";

installMigrationHooks();

const layout = defaultData().core.layout;

const OPEN = "- [ ] Fix the gate";
const DONE = "- [x] Fix the gate";

/** Every `\n` is preceded by `\r`, and every `\r` is followed by `\n`. */
function allWindows(text: string): boolean {
	return !/(?<!\r)\n/.test(text) && !/\r(?!\n)/.test(text);
}

describe("#1038: a task filed at the end of a Windows-endings note", () => {
	const TASKS = "# Garden party\r\n\r\n## Tasks";
	const COMPLETED = `${TASKS}\r\n\r\n## ${layout.completedTasksHeading}`;

	// If wrong: a bare `\n` or a lone `\r` shows in the quoted bytes, so toBe fails.
	it.each([
		["an open task after a task, no final break", `${TASKS}\r\n- [ ] Bring chairs`, OPEN, "open", `${TASKS}\r\n- [ ] Bring chairs\r\n${OPEN}`],
		["an open task after a task, final break", `${TASKS}\r\n- [ ] Bring chairs\r\n`, OPEN, "open", `${TASKS}\r\n- [ ] Bring chairs\r\n${OPEN}\r\n`],
		["an open task in an empty section, no final break", TASKS, OPEN, "open", `${TASKS}\r\n\r\n${OPEN}`],
		["an open task in an empty section, final break", `${TASKS}\r\n`, OPEN, "open", `${TASKS}\r\n\r\n${OPEN}\r\n`],
		["a done task after a task, no final break", `${COMPLETED}\r\n- [x] Bring chairs`, DONE, "done", `${COMPLETED}\r\n- [x] Bring chairs\r\n${DONE}`],
		["a done task after a task, final break", `${COMPLETED}\r\n- [x] Bring chairs\r\n`, DONE, "done", `${COMPLETED}\r\n- [x] Bring chairs\r\n${DONE}\r\n`],
		["a done task in an empty completed section, no final break", COMPLETED, DONE, "done", `${COMPLETED}\r\n\r\n${DONE}`],
		["a done task in an empty completed section, final break", `${COMPLETED}\r\n`, DONE, "done", `${COMPLETED}\r\n\r\n${DONE}\r\n`],
	] as const)("writes exactly these bytes: %s", (_name, note, line, meaning, expected) => {
		const placed = placeInCollection(note, line, meaning, layout);
		expect(placed).toEqual({ ok: true, text: expected });
		expect(allWindows(expected), "the expected text is not all \\r\\n, so the test cannot fail").toBe(true);
	});

	// If wrong: the filed text is not all `\r\n`, as before the fix, so allWindows is false.
	it("keeps a task and its sub-line, both ending \\r\\n, at the end of a note without a final break", () => {
		const placed = placeInCollection(`${TASKS}\r\n- [ ] Bring chairs`, [OPEN, "\t- [ ] Oil the hinge"], "open", layout);
		expect(placed).toEqual({ ok: true, text: `${TASKS}\r\n- [ ] Bring chairs\r\n${OPEN}\r\n\t- [ ] Oil the hinge` });
	});

	// The note's own line endings are the one line model: a note with `\n` endings is not changed by it.
	it("leaves a note with \\n endings as it was written", () => {
		expect(placeInCollection("# Garden party\n\n## Tasks\n- [ ] Bring chairs", OPEN, "open", layout)).toEqual({
			ok: true,
			text: `# Garden party\n\n## Tasks\n- [ ] Bring chairs\n${OPEN}`,
		});
	});
});

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

const OPEN_LOG = ["# Notes", "", "- [ ] Order more tea", "- [ ] Mend the gate", "", "## Today", "", "- [ ] Water the plants", ""].join("\n");
const DONE_LOG = ["# Notes", "", "- [x] Order more tea", "- [ ] Mend the gate", "", "## Today", "", "- [ ] Water the plants", ""].join("\n");

describe("#1041: answering yes to the tasks heading in a Windows-endings note", () => {
	const NO_FINAL_BREAK = "# Garden party\r\n\r\nBring chairs.";
	const FINAL_BREAK = "# Garden party\r\n\r\nBring chairs.\r\n";

	/**
	 * The heading the question writes is `## Tasks`; the open task lands under it, and a done
	 * task adds its own completed-tasks heading below that. What the marker on the filed line
	 * records is every line the filing added around it.
	 */
	it.each([
		["an open task", OPEN_LOG, "- [ ] Order more tea", "# Garden party\r\n\r\nBring chairs.\r\n\r\n## Tasks\r\n\r\n", { above: "bhb", below: "b", under: headingKey("## Tasks") }],
		["a done task", DONE_LOG, "- [x] Order more tea", "# Garden party\r\n\r\nBring chairs.\r\n\r\n## Tasks\r\n\r\n", { above: "bhbbhb", below: "b", under: headingKey(`## ${layout.completedTasksHeading}`) }],
	] as const)("%s: the record names the heading and the blank lines the filing wrote, no final break", async (_name, log, task, prefix, record) => {
		const { plugin } = await startMigration({ collections: [], log, extraNotes: { [PARTY_PATH]: NO_FINAL_BREAK } });
		const button = await fileWithHeading(plugin, new FakeEditor(log, 2));
		const filed = await read(plugin, PARTY_PATH);

		expect(filed.startsWith(prefix), JSON.stringify(filed)).toBe(true);
		expect(allWindows(filed), JSON.stringify(filed)).toBe(true);
		const copy = filed.split("\n").find((each) => each.includes(task.slice(6)) && readMarker(each.replace(/\r$/, "")) !== null) ?? "";
		const marker = readMarker(copy.replace(/\r$/, ""));
		expect(marker, "the filed line carries no marker, so the test cannot fail").not.toBeNull();
		// If wrong: the marker records nothing about the heading, as before the fix, and `added` is undefined.
		expect(marker?.added).toEqual(record);

		await undoBy(button);
		const undone = await read(plugin, PARTY_PATH);
		// If wrong: the note comes back with a `\r` on its old last line, or with the heading and blank lines left behind.
		expect(undone).toBe(NO_FINAL_BREAK);
		expect(await read(plugin, LOG_PATH)).toBe(log);
	});

	// The same note with a final break gave its text back whole before this change; coverage, so it stays that way.
	it.each([
		["an open task", OPEN_LOG],
		["a done task", DONE_LOG],
	] as const)("%s: a note with a final break comes back byte for byte", async (_name, log) => {
		const { plugin } = await startMigration({ collections: [], log, extraNotes: { [PARTY_PATH]: FINAL_BREAK } });
		const button = await fileWithHeading(plugin, new FakeEditor(log, 2));
		expect(allWindows(await read(plugin, PARTY_PATH))).toBe(true);
		await undoBy(button);
		expect(await read(plugin, PARTY_PATH)).toBe(FINAL_BREAK);
	});

	// Coverage for the case `migrationUndoWrittenHeading.test.ts` leaves out ("Windows" filtered from the done cases,
	// its comment above that test): since #1025 a done task filed with the heading into a Windows-endings note
	// that ends in a line break is given back whole.
	it("a done task, both headings written, a Windows-endings note with a final break comes back byte for byte", async () => {
		const { plugin } = await startMigration({ collections: [], log: DONE_LOG, extraNotes: { [PARTY_PATH]: FINAL_BREAK } });
		const button = await fileWithHeading(plugin, new FakeEditor(DONE_LOG, 2));
		const filed = await read(plugin, PARTY_PATH);
		expect(filed).toContain("Completed tasks");
		expect(allWindows(filed)).toBe(true);
		await undoBy(button);
		expect(await read(plugin, PARTY_PATH)).toBe(FINAL_BREAK);
	});
});

describe("#1039: a done task whose completed heading is written into a Windows-endings note with no final break", () => {
	const BEFORE = "# Garden party\r\n\r\n## Tasks\r\n\r\n- [ ] Bring chairs";

	// If wrong: the open tab's text comes back ending `- [ ] Bring chairs\r`, as the file path's did.
	it("undone through an open tab, the tab's text is the note as it was", async () => {
		const { plugin } = await startMigration({ collections: [], log: DONE_LOG, extraNotes: { [PARTY_PATH]: BEFORE } });
		const button = await fileWithHeading(plugin, new FakeEditor(DONE_LOG, 2));
		const filed = await read(plugin, PARTY_PATH);
		expect(filed, "filing wrote nothing, so the test cannot fail").not.toBe(BEFORE);
		const tab = new FakeEditor(filed, 0);
		const view = new MarkdownView({ path: PARTY_PATH }, filed);
		view.editor = tab as never;
		plugin.app.workspace.leaves.push(new WorkspaceLeaf(view));

		await undoBy(button);

		expect(tab.getValue()).toBe(BEFORE);
	});

	// If wrong: the record misses the heading, as the text before the heading had one more `\r` than the note did.
	it("records the blank lines and the heading it wrote, and the text is all \\r\\n", async () => {
		const { plugin } = await startMigration({ collections: [], log: DONE_LOG, extraNotes: { [PARTY_PATH]: BEFORE } });
		const button = await fileWithHeading(plugin, new FakeEditor(DONE_LOG, 2));
		const filed = await read(plugin, PARTY_PATH);
		expect(filed.startsWith(`${BEFORE}\r\n\r\n## ${layout.completedTasksHeading}\r\n\r\n- [x] Order more tea`), JSON.stringify(filed)).toBe(true);
		expect(allWindows(filed)).toBe(true);
		const last = filed.split("\n").pop() ?? "";
		const marker = readMarker(last);
		expect(marker?.added, JSON.stringify(last)).toEqual({ above: "bhb", below: "", under: headingKey(`## ${layout.completedTasksHeading}`) });

		await undoBy(button);
		// If wrong: the note comes back ending `- [ ] Bring chairs\r`.
		expect(await read(plugin, PARTY_PATH)).toBe(BEFORE);
		const found = readFiled(filed, marker?.id ?? "", marker?.hash ?? "", "");
		expect(found.ok).toBe(true);
	});
});
