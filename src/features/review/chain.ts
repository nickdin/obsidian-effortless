/**
 * The chain, as a pure rule: the vault's notes in, a mark for every day of a
 * month and each of the two routines out, and the current run of kept days per
 * routine. Nothing here reads the vault, Obsidian's metadata or the clock — the
 * caller hands in each note's path, frontmatter and text, the layout, a link
 * resolver, the month and today's date, so every case is a literal in a test. It is
 * the twin of the waiting-notes reader and takes its note shape, its link
 * resolver and its rule for which day a note belongs to from there.
 *
 * ## The answer
 *
 * {@link chain} returns `{ days, runs }`.
 *
 * - `days` holds every day of the month in order — 28 to 31 entries — and each
 *   is `{ date, diary, review }`: `date` a local-time date at midnight, `diary`
 *   and `review` the day's mark for that routine.
 * - `runs` is `{ diary, review }`: the current run of kept days for each
 *   routine, a whole number. It is counted from today, whichever month is
 *   shown, over every note handed in, so it reaches back through
 *   earlier months when those months' notes are handed in. The days after
 *   today are *none* and are stepped over.
 *
 * A mark is one of:
 *
 * - `kept`: the routine was done in time (or marked by hand).
 * - `missed`: the time to do it has passed and it was not.
 * - `pending`: it can still be done in time.
 * - `none`: the routine does not apply to the day — no day's log, a day after
 *   today, or (diary) no diary heading in the log.
 *
 * ## The rules
 *
 * **Diary**, per day. *none* with no day's log, a log without the diary heading
 * at its level (the core's `sectionRange`; a blank heading setting finds
 * nothing), or a day after today. Otherwise the diary-date field decides: a
 * date written `YYYY-MM-DD` is *kept* when it is the day's own and *missed*
 * when it is another day, once the day has passed (a diary written in hindsight
 * is dated the day it was written); an empty or absent field is *pending* on
 * today and *missed* on a past day; a value that is not a date (`true`, a word)
 * is *kept*, because the chain cannot say when and a hand-marked day is not a
 * miss. On today a date that is not today's cannot be told from a mistake that
 * may still be mended, so it is *pending*.
 *
 * **Review**, per day. The day's notes are its day's log and every note whose
 * day-link field resolves to it — {@link dayOf}, the waiting-notes reader's own
 * rule — outside the excluded folders, and of those only the ones that take part
 * as the list's reader says ({@link takesPartInReview}: the note holds the
 * processed field at all); a note without it is stepped over, as the list never
 * shows it. *none* with no day's log, a day after today, or a day none of whose
 * notes takes part. The day after is the calendar day following the routine's
 * day; it has passed once today is later than it. A note's processed field is
 * *unprocessed* when empty, a *date* when written `YYYY-MM-DD`, and *processed*
 * when it holds anything else. The day is *missed* when a note holds a date
 * later than the day after, or is still unprocessed once the day after has
 * passed; *pending* when a note is unprocessed and the day after has not
 * passed; *kept* otherwise.
 *
 * **The run**: counted backward from the most recent decided day (*kept* or
 * *missed*), over kept days; a *pending* or *none* day is stepped over and a
 * *missed* day ends it.
 *
 * ## What was driven
 *
 * A field written `2026-10-12` is read as text. That Obsidian's metadata cache
 * hands a bare `YYYY-MM-DD` over as a string was driven in Obsidian 1.14.4
 * (`docs/acceptance-shots/issue-1149-cache-date-drive.txt`), so a date is accepted as text only, and a
 * value of any other type — a number, a list, a date object — is *a value that
 * is not a date*. A date with a time after it (`2026-10-12T09:30`) is read by
 * its date.
 */

import { isExcluded } from "../../core/collections";
import { frontmatterEnd } from "../../core/markdownSections";
import type { VaultLayout } from "../../core/settings";
import { parseDailyLogDate, sectionRange } from "../../core/vaultLayout";
import { isEmptyPropertyValue } from "./markProcessed";
import { dayOf, takesPartInReview } from "./waitingNotes";
import type { ResolveLink, ReviewNote } from "./waitingNotes";

