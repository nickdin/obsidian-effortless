/**
 * The jump and undo from a frozen line outside the day's log
 * (#983, spec
 * #980 decision 3 and the
 * jump and undo half of decision 4): `frozenLineAt` recognises a frozen line in
 * any note that is not a collection and not excluded, and an undo writes the task
 * back into that note, saying "the note" where it is not a day's log.
 *
 * The filing runs through the real Migration feature and the right-click entry
 * through the registry's `editor-menu` event (`migrationHarness.ts`). Every
 * folder, name and task is invented.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Menu, Notice } from "./__mocks__/obsidian";
import type { Plugin } from "./__mocks__/obsidian";
import { NoteWriter } from "../core/noteWriter";
import { defaultData } from "../core/settings";
import { DAY_LOG, ORDINARY_NOTE } from "../features/migration/filable";
import { frozenLineAt } from "../features/migration/frozenLine";
import { JUMP_ENTRY_TITLE, UNDO_ENTRY_TITLE } from "../features/migration/menu";
import { undoFilings } from "../features/migration/undo";
import type { UndoWorld } from "../features/migration/undo";
import { FakeEditor, LOG, LOG_PATH, SHED, installMigrationHooks, lastChooser, read, startMigration } from "./migrationHarness";
import { pressLine, pressLineAwayFromCursor } from "./editorMenu";

installMigrationHooks();

const MEETING_PATH = "Meetings/Lantern committee.md";
const OAR_LINE = 5;
const MEETING = ["# Lantern committee", "", "Present: [[Ada Fenwick]]", "", "## Decisions and actions", "- [ ] Varnish the spare oars", ""].join("\n");
const MARKER = "%% migration:k1abcd 0a1b2c3d %%";
const FROZEN = `- [>] Varnish the spare oars [[Garden shed]] ${MARKER}`;

const layout = { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD", excludedFolders: ["Templates"] };
const isShed = (path: string): boolean => path === SHED.path;
/** The frozen line under the cursor of `text`, at line 1, in the note at `path`. */
const frozenIn = (path: string, text: string) => frozenLineAt(new FakeEditor(text, 1), { path }, layout, isShed);

beforeEach(() => {
	Notice.messages.length = 0;
});

describe("frozenLineAt outside the day's log", () => {
	const text = ["# Note", FROZEN, ""].join("\n");

	// If wrong: code still gated on the day's log answers null for the ordinary note, and code that
	// dropped the note check answers a frozen line for the collection and the template.
	it("recognises the line in an ordinary note", () => {
		expect(frozenIn(MEETING_PATH, text)?.marker.id).toBe("k1abcd");
	});

	it("does not recognise the same line in a collection, in an excluded folder, or in fenced text", () => {
		expect(frozenIn(SHED.path, text)).toBeNull();
		expect(frozenIn("Templates/Meeting.md", text)).toBeNull();
		expect(frozenIn(MEETING_PATH, ["# Note", "```", FROZEN, "```", ""].join("\n"))).toBeNull();
	});

	it("does not recognise the line in the frontmatter of an ordinary note", () => {
		// A frozen-looking line between the fences at the top: the note's properties, not a task.
		expect(frozenLineAt(new FakeEditor(["---", FROZEN, "---", ""].join("\n"), 1), { path: MEETING_PATH }, layout, isShed)).toBeNull();
	});

	it("still recognises it in a day's log, and does not take the collection's own copy for one", () => {
		expect(frozenIn(LOG_PATH, text)?.marker.id).toBe("k1abcd");
		expect(frozenIn(MEETING_PATH, ["# Note", `- [ ] Varnish the spare oars ${MARKER}`, ""].join("\n"))).toBeNull();
	});

	it("asks the collections index now: a note that has become a collection stops being one", () => {
		let collection = false;
		const asks = (): boolean => collection;
		const line = () => frozenLineAt(new FakeEditor(text, 1), { path: MEETING_PATH }, layout, asks);
		expect(line()).not.toBeNull();
		collection = true;
		expect(line()).toBeNull();
	});
});

