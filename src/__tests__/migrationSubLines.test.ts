/**
 * Filing several lines at once, and a task's sub-lines travelling with it.
 *
 * The first block is the pure planning over text. The second block is **the
 * composition this ticket relies on**: the real registry, note writer and
 * command run over the stub vault, so the selection and subtree code runs
 * together with #856's `checkFilable` and `fileInto` path (`checkFilable` in
 * the plan, `linesToWrite` and `placeInCollection` in the writes,
 * `lineToFreeze` in the log). The day's log is the open note in those tests,
 * as it is when a person files from it. Every name and task is invented.
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
import { FEATURE_ID, Migration } from "../features/migration";
import { collectionBlock, planFiling, selectedLineRange, skippedNotice, subtreeOf } from "../features/migration/selection";
import { linesToWrite } from "../features/migration/fileInto";

const LOG_PATH = "Journal/2031-04-05.md";
const SHED_PATH = "Projects/Garden shed.md";
const SHED: Collection = { path: SHED_PATH, name: "Garden shed", headingLine: 2, headingLevel: 2, openTasks: 1 };
const SHED_TEXT = ["# Garden shed", "", "## Tasks", "", "- [ ] Sweep the floor", "", "## Notes", "", "Some notes.", ""].join("\n");

const layout: VaultLayout = { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };

/** A task with two levels of sub-lines, a plain bullet, and a second task with one. */
const LOG = [
	"# Notes", // 0
	"", // 1
	"- [ ] Order more tea", // 2
	"  - [ ] Black", // 3
	"    - the loose kind", // 4
	"- Just a thought", // 5
	"- [x] Mend the gate", // 6
	"\t- with the new hinge", // 7
	"", // 8
	"## Today", // 9
	"", // 10
	"- [ ] Water the plants", // 11
	"",
].join("\n");

describe("planning what a selection files", () => {
	it("takes a lone line with the lines indented under it, up to the first line no deeper", () => {
		const plan = planFiling(LOG, 2, 2, layout);

		expect(plan.skipped).toEqual([]);
		expect(plan.items).toEqual([
			{ lineIndex: 2, line: "- [ ] Order more tea", subtree: ["  - [ ] Black", "    - the loose kind"] },
		]);
	});

	it("files each top-level line of a selection on its own, and names the plain bullet it leaves", () => {
		const plan = planFiling(LOG, 2, 6, layout);

		// If sub-lines were filed as tops the plan would hold `Black` too; if the bullet were not
		// refused it would be an item.
		expect(plan.items.map((item) => item.lineIndex)).toEqual([2, 6]);
		expect(plan.skipped).toHaveLength(1);
		expect(plan.skipped[0]).toMatchObject({ lineIndex: 5, line: "- Just a thought" });
		expect(plan.skipped[0].reason).toContain("list item with no checkbox");
		expect(plan.examined).toBe(3);
	});

	it("does not look again at the sub-lines of a line it left out", () => {
		const text = ["# Notes", "- Just a thought", "  - [ ] a child task", "- [ ] Mend the gate"].join("\n");

		const plan = planFiling(text, 1, 3, layout);

		expect(plan.items.map((item) => item.lineIndex)).toEqual([3]);
		expect(plan.skipped.map((each) => each.lineIndex)).toEqual([1]);
	});

	it("names a line under a day's task section, and a line inside fenced text", () => {
		const text = ["# Notes", "```", "- [ ] inside a fence", "```", "## Today", "- [ ] Water the plants"].join("\n");

		const plan = planFiling(text, 2, 5, layout);

		expect(plan.items).toEqual([]);
		expect(plan.skipped.map((each) => each.lineIndex)).toEqual([2, 3, 4, 5]);
		expect(plan.skipped[0].reason).toContain("fenced text");
		expect(plan.skipped[3].reason).toContain("Today");
	});

	it("ignores blank lines in a selection of several, and refuses one when it is the lone line", () => {
		expect(planFiling(LOG, 6, 9, layout).skipped.map((each) => each.lineIndex)).toEqual([9]);
		expect(planFiling(LOG, 8, 8, layout).skipped[0].reason).toContain("not a task");
	});

	it("ends a selection that stops at the start of a line on the line above", () => {
		expect(selectedLineRange({ line: 2, ch: 3 }, { line: 6, ch: 0 })).toEqual({ first: 2, last: 5 });
		expect(selectedLineRange({ line: 2, ch: 0 }, { line: 2, ch: 0 })).toEqual({ first: 2, last: 2 });
		expect(selectedLineRange({ line: 2, ch: 3 }, { line: 6, ch: 4 })).toEqual({ first: 2, last: 6 });
	});

	it("counts a tab as deeper than no indentation, and ends the subtree at a blank line", () => {
		expect(subtreeOf(LOG.split("\n"), 6)).toEqual(["\t- with the new hinge"]);
		expect(subtreeOf(["- [ ] a", "  b", "", "  c"], 0)).toEqual(["  b"]);
	});

	it("names every skipped line in one sentence, each by its number and its words", () => {
		const said = skippedNotice([
			{ lineIndex: 4, line: "- Just a thought", reason: "Reason one." },
			{ lineIndex: 8, line: "- [I] an idea", reason: "Reason two." },
		]);

		expect(said).toBe('2 lines were left where they are. line 5 "- Just a thought": Reason one. line 9 "- [I] an idea": Reason two.');
	});
});

