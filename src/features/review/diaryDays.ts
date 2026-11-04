/**
 * The day Review first saw text under a day's log's diary heading, kept in
 * Review's own slice of `data.json` until the diary-date write has landed.
 *
 * The core's note writer holds the write while the log is on screen, and a write
 * still held when the plugin unloads or the app is killed is lost. Without this,
 * the next change to the log, on a later day, would stamp the later day and the
 * chain would call the diary written in hindsight. With it, the next start (or
 * the next change) writes the day the text was seen: the same date the lost write
 * carried, never a later one, and never one for a log other than the one it was
 * seen in. A log whose day was not kept is dated the day it is first seen, as
 * before; spec #1049 story 10
 * keeps hindsight honest.
 *
 * **Keyed by the log's path.** An entry belongs to one log and to no other, so a
 * day remembered for one log can never date another.
 *
 * **Validated on read.** `diaryDays` lives in `data.json`, which a person can edit
 * by hand, so every reader of it is an input boundary (`CLAUDE.md`,
 * #606,
 * #607): an entry that is not
 * a real calendar day, or a day later than its own log's, is dropped and named,
 * never trusted and never thrown on. A day later than its log's is refused because
 * it would date a log with a day after the log's own, which spec #1049 story 10
 * forbids and is the thing this exists to prevent.
 */

import type { ReviewSettings } from "./types";

/** The slice's key for the memory. */
export const DIARY_DAYS_KEY = "diaryDays";

/** Log path → the day (`YYYY-MM-DD`) the text under the diary heading was first seen. */
export type DiaryDays = Readonly<Record<string, string>>;

/** The memory as far as it could be read, and the name of every entry that was dropped. */
export interface ReadDiaryDays {
	readonly days: DiaryDays;
	/** One name per dropped entry, as the person would find it in `data.json`: the path, or `diaryDays` itself when the stored value was not a table at all. */
	readonly dropped: string[];
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `day` is `YYYY-MM-DD` and names a day that exists, `2026-02-31` not. */
function isRealDay(day: string): boolean {
	const match = DAY.exec(day);
	if (match === null) return false;
	const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const built = new Date(year, month - 1, date);
	return built.getFullYear() === year && built.getMonth() === month - 1 && built.getDate() === date;
}

/**
 * The memory out of whatever `data.json` held. `latestFor(path)` is the last day
 * (`YYYY-MM-DD`) a day kept for that log may name: the log's own day, or the local
 * day now for a path that is not a day's log. Dropped, and named: a blank path, a
 * value that is not a real day, and a real day later than the log's latest.
 * Nothing stored is an empty memory with nothing dropped.
 *
 * The bound is the log's, not this device's clock: `data.json` syncs and each
 * device records in its own local day (ADR 0005), so a day kept by a device whose
 * clock is already on the next day is still the day that device saw the text.
 */
export function readDiaryDays(raw: unknown, latestFor: (path: string) => string): ReadDiaryDays {
	if (raw === undefined) return { days: {}, dropped: [] };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { days: {}, dropped: [DIARY_DAYS_KEY] };

	const days: Record<string, string> = {};
	const dropped: string[] = [];
	for (const [path, day] of Object.entries(raw)) {
		// Compared as text: `YYYY-MM-DD` orders the way the days do.
		if (path.trim() === "" || typeof day !== "string" || !isRealDay(day) || day > latestFor(path)) dropped.push(path);
		else days[path] = day;
	}
	return { days, dropped };
}

/** The stored memory exactly as `data.json` holds it, unjudged. */
export function storedDiaryDays(slice: object): unknown {
	return (slice as { diaryDays?: unknown }).diaryDays;
}

/** `slice` with its memory replaced by `days` and nothing else changed. */
export function withDiaryDays(slice: ReviewSettings, days: DiaryDays): ReviewSettings {
	const next = { ...slice, [DIARY_DAYS_KEY]: days };
	return next;
}
