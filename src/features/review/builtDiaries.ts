/**
 * The diary section each day's log was built with, kept in Review's own slice of
 * `data.json`.
 *
 * Days ahead builds logs up to eight days before their day. Comparing such a log's
 * diary section with the day's-log template *as it reads on the day* stamps an
 * untouched log the moment the person rewords the template in between. So when a
 * log is created and its diary section is exactly what the template makes, Review
 * keeps that section, and "untouched" later means "still that section", whatever
 * the template says by then. Nothing is written into the log for this: a mark in
 * the note would be one more thing every plugin write to it had to keep current.
 *
 * Since #1201 the core keeps
 * the section of every log it builds, at build time (`src/core/builtDiaries.ts`),
 * and Review reads that first. This record is for a log built before then: one
 * with neither entry is compared with the template as it reads now, as before.
 *
 * **Keyed by the log's path.** An entry belongs to one log.
 *
 * **Validated on read**, by the core's rule for both records
 * ({@link readBuiltDiaries}): an entry whose path is blank or whose section is not
 * text is dropped and named, never trusted and never thrown on.
 */

import { readBuiltDiaries } from "../../core/builtDiaries";
import type { BuiltDiaries, ReadBuiltDiaries } from "../../core/builtDiaries";
import type { ReviewSettings } from "./types";

/** The slice's key for the record. */
export const BUILT_DIARIES_KEY = "builtDiaries";

/** The record out of whatever `data.json` held, judged by the core's rule for every such record. */
export function readReviewBuiltDiaries(raw: unknown): ReadBuiltDiaries {
	return readBuiltDiaries(raw, BUILT_DIARIES_KEY);
}

/** The stored record exactly as `data.json` holds it, unjudged. */
export function storedBuiltDiaries(slice: object): unknown {
	return (slice as { builtDiaries?: unknown }).builtDiaries;
}

/** `slice` with its record replaced by `sections` and nothing else changed. */
export function withBuiltDiaries(slice: ReviewSettings, sections: BuiltDiaries): ReviewSettings {
	const next = { ...slice, [BUILT_DIARIES_KEY]: sections };
	return next;
}

/** `sections` without the entries for `paths`. */
export function without(sections: BuiltDiaries, paths: readonly string[]): BuiltDiaries {
	const rest: Record<string, string> = { ...sections };
	for (const path of paths) delete rest[path];
	return rest;
}

/** `slice` as text with the record left out: equal for two slices that differ only in what was built. */
export function settingsApartFromBuilt(slice: ReviewSettings): string {
	const rest: Record<string, unknown> = { ...slice };
	delete rest[BUILT_DIARIES_KEY];
	return JSON.stringify(rest);
}
