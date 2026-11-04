/**
 * *Mark as processed*'s write function: the note's text in, the note's text
 * out, one line changed.
 *
 * Every expectation is the exact text, so a stray line ending, a lost final
 * line break or a tidied property would show as a different string. Every
 * note, name and date here is invented.
 */

import { describe, expect, it } from "vitest";
import { defaultData } from "../core/settings";
import { markProcessedText } from "../features/review/markProcessed";
import { waitingNotes } from "../features/review/waitingNotes";

const DATE = "2026-03-18";

/** A note's frontmatter lines and body joined with `eol`, ending in a line break when `final` is true. */
function note(eol: string, final: boolean, processed = "processed:"): string {
	const lines = ["---", "title: Weekly sync", processed, 'day: "[[2026-03-17]]"', "---", "# Weekly sync", "- [ ] send the notes", "- a plain bullet"];
	return lines.join(eol) + (final ? eol : "");
}

describe("the one line that changes", () => {
	it("fills a bare field on a note with Unix endings, ending in a line break", () => {
		expect(markProcessedText(note("\n", true), "processed", DATE)).toBe(
			'---\ntitle: Weekly sync\nprocessed: 2026-03-18\nday: "[[2026-03-17]]"\n---\n# Weekly sync\n- [ ] send the notes\n- a plain bullet\n',
		);
	});

	it("fills a bare field on a note with Unix endings, not ending in a line break", () => {
		expect(markProcessedText(note("\n", false), "processed", DATE)).toBe(
			'---\ntitle: Weekly sync\nprocessed: 2026-03-18\nday: "[[2026-03-17]]"\n---\n# Weekly sync\n- [ ] send the notes\n- a plain bullet',
		);
	});

	it("fills a bare field on a note with Windows endings, ending in a line break, keeping every \\r", () => {
		expect(markProcessedText(note("\r\n", true), "processed", DATE)).toBe(
			'---\r\ntitle: Weekly sync\r\nprocessed: 2026-03-18\r\nday: "[[2026-03-17]]"\r\n---\r\n# Weekly sync\r\n- [ ] send the notes\r\n- a plain bullet\r\n',
		);
	});

	it("fills a bare field on a note with Windows endings, not ending in a line break, adding none", () => {
		expect(markProcessedText(note("\r\n", false), "processed", DATE)).toBe(
			'---\r\ntitle: Weekly sync\r\nprocessed: 2026-03-18\r\nday: "[[2026-03-17]]"\r\n---\r\n# Weekly sync\r\n- [ ] send the notes\r\n- a plain bullet',
		);
	});

	it.each([
		["a bare key", "processed:"],
		["a bare key with trailing spaces", "processed:   "],
		["a key with a space and nothing after it", "processed: "],
		["empty double quotes, as written by hand", 'processed: ""'],
		["empty single quotes", "processed: ''"],
		["blank quotes", 'processed: "  "'],
		["null", "processed: null"],
		["a tilde, YAML's other null", "processed: ~"],
	])("treats %s as empty and rewrites the line to the date", (_name, line) => {
		const after = markProcessedText(note("\n", true, line), "processed", DATE);
		expect(after).toBe(note("\n", true, "processed: 2026-03-18"));
	});

	it("restores byte for byte when the one line is put back", () => {
		const before = note("\r\n", false, 'processed: ""');
		const after = markProcessedText(before, "processed", DATE);
		expect(after).not.toBe(before);
		expect(after.replace("processed: 2026-03-18", 'processed: ""')).toBe(before);
	});

	it("uses the field name it is given, not a built-in one", () => {
		const before = "---\nbearbetad:\nprocessed: keep me\n---\nbody\n";
		expect(markProcessedText(before, "bearbetad", DATE)).toBe("---\nbearbetad: 2026-03-18\nprocessed: keep me\n---\nbody\n");
	});

	it("keeps a comment the person wrote after the empty value", () => {
		expect(markProcessedText("---\nprocessed: # not yet\n---\n", "processed", DATE)).toBe("---\nprocessed: 2026-03-18 # not yet\n---\n");
	});

	it("leaves a line that merely starts with the field's name alone", () => {
		const before = "---\nprocessed_by:\nprocessed:\n---\n";
		expect(markProcessedText(before, "processed", DATE)).toBe("---\nprocessed_by:\nprocessed: 2026-03-18\n---\n");
	});

	it("fills the field in the frontmatter and not a line in the body that reads like it", () => {
		const before = "---\nprocessed:\n---\nprocessed:\n";
		expect(markProcessedText(before, "processed", DATE)).toBe("---\nprocessed: 2026-03-18\n---\nprocessed:\n");
	});
});

describe("a note already marked with the same day", () => {
	it("is handed back unchanged rather than refused, so a repeated press is not a failure", () => {
		const marked = note("\r\n", false, "processed: 2026-03-18");
		expect(markProcessedText(marked, "processed", DATE)).toBe(marked);
	});

	it("is still refused when the field holds another day, which is a note someone else filled in", () => {
		expect(() => markProcessedText(note("\n", true, "processed: 2026-03-17"), "processed", DATE)).toThrow("already filled in");
	});
});

