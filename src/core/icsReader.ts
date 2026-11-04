/**
 * The core's calendar: `.ics` bytes in, a day's meetings out.
 *
 * The calendar belongs to the core rather than to a feature, because two
 * features read it — building the days ahead, and meeting notes — and a feature
 * may never reference another one.
 *
 * **This is the reader alone, and it never learns where the bytes came from.**
 * A calendar source is either an HTTPS link the plugin fetches or an `.ics`
 * file inside the vault (ADR 0001), and both hand their bytes to the same
 * function here. That is what makes the two routes a two-line adapter in front
 * of one reader instead of two code paths.
 *
 * Nothing in here reads outside the vault or touches Node, which is what keeps
 * `isDesktopOnly` set to `false` for the whole plugin.
 */

import {
	IcsReadError,
	isExpanderContractError,
	isNotACalendar,
	occurrenceKeyDay,
	readOccurrencesBetween,
	reportLoss,
} from "./icsOccurrences";
import { reasonOf } from "./reason";
import type { IcsLoss, IcsTime, InvitedParty, LossGrade, Occurrence } from "./icsOccurrences";

export { IcsReadError, isNotACalendar, reportLoss };
export type { IcsLoss, InvitedParty, LossGrade };

/** One meeting on one day. */
export interface Meeting {
	/** The calendar's own id. Every occurrence of one repeat shares it. */
	readonly uid: string;
	/** Empty when the event gives none. The reader reports what is there. */
	readonly summary: string;
	readonly location: string | null;
	readonly description: string | null;
	/**
	 * Who called the meeting, `null` when the calendar names none. Meeting
	 * notes is the feature that reads this; the core reads it because a
	 * feature parsing calendar bytes of its own would be a second reader of the
	 * same format, and `.ics` reading is the core's alone (#26, ADR 0001, #14).
	 */
	readonly organizer: InvitedParty | null;
	/**
	 * Everyone the calendar invited, empty when it names nobody. Read for the
	 * same reason as {@link organizer}: meeting notes reads it, and
	 * `.ics` reading is the core's alone (#26, ADR 0001, #14).
	 */
	readonly attendees: readonly InvitedParty[];
	/**
	 * Names *this occurrence* of the meeting's series, stable across a
	 * reschedule — `uid` above is the series id and is shared by every
	 * occurrence of one repeat, this is what tells one of them apart from
	 * another.
	 *
	 * `null` for a meeting that does not repeat. For an occurrence of a
	 * repeat, the occurrence's original start — the moment the repeat rule
	 * would have placed it at, unchanged by a reschedule, so a Tuesday moved
	 * to Thursday keeps Tuesday's key. Two occurrences of one series that ever
	 * land on the same day carry two different keys, because they had two
	 * different original moments. Meeting notes reads it to tell a
	 * moved occurrence's note apart from an ordinary occurrence of the same
	 * series.
	 */
	readonly occurrenceKey: string | null;
	/** True for a meeting written as whole days rather than as times. */
	readonly allDay: boolean;
	/** For an all-day meeting, midnight at the start of its **first** day. */
	readonly start: Date;
	/**
	 * For a timed meeting, when it ends. For an all-day meeting, midnight at
	 * the start of its **last** day — the day it is on, never the morning
	 * after. A calendar states an all-day end as the day *after* the last one,
	 * and taking that at face value is what puts a Tuesday holiday on
	 * Wednesday's page as well.
	 */
	readonly end: Date;
}

/**
 * The local day, as `YYYY-MM-DD`, an occurrence of a repeating meeting was on
 * before any reschedule moved it, read from {@link Meeting.occurrenceKey};
 * `null` for a meeting that does not repeat. Building the days ahead asks it
 * to tell a moved occurrence's old row from a cancelled one's, and
 * asks here because the key's shape is this reader's own.
 */
export function originalDayOf(meeting: Meeting): string | null {
	return meeting.occurrenceKey === null ? null : occurrenceKeyDay(meeting.occurrenceKey);
}

