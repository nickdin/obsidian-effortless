/**
 * The core's reader and writer for the day's calendar table.
 *
 * The table is a two-column Markdown table — a time and an event — inside a
 * fenced `schema` block under the day's-log calendar heading. It is found by
 * its column names, case-insensitively, and never by counting its columns:
 * counting would let the plugin mangle any unrelated two-column table that
 * happened to sit in the same place. The names are the person's to configure,
 * so they arrive as arguments rather than being read from anywhere.
 *
 * Where the rows stop is guarded in the same spirit. Every line of the table,
 * the header included, has to open with the pipe — see `tableRow` — because a
 * sentence of the person's own prose can hold one, and reading that sentence
 * as a meeting would both spoil it and hide the meeting after it.
 *
 * Two writers share that lookup: {@link editCalendarCell} changes one cell of
 * one row, and {@link writeCalendarRows} writes the whole set of data rows a
 * caller wants the table to hold in one step — neither one decides which rows
 * belong; that stays a feature's own policy.
 *
 * Like the task-line piece, this is pure code over strings. It touches no
 * vault, no app and no settings storage, and an edit changes one cell and
 * leaves every other byte of the note identical. The one thing it imports is
 * `markdownSections.ts`, which is core code over strings in the same way and
 * imports nothing itself: CommonMark's rule for what opens and closes a fenced
 * block is stated there and was stated a second time here until
 * #412. What a `schema`
 * block *is* stays this module's own question — the core reads an info string
 * and decides nothing about it.
 *
 * There is no lookbehind in this file. Obsidian on older mobile WebViews
 * cannot run one, and the whole manifest has to stay mobile-capable. That is
 * held to by `afterTheFloor` in `src/__tests__/platform.test.ts`, over every
 * shipped module at once rather than over this file by name.
 */

import { closesFence, openingFence } from "./markdownSections";

/** The two column names, as the person configured them. */
export interface ColumnNames {
	readonly time: string;
	readonly event: string;
}

/** Which of the two columns a cell belongs to. */
export type CalendarColumn = "time" | "event";

/** One meeting: the two cells this piece understands, and where its line is. */
export interface CalendarRow {
	/** Index into the lines the table was parsed from. */
	readonly line: number;
	readonly time: string;
	readonly event: string;
	/**
	 * How many cells the row's own line actually held. `time` and `event` read
	 * as blank text whether a cell was written blank or left off the end
	 * entirely, so a caller that has to tell those two apart — a short row is
	 * a row error to `readDay`, issue #640 — reads this against the table's
	 * `columnCount` rather than the two strings.
	 */
	readonly cellCount: number;
}

export interface CalendarTable {
	/** Index into the lines the table was parsed from. */
	readonly headerLine: number;
	/** How many cells the header row named — what a row's own `cellCount` is measured against. */
	readonly columnCount: number;
	/** The body rows, in the order they are written. */
	readonly rows: readonly CalendarRow[];
}

/**
 * Why no calendar table was read. Five reasons rather than one silence, because
 * a caller that draws the day has a different sentence to say for each, and a
 * bare `null` left it with nothing to say at all.
 *
 * The first two are about the note. The last three are about the names the
 * person configured, or a table that defeats them; they are kept apart rather
 * than folded together because "you have not named a column", "both your
 * columns are named the same" and "that table names one of them twice" are
 * three different things for a person to fix.
 */
export type CalendarTableAbsence =
	/** These lines hold no fenced `schema` block at all. */
	| "no-schema-block"
	/**
	 * A `schema` block was there, and no table inside one named both columns.
	 * A table written without the leading pipe lands here — see `tableRow`.
	 */
	| "no-table-in-block"
	/** One of the two configured names is blank, so it can name no column. */
	| "column-name-blank"
	/** The two configured names fold to the same text and cannot tell two columns apart. */
	| "column-names-alike"
	/** A table names one of the configured columns twice, so neither one is the column. */
	| "column-named-twice";

/**
 * What `parseCalendarTable` gives back: the table, or the reason there is none.
 *
 * `found` is the discriminator. Reading `outcome.table` is only possible after
 * `outcome.found` has been checked, so a caller cannot use a table that is not
 * there — which is the half of the old `null` that was worth keeping.
 */
