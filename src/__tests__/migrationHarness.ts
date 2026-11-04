/**
 * Shared set-up for the tests of choosing where a task goes; not a test file.
 * It starts the real feature registry, the real settings store and the real note
 * writer over the Obsidian stub, so a test runs the command from the palette
 * through the real chooser and the question, #856's `checkFilable` and `fileInto`
 * halves, and reads both notes' whole texts and `data.json` back. Every folder,
 * name and task is invented.
 */

import { afterEach, beforeEach, expect, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, Vault as ObsidianVault } from "obsidian";
import { ConfirmationModal, Notice, Plugin } from "./__mocks__/obsidian";
import type { FuzzySuggestModal as StubFuzzySuggestModal } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collection, Collections } from "../core/collections";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import { CollectionChooser } from "../features/migration/chooser";
import type { ChooserItem } from "../features/migration/chooser";
import { FEATURE_ID, Migration } from "../features/migration";

export const LOG_PATH = "Journal/2031-04-05.md";
export const TEA = "- [ ] Order more tea";
export const GATE = "- [ ] Mend the gate";
export const LOG = ["# Notes", "", TEA, GATE, "", "## Today", "", "- [ ] Water the plants", ""].join("\n");

const TASKS_TEXT = (title: string): string => [`# ${title}`, "", "## Tasks", "", "- [ ] Sweep the floor", "", "## Notes", "", "Words.", ""].join("\n");

export function collectionAt(path: string, name: string): Collection {
	return { path, name, headingLine: 2, headingLevel: 2, openTasks: 1 };
}

export const ATTIC = collectionAt("Projects/Attic.md", "Attic");
export const SHED = collectionAt("Projects/Garden shed.md", "Garden shed");
export const KITCHEN = collectionAt("Projects/Kitchen.md", "Kitchen");

export const PARTY_PATH = "Ideas/Garden party.md";
export const PARTY_TEXT = "# Garden party\n\nBring chairs.\n";

type CheckCallback = (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } | null }) => boolean | void;

export class FakeEditor {
	constructor(
		private text: string,
		private line: number,
	) {}
	getValue(): string {
		return this.text;
	}
	getLine(line: number): string {
		return this.text.split("\n")[line];
	}
	setLine(n: number, text: string): void {
		const lines = this.text.split("\n");
		lines[n] = text;
		this.text = lines.join("\n");
	}
	/** Obsidian's `Editor.replaceRange`, the one write a task with sub-lines is frozen by. */
	replaceRange(text: string, from: { line: number; ch: number }, to: { line: number; ch: number }): void {
		const lines = this.text.split("\n");
		const head = lines[from.line].slice(0, from.ch);
		const tail = lines[to.line].slice(to.ch);
		lines.splice(from.line, to.line - from.line + 1, head + text + tail);
		this.text = lines.join("\n");
	}
	getCursor(): { line: number; ch: number } {
		return { line: this.line, ch: 0 };
	}
}

const started: Plugin[] = [];
export const openedChoosers: CollectionChooser[] = [];

interface Setup {
	collections?: Collection[];
	/** The recently-used value `data.json` holds before the run; anything, so a wrong shape can be planted. */
	recentlyUsed?: unknown;
	/** What the index answers; defaults to `collections`. A note not in it is not a collection. */
	extraNotes?: Record<string, string>;
	/** The day's log's text in the vault; defaults to {@link LOG}. */
	log?: string;
	/** The layout's excluded folders; the core's index never calls a note under one a collection. */
	excludedFolders?: string[];
	/**
	 * Resolve a link the way Obsidian resolves a short one when two notes share a
	 * name: by the note's whole path, or else by the first note of that name in
	 * the vault's order. Obsidian's own rule for that case is its own and not
	 * published; the emulation only has to pick one of the two, so a test files
	 * into the one it does not pick. Off, links resolve from the metadata cache.
	 */
	obsidianLinks?: boolean;
	/**
	 * The person's link settings, as `getConfig` would read them back; the stub's
	 * `FileManager.generateMarkdownLink` writes the link they ask for. Wikilinks, "shortest".
	 */
	linkSettings?: { useMarkdownLinks?: boolean; newLinkFormat?: "shortest" | "relative" | "absolute" };
}

