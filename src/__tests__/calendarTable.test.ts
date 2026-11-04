import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	editCalendarCell,
	parseCalendarTable,
	parseCalendarTableFromBody,
	writeCalendarRows,
	type CalendarRowWrite,
	type CalendarTable,
	type CalendarTableAbsence,
	type ColumnNames,
} from "../core/calendarTable";

/**
 * The table when one was read, or `null` when none was.
 *
 * `parseCalendarTable` returns *why* it read none as well, and that is
 * asserted on its own below. Every assertion that is about what the reader
 * reads rather than about what it says flattens the outcome through here, so
 * those tests still read as one call and one expectation.
 */
function parsedTable(lines: readonly string[], columns: ColumnNames): CalendarTable | null {
	const outcome = parseCalendarTable(lines, columns);
	return outcome.found ? outcome.table : null;
}

/** The same flattening as {@link parsedTable}, over {@link parseCalendarTableFromBody}. */
function parsedBodyTable(lines: readonly string[], columns: ColumnNames): CalendarTable | null {
	const outcome = parseCalendarTableFromBody(lines, columns);
	return outcome.found ? outcome.table : null;
}

/**
 * The new lines when the write landed, or `null` when no table matched.
 *
 * `editCalendarCell` returns *why* it wrote nothing as well, and that
 * is asserted on its own below. Every assertion that is about the bytes the
 * writer writes rather than about what it says flattens the outcome through
 * here, the way `parsedTable` does for the reader.
 */
function edited(
	lines: readonly string[],
	columns: ColumnNames,
	cell: { row: number; column: "time" | "event"; value: string },
): string[] | null {
	const outcome = editCalendarCell(lines, columns, cell);
	return outcome.found ? outcome.lines : null;
}

/** The shipped defaults' capitals, so that the tests exercise case folding. */
const columns: ColumnNames = { time: "Time", event: "Event" };

/** A calendar section of a day's log: the heading, the fenced block, and what follows it. */
function section(...table: string[]): string[] {
	return ["## Calendar", "", "```schema", ...table, "```", "", "## Notes", ""];
}

const table = [
	"| Time  | Event         |",
	"| ----- | ------------- |",
	"| 09:00 | Standup       |",
	"| 13:30 | Design review |",
];

/**
 * Asserts that `after` differs from `before` on exactly one line, and returns
 * that line's index. This is the byte-identical rule: an edit changes one cell
 * and leaves every other byte of the note alone.
 */
function theOneChangedLine(before: readonly string[], after: readonly string[]): number {
	expect(after).toHaveLength(before.length);
	const changed: number[] = [];
	for (let i = 0; i < before.length; i++) {
		if (before[i] !== after[i]) changed.push(i);
	}
	expect(changed).toHaveLength(1);
	return changed[0];
}

