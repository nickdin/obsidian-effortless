/**
 * The diary section a day's log was built with, kept so that an untouched log is
 * never taken for one the person wrote in, whatever the day's-log template says by
 * the time anyone looks.
 *
 * Days ahead builds logs up to eight days before their day. Comparing such a log's
 * diary section with the template *as it reads on the day* stamps an untouched log
 * the moment the person rewords the template in between.
 *
 * **Two records, one shape.** The core keeps `core.builtDiaries` in `data.json`,
 * the day (`YYYY-MM-DD`) → the section, taken by the note writer at the moment it
 * builds a log from the template ({@link keepBuiltDiaries}), whichever feature
 * asked for the build and whether or not Review is on. Review keeps its own,
 * keyed by path, for a log built before the core kept one
 * (`src/features/review/builtDiaries.ts`). Both are read and judged here.
 *
 * **The core's is keyed by the day, not the path**, so a log that is renamed or
 * moved keeps its entry with nothing listening for the rename, and a log built
 * again for the same day replaces it. Nothing is pruned: the stamp has no window,
 * so an old log still needs its section (the reason
 * #1198 gives), and an entry
 * is one short text per day built.
 *
 * **Across devices** it travels in `data.json`, which syncs, and
 * `SettingsStore.reloadExternal` merges it one day at a time, so the device that
 * builds the days and the device that runs Review need not be the same one. A log
 * that reaches Review's device and is indexed there before the settings file does
 * is judged with no record, as before.
 *
 * **Validated on read.** `data.json` can be edited by hand, so every reader of a
 * record is an input boundary (`CLAUDE.md`,
 * #606): an entry whose key the
 * record cannot use (a blank path in Review's, anything but a real `YYYY-MM-DD` day
 * in the core's) or whose section is not text is dropped and named, never trusted
 * and never thrown on.
 */

import { Notice } from "obsidian";
import { localDateKey } from "./meetingName";
import { reasonOf } from "./reason";
import type { SettingsStore } from "./settings";

/** Key → the text the log held under its diary heading when it was built. */
export type BuiltDiaries = Readonly<Record<string, string>>;

/** A record as far as it could be read, and the name of every entry that was dropped. */
export interface ReadBuiltDiaries {
	readonly sections: BuiltDiaries;
	/** One name per dropped entry, as the person would find it in `data.json`: its key, or `name` itself when the stored value was not a table at all. */
	readonly dropped: string[];
}

/**
 * The record out of whatever `data.json` held under `name`; nothing stored is an
 * empty record with nothing dropped. `usableKey` says which keys the record can
 * look an entry up by; any key that is not blank, unless said otherwise.
 */
export function readBuiltDiaries(raw: unknown, name: string, usableKey: (key: string) => boolean = (key) => key.trim() !== ""): ReadBuiltDiaries {
	if (raw === undefined) return { sections: {}, dropped: [] };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { sections: {}, dropped: [name] };

	const sections: Record<string, string> = {};
	const dropped: string[] = [];
	for (const [key, section] of Object.entries(raw)) {
		if (!usableKey(key) || typeof section !== "string") dropped.push(key);
		else sections[key] = section;
	}
	return { sections, dropped };
}

/** The core's key for the day `date` falls on. */
export function builtDiaryDay(date: Date): string {
	return localDateKey(date);
}

/** Whether `key` is a day the core's record can be looked up by: `YYYY-MM-DD`, and a day the calendar has (`2026-02-30` is not). */
export function isBuiltDiaryDay(key: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
	if (match === null) return false;
	return builtDiaryDay(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) === key;
}

/**
 * The section the core kept for the day's log of `day`, the log's own day as
 * `parseDailyLogDate` reads it off its path, or `undefined` when the path has no
 * day (`null`) or none was kept. Takes the day rather than the path so that a
 * caller which has already read the day does not read it again.
 */
export function coreBuiltDiary(day: Date | null, sections: BuiltDiaries): string | undefined {
	return day === null ? undefined : sections[builtDiaryDay(day)];
}

/**
 * What the note writer is told each time it builds a day's log from the template
 * (`NoteWriter`'s `onDailyLogBuilt`): the day and the section, kept in `settings`.
 * A record that cannot be saved is said in a notice; the log itself is built
 * either way, and without the record it is compared with the template as it
 * reads, as before.
 */
export function keepBuiltDiaries(settings: SettingsStore): (date: Date, section: string) => void {
	return (date, section) => {
		const day = builtDiaryDay(date);
		settings.keepBuiltDiary(day, section).catch((error: unknown) => {
			new Notice(`Effortless could not keep the diary section the log for ${day} was built with: ${reasonOf(error).replace(/^Effortless: /, "")}`);
		});
	};
}