export type CalendarTableOutcome =
	| { readonly found: true; readonly table: CalendarTable }
	| { readonly found: false; readonly absence: CalendarTableAbsence };

/**
 * What {@link editCalendarCell} and {@link writeCalendarRows} both give back:
 * the new lines, or the reason there are none.
 *
 * The same `found` discriminator and the same five reasons as
 * {@link CalendarTableOutcome}, because every writer runs the identical
 * lookup. {@link CalendarTableAbsence} is named here rather than a second list
 * being written out, so a sixth reason added to the reader arrives in every
 * writer with no second edit.
 */
export type CalendarEditOutcome =
	| { readonly found: true; readonly lines: string[] }
	| { readonly found: false; readonly absence: CalendarTableAbsence };

/**
 * Reads the calendar table out of `lines` — the lines of a note, or of the
 * calendar section of one.
 *
 * When no table is read, the outcome carries which of the five reasons it was,
 * so a caller can tell the person what to do about it. A feature that draws the
 * day cannot say "there is no calendar block here" and "the block here holds no
 * table I can read" if the reader gives it one silence for both.
 *
 * A table carrying columns beyond the two is read all the same: the extra
 * columns are simply not this piece's business, and refusing them would leave
 * a day's log the plugin wrote before the third column was dropped unreadable.
 */
export function parseCalendarTable(
	lines: readonly string[],
	columns: ColumnNames,
): CalendarTableOutcome {
	const found = locate(lines, columns);
	if (!found.found) return found;
	return tableFromLocated(lines, found.at);
}

/**
 * Reads the calendar table out of `lines` when they are already the body of
 * one block — what Obsidian hands a code-block renderer, the lines between
 * the fences and not the note. `parseCalendarTable` cannot answer this: it
 * looks for a fenced `schema` block first, and a renderer never sees the
 * fences.
 *
 * Runs **the same per-block lookup** `parseCalendarTable` runs inside each
 * block it finds — `tableInRange`, below — so the two cannot disagree about
 * which row is row 3; `editCalendarCell` runs it too. Reading the note's own
 * lines instead, through Obsidian's section information, was rejected in the
 * spec:
 * that answers nothing in an exported view, or a block genuinely nested in a
 * callout or blockquote — not, as decision 5 assumed, in an embed: a
 * whole-note, heading or block embed all get real section information
 * (Ticket #685, amending
 * decision 5 the same way it amends decision 12).
 *
 * How far an unclosed `schema` block may run — [ADR
 * 0004](../../docs/adr/0004-commonmark-decides-what-may-follow-a-closing-fence-run.md)'s
 * open consequence — is not this function's question: Obsidian has already
 * bounded the block by the time it hands over a body, so there is no fence
 * left here to run away. Whoever instead walks the note's own lines to find a
 * block still owns that bound.
 */
export function parseCalendarTableFromBody(
	lines: readonly string[],
	columns: ColumnNames,
): CalendarTableOutcome {
	const checked = checkColumns(columns);
	if ("absence" in checked) return checked;

	const found = tableInRange(lines, checked.wanted, 0, lines.length);
	if (!found.found) return found;
	return tableFromLocated(lines, found.at);
}

/** {@link CalendarTable} built from a located header and rows, shared by both readers. */
function tableFromLocated(lines: readonly string[], at: Located): CalendarTableOutcome {
	return {
		found: true,
		table: {
			headerLine: at.headerLine,
			columnCount: at.columnCount,
			rows: at.rows.map((row) => ({
				line: row.line,
				cellCount: row.cells.length,
				time: readCell(lines[row.line], row.cells[at.columnIndex.time]),
				event: readCell(lines[row.line], row.cells[at.columnIndex.event]),
			})),
		},
	};
}

