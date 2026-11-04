import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { readDay } from "../features/dayView/readDay";
import { readMeetingCell } from "../features/dayView/meetingCell";
import { withoutComments } from "./sourceGuards";
import type { ColumnNames } from "../core/calendarTable";
import type { Day } from "../features/dayView/types";

/**
 * `readDay` reads through the core's body reader and `readTimeCell`, and
 * reads its own meeting cell through `readMeetingCell`.
 *
 * **The parity corpus is the central block below**: every table
 * `~/Devbox/schema-render/src/__tests__/parser.test.ts` fed `parseSchedule`,
 * header rewritten to this file's configured column names, read through
 * `readDay` and asserted to give the old parser's answer — except where
 * #618's *Named differences* rows 1 to 5 say otherwise, each such case
 * citing its row. The old suite's structural failures (wrong headers, too
 * few columns, a non-separator second row) are not carried here: they are
 * `parseCalendarTableFromBody`'s own answers, already the core's suite
 * (`calendarTable.test.ts`), and #618's named differences 1, 3 and 4 change
 * several of them outright — a two-column table and a header not on the
 * block's first line are now drawn rather than refused.
 *
 * Fixtures use the day view's own configured names, `Time` and `Meeting` —
 * the core's own default (`src/core/settings.ts`) — rather than the old
 * plugin's hard-coded Swedish header, because #618 decision 5 made the
 * column names something the person configures rather than a protected
 * literal.
 */

const columns: ColumnNames = { time: "Time", event: "Meeting" };
const header = "| Time | Meeting |";
const separator = "| --- | --- |";

function body(...rows: string[]): string[] {
	return [header, separator, ...rows];
}

function expectFound(day: Day): asserts day is Exclude<Day, { fallback: string }> {
	if ("fallback" in day) throw new Error(`expected a day, got fallback: ${day.fallback}`);
}

function expectFallback(day: Day): asserts day is { fallback: string } {
	if (!("fallback" in day)) throw new Error("expected a fallback");
}

describe("readDay as shipped code", () => {
	const source = readFileSync(resolve(__dirname, "..", "features", "dayView", "readDay.ts"), "utf8");

	it("imports the table reader and the time-cell reader from the core, and declares no time or table parsing of its own", () => {
		const imports = source.match(/^[ \t]*import\s.*$/gm) ?? [];
		expect(imports).toEqual([
			'import { parseCalendarTableFromBody, type CalendarTable, type CalendarTableAbsence, type ColumnNames } from "../../core/calendarTable";',
			'import { readTimeCell } from "../../core/timeCell";',
			'import { readMeetingCell, type MeetingCell } from "./meetingCell";',
			'import type { AllDayMeeting, Day, RowError, TimedMeeting, UnreadRow } from "./types";',
		]);
		// The only pattern this file owns is the pipe-prefix check for a line the
		// core's table reader never reached (named difference 5) — no digit-pair
		// time pattern of its own, and no cell-splitting of its own.
		expect(source).not.toContain("\\d{1,2}");
		expect(source).not.toContain('.split("|")');
	});
});