describe("what the collection receives for one item", () => {
	it("keeps the sub-lines' indentation relative to the filed line, and the marker on the top line only", () => {
		const item = { lineIndex: 0, line: "  - [ ] Mend the gate", subtree: ["    - hinge", "      - brass"] };
		const filed = linesToWrite(item.line, "abc", "[[Garden shed]]", "[[2031-04-05]]");

		const block = collectionBlock(item, filed);

		expect(block[0]).toMatch(/^- \[ \] Mend the gate \[\[2031-04-05\]\] %% migration:abc [^ ]+ _ L %%$/);
		expect(block.slice(1)).toEqual(["  - hinge", "    - brass"]);
	});
});

/** The open note: text on screen, a selection, and the two writes the command makes to it. */
class SelectingEditor {
	constructor(
		private text: string,
		private from: { line: number; ch: number },
		private to: { line: number; ch: number } = from,
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

	replaceRange(replacement: string, from: { line: number; ch: number }, to: { line: number; ch: number }): void {
		const offset = (at: { line: number; ch: number }): number =>
			this.text.split("\n").slice(0, at.line).reduce((sum, each) => sum + each.length + 1, 0) + at.ch;
		this.text = this.text.slice(0, offset(from)) + replacement + this.text.slice(offset(to));
	}

	type(text: string): void {
		this.text = text;
	}

	getCursor(side?: string): { line: number; ch: number } {
		return side === "to" ? this.to : this.from;
	}
}

type CheckCallback = (checking: boolean, editor: SelectingEditor, ctx: { file: { path: string } | null }) => boolean | void;

const started: Plugin[] = [];
const openedChoosers: CollectionChooser[] = [];

/** The real registry over the stub vault, with the day's log as the note on screen. */
async function startMigration(shedText = SHED_TEXT) {
	const plugin = new Plugin();
	started.push(plugin);
	const data = defaultData();
	plugin.seedData({ ...data, core: { ...data.core, layout } });
	plugin.load();
	const vault = plugin.app.vault;
	vault.files = [{ path: LOG_PATH }, { path: SHED_PATH }];
	vault.allowReads({ [LOG_PATH]: LOG, [SHED_PATH]: shedText });

	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const notes = new NoteWriter(vault as unknown as ObsidianVault, { path: () => LOG_PATH, onChange: () => undefined });
	const calendar: Calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const index: Collections = { all: () => [SHED], at: (path) => (path === SHED_PATH ? SHED : null) };
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections: index, problems: new Problems(), device },
		notes,
		calendar,
	);
	registry.register(FEATURE_ID, (host) => new Migration(host));
	registry.start();
	return plugin;
}