/**
 * Writes `cell.value` into one cell of the calendar table in `lines`, and
 * returns the new lines. The lines handed in are not changed.
 *
 * When no table matched, the outcome carries which of the five reasons it was,
 * exactly as {@link parseCalendarTable}'s does and from the same lookup, so a
 * caller that could not write has something to tell the person. A write that
 * failed because the note holds no calendar block and one that failed because
 * both columns are configured to the same name are two different things to say,
 * and a bare `null` said neither.
 *
 * Throws a `RangeError` when the table has no such row — the caller is
 * working from a reading of the note that is no longer true, which is worth
 * hearing about loudly rather than being handed back as one of the five.
 *
 * A row that does not physically hold the cell being written — a blank,
 * unterminated last cell, or a row shorter still — is extended rather than
 * refused: `parseCalendarTable` already reports such a cell as blank, so a
 * caller writing into it is not mistaken. The missing cells up
 * to and including the one written are appended in column order, each padded
 * the way `writeCell` pads a blank cell. The row's own closing-pipe habit is
 * kept — a row that ended with a closing pipe still ends with one, and a row
 * that did not still does not — and a trailing carriage return stays at the
 * very end of the line. Cells that exist are untouched.
 *
 * `cell.row` counts the body rows from zero, as `parseCalendarTable` lists
 * them. The value is written as text: a pipe in it is escaped so that the
 * table keeps its shape, and a line break is refused because a table row
 * cannot hold one.
 */
export function editCalendarCell(
	lines: readonly string[],
	columns: ColumnNames,
	cell: { readonly row: number; readonly column: CalendarColumn; readonly value: string },
): CalendarEditOutcome {
	assertNoLineBreak(cell.value);

	const outcome = locate(lines, columns);
	// Handed straight back rather than rebuilt, which is what keeps the two
	// functions on one list of reasons.
	if (!outcome.found) return outcome;
	const found = outcome.at;

	const row = found.rows[cell.row];
	if (!row) {
		throw new RangeError(
			`The calendar table has ${found.rows.length} rows, so there is no row ${cell.row}.`,
		);
	}

	const targetIndex = found.columnIndex[cell.column];
	const next = [...lines];
	next[row.line] = writeRowLine(lines[row.line], row.cells, [
		{ index: targetIndex, value: cell.value },
	]);
	return { found: true, lines: next };
}

/**
 * One row a caller wants the table to hold, for {@link writeCalendarRows}.
 *
 * `from` says which of the table's own rows this is — the index
 * {@link parseCalendarTable} would give it, counted from zero — or `null` for
 * a row that does not exist in the note yet. A plain pair of cells could not
 * say that: without it the writer could not know which physical row an entry
 * was ever about, and so could keep neither that row's own padding and
 * closing-pipe habit nor a third column's cell it knows nothing about
 * (ticket #693, correcting
 * spec #687 decision 8's
 * plain `{ time, event }` pair — the losing option, left standing nowhere in
 * this file).
 *
 * Which rows are new, kept or changed is never this module's decision, the
 * same seam #618 drew
 * between the core's table grammar and a feature's own reading of a day: a
 * feature works that out from its own memory of what it last wrote, and hands
 * this writer the answer, one entry per row it wants on the page.
 */
export interface CalendarRowWrite {
	/**
	 * The data row this is, counted from zero as {@link parseCalendarTable}
	 * lists them, or `null` for a row that does not exist yet.
	 */
	readonly from: number | null;
	readonly time: string;
	readonly event: string;
}

/**
 * Writes a whole table's data rows back in one step: the table found in
 * `lines` ends up holding exactly `rows`, in the order given. Decides nothing
 * about which rows those should be — see {@link CalendarRowWrite}.
 *
 * A row with a `from` is written in place, through the same
 * {@link writeRowLine} — and so the same `writeCell` — {@link editCalendarCell}
 * writes with, both cells at once; every other byte of that line, a third
 * column's cell included, is left alone. A row with `from: null` is a new
 * line, every cell padded with one space each side the way a blank cell
 * always is, inserted at its place in the list, and carrying the line
 * ending — `\r` or none — of the row before it in the finished table, or the
 * header's own ending for one inserted first: a built row that always ended
 * bare was the one line without its own carriage return in a note written
 * with Windows line endings.
 *
 * **A row goes only when `remove` names it**: its line is taken out
 * whole, line ending and all, and every other line is left byte-identical.
 * The table always sits inside a fenced block, so a removed row is never the
 * note's last line and never leaves a line ending behind it.
 *
 * The lists are checked before anything is written: every `from` must name a
 * row the table has, at most once, in ascending order; every index in
 * `remove` must name a row the table has, at most once, and one no entry in
 * `rows` writes; and every one of the table's own rows has to be named by
 * exactly one of the two. Violating any of that throws a `RangeError` saying
 * so — a caller working from a stale reading of the note — rather than
 * being handed back as one of the five {@link CalendarTableAbsence} reasons.
 * A row left out of both lists is never taken for a removal: deleting is
 * asked for by name or not at all.
 *
 * Answers the same {@link CalendarEditOutcome} {@link editCalendarCell}
 * answers, from the same lookup, for the same reason.
 */
