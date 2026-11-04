/**
 * `linkWrite`: the one line click-to-link changes, worked out from the clicked
 * block's own lines.
 *
 * Pure code over strings: the block's lines, fences included, as Obsidian's
 * section information bounds them, go in; the same lines with one meeting cell
 * made a link, or a refusal, come out. The core's `editCalendarCell` does the
 * rewriting, so everything outside the one cell stays byte for byte.
 *
 * The "carried" cases come from the old plugin's
 * `~/Devbox/schema-render/src/__tests__/writeback.test.ts`
 * (`writebackEventCellAsWikilink — robustness`), with the production column
 * names replaced by the core's defaults. One of them now answers the other
 * way on purpose — a row below a blank line is not the table's any more
 * (named difference 5) — and says so where it stands.
 *
 * Every meeting name here is invented.
 */

import { describe, expect, it } from "vitest";
import type { SectionCache } from "obsidian";
import type { ColumnNames } from "../core/calendarTable";
import { blockInsideCallout, linkWrite, locateHeldBlock, restoreLocatedBlock } from "../features/dayView/linkWrite";

const COLUMNS: ColumnNames = { time: "Time", event: "Meeting" };

const FENCE = "```schema";
const CLOSE = "```";
const HEADER = ["| Time | Meeting | Note |", "| --- | --- | --- |"];

/** A block of `rows` under the header, fences included — what the section information bounds. */
function block(...rows: string[]): string[] {
	return [FENCE, ...HEADER, ...rows, CLOSE];
}

/** The lines `linkWrite` answered, or a failed test saying what it refused. */
function written(outcome: ReturnType<typeof linkWrite>): string[] {
	if ("refused" in outcome) throw new Error(`expected lines, got the refusal ${outcome.refused}`);
	return outcome.lines;
}

describe("a plain cell becomes a link, with every other byte of the block identical", () => {
	// Each case: the row as written, the drawn cells, and the row expected back.
	// The block around it is the same every time and must come back untouched.
	const corpus: { name: string; row: string; time: string; meeting: string; expected: string }[] = [
		{
			name: "a bare name",
			row: "| 08:00–08:30 | Standup | quick |",
			time: "08:00–08:30",
			meeting: "Standup",
			expected: "| 08:00–08:30 | [[Standup]] | quick |",
		},
		{
			name: "a name with a trailing parenthesis, which stays outside the link",
			row: "| 09:00–10:00 | Budget review (Online) |  |",
			time: "09:00–10:00",
			meeting: "Budget review (Online)",
			expected: "| 09:00–10:00 | [[Budget review]] (Online) |  |",
		},
		{
			name: "a cell padded wider than one space, whose padding is kept",
			row: "| 11:00–11:30 |   Retro   | x |",
			time: "11:00–11:30",
			meeting: "Retro",
			expected: "| 11:00–11:30 |   [[Retro]]   | x |",
		},
		{
			name: "a row with no closing pipe",
			row: "| 12:00–12:45 | Lunch walk",
			time: "12:00–12:45",
			meeting: "Lunch walk",
			expected: "| 12:00–12:45 | [[Lunch walk]]",
		},
		{
			name: "a row whose other cell holds an aliased link with a bare pipe",
			row: "| 13:00–14:00 | Design crit | [[Plan|the plan]] |",
			time: "13:00–14:00",
			meeting: "Design crit",
			expected: "| 13:00–14:00 | [[Design crit]] | [[Plan|the plan]] |",
		},
		{
			name: "a row whose other cell holds an aliased link with an escaped pipe",
			row: "| 13:00–14:00 | Design crit | [[Plan\\|the plan]] |",
			time: "13:00–14:00",
			meeting: "Design crit",
			expected: "| 13:00–14:00 | [[Design crit]] | [[Plan\\|the plan]] |",
		},
		{
			name: "a parenthesis that is not trailing, which stays inside the name",
			row: "| 15:00–15:30 | Sprint (two) planning | |",
			time: "15:00–15:30",
			meeting: "Sprint (two) planning",
			expected: "| 15:00–15:30 | [[Sprint (two) planning]] | |",
		},
		{
			name: "an all-day row",
			row: "| heldag | Harbour festival | |",
			time: "heldag",
			meeting: "Harbour festival",
			expected: "| heldag | [[Harbour festival]] | |",
		},
	];

	for (const { name, row, time, meeting, expected } of corpus) {
		it(`for ${name}`, () => {
			const before = block("| 07:00–07:15 | Coffee | |", row, "| 16:00–17:00 | Wrap-up | |");
			const after = written(linkWrite(before, COLUMNS, 1, { time, meeting }));

			expect(after).toEqual([...before.slice(0, 4), expected, ...before.slice(5)]);
		});
	}

	it("keeps a carriage return at the end of every line, the written one included", () => {
		const before = block("| 08:00–08:30 | Standup | |").map((line) => `${line}\r`);
		const after = written(linkWrite(before, COLUMNS, 0, { time: "08:00–08:30", meeting: "Standup" }));

		expect(after).toEqual([...before.slice(0, 3), "| 08:00–08:30 | [[Standup]] | |\r", before[4]]);
	});

	it("finds a table whose header is not the block's first line", () => {
		const before = [FENCE, "A line of the person's own.", "", ...HEADER, "| 08:00–08:30 | Standup | |", CLOSE];
		const after = written(linkWrite(before, COLUMNS, 0, { time: "08:00–08:30", meeting: "Standup" }));

		expect(after[5]).toBe("| 08:00–08:30 | [[Standup]] | |");
		expect(after.filter((_, i) => i !== 5)).toEqual(before.filter((_, i) => i !== 5));
	});

	it("does not change the lines it was handed", () => {
		const before = block("| 08:00–08:30 | Standup | |");
		const copy = [...before];
		linkWrite(before, COLUMNS, 0, { time: "08:00–08:30", meeting: "Standup" });
		expect(before).toEqual(copy);
	});
});

