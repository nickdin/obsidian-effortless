/**
 * Puts a day's desired rows into the table it already has.
 *
 * Carried from `~/Devbox/calendar-scaffold/src/schema-table.ts:264-469`'s
 * `mergeRows`/`findRow`/`insertionIndex`/`shiftClaimed`/`holdsWikilink`,
 * adjusted for two columns instead of three and for the core's own
 * {@link CalendarRowWrite}, which says which existing row an entry is rather
 * than handing back a rebuilt line.
 *
 * This module decides nothing about the table's grammar — which line a row
 * is, how its padding survives, how a pipe in its text is escaped. That is
 * {@link writeCalendarRows}'s job, one layer up; this module only says which
 * rows belong and in what order.
 */

import type { CalendarRowWrite } from "../../core/calendarTable";
import { readTimeCell } from "../../core/timeCell";
import { UNTITLED_MEETING_TITLE } from "../../core/meetingName";
import { localDateKey } from "./desiredRows";
import type { DesiredRow } from "./desiredRows";
import { matchKey } from "./matchKey";
import { wholeOnly } from "./removalReading";
import type { RemovalReading } from "./removalReading";
import { isPluginsOwnCell, recordFor, startKeyFor } from "./rowMemory";
import type { RowMemory, RowMemoryEntry, RowMemoryKey, RowMemoryUpdate } from "./rowMemory";

/** One row already in the table, before this run touches it. */
export interface ExistingRow {
	readonly time: string;
	readonly meetingCell: string;
}

export interface MergeResult {
	readonly rows: readonly CalendarRowWrite[];
	/** The existing rows to take out of the table — a gone meeting's, see {@link mergeMeetings}. */
	readonly remove: readonly number[];
	/** What this run wrote, for the caller to commit into {@link RowMemory} once the write succeeds. */
	readonly remember: readonly RowMemoryUpdate[];
	/** The memory entries of the rows in {@link remove}, for the caller to drop once the write succeeds. */
	readonly forget: readonly RowMemoryKey[];
}

/** One row being built up while a merge runs: an existing table row, or a new one about to be inserted. */
interface WorkingRow {
	/** The existing row's index, or `null` for a row this run is inserting. */
	readonly from: number | null;
	time: string;
	meetingCell: string;
}