export function writeCalendarRows(
	lines: readonly string[],
	columns: ColumnNames,
	rows: readonly CalendarRowWrite[],
	remove: readonly number[] = [],
): CalendarEditOutcome {
	for (const row of rows) {
		assertNoLineBreak(row.time);
		assertNoLineBreak(row.event);
	}

	const outcome = locate(lines, columns);
	if (!outcome.found) return outcome;
	const found = outcome.at;

	checkRowWrites(rows, remove, found.rows.length);

	const newRowLines: string[] = [];
	for (const row of rows) {
		if (row.from === null) {
			const previous = newRowLines[newRowLines.length - 1] ?? lines[found.headerLine];
			newRowLines.push(buildNewRowLine(found, row, previous.endsWith("\r") ? "\r" : ""));
			continue;
		}
		const existing = found.rows[row.from];
		newRowLines.push(
			writeRowLine(lines[existing.line], existing.cells, [
				{ index: found.columnIndex.time, value: row.time },
				{ index: found.columnIndex.event, value: row.event },
			]),
		);
	}

	const firstRowLine = found.headerLine + 2;
	const next = [...lines];
	next.splice(firstRowLine, found.rows.length, ...newRowLines);
	return { found: true, lines: next };
}

/**
 * Checks a {@link writeCalendarRows} call's `rows` and `remove` against the
 * table's own row count, before anything is written. Every `from` must name a
 * row that exists, at most once, in ascending order; every removal must name a
 * row that exists, at most once, that no `from` writes; and every one of the
 * table's rows must be named exactly once across the two — a list that skips
 * one would delete it without being asked to.
 */
function checkRowWrites(rows: readonly CalendarRowWrite[], remove: readonly number[], existingCount: number): void {
	const seen = new Set<number>();
	let last = -1;
	for (const row of rows) {
		if (row.from === null) continue;
		if (row.from < 0 || row.from >= existingCount) {
			throw new RangeError(
				`The calendar table has ${existingCount} rows, so there is no row ${row.from}.`,
			);
		}
		if (seen.has(row.from)) {
			throw new RangeError(`Row ${row.from} is written more than once.`);
		}
		if (row.from < last) {
			throw new RangeError(
				`Row ${row.from} is written after row ${last}, but the table holds it earlier; rows must be written in ascending order.`,
			);
		}
		seen.add(row.from);
		last = row.from;
	}
	for (const index of remove) {
		if (!Number.isInteger(index) || index < 0 || index >= existingCount) {
			throw new RangeError(`The calendar table has ${existingCount} rows, so there is no row ${index} to remove.`);
		}
		if (seen.has(index)) {
			throw new RangeError(
				remove.indexOf(index) !== remove.lastIndexOf(index)
					? `Row ${index} is removed more than once.`
					: `Row ${index} is both written and removed.`,
			);
		}
		seen.add(index);
	}
	if (seen.size !== existingCount) {
		const missing: number[] = [];
		for (let i = 0; i < existingCount; i++) if (!seen.has(i)) missing.push(i);
		const plural = missing.length !== 1;
		throw new RangeError(
			`Row${plural ? "s" : ""} ${missing.join(", ")} of the table ${plural ? "are" : "is"} missing from the write; a row is removed only when it is named for removal.`,
		);
	}
}

/**
 * A brand-new data row for `row`: one space of padding each side of every
 * cell, blank where neither `time` nor `event` names the column, ending in
 * `ending` — `"\r"` or `""`, {@link writeCalendarRows}'s own choice of the
 * row before it or the header.
 */
function buildNewRowLine(found: Located, row: CalendarRowWrite, ending: string): string {
	const cells = new Array<string>(found.columnCount).fill("");
	for (let i = 0; i < cells.length; i++) cells[i] = writeCell("", "");
	cells[found.columnIndex.time] = writeCell("", row.time);
	cells[found.columnIndex.event] = writeCell("", row.event);
	return `|${cells.join("|")}|${ending}`;
}