export async function startMigration({ collections = [ATTIC, SHED, KITCHEN], recentlyUsed, extraNotes = {}, log = LOG, excludedFolders = [], obsidianLinks = false, linkSettings = {} }: Setup = {}) {
	const plugin = new Plugin();
	started.push(plugin);
	const data = defaultData();
	const seeded: Record<string, unknown> = {
		...data,
		core: { ...data.core, layout: { ...data.core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD", excludedFolders } },
	};
	if (recentlyUsed !== undefined) seeded.features = { ...data.features, [FEATURE_ID]: { recentlyUsed } };
	plugin.seedData(seeded);
	plugin.load();
	const vault = plugin.app.vault;
	const texts: Record<string, string> = { [LOG_PATH]: log, ...extraNotes };
	for (const each of collections) texts[each.path] = TASKS_TEXT(each.name);
	vault.files = Object.keys(texts).map((path) => ({ path }));
	vault.allowReads(texts);
	const filePaths = (): string[] => vault.files.map((each) => each.path);
	Object.assign(plugin.app.fileManager, linkSettings);
	if (obsidianLinks) {
		// A linktext that already ends in `.md` (a markdown link's) is looked up as it stands, and names
		// match without regard to case, as Obsidian matches them.
		plugin.app.metadataCache.getFirstLinkpathDest = (linkpath, sourcePath) => {
			let reached = linkpath;
			if (linkpath.startsWith("../") || linkpath.startsWith("./")) {
				// A relative path is reached from the folder of the note the link is in.
				const parts = sourcePath.split("/").slice(0, -1);
				for (const part of linkpath.split("/")) {
					if (part === "..") parts.pop();
					else if (part !== ".") parts.push(part);
				}
				reached = parts.join("/");
			}
			const wanted = (/\.md$/iu.test(reached) ? reached : `${reached}.md`).toLowerCase();
			const found = filePaths().find((each) => each.toLowerCase() === wanted) ?? filePaths().find((each) => each.toLowerCase().endsWith(`/${wanted}`));
			return found === undefined ? null : { path: found };
		};
	}

	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const notes = new NoteWriter(vault as unknown as ObsidianVault, { path: () => null, onChange: () => undefined });
	const calendar: Calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const index: Collections = { all: () => collections, at: (path) => collections.find((each) => each.path === path) ?? null };
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections: index, problems: new Problems(), device },
		notes,
		calendar,
	);
	registry.register(FEATURE_ID, (host) => new Migration(host));
	registry.start();
	return { plugin };
}

/** Runs the command with the cursor on `line` of the log, as the palette would. */
export function run(plugin: Plugin, line: number): void {
	const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:file-task`);
	expect(command, "the file-task command was not registered").toBeDefined();
	const check = (command as unknown as { editorCheckCallback: CheckCallback }).editorCheckCallback;
	check(false, new FakeEditor(LOG, line), { file: { path: LOG_PATH } });
}

export function lastChooser(): StubFuzzySuggestModal<ChooserItem> & CollectionChooser {
	const chooser = openedChoosers[openedChoosers.length - 1];
	expect(chooser, "the command opened no chooser").toBeDefined();
	return chooser as unknown as StubFuzzySuggestModal<ChooserItem> & CollectionChooser;
}

export let asks: MockInstance<ConfirmationModal["open"]>;

export function lastAsk(): ConfirmationModal {
	const ask = asks.mock.contexts[asks.mock.contexts.length - 1] as ConfirmationModal | undefined;
	expect(ask, "no question was asked").toBeDefined();
	return ask as ConfirmationModal;
}

export async function read(plugin: Plugin, path: string): Promise<string> {
	return plugin.app.vault.read({ path });
}

/** What `data.json` holds for the feature, read back from the stored file. */
export async function storedRecent(plugin: Plugin): Promise<unknown> {
	const stored = (await plugin.loadData()) as { features: Record<string, { recentlyUsed?: unknown }> };
	return stored.features[FEATURE_ID]?.recentlyUsed;
}

/** Runs the command on the tea line and files it into the collection named `query` finds. */
export async function fileInto(plugin: Plugin, query: string, line = 2): Promise<void> {
	const before = Notice.messages.filter((each) => each.startsWith("Put this task in")).length;
	run(plugin, line);
	await lastChooser().chooseAt(query, 0);
	await vi.waitFor(() => expect(Notice.messages.filter((each) => each.startsWith("Put this task in"))).toHaveLength(before + 1));
}

export function pathsFor(chooser: CollectionChooser, query: string): string[] {
	return chooser.getSuggestions(query).map((each) => each.item.path);
}

/** Registers the shared set-up and tear-down in the test file that calls it. */
export function installMigrationHooks(): void {
	beforeEach(() => {
		Notice.messages.length = 0;
		openedChoosers.length = 0;
		asks = vi.spyOn(ConfirmationModal.prototype, "open");
		vi.spyOn(CollectionChooser.prototype, "open").mockImplementation(function (this: CollectionChooser) {
			openedChoosers.push(this);
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const plugin of started.splice(0)) plugin.unload();
	});
}
