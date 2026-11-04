/**
 * Filing a task from any note that is not a collection
 * (#981, spec
 * #980 decisions 1, 2 and 4).
 *
 * Runs the real feature registry, settings store and note writer over the
 * Obsidian stub through `migrationHarness.ts`, with the chooser opened but not
 * shown, and reads back the refusal sentence or the two texts written. A
 * meeting-shaped note stands for "any other note": it is not a day's log, not a
 * collection, links to another note, and carries tasks under several headings,
 * a fenced block and frontmatter. Every folder, name and task is invented.
 */

import { describe, expect, it, vi } from "vitest";
import { Menu, Notice } from "./__mocks__/obsidian";
import type { Plugin } from "./__mocks__/obsidian";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { DAY_LOG, ORDINARY_NOTE, sourceNoteOf } from "../features/migration/filable";
import { lineToFreeze } from "../features/migration/fileInto";
import { JUMP_ENTRY_TITLE, UNDO_ENTRY_TITLE } from "../features/migration/menu";
import { planFiling } from "../features/migration/selection";
import { FakeEditor, LOG, LOG_PATH, SHED, installMigrationHooks, lastChooser, openedChoosers, pathsFor, read, startMigration } from "./migrationHarness";
import { pressLine } from "./editorMenu";

installMigrationHooks();

const MEETING_PATH = "Meetings/Harbour board meeting.md";
const PICNIC_PATH = "Meetings/Harbour picnic.md";
const PAINT = "- [ ] Paint the boathouse door";
const BLUE = "\t- [ ] Buy blue paint";
const ROPES = "- [ ] Order new mooring ropes";

/** Line numbers below are counted from zero, as the editor counts them. */
const MEETING = [
	"---", // 0
	"- [ ] A list in the frontmatter", // 1
	"---", // 2
	"# Harbour board meeting", // 3
	"", // 4
	"Present: [[Wren Talbot]]", // 5
	"", // 6
	"## Notes", // 7
	"", // 8
	"- [ ] Ask about the pier lights", // 9
	"", // 10
	"```", // 11
	"- [ ] A task-shaped line in fenced text", // 12
	"```", // 13
	"", // 14
	"## Decisions and actions", // 15
	"", // 16
	PAINT, // 17
	BLUE, // 18
	ROPES, // 19
	"", // 20
].join("\n");

const PAINT_LINE = 17;
const ROPES_LINE = 19;

function layout(over: Partial<VaultLayout> = {}): VaultLayout {
	return { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD", ...over };
}

/** An editor with a selection from `from` to `to`, as Obsidian's `getCursor("from")` and `getCursor("to")` answer. */
class SelectingEditor extends FakeEditor {
	constructor(
		text: string,
		private readonly from: number,
		private readonly to: number,
	) {
		super(text, from);
	}
	override getCursor(which?: "from" | "to"): { line: number; ch: number } {
		return which === "to" ? { line: this.to, ch: 1 } : { line: this.from, ch: 0 };
	}
}

type CheckCallback = (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } | null }) => boolean | void;