describe("parity corpus — every old parseSchedule table, read through readDay", () => {
	it("parses a valid two-row day", () => {
		// Carried from parser.test.ts:444, third column dropped (named difference 2).
		// The old renderer drew display+trailingParen joined (schema-render/src/renderer.ts:61-62,
		// formatCell) — restored here after #642 found the join missing from readDay's own text.
		const day = readDay(body("| 09:00–10:00 | Lunch |", "| 10:00–11:30 | [[Möte]] (Skype) |"), columns);
		expectFound(day);
		expect(day.timed).toHaveLength(2);
		expect(day.timed[0]).toEqual({ startMin: 540, endMin: 600, text: "Lunch", rowIndex: 0 });
		expect(day.timed[1].text).toBe("Möte (Skype)");
		expect(day.rowErrors).toEqual([]);
	});

	it("gives an empty day when only the header and separator are present", () => {
		// Carried from parser.test.ts:520.
		const day = readDay(body(), columns);
		expectFound(day);
		expect(day).toEqual({ bars: [], timed: [], rowErrors: [], unread: [] });
	});

	it("preserves a wikilink's alias through the meeting cell", () => {
		// Carried from parser.test.ts:528.
		const day = readDay(body("| 09:00–10:00 | [[Note|Alias]] |"), columns);
		expectFound(day);
		expect(day.timed[0].text).toBe(readMeetingCell("[[Note|Alias]]").display);
		expect(day.timed[0].text).toBe("Alias");
	});

	it("keeps the readable rows when one row's time cannot be read", () => {
		// Carried from parser.test.ts:561.
		const day = readDay(
			body("| 09:00–10:00 | Lunch |", "| 25:00–26:00 | Skidåkning |", "| 13:00–14:00 | [[Möte]] |"),
			columns,
		);
		expectFound(day);
		expect(day.timed.map((m) => m.text)).toEqual(["Lunch", "Möte"]);
		expect(day.rowErrors).toHaveLength(1);
		expect(day.rowErrors[0].reason).toMatch(/Invalid time/);
		expect(day.rowErrors[0].rawLine).toContain("25:00");
	});

	it("counts rowIndex by physical row, so a skipped or unreadable row does not shift the rest", () => {
		// Carried from parser.test.ts:585.
		const day = readDay(
			body("|     |      |", "| 25:00–26:00 | Skidåkning |", "| 13:00–14:00 | Möte |"),
			columns,
		);
		expectFound(day);
		expect(day.timed).toHaveLength(1);
		expect(day.timed[0].rowIndex).toBe(2);
		expect(day.rowErrors).toHaveLength(1);
	});

	it("skips the template's placeholder row without calling it an error", () => {
		// Carried from parser.test.ts:602.
		const day = readDay(body("|     |      |"), columns);
		expectFound(day);
		expect(day.timed).toEqual([]);
		expect(day.rowErrors).toEqual([]);
	});

	it("reports a blank time cell as a row error — not the placeholder, since the meeting cell is filled", () => {
		// A second, readable row keeps this a row error rather than the
		// whole-table fallback, which needs every row with content to fail.
		const day = readDay(body("|  | Lunch |", "| 09:00–10:00 | Standup |"), columns);
		expectFound(day);
		expect(day.timed).toHaveLength(1);
		expect(day.rowErrors).toHaveLength(1);
		expect(day.rowErrors[0].reason).toMatch(/Invalid time/);
		expect(day.rowErrors[0].rawLine).toBe("|  | Lunch |");
	});

	it("reports a word in the time cell as a row error", () => {
		const day = readDay(body("| lunchtid | Lunch |", "| 09:00–10:00 | Standup |"), columns);
		expectFound(day);
		expect(day.timed).toHaveLength(1);
		expect(day.rowErrors).toHaveLength(1);
		expect(day.rowErrors[0].reason).toMatch(/Invalid time "lunchtid"/);
		expect(day.rowErrors[0].rawLine).toBe("| lunchtid | Lunch |");
	});

	it("reports a row whose end time is before its start time", () => {
		// Carried from parser.test.ts:611.
		const day = readDay(body("| 09:00–10:00 | Lunch |", "| 10:00–09:00 | Backwards |"), columns);
		expectFound(day);
		expect(day.timed).toHaveLength(1);
		expect(day.rowErrors).toHaveLength(1);
		expect(day.rowErrors[0].reason).toMatch(/end time is before the start time/);
		expect(day.rowErrors[0].rawLine).toBe("| 10:00–09:00 | Backwards |");
	});

	it("lets a zero-length range through — it is degenerate, not backwards", () => {
		// Carried from parser.test.ts:646.
		const day = readDay(body("| 10:00–10:00 | Standup |"), columns);
		expectFound(day);
		expect(day.timed).toHaveLength(1);
		expect(day.rowErrors).toEqual([]);
	});

	it("falls back to a whole-table reason when not one row with content could be read", () => {
		// Carried from parser.test.ts:671.
		const day = readDay(body("| 25:00–26:00 | Skidåkning |", "| 26:00–27:00 | Backe |"), columns);
		expectFallback(day);
		expect(day.fallback).toMatch(/Not one of the 2 rows with content could be read/);
		expect(day.fallback).toMatch(/Invalid time/);
	});

	it("names the true row when a blank line sits above the header (parser.test.ts:631)", () => {
		// Carried directly (not through `body()`, which always puts the header
		// first): a leading blank line inside the block must not shift which
		// physical row a row error points at. The old parser numbered this by
		// `lineNumber`; `readDay` has no such field, so parity is the row
		// error naming the true failing line through `rawLine` instead.
		const day = readDay(
			["", header, separator, "| 09:00–10:00 | Lunch |", "| 25:00–26:00 | Ski |"],
			columns,
		);
		expectFound(day);
		expect(day.timed).toHaveLength(1);
		expect(day.rowErrors).toHaveLength(1);
		expect(day.rowErrors[0].rawLine).toBe("| 25:00–26:00 | Ski |");
	});

	// #640: a row with fewer cells than the header is, as in the old parser, a
	// row error (or, when it is the only row, the whole-table fallback) with a
	// reason matching /cells/ — never a meeting with a blank name.
	// `CalendarRow.cellCount` and `CalendarTable.columnCount`
	// (`src/core/calendarTable.ts`) are what let `readDay` tell
	// "| 11:00–12:00 |" (one cell) from "| 11:00–12:00 | |" (two cells, the
	// second blank) apart, rather than reading both as a meeting with a blank
	// name.
	it("falls back with a cells-count reason when the only data row is short (parser.test.ts:512)", () => {
		const day = readDay(body("| 11:00–12:00 |"), columns);
		expectFallback(day);
		expect(day.fallback).toMatch(/cells/);
	});

	it("reports a short row as a row error, without losing the readable rows (parser.test.ts:655)", () => {
		const day = readDay(body("| 09:00–10:00 | Lunch |", "| 11:00–12:00 |"), columns);
		expectFound(day);
		expect(day.timed.map((m) => m.text)).toEqual(["Lunch"]);
		expect(day.rowErrors).toHaveLength(1);
		expect(day.rowErrors[0].reason).toMatch(/cells/);
	});

	it("marks a 00:00–23:59 row and a heldag row as all-day bars", () => {
		// Carried from parser.test.ts:739; the two real place names there replaced with invented ones that are not places
		// themselves — the first pair tried, "Kroksjö" and "Fjällbo", turned
		// out to both be real places too.
		const day = readDay(body("| 00:00–23:59 | Städdag |", "| heldag | Läsdag |"), columns);
		expectFound(day);
		expect(day.bars.map((b) => b.text)).toEqual(["Städdag", "Läsdag"]);
		expect(day.timed).toEqual([]);
		expect(day.rowErrors).toEqual([]);
	});

	it("leaves a timed row alone", () => {
		// Carried from parser.test.ts:750; the real activity there replaced with an invented one.
		const day = readDay(body("| 12:00–13:30 | Bågskytte |"), columns);
		expectFound(day);
		expect(day.timed).toHaveLength(1);
		expect(day.bars).toEqual([]);
	});

	it("numbers all-day and timed rows in one sequence, whichever order they come in", () => {
		// Carried from parser.test.ts:756.
		const allDayFirst = readDay(
			body("| heldag | A |", "| 12:00–13:00 | B |", "| 00:00–23:59 | C |"),
			columns,
		);
		expectFound(allDayFirst);
		expect(allDayFirst.bars.map((b) => [b.text, b.rowIndex])).toEqual([
			["A", 0],
			["C", 2],
		]);
		expect(allDayFirst.timed.map((m) => [m.text, m.rowIndex])).toEqual([["B", 1]]);

		const timedFirst = readDay(
			body("| 09:00–10:00 | A |", "| heldag | B |", "| 11:00–12:00 | C |"),
			columns,
		);
		expectFound(timedFirst);
		expect(timedFirst.timed.map((m) => [m.text, m.rowIndex])).toEqual([
			["A", 0],
			["C", 2],
		]);
		expect(timedFirst.bars.map((b) => [b.text, b.rowIndex])).toEqual([["B", 1]]);
	});

	it("reads an all-day row whose meeting cell is a wikilink plus trailing text", () => {
		// Carried from parser.test.ts:785. The real day's-log path and the real
		// family trip's name, word and dates are replaced by an
		// invented target, alias and trailing word of the same shape: a
		// wikilink's table-escaped alias, followed by ", " and more text — and
		// carrying no year, since a year turned out to be the closest thing a
		// first attempt at this fixture left to the real dates it replaced. The escaped pipe in the row below is how the markdown table
		// carries it; the core's cell reader unescapes it before this reading
		// ever sees the cell (`readCell` in `src/core/calendarTable.ts`), so the
		// bar's text below carries a bare pipe, not the escaped one the old
		// parser's own pin kept (parser.test.ts:803). That is a real change
		// from the old answer, and none of #618's five named differences
		// names it — the row that would cover "a table-escaped pipe inside a
		// cell reads as a bare one" does not exist yet.
		const day = readDay(body("| heldag | [[Höstlovet\\|Lovet]], vandring |"), columns);
		expectFound(day);
		expect(day.bars).toHaveLength(1);
		// Pinned as it is, not as it should be — parity with the old plugin's own
		// pin (parser.test.ts:794): a link followed by words is not a whole
		// wikilink, so it reads as plain text and the brackets show in the bar.
		const cell = readMeetingCell("[[Höstlovet|Lovet]], vandring");
		expect(cell.isWikilink).toBe(false);
		expect(cell.looksLikeLink).toBe(true);
		expect(day.bars[0].text).toBe("[[Höstlovet|Lovet]], vandring");
	});

	it("falls back to the row's own reason when the only row's time is neither a range nor the word", () => {
		// Carried from parser.test.ts:809.
		const day = readDay(body("| heldagen | A |"), columns);
		expectFallback(day);
		expect(day.fallback).toMatch(/heldagen/);
	});
});

