/**
 * A two-line empty list whose closing line carries a YAML comment:
 * YAML and the chain read `processed: [` then `] # a note` as an empty list, so
 * *Mark as processed* fills it through each of its three write routes, and the
 * comment stays. Every note and date here is invented.
 */

import type { Editor, EditorChange } from "obsidian";
import { describe, expect, it } from "vitest";
import { diaryDateText } from "../features/review/diaryDate";
import { markInEditor } from "../features/review/editorRoute";
import { markProcessedText } from "../features/review/markProcessed";

const DATE = "2026-10-15";

const spellings = [
	["Unix endings, ending in a line break", "\n", true],
	["Unix endings, with no final line break", "\n", false],
	["Windows endings, ending in a line break", "\r\n", true],
	["Windows endings, with no final line break", "\r\n", false],
] as const;

/** An editor over `text`: `getValue` reads it and `transaction` applies the changes to it, by line and column. */
function fakeEditor(text: string): { editor: Editor; value: () => string } {
	let current = text;
	const editor = {
		getValue: () => current,
		transaction: (tx: { changes?: EditorChange[] }) => {
			for (const change of tx.changes ?? []) {
				const lines = current.split("\n");
				const at = (pos: { line: number; ch: number }): number => lines.slice(0, pos.line).reduce((n, l) => n + l.length + 1, 0) + pos.ch;
				current = current.slice(0, at(change.from)) + change.text + current.slice(at(change.to ?? change.from));
			}
		},
	} as unknown as Editor;
	return { editor, value: () => current };
}

describe("a two-line empty list whose closing line carries a comment", () => {
	it.each(spellings)("is filled by the text route, the comment kept, on %s", (_name, eol, final) => {
		// If wrong: a closing line that must be a bare `]` refuses the note as already filled in.
		const text = (lines: string[]): string => ["---", "title: Weekly sync", ...lines, "---", "- [ ] one"].join(eol) + (final ? eol : "");
		expect(markProcessedText(text(["processed: [", "] # a note", "kept: yes"]), "processed", DATE)).toBe(text([`processed: ${DATE} # a note`, "kept: yes"]));
		expect(markProcessedText(text(["processed: [ # first", "  ]\t# second"]), "processed", DATE)).toBe(text([`processed: ${DATE} # first # second`]));
	});

	it.each(spellings)("is filled by the diary write, the comment kept, on %s", (_name, eol, final) => {
		const text = (lines: string[]): string => ["---", ...lines, "---", "# Diary", "Walked by the harbour."].join(eol) + (final ? eol : "");
		expect(diaryDateText(text(["diary: [", "] # a note", "kept: yes"]), "Diary", 1, "diary", DATE)).toBe(text([`diary: ${DATE} # a note`, "kept: yes"]));
	});

	it.each(spellings)("is filled by the editor route, the comment kept, on %s", (_name, eol, final) => {
		const text = (lines: string[]): string => ["---", "title: Weekly sync", ...lines, "---", "- [ ] one"].join(eol) + (final ? eol : "");
		const { editor, value } = fakeEditor(text(["processed: [", "] # a note", "kept: yes"]));
		markInEditor(editor, "processed", DATE);
		expect(value()).toBe(text([`processed: ${DATE} # a note`, "kept: yes"]));
	});

	it("is still refused when the closing line holds anything but a comment", () => {
		// If wrong: a closing pattern that ignores what follows the `]` fills a note whose second line is a value.
		for (const close of ["] extra", "]# glued", "], other"]) {
			expect(() => markProcessedText(`---\nprocessed: [\n${close}\n---\n`, "processed", DATE), close).toThrow("already filled in");
		}
	});
});
