/**
 * Reads one day from a `schema` block's body: the bars, the timed meetings,
 * the rows that could not be read, and the lines the table never reached —
 * or a fallback carrying the reason there was no table at all.
 *
 * Pure code over strings, like the core pieces it calls. It reads the table
 * through {@link parseCalendarTableFromBody} and each row's time cell through
 * {@link readTimeCell}, and declares no time or table parsing of its own: the
 * only string test this file makes on its own account is whether a line
 * *opens* with a pipe, for the rows the core's reader never reached, which is
 * this ticket's own rule (named difference 5) rather than a re-reading of the
 * table.
 */

import { parseCalendarTableFromBody, type CalendarTable, type CalendarTableAbsence, type ColumnNames } from "../../core/calendarTable";
import { readTimeCell } from "../../core/timeCell";
import { readMeetingCell, type MeetingCell } from "./meetingCell";
import type { AllDayMeeting, Day, RowError, TimedMeeting, UnreadRow } from "./types";

/**
 * Reads a day out of `bodyLines` — one `schema` block's body, as Obsidian
 * hands it to a renderer — using `columns` as the configured column names.
 */
export function readDay(bodyLines: readonly string[], columns: ColumnNames): Day {
	const outcome = parseCalendarTableFromBody(bodyLines, columns);
	if (!outcome.found) {
		return { fallback: fallbackReason(outcome.absence) };
	}

	const table = outcome.table;
	const bars: AllDayMeeting[] = [];
	const timed: TimedMeeting[] = [];
	const rowErrors: RowError[] = [];

	table.rows.forEach((row, rowIndex) => {
		// The daily-log template's placeholder row: both cells blank, nothing to say.
		if (row.time === "" && row.event === "") return;

		// A row with fewer cells than the header is a row error, as the old
		// parser made it — never a meeting with a blank cell
		// nobody wrote. Checked before the time cell is read, since a short
		// row's one cell can still look like a valid time on its own.
		if (row.cellCount < table.columnCount) {
			rowErrors.push({ reason: cellsReason(row.cellCount, table.columnCount), rawLine: bodyLines[row.line] });
			return;
		}

		const time = readTimeCell(row.time);
		if (!time.ok) {
			rowErrors.push({ reason: timeReason(time.reason, row.time), rawLine: bodyLines[row.line] });
			return;
		}

		const meeting = readMeetingCell(row.event);
		if (time.allDay) {
			bars.push({ text: drawnText(meeting), rowIndex });
		} else {
			timed.push({ startMin: time.startMin, endMin: time.endMin, text: drawnText(meeting), rowIndex });
		}
	});

	// There were rows with content, and not one of them could be read — an
	// empty grid full of red text is worse than the table.
	// A block whose rows were all the placeholder never reaches here:
	// `rowErrors` stays empty for it, same as `bars` and `timed`.
	if (bars.length === 0 && timed.length === 0 && rowErrors.length > 0) {
		return { fallback: wholeTableReason(rowErrors) };
	}

	return { bars, timed, rowErrors, unread: unreadRows(bodyLines, table) };
}

/**
 * The text a bar or timed block draws for a meeting cell: the cell's own
 * trailing parenthesis, joined after `display` exactly as the old renderer
 * joined them (`~/Devbox/schema-render/src/renderer.ts:61-62`, `formatCell`),
 * so `Möte (Skype)` draws as `Möte (Skype)` rather than losing the
 * parenthesis. `isWikilink`, `linktext` and `looksLikeLink` stay out
 * of the day's reading — #628's click handling rereads the raw block lines
 * for those, independent of what `readDay` carries.
 */
function drawnText(cell: MeetingCell): string {
	return cell.trailingParen ? `${cell.display} (${cell.trailingParen})` : cell.display;
}

/** The sentence a row error carries, in the same voice for both refusals. */
function timeReason(reason: "not-a-time" | "backwards", cell: string): string {
	if (reason === "backwards") {
		return `Invalid time "${cell}" — the end time is before the start time.`;
	}
	return `Invalid time "${cell}" — expected a range such as 09:00–10:30, or "heldag".`;
}

/** The sentence a row error carries when the row itself has fewer cells than the header names. */
function cellsReason(cellCount: number, columnCount: number): string {
	return `Too few cells: ${cellCount}, expected ${columnCount}.`;
}

/** The one sentence the fallback carries when every row with content failed. */
function wholeTableReason(rowErrors: readonly RowError[]): string {
	const first = rowErrors[0].reason;
	return rowErrors.length === 1
		? first
		: `Not one of the ${rowErrors.length} rows with content could be read. ${first}`;
}

/**
 * The sentence for a block whose body carried no table at all.
 *
 * In the live plugin, readiness stops the feature before `readDay` ever runs
 * when a column name is blank or the two names are alike, so
 * `column-name-blank` and `column-names-alike` do not reach here that way.
 * But `readDay` takes `columns` as a plain argument and calls
 * `parseCalendarTableFromBody` directly, with no readiness gate of its own —
 * this suite calls it exactly that way, and so could a future caller — so
 * both branches are answered below rather than left to throw.
 */
function fallbackReason(absence: CalendarTableAbsence): string {
	switch (absence) {
		case "column-named-twice":
			return "A table names one of the configured columns twice.";
		case "no-schema-block":
		case "no-table-in-block":
			return "No table names both columns.";
		case "column-name-blank":
			return "One of the configured column names is blank.";
		case "column-names-alike":
			return "The configured column names cannot tell two columns apart.";
	}
}

/**
 * The lines below the table's end that open with a pipe but were never read
 * as a row (named difference 5): the core's table ends at a blank line, at a
 * plain line with no leading pipe, or at a row wider than its header, and
 * every such line inside the block is listed here rather than lost.
 *
 * Which of those stopped the table is read off the one line that follows the
 * table's last read row: if it opens with a pipe, the core's own loop can
 * only have stopped there because it was wider than the header — a pipe row
 * that was not wide would have been absorbed into the table instead, and
 * would not be this line. So `"wide-row"` needs no cell count of its own;
 * every other stop — blank, or a plain line with no leading pipe — is
 * `"blank-line"`, matching the core's own grouping (`!cells` covers both at
 * `src/core/calendarTable.ts:394`; decision settled on issue #636).
 */
function unreadRows(bodyLines: readonly string[], table: CalendarTable): UnreadRow[] {
	const lastTableLine = table.rows.length > 0 ? table.rows[table.rows.length - 1].line : table.headerLine + 1;
	const stopLine = lastTableLine + 1;
	if (stopLine >= bodyLines.length) return [];

	const stoppedBy: UnreadRow["stoppedBy"] = opensWithPipe(bodyLines[stopLine]) ? "wide-row" : "blank-line";

	const unread: UnreadRow[] = [];
	for (let i = stopLine; i < bodyLines.length; i++) {
		if (opensWithPipe(bodyLines[i])) unread.push({ line: bodyLines[i], stoppedBy });
	}
	return unread;
}

/** Whether `line` opens with the pipe that makes a line a table row — up to three spaces, then `|`. */
function opensWithPipe(line: string): boolean {
	return /^ {0,3}\|/.test(line);
}
