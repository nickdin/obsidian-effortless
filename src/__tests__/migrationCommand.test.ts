/**
 * The command itself: `Migration: file this task into a collection`. It runs the real
 * feature registry, the real settings store and the real note writer over the
 * Obsidian stub's vault, with the chooser opened but not shown: a test reads the
 * dialog the command opened and does what a person would do in it.
 *
 * **The one test that runs the pure halves and the Obsidian half together** is
 * "files the task the cursor is on", which drives the palette entry through the
 * chooser to the two files' final texts. Every folder, name and task is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, Vault as ObsidianVault } from "obsidian";
import { Notice, Plugin } from "./__mocks__/obsidian";
import type { FuzzySuggestModal as StubFuzzySuggestModal } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collection, Collections } from "../core/collections";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { CollectionChooser } from "../features/migration/chooser";
import { hashOfLine } from "../features/migration/marker";
import { FEATURE_ID, Migration } from "../features/migration";
import { parseTaskLine } from "../core/taskLine";

const LOG_PATH = "Journal/2031-04-05.md";
const SHED_PATH = "Projects/Garden shed.md";
const LOG_LINK = "[[2031-04-05]]";

const SHED: Collection = { path: SHED_PATH, name: "Garden shed", headingLine: 2, headingLevel: 2, openTasks: 1 };

const LOG = ["# Notes", "", "- [ ] Order more tea", "- Just a thought", "", "## Today", "", "- [ ] Water the plants", ""].join("\n");

const SHED_TEXT = ["# Garden shed", "", "## Tasks", "", "- [ ] Sweep the floor", "", "## Notes", "", "Some notes.", ""].join("\n");

/** What Obsidian hands a check callback, reduced to what this command reads. */
class FakeEditor {
	constructor(
		protected text: string,
		private line: number,
	) {}

	getValue(): string {
		return this.text;
	}

	getLine(line: number): string {
		return this.text.split("\n")[line];
	}

	/** Obsidian's `Editor.setLine`: the note on screen changes at once. */
	setLine(n: number, text: string): void {
		const lines = this.text.split("\n");
		lines[n] = text;
		this.text = lines.join("\n");
	}

	/** What the person types into the open note. */
	type(text: string): void {
		this.text = text;
	}

	getCursor(): { line: number; ch: number } {
		return { line: this.line, ch: 0 };
	}
}

/** An editor whose write is refused, as an editor that has been closed would refuse it. */
class RefusingEditor extends FakeEditor {
	override setLine(): void {
		throw new Error("the editor is closed");
	}
}

type CheckCallback = (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } | null }) => boolean | void;

const started: Plugin[] = [];
const openedChoosers: CollectionChooser[] = [];