/** Throws the way both {@link editCalendarCell} and {@link writeCalendarRows} refuse a value holding a line break. */
function assertNoLineBreak(value: string): void {
	if (/[\r\n]/.test(value)) {
		throw new Error("A calendar cell cannot hold a line break.");
	}
}

/**
 * Writes `targets` — each a column's index into `cells` and the value it
 * should hold — into `line`, and returns the new line. Shared by
 * {@link editCalendarCell}, writing one column, and
 * {@link writeCalendarRows}, writing both of a row's columns at once, so a
 * pipe in a meeting's title is escaped the same way for either.
 *
 * `cells` is read only through `spans` below, never directly: when the row
 * ends in a carriage return and has no closing pipe, `splitRow` has nothing
 * to stop the last cell's span before the line's own end, so that span
 * swallows the `\r`. Clamping it here to the row's real content — the line
 * without that trailing `\r` — is what lets the extension below and an
 * in-place rewrite of that same cell agree on where the row actually ends.
 * Trusting the unclamped span as that boundary was ticket #702: the in-place
 * rewrite of a row's one existing cell reached past where the extension had
 * already spliced, and read the pipe the extension had just appended as part
 * of the cell being rewritten, merging the row's two cells into one.
 *
 * A target whose column already has a cell is rewritten in place through
 * `writeCell`, keeping that cell's own padding. A target past the row's own
 * cells extends it: `last` always exists (`tableRow` never hands back an
 * empty `cells` array, so a row has at least one cell); `last.end` sits on
 * the row's closing pipe when it has one — `splitRow` puts it exactly on the
 * line's last non-whitespace character in that case — and at the end of the
 * line's real content when it does not. Any column between the row's own
 * cells and the furthest target is filled blank, the same way `writeCell`
 * pads a blank cell.
 *
 * The extension is done first, from the original `line`, so the in-place
 * edits below it can still trust their spans: extending only ever appends at
 * or after `last.end`, and every span still to be edited in place ends at or
 * before that offset, so the appended text never moves it.
 */
function writeRowLine(
	line: string,
	cells: readonly Span[],
	targets: readonly { readonly index: number; readonly value: string }[],
): string {
	const missing = targets.filter((t) => t.index >= cells.length);
	const existing = targets.filter((t) => t.index < cells.length);

	const hasCR = line.endsWith("\r");
	const content = hasCR ? line.slice(0, -1) : line;
	const lastIndex = cells.length - 1;
	const spans = cells.map((span, i) =>
		i === lastIndex && span.end > content.length ? { start: span.start, end: content.length } : span,
	);

	let result = line;
	if (missing.length > 0) {
		const maxIndex = Math.max(...missing.map((t) => t.index));
		const valueAt = new Map(missing.map((t) => [t.index, t.value]));
		const last = spans[lastIndex];
		const hadClosingPipe = content[last.end] === "|";
		const tailStart = hadClosingPipe ? last.end + 1 : content.length;

		const appendedCells: string[] = [];
		for (let i = cells.length; i <= maxIndex; i++) {
			appendedCells.push(writeCell("", valueAt.get(i) ?? ""));
		}

		const appended =
			appendedCells.map((text, i) => (hadClosingPipe && i === 0 ? text : `|${text}`)).join("") +
			(hadClosingPipe ? "|" : "") +
			(hasCR ? "\r" : "");

		// A pipe appended straight onto a run of backslashes reads back as
		// escaped text, not a bound — `splitRow` counts the backslashes right
		// in front of it. A space breaks the run without changing anything
		// `hadClosingPipe` already produces, where the appended cell's own
		// leading space plays the same part.
		const gap = !hadClosingPipe && endsWithOddBackslashes(content) ? " " : "";

		result = line.slice(0, tailStart) + gap + appended;
	}

	// Rightmost first, so editing one target's span cannot move the offsets
	// this loop still has to trust for the ones to its left.
	for (const target of [...existing].sort((a, b) => b.index - a.index)) {
		const span = spans[target.index];
		const written = writeCell(result.slice(span.start, span.end), target.value);
		result = result.slice(0, span.start) + written + result.slice(span.end);
	}

	return result;
}

