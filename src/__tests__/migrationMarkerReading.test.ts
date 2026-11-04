/**
 * One reading of a frozen line's marker and link
 * (#878, found against
 * #862): the jump and the
 * undo read the same line, so a hand-edited line cannot be one thing to the jump
 * and another to the undo. `writeMarker` writes one space between the id and the
 * hash, so the plugin's own lines never split the two readings; a person editing
 * the comment by hand does. Every folder, name and task is invented.
 */

import { describe, expect, it } from "vitest";
import { Menu } from "./__mocks__/obsidian";
import type { Plugin } from "./__mocks__/obsidian";
import { linesToWrite } from "../features/migration/fileInto";
import { collectionLinktextOf } from "../features/migration/jump";
import { readMarker } from "../features/migration/marker";
import { JUMP_ENTRY_TITLE, UNDO_ENTRY_TITLE } from "../features/migration/menu";
import { readFrozen } from "../features/migration/undo";
import { FakeEditor, LOG_PATH, installMigrationHooks, startMigration } from "./migrationHarness";
import { pressLine } from "./editorMenu";

installMigrationHooks();

const logWith = (line: string): string => ["# Notes", "", line, "", "## Today", ""].join("\n");

function titlesAt(plugin: Plugin, text: string): string[] {
	const menu = new Menu();
	plugin.app.workspace.fire("editor-menu", menu, pressLine(new FakeEditor(text, 0), 2), { file: { path: LOG_PATH } });
	return menu.items.map((each) => each.title);
}

describe("a frozen line whose marker was edited by hand", () => {
	// Each line is a marker the jump reads (it trims and splits on any whitespace) and the
	// undo, splitting on one space, does not; with the two readings apart, one entry is
	// offered and the other not, and `readFrozen` answers "not there any more".
	it.each([
		["two spaces between the id and the hash", "%% migration:k1abcd  0a1b2c3d %%"],
		["a tab between the id and the hash", "%% migration:k1abcd\t0a1b2c3d %%"],
		["a space after the colon", "%% migration: k1abcd 0a1b2c3d %%"],
	])("is one thing to the jump and the undo alike, with %s", async (_, marker) => {
		const line = `- [>] Mend the gate [[Garden shed]] ${marker}`;
		const text = logWith(line);
		const { plugin } = await startMigration({ log: text });

		const titles = titlesAt(plugin, text);
		const undoSees = readFrozen(text, "k1abcd") !== null;

		expect(titles.includes(JUMP_ENTRY_TITLE)).toBe(true);
		expect(titles.includes(UNDO_ENTRY_TITLE)).toBe(true);
		expect(undoSees).toBe(true);
	});
});

describe("a frozen line whose last link sits inside a comment", () => {
	// The jump masks comments out before it looks for the link; the undo took the last
	// `[[…]]` anywhere, so a line ending `%% see [[Elsewhere]] %%` named "Elsewhere" for
	// the undo and no collection for the jump.
	it("names the same collection to the jump and the undo", () => {
		const line = "- [>] Mend the gate %% see [[Elsewhere]] %% %% migration:k1abcd 0a1b2c3d %%";

		expect(collectionLinktextOf(line)).toBeNull();
		expect(readFrozen(logWith(line), "k1abcd")?.collectionName).toBeNull();
	});

	it("names the link outside the comments, to both", () => {
		const line = "- [>] Mend the gate [[Garden shed]] %% see [[Elsewhere]] %% %% migration:k1abcd 0a1b2c3d %%";

		expect(collectionLinktextOf(line)).toBe("Garden shed");
		expect(readFrozen(logWith(line), "k1abcd")?.collectionName).toBe("Garden shed");
	});
});

describe("the marker's third word, the checkbox the task was filed with", () => {
	// A marker is `id hash` from an earlier build, or `id hash box` from this one: `box` is one character,
	// with `_` standing for the space of `[ ]`, since the comment is split on whitespace.
	it.each([
		["an open task", "- [ ] Mend the gate", "_"],
		["a task in progress", "- [/] Mend the gate", "/"],
		["a done task", "- [x] Mend the gate", "x"],
		["a cancelled task", "- [-] Mend the gate", "-"],
	])("is written on the line of %s and read back as the checkbox itself", (_, task, word) => {
		const filed = linesToWrite(task, "k1abcd", "[[Garden shed]]", "[[2031-04-05]]");

		// A fourth word, `L`, follows: both lines also carry a link this filing
		// appended, which `src/core/markerLink.ts` reads by that flag.
		expect(filed.collectionLine).toMatch(new RegExp(`%% migration:k1abcd [0-9a-f]{8} ${word} L %%$`));
		expect(readMarker(filed.collectionLine)?.checkbox).toBe(word === "_" ? " " : word);
		expect(readMarker(filed.frozenLine)?.checkbox).toBe(word === "_" ? " " : word);
	});

	it("is absent from a marker an earlier build wrote", () => {
		expect(readMarker("- [>] Tea %% migration:k1abcd 0a1b2c3d %%")).toEqual({ id: "k1abcd", hash: "0a1b2c3d", carriesLink: false });
	});

	it("is not a marker at all when the third word is more than one character", () => {
		expect(readMarker("- [>] Tea %% migration:k1abcd 0a1b2c3d xx %%")).toBeNull();
	});
});

// #899: the markdown half of the reader cut a
// destination at its first `)`, so a note whose name holds a bracket was read short, and it took a
// hand-typed web link after the frozen one for the collection.
describe("the frozen line's link when the note's name holds a bracket, or a web link follows it", () => {
	const MARK = "%% migration:k1abcd 0a1b2c3d 0 %%";

	it.each([
		["a markdown link, the bracket written raw", `- [>] Order tea [Garden (old)](Ideas/Garden%20(old).md) ${MARK}`, "Ideas/Garden (old).md"],
		["a markdown link, the path in angle brackets", `- [>] Order tea [Garden (old)](<Ideas/Garden (old).md>) ${MARK}`, "Ideas/Garden (old).md"],
		["a web link the person typed after the frozen one", `- [>] Order tea [[Garden shed]] [see](https://x.org/a) ${MARK}`, "Garden shed"],
	])("reads the note whole for %s", (_, line, expected) => {
		expect(collectionLinktextOf(line)).toBe(expected);
		expect(readFrozen(logWith(line), "k1abcd")?.collectionName).toBe(expected);
	});
});