/** What one routine says of one day. */
export type ChainMark = "kept" | "missed" | "pending" | "none";

/** One day of the month, with both routines' marks. */
export interface ChainDay {
	/** The day, a local-time date at midnight. */
	readonly date: Date;
	readonly diary: ChainMark;
	readonly review: ChainMark;
}

/** A month: its year and its number from 1 (January) to 12 (December). */
export interface ChainMonth {
	readonly year: number;
	readonly month: number;
}

/** The answer: every day of the month in order, and the current run per routine. */
export interface Chain {
	readonly days: readonly ChainDay[];
	readonly runs: { readonly diary: number; readonly review: number };
}

/** What the notes say of one day: its log, and every note that belongs to it. */
interface ChainDayNotes {
	readonly log: ReviewNote;
	readonly notes: ReviewNote[];
}

/** A date field as read: nothing in it, a calendar day (its number), or something else. */
type ChainFieldReading = { readonly kind: "empty" } | { readonly kind: "date"; readonly day: number } | { readonly kind: "other" };

/**
 * The chain for `month`, read from `notes` on `today` (a local-time date at
 * midnight, as the waiting-notes reader takes it).
 *
 * Throws a `RangeError` when `month.month` is not a whole number from 1 to 12.
 */
export function chain(
	notes: readonly ReviewNote[],
	layout: VaultLayout,
	resolveLink: ResolveLink,
	month: ChainMonth,
	today: Date,
): Chain {
	if (!Number.isInteger(month.month) || month.month < 1 || month.month > 12) {
		throw new RangeError(`The month must be a whole number from 1 to 12, not ${String(month.month)}.`);
	}
	const todayNumber = chainDayNumber(today);
	const byDay = chainIndex(notes, layout, resolveLink);
	const marksOf = (date: Date): { diary: ChainMark; review: ChainMark } => {
		const number = chainDayNumber(date);
		if (number > todayNumber) return { diary: "none", review: "none" };
		const found = byDay.get(number);
		if (found === undefined) return { diary: "none", review: "none" };
		return {
			diary: chainDiaryMark(found.log, number, todayNumber, layout),
			review: chainReviewMark(found.notes, number, todayNumber, layout),
		};
	};

	const days: ChainDay[] = [];
	const length = new Date(month.year, month.month, 0).getDate();
	for (let dayOfMonth = 1; dayOfMonth <= length; dayOfMonth += 1) {
		const date = new Date(month.year, month.month - 1, dayOfMonth);
		days.push({ date, ...marksOf(date) });
	}

	// The run is a fact about today, not about the month on screen: it
	// walks back from today to the earliest day any note is a log for, whichever
	// month `days` holds, so it crosses month boundaries when those notes are in.
	const earliest = Math.min(...byDay.keys(), todayNumber);
	const runs = { diary: 0, review: 0 };
	let diaryOpen = true;
	let reviewOpen = true;
	for (let offset = 0; todayNumber - offset >= earliest && (diaryOpen || reviewOpen); offset += 1) {
		const marks = marksOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset));
		if (diaryOpen) {
			if (marks.diary === "kept") runs.diary += 1;
			else if (marks.diary === "missed") diaryOpen = false;
		}
		if (reviewOpen) {
			if (marks.review === "kept") runs.review += 1;
			else if (marks.review === "missed") reviewOpen = false;
		}
	}
	return { days, runs };
}

/**
 * Sorts the notes outside the excluded folders under the day each belongs to,
 * keyed by the day number. A day appears only when a day's log exists for it:
 * a note linking to a day that has no log takes part in nothing.
 */
function chainIndex(
	notes: readonly ReviewNote[],
	layout: VaultLayout,
	resolveLink: ResolveLink,
): Map<number, ChainDayNotes> {
	const logs = new Map<number, ReviewNote>();
	const included = notes.filter((note) => !isExcluded(note.path, layout.excludedFolders));
	for (const note of included) {
		const own = parseDailyLogDate(note.path, layout);
		if (own === null) continue;
		const number = chainDayNumber(own);
		if (!logs.has(number)) logs.set(number, note);
	}

	const byDay = new Map<number, ChainDayNotes>();
	for (const [number, log] of logs) byDay.set(number, { log, notes: [] });
	for (const note of included) {
		const day = dayOf(note, layout, resolveLink);
		if (day === null) continue;
		byDay.get(chainDayNumber(day))?.notes.push(note);
	}
	return byDay;
}

