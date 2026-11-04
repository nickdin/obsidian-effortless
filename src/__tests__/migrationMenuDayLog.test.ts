/**
 * The filing entry in a day's log: offered only on a
 * line the command could file, the rule ordinary notes follow. Over the shared
 * harness's real registry and note writer. Every press lands on a line **other
 * than the cursor's**, so a check that read the cursor's line would fail each
 * test. Every folder, name and task is invented.
 */

import { describe, expect, it, vi } from "vitest";
import { Menu, Notice } from "./__mocks__/obsidian";
import type { Plugin } from "./__mocks__/obsidian";
import { FILE_ENTRY_TITLE, JUMP_ENTRY_TITLE, UNDO_ENTRY_TITLE } from "../features/migration/menu";
import { FakeEditor, LOG_PATH, SHED, installMigrationHooks, lastChooser, read, startMigration } from "./migrationHarness";

installMigrationHooks();

const FROZEN = "- [>] Sweep the porch [[Garden shed]] %% migration:mueqhd82nrew 5548e9c2 %%";

// Line 0 heading, 2 an open task, 3 a plain bullet, 4 a frozen line, 7 a task under Today.
const LOG = ["# Notes", "", "- [ ] Order more tea", "- Just a thought", FROZEN, "", "## Today", "- [ ] Water the plants", ""].join("\n");

/** Right-clicks `pressed` while the cursor sits on `cursor`; Obsidian has not moved the cursor when `editor-menu` fires. */
function press(plugin: Plugin, editor: FakeEditor, pressed: number): Menu {
	Object.assign(editor, { pressedLine: pressed });
	const menu = new Menu();
	plugin.app.workspace.fire("editor-menu", menu, editor, { file: { path: LOG_PATH } });
	return menu;
}

describe("the filing entry in a day's log", () => {
	it("is not offered on a plain bullet under the notes heading, the cursor being on the open task", async () => {
		// Wrong code (place only, as #860 had it) would list the entry here; a check of the cursor's line would list it too, the cursor being on a task.
		const { plugin } = await startMigration({ log: LOG });

		const menu = press(plugin, new FakeEditor(LOG, 2), 3);

		expect(menu.items.map((item) => item.title)).toEqual([]);
	});

	it("is not offered on a frozen line, which still offers jump and undo, the cursor being on the open task", async () => {
		const { plugin } = await startMigration({ log: LOG });

		const menu = press(plugin, new FakeEditor(LOG, 2), 4);

		expect(menu.items.map((item) => item.title)).toEqual([JUMP_ENTRY_TITLE, UNDO_ENTRY_TITLE]);
	});

	it("is offered on an open task under the notes heading, the cursor being on the plain bullet", async () => {
		// A menu that dropped the entry everywhere, or read the cursor's line (a bullet), would list nothing.
		const { plugin } = await startMigration({ log: LOG });

		const menu = press(plugin, new FakeEditor(LOG, 3), 2);

		expect(menu.items.map((item) => item.title)).toEqual([FILE_ENTRY_TITLE]);
	});

	it("files the task when its entry is chosen: the collection holds it and the log line is frozen", async () => {
		// Wrong code that listed the entry without wiring its click would leave the collection as it was.
		const { plugin } = await startMigration({ log: LOG, collections: [SHED] });
		// By the time the entry is chosen Obsidian has moved the cursor to the pressed line (see menu.ts), so it is on line 2 here.
		const editor = new FakeEditor(LOG, 2);
		const before = await read(plugin, SHED.path);

		press(plugin, editor, 2).items[0].click();
		await lastChooser().chooseAt("shed", 0);
		await vi.waitFor(() => expect(Notice.messages).toContain("Put this task in Garden shed."));

		expect(await read(plugin, SHED.path)).not.toBe(before);
		expect(await read(plugin, SHED.path)).toContain("- [ ] Order more tea");
		expect(editor.getLine(2)).toContain("- [>] Order more tea [[Garden shed]] %% migration:");
	});

	it("is not offered on a task under Today, the cursor being on a task under the notes heading", async () => {
		const { plugin } = await startMigration({ log: LOG });

		const menu = press(plugin, new FakeEditor(LOG, 2), 7);

		expect(menu.items).toEqual([]);
	});
});
