/**
 * Undo finds the collection through the link, as the jump does
 * (#880, found against
 * #862): Obsidian rewrites a
 * `[[Garden shed]]` link to a path when the collection is moved or renamed, or
 * when the bare name becomes ambiguous, so comparing the link's text with the
 * collection's name alone refuses an undo whose task is right there. Every
 * folder, name and task is invented.
 */

import { describe, expect, it, vi } from "vitest";
import { Menu, Notice } from "./__mocks__/obsidian";
import { FakeEditor, LOG, LOG_PATH, installMigrationHooks, lastChooser, read, startMigration } from "./migrationHarness";
import { pressLineAwayFromCursor } from "./editorMenu";

installMigrationHooks();

const SHED_PATH = "Projects/Garden shed.md";

type CheckCallback = (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } | null }) => boolean | void;

describe("undoing through the right-click entry when the frozen line's link is a path", () => {
	it("finds the collection Obsidian resolves the link to, and undoes", async () => {
		const { plugin } = await startMigration({ log: LOG });
		// Obsidian's index knows the collection, so a path link resolves to it.
		plugin.app.metadataCache.caches.set(SHED_PATH, {});
		const collectionBefore = await read(plugin, SHED_PATH);
		const editor = new FakeEditor(LOG, 2);
		const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:file-task`);
		(command as unknown as { editorCheckCallback: CheckCallback }).editorCheckCallback(false, editor, { file: { path: LOG_PATH } });
		await lastChooser().chooseAt("shed", 0);
		await vi.waitFor(() => expect(Notice.messages.length).toBeGreaterThan(0));

		// Filed: the frozen line names the collection by its name. Obsidian then rewrites it as a path.
		expect(editor.getValue()).toContain("[[Garden shed]]");
		editor.setLine(2, editor.getLine(2).replace("[[Garden shed]]", "[[Projects/Garden shed]]"));
		expect(editor.getValue()).toContain("[[Projects/Garden shed]]");
		expect(await read(plugin, SHED_PATH)).not.toBe(collectionBefore);

		const menu = new Menu();
		pressLineAwayFromCursor(editor, editor.getCursor().line);
		plugin.app.workspace.fire("editor-menu", menu, editor, { file: { path: LOG_PATH } });
		menu.items.find((each) => each.title === "Undo migration")?.click();
		await vi.waitFor(() => expect(Notice.messages.some((each) => each.startsWith("Undone") || each.includes("nothing was undone"))).toBe(true));

		// The notice names the collection by its note name, as the filing notice does, not by the path
		// the link spells: the brief for this wave's fixes to #871 settled it, so this line no longer says "Projects/Garden shed".
		expect(Notice.messages[Notice.messages.length - 1]).toBe("Undone. The task is back in the day's log and no longer in Garden shed.");
		expect(editor.getValue()).toBe(LOG);
		expect(await read(plugin, SHED_PATH)).toBe(collectionBefore);
	});
});