/**
 * Puts `desired`'s rows into `existingRows`, matching each to a row already
 * there where one exists.
 *
 * **Matching runs in two steps, in this order** (`findRow`,
 * `schema-table.ts:384-405`):
 *
 *  1. **By memory** — first the unclaimed row whose meeting cell still holds
 *     the exact text this feature last wrote at the meeting's *current*
 *     start minute (issue #715 — the third key part is what tells two
 *     meetings of one repeating uid on the same day apart). Only when that
 *     key holds **no entry at all** — the calendar moved the meeting since,
 *     so its own key is not the one it was last written under — every other
 *     entry remembered for this uid and date is tried too, except one that is
 *     itself another want's own current key this run, disambiguated the same
 *     way — by its own recorded text against the unclaimed rows. An own key that does hold an entry, but whose
 *     text matches no unclaimed row (the row was deleted or hand-edited),
 *     falls straight to the title match below rather than trying another
 *     meeting's entry. What survives a calendar-title rename, a moved start
 *     time, or both at once: the memory, not the row's own text, says which
 *     meeting it was.
 *  2. **By title** — the unclaimed row whose {@link matchKey} equals the
 *     desired cell's, except — only when the meeting's own key held an entry
 *     that matched no row — a row some meeting's memory names for the day,
 *     which is that meeting's. What adopts a row typed
 *     by hand before this feature ever ran, and the row a person edited.
 *
 * A row already claimed by an earlier meeting in the same run is not offered
 * to a second one, so two meetings sharing a title get one row each,
 * decided by the sort order and stable between runs (`shiftClaimed`,
 * `:378-382`).
 *
 * **An unmatched row is never moved, and is removed only when its meeting is
 * gone from the calendar and the row is still exactly the plugin's**
 * — the reading `mayRemove` says the entry's own source read whole, so a
 * meeting missing from it is missing from the calendar rather than from a
 * failed read, and an entry remembered with no source needs every source
 * whole; the day is today or later and the row's own end time has
 * not passed (the same line #1011 draws for rewriting a row), **unless** the
 * entry's own source's whole reading shows the same meeting moved to another
 * day of the window, the one ended row that goes; and a memory entry
 * for the day records that the plugin wrote exactly this meeting cell and
 * this time cell. A row
 * the person typed, a row they edited in either cell, a link the plugin kept
 * as theirs, and a row whose entry predates the record of who wrote it are
 * all kept. Each entry accounts for one row at most, so of two identical
 * rows only one can be the plugin's. Every other unmatched row comes back
 * holding its own existing text, so the writer leaves its line
 * byte-identical. A meeting moved to another time on the same day is found
 * by memory above and is never unmatched; one moved to another day is
 * unmatched here and loses its row, and the day it moved to gains one.
 * **A new row is inserted at its time-sorted position**
 * between existing rows, moving none of them: before the first existing row
 * that starts later, and at the end otherwise. An existing row whose time
 * cell is not a time, read with {@link readTimeCell}, anchors nothing and is
 * stepped over.
 *
 * **A row already holding a link is left alone when its meeting does not
 * make a note and the plugin did not write that link itself**
 * (`holdsWikilink`, `:467-469`, then {@link isPluginsOwnCell}) — deliberately
 * loose about what counts as a link, any `[[…]]` anywhere in the cell, and
 * strict about whose it is: a link is the plugin's own only where memory
 * records the plugin wrote that exact text, or, for an entry stored before
 * that record existed, where it is exactly the link the plugin writes. The plugin's own link is corrected like any cell of its own; every
 * other link is the person's, on every run. Its time cell is still kept up
 * to date. **A row for a
 * meeting that does make a note is rewritten**, even when it already holds a
 * link — what picks up a calendar-title rename on the next run — **until the
 * row's own end time has passed**; after that it is left as written, and an
 * ended meeting with no row gets none.
 *
 * A row of blank cells is never looked for (named difference 5): nothing
 * writes one any more. A row reading *Untitled meeting* at a meeting's start
 * minute, which no memory entry for the day names, is that meeting's and is
 * corrected in place — the third match, after memory and title.
 *
 * Every row remembered carries the one source its meeting came from, as
 * `mayRemove` names it, so a later run can ask that source alone.
 * A plain `true` or `false` for `mayRemove` is a reading that names no
 * source: every entry then falls under it alone, as before #1211.
 */
