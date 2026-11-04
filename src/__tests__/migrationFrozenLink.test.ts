/**
 * The link on the frozen line, when two collections share a name
 * (#871, against
 * #856; the drive gap of
 * #869 is folded in).
 *
 * The chooser tells two collections of one name apart by folder, so the link
 * written after choosing one must open that one from the day's log, whichever
 * of the two Obsidian would pick for the bare name. The harness resolves a
 * short link to the first note of that name in the vault's order
 * (`obsidianLinks`), so a test files into the *other* one: a link that is the
 * bare name resolves to the wrong note there. The four cases of the first
 * block run both notes in both orders, and **two of them can fail**: the ones
 * that file into the note listed second, where the bare name opens the wrong
 * note. The other two file into the note the bare name opens anyway, so they
 * pass on the old code too; they are there so a fix that only works for one order
 * shows. Which cases fail on the bare name was read off a run against `a18d3a4`'s
 * link (the two "second" cases failed there).
 *
 * **The compositions** are "files into the second same-named collection, then
 * undoes" and "files into the second same-named collection, then jumps": each
 * runs #856's filing with #862's undo or #861's jump over the real command.
 * Every folder, name and task is invented.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView, Menu, Notice } from "./__mocks__/obsidian";
import type { Plugin } from "./__mocks__/obsidian";
import { rewriteCollectionLinks } from "../core/collectionRename";
import { collectionLinktextOf, readMarker } from "../features/migration/marker";
import {
	FakeEditor,
	KITCHEN,
	LOG,
	LOG_PATH,
	collectionAt,
	installMigrationHooks,
	lastChooser,
	read,
	startMigration,
} from "./migrationHarness";
import { getLinkpath } from "./__mocks__/obsidian";
import { pressLineAwayFromCursor } from "./editorMenu";

installMigrationHooks();

const SHEDS = collectionAt("Projects/Garden shed.md", "Garden shed");
const OTHER = collectionAt("Ideas/Garden shed.md", "Garden shed");

beforeEach(() => {
	Notice.messages.length = 0;
});

interface Run {
	plugin: Plugin;
	editor: FakeEditor;
}

type LinkSettings = NonNullable<Parameters<typeof startMigration>[0]>["linkSettings"];

/** Files the tea line into `chosen` from a vault holding `collections`, by choosing its row in the chooser. */
async function fileInto(collections: typeof SHEDS[], chosen: typeof SHEDS, query = "garden shed", linkSettings?: LinkSettings): Promise<Run> {
	const { plugin } = await startMigration({ collections, obsidianLinks: true, linkSettings });
	const editor = new FakeEditor(LOG, 2);
	const command = plugin.commands.find((each) => each.id === `${plugin.manifest.id}:file-task`);
	(command as unknown as { editorCheckCallback: (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } }) => void }).editorCheckCallback(false, editor, { file: { path: LOG_PATH } });
	const rows = lastChooser().getSuggestions(query) as unknown as { item: { path: string } }[];
	const at = rows.findIndex((each) => each.item.path === chosen.path);
	expect(at, "the chooser must offer the chosen collection").toBeGreaterThan(-1);
	await lastChooser().chooseAt(query, at);
	await vi.waitFor(() => expect(Notice.messages.some((each) => each.startsWith("Put this task in"))).toBe(true));
	Notice.messages.length = 0;
	return { plugin, editor };
}

/** The path the link on the frozen line opens from the day's log, the way undo and the jump resolve it. */
function opens(run: Run): string | null {
	const linktext = collectionLinktextOf(run.editor.getLine(2));
	expect(linktext, "the frozen line must carry a link").not.toBeNull();
	return run.plugin.app.metadataCache.getFirstLinkpathDest(getLinkpath(linktext as string), LOG_PATH)?.path ?? null;
}

describe("the frozen line's link, two collections of one name", () => {
	it.each([
		["the one the vault lists second", [SHEDS, OTHER], OTHER],
		["the one the vault lists first", [SHEDS, OTHER], SHEDS],
		["the same two, listed the other way round: the second", [OTHER, SHEDS], SHEDS],
		["the same two, listed the other way round: the first", [OTHER, SHEDS], OTHER],
	])("opens %s when that one was chosen", async (_, collections, chosen) => {
		const run = await fileInto(collections, chosen);

		expect(opens(run)).toBe(chosen.path);
	});

	it("writes the plain short name for a collection whose name is its own", async () => {
		const run = await fileInto([SHEDS, KITCHEN], KITCHEN, "kitchen");

		expect(run.editor.getLine(2)).toMatch(/^- \[>\] Order more tea \[\[Kitchen\]\] %% migration:/);
		expect(opens(run)).toBe(KITCHEN.path);
	});
});

