/**
 * `writeCalendarRows` removing a row it is told to remove: a meeting
 * gone from the calendar loses the row the plugin wrote for it, and every
 * other byte of the note stays as it was.
 *
 * The removal is named explicitly, beside the rows to write. A row the list
 * neither writes nor removes is still a caller's mistake, and still throws:
 * that is what keeps a stale reading of the note from deleting a row by
 * leaving it out.
 */

import { describe, expect, it } from "vitest";
import { writeCalendarRows } from "../core/calendarTable";
import type { ColumnNames } from "../core/calendarTable";

const columns: ColumnNames = { time: "Time", event: "Event" };

/** The note as one text, the way the vault holds it, split the way the run splits it. */
function linesOf(text: string): string[] {
	return text.split("\n");
}

function written(text: string, rows: Parameters<typeof writeCalendarRows>[2], remove: readonly number[]): string {
	const outcome = writeCalendarRows(linesOf(text), columns, rows, remove);
	if (!outcome.found) throw new Error(`no table: ${outcome.absence}`);
	return outcome.lines.join("\n");
}

describe("writeCalendarRows removing a row", () => {
	it("removes the named row's line and leaves every other line byte-identical", () => {
		const before = [
			"## Calendar",
			"",
			"```schema",
			"| Time  | Event          | Effort |",
			"| ----- | -------------- | ------ |",
			"|   09:00   |   Standup   | 15 |",
			"| 10:00 | [[2026-10-02 Team arkitektur]] | |",
			"| 13:30 | Design review",
			"```",
			"",
			"## Notes",
			"",
		].join("\n");

		const after = written(
			before,
			[
				{ from: 0, time: "09:00", event: "Standup" },
				{ from: 2, time: "13:30", event: "Design review" },
			],
			[1],
		);

		expect(after).toBe(
			[
				"## Calendar",
				"",
				"```schema",
				"| Time  | Event          | Effort |",
				"| ----- | -------------- | ------ |",
				"|   09:00   |   Standup   | 15 |",
				"| 13:30 | Design review",
				"```",
				"",
				"## Notes",
				"",
			].join("\n"),
		);
	});

	it("removes a row from a note with Windows line endings that ends in a line break, leaving no stray carriage return", () => {
		const before =
			"```schema\r\n| Time | Event |\r\n| --- | --- |\r\n| 09:00 | Standup |\r\n| 10:00 | Gone |\r\n```\r\n";

		const after = written(before, [{ from: 0, time: "09:00", event: "Standup" }], [1]);

		expect(after).toBe("```schema\r\n| Time | Event |\r\n| --- | --- |\r\n| 09:00 | Standup |\r\n```\r\n");
	});

	it("removes a row from a note with Windows line endings and no final line break, leaving no stray carriage return", () => {
		const before = "```schema\r\n| Time | Event |\r\n| --- | --- |\r\n| 09:00 | Gone |\r\n| 10:00 | Kept |\r\n```";

		const after = written(before, [{ from: 1, time: "10:00", event: "Kept" }], [0]);

		expect(after).toBe("```schema\r\n| Time | Event |\r\n| --- | --- |\r\n| 10:00 | Kept |\r\n```");
	});

	it("removes every row, leaving the header and the separator", () => {
		const before = "```schema\n| Time | Event |\n| --- | --- |\n| 09:00 | Gone |\n| 10:00 | Also gone |\n```\n";

		const after = written(before, [], [0, 1]);

		expect(after).toBe("```schema\n| Time | Event |\n| --- | --- |\n```\n");
	});

	it("inserts a new row beside a removed one", () => {
		const before = "```schema\n| Time | Event |\n| --- | --- |\n| 09:00 | Gone |\n```\n";

		const after = written(before, [{ from: null, time: "11:00", event: "New" }], [0]);

		expect(after).toBe("```schema\n| Time | Event |\n| --- | --- |\n| 11:00 | New |\n```\n");
	});

	it("still throws a RangeError for a row neither written nor removed", () => {
		const before = linesOf("```schema\n| Time | Event |\n| --- | --- |\n| 09:00 | A |\n| 10:00 | B |\n```\n");

		expect(() => writeCalendarRows(before, columns, [{ from: 0, time: "09:00", event: "A" }], [])).toThrow(RangeError);
	});

	it("throws a RangeError for a row both written and removed", () => {
		const before = linesOf("```schema\n| Time | Event |\n| --- | --- |\n| 09:00 | A |\n```\n");

		expect(() => writeCalendarRows(before, columns, [{ from: 0, time: "09:00", event: "A" }], [0])).toThrow(RangeError);
	});

	it("throws a RangeError for a removal naming no such row", () => {
		const before = linesOf("```schema\n| Time | Event |\n| --- | --- |\n| 09:00 | A |\n```\n");

		expect(() => writeCalendarRows(before, columns, [{ from: 0, time: "09:00", event: "A" }], [3])).toThrow(RangeError);
	});
});