/**
 * `text` below its frontmatter, so a `# Diary` comment line inside the property
 * block is not taken for the heading;
 * the core's `frontmatterEnd` says where the block ends, as the diary-date write
 * and the diary-empty reader read it.
 */
function belowFrontmatter(text: string): string {
	const lines = text.split("\n");
	// A byte-order mark in front of the opening rule is not part of the rule.
	lines[0] = lines[0].replace("\uFEFF", "");
	return lines.slice(frontmatterEnd(lines) + 1).join("\n");
}

/** The diary's mark for the day numbered `day`, whose log is `log`; today is `today`. */
function chainDiaryMark(log: ReviewNote, day: number, today: number, layout: VaultLayout): ChainMark {
	if (sectionRange(belowFrontmatter(log.text), "diaryHeading", layout) === null) return "none";
	const reading = chainReadField(log.frontmatter, layout.diaryDateField);
	if (reading.kind === "other") return "kept";
	if (reading.kind === "date" && reading.day === day) return "kept";
	return day < today ? "missed" : "pending";
}

/**
 * Whether the diary of `log`, the log of the day `date`, is *missed* on `today`:
 * the one mark that ends the diary run, so a reader walking back through the
 * logs newest first knows where to stop reading. `log` carries its text.
 */
export function chainDiaryMissed(log: ReviewNote, date: Date, today: Date, layout: VaultLayout): boolean {
	return chainDiaryMark(log, chainDayNumber(date), chainDayNumber(today), layout) === "missed";
}

/** The review's mark for the day numbered `day`, whose notes (the log among them) are `notes`. */
function chainReviewMark(notes: readonly ReviewNote[], day: number, today: number, layout: VaultLayout): ChainMark {
	const dayAfter = day + 1;
	// A note without the processed field is one Review's list never shows and
	// cannot mark, so it is stepped over like a missing note; a day none of whose
	// notes takes part has no review to keep or miss.
	const taking = notes.filter((note) => takesPartInReview(note.frontmatter, layout.processedField));
	if (taking.length === 0) return "none";
	const readings = taking.map((note) => chainReadField(note.frontmatter, layout.processedField));
	if (readings.some((reading) => reading.kind === "date" && reading.day > dayAfter)) return "missed";
	if (readings.some((reading) => reading.kind === "empty")) return today > dayAfter ? "missed" : "pending";
	return "kept";
}

/**
 * What `field` holds in `frontmatter`: nothing (absent, `null`, a blank string or
 * an empty list), a calendar day written `YYYY-MM-DD`, or something else.
 */
function chainReadField(frontmatter: ReviewNote["frontmatter"], field: string): ChainFieldReading {
	const value: unknown = frontmatter === null ? undefined : frontmatter[field];
	// Whether a property is empty is the one answer the waiting-notes reader and the writes use too.
	if (isEmptyPropertyValue(value)) return { kind: "empty" };
	if (typeof value !== "string") return { kind: "other" };
	const text = value.trim();
	const found = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(text);
	if (found === null) return { kind: "other" };
	const [year, month, dayOfMonth] = [Number(found[1]), Number(found[2]), Number(found[3])];
	const check = new Date(year, month - 1, dayOfMonth);
	// `new Date` rolls 2026-02-31 over to March; a day that is not on the calendar is not a date.
	if (check.getFullYear() !== year || check.getMonth() !== month - 1 || check.getDate() !== dayOfMonth) {
		return { kind: "other" };
	}
	return { kind: "date", day: chainDayNumber(check) };
}

/**
 * A calendar day as a whole number, from its local year, month and date, so two
 * days one apart differ by exactly 1 whatever daylight-saving time does between.
 */
function chainDayNumber(date: Date): number {
	return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}