describe("filing into the second of two same-named collections, then undoing", () => {
	it("puts the task back from the note it was filed into and leaves the other alone", async () => {
		const run = await fileInto([SHEDS, OTHER], OTHER);
		expect(await read(run.plugin, OTHER.path), "the task must be in the chosen note").toContain("Order more tea");
		// The note that was not chosen holds a line with the same marker id and another hash: undo that
		// reads it first stops on "touched" and refuses, so a link that is the bare name — which opens
		// this note — fails the test, where undo trying every same-named note would have passed it.
		const id = readMarker(run.editor.getLine(2))?.id as string;
		const decoy = `${await read(run.plugin, SHEDS.path)}- [ ] Order more tea, reworded %% migration:${id} 00000000 %%\n`;
		run.plugin.app.vault.readableContents()?.set(SHEDS.path, decoy);
		const untouched = await read(run.plugin, SHEDS.path);

		const menu = new Menu();
		pressLineAwayFromCursor(run.editor, run.editor.getCursor().line);
		run.plugin.app.workspace.fire("editor-menu", menu, run.editor, { file: { path: LOG_PATH } });
		menu.items.find((each) => each.title === "Undo migration")?.click();
		await vi.waitFor(() => expect(Notice.messages.some((each) => each.startsWith("Undone") || each.includes("nothing was undone"))).toBe(true));

		expect(Notice.messages[Notice.messages.length - 1]).toMatch(/^Undone\./);
		expect(run.editor.getValue()).toBe(LOG);
		expect(await read(run.plugin, OTHER.path)).not.toContain("Order more tea");
		expect(await read(run.plugin, SHEDS.path)).toBe(untouched);
	});
});

describe("filing into the second of two same-named collections, then jumping", () => {
	it("lands on the task in the note it was filed into", async () => {
		const run = await fileInto([SHEDS, OTHER], OTHER);
		const filed = await read(run.plugin, OTHER.path);
		const expected = filed.split("\n").findIndex((each) => each.includes("Order more tea"));
		expect(expected).toBeGreaterThan(-1);

		const cursor = { line: -1, ch: -1 };
		const editor = { getValue: () => filed, getLine: (n: number) => filed.split("\n")[n], setCursor: (c: { line: number; ch: number }) => Object.assign(cursor, c), scrollIntoView: () => {}, getCursor: () => cursor };
		const view = new MarkdownView({ path: OTHER.path }, filed, "source");
		(view as unknown as { editor: unknown }).editor = editor;
		run.plugin.app.workspace.activeView = view;
		const jump = run.plugin.commands.find((each) => each.id === `${run.plugin.manifest.id}:jump-filed`);
		(jump as unknown as { editorCheckCallback: (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } }) => void }).editorCheckCallback(false, run.editor, { file: { path: LOG_PATH } });
		await vi.waitFor(() => expect(cursor.line).not.toBe(-1));

		expect(cursor.line).toBe(expected);
		expect(Notice.messages).toEqual([]);
	});
});

describe("reading the link back", () => {
	const MARKER = "%% migration:k1abcd 0a1b2c3d 0 %%";

	it.each([
		["a wikilink by path", `- [>] Order more tea [[Ideas/Garden shed]] ${MARKER}`, "Ideas/Garden shed"],
		["a wikilink by path with an alias", `- [>] Order more tea [[Ideas/Garden shed|the shed]] ${MARKER}`, "Ideas/Garden shed"],
		["a markdown link, its spaces written %20", `- [>] Order more tea [Garden shed](Ideas/Garden%20shed.md) ${MARKER}`, "Ideas/Garden shed.md"],
		["a markdown link, its path in angle brackets", `- [>] Order more tea [Garden shed](<Ideas/Garden shed.md>) ${MARKER}`, "Ideas/Garden shed.md"],
		["the last of two links, the person's own first", `- [>] See [[Attic]] and order tea [[Ideas/Garden shed]] ${MARKER}`, "Ideas/Garden shed"],
	])("names the note for %s", (_, line, expected) => {
		expect(collectionLinktextOf(line)).toBe(expected);
	});

	it("resolves a path-qualified link from the day's log to that note alone", async () => {
		const { plugin } = await startMigration({ collections: [SHEDS, OTHER], obsidianLinks: true });
		const linktext = collectionLinktextOf(`- [>] Order more tea [[Ideas/Garden shed]] ${MARKER}`);

		expect(plugin.app.metadataCache.getFirstLinkpathDest(getLinkpath(linktext as string), LOG_PATH)?.path).toBe(OTHER.path);
	});
});