export function mergeMeetings(
	existingRows: readonly ExistingRow[],
	desired: readonly DesiredRow[],
	remembered: RowMemory,
	date: string,
	now: Date | null = null,
	mayRemove: boolean | RemovalReading = false,
): MergeResult {
	const reading = typeof mayRemove === "boolean" ? wholeOnly(mayRemove) : mayRemove;
	const rows: WorkingRow[] = existingRows.map((row, index) => ({
		from: index,
		time: row.time,
		meetingCell: row.meetingCell,
	}));
	const claimed = new Set<number>();
	const remember: RowMemoryUpdate[] = [];

	// Every want's own current start key, grouped by uid — what the memory
	// fallback below must not steal from, so one occurrence processed first
	// cannot claim the row memory holds for a sibling that has not been
	// processed yet.
	const ownKeysByUid = new Map<string, Set<string>>();
	for (const want of desired) {
		const keys = ownKeysByUid.get(want.uid) ?? new Set<string>();
		keys.add(startKeyFor(want.startMin));
		ownKeysByUid.set(want.uid, keys);
	}

	// Every start minute this run's meetings have, so a row can be told apart
	// from the stale time cell a moved meeting leaves behind.
	const desiredStarts = new Set(desired.map((want) => want.startMin));

	for (const want of desired) {
		const ownKeysForUid = ownKeysByUid.get(want.uid) ?? new Set<string>();
		const index = findRow(rows, claimed, want, remembered, date, ownKeysForUid, desiredStarts);

		const rememberedEntries = Object.values(remembered[want.uid]?.[date] ?? {});
		// The memory's provenance record for this row: the cell text this run
		// wrote, `null` where it kept the person's cell, unset only where an
		// ended row had no record to carry over.
		let wrote: string | null | undefined;
		let landedAt: number;
		if (index === null) {
			// An ended meeting adds no row: a row an older build wrote and
			// memory lost would otherwise be shown twice once the calendar
			// renamed the meeting.
			if (now !== null && hasEnded(want.endMin, date, now)) continue;
			const insertAt = insertionIndex(rows, want.startMin);
			shiftClaimed(claimed, insertAt);
			rows.splice(insertAt, 0, { from: null, time: want.time, meetingCell: want.meetingCell });
			claimed.add(insertAt);
			landedAt = insertAt;
			wrote = want.meetingCell;
		} else if (now !== null && hasEnded(rowEndMinutes(rows[index].time) ?? want.endMin, date, now)) {
			// A meeting that is over is history: its row stays as written,
			// time cell included, whatever the calendar says now. Over
			// means that row's own end time has passed — the calendar's end
			// only where the row's time cell cannot be read.
			claimed.add(index);
			landedAt = index;
			// An ended row is not written, so it carries the record it had.
			wrote = recordFor(rows[index].meetingCell, rememberedEntries);
		} else {
			// A link in a row for a meeting that makes no note is the person's,
			// and this feature stops writing that cell once it is there — unless
			// the plugin wrote that link itself, which it corrects like any
			// other cell of its own.
			const keepMeetingCell =
				!want.makesNote &&
				holdsWikilink(rows[index].meetingCell) &&
				!isPluginsOwnCell(rows[index].meetingCell, date, rememberedEntries);
			rows[index] = {
				from: rows[index].from,
				time: want.time,
				meetingCell: keepMeetingCell ? rows[index].meetingCell : want.meetingCell,
			};
			claimed.add(index);
			landedAt = index;
			wrote = keepMeetingCell ? null : want.meetingCell;
		}

		const source = reading.sourceOf(want.uid);
		remember.push({
			uid: want.uid,
			startMin: want.startMin,
			time: rows[landedAt].time,
			// What the row actually says, not what was wanted — they differ when
			// the meeting cell was left alone, and finding this row again by its
			// text is the memory's whole job.
			meetingCell: rows[landedAt].meetingCell,
			title: want.title,
			...(wrote === undefined ? {} : { wrote }),
			...(source === undefined ? {} : { source }),
		});
	}

	const remove: number[] = [];
	const forget: RowMemoryKey[] = [];
	if (now !== null) {
		const accountedFor = new Set<RowMemoryEntry>();
		// A meeting still on the day is not gone, whichever row it claimed: a
		// second copy of its row — the person's copy, or #1037's duplicate —
		// matches its record too, and must not be taken for a gone meeting's.
		// Judged by the meeting's uid, so one cancelled occurrence of a series
		// with another occurrence the same day keeps its row; that needs the
		// calendar's occurrence identity on the row's memory.
		const onTheDay = new Set(desired.map((want) => want.uid));
		rows.forEach((row, at) => {
			if (row.from === null || claimed.has(at)) return;
			const end = rowEndMinutes(row.time);
			if (end === null) return;
			// An ended row is history, except the old row of a meeting
			// its own source's whole reading shows moved to another day.
			const ended = hasEnded(end, date, now);
			const removable = (uid: string, entry: RowMemoryEntry): boolean =>
				ended ? reading.movedAway(entry.source, uid, date) : reading.mayRemove(entry.source);
			const owner = writtenByThePlugin(row, remembered, date, onTheDay, accountedFor, removable);
			if (owner === null) return;
			remove.push(row.from);
			forget.push(owner);
		});
	}

	return {
		rows: rows
			.filter((row) => row.from === null || !remove.includes(row.from))
			.map((row) => ({ from: row.from, time: row.time, event: row.meetingCell })),
		remove,
		remember,
		forget,
	};
}

/**
 * The memory entry for `date` that records the plugin wrote exactly `row` —
 * its meeting cell by the provenance record and its time cell as
 * stored — whose meeting is not in `onTheDay`, that `removable` lets go, and
 * that no other row has already been put down to, or `null` when none does.
 * The entry found is added to `accountedFor`; one `removable` refuses is
 * passed over and accounts for nothing.
 */