describe("a cell already a link is never written", () => {
	it("refuses a whole link", () => {
		const lines = block("| 13:00–14:00 | [[Design crit]] | |");
		expect(linkWrite(lines, COLUMNS, 0, { time: "13:00–14:00", meeting: "[[Design crit]]" })).toEqual({
			refused: "already-a-link",
		});
	});

	it("refuses a link with a trailing parenthesis", () => {
		const lines = block("| 13:00–14:00 | [[Design crit]] (Online) | |");
		expect(
			linkWrite(lines, COLUMNS, 0, { time: "13:00–14:00", meeting: "[[Design crit]] (Online)" }),
		).toEqual({ refused: "already-a-link" });
	});

	it("refuses an aliased link", () => {
		const lines = block("| 13:00–14:00 | [[Design crit|Crit]] | |");
		expect(
			linkWrite(lines, COLUMNS, 0, { time: "13:00–14:00", meeting: "[[Design crit|Crit]]" }),
		).toEqual({ refused: "already-a-link" });
	});

	it("is idempotent: a second write on a cell the first one linked is refused (carried)", () => {
		const first = written(
			linkWrite(block("| 09:00–10:00 | Lunch | x |"), COLUMNS, 0, { time: "09:00–10:00", meeting: "Lunch" }),
		);
		expect(linkWrite(first, COLUMNS, 0, { time: "09:00–10:00", meeting: "[[Lunch]]" })).toEqual({
			refused: "already-a-link",
		});
	});
});

describe("a cell mixing a link with other text is never written (named difference 11)", () => {
	it("refuses a link followed by two parentheses", () => {
		const cell = "[[Design crit]] (Online) (cancelled)";
		const lines = block(`| 13:00–14:00 | ${cell} | |`);
		expect(linkWrite(lines, COLUMNS, 0, { time: "13:00–14:00", meeting: cell })).toEqual({
			refused: "mixed-link",
		});
	});

	it("refuses a link followed by words", () => {
		const cell = "[[Design crit]] and notes";
		const lines = block(`| 13:00–14:00 | ${cell} | |`);
		expect(linkWrite(lines, COLUMNS, 0, { time: "13:00–14:00", meeting: cell })).toEqual({
			refused: "mixed-link",
		});
	});
});