// #900: the harness's link writer used to write only
// a wikilink and its resolver could not read a link ending in `.md`, so nothing in the suite filed under
// a markdown or relative link and then jumped or undid from it. Each case files into the note the bare
// name does NOT open (`OTHER`, listed second), so a link that is the bare name, a wrong path or one the
// resolver cannot read lands on `SHEDS` or on nothing, and the assertion fails.
describe.each([
	["markdown links, shortest", { useMarkdownLinks: true }, /\[Garden shed\]\(Ideas\/Garden%20shed\.md\)/],
	["markdown links, absolute", { useMarkdownLinks: true, newLinkFormat: "absolute" as const }, /\[Garden shed\]\(Ideas\/Garden%20shed\.md\)/],
	["wikilinks, relative", { newLinkFormat: "relative" as const }, /\[\[\.\.\/Ideas\/Garden shed\]\]/],
])("filing into the second same-named collection under %s", (_, settings, written) => {
	it("writes the link the setting asks for, and it opens the chosen note", async () => {
		const run = await fileInto([SHEDS, OTHER], OTHER, "garden shed", settings);

		expect(run.editor.getLine(2)).toMatch(written);
		expect(opens(run)).toBe(OTHER.path);
	});

	it("undoes from the chosen note, though the other holds a line with the same id and another hash", async () => {
		const run = await fileInto([SHEDS, OTHER], OTHER, "garden shed", settings);
		const id = readMarker(run.editor.getLine(2))?.id as string;
		run.plugin.app.vault.readableContents()?.set(SHEDS.path, `${await read(run.plugin, SHEDS.path)}- [ ] Order more tea, reworded %% migration:${id} 00000000 %%\n`);

		const menu = new Menu();
		pressLineAwayFromCursor(run.editor, run.editor.getCursor().line);
		run.plugin.app.workspace.fire("editor-menu", menu, run.editor, { file: { path: LOG_PATH } });
		menu.items.find((each) => each.title === "Undo migration")?.click();
		await vi.waitFor(() => expect(Notice.messages.some((each) => each.startsWith("Undone") || each.includes("nothing was undone"))).toBe(true));

		expect(Notice.messages[Notice.messages.length - 1]).toMatch(/^Undone\./);
		expect(run.editor.getValue()).toBe(LOG);
		expect(await read(run.plugin, OTHER.path)).not.toContain("Order more tea");
	});

	it("jumps to the task in the chosen note", async () => {
		const run = await fileInto([SHEDS, OTHER], OTHER, "garden shed", settings);
		const filed = await read(run.plugin, OTHER.path);
		const expected = filed.split("\n").findIndex((each) => each.includes("Order more tea"));
		expect(expected).toBeGreaterThan(-1);

		const cursor = { line: -1, ch: -1 };
		const editor = { getValue: () => filed, getLine: (n: number) => filed.split("\n")[n], setCursor: (c: { line: number; ch: number }) => Object.assign(cursor, c), scrollIntoView: () => {}, getCursor: () => cursor };
		const view = new MarkdownView({ path: OTHER.path }, filed, "source");
		(view as unknown as { editor: unknown }).editor = editor;
		run.plugin.app.workspace.activeView = view;
		const jump = run.plugin.commands.find((each) => each.id === `${run.plugin.manifest.id}:jump-filed`);
		(jump as unknown as { editorCheckCallback: (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } }) => void }).editorCheckCallback(false, run.editor, { file: { path: LOG_PATH } });
		await vi.waitFor(() => expect(cursor.line).not.toBe(-1));

		expect(cursor.line).toBe(expected);
		expect(Notice.messages).toEqual([]);
	});
});

describe("a uniquely named collection, under each link setting", () => {
	it.each([
		["wikilinks, shortest", {}, "[[Kitchen]]"],
		["markdown links, shortest", { useMarkdownLinks: true }, "[Kitchen](Kitchen.md)"],
		["wikilinks, absolute", { newLinkFormat: "absolute" as const }, "[[Projects/Kitchen]]"],
	])("is linked as %s writes it, and the link opens it", async (_, settings, written) => {
		const run = await fileInto([SHEDS, KITCHEN], KITCHEN, "kitchen", settings);

		expect(run.editor.getLine(2)).toContain(` ${written} `);
		expect(opens(run)).toBe(KITCHEN.path);
	});
});