async function startMigration(
	layout: Partial<VaultLayout> = {},
	collections: Collection[] = [SHED],
	openNote: string | null = null,
) {
	const plugin = new Plugin();
	started.push(plugin);
	const data = defaultData();
	plugin.seedData({
		...data,
		core: { ...data.core, layout: { ...data.core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD", ...layout } },
	});
	plugin.load();
	const vault = plugin.app.vault;
	vault.files = [{ path: LOG_PATH }, { path: SHED_PATH }];
	vault.allowReads({ [LOG_PATH]: LOG, [SHED_PATH]: SHED_TEXT });

	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const notes = new NoteWriter(vault as unknown as ObsidianVault, { path: () => openNote, onChange: () => undefined });
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
	return { plugin, vault };
}

function registered(plugin: Plugin) {
	const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:file-task`);
	expect(command, "the file-task command was not registered").toBeDefined();
	return command as unknown as { name: string; hotkeys?: unknown; editorCheckCallback: CheckCallback };
}

/** Runs the command with the cursor on `line` of `text`, as the palette would. */
function run(plugin: Plugin, line: number, text = LOG, path = LOG_PATH): FakeEditor {
	const editor = new FakeEditor(text, line);
	runIn(plugin, editor, path);
	return editor;
}

/** Runs the command in an editor the test already holds, so the same note can be run twice. */
function runIn(plugin: Plugin, editor: FakeEditor, path = LOG_PATH): void {
	registered(plugin).editorCheckCallback(false, editor, { file: { path } });
}

async function read(plugin: Plugin, path: string): Promise<string> {
	return plugin.app.vault.read({ path });
}

/** The dialog the command opened last, with the stub's `chooseAt` the published type does not have. */
function lastChooser(): StubFuzzySuggestModal<Collection> & CollectionChooser {
	const chooser = openedChoosers[openedChoosers.length - 1];
	expect(chooser, "the command opened no chooser").toBeDefined();
	return chooser as unknown as StubFuzzySuggestModal<Collection> & CollectionChooser;
}

beforeEach(() => {
	Notice.messages.length = 0;
	openedChoosers.length = 0;
	vi.spyOn(CollectionChooser.prototype, "open").mockImplementation(function (this: CollectionChooser) {
		openedChoosers.push(this);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const plugin of started.splice(0)) plugin.unload();
});

describe("the command's registration", () => {
	it("is in the palette under its name with no default hotkey", async () => {
		const { plugin } = await startMigration();

		const command = registered(plugin);
		expect(command.name).toBe("Migration: file this task into a collection");
		expect("hotkeys" in command).toBe(false);
	});

	it("is enabled wherever a note is open and never hidden by a refusal it will explain", async () => {
		const { plugin } = await startMigration();
		const check = registered(plugin).editorCheckCallback;

		expect(check(true, new FakeEditor(LOG, 3), { file: { path: LOG_PATH } })).toBe(true);
		expect(check(true, new FakeEditor(LOG, 3), { file: null })).toBe(false);
	});
});

describe("filing from the palette", () => {
	it("files the task the cursor is on: the collection gets the copy, the log keeps the frozen line, one notice names the collection", async () => {
		const { plugin } = await startMigration();
		const task = "- [ ] Order more tea";
		const hash = hashOfLine(parseTaskLine(task)!);

		const editor = run(plugin, 2);
		expect(Notice.messages).toEqual([]);
		await lastChooser().chooseAt("shed", 0);
		await vi.waitFor(() => expect(Notice.messages).toHaveLength(1));

		const id = /migration:(\S+) /.exec(editor.getValue())?.[1];
		expect(id).toMatch(/^[0-9a-z]{9,}$/);
		expect(await read(plugin, SHED_PATH)).toBe(
			SHED_TEXT.replace("- [ ] Sweep the floor\n", `- [ ] Sweep the floor\n${task} ${LOG_LINK} %% migration:${id} ${hash} _ L %%\n`),
		);
		expect(editor.getValue()).toBe(LOG.replace(task, `- [>] Order more tea [[Garden shed]] %% migration:${id} ${hash} _ L %%`));
		expect(Notice.messages).toEqual(["Put this task in Garden shed."]);
	});

	it("freezes the line in the open day's log at once, and a second run on it is refused and files nothing more", async () => {
		// Old code (1749fa7): the log write is parked until the note is left, so the editor still
		// reads `[ ]` after choosing and the second run opens a chooser and files a second copy.
		const { plugin } = await startMigration({}, [SHED], LOG_PATH);
		const task = "- [ ] Order more tea";
		const hash = hashOfLine(parseTaskLine(task)!);

		const editor = run(plugin, 2);
		await lastChooser().chooseAt("shed", 0);
		await vi.waitFor(() => expect(Notice.messages).toHaveLength(1));

		// Nothing has left the note: both whole texts, as they stand now.
		const id = /migration:(\S+) /.exec(editor.getValue())?.[1];
		expect(id).toMatch(/^[0-9a-z]{9,}$/);
		const frozen = LOG.replace(task, `- [>] Order more tea [[Garden shed]] %% migration:${id} ${hash} _ L %%`);
		const collected = SHED_TEXT.replace("- [ ] Sweep the floor\n", `- [ ] Sweep the floor\n${task} ${LOG_LINK} %% migration:${id} ${hash} _ L %%\n`);
		expect(editor.getValue()).toBe(frozen);
		expect(await read(plugin, SHED_PATH)).toBe(collected);
		expect(Notice.messages).toEqual(["Put this task in Garden shed."]);

		runIn(plugin, editor);

		expect(openedChoosers).toHaveLength(1);
		expect(Notice.messages).toHaveLength(2);
		expect(Notice.messages[1]).toContain("hidden comment");
		expect(await read(plugin, SHED_PATH)).toBe(collected);
		expect((collected.match(/Order more tea/g) ?? []).length).toBe(1);
		expect(editor.getValue()).toBe(frozen);
	});

	it("says the collection has the task, and the line was not marked, when the log's write fails after the collection's landed", async () => {
		// Old code: the frozen line is written through the note writer, never the editor, so this
		// editor's refusal is not felt and the person is told "Put this task in Garden shed." only.
		const { plugin } = await startMigration({}, [SHED], LOG_PATH);

		registered(plugin).editorCheckCallback(false, new RefusingEditor(LOG, 2), { file: { path: LOG_PATH } });
		await lastChooser().chooseAt("shed", 0);
		await vi.waitFor(() => expect(Notice.messages).toHaveLength(1));

		expect(Notice.messages[0]).toContain("The task is in Garden shed");
		expect(Notice.messages[0]).toContain("was not marked");
		expect(Notice.messages[0]).not.toContain("was not put in");
		expect(await read(plugin, SHED_PATH)).toContain("- [ ] Order more tea [[2031-04-05]] %% migration:");
	});

	it("writes nothing when the chooser is dismissed", async () => {
		const { plugin, vault } = await startMigration();
		const process = vi.spyOn(vault, "process");

		run(plugin, 2);
		lastChooser().close();
		await Promise.resolve();

		expect(process).not.toHaveBeenCalled();
		expect(await read(plugin, LOG_PATH)).toBe(LOG);
		expect(await read(plugin, SHED_PATH)).toBe(SHED_TEXT);
		expect(Notice.messages).toEqual([]);
	});

	it.each([
		["a plain bullet", 3, "list item with no checkbox"],
		["a line under a day's task section", 7, "Today"],
		["a blank line", 4, "not a task"],
	])("refuses %s with a notice and opens nothing", async (_name, line, said) => {
		const { plugin } = await startMigration();

		run(plugin, line);

		expect(openedChoosers).toEqual([]);
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain(said);
		expect(await read(plugin, LOG_PATH)).toBe(LOG);
	});

	it("refuses a line inside fenced text", async () => {
		const { plugin } = await startMigration();
		const fenced = ["# Notes", "", "```", "- [ ] Not a task", "```", ""].join("\n");

		run(plugin, 3, fenced);

		expect(openedChoosers).toEqual([]);
		expect(Notice.messages[0]).toContain("fenced text");
	});

	// Until #981 this refused any note that was not a day's log, with "This is not
	// a day's log…". Spec #980 decision 1 overturns that rule: any note that is not
	// a collection may be filed from. The fixture note here is a collection (SHED is
	// in the index), so it is still refused, and now for its real reason.
	it("refuses in a note that is a collection, saying so", async () => {
		const { plugin } = await startMigration();

		run(plugin, 2, LOG, SHED_PATH);

		expect(openedChoosers).toEqual([]);
		expect(Notice.messages[0]).toContain("This note is a collection");
		expect(Notice.messages[0]).not.toContain("day's log");
	});

	it("says so when there is no collection to choose from", async () => {
		const { plugin, vault } = await startMigration({}, []);
		// Since #873 the chooser also offers ordinary notes, so the refusal holds
		// only where the vault has none: the day's log alone.
		vault.files = [{ path: LOG_PATH }];

		run(plugin, 2);

		expect(openedChoosers).toEqual([]);
		expect(Notice.messages[0]).toContain("no collection");
	});

	it("says why when the feature is not configured, and opens nothing", async () => {
		const { plugin } = await startMigration({ dailyLogFolder: "" });

		run(plugin, 2);

		expect(openedChoosers).toEqual([]);
		expect(Notice.messages[0]).toContain("not set up");
	});

	it("leaves both files alone and says so when the chosen note has stopped being a collection", async () => {
		const { plugin } = await startMigration();
		plugin.app.vault.allowReads({ [LOG_PATH]: LOG, [SHED_PATH]: "# Garden shed\n\nNo tasks now.\n" });

		run(plugin, 2);
		await lastChooser().chooseAt("shed", 0);
		await vi.waitFor(() => expect(Notice.messages).toHaveLength(1));

		expect(Notice.messages[0]).toContain("no longer has the Tasks heading");
		expect(await read(plugin, LOG_PATH)).toBe(LOG);
		expect(await read(plugin, SHED_PATH)).toBe("# Garden shed\n\nNo tasks now.\n");
	});

	it("still puts the task in the collection, and says the original was not marked, when the line changed while the chooser was open", async () => {
		const { plugin } = await startMigration();

		const editor = run(plugin, 2);
		const edited = LOG.replace("Order more tea", "Order oat milk");
		editor.type(edited);
		await lastChooser().chooseAt("shed", 0);
		await vi.waitFor(() => expect(Notice.messages).toHaveLength(1));

		expect(Notice.messages[0]).toContain("was not marked");
		expect(editor.getValue()).toBe(edited);
		expect(await read(plugin, SHED_PATH)).toContain("- [ ] Order more tea [[2031-04-05]] %% migration:");
	});
});