describe("a row that no longer reads what was drawn is refused (named difference 10)", () => {
	const lines = block("| 08:00–08:30 | Standup | |", "| 09:00–10:00 | Budget review | |");

	it("refuses when the time cell changed", () => {
		expect(linkWrite(lines, COLUMNS, 1, { time: "09:30–10:00", meeting: "Budget review" })).toEqual({
			refused: "table-changed",
		});
	});

	it("refuses when the meeting cell changed", () => {
		expect(linkWrite(lines, COLUMNS, 1, { time: "09:00–10:00", meeting: "Budget planning" })).toEqual({
			refused: "table-changed",
		});
	});

	it("refuses when a row was added above, so another row sits where the drawn one was", () => {
		const moved = block("| 07:00–07:15 | Coffee | |", "| 08:00–08:30 | Standup | |", "| 09:00–10:00 | Budget review | |");
		expect(linkWrite(moved, COLUMNS, 1, { time: "09:00–10:00", meeting: "Budget review" })).toEqual({
			refused: "table-changed",
		});
	});

	it("refuses a row the table no longer has (carried)", () => {
		expect(linkWrite(lines, COLUMNS, 99, { time: "09:00–10:00", meeting: "Budget review" })).toEqual({
			refused: "table-changed",
		});
	});

	it("refuses a row whose time cell is not a time where a time was drawn (carried)", () => {
		const changed = block("| not a time | Lunch | x |");
		expect(linkWrite(changed, COLUMNS, 0, { time: "09:00–10:00", meeting: "Lunch" })).toEqual({
			refused: "table-changed",
		});
	});

	it("refuses lines that hold no table naming both columns any more", () => {
		const renamed = [FENCE, "| When | What |", "| --- | --- |", "| 09:00–10:00 | Budget review |", CLOSE];
		expect(linkWrite(renamed, COLUMNS, 0, { time: "09:00–10:00", meeting: "Budget review" })).toEqual({
			refused: "table-changed",
		});
	});

	it("refuses lines that are no longer a schema block at all", () => {
		const gone = ["Some prose where the block used to be.", "", "More prose."];
		expect(linkWrite(gone, COLUMNS, 0, { time: "09:00–10:00", meeting: "Budget review" })).toEqual({
			refused: "table-changed",
		});
	});
});

describe("which row is written, counted the way the reader counts (carried)", () => {
	it("lands on the right row when a blank line precedes the header", () => {
		const before = [FENCE, "", ...HEADER, "| 08:30–11:30 | Demo | x |", "| 11:30–12:00 | Sync | y |", CLOSE];
		const after = written(linkWrite(before, COLUMNS, 1, { time: "11:30–12:00", meeting: "Sync" }));

		expect(after[5]).toBe("| 11:30–12:00 | [[Sync]] | y |");
		expect(after[4]).toBe("| 08:30–11:30 | Demo | x |");
	});

	it("refuses a row below a blank line inside the table: it is not the table's row any more", () => {
		// The old writer counted past the blank line and wrote row 1 here. The
		// core's table ends at a blank line and the day view lists the rows below
		// it as not read (spec #618, named difference 5), so no block was ever
		// drawn from this row, and a click that claims it was is refused.
		const before = [FENCE, ...HEADER, "| 08:30–11:30 | Demo | x |", "", "| 11:30–12:00 | Sync | y |", CLOSE];
		expect(linkWrite(before, COLUMNS, 1, { time: "11:30–12:00", meeting: "Sync" })).toEqual({
			refused: "table-changed",
		});
	});
});

describe("cells a link cannot be made from", () => {
	it("refuses an empty meeting cell", () => {
		const lines = block("| 08:00–08:30 |  | |");
		expect(linkWrite(lines, COLUMNS, 0, { time: "08:00–08:30", meeting: "" })).toEqual({ refused: "empty" });
	});

	it("refuses a name holding a pipe, which a link would read as the start of an alias", () => {
		const lines = block("| 08:00–08:30 | Red \\| blue | |");
		expect(linkWrite(lines, COLUMNS, 0, { time: "08:00–08:30", meeting: "Red | blue" })).toEqual({
			refused: "pipe-in-name",
		});
	});
});

