/**
 * The jump and undo entries decide from the line that was pressed, and undo
 * writes the frozen line the place rule accepts
 * (#993,
 * #995 and
 * #992, all found against
 * #983).
 *
 * The filing runs through the real Migration feature and each entry through the
 * registry's `editor-menu` event (`migrationHarness.ts`); nothing here mocks the
 * jump or the undo. Every folder, name and task is invented.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView, Menu, Notice, WorkspaceLeaf } from "./__mocks__/obsidian";
import type { Plugin } from "./__mocks__/obsidian";
import { JUMP_ENTRY_TITLE, UNDO_ENTRY_TITLE } from "../features/migration/menu";
import { FakeEditor, LOG, LOG_PATH, SHED, installMigrationHooks, lastChooser, read, startMigration } from "./migrationHarness";

installMigrationHooks();

const MEETING_PATH = "Meetings/Lantern committee.md";
const OARS = "- [ ] Varnish the spare oars";
const MEETING = ["# Lantern committee", "", "Present: [[Ada Fenwick]]", "", "## Decisions and actions", OARS, ""].join("\n");
const OAR_LINE = 5;

beforeEach(() => {
	Notice.messages.length = 0;
	Notice.fragments.length = 0;
});

/** An editor with real state for the collection the jump opens: the cursor is whatever `setCursor` last set. */
class PlacingFake {
	cursor = { line: -1, ch: -1 };
	constructor(private text: string) {}
	getValue(): string {
		return this.text;
	}
	setCursor(pos: { line: number; ch: number }): void {
		this.cursor = pos;
	}
}

type Filed = { plugin: Plugin; meeting: string; collection: string; frozen: string };