/** Files the oars line of the meeting note into Garden shed; answers the texts either side. */
async function filedFromMeeting(): Promise<{ plugin: Plugin; meeting: string; collection: string; log: string }> {
	const { plugin } = await startMigration({ extraNotes: { "Meetings/Lantern committee.md": MEETING } });
	const editor = new FakeEditor(MEETING, OAR_LINE);
	const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:file-task`);
	(command as unknown as { editorCheckCallback: (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } }) => void }).editorCheckCallback(false, editor, {
		file: { path: MEETING_PATH },
	});
	await lastChooser().chooseAt("Garden shed", 0);
	await vi.waitFor(() => expect(Notice.messages).toContain("Put this task in Garden shed."));
	// The meeting note is in no tab afterwards; the vault holds what the filing wrote.
	plugin.app.vault.readableContents()?.set(MEETING_PATH, editor.getValue());
	return { plugin, meeting: editor.getValue(), collection: await read(plugin, SHED.path), log: await read(plugin, LOG_PATH) };
}

/** Opens the menu on `editor`, whose pressed line the caller has named, in the meeting note, and answers it. */
function rightClickFrozen(plugin: Plugin, editor: FakeEditor & { pressedLine?: number | null }): Menu {
	const menu = new Menu();
	plugin.app.workspace.fire("editor-menu", menu, editor, { file: { path: MEETING_PATH } });
	return menu;
}

const entry = (menu: Menu, title: string) => menu.items.find((each) => each.title === title);

describe("the jump and undo entries on a frozen line in an ordinary note", () => {
	it("are offered on the frozen line and nowhere else in the note", async () => {
		const { plugin, meeting } = await filedFromMeeting();
		const frozenAt = meeting.split("\n").findIndex((each) => each.startsWith("- [>]"));
		expect(frozenAt, "filing froze no line, so the test cannot fail").toBeGreaterThan(-1);

		const onFrozen = rightClickFrozen(plugin, pressLine(new FakeEditor(meeting, 0), frozenAt)).items.map((each) => each.title);
		// Cursor on the frozen line, click on prose: the entries follow the click.
		const editor = new FakeEditor(meeting, frozenAt) as FakeEditor & { pressedLine?: number };
		editor.pressedLine = 2;
		const onProse = rightClickFrozen(plugin, editor).items.map((each) => each.title);

		expect(onFrozen).toEqual(expect.arrayContaining([JUMP_ENTRY_TITLE, UNDO_ENTRY_TITLE]));
		expect(onProse).not.toContain(JUMP_ENTRY_TITLE);
		expect(onProse).not.toContain(UNDO_ENTRY_TITLE);
	});
});

describe("undo of a filing made from an ordinary note", () => {
	// If wrong: an undo that still wrote the day's log would change its bytes and leave the meeting
	// note frozen; one that left the collection's copy would leave the task in both notes.
	it("puts the original line back in the note, takes the collection's copy out and does not write the day's log", async () => {
		const { plugin, meeting, collection, log } = await filedFromMeeting();
		expect(collection, "filing put nothing in the collection, so the test cannot fail").toContain("Varnish the spare oars");
		const frozenAt = meeting.split("\n").findIndex((each) => each.startsWith("- [>]"));
		const editor = pressLineAwayFromCursor(new FakeEditor(meeting, frozenAt), frozenAt);
		const before = await read(plugin, SHED.path);

		entry(rightClickFrozen(plugin, editor), UNDO_ENTRY_TITLE)?.click();
		await vi.waitFor(() => expect(Notice.messages.some((each) => each.startsWith("Undone"))).toBe(true));

		expect(editor.getValue()).toBe(MEETING);
		expect(await read(plugin, SHED.path)).not.toContain("Varnish the spare oars");
		expect(await read(plugin, SHED.path)).toBe(before.split("\n").filter((each) => !each.includes("Varnish the spare oars")).join("\n"));
		expect(await read(plugin, LOG_PATH)).toBe(log);
		expect(await read(plugin, LOG_PATH)).toBe(LOG);
		expect(Notice.messages).toContain("Undone. The task is back in the note and no longer in Garden shed.");
	});

	// If wrong: an undo that ignored the tick would restore the line over a task the person completed.
	it("is refused once the collection's line was ticked, in a sentence that names the collection and never the day's log", async () => {
		const { plugin, meeting, collection } = await filedFromMeeting();
		const ticked = collection.replace("- [ ] Varnish the spare oars", "- [x] Varnish the spare oars");
		expect(ticked, "the copy was not ticked, so the test cannot fail").not.toBe(collection);
		plugin.app.vault.readableContents()?.set(SHED.path, ticked);
		const frozenAt = meeting.split("\n").findIndex((each) => each.startsWith("- [>]"));
		const editor = pressLineAwayFromCursor(new FakeEditor(meeting, frozenAt), frozenAt);

		entry(rightClickFrozen(plugin, editor), UNDO_ENTRY_TITLE)?.click();
		await vi.waitFor(() => expect(Notice.messages.some((each) => each.includes("nothing was undone"))).toBe(true));

		expect(Notice.messages.filter((each) => each.includes("nothing was undone"))).toEqual(["The task in Garden shed has been changed or ticked since it was put there, so nothing was undone."]);
		expect(editor.getValue()).toBe(meeting);
		expect(await read(plugin, SHED.path)).toBe(ticked);
	});

	// If wrong: a sentence still hard-wired to the day's log would say so about a meeting note; and
	// handed the day's log kind, the same call must still say it, so the wording is chosen by the kind.
	it("names the note in the sentence for a frozen line that has gone, and the day's log when told it is one", async () => {
		const { plugin, meeting } = await filedFromMeeting();
		const id = /migration:(\S+)/.exec(meeting)?.[1] as string;
		plugin.app.vault.readableContents()?.set(MEETING_PATH, MEETING);
		const world: UndoWorld = {
			app: plugin.app as never,
			notes: new NoteWriter(plugin.app.vault as never, { path: () => null, onChange: () => undefined }),
			collections: { all: () => [SHED] },
		};

		expect(await undoFilings(world, MEETING_PATH, [id], SHED.path, null, ORDINARY_NOTE)).toBe("The task's line in the note is not there any more, so nothing was undone.");
		expect(await undoFilings(world, MEETING_PATH, [id], SHED.path, null, DAY_LOG)).toBe("The task's line in the day's log is not there any more, so nothing was undone.");
		expect(await undoFilings(world, "Meetings/Missing.md", [id], SHED.path, null, ORDINARY_NOTE)).toBe("The note is not in the vault any more, so nothing was undone.");
	});
});
