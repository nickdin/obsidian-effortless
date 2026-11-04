/**
 * Two defects the review of wave 2 found in the link-back rename of
 * #991:
 * #1006 — a second rename
 * lost while the collection is open — and
 * #1007 /
 * #1008 — the folder
 * dropped from a link back in a vault whose new links are absolute paths.
 *
 * Filing runs through the real Migration feature (`migrationHarness.ts`), so the
 * line the rename has to recognise is the one filing writes; the rename runs
 * through `watchCollectionRenames`, wired the way `main.ts` wires it. The stub's
 * `vault.fire("rename")` moves nothing, so nothing but the core's rewrite touches
 * the collection. Every note, folder, name and task is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, TFile, Vault as ObsidianVault } from "obsidian";
import { Notice } from "./__mocks__/obsidian";
import type { Plugin } from "./__mocks__/obsidian";
import { noteCachesFrom } from "../core/collections";
import { collectionRenameResolvers, watchCollectionRenames } from "../core/collectionRename";
import { NoteWriter } from "../core/noteWriter";
import type { OpenNote } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { FakeEditor, SHED, installMigrationHooks, lastChooser, read, startMigration } from "./migrationHarness";

installMigrationHooks();

const MEETING_PATH = "Meetings/Lantern committee.md";
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

/** A note on screen the test can change, the way `openNoteFromWorkspace` reports the workspace's. */
function screen(initial: string | null): OpenNote & { show(path: string | null): void } {
	let current = initial;
	const listeners: Array<() => void> = [];
	return {
		path: () => current,
		onChange: (listener) => void listeners.push(listener),
		show(path) {
			current = path;
			for (const listener of listeners) listener();
		},
	};
}

/** Wires the rename watcher the way `main.ts` does, on a plugin that has already filed. */
function watch(plugin: Plugin, openNote: OpenNote = { path: () => null, onChange: () => undefined }): { problems: Problems } {
	const app = plugin.app as unknown as ObsidianApp;
	const layout: VaultLayout = { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
	const writer = new NoteWriter(app.vault as unknown as ObsidianVault, openNote);
	const { resolveBareLink, nameIsShared } = collectionRenameResolvers(app);
	const problems = new Problems();
	watchCollectionRenames(noteCachesFrom(plugin as unknown as ObsidianPlugin), () => layout, writer, problems.forFeature("core", "Effortless"), resolveBareLink, nameIsShared, app.fileManager);
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

describe("a second rename while the collection is open", () => {
	it("ends naming the note's last name when the first rename's edit is still held", async () => {
		const { plugin, meeting, collection } = await filed();
		shedLinksTo(plugin, MEETING_PATH);
		const onScreen = screen(SHED.path);
		watch(plugin, onScreen);

		await rename(plugin, MEETING_PATH, "Meetings/Harbour board.md", { "Meetings/Harbour board.md": meeting });
		// The collection is on screen, so the first edit is held: the file still names the first name.
		expect(await read(plugin, SHED.path)).toContain("[[Lantern committee]] %% migration:");
		plugin.app.metadataCache.resolvedLinks = {};
		await rename(plugin, "Meetings/Harbour board.md", "Meetings/Quay review.md", { "Meetings/Quay review.md": meeting });

		onScreen.show("Reading/Ships.md");
		// If wrong (the second rename found nothing to change because the first edit was still held) the line ends `[[Harbour board]]`, a note that no longer exists.
		await vi.waitFor(async () =>
			expect(await read(plugin, SHED.path)).toBe(collection.replace("[[Lantern committee]] %% migration:", "[[Quay review]] %% migration:")),
		);
	});
});

describe("a link back written as an absolute path keeps its folder", () => {
	const RENAMED = "Meetings/Harbour board.md";
	const MOVED = "Archive/2026/Harbour board.md";

	async function renamedTo(to: string, linkSettings: Parameters<typeof filed>[0]) {
		const { plugin, meeting, collection } = await filed(linkSettings);
		shedLinksTo(plugin, MEETING_PATH);
		watch(plugin);
		await rename(plugin, MEETING_PATH, to, { [to]: meeting });
		return { collection, after: await read(plugin, SHED.path) };
	}

	it("names the folder still, in a wikilink, when the note is only renamed", async () => {
		const settings = { newLinkFormat: "absolute" } as const;
		const { collection, after } = await renamedTo(RENAMED, settings);
		expect(collection, "filing wrote no folder in the link back, so the test cannot fail").toContain("[[Meetings/Lantern committee]] %% migration:");
		// If wrong the folder is dropped and the line ends `[[Harbour board]] %% migration:`.
		expect(after).toBe(collection.replace("[[Meetings/Lantern committee]] %% migration:", "[[Meetings/Harbour board]] %% migration:"));
	});

	it("names the new folder, in a wikilink, when the note is moved and renamed", async () => {
		const { collection, after } = await renamedTo(MOVED, { newLinkFormat: "absolute" });
		// If wrong the link is cut to the last folder or two, `[[2026/Harbour board]]`, or loses them all.
		expect(after).toBe(collection.replace("[[Meetings/Lantern committee]] %% migration:", "[[Archive/2026/Harbour board]] %% migration:"));
	});

	it("names the folder still, in a markdown link, when the note is only renamed", async () => {
		const { collection, after } = await renamedTo(RENAMED, { useMarkdownLinks: true, newLinkFormat: "absolute" });
		expect(collection, "filing wrote no folder in the markdown link back, so the test cannot fail").toContain("[Lantern committee](Meetings/Lantern%20committee.md) %% migration:");
		expect(after).toBe(collection.replace("[Lantern committee](Meetings/Lantern%20committee.md) %% migration:", "[Harbour board](Meetings/Harbour%20board.md) %% migration:"));
	});

	it("names the new folder, in a markdown link, when the note is moved into deeper folders", async () => {
		const { collection, after } = await renamedTo(MOVED, { useMarkdownLinks: true, newLinkFormat: "absolute" });
		// If wrong the path keeps only the old depth, `2026/Harbour%20board.md`, which is not an absolute path.
		expect(after).toBe(collection.replace("[Lantern committee](Meetings/Lantern%20committee.md) %% migration:", "[Harbour board](Archive/2026/Harbour%20board.md) %% migration:"));
	});
});

describe("a frozen line's link in a vault of absolute paths keeps its folder after a name change", () => {
	it("keeps the folder of a wikilink to the renamed collection", async () => {
		const { plugin } = await startMigration({ linkSettings: { newLinkFormat: "absolute" } });
		const log = "Journal/2026-01-05.md";
		const frozen = "- [>] Sweep the floor [[Projects/Garden shed]] %% migration:abcd1234 ef567890 _ %%";
		const vault = plugin.app.vault;
		vault.files = [...vault.files, { path: log }];
		vault.readableContents()?.set(log, ["# Journal", "", frozen, ""].join("\n"));
		plugin.app.metadataCache.caches.set("Projects/Yard shed.md", collectionCache());
		plugin.app.metadataCache.resolvedLinks = { [log]: { [SHED.path]: 1 } };
		watch(plugin);

		await rename(plugin, SHED.path, "Projects/Yard shed.md", { "Projects/Yard shed.md": "# Yard shed\n\n## Tasks\n" });

		// If wrong the folder is dropped and the line reads `[[Yard shed]]`.
		expect(await read(plugin, log)).toBe(["# Journal", "", frozen.replace("[[Projects/Garden shed]]", "[[Projects/Yard shed]]"), ""].join("\n"));
	});
});