describe("readDay — rows the core's table never reached (named difference 5)", () => {
	it("lists a row below a blank line as unread, naming the blank line", () => {
		const day = readDay(body("| 09:00–10:00 | Lunch |", "", "| 11:00–12:00 | Later |"), columns);
		expectFound(day);
		expect(day.timed).toHaveLength(1);
		expect(day.unread).toEqual([{ line: "| 11:00–12:00 | Later |", stoppedBy: "blank-line" }]);
	});

	it("lists a row below a row wider than the header as unread, naming the wide row", () => {
		const day = readDay(
			body("| 09:00–10:00 | Lunch |", "| 11:00–12:00 | Wide | extra |", "| 13:00–14:00 | Later |"),
			columns,
		);
		expectFound(day);
		expect(day.timed).toHaveLength(1);
		expect(day.unread).toEqual([
			{ line: "| 11:00–12:00 | Wide | extra |", stoppedBy: "wide-row" },
			{ line: "| 13:00–14:00 | Later |", stoppedBy: "wide-row" },
		]);
	});

	it("does not list a non-table line below the table's end", () => {
		const day = readDay(body("| 09:00–10:00 | Lunch |", "", "A plain sentence, not a row."), columns);
		expectFound(day);
		expect(day.unread).toEqual([]);
	});

	it("gives no unread rows when the block ends exactly at the table", () => {
		const day = readDay(body("| 09:00–10:00 | Lunch |"), columns);
		expectFound(day);
		expect(day.unread).toEqual([]);
	});
});