function writtenByThePlugin(
	row: WorkingRow,
	remembered: RowMemory,
	date: string,
	onTheDay: ReadonlySet<string>,
	accountedFor: Set<RowMemoryEntry>,
	removable: (uid: string, entry: RowMemoryEntry) => boolean,
): RowMemoryKey | null {
	for (const [uid, byDate] of Object.entries(remembered)) {
		if (onTheDay.has(uid)) continue;
		for (const [start, entry] of Object.entries(byDate[date] ?? {})) {
			if (accountedFor.has(entry)) continue;
			if (entry.wrote !== row.meetingCell || entry.event !== row.meetingCell || entry.time !== row.time) continue;
			if (!removable(uid, entry)) continue;
			accountedFor.add(entry);
			return { uid, startMin: Number(start) };
		}
	}
	return null;
}

function findRow(
	rows: readonly WorkingRow[],
	claimed: ReadonlySet<number>,
	want: DesiredRow,
	remembered: RowMemory,
	date: string,
	ownKeysForUid: ReadonlySet<string>,
	desiredStarts: ReadonlySet<number>,
): number | null {
	const rememberedForDay = remembered[want.uid]?.[date];
	if (rememberedForDay !== undefined) {
		const ownKey = startKeyFor(want.startMin);
		const ownEntry = rememberedForDay[ownKey];
		if (ownEntry !== undefined) {
			const index = findOwnRow(rows, claimed, want, ownEntry.event, desiredStarts);
			if (index !== null) return index;
			// The row was edited or deleted: fall to the title match below,
			// never to another meeting's entry. Only here does the title
			// match leave out the rows some meeting's memory names — a meeting
			// with no entry of its own gets no such exclusion.
			return findByTitle(rows, claimed, want, date, remembered, true);
		}

		// Runs only when the own key above held no entry at all — the
		// meeting's start moved since this feature last wrote it, so its
		// entry no longer sits under this run's own key. An own key that
		// does hold an entry but matches no unclaimed row falls to the title
		// match below instead, rather than trying another meeting's entry
		// here. The candidates below also exclude any key that
		// is itself another want's own current key this run —
		// an entry under such a key belongs to an occurrence still found
		// through its own lookup, not to the one that moved. What is left is
		// tried in start-minute order: deterministic between runs, and it is
		// this order — not chance — that decides which row is claimed when
		// more than one remaining candidate's text would match an unclaimed
		// row. Two occurrences that both moved on the same day can still
		// cross-match this way, since nothing here carries the calendar's
		// own occurrence identity — out of scope for this
		// ticket.
		const otherKeys = Object.keys(rememberedForDay)
			.filter((key) => !ownKeysForUid.has(key))
			.sort((a, b) => Number(a) - Number(b));
		for (const key of otherKeys) {
			const index = findByRememberedText(rows, claimed, rememberedForDay[key].event);
			if (index !== null) return index;
		}
	}

	return findByTitle(rows, claimed, want, date, remembered, false);
}

/**
 * The row holding the text this meeting's own key remembers. A row whose time
 * cell starts when a different meeting of this run starts is that meeting's,
 * not this one's, even when both remember the same text: two meetings with
 * identical titles would otherwise swap rows once the first's row was edited. A time cell that matches no meeting is only stale — the calendar
 * moved the meeting — and does not disqualify the row.
 */
function findOwnRow(
	rows: readonly WorkingRow[],
	claimed: ReadonlySet<number>,
	want: DesiredRow,
	meetingCellText: string,
	desiredStarts: ReadonlySet<number>,
): number | null {
	const index = rows.findIndex((row, at) => {
		if (claimed.has(at) || row.meetingCell !== meetingCellText) return false;
		const start = rowStartMinutes(row.time);
		return start === null || start === want.startMin || !desiredStarts.has(start);
	});
	return index === -1 ? null : index;
}

/**
 * The title match, then the placeholder match. With `excludeNamed`, a row some
 * meeting's memory names for the day is that meeting's and is never claimed
 * here by title — the rule the placeholder match always had.
 * Only the own-key fall-through asks for it: a meeting with no memory entry
 * title-matches any unclaimed row, since a stale entry of a meeting that left
 * the calendar would otherwise make it add a second row.
 */