/**
 * One calendar that lost events, named by its place in the list handed in.
 *
 * **Losing every event and losing one are the same kind of trouble here**, at
 * two sizes, so both arrive this way. A calendar that would not
 * read at all reports the reason it threw; a calendar that read some of its
 * events and dropped the rest reports how many it dropped. Either way the
 * person is told that meetings are missing from the day, which is the thing
 * they could not otherwise tell apart from a day with nothing on it.
 */
export interface CalendarFailure {
	readonly index: number;
	/** A whole sentence, ending in a full stop, ready to show as it is. */
	readonly reason: string;
	/**
	 * How much was lost, when events were lost at all. Absent for a calendar
	 * that would not read at all — there is no "some of it" about those bytes.
	 *
	 * The sentence cannot be told apart afterwards, and the settings row and the
	 * draw-failure console line both have to, so this rides beside
	 * it rather than being parsed back out of it.
	 */
	readonly loss?: LossGrade;
}

/** What several calendars say about one day, and which of them lost events. */
export interface DayReading {
	readonly meetings: readonly Meeting[];
	readonly failures: readonly CalendarFailure[];
}

/** One calendar's day, and what reading it lost saying so. */
export interface CalendarDay {
	readonly meetings: Meeting[];
	/** Null when the whole calendar read, which is the ordinary case. */
	readonly loss: IcsLoss | null;
}

/**
 * Every meeting in `ics` that touches the calendar day `day` falls on, earliest
 * first, with the all-day ones above the timed ones.
 *
 * Throws `IcsReadError` when the bytes are not a calendar. It does **not** throw
 * when the bytes are a calendar whose events will not read: those come back as
 * however many meetings survived, which may be none at all.
 *
 * **So an empty answer from here is not proof of a quiet day**, and a caller
 * that has somewhere to report a loss must call `readDayLosing` instead. This form is for a caller that only wants the day and has
 * nothing to say about what it cost — a day being written, not a row being
 * drawn. It used to carry a docstring promising a distinction it never made.
 */
export function readDay(ics: string, day: Date): Meeting[] {
	return readDayLosing(ics, day).meetings;
}

/**
 * The same read with what it lost kept, for a caller that can report it.
 *
 * `readDayFromAll` uses it to name the calendar that lost events, and the
 * fetch path uses it so that a calendar which loses events is stored as a
 * failed read rather than as a clean one.
 */
export function readDayLosing(ics: string, day: Date): CalendarDay {
	return readSpanLosing(ics, day, 1);
}

/**
 * {@link readDayLosing} over `days` calendar days starting at `from`'s own
 * day, read in one pass: what the core asks when it has to say whether a
 * meeting is anywhere ahead rather than on one day. A meeting on
 * more than one of those days comes back once.
 */
export function readSpanLosing(ics: string, from: Date, days: number): CalendarDay {
	const start = startOfDay(from);
	const to = new Date(start);
	// `setDate` rather than adding hours, so a clock change inside the span does not shift its end.
	to.setDate(to.getDate() + days);
	return meetingsBetween(ics, start, to);
}

function meetingsBetween(ics: string, from: Date, to: Date): CalendarDay {
	const { occurrences, loss } = readOccurrencesBetween(ics, from, to);
	const meetings = occurrences
		.map(meetingOf)
		.filter((meeting) => touches(meeting, from, to))
		.sort(byWhenTheyStart);
	return { meetings, loss };
}

/**
 * The same day across several calendars, merged into one list.
 *
 * One calendar that will not read never empties the day: its reason comes back
 * in `failures`, keyed by its place in `calendars`, so the settings screen can
 * mark that source failed while every other source still shows.
 *
 * **A calendar that reads but loses events is reported the same way**, with the
 * events it did read still in `meetings`. Before that, a calendar
 * whose every event was unreadable arrived here as no meetings and no failure —
 * the one thing this function exists to tell apart from a quiet day.
 *
 * **One throw is not a failure of the calendar it happened to**: the calendar
 * library breaking its own contract says nothing about these bytes, so it is
 * written to the console and no `CalendarFailure` is pushed for it.
 * Every calendar in the vault meets that break, and it is said once per call
 * rather than once per calendar. `isExpanderContractError` in
 * `src/core/icsOccurrences.ts` carries the reasoning, the trade-off against
 * issue #53, and why the class behind it stays private.
 *
 * **That branch cannot be reached today.** This function's only caller,
 * `CalendarSources.meetingsOn`, is handed stored copies only, and a copy is
 * stored after the read that would throw the break — so a broken library
 * never leaves a copy behind for `meetingsOn` to hand back here. It stays
 * because it is the correct answer for a caller fed bytes from somewhere
 * other than that stored copy, and deleting it would trade a real future
 * protection for a few lines.
 */
