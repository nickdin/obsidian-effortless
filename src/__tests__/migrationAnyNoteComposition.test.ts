/**
 * Three modules meet here: #981 files a task from a note that is not a day's log
 * and freezes its line there, #982's rewrite in the core follows a collection's
 * rename into that line, and #983's undo puts the task back from it. Each has its
 * own tests; this one runs all three in order, so the frozen line #981 wrote and
 * #982 rewrote is the one #983's entry recognises and whose link its undo follows
 * to the renamed collection. Spec #980, decisions 3 and 4. It does not repeat
 * `migrationAnyNoteRenameComposition.test.ts`, which stops after the rename.
 *
 * The rename goes through `watchCollectionRenames` as that file wires it, with
 * Obsidian's own link updating off, so only the core's rewrite touches the note.
 * Every folder, name and task is invented.
 */

import { describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, TFile, Vault as ObsidianVault } from "obsidian";
import { Menu, Notice } from "./__mocks__/obsidian";
import { noteCachesFrom } from "../core/collections";
import { collectionRenameResolvers, watchCollectionRenames } from "../core/collectionRename";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { defaultData } from "../core/settings";
import { UNDO_ENTRY_TITLE } from "../features/migration/menu";
import { FakeEditor, LOG, LOG_PATH, SHED, installMigrationHooks, lastChooser, read, startMigration } from "./migrationHarness";
import { pressLineAwayFromCursor } from "./editorMenu";

installMigrationHooks();

const MEETING_PATH = "Meetings/Lantern committee.md";
const RENAMED_PATH = "Projects/Boat shed.md";
const OAR_LINE = 5;
const MEETING = ["# Lantern committee", "", "Present: [[Ada Fenwick]]", "", "## Decisions and actions", "- [ ] Varnish the spare oars", ""].join("\n");

describe("filing from an ordinary note, renaming the collection, then undoing (#981 × #982 × #983)", () => {
	// If wrong: the undo restores nothing where any of the three fails. A frozen line #982 did not
	// rewrite still names Garden shed, which is no longer there, so the undo reports the task gone
	// and the meeting note stays frozen. An undo that wrote the day's log changes its bytes. An
	// undo that left the collection's copy leaves the oars in the renamed collection.
	it("puts the task back in the meeting note, out of the renamed collection, and leaves the day's log as it was", async () => {
		const { plugin } = await startMigration({ extraNotes: { [MEETING_PATH]: MEETING }, obsidianLinks: true });
		const filing = new FakeEditor(MEETING, OAR_LINE);
		const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:file-task`);
		(command as unknown as { editorCheckCallback: (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } }) => void }).editorCheckCallback(false, filing, {
			file: { path: MEETING_PATH },
		});
		await lastChooser().chooseAt("Garden shed", 0);
		await vi.waitFor(() => expect(Notice.messages).toContain("Put this task in Garden shed."));
		const filed = filing.getValue();
		const collection = await read(plugin, SHED.path);
		expect(collection, "filing put nothing in the collection, so the test cannot fail").toContain("Varnish the spare oars");

		// The collection is renamed; the meeting note is in no tab, so only the core's rewrite reaches it.
		const vault = plugin.app.vault;
		vault.files = [{ path: LOG_PATH }, { path: MEETING_PATH }, { path: RENAMED_PATH }];
		vault.allowReads({ [LOG_PATH]: LOG, [MEETING_PATH]: filed, [RENAMED_PATH]: collection });
		const heading = { start: { line: 2, col: 0, offset: 0 }, end: { line: 2, col: 0, offset: 0 } };
		plugin.app.metadataCache.caches.set(RENAMED_PATH, { headings: [{ heading: "Tasks", level: 2, position: heading }] });
		plugin.app.metadataCache.resolvedLinks = { [MEETING_PATH]: { [SHED.path]: 1 } };
		const app = plugin.app as unknown as ObsidianApp;
		const writer = new NoteWriter(app.vault as unknown as ObsidianVault, { path: () => null, onChange: () => undefined });
		const { resolveBareLink, nameIsShared } = collectionRenameResolvers(app);
		const layout = { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
		watchCollectionRenames(noteCachesFrom(plugin as unknown as ObsidianPlugin), () => layout, writer, new Problems().forFeature("core", "Effortless"), resolveBareLink, nameIsShared);
		vault.fire("rename", { path: RENAMED_PATH } as unknown as TFile, SHED.path);
		const renamed = filed.replace("[[Garden shed]]", "[[Boat shed]]");
		await vi.waitFor(async () => expect(await vault.cachedRead({ path: MEETING_PATH })).toBe(renamed));

		// The meeting note is opened again and its frozen line right-clicked; the entry is chosen.
		const editor = new FakeEditor(renamed, renamed.split("\n").findIndex((each) => each.startsWith("- [>]")));
		const menu = new Menu();
		pressLineAwayFromCursor(editor, editor.getCursor().line);
		plugin.app.workspace.fire("editor-menu", menu, editor, { file: { path: MEETING_PATH } });
		const undo = menu.items.find((each) => each.title === UNDO_ENTRY_TITLE);
		expect(undo, "the undo entry was not offered on the rewritten frozen line").toBeDefined();
		undo?.click();
		await vi.waitFor(() => expect(Notice.messages.some((each) => each.startsWith("Undone"))).toBe(true));

		expect(Notice.messages).toContain("Undone. The task is back in the note and no longer in Boat shed.");
		expect(editor.getValue()).toBe(MEETING);
		expect(await vault.cachedRead({ path: RENAMED_PATH })).not.toContain("Varnish the spare oars");
		expect(await vault.cachedRead({ path: LOG_PATH })).toBe(LOG);
	});
});
