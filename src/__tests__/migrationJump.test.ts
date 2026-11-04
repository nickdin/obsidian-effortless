/**
 * Going from a frozen `[>]` line to the task put in a collection.
 *
 * `readMarker`, `collectionLinktextOf` and `jumpFromLine` are tested over a
 * hand-built `JumpTarget`, the way `taskConsistencyJump.test.ts` tests its own:
 * opening a leaf holds no decision. The command's check callback and the
 * composition — a task put in a collection through the real command, then
 * jumped to — run through the real registry from `migrationHarness.ts`. Every
 * folder, name and task is invented.
 *
 * **The one test that runs #856's filing and the core's jump together** is
 * "lands on the task that was put in the collection, with a line added above it
 * since".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView, Menu, Notice } from "./__mocks__/obsidian";
import type { Plugin } from "./__mocks__/obsidian";
import { Problems } from "../core/problems";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { canJumpFrom, collectionLinktextOf, jumpFromLine, readMarker } from "../features/migration/jump";
import type { JumpTarget } from "../features/migration/jump";
import { jumpEntry } from "../features/migration/menu";
import {
	FakeEditor,
	LOG,
	LOG_PATH,
	SHED,
	installMigrationHooks,
	lastChooser,
	read,
	startMigration,
} from "./migrationHarness";

installMigrationHooks();

const FILED = "- [>] Order more tea [[Garden shed]] %% migration:k1abcd 0a1b2c3d %%";
const COPY = "- [ ] Order more tea %% migration:k1abcd 0a1b2c3d %%";
const OTHER_FEATURE = "- [ ] Order more tea %% task-consistency:k1abcd 0a1b2c3d %% → [[Garden shed]]";

const SHED_PATH = "Projects/Garden shed.md";

/** The layout the harness gives the feature: a day's log is `Journal/YYYY-MM-DD.md`. */
function layout(): VaultLayout {
	return { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
}

beforeEach(() => {
	Notice.messages.length = 0;
});

/** An editor with real state: `getValue` answers what it holds now, and the cursor is whatever `setCursor` last set. */
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

/** A `JumpTarget` over plain state, recording what was opened. */
function targetOver(state: { collectionText: string | null; isCollection?: boolean; linkResolves?: boolean; editor?: PlacingFake }) {
	const opened: string[] = [];
	const editor = state.editor ?? new PlacingFake(state.collectionText ?? "");
	const target: JumpTarget = {
		resolveLink: () => (state.linkResolves === false ? null : SHED_PATH),
		isCollection: () => state.isCollection !== false,
		readText: async () => {
			if (state.collectionText === null) throw new Error("gone");
			return state.collectionText;
		},
		open: async (path) => {
			opened.push(path);
			return editor;
		},
		notify: (message) => {
			new Notice(message);
		},
	};
	return { target, opened, editor };
}

function freshProblems(): { problems: Problems; channel: ReturnType<Problems["forFeature"]> } {
	const problems = new Problems();
	return { problems, channel: problems.forFeature("migration", "Migration") };
}

describe("readMarker and canJumpFrom", () => {
	it("reads the id and the hash out of this feature's own comment", () => {
		expect(readMarker(FILED)).toEqual({ id: "k1abcd", hash: "0a1b2c3d", carriesLink: false });
		expect(canJumpFrom(FILED)).toBe(true);
	});

	it("finds nothing on a task line without a comment", () => {
		expect(readMarker("- [ ] Order more tea")).toBeNull();
		expect(canJumpFrom("- [ ] Order more tea")).toBe(false);
	});

	it("finds nothing on a line carrying only another feature's comment, even with the same id", () => {
		expect(readMarker(OTHER_FEATURE)).toBeNull();
		expect(canJumpFrom(OTHER_FEATURE)).toBe(false);
	});

	it("finds nothing in a comment that is not an id and a hash", () => {
		expect(readMarker("- [>] Tea %% migration:k1abcd %%")).toBeNull();
		expect(readMarker("- [>] Tea %% migration:k1 ab cd %%")).toBeNull();
	});

	it("does not offer a line that is not a task", () => {
		expect(canJumpFrom("Order more tea %% migration:k1abcd 0a1b2c3d %%")).toBe(false);
	});
});

describe("collectionLinktextOf", () => {
	it("is the appended link, and the last when the person's own words hold one", () => {
		expect(collectionLinktextOf("- [>] Ask [[Aunt Maria]] about tea [[Garden shed]] %% migration:k1abcd 0a1b2c3d %%")).toBe("Garden shed");
	});

	it("does not read a link inside a comment", () => {
		expect(collectionLinktextOf("- [>] Order tea %% migration:k1abcd 0a1b2c3d %% %% see [[Elsewhere]] %%")).toBeNull();
	});
});

describe("jumpFromLine", () => {
	it("puts the cursor on the task's line, counted from where it is now, not where it was", async () => {
		const collection = ["# Garden shed", "", "## Tasks", "", "- [ ] A line added since", COPY, ""].join("\n");
		const { target, opened, editor } = targetOver({ collectionText: collection });
		const { channel } = freshProblems();

		await jumpFromLine(target, channel, LOG_PATH, FILED);

		expect(opened).toEqual([SHED_PATH]);
		// Line 5 counted from zero: the added line sits above the copy.
		expect(editor.cursor).toEqual({ line: 5, ch: 0 });
		expect(Notice.messages).toEqual([]);
	});

	it("says so, opens nothing and moves no cursor when no line carries the id", async () => {
		const collection = ["# Garden shed", "", "## Tasks", "", "- [ ] Order more tea %% migration:zzzz99 0a1b2c3d %%", "- [ ] Sweep", ""].join("\n");
		const { target, opened, editor } = targetOver({ collectionText: collection });
		const { problems, channel } = freshProblems();

		await jumpFromLine(target, channel, LOG_PATH, FILED);

		expect(Notice.messages).toEqual(['Effortless: no line in "Garden shed" is still the one put there from this task. Nothing was changed.']);
		expect(opened, "nothing may be opened").toEqual([]);
		expect(editor.cursor).toEqual({ line: -1, ch: -1 });
		expect(editor.getValue()).toBe(collection);
		expect(problems.all(), "a task that is gone is not a standing problem").toEqual([]);
	});

	it("does not take another feature's comment carrying the same id for the task", async () => {
		const collection = ["# Garden shed", "", "## Tasks", "", OTHER_FEATURE, ""].join("\n");
		const { target, opened } = targetOver({ collectionText: collection });

		await jumpFromLine(target, freshProblems().channel, LOG_PATH, FILED);

		expect(opened).toEqual([]);
		expect(Notice.messages).toHaveLength(1);
	});

	it("says so once, and the cursor stays, when the task went between the read and the open", async () => {
		const editor = new PlacingFake("# Garden shed\n\n## Tasks\n\n- [ ] Sweep\n");
		const { target } = targetOver({ collectionText: COPY, editor });

		await jumpFromLine(target, freshProblems().channel, LOG_PATH, FILED);

		expect(Notice.messages).toEqual(['Effortless: no line in "Garden shed" is still the one put there from this task. Nothing was changed.']);
		expect(editor.cursor).toEqual({ line: -1, ch: -1 });
	});

	it("reports one standing problem, and no second on a repeat, when the linked note is gone", async () => {
		const { target, opened } = targetOver({ collectionText: null, linkResolves: false });
		const { problems, channel } = freshProblems();

		await jumpFromLine(target, channel, LOG_PATH, FILED);
		expect(problems.all()).toHaveLength(1);
		expect(problems.all()[0]).toMatchObject({ featureId: "migration", key: "collection-gone:k1abcd" });
		const afterFirst = [...Notice.messages];

		await jumpFromLine(target, channel, LOG_PATH, FILED);

		expect(problems.all(), "a repeat is the same problem").toHaveLength(1);
		expect(opened).toEqual([]);
		expect(afterFirst).toContain('Effortless: "Garden shed" is not a collection any more, so there is nowhere to go. Nothing was changed.');
		// The repeat still tells the person: the standing problem speaks once, the jump answers every time.
		expect(Notice.messages.filter((each) => each.startsWith('Effortless: "Garden shed"'))).toHaveLength(2);
	});

	it("reports the same standing problem when the note is there but is not a collection any more", async () => {
		const { target } = targetOver({ collectionText: COPY, isCollection: false });
		const { problems, channel } = freshProblems();

		await jumpFromLine(target, channel, LOG_PATH, FILED);
		await jumpFromLine(target, channel, LOG_PATH, FILED);

		expect(problems.all()).toHaveLength(1);
	});

	it("keeps two filings' broken pairings apart", async () => {
		const { target } = targetOver({ collectionText: null, linkResolves: false });
		const { problems, channel } = freshProblems();

		await jumpFromLine(target, channel, LOG_PATH, FILED);
		await jumpFromLine(target, channel, LOG_PATH, FILED.replace(/k1abcd/g, "m2wxyz"));

		expect(problems.all().map((each) => each.key)).toEqual(["collection-gone:k1abcd", "collection-gone:m2wxyz"]);
	});

	it("clears the standing problem once the collection is found again", async () => {
		const gone = targetOver({ collectionText: null, linkResolves: false });
		const { problems, channel } = freshProblems();
		await jumpFromLine(gone.target, channel, LOG_PATH, FILED);
		expect(problems.all()).toHaveLength(1);

		const back = targetOver({ collectionText: ["## Tasks", COPY].join("\n") });
		await jumpFromLine(back.target, channel, LOG_PATH, FILED);

		expect(problems.all()).toEqual([]);
		expect(back.editor.cursor).toEqual({ line: 1, ch: 0 });
	});

	it("says a line that names no collection has nowhere to go", async () => {
		const { target, opened } = targetOver({ collectionText: COPY });

		await jumpFromLine(target, freshProblems().channel, LOG_PATH, "- [>] Order more tea %% migration:k1abcd 0a1b2c3d %%");

		expect(opened).toEqual([]);
		expect(Notice.messages).toEqual(["Effortless: this task names no collection, so there is nowhere to go. Nothing was changed."]);
	});

	it("says why when the collection cannot be read", async () => {
		const { target } = targetOver({ collectionText: null });

		await jumpFromLine(target, freshProblems().channel, LOG_PATH, FILED);

		expect(Notice.messages).toEqual(['Effortless could not open "Garden shed": gone']);
	});
});

/** Where these tests right-click: the line their editor's cursor is on, which is all the line there is to ask here. */
const cursorLine = (_menu: unknown, editor: { getCursor(): { line: number } }): number => editor.getCursor().line;

describe("the right-click entry", () => {
	function menuOn(line: string, jump = vi.fn()): { menu: Menu; jump: ReturnType<typeof vi.fn> } {
		const menu = new Menu();
		jumpEntry(jump, layout, cursorLine, () => false)(menu as never, new FakeEditor(line, 0) as never, { file: { path: LOG_PATH } } as never);
		return { menu, jump };
	}

	it("is added on a line carrying this feature's own marker, and clicking it runs the jump on that editor and note", () => {
		const editor = new FakeEditor(FILED, 0);
		const menu = new Menu();
		const jump = vi.fn();

		jumpEntry(jump, layout, cursorLine, () => false)(menu as never, editor as never, { file: { path: LOG_PATH } } as never);

		expect(menu.items.map((item) => item.title)).toEqual(["Go to this task in its collection"]);
		menu.items[0].click();
		expect(jump).toHaveBeenCalledWith(editor, { path: LOG_PATH });
	});

	it("is not added on a task line with no marker", () => {
		expect(menuOn("- [ ] Order more tea").menu.items).toEqual([]);
	});

	it("is not added on a line carrying only another feature's marker", () => {
		expect(menuOn(OTHER_FEATURE).menu.items).toEqual([]);
	});

	it("is not added when the editor has no note behind it", () => {
		const menu = new Menu();
		jumpEntry(vi.fn(), layout, cursorLine, () => false)(menu as never, new FakeEditor(FILED, 0) as never, { file: null } as never);
		expect(menu.items).toEqual([]);
	});
});

type CheckCallback = (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } | null }) => boolean | void;

