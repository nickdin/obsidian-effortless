/**
 * The repeat rule: reading it, writing it, and counting dates from it.
 *
 * A repeat rule is the text after `🔁` on a task line, in the Tasks plugin's own
 * English wording (`every week`, `every month on the 1st`, `every 3 days when
 * done`). This module does three things with it and nothing else:
 *
 * - **Read** the text into a {@link RepeatRule}, or refuse it with `null`.
 * - **Write** a rule as its canonical text.
 * - **Count** dates: the next date of a round, and the first date of a line that
 *   has none yet.
 *
 * **Only canonical text is read.** The Tasks plugin accepts far more than it
 * writes — `every Monday`, `every week on Mon`, `on the 31` — and rewrites each
 * to its own wording (`docs/research/tasks-plugin-recurrence.md` § 1, on the
 * branch `research/tasks-recurrence-grammar`). This module reads exactly what
 * that plugin writes back unchanged and refuses everything else, so a string it
 * writes reads back byte-for-byte identical here and through the Tasks plugin
 * alike, and a form it would have to guess at is never guessed at. Words are
 * matched ignoring case; the shape is exact. Every refusal is the same `null`:
 * the caller reports the rule, quoting its text.
 *
 * **Today is an argument.** Nothing here reads the clock, so every caller and
 * every test names the day it counts from. Dates in and out are `YYYY-MM-DD`
 * text, the shape `TaskLine.scheduled` carries. This module does not import the
 * task-line reader: the reader carries the rule as text and this module reads
 * it.
 *
 * This is plain shared code. It touches no vault, no app and no settings
 * storage, and uses no lookbehind (held to by `afterTheFloor` in
 * `src/__tests__/platform.test.ts`).
 */

/** What a rule counts in. */
export type RepeatUnit = "day" | "week" | "month" | "year";

/** A day of the month a rule names: 1 to 31, or the month's last day. */
export type MonthDay = number | "last";

/** The weekday names, Monday first — an index into this is a weekday's number. */
export const WEEKDAY_NAMES: readonly string[] = [
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
	"Sunday",
];

/**
 * A repeat rule, as the subset reads it.
 *
 * `interval` is 1 to {@link MAX_INTERVAL}. `weekdays` is set only on a week
 * rule, `monthDays` only on a month rule; each is strictly ascending, Monday
 * first (0 is Monday) and 1 to 31 with `"last"` standing alone. `every weekday`
 * is a week rule of interval 1 whose `weekdays` are Monday to Friday.
 */
export interface RepeatRule {
	readonly unit: RepeatUnit;
	readonly interval: number;
	readonly weekdays: readonly number[] | null;
	readonly monthDays: readonly MonthDay[] | null;
	readonly whenDone: boolean;
}

/**
 * The largest interval read. A bound, not a rule of the Tasks plugin: it keeps
 * every date this module counts inside the years it can write (1000 to 9999),
 * and no rhythm a person types comes near it.
 */
export const MAX_INTERVAL = 999;

const WHEN_DONE = " when done";
const MONDAY_TO_FRIDAY: readonly number[] = [0, 1, 2, 3, 4];

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

// No `u` flag on purpose: without it `/i` folds ASCII only, so U+212A (the
// Kelvin sign) cannot stand in for a `k` in `weeks`.
const SHAPE = /^every (?:(\d+) )?(day|week|month|year)(s)?(?: on (.+))?$/i;
const WEEKDAY_RULE = /^every weekday$/i;
const ORDINAL = /^([1-9]|[12][0-9]|3[01])(st|nd|rd|th)$/i;

/** The suffix the Tasks plugin writes after a day of the month. */
function ordinalSuffix(day: number): string {
	if (day === 1 || day === 21 || day === 31) return "st";
	if (day === 2 || day === 22) return "nd";
	if (day === 3 || day === 23) return "rd";
	return "th";
}

function isStrictlyAscending(values: readonly number[]): boolean {
	return values.every((value, index) => index === 0 || value > values[index - 1]);
}