describe("readDay — a prose line groups with blank-line, not wide-row", () => {
	it("labels a row below a line of prose blank-line, matching the core's own grouping", () => {
		const day = readDay(body("| 09:00–10:00 | A |", "Notes about the day", "| 11:00–12:00 | B |"), columns);
		expectFound(day);
		expect(day.unread).toEqual([{ line: "| 11:00–12:00 | B |", stoppedBy: "blank-line" }]);
	});
});

describe("readDay — a third column is neither read nor kept (named difference 2)", () => {
	it("ignores a third column entirely", () => {
		const threeColumnHeader = "| Time | Meeting | Effort |";
		const threeColumnSeparator = "| --- | --- | --- |";
		const day = readDay(
			[threeColumnHeader, threeColumnSeparator, "| 09:00–10:00 | Lunch | [[Uppdrag]] |"],
			columns,
		);
		expectFound(day);
		expect(day.timed[0]).toEqual({ startMin: 540, endMin: 600, text: "Lunch", rowIndex: 0 });
	});
});

describe("readDay — the drawn text carries a trailing parenthesis", () => {
	// #642: readDay kept only readMeetingCell's `display`, dropping the trailing
	// parenthesis the old renderer joined onto it (formatCell,
	// schema-render/src/renderer.ts:61-62). The join is folded into the meeting's
	// own `text` here — no new field on TimedMeeting/AllDayMeeting/Day, and
	// isWikilink/linktext/looksLikeLink stay out of the day's reading (#628
	// rereads the raw block lines for its own click handling).

	it("draws a plain-text cell's trailing parenthesis after its name", () => {
		const day = readDay(body("| 09:00–10:00 | Möte (Skype) |"), columns);
		expectFound(day);
		expect(day.timed[0].text).toBe("Möte (Skype)");
	});

	it("draws a wikilink cell's trailing parenthesis after its display text", () => {
		const day = readDay(body("| 09:00–10:00 | [[Möte]] (Skype) |"), columns);
		expectFound(day);
		expect(day.timed[0].text).toBe("Möte (Skype)");
	});

	it("leaves a cell with no trailing parenthesis unaffected", () => {
		const day = readDay(body("| 09:00–10:00 | Möte |", "| 11:00–12:00 | [[Möte]] |"), columns);
		expectFound(day);
		expect(day.timed[0].text).toBe("Möte");
		expect(day.timed[1].text).toBe("Möte");
	});

	it("draws a bar's trailing parenthesis the same way as a timed meeting's", () => {
		const day = readDay(body("| heldag | Möte (Skype) |"), columns);
		expectFound(day);
		expect(day.bars[0].text).toBe("Möte (Skype)");
	});
});