function commandOf(plugin: Plugin, id: string): CheckCallback {
	const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:${id}`);
	expect(command, `the ${id} command was not registered`).toBeDefined();
	return (command as unknown as { editorCheckCallback: CheckCallback }).editorCheckCallback;
}

describe("the jump command's check callback", () => {
	const lines = ["# Notes", "", FILED, "- [ ] Order more tea", OTHER_FEATURE, "Words %% migration:k1abcd 0a1b2c3d %%"].join("\n");

	it("is enabled on a line carrying this feature's own marker", async () => {
		const { plugin } = await startMigration();
		expect(commandOf(plugin, "jump-filed")(true, new FakeEditor(lines, 2), { file: { path: LOG_PATH } })).toBe(true);
	});

	it("is disabled on a line with no marker", async () => {
		const { plugin } = await startMigration();
		expect(commandOf(plugin, "jump-filed")(true, new FakeEditor(lines, 3), { file: { path: LOG_PATH } })).toBe(false);
	});

	it("is disabled on a line carrying only another feature's marker", async () => {
		const { plugin } = await startMigration();
		expect(commandOf(plugin, "jump-filed")(true, new FakeEditor(lines, 4), { file: { path: LOG_PATH } })).toBe(false);
	});

	it("is disabled on a line that is not a task", async () => {
		const { plugin } = await startMigration();
		expect(commandOf(plugin, "jump-filed")(true, new FakeEditor(lines, 5), { file: { path: LOG_PATH } })).toBe(false);
	});

	it("is registered with no default hotkey", async () => {
		const { plugin } = await startMigration();
		const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:jump-filed`);
		expect(command).toBeDefined();
		expect(command).not.toHaveProperty("hotkeys");
	});
});