describe("parseCalendarTable", () => {
	it("reads a table whose headings match the configured names", () => {
		const parsed = parsedTable(section(...table), columns);

		expect(parsed?.rows).toEqual([
			{ line: 5, time: "09:00", event: "Standup", cellCount: 2 },
			{ line: 6, time: "13:30", event: "Design review", cellCount: 2 },
		]);
		expect(parsed?.headerLine).toBe(3);
	});

	it("ignores capitals on both sides of the match", () => {
		const parsed = parsedTable(
			section("| TIME | eVeNt |", "| --- | --- |", "| 09:00 | Standup |"),
			{ time: "tImE", event: "EVENT" },
		);

		expect(parsed?.rows).toEqual([{ line: 5, time: "09:00", event: "Standup", cellCount: 2 }]);
	});

	it("reads the columns in whichever order the table writes them", () => {
		const parsed = parsedTable(
			section("| Event | Time |", "| --- | --- |", "| Standup | 09:00 |"),
			columns,
		);

		expect(parsed?.rows).toEqual([{ line: 5, time: "09:00", event: "Standup", cellCount: 2 }]);
	});

	it("refuses a two-column table whose headings do not match", () => {
		const parsed = parsedTable(
			section("| Ingredient | Amount |", "| --- | --- |", "| Flour | 300 g |"),
			columns,
		);

		expect(parsed).toBeNull();
	});

	it("refuses a table matching on only one of the two names", () => {
		const parsed = parsedTable(
			section("| Time | Duration |", "| --- | --- |", "| 09:00 | 15 min |"),
			columns,
		);

		expect(parsed).toBeNull();
	});

	it("refuses a three-column table whose headings do not match either", () => {
		const parsed = parsedTable(
			section("| Ingredient | Amount | Note |", "| --- | --- | --- |", "| Flour | 300 g | — |"),
			columns,
		);

		expect(parsed).toBeNull();
	});

	it("reads a table with no rows yet as a table with no rows", () => {
		const parsed = parsedTable(section("| Time | Event |", "| --- | --- |"), columns);

		expect(parsed?.rows).toEqual([]);
	});

	it("reads a table carrying a third column it does not know", () => {
		const parsed = parsedTable(
			section(
				"| Time | Event | Effort |",
				"| --- | --- | --- |",
				"| 09:00 | Standup | 15 |",
			),
			columns,
		);

		expect(parsed?.rows).toEqual([{ line: 5, time: "09:00", event: "Standup", cellCount: 3 }]);
	});

	it("refuses a matching table that is not inside a fenced schema block", () => {
		const parsed = parsedTable(["## Calendar", "", ...table, ""], columns);

		expect(parsed).toBeNull();
	});

	it("refuses a matching table inside a fence that is not a schema block", () => {
		const parsed = parsedTable(
			["## Calendar", "", "```markdown", ...table, "```"],
			columns,
		);

		expect(parsed).toBeNull();
	});

	it("finds the table in a later schema block when the first holds none", () => {
		const parsed = parsedTable(
			[
				"```schema",
				"| Ingredient | Amount |",
				"| --- | --- |",
				"| Flour | 300 g |",
				"```",
				"",
				"```schema",
				...table,
				"```",
			],
			columns,
		);

		expect(parsed?.headerLine).toBe(7);
	});

	it("refuses a table naming one of the configured columns twice", () => {
		const parsed = parsedTable(
			section("| Time | Event | time |", "| --- | --- | --- |", "| 09:00 | Standup | 1 |"),
			columns,
		);

		expect(parsed).toBeNull();
	});

	it("refuses a header with no row of dashes under it", () => {
		const parsed = parsedTable(
			section("| Time | Event |", "| 09:00 | Standup |"),
			columns,
		);

		expect(parsed).toBeNull();
	});

	it("stops the rows at the first line that is not a row", () => {
		const parsed = parsedTable(
			section(...table, "", "| 15:00 | Too late |"),
			columns,
		);

		expect(parsed?.rows).toHaveLength(2);
	});

	it("stops the rows at the closing fence", () => {
		const parsed = parsedTable(section(...table), columns);

		expect(parsed?.rows).toHaveLength(2);
	});

	it("reads a cell holding an escaped pipe as the pipe itself", () => {
		const parsed = parsedTable(
			section("| Time | Event |", "| --- | --- |", "| 09:00 | Ada \\| Bob |"),
			columns,
		);

		expect(parsed?.rows[0].event).toBe("Ada | Bob");
	});

	it("reads a row whose trailing cell is missing as an empty cell", () => {
		const parsed = parsedTable(
			section("| Time | Event |", "| --- | --- |", "| 09:00 |"),
			columns,
		);

		expect(parsed?.rows).toEqual([{ line: 5, time: "09:00", event: "", cellCount: 1 }]);
	});

	// #640: `readDay` needs to tell this row apart from one whose event cell
	// was written blank — both read `event` as `""` — so its own `cellCount`
	// is fewer than the table's `columnCount` rather than the two being equal.
	it("gives a short row a cell count fewer than the table's column count", () => {
		const parsed = parsedTable(
			section("| Time | Event |", "| --- | --- |", "| 09:00 |"),
			columns,
		);

		expect(parsed?.columnCount).toBe(2);
		expect(parsed?.rows[0].cellCount).toBe(1);
	});

	it("returns null for lines holding nothing at all", () => {
		expect(parsedTable([], columns)).toBeNull();
	});

	it("returns null when the two configured names are the same word", () => {
		expect(parsedTable(section(...table), { time: "Time", event: "time" })).toBeNull();
	});

	it("returns null when a configured name is blank", () => {
		expect(parsedTable(section(...table), { time: "", event: "Event" })).toBeNull();
	});
});

describe("what parseCalendarTable says when it finds nothing", () => {
	it("tells a note with no schema block apart from a block holding no readable table", () => {
		expect(parseCalendarTable(["## Calendar", "", ...table, ""], columns)).toEqual({
			found: false,
			absence: "no-schema-block",
		});
		expect(parseCalendarTable(section("| Ingredient |", "| --- |"), columns)).toEqual({
			found: false,
			absence: "no-table-in-block",
		});
	});

	it("says a block held no readable table when the table in it has no leading pipes", () => {
		const pipeless = section("Time  | Event", "----- | -----", "09:00 | Standup");

		expect(parseCalendarTable(pipeless, columns)).toEqual({
			found: false,
			absence: "no-table-in-block",
		});
	});

	it("keeps the two ambiguous cases apart from each other and from an unreadable block", () => {
		expect(parseCalendarTable(section(...table), { time: "Time", event: "time" })).toEqual({
			found: false,
			absence: "column-names-alike",
		});
		expect(parseCalendarTable(section(...table), { time: "", event: "Event" })).toEqual({
			found: false,
			absence: "column-name-blank",
		});
		expect(
			parseCalendarTable(
				section("| Time | Event | Time |", "| --- | --- | --- |", "| 09:00 | x | 10:00 |"),
				columns,
			),
		).toEqual({ found: false, absence: "column-named-twice" });
	});

	it("hands the table itself back under found, so a caller reads one shape", () => {
		const outcome = parseCalendarTable(section(...table), columns);

		expect(outcome.found).toBe(true);
		if (!outcome.found) throw new Error("the table was not found");
		expect(outcome.table.headerLine).toBe(3);
		expect(outcome.table.rows).toHaveLength(2);
	});
});

