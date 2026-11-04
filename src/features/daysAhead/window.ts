/**
 * The days one run is responsible for: today, then the next `days - 1`,
 * oldest first (spec #687
 * decision 2, carried from
 * `~/Devbox/calendar-scaffold/src/daily-log.ts:61-103`'s `windowDates`).
 *
 * **A day before today is never in this list**, and the rule holds by
 * construction rather than by a check somewhere later: the list always starts
 * at `today` itself and only ever adds days after it (issue #698, spec #687 §
 * Out of Scope, item 7).
 *
 * Built from `today`'s local year, month and day, never from its clock time or
 * from `toISOString`, so a window crossing a month end or a daylight-saving
 * change still lands on the calendar dates a person would name — the same
 * local-parts rule `desiredRows.ts`'s `localDateKey` follows for the same
 * reason (`Europe/Stockholm`, where a local midnight through `toISOString`
 * reads as the day before).
 */

/**
 * `days` local-midnight dates starting at `today`'s own local date, oldest
 * first. `Date`'s constructor normalises a day-of-month past the end of its
 * month on its own, which is what carries the window correctly over a month
 * end and over a daylight-saving change without this function knowing either
 * happened.
 */
export function windowDates(today: Date, days: number): Date[] {
	const year = today.getFullYear();
	const month = today.getMonth();
	const day = today.getDate();
	return Array.from({ length: days }, (_unused, offset) => new Date(year, month, day + offset));
}
