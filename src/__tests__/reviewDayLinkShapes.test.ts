import { describe, expect, it } from "vitest";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { waitingNotes } from "../features/review/waitingNotes";
import type { ResolveLink, ReviewNote } from "../features/review/waitingNotes";

/** Thursday 15 October 2026, the day every case below is read on. */
const TODAY = new Date(2026, 9, 15);
const DAY = "2026-10-13";

const layout: VaultLayout = {
	...defaultData().core.layout,
	dailyLogFolder: "Journal",
	dailyLogFilename: "YYYY-MM-DD",
	processedField: "processed",
	dayLinkField: "day",
};

/** Knows a day's log by its date, as Obsidian's link resolver would, and nothing else. */
const resolveLink: ResolveLink = (linkText) => (/^\d{4}-\d{2}-\d{2}$/.test(linkText) ? `Journal/${linkText}.md` : null);

/** The days of the notes that wait, for one note whose day-link field holds `value`. */
function daysFor(value: unknown): string[] {
	const note: ReviewNote = { path: "Meetings/Weekly sync.md", frontmatter: { processed: null, day: value }, text: "" };
	return waitingNotes([note], layout, 7, TODAY, resolveLink, () => false).list.map((row) => {
		const d = row.day;
		const two = (n: number) => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
	});
}

// The shapes below are inferred from YAML parsing, not read back from Obsidian's
// metadata cache: `day:` with a quoted link under it is a list of one string, and
// an unquoted `day: [[2026-10-13]]` is a list holding a list of one string, and
// the same unquoted link as a list item is one list deeper still. The first three
// were read back in the test Obsidian (docs/acceptance-shots/issue-1066-day-link-shapes.txt);
// the fourth is read back in docs/acceptance-shots/fix-1102-drive.txt.
describe("the day-link field, in each way a person writes it", () => {
	it("a quoted link still gives its day", () => {
		expect(daysFor(`[[${DAY}]]`)).toEqual([DAY]);
	});

	it("a list property holding one quoted link gives its day", () => {
		expect(daysFor([`[[${DAY}]]`])).toEqual([DAY]);
	});

	it("an unquoted link, which YAML reads as a nested list, gives its day", () => {
		expect(daysFor([[DAY]])).toEqual([DAY]);
	});

	it("an unquoted link with an alias keeps the target and drops the alias", () => {
		expect(daysFor([[`${DAY}|Tuesday`]])).toEqual([DAY]);
	});

	it("a list whose item is an unquoted link, which YAML reads as a list in a list in a list, gives its day", () => {
		expect(daysFor([[[DAY]]])).toEqual([DAY]);
		expect(daysFor([[[`${DAY}|Tuesday`]]])).toEqual([DAY]);
	});

	it("a list in a list in a list that holds no link text gives no day", () => {
		for (const value of [[[[]]], [[[""]]], [[[42]]], [[[[DAY]]]]]) {
			expect(daysFor(value), JSON.stringify(value)).toEqual([]);
		}
	});

	it("a number, an empty list, an empty string and an empty nested list give no day", () => {
		for (const value of [20261013, [], "", [[]], [""], [[""]], [42], null, true]) {
			expect(daysFor(value), JSON.stringify(value)).toEqual([]);
		}
	});
});
