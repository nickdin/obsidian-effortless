/**
 * The English date parser: a fixed phrase list consulted first, three rules
 * of its own ahead of it, and `chrono` behind it for everything else.
 *
 * **Why a list at all.** `chrono` does not suggest as you type — `t`, `tom`
 * and `nex` all parse to nothing, only finished words do. The list is
 * consulted first so a partial word already has an answer, the way the
 * Swedish parser's own list does. Matching is "the first phrase that starts
 * with the input", so the **order below is load-bearing**: `t` reaches
 * `today` before `tomorrow` reaches it, `next` reaches `next week` before
 * `next monday` does, and `next m` reaches `next monday` and never falls to
 * `chrono`, which reads a lone `m` as *minute* and answers today.
 *
 * **Three phrases get a rule of their own, because `chrono` answers them wrong**
 * (measured in #24 and #575): a bare weekday, which `chrono` reads as today
 * on the day itself; `next week`, which `chrono` reads as the same weekday
 * seven days out rather than the coming Monday; and `day after tomorrow`,
 * which `chrono` reads as tomorrow, discarding "day after". Each has its own
 * rule here instead.
 *
 * **`next <weekday>` is the one case list-matched but still handed to
 * `chrono`.** It keeps `chrono`'s own following-Monday-to-Sunday-week
 * convention, so the date comes from `chrono` — but from the
 * *resolved* phrase (`"next monday"`), never the raw input (`"next m"`),
 * which is what keeps the "minute"/"second" misreading out of the answer.
 *
 * **Only the English locale is imported, by path**, so the other eleven
 * `chrono` locales stay out of the built plugin.
 */

import * as chronoEnglish from "chrono-node/en";

/**
 * The candidate list, in the order an input is matched against it.
 *
 * Twenty phrases in the spec's own prose; the list itself, read
 * literally, holds nineteen — five standalone phrases, the seven weekdays and
 * the seven `next <weekday>`s. Built to the list as enumerated, not to the
 * rounded count.
 */
export const ENGLISH_PHRASES = [
	"today",
	"tomorrow",
	"day after tomorrow",
	"yesterday",
	"next week",
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
	"saturday",
	"sunday",
	"next monday",
	"next tuesday",
	"next wednesday",
	"next thursday",
	"next friday",
	"next saturday",
	"next sunday",
] as const;

/** A bare weekday's index into `Date#getDay()` — Sunday is 0. */
const WEEKDAY_INDEX: Record<string, number> = {
	sunday: 0,
	monday: 1,
	tuesday: 2,
	wednesday: 3,
	thursday: 4,
	friday: 5,
	saturday: 6,
};

/** `date`, with any time-of-day component dropped, in local parts. */
function localMidnight(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** `date` shifted by `days`, in local parts — negative goes backward. */
function addDays(date: Date, days: number): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * The nearest date after `today` that falls on `weekday` — **never `today`
 * itself**, even when `today` is already that weekday (the bare-weekday
 * rule, and `next week`'s Monday).
 */
function nearestUpcomingWeekday(weekday: number, today: Date): Date {
	const daysAhead = (weekday - today.getDay() + 7) % 7 || 7;
	return addDays(today, daysAhead);
}

/** `chrono`'s answer for `phrase`, normalised to local midnight, or `null` when it answers nothing. */
function chronoDate(phrase: string, today: Date): Date | null {
	const answer = chronoEnglish.parseDate(phrase, today, { forwardDate: true });
	return answer === null ? null : localMidnight(answer);
}

/**
 * The date a matched candidate answers to.
 *
 * The four fixed phrases and `next week` are handled
 * directly; a bare weekday falls to `nearestUpcomingWeekday`; anything left
 * is one of the seven `next <weekday>` phrases, which is `chrono`'s to
 * answer. `chrono` returning nothing for one of those seven would be a
 * genuine defect in either the list or `chrono` itself — not a case this
 * function can silently pass upward as "no date".
 */
function dateForCandidate(candidate: string, today: Date): Date {
	switch (candidate) {
		case "today":
			return localMidnight(today);
		case "tomorrow":
			return addDays(today, 1);
		case "day after tomorrow":
			return addDays(today, 2);
		case "yesterday":
			return addDays(today, -1);
		case "next week":
			return nearestUpcomingWeekday(WEEKDAY_INDEX.monday, today);
	}

	const bareWeekday = WEEKDAY_INDEX[candidate];
	if (bareWeekday !== undefined) return nearestUpcomingWeekday(bareWeekday, today);

	const chronoAnswer = chronoDate(candidate, today);
	if (chronoAnswer === null) {
		throw new Error(
			`chrono answered nothing for "${candidate}", which the candidate list guarantees a date for.`,
		);
	}
	return chronoAnswer;
}

/**
 * The English date an input answers to, or `null` when nothing — the list
 * and `chrono` alike — parses it.
 *
 * `today` is a local-midnight `Date` the caller pins; every date this
 * function answers is local midnight too. `phrase` is the full phrase the
 * date came from: the matched candidate where the list answered, or the
 * trimmed, lower-cased input where `chrono` did.
 */
export function parseEnglish(input: string, today: Date): { date: Date; phrase: string } | null {
	const normalized = input.trim().toLowerCase();
	const candidate =
		normalized.length > 0
			? ENGLISH_PHRASES.find((phrase) => phrase.startsWith(normalized))
			: undefined;

	if (candidate !== undefined) {
		return { date: dateForCandidate(candidate, today), phrase: candidate };
	}

	const date = chronoDate(normalized, today);
	return date === null ? null : { date, phrase: normalized };
}