describe("filing a task, then jumping to it", () => {
	let plugin: Plugin;

	afterEach(() => {
		Notice.messages.length = 0;
	});

	/** The frozen log after the command has filed the tea line into the shed, and the editor holding it. */
	async function fileTheTea(): Promise<FakeEditor> {
		const started = await startMigration({ collections: [SHED] });
		plugin = started.plugin;
		plugin.app.metadataCache.caches.set(SHED.path, {});
		const editor = new FakeEditor(LOG, 2);
		commandOf(plugin, "file-task")(false, editor, { file: { path: LOG_PATH } });
		await lastChooser().chooseAt("shed", 0);
		await vi.waitFor(() => expect(Notice.messages.some((each) => each.startsWith("Put this task in"))).toBe(true));
		Notice.messages.length = 0;
		return editor;
	}

	function lineOf(text: string, words: string): number {
		return text.split("\n").findIndex((each) => each.includes(words));
	}

	it("lands on the task that was put in the collection, with a line added above it since", async () => {
		const log = await fileTheTea();
		expect(log.getLine(2), "the frozen line must carry a link and a marker, or this proves nothing").toMatch(/^- \[>\] Order more tea \[\[Garden shed\]\] %% migration:\S+ \S+ \S+ \S+ %%$/);

		const filed = await read(plugin, SHED.path);
		const atFiling = lineOf(filed, "Order more tea");
		expect(atFiling, "the task must be in the collection").toBeGreaterThan(-1);

		// A line somebody adds above the filed task after the filing.
		await plugin.app.vault.process({ path: SHED.path }, (text: string) => text.replace("## Tasks\n\n", "## Tasks\n\n- [ ] A task added later\n"));
		const now = await read(plugin, SHED.path);
		const expected = lineOf(now, "Order more tea");
		expect(expected, "the added line must have moved the task down, or the id search is untested").toBe(atFiling + 1);

		const collectionEditor = new PlacingFake(now);
		const view = new MarkdownView({ path: SHED.path }, now, "source");
		(view as unknown as { editor: PlacingFake }).editor = collectionEditor;
		plugin.app.workspace.activeView = view;

		expect(commandOf(plugin, "jump-filed")(true, log, { file: { path: LOG_PATH } })).toBe(true);
		commandOf(plugin, "jump-filed")(false, log, { file: { path: LOG_PATH } });
		await vi.waitFor(() => expect(collectionEditor.cursor.line).not.toBe(-1));

		expect(collectionEditor.cursor).toEqual({ line: expected, ch: 0 });
		expect(now, "the jump wrote nothing").toBe(await read(plugin, SHED.path));
		expect(Notice.messages).toEqual([]);
	});
});
