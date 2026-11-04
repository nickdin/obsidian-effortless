/**
 * What one run's reading of the calendar lets building the days ahead remove: the core's per-source answer ({@link CalendarPresence.bySource})
 * turned into the questions `mergeMeetings` and the run's report ask of it.
 *
 * Before #1211 the answer was one yes or no for the whole window, so one
 * calendar link that answered 404 stopped every removal on every day, though
 * the calendar that actually held the moved meeting read whole. A row now
 * belongs to the source its meeting came from, and only that source's own
 * whole reading may remove it. A row remembered without a source keeps the
 * old rule: removed only on a run where every source read whole.
 *
 * This module decides nothing about rows — whether the plugin wrote one, or
 * whether its meeting is still on the day, is the merge's. It only says what
 * the reading can vouch for.
 */

import type { CalendarPresence, SourcePresence } from "../../core/calendarSources";
import { originalDayOf } from "../../core/icsReader";
import type { Meeting } from "../../core/icsReader";

export interface RemovalReading {
	/**
	 * The one source holding a meeting with `uid` over the window, or
	 * `undefined` when none does or more than one does — a meeting two
	 * calendars both hold is not one calendar's to remove.
	 */
	sourceOf(uid: string): string | undefined;
	/**
	 * Whether a row remembered under `source` may be removed on this
	 * reading's word; absent, every source switched on for the day must have
	 * read whole.
	 */
	mayRemove(source: string | undefined): boolean;
	/**
	 * Whether `source`'s own whole reading shows the meeting `uid` moved away
	 * from `date` to another day of the window — the one case an ended row is
	 * removed. See {@link movedAwayFrom}.
	 */
	movedAway(source: string | undefined, uid: string, date: string): boolean;
	/** The sources switched on for the day that did not read whole, in the person's order. */
	readonly failing: readonly SourcePresence[];
}

/**
 * The reading `presence` can vouch for. An answer without `bySource` — a test
 * double written before #1211 — attributes nothing to any one source, so
 * every row falls under `whole` alone, the rule it was written for.
 */
export function removalReadingFrom(presence: CalendarPresence): RemovalReading {
	const parts = presence.bySource ?? [];
	const whole = new Map(parts.map((part) => [part.id, part.whole]));
	const holders = new Map<string, Set<string>>();
	for (const part of parts) {
		for (const meeting of part.meetings) {
			const forUid = holders.get(meeting.uid) ?? new Set<string>();
			forUid.add(part.id);
			holders.set(meeting.uid, forUid);
		}
	}
	const meetingsOf = new Map(parts.map((part) => [part.id, part.meetings]));

	const mayRemove = (source: string | undefined): boolean =>
		source === undefined ? presence.whole : whole.get(source) === true;

	return {
		sourceOf(uid) {
			const forUid = holders.get(uid);
			if (forUid === undefined || forUid.size !== 1) return undefined;
			return [...forUid][0];
		},
		mayRemove,
		movedAway(source, uid, date) {
			if (source === undefined || whole.get(source) !== true) return false;
			return movedAwayFrom(meetingsOf.get(source) ?? [], uid, date);
		},
		failing: parts.filter((part) => !part.whole),
	};
}

/**
 * A reading of only a yes or no for the whole window — what the merge's
 * callers passed before #1211, and still may.
 */
export function wholeOnly(whole: boolean): RemovalReading {
	return removalReadingFrom({ whole, meetings: [] });
}

/**
 * Whether `meetings`, one source's whole reading over the window, show the
 * meeting `uid` on a day other than `date` *as the same meeting moved*.
 *
 * The caller has already found `uid` absent from `date`, so any meeting with
 * that uid in the reading lies on another day. For a meeting that does not
 * repeat that is the move. A repeating meeting's occurrences all share the
 * uid, so another occurrence in the window is not a move of this one: it
 * counts only when the core says that occurrence was originally on `date`
 * ({@link originalDayOf}). A cancelled occurrence of a daily series is a
 * cancellation, and its ended row stays.
 */
function movedAwayFrom(meetings: readonly Meeting[], uid: string, date: string): boolean {
	return meetings.some((meeting) => meeting.uid === uid && (meeting.occurrenceKey === null || originalDayOf(meeting) === date));
}