function readWeekdays(list: string): readonly number[] | null {
	const lowered = WEEKDAY_NAMES.map((name) => name.toLowerCase());
	const days: number[] = [];
	for (const word of list.split(", ")) {
		const day = lowered.indexOf(word.toLowerCase());
		if (day === -1) return null;
		days.push(day);
	}
	if (!isStrictlyAscending(days)) return null;
	// The Tasks plugin writes Monday to Friday as `weekday(s)` and all seven as
	// `day`, so a list of either is not a fixed point there.
	if (days.length === 7) return null;
	if (days.length === 5 && days.every((day, index) => day === MONDAY_TO_FRIDAY[index])) return null;
	return days;
}

function readMonthDays(list: string): readonly MonthDay[] | null {
	if (!/^the /i.test(list)) return null;
	const days = list.slice("the ".length);
	if (/^last$/i.test(days)) return ["last"];
	const numbers: number[] = [];
	for (const word of days.split(" and ")) {
		const match = ORDINAL.exec(word);
		if (match === null) return null;
		const day = Number(match[1]);
		if (match[2].toLowerCase() !== ordinalSuffix(day)) return null;
		numbers.push(day);
	}
	if (numbers.length > 2 || !isStrictlyAscending(numbers)) return null;
	return numbers;
}

/**
 * Reads the text after `🔁` into a rule, or `null` when it is not in the
 * subset. The text is read whole: a trailing space, a second space, a weekday
 * abbreviation, `and` between weekdays, `every 1 week`, a bare number after
 * `on the` and a weekday list out of Monday-first order are all refused.
 */
export function readRepeatRule(text: string): RepeatRule | null {
	let body = text;
	let whenDone = false;
	if (body.length > WHEN_DONE.length && body.slice(-WHEN_DONE.length).toLowerCase() === WHEN_DONE) {
		whenDone = true;
		body = body.slice(0, -WHEN_DONE.length);
	}

	if (WEEKDAY_RULE.test(body)) {
		return { unit: "week", interval: 1, weekdays: MONDAY_TO_FRIDAY, monthDays: null, whenDone };
	}

	const match = SHAPE.exec(body);
	if (match === null) return null;
	const [, count, unitWord, plural, tail] = match;
	// `every 3 days` and `every day`: a count goes with the plural and only with it.
	if ((count !== undefined) !== (plural !== undefined)) return null;
	let interval = 1;
	if (count !== undefined) {
		if (!/^[1-9][0-9]{0,2}$/.test(count)) return null;
		interval = Number(count);
		if (interval < 2 || interval > MAX_INTERVAL) return null;
	}
	const unit = unitWord.toLowerCase() as RepeatUnit;

	if (tail === undefined) return { unit, interval, weekdays: null, monthDays: null, whenDone };
	if (unit === "week") {
		const weekdays = readWeekdays(tail);
		return weekdays === null ? null : { unit, interval, weekdays, monthDays: null, whenDone };
	}
	if (unit === "month") {
		const monthDays = readMonthDays(tail);
		return monthDays === null ? null : { unit, interval, weekdays: null, monthDays, whenDone };
	}
	return null;
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The canonical text of a rule: the wording the Tasks plugin writes, which
 * {@link readRepeatRule} reads back to an equal rule.
 *
 * @throws RangeError for a rule the subset cannot say — an interval out of
 * range, weekdays on a month rule, a list out of order. A rule that came from
 * {@link readRepeatRule} never throws; one built by hand and wrong is a
 * programming error, not a vault problem.
 */
export function writeRepeatRule(rule: RepeatRule): string {
	const plural = rule.interval === 1 ? "" : "s";
	const count = rule.interval === 1 ? "" : `${rule.interval} `;
	let text = `every ${count}${rule.unit}${plural}`;
	if (rule.weekdays !== null) {
		const isMondayToFriday =
			rule.interval === 1 &&
			rule.weekdays.length === 5 &&
			rule.weekdays.every((day, index) => day === MONDAY_TO_FRIDAY[index]);
		text = isMondayToFriday
			? "every weekday"
			: `${text} on ${rule.weekdays.map((day) => WEEKDAY_NAMES[day]).join(", ")}`;
	} else if (rule.monthDays !== null) {
		const days = rule.monthDays.map((day) => (day === "last" ? "last" : `${day}${ordinalSuffix(day)}`));
		text = `${text} on the ${days.join(" and ")}`;
	}
	if (rule.whenDone) text += WHEN_DONE;
	if (readRepeatRule(text) === null) throw new RangeError(`Not a repeat rule the plugin can write: ${JSON.stringify(rule)}`);
	return text;
}

/* -------------------------------------------------------------------------- */
/* Counting                                                                    */
/* -------------------------------------------------------------------------- */

const MS_PER_DAY = 86_400_000;
const FIRST_YEAR = 1000;
const LAST_YEAR = 9999;

/** Whole days since 1970-01-01 for a real calendar day written `YYYY-MM-DD`, else `null`. */
function dayNumber(date: string): number | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (match === null) return null;
	const year = Number(match[1]);
	const month = Number(match[2]) - 1;
	const day = Number(match[3]);
	if (year < FIRST_YEAR) return null;
	const ms = Date.UTC(year, month, day);
	const back = new Date(ms);
	if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month || back.getUTCDate() !== day) {
		return null;
	}
	return ms / MS_PER_DAY;
}