describe("editCalendarCell", () => {
	it("changes the named cell and leaves every other byte identical", () => {
		const before = section(...table);

		const after = edited(before, columns, { row: 1, column: "time", value: "14:00" });

		expect(after).not.toBeNull();
		const line = theOneChangedLine(before, after!);
		expect(line).toBe(6);
		expect(after![line]).toBe("| 14:00 | Design review |");
	});

	it("keeps the padding the cell was written with", () => {
		const before = section(
			"| Time | Event |",
			"| --- | --- |",
			"|   09:00   |   Standup   |",
		);

		const after = edited(before, columns, { row: 0, column: "event", value: "Retro" });

		expect(after![5]).toBe("|   09:00   |   Retro   |");
	});

	it("gives a cell that was written empty one space on each side", () => {
		const before = section("| Time | Event |", "| --- | --- |", "| 09:00 ||");

		const after = edited(before, columns, { row: 0, column: "event", value: "Retro" });

		expect(after![5]).toBe("| 09:00 | Retro |");
	});

	it("escapes a pipe in the new value so the table keeps its shape", () => {
		const before = section(...table);

		const after = edited(before, columns, {
			row: 0,
			column: "event",
			value: "Ada | Bob",
		});

		// The fixture pads its event column, and that padding is kept.
		expect(after![5]).toBe("| 09:00 | Ada \\| Bob       |");
		expect(parsedTable(after!, columns)?.rows[0].event).toBe("Ada | Bob");
	});

	it("writes to the right column when the table writes them the other way round", () => {
		const before = section("| Event | Time |", "| --- | --- |", "| Standup | 09:00 |");

		const after = edited(before, columns, { row: 0, column: "time", value: "10:00" });

		expect(after![5]).toBe("| Standup | 10:00 |");
	});

	it("leaves a third column it does not know untouched", () => {
		const before = section(
			"| Time | Event | Effort |",
			"| --- | --- | --- |",
			"| 09:00 | Standup | 15 |",
		);

		const after = edited(before, columns, { row: 0, column: "event", value: "Retro" });

		expect(after![5]).toBe("| 09:00 | Retro | 15 |");
	});

	it("writes the same bytes back when the value has not changed", () => {
		const before = section(...table);

		const after = edited(before, columns, {
			row: 1,
			column: "event",
			value: "Design review",
		});

		expect(after).toEqual(before);
	});

	it("does not change the lines it was given", () => {
		const before = section(...table);
		const copy = [...before];

		edited(before, columns, { row: 0, column: "time", value: "07:15" });

		expect(before).toEqual(copy);
	});

	it("returns null when there is no matching table to edit", () => {
		const before = section("| Ingredient | Amount |", "| --- | --- |", "| Flour | 300 g |");

		expect(edited(before, columns, { row: 0, column: "time", value: "09:00" })).toBeNull();
	});

	it("refuses a row the table does not have", () => {
		const before = section(...table);

		expect(() =>
			editCalendarCell(before, columns, { row: 2, column: "time", value: "09:00" }),
		).toThrow(RangeError);
	});

	it("extends a blank, unterminated last cell instead of refusing it, keeping the closing pipe", () => {
		const before = section("| Time | Event |", "| --- | --- |", "| 09:00 | ");

		const after = edited(before, columns, { row: 0, column: "event", value: "Meeting" });

		expect(after).not.toBeNull();
		expect(after![5]).toBe("| 09:00 | Meeting |");
		expect(parsedTable(after!, columns)?.rows).toEqual([
			{ line: 5, time: "09:00", event: "Meeting", cellCount: 2 },
		]);
	});

	it("extends a row with no closing pipe at all, and adds none", () => {
		const before = section("| Time | Event |", "| --- | --- |", "| 09:00");

		const after = edited(before, columns, { row: 0, column: "event", value: "Meeting" });

		expect(after).not.toBeNull();
		expect(after![5]).toBe("| 09:00| Meeting ");
		expect(parsedTable(after!, columns)?.rows).toEqual([
			{ line: 5, time: "09:00", event: "Meeting", cellCount: 2 },
		]);
	});

	it("keeps a trailing carriage return at the very end of an extended line", () => {
		const before = section("| Time | Event |", "| --- | --- |", "| 09:00 | ").map((line, i) =>
			i === 5 ? `${line}\r` : line,
		);

		const after = edited(before, columns, { row: 0, column: "event", value: "Meeting" });

		expect(after).not.toBeNull();
		expect(after![5]).toBe("| 09:00 | Meeting |\r");
		expect(parsedTable(after!, columns)?.rows).toEqual([
			{ line: 5, time: "09:00", event: "Meeting", cellCount: 2 },
		]);
	});

	// The pair-test #530 asked for on this pair: one set of rows, both paths.
	// Every shape `parseCalendarTable` reports a row for is a shape
	// `editCalendarCell` can write into, and the cell not being written stays
	// exactly what it read as before the write.
	it("writes every cell parseCalendarTable reports for a row, however it ends, leaving the other cell untouched", () => {
		const rows = [
			"| 09:00 | ",
			"| 09:00",
			"| 09:00 | \r",
			"| 09:00 | Standup |",
			"| C:\\Notes\\",
			"| C:\\Notes\\\r",
		];

		for (const row of rows) {
			for (const column of ["time", "event"] as const) {
				const other = column === "time" ? "event" : "time";
				const before = section("| Time | Event |", "| --- | --- |", row);
				const read = parsedTable(before, columns);
				if (!read) throw new Error(`no table found for row ${JSON.stringify(row)}`);
				const originalOther = read.rows[0][other];

				const value = column === "time" ? "10:15" : "Meeting";
				const after = edited(before, columns, { row: 0, column, value });
				if (!after) throw new Error(`no write for row ${JSON.stringify(row)}`);

				const reread = parsedTable(after, columns);
				expect(reread?.rows[0][column]).toBe(value);
				expect(reread?.rows[0][other]).toBe(originalOther);
			}
		}
	});

	it("refuses a value carrying a line break", () => {
		const before = section(...table);

		expect(() =>
			editCalendarCell(before, columns, { row: 0, column: "event", value: "a\nb" }),
		).toThrow();
	});
});