/** Files the oars line of the meeting note into Garden shed, and answers the texts either side and the frozen line. */
async function filedFromMeeting(): Promise<Filed> {
	const { plugin } = await startMigration({ extraNotes: { [MEETING_PATH]: MEETING } });
	const editor = new FakeEditor(MEETING, OAR_LINE);
	const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:file-task`);
	(command as unknown as { editorCheckCallback: (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } }) => void }).editorCheckCallback(false, editor, {
		file: { path: MEETING_PATH },
	});
	await lastChooser().chooseAt("Garden shed", 0);
	await vi.waitFor(() => expect(Notice.messages).toContain("Put this task in Garden shed."));
	const meeting = editor.getValue();
	// The meeting note is in no tab afterwards; the vault holds what the filing wrote.
	plugin.app.vault.readableContents()?.set(MEETING_PATH, meeting);
	const frozen = meeting.split("\n").find((each) => each.startsWith("- [>]"));
	expect(frozen, "filing froze no line, so the tests below cannot fail").toBeDefined();
	return { plugin, meeting, collection: await read(plugin, SHED.path), frozen: frozen as string };
}

/** Right-clicks `pressed` in `editor` (whose cursor is wherever it was made to be) and answers the menu. */
function rightClick(plugin: Plugin, text: string, cursor: number, pressed: number): { menu: Menu; editor: FakeEditor } {
	const editor = Object.assign(new FakeEditor(text, cursor), { pressedLine: pressed });
	const menu = new Menu();
	plugin.app.workspace.fire("editor-menu", menu, editor, { file: { path: MEETING_PATH } });
	return { menu, editor };
}

const entry = (menu: Menu, title: string) => menu.items.find((each) => each.title === title);

describe("#993: the jump entry jumps from the line that was pressed", () => {
	// If wrong: a jump that reads the cursor's line reads the prose line, finds no marker and opens
	// nothing, so the collection's cursor never moves; on the current code this test reports exactly that.
	it("opens the task's collection at its line when the cursor sits on prose and the pressed line is the frozen one", async () => {
		const { plugin, meeting, collection } = await filedFromMeeting();
		const frozenAt = meeting.split("\n").findIndex((each) => each.startsWith("- [>]"));
		const expected = collection.split("\n").findIndex((each) => each.includes("Varnish the spare oars"));
		expect(expected, "the collection holds no copy, so the jump has nowhere to land").toBeGreaterThan(-1);
		// The jump resolves the frozen line's link through the metadata cache, as Obsidian does.
		plugin.app.metadataCache.caches.set(SHED.path, {});
		const collectionEditor = new PlacingFake(collection);
		const view = new MarkdownView({ path: SHED.path }, collection, "source");
		(view as unknown as { editor: PlacingFake }).editor = collectionEditor;
		plugin.app.workspace.activeView = view;

		const { menu } = rightClick(plugin, meeting, 2, frozenAt);
		Notice.messages.length = 0;
		entry(menu, JUMP_ENTRY_TITLE)?.click();

		await vi.waitFor(() => expect(collectionEditor.cursor.line).not.toBe(-1), { timeout: 500 });
		expect(collectionEditor.cursor).toEqual({ line: expected, ch: 0 });
		expect(Notice.messages).toEqual([]);
	});
});

/**
 * The meeting note quoting its frozen line above the real one: in a fenced block, or in the frontmatter.
 * Answers the note as filed (the real line frozen) and as an undo of the real line must leave it.
 */
const QUOTED = {
	"a fenced block": (line: string) => ["# Lantern committee", "", "```md", "QUOTE", "```", "", "## Decisions and actions", line, ""],
	"the frontmatter": (line: string) => ["---", "QUOTE", "---", "", "## Decisions and actions", line, ""],
} as const;

function quoting(where: keyof typeof QUOTED, frozen: string): { doc: string; undone: string; realAt: number } {
	const build = (line: string): string[] => QUOTED[where](line).map((each) => (each === "QUOTE" ? frozen : each));
	const doc = build(frozen);
	return { doc: doc.join("\n"), undone: build(OARS).join("\n"), realAt: doc.length - 2 };
}

describe("#995: undo writes the frozen line the place rule accepts, never a quoted copy of it", () => {
	// If wrong: an undo that writes the first line carrying the id replaces the quoted line in the block
	// and leaves the real line frozen, so the whole-file comparison below fails on the current code.
	it.each(Object.keys(QUOTED) as (keyof typeof QUOTED)[])("from the right-click entry on the real line, with a copy quoted in %s above it", async (where) => {
		const { plugin, frozen } = await filedFromMeeting();
		const { doc, undone, realAt } = quoting(where, frozen);
		expect(doc.split("\n")[realAt], "the fixture's real line is not the frozen one, so the test cannot fail").toBe(frozen);
		plugin.app.vault.readableContents()?.set(MEETING_PATH, doc);

		const { menu, editor } = rightClick(plugin, doc, 0, realAt);
		entry(menu, UNDO_ENTRY_TITLE)?.click();
		await vi.waitFor(() => expect(Notice.messages.some((each) => each.startsWith("Undone"))).toBe(true), { timeout: 500 });

		expect(editor.getValue()).toBe(undone);
	});

	// If wrong: the notice route finds the first line carrying the id in the text it reads, the quoted
	// one, so the note ends with the quoted line restored and the real one still frozen.
	it.each(Object.keys(QUOTED) as (keyof typeof QUOTED)[])("from the notice's button, with a copy quoted in %s above the real line", async (where) => {
		const { plugin, frozen } = await filedFromMeeting();
		const { doc, undone } = quoting(where, frozen);
		plugin.app.vault.readableContents()?.set(MEETING_PATH, doc);
		const button = Notice.fragments[Notice.fragments.length - 1]?.querySelector("button");
		expect(button?.textContent, "the filing showed no notice with a button").toBe("Undo migration");
		Notice.messages.length = 0;

		button?.click();
		await vi.waitFor(() => expect(Notice.messages.some((each) => each.startsWith("Undone"))).toBe(true), { timeout: 500 });

		expect(await read(plugin, MEETING_PATH)).toBe(undone);
	});

	// If wrong: a note whose only frozen-looking line is quoted would be written all the same and say
	// "Undone"; the right answer is that the task's line is not there.
	it("from the notice's button, refuses when the only line carrying the id is quoted in a fenced block", async () => {
		const { plugin, frozen, collection } = await filedFromMeeting();
		const doc = ["# Lantern committee", "", "```md", frozen, "```", ""].join("\n");
		plugin.app.vault.readableContents()?.set(MEETING_PATH, doc);
		const button = Notice.fragments[Notice.fragments.length - 1]?.querySelector("button");
		Notice.messages.length = 0;

		button?.click();
		await vi.waitFor(() => expect(Notice.messages).not.toHaveLength(0), { timeout: 500 });

		expect(Notice.messages).toEqual(["The task's line in the note is not there any more, so nothing was undone."]);
		expect(await read(plugin, MEETING_PATH)).toBe(doc);
		expect(await read(plugin, SHED.path)).toBe(collection);
	});
});

describe("#992: the refusal when the collection's line is ticked during the write names the note it was undone from", () => {
	// If wrong: code that ignored the note kind would say "The day's log and Garden shed are as they
	// were" about a meeting note, and this exact sentence would not match. The same call from a day's log
	// says "The day's log and Garden shed …" (`migrationUndoActiveCollection.test.ts`, the refusal test).
	it("says \"The note and Garden shed are as they were.\" from an ordinary note, and leaves both notes as they were", async () => {
		const { plugin, meeting, collection, frozen } = await filedFromMeeting();
		// The person ticks the copy in the open collection tab and has not saved: the vault still holds
		// the filed line, so the check before the write passes and only the write's own read sees the tick.
		const ticked = collection.replace("- [ ] Varnish the spare oars", "- [x] Varnish the spare oars");
		expect(ticked, "the copy was not ticked, so the test cannot fail").not.toBe(collection);
		const collectionEditor = new FakeEditor(ticked, 0);
		const view = new MarkdownView({ path: SHED.path }, ticked);
		view.editor = collectionEditor as never;
		plugin.app.workspace.leaves.push(new WorkspaceLeaf(view));
		const frozenAt = meeting.split("\n").indexOf(frozen);

		const { menu, editor } = rightClick(plugin, meeting, 0, frozenAt);
		Notice.messages.length = 0;
		entry(menu, UNDO_ENTRY_TITLE)?.click();
		await vi.waitFor(() => expect(Notice.messages).not.toHaveLength(0), { timeout: 500 });
		// Nothing more arrives late: one Notice for the one undo.
		await new Promise((settle) => setTimeout(settle, 50));

		expect(Notice.messages).toEqual(["The task in Garden shed was changed just now, so nothing was undone. The note and Garden shed are as they were."]);
		expect(editor.getValue()).toBe(meeting);
		expect(collectionEditor.getValue()).toBe(ticked);
	});
});

describe("undo from the notice's button on an ordinary note, with no editor open", () => {
	// If wrong: an undo that worked out the note's kind wrongly would write the day's log (its bytes
	// would differ from `LOG`) or say "the day's log"; one that left the note frozen would fail the first line.
	it("puts the task back in the note and leaves the day's log's bytes as they were", async () => {
		const { plugin, meeting, collection } = await filedFromMeeting();
		expect(meeting, "filing did not freeze the note, so the test cannot fail").not.toBe(MEETING);
		const button = Notice.fragments[Notice.fragments.length - 1]?.querySelector("button");
		expect(button?.textContent, "the filing showed no notice with a button").toBe("Undo migration");
		Notice.messages.length = 0;

		button?.click();
		await vi.waitFor(() => expect(Notice.messages).not.toHaveLength(0), { timeout: 500 });

		expect(Notice.messages).toEqual(["Undone. The task is back in the note and no longer in Garden shed."]);
		expect(await read(plugin, MEETING_PATH)).toBe(MEETING);
		expect(await read(plugin, LOG_PATH)).toBe(LOG);
		expect(await read(plugin, SHED.path)).not.toBe(collection);
	});
});
