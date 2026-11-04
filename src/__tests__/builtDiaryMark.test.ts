/**
 * The mark a day's log carries of the diary section it was built with: where the line goes
 * in the built text, byte for byte, and what the reader accepts. The fingerprints
 * are literals, taken once from `fingerprintOf` over the section's text: `- Line`
 * is `6:1b1b5212a4d8e5`, `- What did I learn today?` is `25:13627175d8dfa1`. Every
 * line here is invented.
 */

import { describe, expect, it } from "vitest";
import { builtDiaryMarkIn, diaryFingerprint, withBuiltDiaryMark } from "../core/builtDiaryMark";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";

const LINE_MARK = 'effortless-built-diary: "6:1b1b5212a4d8e5"';

function layout(): VaultLayout {
	return { ...defaultData().core.layout, diaryHeading: { text: "Diary", level: 1 } };
}

describe("a built log carries the mark of its own diary section", () => {
	it("as its frontmatter block's last line", () => {
		const built = withBuiltDiaryMark("---\nprocessed:\n---\n# Notes\n# Diary\n- Line\n", layout());

		expect(built).toBe(`---\nprocessed:\n${LINE_MARK}\n---\n# Notes\n# Diary\n- Line\n`);
	});

	it("in a block of its own in front of a log that has none", () => {
		const built = withBuiltDiaryMark("# Notes\n# Diary\n- Line\n", layout());

		expect(built).toBe(`---\n${LINE_MARK}\n---\n# Notes\n# Diary\n- Line\n`);
	});

	it.each([
		["ending in a line break", "---\r\nprocessed:\r\n---\r\n# Diary\r\n- Line\r\n", `---\r\nprocessed:\r\n${LINE_MARK}\r\n---\r\n# Diary\r\n- Line\r\n`],
		["not ending in one", "---\r\nprocessed:\r\n---\r\n# Diary\r\n- Line", `---\r\nprocessed:\r\n${LINE_MARK}\r\n---\r\n# Diary\r\n- Line`],
		["with no block, ending in a line break", "# Diary\r\n- Line\r\n", `---\r\n${LINE_MARK}\r\n---\r\n# Diary\r\n- Line\r\n`],
		["with no block, not ending in one", "# Diary\r\n- Line", `---\r\n${LINE_MARK}\r\n---\r\n# Diary\r\n- Line`],
	])("with Windows line endings, %s, in those endings", (_case, log, expected) => {
		const built = withBuiltDiaryMark(log, layout());

		expect(built).toBe(expected);
		// The mark matches its own section: read back from the built text, it is the
		// fingerprint of the lines under the diary heading.
		expect(builtDiaryMarkIn(built)).toBe("6:1b1b5212a4d8e5");
	});

	it("covering the diary section only, so the text around it does not change it", () => {
		const built = withBuiltDiaryMark("---\n---\n# Notes\n- a task\n# Diary\n- What did I learn today?\n\n\n# After\nNot the diary.\n", layout());

		expect(builtDiaryMarkIn(built)).toBe("25:13627175d8dfa1");
	});

	it("replacing a line whose key is quoted, as a property editor may write it", () => {
		const built = withBuiltDiaryMark("---\n\"effortless-built-diary\": \"25:13627175d8dfa1\"\n---\n# Diary\n- Line\n", layout());

		expect(built).toBe(`---\n${LINE_MARK}\n---\n# Diary\n- Line\n`);
	});

	it("replacing the line a template copied from a built log carries, never repeating it", () => {
		const built = withBuiltDiaryMark('---\neffortless-built-diary: "25:13627175d8dfa1"\nprocessed:\n---\n# Diary\n- Line\n', layout());

		expect(built).toBe(`---\n${LINE_MARK}\nprocessed:\n---\n# Diary\n- Line\n`);
	});

	it("after a byte-order mark, which stays in front", () => {
		const built = withBuiltDiaryMark("﻿---\nprocessed:\n---\n# Diary\n- Line\n", layout());

		expect(built).toBe(`﻿---\nprocessed:\n${LINE_MARK}\n---\n# Diary\n- Line\n`);
		expect(builtDiaryMarkIn(built)).toBe("6:1b1b5212a4d8e5");
	});
});

describe("the fingerprint of a diary section reads it as the stamp compares it", () => {
	it("leaves out line endings, spaces at a line's end and blank lines after the text", () => {
		expect(diaryFingerprint(["- Line  \r", "", "  "])).toBe("6:1b1b5212a4d8e5");
	});

	it("differs for a section with one more word", () => {
		expect(diaryFingerprint(["- Line", "Mine."])).not.toBe("6:1b1b5212a4d8e5");
	});
});

describe("reading the mark back", () => {
	it.each([
		["double quotes", 'effortless-built-diary: "6:1b1b5212a4d8e5"'],
		["single quotes, as a property editor may write it", "effortless-built-diary: '6:1b1b5212a4d8e5'"],
		["no quotes", "effortless-built-diary: 6:1b1b5212a4d8e5"],
		["double quotes, under a quoted key", '"effortless-built-diary": "6:1b1b5212a4d8e5"'],
	])("finds a value in %s", (_case, line) => {
		expect(builtDiaryMarkIn(`---\n${line}\n---\n# Diary\n`)).toBe("6:1b1b5212a4d8e5");
	});

	it.each([
		["blank", "effortless-built-diary:"],
		["hand-edited text", 'effortless-built-diary: "written by me"'],
		["a number", "effortless-built-diary: 12"],
		["a list", "effortless-built-diary: [6:1b1b5212a4d8e5]"],
		["an unclosed quote", 'effortless-built-diary: "6:1b1b5212a4d8e5'],
	])("reads %s as no mark", (_case, line) => {
		expect(builtDiaryMarkIn(`---\n${line}\n---\n# Diary\n`)).toBeNull();
	});

	it("reads a line outside the frontmatter, or an indented one, as no mark", () => {
		expect(builtDiaryMarkIn('# Diary\neffortless-built-diary: "6:1b1b5212a4d8e5"\n')).toBeNull();
		expect(builtDiaryMarkIn('---\nother:\n  effortless-built-diary: "6:1b1b5212a4d8e5"\n---\n')).toBeNull();
	});
});