// The writer answers with the reason it wrote nothing, the way the reader
// already did. The five are the reader's five and are not a second list, so a
// caller that could not write has a sentence for the person rather than a
// silence.
describe("what editCalendarCell says when it writes nothing", () => {
	/** One input per reason, each named by the reason the reader gives for it. */
	const refusals: { readonly absence: CalendarTableAbsence; readonly lines: string[]; readonly columns: ColumnNames }[] = [
		{ absence: "no-schema-block", lines: ["## Calendar", "", ...table, ""], columns },
		{ absence: "no-table-in-block", lines: section("| Ingredient |", "| --- |"), columns },
		{ absence: "column-name-blank", lines: section(...table), columns: { time: "", event: "Event" } },
		{ absence: "column-names-alike", lines: section(...table), columns: { time: "Time", event: "time" } },
		{
			absence: "column-named-twice",
			lines: section("| Time | Event | Time |", "| --- | --- | --- |", "| 09:00 | x | 10:00 |"),
			columns,
		},
	];

	for (const refusal of refusals) {
		it(`says ${refusal.absence} rather than nothing`, () => {
			expect(
				editCalendarCell(refusal.lines, refusal.columns, {
					row: 0,
					column: "time",
					value: "09:00",
				}),
			).toEqual({ found: false, absence: refusal.absence });
		});
	}

	// The one list, asserted rather than assumed: both functions run the same
	// lookup and hand its refusal straight back, so a sixth reason added to the
	// reader arrives in the writer with no second edit.
	it("names every absence exactly as the reader names it", () => {
		for (const refusal of refusals) {
			const read = parseCalendarTable(refusal.lines, refusal.columns);
			const written = editCalendarCell(refusal.lines, refusal.columns, {
				row: 0,
				column: "time",
				value: "09:00",
			});

			expect(read.found).toBe(false);
			expect(written.found).toBe(false);
			if (read.found || written.found) throw new Error("a table was found");
			expect(written.absence).toBe(read.absence);
		}
	});

	it("hands the new lines back under found, so a caller reads one shape", () => {
		const outcome = editCalendarCell(section(...table), columns, {
			row: 1,
			column: "time",
			value: "14:00",
		});

		expect(outcome.found).toBe(true);
		if (!outcome.found) throw new Error("the table was not found");
		expect(outcome.lines[6]).toBe("| 14:00 | Design review |");
	});
});

// The header is found by its column names, which is what stops the plugin
// touching an unrelated table. Where the body *stops* needs its own guard: a
// sentence in the person's own prose can hold a pipe, and reading it as a
// meeting both corrupts that sentence and misses the meeting it meant.
describe("where the rows stop", () => {
	const withProse = section(
		"| Time | Event |",
		"| --- | --- |",
		"| 09:00 | Standup |",
		"note: a | b",
		"| 10:00 | Review |",
	);

	it("stops at a line of prose that merely holds a pipe", () => {
		expect(parsedTable(withProse, columns)?.rows).toEqual([
			{ line: 5, time: "09:00", event: "Standup", cellCount: 2 },
		]);
	});

	it("never addresses a prose line as a meeting", () => {
		expect(() =>
			editCalendarCell(withProse, columns, { row: 1, column: "event", value: "X" }),
		).toThrow(RangeError);
	});

	it("stops at a line holding more cells than the header", () => {
		const lines = section(
			"| Time | Event |",
			"| --- | --- |",
			"| 09:00 | Standup |",
			"| a | b | c |",
		);

		expect(parsedTable(lines, columns)?.rows).toHaveLength(1);
	});

	it("still reads a row whose trailing cell is missing", () => {
		const lines = section("| Time | Event |", "| --- | --- |", "| 09:00 |");

		expect(parsedTable(lines, columns)?.rows).toHaveLength(1);
	});

	it("allows a row the three spaces of indentation Markdown allows", () => {
		const lines = section("| Time | Event |", "| --- | --- |", "   | 09:00 | Standup |");

		expect(parsedTable(lines, columns)?.rows).toEqual([
			{ line: 5, time: "09:00", event: "Standup", cellCount: 2 },
		]);
	});

	// The cost of the guard, stated so that a later reader meets it here rather
	// than in a bug report: a table written in the pipe-less style Markdown also
	// allows is not this plugin's table, and is left entirely alone.
	it("does not find a table whose rows are written without their outer pipes", () => {
		const lines = section("Time | Event", "--- | ---", "09:00 | Standup");

		expect(parsedTable(lines, columns)).toBeNull();
	});
});