// A notice names the collection by its note name, as the filing notice ("Put this task in Garden shed")
// does, however the frozen line's link spells it. Found by the wave 2 review of #871: with a path-qualified
// link the undo said "The task is not in Ideas/Garden shed.md any more".
describe("the notices name the collection by its note name when the link is a path", () => {
	it("says the task is not in the note, by name, when undo finds it gone", async () => {
		const run = await fileInto([SHEDS, OTHER], OTHER);
		const filed = await read(run.plugin, OTHER.path);
		run.plugin.app.vault.readableContents()?.set(OTHER.path, filed.split("\n").filter((each) => !each.includes("Order more tea")).join("\n"));
		Notice.messages.length = 0;

		const menu = new Menu();
		pressLineAwayFromCursor(run.editor, run.editor.getCursor().line);
		run.plugin.app.workspace.fire("editor-menu", menu, run.editor, { file: { path: LOG_PATH } });
		menu.items.find((each) => each.title === "Undo migration")?.click();
		await vi.waitFor(() => expect(Notice.messages.some((each) => each.includes("nothing was undone"))).toBe(true));

		expect(Notice.messages).toEqual(["The task is not in Garden shed any more, so nothing was undone."]);
	});

	it("says the note is not a collection, by name, when the jump finds it gone", async () => {
		const collections = [SHEDS, OTHER];
		const run = await fileInto(collections, OTHER);
		collections.splice(collections.indexOf(OTHER), 1);
		const jump = run.plugin.commands.find((each) => each.id === `${run.plugin.manifest.id}:jump-filed`);
		(jump as unknown as { editorCheckCallback: (checking: boolean, editor: FakeEditor, ctx: { file: { path: string } }) => void }).editorCheckCallback(false, run.editor, { file: { path: LOG_PATH } });
		await vi.waitFor(() => expect(Notice.messages.some((each) => each.includes("so there is nowhere to go"))).toBe(true));

		expect(Notice.messages.filter((each) => each.includes("so there is nowhere to go"))).toEqual([
			'Effortless: "Garden shed" is not a collection any more, so there is nowhere to go. Nothing was changed.',
		]);
	});
});

// #897: a collection moved to another folder with
// its name kept, while Obsidian's own link updating is off. The frozen link is path-qualified (two
// notes shared the name when it was written), so it names a folder that no longer holds the note.
describe("filing into the second of two same-named collections, then moving it to another folder", () => {
	const MOVED = collectionAt("Archive/Garden shed.md", "Garden shed");

	/** Files into OTHER, then moves that note to MOVED's path the way Obsidian does when it rewrites no link. */
	async function fileThenMove(): Promise<Run> {
		const collections = [SHEDS, OTHER];
		const run = await fileInto(collections, OTHER);
		const file = run.plugin.app.vault.getFileByPath(OTHER.path);
		await run.plugin.app.fileManager.renameFile(file as never, MOVED.path);
		collections.splice(collections.indexOf(OTHER), 1, MOVED);
		return run;
	}

	it("undoes from the note it was filed into, found by its name when the link names the old folder", async () => {
		const run = await fileThenMove();
		expect(opens(run), "the link must be stale for this to be the fallback").toBeNull();

		const menu = new Menu();
		pressLineAwayFromCursor(run.editor, run.editor.getCursor().line);
		run.plugin.app.workspace.fire("editor-menu", menu, run.editor, { file: { path: LOG_PATH } });
		menu.items.find((each) => each.title === "Undo migration")?.click();
		await vi.waitFor(() => expect(Notice.messages.some((each) => each.startsWith("Undone") || each.includes("nothing was undone"))).toBe(true));

		expect(Notice.messages[Notice.messages.length - 1]).toMatch(/^Undone\./);
		expect(run.editor.getValue()).toBe(LOG);
		expect(await read(run.plugin, MOVED.path)).not.toContain("Order more tea");
	});

	it("opens the moved note again once the rename keeper has rewritten the frozen line", async () => {
		const run = await fileThenMove();
		const line = run.editor.getLine(2);

		run.editor.setLine(2, rewriteCollectionLinks(line, OTHER.path, "Garden shed", { newPath: MOVED.path, logPath: LOG_PATH }));

		expect(opens(run)).toBe(MOVED.path);
	});
});
