/**
 * Each editor-menu entry, clicked through to its effect with the cursor on
 * another line, and
 * left out where its action cannot run.
 *
 * `CLAUDE.md`: "An editor-menu entry decides from the line that was pressed,
 * never the cursor's line, and offers itself only on a line where its action
 * can run." Three entries exist, all Migration's: filing, jump and undo. The
 * filing runs through the real feature, and each entry through the registry's
 * `editor-menu` event (`migrationHarness.ts`); nothing here mocks the jump, the
 * undo or the chooser. Obsidian moves the cursor to the pressed line only after
 * it fires `editor-menu`, and not reliably before the entry runs, so
 * every entry is handed the pressed line and each test leaves the cursor on
 * another line through the click, where an entry that read the cursor would
 * find prose. Every name and task is invented.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView, Menu, Notice } from "./__mocks__/obsidian";
import type { Plugin } from "./__mocks__/obsidian";
import { FILE_ENTRY_TITLE, JUMP_ENTRY_TITLE, UNDO_ENTRY_TITLE } from "../features/migration/menu";
import { pressLine } from "./editorMenu";
import { FakeEditor, SHED, installMigrationHooks, lastChooser, read, startMigration } from "./migrationHarness";

installMigrationHooks();

const MEETING_PATH = "Meetings/Lantern committee.md";
const PRESENT = "Present: [[Ada Fenwick]]";
const OARS = "- [ ] Varnish the spare oars";
const RIBBON = "- [ ] Untangle the ribbon";
const MEETING = ["# Lantern committee", "", PRESENT, "", "## Decisions and actions", OARS, RIBBON, ""].join("\n");
const PRESENT_LINE = 2;
const OAR_LINE = 5;
const RIBBON_LINE = 6;

beforeEach(() => {
	Notice.messages.length = 0;
	Notice.fragments.length = 0;
});

/** The collection's editor, as the jump finds it after opening the collection: the cursor is whatever `setCursor` last set. */
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

/** Opens the menu on `pressed` with the cursor on `cursor`, and answers the menu and the editor. */
function open(plugin: Plugin, text: string, cursor: number, pressed: number): { menu: Menu; editor: FakeEditor } {
	const editor = pressLine(new FakeEditor(text, cursor), pressed);
	const menu = new Menu();
	plugin.app.workspace.fire("editor-menu", menu, editor, { file: { path: MEETING_PATH } });
	return { menu, editor };
}

const entry = (menu: Menu, title: string) => menu.items.find((each) => each.title === title);
const titles = (menu: Menu): string[] => menu.items.map((each) => each.title);

async function started(): Promise<Plugin> {
	return (await startMigration({ extraNotes: { [MEETING_PATH]: MEETING } })).plugin;
}