describe("readDay — no table found", () => {
	it("falls back with the core's reason when no table names both columns", () => {
		const day = readDay(["| A | B |", "| --- | --- |", "| x | y |"], columns);
		expectFallback(day);
		expect(day.fallback).toBe("No table names both columns.");
	});

	it("falls back with the core's reason when a table names one of the columns twice", () => {
		const day = readDay(["| Time | Time |", "| --- | --- |"], columns);
		expectFallback(day);
		expect(day.fallback).toBe("A table names one of the configured columns twice.");
	});
});

describe("no real name, place, calendar, path or date in this file's own fixtures", () => {
	/**
	 * #21 and #618 § 17 name a real place, a real activity, a real family
	 * trip's name and word, and a real calendar name that the old
	 * `parser.test.ts` fixtures carried — plus a real day's-log path and the
	 * trip's real dates
	 * (`~/Devbox/schema-render/src/__tests__/parser.test.ts:448`, `:458`,
	 * `:741`, `:751`, `:786`, `:803-806`). None of the five words is spelled
	 * out here: spelling them out would put back exactly what the scrub
	 * took out, which is what the old version of this guard did.
	 *
	 * So this hashes every word-shaped token this file's own fixtures hold and
	 * compares it against the five words' hashes, computed once, offline, from
	 * #21 and the lines above — never from a literal written here. A fixture
	 * shaped like a vault path or a calendar date is refused outright, because
	 * #618 § 17 lists both alongside the five words and neither needs a name
	 * to be worth catching.
	 *
	 * "Kroksjö", "Fjällbo" and "Fjällvy" were themselves real places, so
	 * a hash could not have caught them: they came from nowhere on #618 § 17's
	 * list, and the reviewers' finding is the evidence they were wrong, not a
	 * failing test. They are replaced above by "Städdag", "Läsdag" and
	 * "Höstlovet"/"Lovet", none of which names a place. A bare four-digit year
	 * counts as a date shape below for the same reason: "Fjällvy 2027" was the
	 * closest thing a first attempt left to the trip's real dates once the day
	 * and month were gone.
	 */
	const bannedWordHashes = new Set([
		"8602feac94ac1940bf0e219cc25992c7df797df1647d471f3cd7f3bbcb4199b2",
		"75e4b8e2c3850b9ebb1ab01eba7e4c7007457abf85525e0f172a3b513e60b13d",
		"c7174b341da129538827a81fa43b436f95e92fb6ad1b2cf7dbe185bef9a69eb5",
		"0a747b511ade8590ac126f63bb0636f4938838a1b01caebc972614ff4123a511",
		"0465ee92df5c06b1c85d43a4bf6a7d71f251bc46e2bb05a837cba0d35cec5a58",
	]);

	function hash(word: string): string {
		return createHash("sha256").update(word.toLowerCase(), "utf8").digest("hex");
	}

	// A vault path: a string ending `.md`, or one holding two or more
	// slashes at all — a day's-log path is always at least this deep.
	function looksLikeVaultPath(text: string): boolean {
		if (!text.includes("/")) return false;
		if (/\.md$/i.test(text.trim())) return true;
		return (text.match(/\//g) ?? []).length >= 2;
	}

	const swedishMonths =
		"januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december";

	// A calendar date: an ISO date, a day and month joined by "." or "/", a
	// day with a Swedish month name, or a bare year (see the doc comment above).
	function looksLikeCalendarDate(text: string): boolean {
		if (/\b\d{4}-\d{2}-\d{2}\b/.test(text)) return true;
		if (/\b\d{1,2}[./]\d{1,2}([./]\d{2,4})?\b/.test(text)) return true;
		if (new RegExp(`\\b\\d{1,2}\\s+(${swedishMonths})\\b`, "i").test(text)) return true;
		if (/\b(19|20)\d{2}\b/.test(text)) return true;
		return false;
	}

	// This file's own fixtures: every double-quoted string literal outside a
	// comment or an `import` line — comments stripped by `./sourceGuards`'s
	// own `withoutComments`, the one place this repository answers that
	// question, so this file's own prose (including the doc comment just
	// above, which names the real places #637 found) stays free to say what
	// its fixtures may not, and an import specifier's slash is never read as
	// a vault path.
	//
	// Walked one character at a time rather than by two independent regexes,
	// one per quote mark: this file's own "imports the table reader…" test
	// holds single-quoted strings whose *contents* are themselves double
	// quoted (`'import { … } from "../../core/calendarTable";'`), and a
	// double-quote regex run on its own reads that inner double-quoted text
	// as a fixture — exactly the kind of import specifier this guard exists
	// to leave alone.
	function fixtureStrings(source: string): string[] {
		const codeOnly = withoutComments(source)
			.split("\n")
			.filter((line) => !/^\s*import\s/.test(line))
			.join("\n");

		const strings: string[] = [];
		let i = 0;
		while (i < codeOnly.length) {
			const quote = codeOnly[i];
			if (quote !== '"' && quote !== "'" && quote !== "`") {
				i++;
				continue;
			}
			let value = "";
			let j = i + 1;
			while (j < codeOnly.length && codeOnly[j] !== quote) {
				if (codeOnly[j] === "\\") {
					value += codeOnly[j] + (codeOnly[j + 1] ?? "");
					j += 2;
					continue;
				}
				value += codeOnly[j];
				j++;
			}
			if (quote === '"') strings.push(value);
			i = j + 1;
		}
		return strings;
	}

	it("carries no fixture shaped like the old plugin's real names, a vault path or a calendar date", () => {
		for (const file of ["dayViewReadDay.test.ts", "dayViewMeetingCell.test.ts"]) {
			const source = readFileSync(resolve(__dirname, file), "utf8");
			for (const text of fixtureStrings(source)) {
				for (const token of text.match(/\p{L}+/gu) ?? []) {
					expect(bannedWordHashes.has(hash(token))).toBe(false);
				}
				expect(looksLikeVaultPath(text)).toBe(false);
				expect(looksLikeCalendarDate(text)).toBe(false);
			}
		}
	});
});