export function readDayFromAll(
	calendars: readonly string[],
	day: Date,
): DayReading {
	const meetings: Meeting[] = [];
	const failures: CalendarFailure[] = [];
	// One read, one line. A local rather than module-level, so it resets by
	// itself on the next call and no test has to reach in and clear it.
	let contractBreakSaid = false;
	calendars.forEach((ics, index) => {
		try {
			const reading = readDayLosing(ics, day);
			meetings.push(...reading.meetings);
			if (reading.loss !== null)
				failures.push({ index, ...reportLoss(reading.loss) });
		} catch (error) {
			if (isExpanderContractError(error)) {
				if (!contractBreakSaid) {
					contractBreakSaid = true;
					console.warn(`Effortless: ${reasonOf(error)}`);
				}
				return;
			}
			failures.push({ index, reason: reasonOf(error) });
		}
	});
	return { meetings: meetings.sort(byWhenTheyStart), failures };
}

/**
 * When `meeting` is over, in milliseconds since the epoch. An all-day
 * meeting's `end` is midnight at the start of its last day, so it is over at
 * the midnight after that day; a timed meeting is over at its `end`, or at its
 * start where the calendar gives an end before it. Meeting notes asks only
 * this, never `end` itself, which would end an all-day meeting a day early. Days ahead does not: it reads a row's written time instead.
 */
export function endsAtOf(meeting: Meeting): number {
	if (meeting.allDay) {
		const last = meeting.end;
		return new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).getTime();
	}
	return Math.max(meeting.start.getTime(), meeting.end.getTime());
}

function meetingOf(occurrence: Occurrence): Meeting {
	const allDay = occurrence.start.kind === "date";
	return {
		uid: occurrence.uid,
		summary: occurrence.summary,
		location: occurrence.location,
		description: occurrence.description,
		organizer: occurrence.organizer,
		attendees: occurrence.attendees,
		occurrenceKey: occurrence.occurrenceKey,
		allDay,
		start: instantOf(occurrence.start),
		end: allDay
			? lastDayOf(occurrence.start, occurrence.end)
			: instantOf(occurrence.end),
	};
}

/** A calendar date becomes midnight local, because the day is the person's. */
function instantOf(time: IcsTime): Date {
	if (time.kind === "time") return time.at;
	return new Date(time.year, time.month - 1, time.day);
}

/** Turns a calendar's exclusive all-day end into the last day it is actually on. */
function lastDayOf(start: IcsTime, end: IcsTime): Date {
	const first = instantOf(start);
	if (end.kind !== "date") return first;
	const last = instantOf(end);
	last.setDate(last.getDate() - 1);
	return last < first ? first : last;
}

function startOfDay(day: Date): Date {
	return new Date(day.getFullYear(), day.getMonth(), day.getDate());
}

function touches(meeting: Meeting, from: Date, to: Date): boolean {
	// An all-day meeting's end is the last day it is on, so the day it ends is
	// a day it touches — hence `>=` where the timed comparison uses `>`.
	if (meeting.allDay) return meeting.start < to && meeting.end >= from;
	// A meeting with no length at all still happens, so it counts on the day it
	// starts. Every other meeting has to overlap the day rather than abut it.
	if (meeting.end <= meeting.start)
		return meeting.start >= from && meeting.start < to;
	return meeting.start < to && meeting.end > from;
}

/**
 * All-day meetings first, then by when they start, then by name. A day's view
 * has to come out in the same order every time it is built, or the plugin
 * rewrites the calendar table for no reason.
 */
function byWhenTheyStart(a: Meeting, b: Meeting): number {
	if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
	const started = a.start.getTime() - b.start.getTime();
	if (started !== 0) return started;
	if (a.summary < b.summary) return -1;
	return a.summary > b.summary ? 1 : 0;
}