// A cell value is not always the plugin's own text: an event read out of an
// .ics source is whatever a person or another system wrote. A backslash is
// ordinary in such text, and it is also the character the table format escapes
// with, so writing and reading it have to be exact inverses of each other.
describe("a cell value carrying a backslash", () => {
	const values = [
		"\\",
		"a\\",
		"\\a",
		"|",
		"a|b",
		"\\|",
		"a\\|b",
		"\\\\",
		"a\\\\b",
		"\\\\|\\\\",
		"C:\\Users\\ada",
		"\\\\|",
	];

	// The same table under both spellings of a cell: padded, which keeps the
	// padding, and bare, which is what the plugin writes when a cell is empty.
	const bodies = ["| 09:00 | x | keepme |", "|09:00|x|keepme|"];

	/** The same table read with the third column standing in as the event. */
	const asNote: ColumnNames = { time: "Time", event: "Note" };

	it("comes back out of the table exactly as it went in", () => {
		for (const value of values) {
			for (const body of bodies) {
				const before = section("| Time | Event | Note |", "| - | - | - |", body);
				const after = edited(before, columns, { row: 0, column: "event", value });
				if (!after) throw new Error("the table was not found");

				expect(parsedTable(after, columns)?.rows).toEqual([
					{ line: 5, time: "09:00", event: value, cellCount: 3 },
				]);
			}
		}
	});

	it("leaves the neighbouring column and every other line identical", () => {
		for (const value of values) {
			for (const body of bodies) {
				const before = section("| Time | Event | Note |", "| - | - | - |", body);
				const after = edited(before, columns, { row: 0, column: "event", value });
				if (!after) throw new Error("the table was not found");

				// One row still, and the columns on either side of the edit untouched.
				expect(parsedTable(after, asNote)?.rows).toEqual([
					{ line: 5, time: "09:00", event: "keepme", cellCount: 3 },
				]);
				expect(after.filter((_, i) => i !== 5)).toEqual(before.filter((_, i) => i !== 5));
			}
		}
	});

	it("survives being written twice, so an edit of an edit is still exact", () => {
		for (const value of values) {
			const before = section("| Time | Event | Note |", "| - | - | - |", "| 09:00 | x | keepme |");
			const once = edited(before, columns, { row: 0, column: "event", value });
			if (!once) throw new Error("the table was not found");
			const twice = edited(once, columns, { row: 0, column: "event", value });

			expect(twice).toEqual(once);
		}
	});
});

/**
 * What a `schema` block is, and where it ends ([#412]).
 *
 * The fence rule underneath these answers moved to `markdownSections.ts`; the
 * questions above it — which blocks the person meant as schema blocks, and how
 * far the outermost ones run — stayed here. These cases pin the answers across
 * that move. They drive `parseCalendarTable`, because finding the table at all
 * is the only way to ask from outside whether a block was read as a schema
 * block.
 */
describe("which fenced blocks the calendar reader takes as schema blocks", () => {
	it("takes `schema`, `Schema` and `schema json`, and not `schemas`", () => {
		expect(parsedTable(["```schema", ...table, "```"], columns)).not.toBeNull();
		expect(parsedTable(["```Schema", ...table, "```"], columns)).not.toBeNull();
		expect(parsedTable(["```schema json", ...table, "```"], columns)).not.toBeNull();
		expect(parsedTable(["```schemas", ...table, "```"], columns)).toBeNull();
	});

	it("does not let a backtick fence open on an info string holding a backtick", () => {
		// The clause that keeps an inline code span written on a line of its own
		// from opening a block. Nothing opens here, so there is no schema block
		// and no table.
		expect(parsedTable(["``` `schema", ...table, "```"], columns)).toBeNull();
	});

	it("opens a tilde fence on an info string holding a backtick", () => {
		// The same clause is a backtick fence's alone, so this one is a schema
		// block despite the backtick — the info string's first word is still
		// `schema`.
		expect(parsedTable(["~~~schema `js", ...table, "~~~"], columns)).not.toBeNull();
	});

	it("does not let a backtick run close a tilde block", () => {
		// The table sits after what looks like a closing line, so it is only
		// found if the tilde block is still open across it. It is.
		expect(
			parsedTable(["~~~schema", "```", ...table, "~~~"], columns)?.headerLine,
		).toBe(2);
	});

	it("does not let a closing run shorter than the opening one close the block", () => {
		expect(
			parsedTable(["````schema", "```", ...table, "````"], columns)?.headerLine,
		).toBe(2);
	});

	it("lets a closing run longer than the opening one close the block", () => {
		// The block ends at the longer run, so the table below it is outside and
		// is not found.
		expect(parsedTable(["```schema", "`````", ...table], columns)).toBeNull();
	});

	it("runs an unclosed schema fence to the end of what it was given", () => {
		// No closing line anywhere, so the block's body is every line below the
		// fence and the table inside it is still found.
		expect(parsedTable(["```schema", ...table], columns)?.headerLine).toBe(1);
	});
});

describe("a note written with Windows line endings", () => {
	/**
	 * The note as a caller meets it: written with `\r\n` line endings and split on
	 * `"\n"` alone, so every line still carries its carriage return.
	 */
	function windowsLines(lines: readonly string[]): string[] {
		return `${lines.join("\r\n")}\r\n`.split("\n");
	}

	it("finds the schema block and reads its table exactly as it reads the same note without the carriage returns", () => {
		// The defect #503: the
		// opening-fence rule refused a line ending in a carriage return, so no
		// schema block opened anywhere in such a note, no table was found, and
		// nothing said so. Asserted against the plain note's own reading rather
		// than against a written-out table, because the point is that the two
		// notes read alike.
		const plain = section(...table);

		expect(parsedTable(windowsLines(plain), columns)).toEqual(parsedTable(plain, columns));
		expect(parsedTable(windowsLines(plain), columns)?.rows).toEqual([
			{ line: 5, time: "09:00", event: "Standup", cellCount: 2 },
			{ line: 6, time: "13:30", event: "Design review", cellCount: 2 },
		]);
	});

	it("closes the block on its closing line rather than running to the end of the note", () => {
		// The closing rule has always stripped the carriage return, but nothing
		// could reach it while the opening rule refused the block. The table below
		// the block is outside it, so a walk that ran past the closing line would
		// find that one instead of the block's own.
		const lines = windowsLines([...section(...table), "| Time | Event |", "| --- | --- |"]);

		expect(parsedTable(lines, columns)?.headerLine).toBe(3);
	});
});