/** Where one cell's text sits in its line: the offsets between its two pipes. */
interface Span {
	readonly start: number;
	readonly end: number;
}

/** The table as found in the lines, with everything an edit needs to place a cell. */
interface Located {
	readonly headerLine: number;
	readonly columnIndex: Record<CalendarColumn, number>;
	/** How many cells the header row itself held — carried through to `CalendarTable.columnCount`. */
	readonly columnCount: number;
	readonly rows: readonly { readonly line: number; readonly cells: readonly Span[] }[];
}

/** Where the table is, or why there is none — `parseCalendarTable`'s answer, before the cells are read. */
type LocateOutcome =
	| { readonly found: true; readonly at: Located }
	| { readonly found: false; readonly absence: CalendarTableAbsence };

/**
 * Finds the first table, in the first fenced `schema` block that holds one,
 * whose headings name both configured columns.
 *
 * Two things stop the search outright rather than moving it on: a pair of
 * configured names that cannot tell two columns apart, and a table naming one
 * of them twice. Both are ambiguous, and reading past an ambiguous table to
 * edit a later one would be the plugin guessing.
 *
 * The configured names are judged before the note is looked at, so a person who
 * has left a column unnamed hears about that rather than about their note.
 */
function locate(lines: readonly string[], columns: ColumnNames): LocateOutcome {
	const checked = checkColumns(columns);
	if ("absence" in checked) return checked;

	const blocks = schemaBlocks(lines);
	if (blocks.length === 0) return { found: false, absence: "no-schema-block" };

	for (const block of blocks) {
		const found = tableInRange(lines, checked.wanted, block.from, block.to);
		if (found.found || found.absence === "column-named-twice") return found;
	}

	return { found: false, absence: "no-table-in-block" };
}

/**
 * The two configured column names, folded and validated, or the absence that
 * says why they cannot name two columns at all. Shared by `locate` and
 * {@link parseCalendarTableFromBody}, which judge a person's configuration
 * the same way whether or not a schema block is even in view.
 */
function checkColumns(
	columns: ColumnNames,
): { readonly wanted: { readonly time: string; readonly event: string } } | { readonly found: false; readonly absence: CalendarTableAbsence } {
	const wanted = { time: fold(columns.time), event: fold(columns.event) };
	if (wanted.time === "" || wanted.event === "") return { found: false, absence: "column-name-blank" };
	if (wanted.time === wanted.event) return { found: false, absence: "column-names-alike" };
	return { wanted };
}

/**
 * Finds the first table in `lines[from, to)` whose headings name both of
 * `wanted`'s columns — the header by name, the dashes under it, and the rows
 * below. This is **the very lookup** both readers run inside a block: the
 * note reader's `locate` calls it once per fenced `schema` block it finds,
 * and {@link parseCalendarTableFromBody} calls it once over the whole body it
 * was handed, so the two can never disagree about which row is row 3.
 *
 * A table naming one of the two columns twice stops the search outright
 * rather than moving it on — see `locate` — so `column-named-twice` is
 * returned rather than treated as "keep looking".
 */
function tableInRange(
	lines: readonly string[],
	wanted: { readonly time: string; readonly event: string },
	from: number,
	to: number,
): LocateOutcome {
	for (let i = from; i < to; i++) {
		const header = tableRow(lines[i]);
		if (!header || header.length < 2) continue;

		const delimiter = i + 1 < to ? tableRow(lines[i + 1]) : null;
		if (!delimiter || delimiter.length !== header.length) continue;
		if (!delimiter.every((span) => isDashes(lines[i + 1], span))) continue;

		const headings = header.map((span) => fold(readCell(lines[i], span)));
		const time = matchOne(headings, wanted.time);
		const event = matchOne(headings, wanted.event);
		if (time === ambiguous || event === ambiguous) {
			return { found: false, absence: "column-named-twice" };
		}
		if (time === null || event === null) continue;

		const rows: { line: number; cells: readonly Span[] }[] = [];
		for (let r = i + 2; r < to; r++) {
			const cells = tableRow(lines[r]);
			// A row may be short — a trailing cell nobody wrote — but one
			// wider than the header is not this table's row at all. Accepted
			// either way: this reader still just reads it, and
			// `CalendarRow.cellCount` is what lets a caller such as `readDay`
			// tell a short row from a genuinely blank one.
			if (!cells || cells.length > header.length) break;
			rows.push({ line: r, cells });
		}

		return {
			found: true,
			at: { headerLine: i, columnIndex: { time, event }, columnCount: header.length, rows },
		};
	}

	return { found: false, absence: "no-table-in-block" };
}

