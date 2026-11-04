/**
 * The right-click entry on a line, over the
 * same real registry, settings store and note writer as `migrationCommand.test.ts`,
 * with the stub's `Menu` standing for the one Obsidian builds. Every folder,
 * name and task is invented.
 *
 * **The one test that runs this ticket's code together with #856's filing path**
 * (`checkFilable`, `fileInto`) is "files exactly as the command does": it drives
 * the menu route and the palette route over one fixture and compares the files.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, Vault as ObsidianVault } from "obsidian";
import { EDITOR_LINE_HEIGHT, Menu, Notice, Plugin } from "./__mocks__/obsidian";
import type { FuzzySuggestModal as StubFuzzySuggestModal } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collection, Collections } from "../core/collections";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { CollectionChooser } from "../features/migration/chooser";
import { FEATURE_ID, Migration } from "../features/migration";
import { pressLine } from "./editorMenu";

const LOG_PATH = "Journal/2031-04-05.md";
const SHED_PATH = "Projects/Garden shed.md";

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

	/** Where the right-click lands, when it is not on the cursor's line (`PressableEditor` in the stub). */
	pressedLine?: number | null;
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

function commandOf(plugin: Plugin) {
	const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:file-task`);
	expect(command, "the file-task command was not registered").toBeDefined();
	return command as unknown as { editorCheckCallback: CheckCallback };
}

/**
 * Right-clicks `editor` in the note at `path`, and returns the menu Obsidian would have shown.
 * The click lands on the editor's `pressedLine` (set by `pressLine`, or by `pressed` here, which
 * overrides it); with neither set the stub throws. `null` opens the menu with no mouse event at all. Obsidian moves the cursor only after it fires `editor-menu`, so the fake's stays put.
 */
function rightClick(plugin: Plugin, editor: FakeEditor, path = LOG_PATH, pressed?: number | null): Menu {
	if (pressed !== undefined) editor.pressedLine = pressed;
	const menu = new Menu();
	plugin.app.workspace.fire("editor-menu", menu, editor, { file: { path } });
	return menu;
}

async function read(plugin: Plugin, path: string): Promise<string> {
	return plugin.app.vault.read({ path });
}

function lastChooser(): StubFuzzySuggestModal<Collection> & CollectionChooser {
	const chooser = openedChoosers[openedChoosers.length - 1];
	expect(chooser, "no chooser was opened").toBeDefined();
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

describe("the entry on a line", () => {
	it("is added on a task line under the notes heading", async () => {
		// Wrong code (no entry, or one on every line) would leave `items` empty here or non-empty below.
		const { plugin } = await startMigration();

		const menu = rightClick(plugin, pressLine(new FakeEditor(LOG, 3), 2));

		expect(menu.items.map((item) => item.title)).toEqual(["File this task into a collection"]);
	});

	it("is not added on a line under a day's task section", async () => {
		const { plugin } = await startMigration();

		const menu = rightClick(plugin, pressLine(new FakeEditor(LOG, 2), 7));

		expect(menu.items).toEqual([]);
	});

	// Until #981 this was "not added in a note that is not a day's log". Spec #980
	// decision 4 overturns that: the entry shows in any note that is not a
	// collection. SHED_PATH is a collection, so the entry is still left out, now
	// for that reason; `migrationFileFromAnyNote.test.ts` covers an ordinary note.
	it("is not added in a note that is a collection, even on a line under a notes heading", async () => {
		const { plugin } = await startMigration();

		const menu = rightClick(plugin, pressLine(new FakeEditor(LOG, 3), 2), SHED_PATH);

		expect(menu.items).toEqual([]);
	});

	it("is not added inside a fenced block under the notes heading", async () => {
		const { plugin } = await startMigration();
		const fenced = ["# Notes", "", "```", "- [ ] Not a task", "```", "- [ ] A real task", ""].join("\n");

		const menu = rightClick(plugin, pressLine(new FakeEditor(fenced, 5), 3));

		expect(menu.items).toEqual([]);
	});

	it("reads the notes heading when the menu opens, so a changed heading is felt at once", async () => {
		const { plugin } = await startMigration({ notesHeading: { text: "Jottings", level: 1 } });

		// Under "Jottings" nothing in LOG is a task the command could file, so the cursor goes on the bullet in both.
		expect(rightClick(plugin, pressLine(new FakeEditor(LOG, 3), 2)).items).toEqual([]);
		expect(rightClick(plugin, pressLine(new FakeEditor(LOG.replace("# Notes", "# Jottings"), 3), 2)).items).toHaveLength(1);
	});
});

describe("the line the right-click lands on, when the cursor is on another", () => {
	// Read on the test Obsidian: `editor-menu` fires while the cursor is still where it was before the click
	// (docs/acceptance-shots/issue-864-drive-1-settings-chooser-rightclick.txt, step 3b). A menu that asks the
	// cursor would answer for the wrong line in every case below.
	const FROZEN = ["# Notes", "", "- [>] Order more tea [[Garden shed]] %% migration:mueqhd82nrew 5548e9c2 %%", "- Just a thought", "", "## Today", "", "- [ ] Water the plants", ""].join("\n");
	const titlesOf = (menu: Menu): string[] => menu.items.map((item) => item.title);

	it("adds the filing entry on a task under the notes heading when the cursor is under Today", async () => {
		const { plugin } = await startMigration();

		const menu = rightClick(plugin, new FakeEditor(LOG, 7), LOG_PATH, 2);

		expect(titlesOf(menu)).toEqual(["File this task into a collection"]);
	});

	it("adds no filing entry on a line under Today when the cursor is on a task under the notes heading", async () => {
		const { plugin } = await startMigration();

		const menu = rightClick(plugin, new FakeEditor(LOG, 2), LOG_PATH, 7);

		expect(titlesOf(menu)).toEqual([]);
	});

	it("adds the jump and undo entries on a frozen line the cursor is not on, and none on the line the cursor is on", async () => {
		const { plugin } = await startMigration();

		// The frozen line offers jump and undo, and no filing entry: the command would refuse it. The
		// second press is on the plain bullet beside it, where the cursor sits on the frozen line.
		expect(titlesOf(rightClick(plugin, new FakeEditor(FROZEN, 7), LOG_PATH, 2))).toEqual([
			"Go to this task in its collection",
			"Undo migration",
		]);
		expect(titlesOf(rightClick(plugin, new FakeEditor(FROZEN, 2), LOG_PATH, 3))).toEqual([]);
	});

	it("says so and adds nothing when the menu opens with no right-click to read, rather than using the cursor's line", async () => {
		const { plugin } = await startMigration();

		const menu = rightClick(plugin, new FakeEditor(LOG, 2), LOG_PATH, null);

		expect(menu.items).toEqual([]);
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toMatch(/which line/);
	});

	it("does not take an earlier right-click for this menu's", async () => {
		const { plugin } = await startMigration();
		expect(rightClick(plugin, pressLine(new FakeEditor(LOG, 3), 2)).items).toHaveLength(1);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const menu = rightClick(plugin, new FakeEditor(LOG, 2), LOG_PATH, null);

		expect(menu.items).toEqual([]);
		expect(Notice.messages).toHaveLength(1);
	});

	it("reads the click of a menu Obsidian opens a moment after the right-click, and only that menu's", async () => {
		// Read on the test Obsidian: when the pane did not have the typing focus, `editor-menu` fired after
		// the cursor had already moved, in a later turn than the `contextmenu` event
		// (docs/acceptance-shots/issue-881-rightclick-line.txt, the first build's cases A and C). A reader
		// that forgot the click at the end of its turn adds nothing here, and says the click was unreadable.
		const { plugin } = await startMigration();
		const editor = new FakeEditor(LOG, 7);
		const press = (line: number) => document.dispatchEvent(new MouseEvent("contextmenu", { clientX: 40, clientY: line * EDITOR_LINE_HEIGHT + 10, bubbles: true }));
		Object.assign(editor, { cm: { posAtCoords: ({ y }: { y: number }) => LOG.split("\n").slice(0, Math.floor(y / EDITOR_LINE_HEIGHT)).join("\n").length + 1 }, offsetToPos: (offset: number) => ({ line: LOG.slice(0, offset).split("\n").length - 1, ch: 0 }) });
		press(2);
		await new Promise((resolve) => setTimeout(resolve, 20));

		const late = rightClick(plugin, editor, LOG_PATH, null);
		const next = rightClick(plugin, editor, LOG_PATH, null);

		expect(late.items.map((item) => item.title)).toEqual(["File this task into a collection"]);
		expect(next.items).toEqual([]);
		expect(Notice.messages).toHaveLength(1);
	});

	it("says so and adds nothing when the editor cannot turn the click into a line", async () => {
		const { plugin } = await startMigration();
		const editor = new FakeEditor(LOG, 2);
		Object.assign(editor, { cm: null });

		const menu = rightClick(plugin, pressLine(editor, 7));

		expect(menu.items).toEqual([]);
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toMatch(/which line/);
	});
});

describe("choosing the entry", () => {
	/** Both files with the id, which differs between two runs, made the same word. */
	const withoutId = (text: string) => text.replace(/migration:\S+ /g, "migration:ID ");

	it("files exactly as the command does: the same two files come out of both routes", async () => {
		// Wrong code (a second copy of the filing, or a menu that filed a different line) would leave
		// the two routes' files apart; two equal untouched files would also be equal, so they are
		// first compared with the untouched ones.
		const viaMenu = await startMigration({}, [SHED], LOG_PATH);
		const menuEditor = new FakeEditor(LOG, 3);
		rightClick(viaMenu.plugin, pressLine(menuEditor, 2)).items[0].click();
		await lastChooser().chooseAt("shed", 0);
		await vi.waitFor(() => expect(Notice.messages).toHaveLength(1));
		const menuNotices = [...Notice.messages];

		Notice.messages.length = 0;
		const viaCommand = await startMigration({}, [SHED], LOG_PATH);
		const commandEditor = new FakeEditor(LOG, 2);
		commandOf(viaCommand.plugin).editorCheckCallback(false, commandEditor, { file: { path: LOG_PATH } });
		await lastChooser().chooseAt("shed", 0);
		await vi.waitFor(() => expect(Notice.messages).toHaveLength(1));

		expect(withoutId(menuEditor.getValue())).not.toBe(withoutId(LOG));
		expect(withoutId(menuEditor.getValue())).toContain("- [>] Order more tea [[Garden shed]] %% migration:ID ");
		expect(withoutId(await read(viaMenu.plugin, SHED_PATH))).not.toBe(withoutId(SHED_TEXT));
		expect(withoutId(menuEditor.getValue())).toBe(withoutId(commandEditor.getValue()));
		expect(withoutId(await read(viaMenu.plugin, SHED_PATH))).toBe(withoutId(await read(viaCommand.plugin, SHED_PATH)));
		expect(menuNotices).toEqual(Notice.messages);
		expect(menuNotices).toEqual(["Put this task in Garden shed."]);
	});

	it("offers no entry on a plain bullet under the notes heading, and the command still refuses it in words", async () => {
		// The entry is offered only on a line the command could file, so the refusal is heard from the command alone.
		const { plugin } = await startMigration();
		const menu = rightClick(plugin, pressLine(new FakeEditor(LOG, 2), 3));
		expect(menu.items).toEqual([]);
		expect(Notice.messages).toEqual([]);
		commandOf(plugin).editorCheckCallback(false, new FakeEditor(LOG, 3), { file: { path: LOG_PATH } });

		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("list item with no checkbox");
		expect(openedChoosers).toEqual([]);
	});
});

describe("unloading", () => {
	it("takes the listener off the workspace, so no entry is added any more", async () => {
		const { plugin } = await startMigration();
		const listening = () => plugin.app.workspace.listeners.filter(([name]) => name === "editor-menu");
		// Three entries since wave 4: filing, jump and undo.
		expect(listening()).toHaveLength(3);

		plugin.unload();

		expect(listening()).toHaveLength(0);
		expect(rightClick(plugin, pressLine(new FakeEditor(LOG, 3), 2)).items).toEqual([]);
	});
});
