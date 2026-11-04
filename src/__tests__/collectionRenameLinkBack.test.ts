/**
 * Renaming the note a task was filed from keeps the link back on the collection's
 * copy true (#991, against
 * #981; spec #980 story 16 and decision 3, #906). Since #981 a collection's copy
 * ends in a link to any ordinary note it was filed from — the mirror of the frozen
 * line's link — and Obsidian's own link-updating may be off (#982 exists for the
 * other side of the same pair).
 *
 * Every filing here runs through the real Migration feature (`migrationHarness.ts`),
 * so the line the rename has to recognise is the one filing writes; the rename runs
 * through `watchCollectionRenames`, wired on the same plugin stub with the arguments
 * `main.ts` passes. Obsidian's own link-updating is off unless a test says it is on:
 * the stub's `vault.fire("rename")` moves nothing, so nothing but the core's rewrite
 * touches the collection. Every note, folder, name and task is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, TFile, Vault as ObsidianVault } from "obsidian";
import { Menu, Notice } from "./__mocks__/obsidian";
import type { Plugin } from "./__mocks__/obsidian";
import { noteCachesFrom } from "../core/collections";
import { collectionRenameResolvers, watchCollectionRenames } from "../core/collectionRename";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { UNDO_ENTRY_TITLE } from "../features/migration/menu";
import { FakeEditor, SHED, installMigrationHooks, lastChooser, read, startMigration } from "./migrationHarness";
import { pressLineAwayFromCursor } from "./editorMenu";

installMigrationHooks();

const MEETING_PATH = "Meetings/Lantern committee.md";
const RENAMED_PATH = "Meetings/Harbour board.md";
const OAR_LINE = 5;
const OARS = "- [ ] Varnish the spare oars, see [[Lantern committee#Decisions]]";
const MEETING = ["# Lantern committee", "", "Present: [[Ada Fenwick]]", "", "## Decisions and actions", OARS, ""].join("\n");

beforeEach(() => {
	Notice.messages.length = 0;
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** Files the oars task from the meeting note into Garden shed, and hands back what filing wrote. */
async function filed(linkSettings: { useMarkdownLinks?: boolean; newLinkFormat?: "shortest" | "relative" | "absolute" } = {}) {
	const { plugin } = await startMigration({ extraNotes: { [MEETING_PATH]: MEETING }, linkSettings });
	const editor = new FakeEditor(MEETING, OAR_LINE);
	const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:file-task`);
	(command as unknown as { editorCheckCallback: (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } }) => void }).editorCheckCallback(false, editor, {
		file: { path: MEETING_PATH },
	});
	await lastChooser().chooseAt("Garden shed", 0);
	await vi.waitFor(() => expect(Notice.messages).toContain("Put this task in Garden shed."));
	const collection = await read(plugin, SHED.path);
	return { plugin, meeting: editor.getValue(), collection };
}

function collectionCache(): unknown {
	const at = { line: 2, col: 0, offset: 0 };
	return { headings: [{ heading: "Tasks", level: 2, position: { start: at, end: at } }] };
}

/** Wires the rename watcher the way `main.ts` does, on a plugin that has already filed. */
function watch(plugin: Plugin, excludedFolders: string[] = []): { problems: Problems } {
	const app = plugin.app as unknown as ObsidianApp;
	const layout: VaultLayout = { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD", excludedFolders };
	const writer = new NoteWriter(app.vault as unknown as ObsidianVault, { path: () => null, onChange: () => undefined });
	const { resolveBareLink, nameIsShared } = collectionRenameResolvers(app);
	const problems = new Problems();
	watchCollectionRenames(noteCachesFrom(plugin as unknown as ObsidianPlugin), () => layout, writer, problems.forFeature("core", "Effortless"), resolveBareLink, nameIsShared);
	return { problems };
}

/** Moves the note in the stub vault and fires Obsidian's rename event for it, with the link index still naming the old path, as Obsidian's does. */
async function rename(plugin: Plugin, from: string, to: string, contents: Record<string, string>): Promise<void> {
	const vault = plugin.app.vault;
	const held = vault.readableContents();
	held?.delete(from);
	for (const [path, text] of Object.entries(contents)) held?.set(path, text);
	vault.files = vault.files.map((file) => (file.path === from ? { path: to } : file));
	vault.fire("rename", { path: to } as unknown as TFile, from);
	for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

/** Marks Garden shed a collection and says it links to `path`, as Obsidian's link index does once it has parsed the note. */
function shedLinksTo(plugin: Plugin, path: string): void {
	plugin.app.metadataCache.caches.set(SHED.path, collectionCache());
	plugin.app.metadataCache.resolvedLinks = { [SHED.path]: { [path]: 1 } };
}

describe("renaming the note a task was filed from", () => {
	it("makes the link back on the collection's copy name the new note, and changes nothing else on the line or in the collection", async () => {
		const { plugin, meeting, collection } = await filed();
		expect(collection, "filing wrote no link back, so the test cannot fail").toContain("[[Lantern committee]] %% migration:");
		shedLinksTo(plugin, MEETING_PATH);
		watch(plugin);

		await rename(plugin, MEETING_PATH, RENAMED_PATH, { [RENAMED_PATH]: meeting });

		// If wrong the old name stays: the line still ends `[[Lantern committee]] %% migration:…`.
		const expected = collection.replace("[[Lantern committee]] %% migration:", "[[Harbour board]] %% migration:");
		expect(expected).not.toBe(collection);
		expect(await read(plugin, SHED.path)).toBe(expected);
	});

	it("leaves a link of the person's own to the note byte for byte, on the same line and on another line of the collection", async () => {
		const { plugin, meeting, collection } = await filed();
		const own = "- [ ] Read the minutes in [[Lantern committee]] again %% ask Ada %%";
		const withOwn = collection.replace("\n## Notes", `\n${own}\n\n## Notes`);
		expect(withOwn).not.toBe(collection);
		plugin.app.vault.readableContents()?.set(SHED.path, withOwn);
		shedLinksTo(plugin, MEETING_PATH);
		watch(plugin);

		await rename(plugin, MEETING_PATH, RENAMED_PATH, { [RENAMED_PATH]: meeting });

		// If wrong (every link naming the old note rewritten) the person's own links read `[[Harbour board]]`.
		const after = await read(plugin, SHED.path);
		expect(after).toBe(withOwn.replace("[[Lantern committee]] %% migration:", "[[Harbour board]] %% migration:"));
		expect(after).toContain(own);
		expect(after).toContain("see [[Lantern committee#Decisions]]");
	});

	it("leaves exactly one link back naming the new note, and writes nothing, when Obsidian's own link-updating already rewrote it", async () => {
		const { plugin, meeting, collection } = await filed();
		const updated = collection.replace("[[Lantern committee]] %% migration:", "[[Harbour board]] %% migration:");
		plugin.app.vault.readableContents()?.set(SHED.path, updated);
		shedLinksTo(plugin, MEETING_PATH);
		watch(plugin);
		const writes = vi.spyOn(plugin.app.vault, "process");

		await rename(plugin, MEETING_PATH, RENAMED_PATH, { [RENAMED_PATH]: meeting });

		// If wrong the link is rewritten again or a second link is added, and the count or the text below differs.
		const after = await read(plugin, SHED.path);
		expect(after).toBe(updated);
		expect(after.match(/\[\[Harbour board\]\]/gu)).toHaveLength(1);
		expect(writes.mock.calls.filter(([file]) => (file as { path: string }).path === SHED.path)).toHaveLength(0);
	});

	it("follows a second rename of the same note while the link index still names nothing", async () => {
		const { plugin, meeting, collection } = await filed();
		shedLinksTo(plugin, MEETING_PATH);
		watch(plugin);
		await rename(plugin, MEETING_PATH, RENAMED_PATH, { [RENAMED_PATH]: meeting });
		expect(await read(plugin, SHED.path)).toContain("[[Harbour board]] %% migration:");

		// Obsidian has not re-resolved anything since: the index names no link to either path.
		plugin.app.metadataCache.resolvedLinks = {};
		await rename(plugin, RENAMED_PATH, "Meetings/Quay review.md", { "Meetings/Quay review.md": meeting });

		// If wrong (no memory of the first rewrite) the line stays `[[Harbour board]]`, a note that no longer exists.
		expect(await read(plugin, SHED.path)).toBe(collection.replace("[[Lantern committee]] %% migration:", "[[Quay review]] %% migration:"));
	});

	it("writes a markdown link back in the markdown shape, the text following the name", async () => {
		const { plugin, meeting, collection } = await filed({ useMarkdownLinks: true });
		expect(collection, "filing wrote no markdown link back, so the test cannot fail").toContain("[Lantern committee](Lantern%20committee.md) %% migration:");
		shedLinksTo(plugin, MEETING_PATH);
		watch(plugin);

		await rename(plugin, MEETING_PATH, RENAMED_PATH, { [RENAMED_PATH]: meeting });

		// If wrong the old name stays in the text or the destination.
		expect(await read(plugin, SHED.path)).toBe(collection.replace("[Lantern committee](Lantern%20committee.md) %% migration:", "[Harbour board](Harbour%20board.md) %% migration:"));
	});

	it("writes a link back that reaches the note from the collection's folder when the vault's links are relative", async () => {
		const { plugin, meeting, collection } = await filed({ newLinkFormat: "relative" });
		expect(collection, "filing wrote no relative link back, so the test cannot fail").toContain("[[../Meetings/Lantern committee]] %% migration:");
		shedLinksTo(plugin, MEETING_PATH);
		watch(plugin);

		await rename(plugin, MEETING_PATH, "Archive/Harbour board.md", { "Archive/Harbour board.md": meeting });

		// If wrong the line keeps `../Meetings/Lantern committee`, or names `Harbour board` from the wrong folder.
		expect(await read(plugin, SHED.path)).toBe(collection.replace("[[../Meetings/Lantern committee]] %% migration:", "[[../Archive/Harbour board]] %% migration:"));
	});

	it("skips a collection's copy under an excluded folder, and reports nothing for it", async () => {
		const { plugin, meeting, collection } = await filed();
		shedLinksTo(plugin, MEETING_PATH);
		const { problems } = watch(plugin, ["Projects"]);

		await rename(plugin, MEETING_PATH, RENAMED_PATH, { [RENAMED_PATH]: meeting });

		// If wrong (excluded folders not asked) the line names the new note.
		expect(await read(plugin, SHED.path)).toBe(collection);
		expect(problems.all()).toEqual([]);
	});

	it("writes nothing, and opens no collection, for a rename of a note no collection links back to", async () => {
		const { plugin, collection } = await filed();
		const other = "Reading/Ships.md";
		const vault = plugin.app.vault;
		vault.files = [...vault.files, { path: other }];
		vault.readableContents()?.set(other, "# Ships\n\nWords.\n");
		// Garden shed links to the meeting note, not to the renamed one; a day's log links to the renamed one.
		plugin.app.metadataCache.caches.set(SHED.path, collectionCache());
		plugin.app.metadataCache.resolvedLinks = { [SHED.path]: { [MEETING_PATH]: 1 }, "Journal/2031-04-05.md": { [other]: 1 } };
		watch(plugin);
		const writes = vi.spyOn(vault, "process");
		const reads = vi.spyOn(vault, "read");
		const cachedReads = vi.spyOn(vault, "cachedRead");

		await rename(plugin, other, "Reading/Vessels.md", { "Reading/Vessels.md": "# Ships\n\nWords.\n" });

		// If wrong (a rename that reads or rewrites what it was not asked about) a spy below sees a call.
		expect(writes).not.toHaveBeenCalled();
		expect(reads).not.toHaveBeenCalled();
		expect(cachedReads).not.toHaveBeenCalled();
		expect(await read(plugin, SHED.path)).toBe(collection);
	});

	it("leaves a collection that links to the note in plain words alone, reading it but writing nothing", async () => {
		const { plugin, meeting } = await filed();
		const plain = "# Garden shed\n\n## Tasks\n\n- [ ] Ask about [[Lantern committee]]\n\n## Notes\n\nWords.\n";
		plugin.app.vault.readableContents()?.set(SHED.path, plain);
		shedLinksTo(plugin, MEETING_PATH);
		watch(plugin);
		const writes = vi.spyOn(plugin.app.vault, "process");

		await rename(plugin, MEETING_PATH, RENAMED_PATH, { [RENAMED_PATH]: meeting });

		// If wrong (any link to the note rewritten) the plain link reads `[[Harbour board]]`.
		expect(await read(plugin, SHED.path)).toBe(plain);
		expect(writes).not.toHaveBeenCalled();
	});
});