function findByTitle(
	rows: readonly WorkingRow[],
	claimed: ReadonlySet<number>,
	want: DesiredRow,
	date: string,
	remembered: RowMemory,
	excludeNamed: boolean,
): number | null {
	const wanted = matchKey(want.meetingCell, date);
	if (wanted.length === 0) return null;
	const named = namedForDay(remembered, date);
	const index = rows.findIndex(
		(row, at) => !claimed.has(at) &&
			!(excludeNamed && named.has(row.meetingCell)) &&
			matchKey(row.meetingCell, date) === wanted,
	);
	if (index !== -1) return index;

	return findPlaceholderRow(rows, claimed, want, date, named);
}

/** The meeting-cell texts that some meeting's memory entry for `date` names. */
function namedForDay(remembered: RowMemory, date: string): ReadonlySet<string> {
	const named = new Set<string>();
	for (const byDate of Object.values(remembered)) {
		for (const entry of Object.values(byDate[date] ?? {})) named.add(entry.event);
	}
	return named;
}

/**
 * A row an older build wrote as the placeholder title — plain, or as the link
 * to the placeholder note — that no memory entry for the day names, starting
 * when this meeting starts. It is this meeting's row, corrected in place, so
 * no second row is added beside it. A row some meeting's memory
 * names is that meeting's, found through its own lookup, and is never handed
 * to another one.
 */
function findPlaceholderRow(
	rows: readonly WorkingRow[],
	claimed: ReadonlySet<number>,
	want: DesiredRow,
	date: string,
	named: ReadonlySet<string>,
): number | null {
	const placeholderKey = matchKey(UNTITLED_MEETING_TITLE, date);
	const index = rows.findIndex(
		(row, at) =>
			!claimed.has(at) &&
			!named.has(row.meetingCell) &&
			matchKey(row.meetingCell, date) === placeholderKey &&
			rowStartMinutes(row.time) === want.startMin,
	);
	return index === -1 ? null : index;
}

/**
 * Whether a row on `date` is over at `now`: every day before today, and
 * today once its end minute has come. An all-day row's end minute is the last
 * of the day (`timeCell.ts`, `desiredRows.ts`).
 */
function hasEnded(endMin: number, date: string, now: Date): boolean {
	const today = localDateKey(now);
	if (date < today) return true;
	if (date > today) return false;
	return endMin <= now.getHours() * 60 + now.getMinutes();
}

function findByRememberedText(
	rows: readonly WorkingRow[],
	claimed: ReadonlySet<number>,
	meetingCellText: string,
): number | null {
	const index = rows.findIndex((row, at) => !claimed.has(at) && row.meetingCell === meetingCellText);
	return index === -1 ? null : index;
}

/**
 * Where a new row goes: before the first existing row that starts later, and
 * at the end otherwise. A row whose time cell {@link readTimeCell} refuses
 * anchors nothing and is stepped over.
 */
function insertionIndex(rows: readonly WorkingRow[], startMin: number): number {
	for (let index = 0; index < rows.length; index++) {
		const minutes = rowStartMinutes(rows[index].time);
		if (minutes !== null && minutes > startMin) return index;
	}
	return rows.length;
}

function rowEndMinutes(time: string): number | null {
	const read = readTimeCell(time);
	return read.ok ? read.endMin : null;
}

function rowStartMinutes(time: string): number | null {
	const read = readTimeCell(time);
	return read.ok ? read.startMin : null;
}

/**
 * Keeps claimed indices pointing at the same rows after an insertion. Called
 * **before** the splice, so every claim at or after the insertion point moves
 * up by one.
 */
function shiftClaimed(claimed: Set<number>, insertedAt: number): void {
	const moved = [...claimed].filter((index) => index >= insertedAt);
	for (const index of moved) claimed.delete(index);
	for (const index of moved) claimed.add(index + 1);
}

/**
 * Does this cell hold a link at all? Deliberately loose — any `[[…]]`
 * anywhere in the cell counts. Whose the link is, is {@link isPluginsOwnCell}'s
 * question: a link is left alone unless the plugin wrote it, so the safe
 * answer errs towards leaving it alone.
 */
function holdsWikilink(cellText: string): boolean {
	return /\[\[[^\]]*\]\]/.test(cellText);
}