// The lookbehind ban is not here. It is one of `afterTheFloor`'s patterns in
// `platform.test.ts`, run over every shipped module by that file's whole-tree
// walk, so a module added tomorrow is covered the day it arrives. It used to be
// asserted here against this one file, which left every other shipped module
// free. No count of those modules is stated, here or in the note
// beside the pattern list: a count of a past tree goes stale and this one did.
describe("the calendar-table piece as shipped code", () => {
	// Read from this file's own folder, one sideways into `src/core/`, so the
	// working directory the suite was started from does not matter.
	const source = readFileSync(resolve(__dirname, "..", "core", "calendarTable.ts"), "utf8");

	it("imports the core's fence rule and nothing else, so it can touch no vault, app or settings storage", () => {
		// This guard said "imports nothing" until
		// #412, which is a
		// stronger sentence than the seam it was written for. The seam is that no
		// vault, app or settings storage can be reached from here; "nothing at
		// all" was the cheapest way to say that while the module needed nothing.
		// #412 gave it one thing to need — CommonMark's fence rule, which it wrote
		// out a second time — so the guard names what may be imported instead of
		// forbidding the lot. `markdownSections.ts` is core code over strings and
		// imports nothing itself, which its own suite pins, so the reach of this
		// module is unchanged. A list of one is still a list: a second entry has
		// to be argued for here.
		const imports = source.match(/^[ \t]*import\s.*$/gm) ?? [];
		expect(imports).toEqual(['import { closesFence, openingFence } from "./markdownSections";']);
	});

	it("has parseCalendarTable's per-block search delegate to the shared lookup parseCalendarTableFromBody also calls", () => {
		// Ticket #623: the body reader and the note reader must run one lookup,
		// not a copy each, so they cannot disagree about which row is row 3. This
		// reads the source rather than only the two readers' answers, because two
		// hand-written copies that happen to agree on every fixture here would
		// still pass every other test in this file.
		const sharedCallers = source.match(/tableInRange\(/g) ?? [];
		expect(sharedCallers.length).toBeGreaterThanOrEqual(2);
	});
});

// #623: Obsidian hands a code-block renderer the lines between the fences, not
// the note, so `parseCalendarTable` — which looks for a fenced `schema` block —
// answers `no-schema-block` for a body. `parseCalendarTableFromBody` runs the
// same per-block lookup directly over the lines it is given.
describe("parseCalendarTableFromBody", () => {
	it("reads the same header line, column index and rows as parseCalendarTable does through the note", () => {
		// A header not on the first line (the blank line above it), a third
		// column, and a row wider than the header below the two real rows —
		// every shape the note reader has to step past on its way into the
		// block.
		const body = [
			"",
			"| Time | Event | Effort |",
			"| --- | --- | --- |",
			"| 09:00 | Standup | 15 |",
			"| 13:30 | Design review | 30 |",
			"| a | b | c | d |",
		];
		const note = section(...body);

		const throughNote = parsedTable(note, columns);
		const throughBody = parsedBodyTable(body, columns);

		expect(throughBody).not.toBeNull();
		expect(throughBody?.headerLine).toBe(throughNote!.headerLine - 3);
		expect(throughBody?.rows).toEqual([
			{ line: 3, time: "09:00", event: "Standup", cellCount: 3 },
			{ line: 4, time: "13:30", event: "Design review", cellCount: 3 },
		]);
		expect(throughNote?.rows).toEqual([
			{ line: 6, time: "09:00", event: "Standup", cellCount: 3 },
			{ line: 7, time: "13:30", event: "Design review", cellCount: 3 },
		]);
	});

	it("answers no-table-in-block for a separator row with fewer cells than the header, the same as parseCalendarTable does", () => {
		const body = ["| Time | Event |", "| --- |"];

		expect(parseCalendarTableFromBody(body, columns)).toEqual({
			found: false,
			absence: "no-table-in-block",
		});
		expect(parseCalendarTable(section(...body), columns)).toEqual({
			found: false,
			absence: "no-table-in-block",
		});
	});

	it("judges the configured column names before it looks at the body, the same as parseCalendarTable does", () => {
		expect(parseCalendarTableFromBody(table, { time: "", event: "Event" })).toEqual({
			found: false,
			absence: "column-name-blank",
		});
		expect(parseCalendarTableFromBody(table, { time: "Time", event: "time" })).toEqual({
			found: false,
			absence: "column-names-alike",
		});
	});
});

// #623: a pipe inside a wikilink is text, not a cell boundary. Carried from the
// two old readers (`schema-render/src/parser.ts:27-39`,
// `calendar-scaffold/src/schema-table.ts:119-121`), which both masked it before
// splitting a row.
describe("a pipe inside a wikilink", () => {
	const withLink = section(
		"| Time | Event |",
		"| --- | --- |",
		"| 09:00–10:00 | [[Note|Alias]] |",
		"| 11:00 | Standup |",
	);
	const withEscapedLink = section(
		"| Time | Event |",
		"| --- | --- |",
		"| 09:00–10:00 | [[Note\\|Alias]] |",
	);

	it("reads as two cells, not three, in the note reader", () => {
		expect(parsedTable(withLink, columns)?.rows).toEqual([
			{ line: 5, time: "09:00–10:00", event: "[[Note|Alias]]", cellCount: 2 },
			{ line: 6, time: "11:00", event: "Standup", cellCount: 2 },
		]);
	});

	it("reads as two cells, not three, in the body reader", () => {
		const body = ["| Time | Event |", "| --- | --- |", "| 09:00–10:00 | [[Note|Alias]] |"];

		expect(parsedBodyTable(body, columns)?.rows).toEqual([
			{ line: 2, time: "09:00–10:00", event: "[[Note|Alias]]", cellCount: 2 },
		]);
	});

	it("also reads as two cells when the pipe inside the link is escaped", () => {
		expect(parsedTable(withEscapedLink, columns)?.rows).toEqual([
			{ line: 5, time: "09:00–10:00", event: "[[Note|Alias]]", cellCount: 2 },
		]);
	});

	it("does not end the table: a row below a piped link is still read", () => {
		expect(parsedTable(withLink, columns)?.rows).toHaveLength(2);
	});

	it("leaves the link byte-identical when editCalendarCell rewrites the other cell", () => {
		const after = edited(withLink, columns, { row: 0, column: "time", value: "07:00" });

		expect(after).not.toBeNull();
		const line = theOneChangedLine(withLink, after!);
		expect(line).toBe(5);
		expect(after![line]).toBe("| 07:00 | [[Note|Alias]] |");
	});
});

// Ticket #693: a second writer for a caller that has the whole list of rows a
// table should hold, rather than one cell to change. It shares editCalendarCell's
// writeCell and its five CalendarTableAbsence reasons, and decides nothing about
// which rows belong on the page — that stays the feature's own policy.
describe("writeCalendarRows", () => {
	/** The new lines when the write landed, or `null` when no table matched. */
	function written(
		lines: readonly string[],
		cols: ColumnNames,
		rows: readonly CalendarRowWrite[],
	): string[] | null {
		const outcome = writeCalendarRows(lines, cols, rows);
		return outcome.found ? outcome.lines : null;
	}

	it("writes a row in place, keeping its padding, its closing-pipe habit and a third column's cell", () => {
		const before = section(
			"| Time | Event | Effort |",
			"| --- | --- | --- |",
			"|   09:00   |   Standup   | 15 |\r",
		);

		const after = written(before, columns, [{ from: 0, time: "10:00", event: "Retro" }]);

		expect(after).not.toBeNull();
		expect(after![5]).toBe("|   10:00   |   Retro   | 15 |\r");
	});

	// #705: this fixture's row has a closing pipe and every cell, so the
	// in-place branch never has to decide the line's end — the carriage
	// return at the fixture's own tail comes back unchanged whether or not
	// that branch is right. The fixture that can fail on the carriage return
	// specifically is #702's own case, above.

	// #702: a row ending in `\r` with no closing pipe, written in place while
	// also being extended for a cell it does not yet hold. Would show wrong if
	// the in-place rewrite of the row's one existing cell trusted a span that
	// reached into the carriage return the extension had already spliced
	// past — reread as one merged cell instead of two.
	it("keeps a carriage-return row's two cells apart when it is extended and rewritten in the same write", () => {
		const lines = ["```schema\r", "| Time | Event |\r", "| --- | --- |\r", "| 09:00\r", "```\r"];

		const after = written(lines, columns, [{ from: 0, time: "10:00", event: "Standup" }]);

		expect(after).not.toBeNull();
		expect(after![3]).toBe("| 10:00| Standup \r");
		expect(parsedTable(after!, columns)?.rows).toEqual([
			{ line: 3, time: "10:00", event: "Standup", cellCount: 2 },
		]);
	});

	// #705: asserting only that the two writers agree passes even if neither
	// escapes anything — both would then produce the same unescaped bytes.
	// The line itself is asserted below so an unescaped pipe would be caught.
	it("escapes a pipe and a backslash in a written value exactly as editCalendarCell does for the same value", () => {
		const before = section("| Time | Event |", "| --- | --- |", "| 09:00 | x |", "| 13:30 | y |");
		const value = "C:\\Notes\\Ada | Bob";

		const viaCell = edited(before, columns, { row: 0, column: "event", value });
		const viaRows = written(before, columns, [
			{ from: 0, time: "09:00", event: value },
			{ from: 1, time: "13:30", event: "y" },
		]);

		expect(viaRows).toEqual(viaCell);
		expect(viaRows![5]).toBe("| 09:00 | C:\\\\Notes\\\\Ada \\| Bob |");
	});

	// #706: a note written with `\r\n` line endings, so every line carries its
	// own `\r`. Would show wrong if the inserted row came back bare — the one
	// line in the table without a carriage return.
	it("carries the row before it's own carriage return onto an inserted row, in a note written with Windows line endings", () => {
		function crlf(inputLines: readonly string[]): string[] {
			return `${inputLines.join("\r\n")}\r\n`.split("\n");
		}

		const before = crlf(section(...table));

		const after = written(before, columns, [
			{ from: 0, time: "09:00", event: "Standup" },
			{ from: null, time: "11:00", event: "Lunch" },
			{ from: 1, time: "13:30", event: "Design review" },
		]);

		expect(after).not.toBeNull();
		const expected = [...before];
		expected.splice(6, 0, "| 11:00 | Lunch |\r");
		expect(after).toEqual(expected);
	});

	// #705: asserting only `after!.slice(5, 8)` never looks at whether the
	// fence still closes or the lines before the header were left alone. The
	// whole array is compared instead, against the fixture with just the one
	// line spliced in, so either would show wrong.
	it("inserts a from: null row in the middle of the list, leaving the rows around it and the rest of the note as written", () => {
		const before = section(...table);

		const after = written(before, columns, [
			{ from: 0, time: "09:00", event: "Standup" },
			{ from: null, time: "11:00", event: "Lunch" },
			{ from: 1, time: "13:30", event: "Design review" },
		]);

		const expected = [...before];
		expected.splice(6, 0, "| 11:00 | Lunch |");
		expect(after).toEqual(expected);
	});

	it("inserts a from: null row at the end of the list, leaving the rows before it and the rest of the note as written", () => {
		const before = section(...table);

		const after = written(before, columns, [
			{ from: 0, time: "09:00", event: "Standup" },
			{ from: 1, time: "13:30", event: "Design review" },
			{ from: null, time: "15:00", event: "Wrap-up" },
		]);

		const expected = [...before];
		expected.splice(7, 0, "| 15:00 | Wrap-up |");
		expect(after).toEqual(expected);
	});

	it("inserts a from: null row into a table that starts with none", () => {
		const before = section("| Time | Event |", "| --- | --- |");

		const after = written(before, columns, [{ from: null, time: "09:00", event: "Standup" }]);

		expect(after).not.toBeNull();
		expect(after![5]).toBe("| 09:00 | Standup |");
	});

	it("throws a RangeError when a from names no such row", () => {
		const before = section(...table);

		expect(() =>
			writeCalendarRows(before, columns, [
				{ from: 0, time: "09:00", event: "Standup" },
				{ from: 5, time: "13:30", event: "Design review" },
			]),
		).toThrow(RangeError);
	});

	it("throws a RangeError when a from is used twice", () => {
		const before = section(...table);

		expect(() =>
			writeCalendarRows(before, columns, [
				{ from: 0, time: "09:00", event: "Standup" },
				{ from: 0, time: "13:30", event: "Design review" },
			]),
		).toThrow(RangeError);
	});

	it("throws a RangeError when two froms are out of ascending order", () => {
		const before = section(...table);

		expect(() =>
			writeCalendarRows(before, columns, [
				{ from: 1, time: "13:30", event: "Design review" },
				{ from: 0, time: "09:00", event: "Standup" },
			]),
		).toThrow(RangeError);
	});

	it("throws a RangeError when an existing row is dropped from the write, since this writer never deletes one", () => {
		const before = section(...table);

		expect(() =>
			writeCalendarRows(before, columns, [{ from: 0, time: "09:00", event: "Standup" }]),
		).toThrow(RangeError);
	});

	it("extends a row that physically holds fewer cells than the columns need, the way editCalendarCell extends one", () => {
		const before = section("| Time | Event |", "| --- | --- |", "| 09:00 |");

		const after = written(before, columns, [{ from: 0, time: "09:00", event: "Standup" }]);

		expect(after).not.toBeNull();
		expect(after![5]).toBe("| 09:00 | Standup |");
	});

	it("returns lines equal to the ones handed in when the values already match, letting the caller skip the write", () => {
		const before = section(...table);

		const after = written(before, columns, [
			{ from: 0, time: "09:00", event: "Standup" },
			{ from: 1, time: "13:30", event: "Design review" },
		]);

		expect(after).toEqual(before);
	});

	it("leaves the header and separator and removes nothing when the table already has no rows", () => {
		const before = section("| Time | Event |", "| --- | --- |");

		expect(written(before, columns, [])).toEqual(before);
	});

	it("throws a RangeError for an empty list against a table that already has rows, since that would delete them", () => {
		const before = section(...table);

		expect(() => writeCalendarRows(before, columns, [])).toThrow(RangeError);
	});

	it("does not change the lines it was given", () => {
		const before = section(...table);
		const copy = [...before];

		writeCalendarRows(before, columns, [
			{ from: 0, time: "07:00", event: "Standup" },
			{ from: 1, time: "13:30", event: "Design review" },
		]);

		expect(before).toEqual(copy);
	});

	it("refuses a value holding a line break, the way editCalendarCell refuses one", () => {
		const before = section(...table);

		expect(() =>
			writeCalendarRows(before, columns, [{ from: 0, time: "09:00", event: "a\nb" }]),
		).toThrow();
	});
});

// The writer answers with the reason it wrote nothing, the same five reasons
// editCalendarCell already answers with, from the same lookup.
describe("what writeCalendarRows says when it writes nothing", () => {
	const refusals: { readonly absence: CalendarTableAbsence; readonly lines: string[]; readonly columns: ColumnNames }[] = [
		{ absence: "no-schema-block", lines: ["## Calendar", "", ...table, ""], columns },
		{ absence: "no-table-in-block", lines: section("| Ingredient |", "| --- |"), columns },
		{ absence: "column-name-blank", lines: section(...table), columns: { time: "", event: "Event" } },
		{ absence: "column-names-alike", lines: section(...table), columns: { time: "Time", event: "time" } },
		{
			absence: "column-named-twice",
			lines: section("| Time | Event | Time |", "| --- | --- | --- |", "| 09:00 | x | 10:00 |"),
			columns,
		},
	];

	for (const refusal of refusals) {
		it(`says ${refusal.absence} rather than nothing`, () => {
			expect(writeCalendarRows(refusal.lines, refusal.columns, [])).toEqual({
				found: false,
				absence: refusal.absence,
			});
		});
	}
});