describe("filing, renaming the note, then undoing from the renamed note (#991 × #981 × #982)", () => {
	it("still finds the collection's copy and removes it, and gives the note back as it was", async () => {
		const { plugin, meeting, collection } = await filed();
		shedLinksTo(plugin, MEETING_PATH);
		watch(plugin);
		await rename(plugin, MEETING_PATH, RENAMED_PATH, { [RENAMED_PATH]: meeting });
		expect(await read(plugin, SHED.path), "the rename rewrote nothing, so the composition is not exercised").toContain("[[Harbour board]] %% migration:");
		const before = plugin.app.vault.readableContents()?.get(SHED.path);
		expect(before).toBeDefined();

		const frozen = new FakeEditor(meeting, meeting.split("\n").findIndex((each) => each.startsWith("- [>]")));
		const menu = new Menu();
		pressLineAwayFromCursor(frozen, frozen.getCursor().line);
		plugin.app.workspace.fire("editor-menu", menu, frozen, { file: { path: RENAMED_PATH } });
		Notice.messages.length = 0;
		menu.items.find((each) => each.title === UNDO_ENTRY_TITLE)?.click();
		await vi.waitFor(() => expect(Notice.messages.length).toBeGreaterThan(0));

		// If wrong the copy stays in Garden shed (the rename's rewrite damaged the rest of the copy's line, or left a copy undo can no longer find), or the notice says the task was changed. Undo strips the appended link before it compares, so the renamed link back itself cannot make it fail.
		expect(Notice.messages[Notice.messages.length - 1]).toBe("Undone. The task is back in the note and no longer in Garden shed.");
		const restored = await read(plugin, SHED.path);
		expect(restored).not.toContain("Varnish the spare oars");
		expect(restored).toBe(collection.split("\n").filter((line) => !line.includes("Varnish the spare oars")).join("\n"));
		expect(frozen.getValue()).toBe(MEETING);
	});
});