/** The `YYYY-MM-DD` text of a day number, or `null` outside the years this module writes. */
function dateText(day: number): string | null {
	const moment = new Date(day * MS_PER_DAY);
	const year = moment.getUTCFullYear();
	if (year < FIRST_YEAR || year > LAST_YEAR) return null;
	return moment.toISOString().slice(0, 10);
}

/**
 * The `YYYY-MM-DD` day `days` away from `date`, or `null` when `date` is not a
 * real day or either end falls outside the years this module reads and writes
 * (1000–9999).
 *
 * Exported so a feature that moves a date by whole days reads and writes it
 * the way the repeat rule does, rather than with a calendar of its own: the
 * collection round once kept one that read a year below 1000 this module
 * refuses.
 */
export function shiftDate(date: string, days: number): string | null {
	const day = dayNumber(date);
	return day === null ? null : dateText(day + days);
}

/**
 * Whole days from `from` to `to`, negative when `to` is earlier, or `null` when
 * either is not a day {@link shiftDate} would read.
 */
export function daysBetween(from: string, to: string): number | null {
	const start = dayNumber(from);
	const end = dayNumber(to);
	return start === null || end === null ? null : end - start;
}

/** 0 for Monday … 6 for Sunday. 1970-01-01 was a Thursday. */
function weekdayOf(day: number): number {
	return (((day + 3) % 7) + 7) % 7;
}

/** A month as year × 12 + month (0 is January), so months are added as plain numbers. */
function monthIndexOf(day: number): number {
	const moment = new Date(day * MS_PER_DAY);
	return moment.getUTCFullYear() * 12 + moment.getUTCMonth();
}

function daysInMonth(monthIndex: number): number {
	return new Date(Date.UTC(Math.floor(monthIndex / 12), (monthIndex % 12) + 1, 0)).getUTCDate();
}

function dayInMonth(monthIndex: number, dayOfMonth: number): number {
	return Date.UTC(Math.floor(monthIndex / 12), monthIndex % 12, dayOfMonth) / MS_PER_DAY;
}

/** How far a search for a named day goes before it gives up: a rule like `every 12 months on the 30th` from February never lands. */
const MONTHS_SEARCHED = 1200;

/**
 * The first date, as a day number, in the rhythm of `rule` counted from
 * `anchor` that falls strictly after `after`. The anchor itself is the first
 * date of an interval rule, and the anchor's own week or month is where a rule
 * naming weekdays or days of the month starts looking. `null` when the rule
 * never lands.
 */