/** Files the oars line into Garden shed by the command, and answers the plugin, the meeting note as filed and the collection. */
async function filedOars(): Promise<{ plugin: Plugin; meeting: string; collection: string }> {
	const plugin = await started();
	const editor = new FakeEditor(MEETING, OAR_LINE);
	const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:file-task`);
	(command as unknown as { editorCheckCallback: (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } }) => void }).editorCheckCallback(false, editor, {
		file: { path: MEETING_PATH },
	});
	await lastChooser().chooseAt("Garden shed", 0);
	await vi.waitFor(() => expect(Notice.messages).toContain("Put this task in Garden shed."));
	const meeting = editor.getValue();
	plugin.app.vault.readableContents()?.set(MEETING_PATH, meeting);
	expect(meeting.split("\n").some((each) => each.startsWith("- [>]")), "filing froze no line, so the tests below cannot fail").toBe(true);
	return { plugin, meeting, collection: await read(plugin, SHED.path) };
}

describe("the stub refuses a menu opened without naming the pressed line", () => {
	// If wrong: a stub that fell back to the cursor's line would open the menu quietly and this would not throw.
	it("throws, quoting the rule from CLAUDE.md", async () => {
		const plugin = await started();
		const editor = new FakeEditor(MEETING, OAR_LINE);
		expect(() => plugin.app.workspace.fire("editor-menu", new Menu(), editor, { file: { path: MEETING_PATH } })).toThrow(
			/decides from the line that was pressed, never the cursor's line, and offers itself only on a line where its action can run/,
		);
	});

	// If wrong: a stub that threw on `null` too would break every test of a menu opened with no mouse event.
	it("lets a menu opened with no mouse event through, adding no entry", async () => {
		const plugin = await started();
		const editor = pressLine(new FakeEditor(MEETING, OAR_LINE), null);
		const menu = new Menu();
		plugin.app.workspace.fire("editor-menu", menu, editor, { file: { path: MEETING_PATH } });
		expect(menu.items).toEqual([]);
	});

	// If wrong: a helper that let the two lines be one would let a test slip back to pressing the cursor's own line.
	it("pressLine refuses a cursor that is on the pressed line", () => {
		expect(() => pressLine(new FakeEditor(MEETING, OAR_LINE), OAR_LINE)).toThrow(/pressCursorLine/);
	});
});

describe("filing entry", () => {
	// If wrong: an entry that reads the cursor's line finds prose there, is not offered, and `entry(...)` is
	// undefined; one that files the cursor's line files nothing of the oars.
	it("files the pressed task, not the one under the cursor, when clicked", async () => {
		const plugin = await started();
		const { menu, editor } = open(plugin, MEETING, PRESENT_LINE, OAR_LINE);
		const filing = entry(menu, FILE_ENTRY_TITLE);
		expect(filing, `the entry was not offered on the pressed task line; the menu held ${JSON.stringify(titles(menu))}`).toBeDefined();

		filing?.click();
		await lastChooser().chooseAt("Garden shed", 0);
		await vi.waitFor(() => expect(Notice.messages).toContain("Put this task in Garden shed."));

		expect(await read(plugin, SHED.path)).toContain("Varnish the spare oars");
		expect(await read(plugin, SHED.path)).not.toContain("Untangle the ribbon");
		expect(editor.getLine(OAR_LINE).startsWith("- [>]")).toBe(true);
		expect(editor.getLine(RIBBON_LINE)).toBe(RIBBON);
		expect(editor.getLine(PRESENT_LINE)).toBe(PRESENT);
	});

	// If wrong: an entry that reads the cursor's line sits on the oars task and is offered on prose.
	it("is not offered on prose, with the cursor on a task", async () => {
		const plugin = await started();
		expect(titles(open(plugin, MEETING, OAR_LINE, PRESENT_LINE).menu)).toEqual([]);
	});
});

describe("jump entry", () => {
	// If wrong: a jump that reads the cursor's line reads prose, finds no marker and opens nothing, so the
	// collection's cursor never moves from -1.
	it("opens the task's collection at its line, with the cursor on prose", async () => {
		const { plugin, meeting, collection } = await filedOars();
		const frozenAt = meeting.split("\n").findIndex((each) => each.startsWith("- [>]"));
		const expected = collection.split("\n").findIndex((each) => each.includes("Varnish the spare oars"));
		expect(expected, "the collection holds no copy, so the jump has nowhere to land").toBeGreaterThan(-1);
		plugin.app.metadataCache.caches.set(SHED.path, {});
		const collectionEditor = new PlacingFake(collection);
		const view = new MarkdownView({ path: SHED.path }, collection, "source");
		(view as unknown as { editor: PlacingFake }).editor = collectionEditor;
		plugin.app.workspace.activeView = view;

		const { menu } = open(plugin, meeting, PRESENT_LINE, frozenAt);
		const jumping = entry(menu, JUMP_ENTRY_TITLE);
		expect(jumping, `the entry was not offered on the frozen line; the menu held ${JSON.stringify(titles(menu))}`).toBeDefined();
		Notice.messages.length = 0;
		jumping?.click();

		await vi.waitFor(() => expect(collectionEditor.cursor.line).not.toBe(-1), { timeout: 500 });
		expect(collectionEditor.cursor).toEqual({ line: expected, ch: 0 });
		expect(Notice.messages).toEqual([]);
	});

	// If wrong: a jump entry that reads the cursor's line sits on the frozen line and is offered on prose.
	it("is not offered on prose, with the cursor on the frozen line", async () => {
		const { plugin, meeting } = await filedOars();
		const frozenAt = meeting.split("\n").findIndex((each) => each.startsWith("- [>]"));
		expect(titles(open(plugin, meeting, frozenAt, PRESENT_LINE).menu)).toEqual([]);
	});
});

describe("undo entry", () => {
	// If wrong: an undo that reads the cursor's line reads prose and restores nothing, so the meeting note
	// stays frozen and the collection keeps its copy.
	it("restores the pressed frozen line and takes the collection's copy out, with the cursor on prose", async () => {
		const { plugin, meeting } = await filedOars();
		const frozenAt = meeting.split("\n").findIndex((each) => each.startsWith("- [>]"));

		const { menu, editor } = open(plugin, meeting, PRESENT_LINE, frozenAt);
		const undoing = entry(menu, UNDO_ENTRY_TITLE);
		expect(undoing, `the entry was not offered on the frozen line; the menu held ${JSON.stringify(titles(menu))}`).toBeDefined();
		undoing?.click();
		await vi.waitFor(() => expect(Notice.messages.some((each) => each.startsWith("Undone"))).toBe(true), { timeout: 500 });

		expect(editor.getValue()).toBe(MEETING);
		expect(await read(plugin, SHED.path)).not.toContain("Varnish the spare oars");
	});

	// If wrong: an undo entry that reads the cursor's line sits on the frozen line and is offered on prose.
	it("is not offered on prose, with the cursor on the frozen line", async () => {
		const { plugin, meeting } = await filedOars();
		const frozenAt = meeting.split("\n").findIndex((each) => each.startsWith("- [>]"));
		expect(titles(open(plugin, meeting, frozenAt, PRESENT_LINE).menu)).toEqual([]);
	});
});