function run(plugin: Plugin, editor: SelectingEditor): void {
	const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:file-task`);
	expect(command, "the file-task command was not registered").toBeDefined();
	(command as unknown as { editorCheckCallback: CheckCallback }).editorCheckCallback(false, editor, { file: { path: LOG_PATH } });
}

function lastChooser(): StubFuzzySuggestModal<Collection> & CollectionChooser {
	const chooser = openedChoosers[openedChoosers.length - 1];
	expect(chooser, "the command opened no chooser").toBeDefined();
	return chooser as unknown as StubFuzzySuggestModal<Collection> & CollectionChooser;
}

const read = (plugin: Plugin, path: string): Promise<string> => plugin.app.vault.read({ path });

/** The ids in a text, in the order they appear. */
const idsIn = (text: string): string[] => [...text.matchAll(/migration:(\S+) /g)].map((match) => match[1]);

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

describe("filing from the palette, over the whole filing path", () => {
	it("files a task with its sub-lines: the collection gets them with their indentation, the open log keeps only the frozen line", async () => {
		// Wrong code that left the sub-lines in the log, or dropped them from the collection, or
		// flattened their indentation, changes one of the two whole texts compared here.
		const plugin = await startMigration();
		const editor = new SelectingEditor(LOG, { line: 2, ch: 4 });

		run(plugin, editor);
		await lastChooser().chooseAt("shed", 0);
		await vi.waitFor(() => expect(Notice.messages).toHaveLength(1));

		const [id] = idsIn(editor.getValue());
		expect(id).toBeDefined();
		const marker = /%% migration:\S+ \S+ \S+ \S+ %%/.exec(editor.getValue())![0];
		expect(editor.getValue()).toBe(
			LOG.replace("- [ ] Order more tea\n  - [ ] Black\n    - the loose kind\n", `- [>] Order more tea [[Garden shed]] ${marker}\n`),
		);
		expect(await read(plugin, SHED_PATH)).toBe(
			SHED_TEXT.replace(
				"- [ ] Sweep the floor\n",
				`- [ ] Sweep the floor\n- [ ] Order more tea [[2031-04-05]] ${marker}\n  - [ ] Black\n    - the loose kind\n`,
			),
		);
		expect(Notice.messages).toEqual(["Put this task in Garden shed."]);
	});

	it("files three selected lines, one of them a plain bullet: two land with distinct ids, the bullet is untouched, one notice names it", async () => {
		// Wrong code would file the bullet, file both tasks under one id, or leave the bullet unnamed.
		const plugin = await startMigration();
		const editor = new SelectingEditor(LOG, { line: 2, ch: 0 }, { line: 6, ch: 18 });

		run(plugin, editor);
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain('line 6 "- Just a thought"');
		expect(Notice.messages[0]).toContain("list item with no checkbox");
		await lastChooser().chooseAt("shed", 0);
		await vi.waitFor(() => expect(Notice.messages).toHaveLength(2));

		const inLog = idsIn(editor.getValue());
		expect(inLog).toHaveLength(2);
		expect(inLog[0]).not.toBe(inLog[1]);
		const shed = await read(plugin, SHED_PATH);
		expect(idsIn(shed)).toEqual(inLog);
		expect(editor.getValue()).toMatch(/^- \[>\] Order more tea \[\[Garden shed\]\] %% migration:/m);
		expect(editor.getValue()).toContain("\n- Just a thought\n");
		expect(editor.getValue()).not.toContain("Black");
		expect(editor.getValue()).not.toContain("new hinge");
		expect(shed).toMatch(/- \[ \] Order more tea \[\[2031-04-05\]\] %% [^\n]*\n {2}- \[ \] Black\n {4}- the loose kind\n/);
		// The done task lands under the completed-tasks heading, still ticked, with its tab-indented child.
		expect(shed).toMatch(/Completed[^\n]*\n\n- \[x\] Mend the gate \[\[2031-04-05\]\] %% migration:[^\n]*\n\t- with the new hinge\n/);
		expect(Notice.messages[1]).toBe("Put 2 tasks in Garden shed.");
	});

	it.each([
		["one line", { line: 2, ch: 0 }, { line: 2, ch: 0 }, "Effortless: the task was not put in Garden shed. disk full"],
		["a selection of two", { line: 2, ch: 0 }, { line: 6, ch: 18 }, "Effortless: the 2 tasks were not put in Garden shed. disk full"],
	])("says, when the collection's write fails, how many tasks were not put there: %s", async (_name, from, to, said) => {
		// Wrong wording would say "the task" for two, or name a count for one; the write
		// is refused before anything lands, so no other notice can carry the sentence.
		const plugin = await startMigration();
		vi.spyOn(plugin.app.vault, "process").mockRejectedValue(new Error("disk full"));

		run(plugin, new SelectingEditor(LOG, from, to));
		await lastChooser().chooseAt("shed", 0);
		await vi.waitFor(() => expect(Notice.messages.filter((each) => each.startsWith("Effortless:"))).toEqual([said]));
	});

	it("opens no chooser when every selected line is refused: a lone line says its reason, several are named in one notice", async () => {
		const plugin = await startMigration();
		const editor = new SelectingEditor(LOG, { line: 5, ch: 0 }, { line: 5, ch: 16 });
		const under = new SelectingEditor(LOG, { line: 9, ch: 0 }, { line: 11, ch: 22 });

		run(plugin, editor);
		expect(Notice.messages).toEqual([Notice.messages[0]]);
		expect(Notice.messages[0]).toContain("list item with no checkbox");
		run(plugin, under);

		expect(openedChoosers).toEqual([]);
		expect(Notice.messages).toHaveLength(2);
		expect(Notice.messages[1]).toContain('line 12 "- [ ] Water the plants"');
		expect(Notice.messages[1]).toContain("Today");
	});

	it("says the line was not marked when its sub-lines changed while the chooser was open, and never shifts another line", async () => {
		const plugin = await startMigration();
		const editor = new SelectingEditor(LOG, { line: 2, ch: 0 });

		run(plugin, editor);
		editor.type(LOG.replace("the loose kind", "the tea bags"));
		await lastChooser().chooseAt("shed", 0);
		await vi.waitFor(() => expect(Notice.messages).toHaveLength(1));

		expect(Notice.messages[0]).toContain("was not marked");
		expect(editor.getValue()).toBe(LOG.replace("the loose kind", "the tea bags"));
		expect(await read(plugin, SHED_PATH)).toContain("- [ ] Order more tea [[2031-04-05]] %% migration:");
	});
});