/** Returned by `matchOne` when a heading is written twice and cannot be told apart. */
const ambiguous = -1;

/** The one heading equal to `name`, its index; `null` for none, `ambiguous` for several. */
function matchOne(headings: readonly string[], name: string): number | null {
	const hits: number[] = [];
	for (let i = 0; i < headings.length; i++) {
		if (headings[i] === name) hits.push(i);
	}
	if (hits.length > 1) return ambiguous;
	return hits.length === 1 ? hits[0] : null;
}

/**
 * The body-line ranges of every fenced `schema` block, outermost fences only.
 *
 * **What opens and closes a fence is asked of the core**, not stated here:
 * `openingFence` and `closesFence` in `markdownSections.ts` hold CommonMark's
 * marker, run-length and info-string rules, and this module wrote them out a
 * second time until #412.
 * What is left here is the wider question the core does not answer — which of
 * those blocks the person meant as a schema, and where the outermost ones end.
 *
 * Skipping to the closing line rather than past it is what makes these the
 * outermost blocks: a fence written inside a block is body text, and the walk
 * never asks whether it opens anything.
 */
function schemaBlocks(lines: readonly string[]): { from: number; to: number }[] {
	const blocks: { from: number; to: number }[] = [];

	for (let i = 0; i < lines.length; i++) {
		const fence = openingFence(lines[i]);
		if (!fence) continue;

		let end = lines.length;
		for (let j = i + 1; j < lines.length; j++) {
			if (closesFence(lines[j], fence)) {
				end = j;
				break;
			}
		}
		// An unclosed fence runs to the end of what it was given, as CommonMark says.
		if (isSchemaInfo(fence.info)) blocks.push({ from: i + 1, to: end });
		i = end;
	}

	return blocks;
}

/**
 * Whether a fence's info string marks the block as a schema block: its first
 * word is `schema`, capitals ignored. `schema json` counts and `schemas` does
 * not — the word has to be the whole of that first word.
 *
 * The core hands over the info string as written and says nothing about what it
 * means. This is where the plugin decides that one word in it names the block
 * it draws the day's calendar from.
 */
function isSchemaInfo(info: string): boolean {
	return fold(info.split(/\s+/)[0] ?? "") === "schema";
}

/**
 * The cells of a line written as a table row, or `null` when it is not one.
 *
 * A line counts as a table row only if it opens with the pipe: up to three
 * spaces of indentation, as Markdown allows, and then an unescaped `|`. Merely
 * holding a pipe is not enough, or a sentence of the person's own prose inside
 * the block would be read as a meeting — and then written into.
 *
 * The cost is that a table written in the pipe-less style Markdown also allows
 * is not found at all. That is the safe half of the trade: the plugin does
 * nothing rather than editing the wrong line. The author's own tables are
 * never written that way, confirmed on 2026-09-07, so the rule stays.
 *
 * Not finding it is no longer the same as going quiet about it: such a block
 * comes back from `parseCalendarTable` as `no-table-in-block`, which a caller
 * can put in front of the person, rather than as the silence a note with no
 * `schema` block at all would give.
 */
function tableRow(line: string): Span[] | null {
	if (!/^ {0,3}\|/.test(line)) return null;
	return splitRow(line);
}

/**
 * The cells between the pipes of `line`, as offsets into it, or `null` when
 * there are no pipes at all. The trailing pipe is optional, as it is in
 * Markdown, a pipe written `\|` is text rather than a bound, and so is a pipe
 * inside a wikilink's `[[…]]` — the old readers' rule, carried rather than
 * invented: `~/Devbox/schema-render/src/parser.ts:27-39`,
 * `~/Devbox/calendar-scaffold/src/schema-table.ts:119-121`. Whether the line
 * is a table row in the first place is `tableRow`'s question, not this
 * one's — nothing calls this directly.
 */
