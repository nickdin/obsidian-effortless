/**
 * A processed field holding an empty list:
 * the list shows the note, the chain reads it as empty, and *Mark as processed*
 * fills it. Every note and date here is invented.
 */

import type { Editor, EditorChange } from "obsidian";
import { describe, expect, it } from "vitest";
import { chain } from "../features/review/chain";
import type { VaultLayout } from "../core/settings";
import { defaultData } from "../core/settings";
import { diaryDateText } from "../features/review/diaryDate";
import { markInEditor } from "../features/review/editorRoute";
import { markProcessedText } from "../features/review/markProcessed";
import { waitingNotes } from "../features/review/waitingNotes";
import type { ResolveLink, ReviewNote } from "../features/review/waitingNotes";

const TODAY = new Date(2026, 9, 15);
const OCTOBER = { year: 2026, month: 10 };
const DAY = 13;
const DATE = "2026-10-15";

const layout: VaultLayout = {
	...defaultData().core.layout,
	dailyLogFolder: "Journal",
	dailyLogFilename: "YYYY-MM-DD",
	processedField: "processed",
	dayLinkField: "day",
	excludedFolders: ["Templates"],
};

const resolveLink: ResolveLink = (linkText) => (/^\d{4}-\d{2}-\d{2}$/.test(linkText) ? `Journal/${linkText}.md` : null);
const noCollection = (): boolean => false;

const goneThrough: ReviewNote = { path: "Journal/2026-10-13.md", frontmatter: { processed: "2026-10-14" }, text: "# Diary\n\nWords.\n" };

function meeting(processed: unknown): ReviewNote {
	return { path: "Meetings/Budget.md", frontmatter: { day: "[[2026-10-13]]", processed }, text: "" };
}

function listed(notes: ReviewNote[]): string[] {
	return waitingNotes(notes, layout, 7, TODAY, resolveLink, noCollection).list.map((note) => note.path);
}

function reviewMark(notes: ReviewNote[]) {
	return chain(notes, layout, resolveLink, OCTOBER, TODAY).days[DAY - 1].review;
}

describe("a note whose processed field holds an empty list", () => {
	it("is listed in the window", () => {
		expect(listed([goneThrough, meeting([])])).toEqual(["Meetings/Budget.md"]);
	});

	it("is listed exactly when the chain reads the day as missed", () => {
		for (const value of [[], [""], ["2026-10-14"]]) {
			const notes = [goneThrough, meeting(value)];
			expect(listed(notes).includes("Meetings/Budget.md")).toBe(reviewMark(notes) === "missed");
		}
		expect(reviewMark([goneThrough, meeting([])])).toBe("missed");
	});
});

describe("the list and Mark as processed together, on a note holding processed: []", () => {
	it.each([
		["Unix endings, ending in a line break", "\n", true],
		["Unix endings, with no final line break", "\n", false],
		["Windows endings, ending in a line break", "\r\n", true],
		["Windows endings, with no final line break", "\r\n", false],
	])("lists the note and then fills the field, on %s", (_name, eol, final) => {
		const text = (value: string): string => ["---", "day: \"[[2026-10-13]]\"", `processed: ${value}`, "---", "- [ ] one"].join(eol) + (final ? eol : "");
		const note: ReviewNote = { path: "Meetings/Budget.md", frontmatter: { day: "[[2026-10-13]]", processed: [] }, text: text("[]") };

		expect(listed([goneThrough, note])).toEqual(["Meetings/Budget.md"]);
		const filled = markProcessedText(note.text, "processed", DATE);
		expect(filled).toBe(text(DATE));
	});
});

describe("a list opened on one line and closed on the next", () => {
	it.each([
		["Unix endings, ending in a line break", "\n", true],
		["Unix endings, with no final line break", "\n", false],
		["Windows endings, ending in a line break", "\r\n", true],
		["Windows endings, with no final line break", "\r\n", false],
	])("is filled like the chain reads it, as one line, on %s", (_name, eol, final) => {
		const text = (lines: string[]): string => ["---", "title: Weekly sync", ...lines, "---", "- [ ] one"].join(eol) + (final ? eol : "");
		expect(markProcessedText(text(["processed: [", "]", "kept: yes"]), "processed", DATE)).toBe(text([`processed: ${DATE}`, "kept: yes"]));
		expect(markProcessedText(text(["processed: [", "]"]), "processed", DATE)).toBe(text([`processed: ${DATE}`]));
	});

	it("is still refused when the list holds an item", () => {
		expect(() => markProcessedText("---\nprocessed: [\n  2026-03-10\n]\n---\n", "processed", DATE)).toThrow("already filled in");
	});
});

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

describe("the two-line empty list, through each write route", () => {
	const spellings = [
		["Unix endings, ending in a line break", "\n", true],
		["Unix endings, with no final line break", "\n", false],
		["Windows endings, ending in a line break", "\r\n", true],
		["Windows endings, with no final line break", "\r\n", false],
	] as const;

	it.each(spellings)("the editor route fills it as one line, on %s", (_name, eol, final) => {
		const text = (lines: string[]): string => ["---", "title: Weekly sync", ...lines, "---", "- [ ] one"].join(eol) + (final ? eol : "");
		const { editor, value } = fakeEditor(text(["processed: [", "]", "kept: yes"]));
		markInEditor(editor, "processed", DATE);
		expect(value()).toBe(text([`processed: ${DATE}`, "kept: yes"]));
	});

	it.each(spellings)("the diary write fills it as one line, on %s", (_name, eol, final) => {
		const text = (lines: string[]): string => ["---", ...lines, "---", "# Diary", "Walked by the harbour."].join(eol) + (final ? eol : "");
		expect(diaryDateText(text(["diary: [", "]", "kept: yes"]), "Diary", 1, "diary", DATE)).toBe(text([`diary: ${DATE}`, "kept: yes"]));
		expect(diaryDateText(text(["diary: [", "]"]), "Diary", 1, "diary", DATE)).toBe(text([`diary: ${DATE}`]));
	});
});
