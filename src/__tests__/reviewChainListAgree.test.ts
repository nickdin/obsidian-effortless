import { describe, expect, it } from "vitest";
import { chain } from "../features/review/chain";
import type { VaultLayout } from "../core/settings";
import { defaultData } from "../core/settings";
import { waitingNotes } from "../features/review/waitingNotes";
import type { ResolveLink, ReviewNote } from "../features/review/waitingNotes";

/**
 * The chain and Review's list read the same notes and must agree on which of
 * them take part:
 * one fixture, handed to both. Thursday 15 October 2026 is today; the day read
 * is Tuesday the 13th, two days back, so it is inside the list's window and past
 * the day after, and a note that takes part and is empty makes it *missed*.
 */
const TODAY = new Date(2026, 9, 15);
const OCTOBER = { year: 2026, month: 10 };
const DAY = 13;

const layout: VaultLayout = {
	...defaultData().core.layout,
	dailyLogFolder: "Journal",
	dailyLogFilename: "YYYY-MM-DD",
	processedField: "processed",
	dayLinkField: "day",
	diaryDateField: "diary",
	diaryHeading: { text: "Diary", level: 1 },
	excludedFolders: ["Templates"],
};

const resolveLink: ResolveLink = (linkText) => (/^\d{4}-\d{2}-\d{2}$/.test(linkText) ? `Journal/${linkText}.md` : null);
const noCollection = (): boolean => false;

/** The day's log, gone through in time, so that only the note beside it can make the day *missed*. */
const goneThrough: ReviewNote = { path: "Journal/2026-10-13.md", frontmatter: { processed: "2026-10-14" }, text: "# Diary\n\nWords.\n" };

/** A meeting note linking to the 13th; `processed` is left out of its frontmatter when `undefined`. */
function meeting(name: string, processed: unknown, folder = "Meetings"): ReviewNote {
	const frontmatter: Record<string, unknown> = { day: "[[2026-10-13]]" };
	if (processed !== undefined) frontmatter.processed = processed;
	return { path: `${folder}/${name}.md`, frontmatter, text: "" };
}

function reviewMark(notes: ReviewNote[]) {
	return chain(notes, layout, resolveLink, OCTOBER, TODAY).days[DAY - 1].review;
}

function listed(notes: ReviewNote[], isCollection: (path: string) => boolean = noCollection): string[] {
	return waitingNotes(notes, layout, 7, TODAY, resolveLink, isCollection).list.map((note) => note.path);
}

describe("the chain and the list agree on which notes take part", () => {
	const cases: ReadonlyArray<readonly [string, unknown, boolean]> = [
		["no processed field at all", undefined, false],
		["a processed field written with nothing after it", null, true],
		["a processed field holding blank text", "  ", true],
		["a processed field holding an empty list", [], true],
		["a processed field holding a date", "2026-10-14", false],
		["a processed field holding true", true, false],
	];

	it.each(cases)("%s: the day is missed exactly when the list shows the note", (_name, processed, shownByList) => {
		const notes = [goneThrough, meeting("Budget", processed)];
		expect(listed(notes).includes("Meetings/Budget.md")).toBe(shownByList);
		expect(reviewMark(notes)).toBe(shownByList ? "missed" : "kept");
	});

	it("reads a day whose only note has no processed field as none, and the list shows nothing for it", () => {
		const notes = [{ ...goneThrough, frontmatter: {} }, meeting("Budget", undefined)];
		expect(listed(notes)).toEqual([]);
		expect(reviewMark(notes)).toBe("none");
	});

	it("keeps a note that takes part and is empty making the day missed, beside one that does not take part", () => {
		const notes = [goneThrough, meeting("Budget", undefined), meeting("Standup", null)];
		expect(listed(notes)).toEqual(["Meetings/Standup.md"]);
		expect(reviewMark(notes)).toBe("missed");
	});

	it("lets a collection with an empty processed field take part in both, since the list shows it with 0 open tasks", () => {
		const notes = [goneThrough, meeting("Reading list", null)];
		const isCollection = (path: string): boolean => path === "Meetings/Reading list.md";
		expect(listed(notes, isCollection)).toEqual(["Meetings/Reading list.md"]);
		expect(reviewMark(notes)).toBe("missed");
	});
});