function splitRow(line: string): Span[] | null {
	const links = wikilinkRanges(line);
	const bars: number[] = [];
	for (let i = 0; i < line.length; i++) {
		if (line[i] !== "|") continue;
		if (insideAny(links, i)) continue;
		let backslashes = 0;
		for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) backslashes++;
		if (backslashes % 2 === 0) bars.push(i);
	}
	if (bars.length === 0) return null;

	const first = line.search(/\S/);
	let last = line.length - 1;
	while (last >= 0 && /\s/.test(line[last])) last--;

	let bounds = bars;
	let start = 0;
	let finish = line.length;
	if (bounds[0] === first) {
		start = bounds[0] + 1;
		bounds = bounds.slice(1);
	}
	if (bounds.length > 0 && bounds[bounds.length - 1] === last) {
		finish = bounds[bounds.length - 1];
		bounds = bounds.slice(0, -1);
	}
	if (start > finish) return null;

	const cells: Span[] = [];
	let from = start;
	for (const bar of bounds) {
		cells.push({ start: from, end: bar });
		from = bar + 1;
	}
	cells.push({ start: from, end: finish });
	return cells;
}

/**
 * The `[start, end)` ranges of every `[[…]]` wikilink in `line`, offsets into
 * the line unchanged — `splitRow` needs the real positions, not a masked
 * copy, because `editCalendarCell` places a cell by slicing the original
 * line at those offsets. The pattern is the old readers' own, not widened:
 * a `]` inside the link is not allowed, matching what they carried.
 */
function wikilinkRanges(line: string): { readonly start: number; readonly end: number }[] {
	const ranges: { start: number; end: number }[] = [];
	const pattern = /\[\[[^\]]*\]\]/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(line))) {
		ranges.push({ start: match.index, end: match.index + match[0].length });
	}
	return ranges;
}

/** Whether `index` falls inside any of `ranges`. */
function insideAny(ranges: readonly { readonly start: number; readonly end: number }[], index: number): boolean {
	return ranges.some((range) => index >= range.start && index < range.end);
}

/** Whether `text` ends in a run of backslashes of odd length — the same count `splitRow` makes before a pipe. */
function endsWithOddBackslashes(text: string): boolean {
	let count = 0;
	for (let i = text.length - 1; i >= 0 && text[i] === "\\"; i--) count++;
	return count % 2 === 1;
}

/** Whether a cell of the row under a header is the dashes that make it a table. */
function isDashes(line: string, span: Span): boolean {
	return /^:?-+:?$/.test(line.slice(span.start, span.end).trim());
}

/**
 * One cell's text: trimmed, and with the two escapes `writeCell` makes read
 * back as the characters they stand for. A backslash in front of anything else
 * is left alone, because in a table nobody's plugin wrote it is just a
 * backslash — a Windows path, say.
 */
function readCell(line: string, span: Span | undefined): string {
	if (!span) return "";
	return line
		.slice(span.start, span.end)
		.trim()
		.replace(/\\([\\|])/g, "$1");
}

/**
 * `text` with the backslash and the pipe escaped the way a cell's text is, so
 * that {@link readCell} reads it back unchanged. The backslash goes first, or
 * escaping the pipe would produce a backslash the next escape pass would read
 * as one of ours. These two replacements and `readCell`'s one are inverses,
 * and text that goes through anything else can move a cell's closing pipe and
 * swallow the column beside it.
 *
 * Exported for `calendarTableBlock` in `vaultLayout.ts`, the one other place
 * configured text reaches a table line: a column name can carry a pipe as
 * freely as a cell's value can, and the header it names is unreadable unless
 * it is escaped the same way.
 */
export function escapeCellText(text: string): string {
	return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/**
 * `value` written back into a cell whose text is currently `raw`, keeping the
 * padding the cell was written with. A cell holding nothing but space gets one
 * space on each side, because there is no padding to keep.
 */
function writeCell(raw: string, value: string): string {
	const escaped = escapeCellText(value);
	const content = raw.trim();
	if (content === "") return ` ${escaped} `;

	const start = raw.indexOf(content);
	return raw.slice(0, start) + escaped + raw.slice(start + content.length);
}

/** A name as it is matched: trimmed, and with capitals ignored. */
function fold(name: string): string {
	return name.trim().toLowerCase();
}