describe("a note it refuses, leaving the text to the writer unchanged", () => {
	it.each([
		["a date", "processed: 2026-03-01"],
		["true", "processed: true"],
		["a word", "processed: done"],
		["a quoted word", 'processed: "yes"'],
		["zero", "processed: 0"],
	])("refuses a note whose field already holds %s", (_name, line) => {
		expect(() => markProcessedText(note("\n", true, line), "processed", DATE)).toThrow("already filled in");
	});

	it("refuses a field whose value is a list on the lines below it", () => {
		const before = "---\nprocessed:\n  - a\n  - b\n---\n";
		expect(() => markProcessedText(before, "processed", DATE)).toThrow("already filled in");
		expect(() => markProcessedText("---\nprocessed:\n- a\n---\n", "processed", DATE)).toThrow("already filled in");
	});

	it("refuses a note without the field in its frontmatter, even with the words in its body", () => {
		expect(() => markProcessedText("---\ntitle: x\n---\nprocessed:\n", "processed", DATE)).toThrow("no `processed` line");
	});

	it("refuses a note without frontmatter, and an opener that never closes", () => {
		expect(() => markProcessedText("processed:\n", "processed", DATE)).toThrow("no frontmatter");
		expect(() => markProcessedText("---\nprocessed:\nno closing fence\n", "processed", DATE)).toThrow("no frontmatter");
	});

	it("refuses an empty note", () => {
		expect(() => markProcessedText("", "processed", DATE)).toThrow("no frontmatter");
	});
});

/**
 * Every shape below was fed to the test Obsidian's metadata cache and read back
 * as an empty `processed` (`docs/acceptance-shots/fix-1079-drive.txt`,
 * "#1083: what the cache returned"), so the list shows a note written like it.
 * `read` is the frontmatter the cache returned. A note the list shows must be a
 * note the press can fill: two readings of "empty" would leave a row whose
 * button is refused on every press.
 */
describe("every note the list shows as waiting can be marked", () => {
	const shapes: Array<[string, string, Record<string, unknown>, string]> = [
		["a quoted key with an empty value", '---\r\n"processed": ""\r\n---\r\nbody\r\n', { processed: "" }, "---\r\nprocessed: 2026-03-18\r\n---\r\nbody\r\n"],
		["a double-quoted key and no value", '---\n"processed":\n---\nbody\n', { processed: null }, "---\nprocessed: 2026-03-18\n---\nbody\n"],
		["a single-quoted key and no value", "---\n'processed':\n---\nbody\n", { processed: null }, "---\nprocessed: 2026-03-18\n---\nbody\n"],
		["a bare literal block scalar", "---\nprocessed: |\n---\nbody\n", { processed: "" }, "---\nprocessed: 2026-03-18\n---\nbody\n"],
		["a bare folded block scalar", "---\nprocessed: >\n---\nbody\n", { processed: "" }, "---\nprocessed: 2026-03-18\n---\nbody\n"],
		["a bare stripped block scalar", "---\nprocessed: |-\n---\nbody\n", { processed: "" }, "---\nprocessed: 2026-03-18\n---\nbody\n"],
		["a null tag", "---\nprocessed: !!null\n---\nbody\n", { processed: null }, "---\nprocessed: 2026-03-18\n---\nbody\n"],
		["a space before the colon", "---\nprocessed : \n---\nbody\n", { processed: null }, "---\nprocessed: 2026-03-18\n---\nbody\n"],
		["a byte-order mark before the opening rule", "\uFEFF---\nprocessed:\n---\nbody\n", { processed: null }, "\uFEFF---\nprocessed: 2026-03-18\n---\nbody\n"],
		["carriage returns alone as line endings", "---\rprocessed:\r---\rbody\r", { processed: null }, "---\rprocessed: 2026-03-18\r---\rbody\r"],
		["carriage returns alone and no final line break", "---\rprocessed:\r---\rbody", { processed: null }, "---\rprocessed: 2026-03-18\r---\rbody"],
	];
	const layout = { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
	const listed = (read: Record<string, unknown>): number =>
		waitingNotes([{ path: "Journal/2026-03-17.md", frontmatter: read, text: "" }], layout, 7, new Date(2026, 2, 18), () => null, () => false).list.length;

	it.each(shapes)("%s", (_name, text, read, written) => {
		expect(listed(read)).toBe(1);
		expect(markProcessedText(text, "processed", DATE)).toBe(written);
	});

	it.each([
		["a block scalar with text under it", "---\nprocessed: |\n  text\n---\nbody\n"],
		["a block scalar with a blank line and then text under it", "---\nprocessed: >\n\n  text\n---\nbody\n"],
	])("still refuses %s, which Obsidian reads as filled in", (_name, text) => {
		expect(() => markProcessedText(text, "processed", DATE)).toThrow("already filled in");
	});
});

/**
 * *Mark as processed* ignores the diary section: the diary-date
 * field is the plugin's own write, and pressing the button never records the
 * diary's day. It passes on the code from before the diary-date write existed.
 */
describe("on a day's log with diary text and an empty diary-date field", () => {
	it("fills the processed field only, naming the exact bytes", () => {
		const before = "---\r\nprocessed:\r\ndiary:\r\n---\r\n# Notes\r\n- [ ] send the notes\r\n# Diary\r\nA walk by the harbour.";
		const after = "---\r\nprocessed: 2026-03-18\r\ndiary:\r\n---\r\n# Notes\r\n- [ ] send the notes\r\n# Diary\r\nA walk by the harbour.";

		expect(markProcessedText(before, "processed", DATE)).toBe(after);
	});
});
