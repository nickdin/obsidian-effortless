/**
 * An undo whose collection half fails after the log's half was written
 * (#876, found against
 * #862): the criterion is
 * "A refused undo leaves both files byte-identical and names the collection".
 * `migrationUndo.test.ts` alters the collection before the undo starts, never
 * between the two writes, so it cannot see this. Here the collection's write is
 * the one thing that goes wrong: it is handed a changed line, or it rejects.
 * Every folder, name and task is invented.
 */

import { describe, expect, it, vi } from "vitest";
import { Menu, Notice } from "./__mocks__/obsidian";
import type { Plugin } from "./__mocks__/obsidian";
import { FakeEditor, LOG, LOG_PATH, installMigrationHooks, lastChooser, read, startMigration } from "./migrationHarness";
import { pressLineAwayFromCursor } from "./editorMenu";

installMigrationHooks();

const SHED_PATH = "Projects/Garden shed.md";

type CheckCallback = (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } | null }) => boolean | void;

/** Files the tea into Garden shed through the command, so the log is on screen and frozen and the collection holds the copy. */
async function filed(): Promise<{ plugin: Plugin; editor: FakeEditor }> {
	const { plugin } = await startMigration({ log: LOG });
	const editor = new FakeEditor(LOG, 2);
	const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:file-task`);
	(command as unknown as { editorCheckCallback: CheckCallback }).editorCheckCallback(false, editor, { file: { path: LOG_PATH } });
	await lastChooser().chooseAt("shed", 0);
	await vi.waitFor(() => expect(Notice.messages.length).toBeGreaterThan(0));
	return { plugin, editor };
}

/** Right-clicks the frozen line, chooses the undo entry and waits for the notice it ends with. */
async function undoThroughTheMenu(plugin: Plugin, editor: FakeEditor): Promise<string> {
	const before = Notice.messages.length;
	const menu = new Menu();
	pressLineAwayFromCursor(editor, editor.getCursor().line);
	plugin.app.workspace.fire("editor-menu", menu, editor, { file: { path: LOG_PATH } });
	menu.items.find((each) => each.title === "Undo migration")?.click();
	await vi.waitFor(() => expect(Notice.messages.length).toBeGreaterThan(before));
	return Notice.messages[Notice.messages.length - 1];
}

describe("an undo whose collection half is refused after the log's half was written", () => {
	// The collection changes between the check and the write: the stub gives the
	// undo's write a text whose copy has been reworded, as a person typing into the
	// collection would. Were the code right, the log is still frozen; the old order
	// leaves it restored, and the task in both notes.
	it("leaves both files as they were and names the collection", async () => {
		const { plugin, editor } = await filed();
		const vault = plugin.app.vault;
		const logBefore = editor.getValue();
		const process = vault.process.bind(vault);
		let reworded = "";
		vi.spyOn(vault, "process").mockImplementation((file, fn) => {
			if (file.path !== SHED_PATH) return process(file, fn);
			const contents = vault.readableContents();
			reworded = (contents?.get(SHED_PATH) ?? "").replace("Order more tea", "Order more coffee");
			contents?.set(SHED_PATH, reworded);
			return process(file, fn);
		});
		expect(logBefore).toContain("[>] Order more tea [[Garden shed]]");

		const said = await undoThroughTheMenu(plugin, editor);

		expect(editor.getValue()).toBe(logBefore);
		expect(await read(plugin, SHED_PATH)).toBe(reworded);
		expect(reworded).toContain("Order more coffee");
		expect(said).toContain("Garden shed");
		expect(said).toContain("nothing was undone");
	});

	it("leaves both files as they were and names the collection when the collection's write rejects", async () => {
		const { plugin, editor } = await filed();
		const vault = plugin.app.vault;
		const logBefore = editor.getValue();
		const collectionBefore = await read(plugin, SHED_PATH);
		const process = vault.process.bind(vault);
		vi.spyOn(vault, "process").mockImplementation((file, fn) => {
			if (file.path === SHED_PATH) return Promise.reject(new Error("the disk is full"));
			return process(file, fn);
		});

		const said = await undoThroughTheMenu(plugin, editor);

		expect(editor.getValue()).toBe(logBefore);
		expect(await read(plugin, SHED_PATH)).toBe(collectionBefore);
		expect(said).toContain("Garden shed");
		expect(said).toContain("nothing was undone");
	});
});

describe("an undo whose collection half fails and whose log half cannot be put back", () => {
	// The person types into the day's log at the moment the collection's write fails,
	// so the line the undo restored is no longer what it wrote and is left alone. The
	// notice then says where the task is: back in the log, and still in the collection.
	it("says the task is back in the day's log and its copy is still in the collection", async () => {
		const { plugin, editor } = await filed();
		const vault = plugin.app.vault;
		const process = vault.process.bind(vault);
		vi.spyOn(vault, "process").mockImplementation((file, fn) => {
			if (file.path !== SHED_PATH) return process(file, fn);
			editor.setLine(2, `${editor.getLine(2)} (typed just now)`);
			return Promise.reject(new Error("the disk is full"));
		});

		const said = await undoThroughTheMenu(plugin, editor);

		expect(editor.getLine(2)).toBe("- [ ] Order more tea (typed just now)");
		expect(await read(plugin, SHED_PATH)).toContain("Order more tea [[2031-04-05]] %% migration:");
		expect(said).toContain("back in the day's log");
		expect(said).toContain("Garden shed");
		expect(said).toContain("Delete it by hand");
	});
});