/** Runs the command in `editor`, open on the note at `path`, as the palette or the hotkey would. */
function runIn(plugin: Plugin, editor: FakeEditor, path: string): void {
	const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:file-task`);
	expect(command, "the file-task command was not registered").toBeDefined();
	(command as unknown as { editorCheckCallback: CheckCallback }).editorCheckCallback(false, editor, { file: { path } });
}

/** Right-clicks `editor` on the note at `path`; the click lands on `pressed`, the cursor's line unless said. */
function rightClick(plugin: Plugin, editor: FakeEditor & { pressedLine?: number | null }, path: string, pressed?: number): Menu {
	if (pressed !== undefined) editor.pressedLine = pressed;
	const menu = new Menu();
	plugin.app.workspace.fire("editor-menu", menu, editor, { file: { path } });
	return menu;
}

function startWithMeeting(over: { excludedFolders?: string[] } = {}) {
	return startMigration({ extraNotes: { [MEETING_PATH]: MEETING, [PICNIC_PATH]: "# Harbour picnic\n\nBring rugs.\n" }, ...over });
}

async function waitForPut(): Promise<void> {
	await vi.waitFor(() => expect(Notice.messages.some((each) => each.startsWith("Put "))).toBe(true));
}

describe("where a task may be filed from", () => {
	it("plans a task under ## Decisions and actions in an ordinary note, and refuses the same line in a collection", async () => {
		// Wrong code — the day's log's rule applied to every note — would skip line 17 with
		// "This line is not under Notes", and open no chooser in the ordinary note.
		const plan = planFiling(MEETING, PAINT_LINE, PAINT_LINE, layout(), ORDINARY_NOTE);
		expect(plan.skipped).toEqual([]);
		expect(plan.items.map((each) => each.line)).toEqual([PAINT]);

		const { plugin } = await startWithMeeting();
		runIn(plugin, new FakeEditor(MEETING, PAINT_LINE), MEETING_PATH);
		expect(Notice.messages).toEqual([]);
		expect(openedChoosers).toHaveLength(1);

		// The same text, in a note the index calls a collection.
		runIn(plugin, new FakeEditor(MEETING, PAINT_LINE), SHED.path);
		expect(openedChoosers).toHaveLength(1);
		expect(Notice.messages).toEqual(["This note is a collection, so its tasks already live in one. A task is put in a collection from another note."]);
	});

	it("asks the collections index when the command runs, not before", () => {
		// Wrong code that kept the first answer would refuse or allow both calls alike.
		let collection = false;
		const isCollection = (): boolean => collection;
		expect(sourceNoteOf(MEETING_PATH, isCollection, layout())).toEqual({ ok: true, source: ORDINARY_NOTE });
		collection = true;
		expect(sourceNoteOf(MEETING_PATH, isCollection, layout())).toMatchObject({ ok: false });
	});

	it("refuses a note under an excluded folder, saying so", async () => {
		// Wrong code (no excluded-folder check) would open the chooser and say nothing.
		const { plugin } = await startWithMeeting({ excludedFolders: ["Templates"] });

		runIn(plugin, new FakeEditor(MEETING, PAINT_LINE), "Templates/Meeting.md");

		expect(openedChoosers).toEqual([]);
		expect(Notice.messages).toEqual(["This note is in an excluded folder, so its tasks are not put in a collection."]);
	});

	it("refuses a line inside fenced text of an ordinary note, saying so", async () => {
		// Wrong code (no fence check outside the day's log) would open the chooser on line 12.
		const { plugin } = await startWithMeeting();

		runIn(plugin, new FakeEditor(MEETING, 12), MEETING_PATH);

		expect(openedChoosers).toEqual([]);
		expect(Notice.messages).toEqual(["This line is inside fenced text, so it is not a task."]);
	});

	it("refuses a line in an ordinary note's frontmatter, saying so", async () => {
		// Line 1 is a task-shaped line; wrong code (no frontmatter check) would open the chooser.
		const { plugin } = await startWithMeeting();

		runIn(plugin, new FakeEditor(MEETING, 1), MEETING_PATH);

		expect(openedChoosers).toEqual([]);
		expect(Notice.messages).toEqual(["This line is in the note's frontmatter, so it is not a task."]);
	});

	it("files a task under any heading of an ordinary note, the notes heading's name included", () => {
		// Line 9 sits under "## Notes", which is not the day's log's "# Notes" section:
		// wrong code that ran the section rule in an ordinary note would refuse one of the two.
		const plan = planFiling(MEETING, 9, 9, layout(), ORDINARY_NOTE);
		expect(plan.items.map((each) => each.lineIndex)).toEqual([9]);
		expect(planFiling(MEETING, PAINT_LINE, PAINT_LINE, layout(), DAY_LOG).skipped[0].reason).toBe(
			"This line is not under Notes. Only a task written there can be put in a collection.",
		);
	});

	it("still refuses a task under a day's task section of the day's log, with the existing sentence", async () => {
		// Wrong code that dropped the day's log's rule would open the chooser on line 7 ("## Today").
		const { plugin } = await startWithMeeting();

		runIn(plugin, new FakeEditor(LOG, 7), LOG_PATH);

		expect(openedChoosers).toEqual([]);
		expect(Notice.messages).toEqual(["This task is under Today. Only a task written under Notes can be put in a collection."]);
	});
});

describe("what filing from an ordinary note writes", () => {
	it("writes the collection's line with a link back to that note, and freezes the line there with the collection link", async () => {
		// Wrong code that still meant "the day's log" would link back to 2031-04-05, or leave line 19 open.
		const { plugin } = await startWithMeeting();
		const editor = new FakeEditor(MEETING, ROPES_LINE);

		runIn(plugin, editor, MEETING_PATH);
		await lastChooser().chooseAt("Garden shed", 0);
		await waitForPut();

		const collection = await read(plugin, SHED.path);
		const copied = collection.split("\n").find((each) => each.includes("Order new mooring ropes"));
		expect(copied).toMatch(/^- \[ \] Order new mooring ropes .*\[\[Harbour board meeting\]\]/u);
		expect(copied).toContain("%% migration:");
		expect(copied).not.toContain("2031-04-05");

		const frozen = editor.getValue().split("\n")[ROPES_LINE];
		expect(frozen).toMatch(/^- \[>\] Order new mooring ropes .*\[\[Garden shed\]\]/u);
		expect(frozen).toContain("%% migration:");
		// Only that line changed in the note.
		const others = (text: string): string[] => text.split("\n").filter((_, at) => at !== ROPES_LINE);
		expect(others(editor.getValue())).toEqual(others(MEETING));
		expect(Notice.messages).toContain("Put this task in Garden shed.");
	});

	it("freezes the line where it now stands when a line was typed above it while the chooser was open", async () => {
		// The task moves from line 19 to 20 under "## Decisions and actions". Wrong code that looked
		// for the moved line by the day's log's rule would find no line under Notes, and say the
		// line was not marked.
		const { plugin } = await startWithMeeting();
		const editor = new FakeEditor(MEETING, ROPES_LINE);

		runIn(plugin, editor, MEETING_PATH);
		editor.replaceRange("- A line typed while choosing\n", { line: 16, ch: 0 }, { line: 16, ch: 0 });
		await lastChooser().chooseAt("Garden shed", 0);
		await waitForPut();

		expect(Notice.messages).toContain("Put this task in Garden shed.");
		expect(editor.getValue().split("\n")[ROPES_LINE + 1]).toMatch(/^- \[>\] Order new mooring ropes .*\[\[Garden shed\]\]/u);
	});

	it("files a two-line selection into one collection, the sub-task travelling with its parent", async () => {
		// Wrong code that planned only the first line, or left the sub-task behind, would show one
		// task in the collection or "Buy blue paint" still in the meeting note.
		const { plugin } = await startWithMeeting();
		const editor = new SelectingEditor(MEETING, PAINT_LINE, ROPES_LINE);

		runIn(plugin, editor, MEETING_PATH);
		await lastChooser().chooseAt("Garden shed", 0);
		await vi.waitFor(() => expect(Notice.messages).toContain("Put 2 tasks in Garden shed."));

		const collection = (await read(plugin, SHED.path)).split("\n");
		const paint = collection.findIndex((each) => each.startsWith("- [ ] Paint the boathouse door"));
		expect(paint).toBeGreaterThan(-1);
		expect(collection[paint + 1]).toBe(BLUE);
		expect(collection[paint + 2]).toMatch(/^- \[ \] Order new mooring ropes .*\[\[Harbour board meeting\]\]/u);

		const after = editor.getValue().split("\n");
		expect(after[PAINT_LINE]).toMatch(/^- \[>\] Paint the boathouse door .*\[\[Garden shed\]\]/u);
		expect(after[PAINT_LINE + 1]).toMatch(/^- \[>\] Order new mooring ropes .*\[\[Garden shed\]\]/u);
		expect(after).not.toContain(BLUE);
	});

	it("never takes a moved line from an ordinary note's frontmatter or fenced text for the one filed", () => {
		// The line pressed is gone from line 17, and its one other copy sits in the frontmatter, then
		// in fenced text — one copy each time, so a search without the place check would find it:
		// wrong code would answer 1, then 12.
		const gone = MEETING.replace(`${PAINT}\n${BLUE}`, "- [ ] Something else");
		expect(lineToFreeze(gone.replace("- [ ] A list in the frontmatter", PAINT), PAINT_LINE, PAINT, layout(), ORDINARY_NOTE)).toBeNull();
		expect(lineToFreeze(gone.replace("- [ ] A task-shaped line in fenced text", PAINT), PAINT_LINE, PAINT, layout(), ORDINARY_NOTE)).toBeNull();
		// And one that moved under another heading is still found there.
		const under = MEETING.replace(`${PAINT}\n${BLUE}\n`, "").replace("- [ ] Ask about the pier lights", PAINT);
		expect(lineToFreeze(under, PAINT_LINE, PAINT, layout(), ORDINARY_NOTE)).toBe(9);
	});
});

describe("the chooser", () => {
	it("does not offer the note being filed from", async () => {
		// Wrong code would list the meeting note among the ordinary notes typing "Harbour" finds;
		// the picnic note, from the same folder, shows the list is not simply empty.
		const { plugin } = await startWithMeeting();

		runIn(plugin, new FakeEditor(MEETING, PAINT_LINE), MEETING_PATH);

		const found = pathsFor(lastChooser(), "Harbour");
		expect(found).toContain(PICNIC_PATH);
		expect(found).not.toContain(MEETING_PATH);
	});
});

describe("the right-click entry", () => {
	it("is offered on a task under any heading of an ordinary note, and its click opens the chooser", async () => {
		// Wrong code that kept the day's-log gate would leave the menu empty here.
		const { plugin } = await startWithMeeting();
		const editor = new FakeEditor(MEETING, 5);

		const menu = rightClick(plugin, pressLine(editor, PAINT_LINE), MEETING_PATH);

		expect(menu.items.map((each) => each.title)).toEqual(["File this task into a collection"]);
		menu.items[0].click();
		expect(openedChoosers).toHaveLength(1);
	});

	it("decides from the pressed line, not the cursor's, in an ordinary note", async () => {
		// The cursor is on a task; the click lands in fenced text, then in the frontmatter.
		// Wrong code reading the cursor's line would offer the entry both times.
		const { plugin } = await startWithMeeting();

		expect(rightClick(plugin, new FakeEditor(MEETING, PAINT_LINE), MEETING_PATH, 12).items).toEqual([]);
		expect(rightClick(plugin, new FakeEditor(MEETING, PAINT_LINE), MEETING_PATH, 1).items).toEqual([]);
		// And the reverse: cursor in fenced text, click on the task.
		expect(rightClick(plugin, new FakeEditor(MEETING, 12), MEETING_PATH, PAINT_LINE).items.map((each) => each.title)).toEqual(["File this task into a collection"]);
	});

	// #990: the entry is offered only on a line the command could file. Each line below sits in the
	// ordinary note, outside the frontmatter and fenced text, so the place check alone passes it; wrong
	// code that stopped at the place check would offer the entry on every one of them.
	const FROZEN_LINE = 21;
	const WITH_FROZEN = `${MEETING}\n- [>] Sand the pier [[Garden shed]] %% migration:mueqhd82nrew 5548e9c2 %%`;

	it.each([
		["a heading", 3],
		["prose with a link", 5],
		["a blank line", 4],
	])("is not offered, and no other entry either, on %s of an ordinary note", async (_name, line) => {
		const { plugin } = await startWithMeeting();

		expect(rightClick(plugin, new FakeEditor(WITH_FROZEN, PAINT_LINE), MEETING_PATH, line).items).toEqual([]);
	});

	it("offers an already-frozen [>] line of an ordinary note the jump and undo entries and not the filing entry", async () => {
		// #983 overturns "no entry at all" for the frozen line, and only for it. Wrong code that offered filing
		// there adds a third title; wrong code that offered nothing, or one of the two, leaves fewer.
		const { plugin } = await startWithMeeting();

		const titles = rightClick(plugin, new FakeEditor(WITH_FROZEN, PAINT_LINE), MEETING_PATH, FROZEN_LINE).items.map((each) => each.title);
		expect(titles).toEqual([JUMP_ENTRY_TITLE, UNDO_ENTRY_TITLE]);
	});

	it("is still offered on a task line of an ordinary note whose cursor is on prose", async () => {
		// Wrong code that dropped the entry on every line would fail here; wrong code that read the cursor's line (prose) would too.
		const { plugin } = await startWithMeeting();

		const menu = rightClick(plugin, new FakeEditor(WITH_FROZEN, 5), MEETING_PATH, PAINT_LINE);

		expect(menu.items.map((each) => each.title)).toEqual(["File this task into a collection"]);
	});

	it("is not offered in a note under an excluded folder", async () => {
		// Wrong code would offer it, since the line itself is a task under an ordinary heading.
		const { plugin } = await startWithMeeting({ excludedFolders: ["Templates"] });

		expect(rightClick(plugin, pressLine(new FakeEditor(MEETING, ROPES_LINE), PAINT_LINE), "Templates/Meeting.md").items).toEqual([]);
	});
});