describe("locateHeldBlock: finding a held write's block fresh, not by a position captured earlier", () => {
	const bodyLines = HEADER.concat("| 08:00–08:30 | Standup | |");

	it("finds the block where it still stands, unchanged", () => {
		const note = ["Some prose.", "", ...block(...bodyLines.slice(2)), "More prose."];
		const found = locateHeldBlock(note, bodyLines, 2);
		expect(found).not.toBeNull();
		expect(found?.from).toBe(2);
		expect(found?.to).toBe(2 + bodyLines.length + 2);
		expect(found?.lines).toEqual(block(...bodyLines.slice(2)));
	});

	it("finds the block moved by lines added above it, ignoring a stale hint", () => {
		const original = ["Some prose.", "", ...block(...bodyLines.slice(2)), "More prose."];
		const shifted = ["Some prose.", "A new line.", "Another new line.", "", ...block(...bodyLines.slice(2)), "More prose."];
		const found = locateHeldBlock(shifted, bodyLines, /* stale hint from `original` */ 2);
		expect(found).not.toBeNull();
		expect(found?.from).toBe(4);
		expect(found?.lines).toEqual(block(...bodyLines.slice(2)));
		expect(original.length + 2).toBe(shifted.length);
	});

	it("returns null when no fenced schema block reads at all", () => {
		expect(locateHeldBlock(["Some prose.", "", "More prose."], bodyLines, 0)).toBeNull();
	});

	it("sets aside each line's own leading spaces, tabs and `>`, fence lines included, and restoreLocatedBlock puts them back untouched", () => {
		const bare = block(...bodyLines.slice(2));
		const quoted = bare.map((line) => `> ${line}`);
		const note = ["# Heading", "", "> [!note]", ...quoted, ""];

		const found = locateHeldBlock(note, bodyLines, 0);
		expect(found).not.toBeNull();
		expect(found?.lines).toEqual(bare);
		expect(found?.prefixes).toEqual(bare.map(() => "> "));

		expect(restoreLocatedBlock(found!.lines, found!)).toEqual(quoted);
	});

	it("picks whichever block reads closest when more than one schema block is in the note, ties broken by distance to the hint", () => {
		const decoyBody = HEADER.concat("| 09:00–10:00 | Retro | |");
		const decoyBlock = block(...decoyBody.slice(2));
		const realBlock = block(...bodyLines.slice(2));
		const note = [...decoyBlock, "", ...realBlock];
		const decoyStart = 0;
		const realStart = decoyBlock.length + 1;

		expect(locateHeldBlock(note, bodyLines, realStart)?.from).toBe(realStart);
		expect(locateHeldBlock(note, decoyBody, decoyStart)?.from).toBe(decoyStart);
	});
});

/** A note's metadata-cache section spanning `startLine` to `endLine`, both 0-based and inclusive. */
function section(startLine: number, endLine: number): SectionCache {
	return {
		type: "callout",
		position: { start: { line: startLine, col: 0, offset: 0 }, end: { line: endLine, col: 0, offset: 0 } },
	};
}

describe("blockInsideCallout: telling a genuinely callout-nested block apart from an exported view, by line range", () => {
	const bodyLines = HEADER.concat("| 08:00–08:30 | Standup | |");

	it("is true when the located block's own line range lies inside the section", () => {
		const bare = block(...bodyLines.slice(2));
		const quoted = bare.map((line) => `> ${line}`);
		const note = ["# Heading", "", "> [!note]", ...quoted, ""];
		const found = locateHeldBlock(note, bodyLines, 0);
		expect(found).not.toBeNull();

		expect(blockInsideCallout(found!, [section(2, found!.to - 1)])).toBe(true);
	});

	it("is false when a callout sits elsewhere in the note and does not reach the block", () => {
		const bare = block(...bodyLines.slice(2));
		const note = ["> [!note]", "> An unrelated callout.", "", ...bare];
		const found = locateHeldBlock(note, bodyLines, 0);
		expect(found).not.toBeNull();

		expect(blockInsideCallout(found!, [section(0, 1)])).toBe(false);
	});

	it("is false when the note holds no callout or blockquote section at all", () => {
		const bare = block(...bodyLines.slice(2));
		const found = locateHeldBlock(bare, bodyLines, 0);
		expect(found).not.toBeNull();

		expect(blockInsideCallout(found!, [])).toBe(false);
	});
});
