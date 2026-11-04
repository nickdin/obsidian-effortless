/**
 * Two tickets meet here: #981 files a task from a note that is not a day's log
 * and freezes its line there, and #982 widens the core's collection-rename
 * rewrite to every note that links to the renamed collection. Each has its own
 * tests; this one runs both together, so the frozen line #981 writes is the one
 * #982's rewrite has to recognise. Spec #980, decision 3.
 *
 * The filing runs through the real Migration feature (`migrationHarness.ts`);
 * the rename through `watchCollectionRenames`, wired on the same plugin stub
 * with the same arguments `main.ts` passes, except that the layout is built
 * here rather than read from the settings store. Every folder, name and task is invented.
 */

import { describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, TFile, Vault as ObsidianVault } from "obsidian";
import { Notice } from "./__mocks__/obsidian";
import { noteCachesFrom } from "../core/collections";
import { collectionRenameResolvers, watchCollectionRenames } from "../core/collectionRename";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { defaultData } from "../core/settings";
import { FakeEditor, SHED, installMigrationHooks, lastChooser, read, startMigration } from "./migrationHarness";

installMigrationHooks();

const MEETING_PATH = "Meetings/Lantern committee.md";
const RENAMED_PATH = "Projects/Boat shed.md";
const OAR_LINE = 5;
const MEETING = ["# Lantern committee", "", "Present: [[Ada Fenwick]]", "", "## Decisions and actions", "- [ ] Varnish the spare oars", ""].join("\n");

describe("filing from an ordinary note, then renaming the collection (#981 × #982)", () => {
	it("rewrites the frozen line the filing wrote in the ordinary note to name the renamed collection", async () => {
		const { plugin } = await startMigration({ extraNotes: { [MEETING_PATH]: MEETING } });
		const editor = new FakeEditor(MEETING, OAR_LINE);
		const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:file-task`);
		(command as unknown as { editorCheckCallback: (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } }) => void }).editorCheckCallback(false, editor, {
			file: { path: MEETING_PATH },
		});
		await lastChooser().chooseAt("Garden shed", 0);
		await vi.waitFor(() => expect(Notice.messages).toContain("Put this task in Garden shed."));
		const filed = editor.getValue();
		expect(filed.split("\n")[OAR_LINE]).toMatch(/^- \[>\] Varnish the spare oars .*\[\[Garden shed\]\]/u);

		// The editor closes; the note on disk now holds what the filing wrote. The collection is
		// renamed with Obsidian's own link updating off, so nothing but the core's rewrite
		// touches the meeting note.
		const vault = plugin.app.vault;
		const collection = await read(plugin, SHED.path);
		vault.files = [{ path: MEETING_PATH }, { path: RENAMED_PATH }];
		vault.allowReads({ [MEETING_PATH]: filed, [RENAMED_PATH]: collection });
		const heading = { start: { line: 2, col: 0, offset: 0 }, end: { line: 2, col: 0, offset: 0 } };
		plugin.app.metadataCache.caches.set(RENAMED_PATH, { headings: [{ heading: "Tasks", level: 2, position: heading }] });
		plugin.app.metadataCache.resolvedLinks = { [MEETING_PATH]: { [SHED.path]: 1 } };
		const app = plugin.app as unknown as ObsidianApp;
		const writer = new NoteWriter(app.vault as unknown as ObsidianVault, { path: () => null, onChange: () => undefined });
		const { resolveBareLink, nameIsShared } = collectionRenameResolvers(app);
		const layout = { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
		watchCollectionRenames(noteCachesFrom(plugin as unknown as ObsidianPlugin), () => layout, writer, new Problems().forFeature("core", "Effortless"), resolveBareLink, nameIsShared);

		vault.fire("rename", { path: RENAMED_PATH } as unknown as TFile, SHED.path);

		// Wrong in either ticket — a rewrite that gathers day's logs only, or a frozen line
		// shaped so the rewrite does not recognise it — leaves `[[Garden shed]]` here.
		const expected = filed.replace("[[Garden shed]]", "[[Boat shed]]");
		expect(expected).not.toBe(filed);
		await vi.waitFor(async () => expect(await vault.cachedRead({ path: MEETING_PATH })).toBe(expected));
	});
});