function firstAfter(rule: RepeatRule, anchor: number, after: number): number | null {
	// An empty list names no day, so the rule never lands (and the loop below would never end).
	if (rule.weekdays?.length === 0 || rule.monthDays?.length === 0) return null;

	if (rule.weekdays !== null) {
		const monday = anchor - weekdayOf(anchor);
		const weeksOn = Math.floor((after - monday) / 7);
		for (let round = Math.max(0, Math.floor(weeksOn / rule.interval)); ; round += 1) {
			for (const weekday of rule.weekdays) {
				const candidate = monday + 7 * rule.interval * round + weekday;
				if (candidate > after) return candidate;
			}
		}
	}

	if (rule.unit === "day" || rule.unit === "week") {
		const step = rule.interval * (rule.unit === "day" ? 1 : 7);
		const rounds = after < anchor ? 0 : Math.floor((after - anchor) / step) + 1;
		return anchor + rounds * step;
	}

	const anchorMonth = monthIndexOf(anchor);
	const monthsOn = monthIndexOf(after) - anchorMonth;

	if (rule.monthDays !== null) {
		const first = Math.max(0, Math.floor(monthsOn / rule.interval));
		for (let round = first; round < first + MONTHS_SEARCHED; round += 1) {
			const month = anchorMonth + round * rule.interval;
			const length = daysInMonth(month);
			for (const monthDay of rule.monthDays) {
				const dayOfMonth = monthDay === "last" ? length : monthDay;
				// A month that lacks the named day is skipped, as the Tasks plugin does.
				if (dayOfMonth > length) continue;
				const candidate = dayInMonth(month, dayOfMonth);
				if (candidate > after) return candidate;
			}
		}
		return null;
	}

	// A plain month or year rule keeps the anchor's day of the month, or the
	// target month's last day when it lacks that day.
	const anchorDay = new Date(anchor * MS_PER_DAY).getUTCDate();
	const stepMonths = rule.interval * (rule.unit === "month" ? 1 : 12);
	for (let round = Math.max(0, Math.floor(monthsOn / stepMonths)); ; round += 1) {
		const month = anchorMonth + round * stepMonths;
		const candidate = dayInMonth(month, Math.min(anchorDay, daysInMonth(month)));
		if (candidate > after) return candidate;
	}
}

function requireDay(date: string, what: string): number {
	const day = dayNumber(date);
	if (day === null) throw new RangeError(`${what} is not a real day written YYYY-MM-DD: ${JSON.stringify(date)}`);
	return day;
}

/**
 * The date of the round after the one dated `ownDate`, ticked on `today`:
 *
 * - **A fixed rule** gives the first date the rule gives strictly after
 *   `ownDate` that is not before `today`. One date, never a catch-up pile and
 *   never in the past; when `ownDate` is today, the first after today. The
 *   rhythm is counted from `ownDate`: a plain `every month` from the 31st
 *   keeps that day, or the month's last day where the month lacks it, and
 *   `every N weeks on …` counts weeks from `ownDate`'s week, weeks starting
 *   Monday.
 * - **A `when done` rule** gives the first date strictly after `today`, counted
 *   from `today`; `ownDate` is not consulted.
 *
 * `null` when no date can be counted: `ownDate` is absent or not a real day
 * (a fixed rule only), the rule never lands (`every 12 months on the 30th`
 * from February), or the date would pass year 9999.
 *
 * @throws RangeError when `today` is not a real day written `YYYY-MM-DD`.
 */
export function nextRepeatDate(rule: RepeatRule, ownDate: string | null, today: string): string | null {
	const todayDay = requireDay(today, "today");
	let found: number | null;
	if (rule.whenDone) {
		found = firstAfter(rule, todayDay, todayDay);
	} else {
		const own = ownDate === null ? null : dayNumber(ownDate);
		if (own === null) return null;
		found = firstAfter(rule, own, Math.max(own, todayDay - 1));
	}
	return found === null ? null : dateText(found);
}

/**
 * The first date for a line that has none yet, entered on `today`: the first
 * date the rule gives that is not before `today`. That is `today` itself for
 * an interval rule and for any `when done` rule, the next matching weekday
 * (today included) for `every week on Monday`, the next named day of the month
 * (today included) for `every month on the 1st`.
 *
 * `null` when the rule never lands, as {@link nextRepeatDate}.
 *
 * @throws RangeError when `today` is not a real day written `YYYY-MM-DD`.
 */
export function firstRepeatDate(rule: RepeatRule, today: string): string | null {
	const todayDay = requireDay(today, "today");
	if (rule.whenDone) return today;
	// The first day not before today that the rule names, whatever the interval:
	// the interval spaces the rounds after the first, so it is set aside here.
	// A rule naming no day has no rhythm to anchor and keeps today.
	const named = rule.weekdays !== null || rule.monthDays !== null;
	const found = firstAfter(named ? { ...rule, interval: 1 } : rule, todayDay, todayDay - 1);
	return found === null ? null : dateText(found);
}
