/**
 * What a day's calendar table should hold, before any existing row is looked
 * at: one {@link DesiredRow} per meeting on the day, in the order they belong
 * in the table.
 *
 * Carried from `~/Devbox/calendar-scaffold/src/schema-table.ts`'s
 * `desiredRows` and `~/Devbox/calendar-scaffold/src/event-time.ts`'s
 * `timeCellFor`/`startMinutesOn`/`endMinutesOn`, minus the third
 * `Ansträngning` column those files were built to protect and minus
 * `WORK_CALENDAR`/`isMeeting` — which calendar a meeting is on plays no part
 * here (named difference 4, issue #687).
 */

import type { Meeting } from "../../core/icsReader";
import { writeTimeCell } from "../../core/timeCell";
import {
	localDateKey,
	locationSuffix,
	meetingNoteBasename,
	meetingNoteDate,
	meetingTitle,
	plainCellText,
} from "../../core/meetingName";

/** Everything one meeting needs to become or update a row, in sort order. */
export interface DesiredRow {
	readonly uid: string;
	/** The meeting's title, or the placeholder. */
	readonly title: string;
	/** The `Tid` cell. */
	readonly time: string;
	/** The calendar-table cell: a link or plain text, with its location. */
	readonly meetingCell: string;
	/** Its source is switched on for notes. */
	readonly makesNote: boolean;
	/** Clamped to this day, for the sort and the insertion. */
	readonly startMin: number;
	readonly endMin: number;
}

/**
 * One {@link DesiredRow} per meeting in `onTheDay`, sorted into the order
 * they belong in `date`'s table.
 *
 * `onTheDay` is `host.calendar.meetingsOn(day, "day")` — a meeting that
 * appears only in `makingNotes` (`meetingsOn(day, "notes")`) gets no row: a
 * source switched on for notes and off for the day is not meant to be seen
 * in the table. `makesNote` is decided by `uid` membership in `makingNotes`
 * alone — never by a calendar's name, which is the one behaviour change this
 * feature makes over the old plugin (named difference 4).
 */
export function desiredRowsFor(
	onTheDay: readonly Meeting[],
	makingNotes: readonly Meeting[],
	day: Date,
): DesiredRow[] {
	const date = localDateKey(day);
	const notesUids = new Set(makingNotes.map((meeting) => meeting.uid));

	const rows = onTheDay.map((meeting) => {
		const title = meetingTitle(meeting.summary);
		const makesNote = notesUids.has(meeting.uid);
		const { startMin, endMin } = clampedMinutes(meeting, date);
		const time = writeTimeCell(startMin, endMin, meeting.allDay);
		const meetingCell = meetingCellFor(meeting, title, makesNote, date);
		return { uid: meeting.uid, title, time, meetingCell, makesNote, startMin, endMin };
	});

	return rows.sort(
		(a, b) =>
			a.startMin - b.startMin ||
			a.endMin - b.endMin ||
			// By code unit, not `localeCompare`: a locale-dependent order would
			// put a new row in a different place on a different device, and a
			// stable insertion is the whole point.
			compareByCodeUnit(a.meetingCell, b.meetingCell) ||
			compareByCodeUnit(a.uid, b.uid),
	);
}

function compareByCodeUnit(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

/**
 * The calendar-table cell for one meeting on `date`: a wikilink to its
 * meeting note when `makesNote`, plain text otherwise, with the location as
 * a trailing parenthesis when there is one. Carried from `eventCellFor`,
 * `schema-table.ts:222-230`.
 */
function meetingCellFor(meeting: Meeting, title: string, makesNote: boolean, date: string): string {
	const body = makesNote
		? `[[${meetingNoteBasename(meetingNoteDate(meeting, date), meeting.summary)}]]`
		: plainCellText(title);
	const suffix = locationSuffix(meeting.location ?? "");
	return suffix === null ? body : `${body} (${suffix})`;
}

/**
 * The minutes a meeting's `Tid` cell is clamped to on `date`: `00:00` on any
 * day after the meeting's first, `23:59` on any day before its last
 * (`event-time.ts:103-115`). The same clamped minutes are what the sort and
 * `mergeMeetings`'s insertion use, so they are computed once here rather
 * than twice.
 *
 * **Beware `Meeting.end` for an all-day meeting**: it is midnight at the
 * start of its **last** day, never the morning after
 * (`src/core/icsReader.ts:42-51`), so a whole-day meeting's own `endMin` is
 * `1439` rather than `0` the way its raw clock reads.
 *
 * `Date.getHours()`/`getMinutes()` never answer above `23`/`59`, so a real
 * meeting's minutes can never land outside `0..1439` here — but that argues
 * the range only, never the order. `icsReader.ts`'s `touches` deliberately
 * accepts a meeting whose `end` is earlier in the day than its `start`
 * (`DTEND` before `DTSTART`), so the bound `writeTimeCell` needs (comment
 * `5746254606` on issue #696) — `0..1439` with `endMin >= startMin` — does
 * not hold by construction. `endMin` is clamped up to `startMin` below when
 * it would otherwise be smaller, giving such a meeting a zero-length cell at
 * its own start time rather than one `readTimeCell` refuses as backwards.
 */
function clampedMinutes(meeting: Meeting, date: string): { startMin: number; endMin: number } {
	if (meeting.allDay) return { startMin: 0, endMin: 23 * 60 + 59 };

	const startMin = localDateKey(meeting.start) === date ? localMinutesOfDay(meeting.start) : 0;
	const rawEndMin = localDateKey(meeting.end) === date ? localMinutesOfDay(meeting.end) : 23 * 60 + 59;
	return { startMin, endMin: Math.max(startMin, rawEndMin) };
}

/**
 * `date`'s local year, month and day as `YYYY-MM-DD` — the core's own
 * (`src/core/meetingName.ts`), re-exported here for `run.ts` and
 * `mergeMeetings.ts`, which need the identical key to prune and to read
 * {@link RowMemory} by the same dates this module sorts by.
 *
 * `toISOString` would read a local midnight as the day before on this
 * server's timezone (`Europe/Stockholm`), which is exactly the trap this
 * function exists to avoid.
 */
export { localDateKey };

/** Minutes since local midnight. */
function localMinutesOfDay(date: Date): number {
	return date.getHours() * 60 + date.getMinutes();
}
