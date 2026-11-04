/**
 * The now-line's two pure halves: whether a note is today's log, and where the
 * line sits on a grid at a given moment.
 *
 * **Today's log is the note the core's layout names for today**, read through
 * the core's own `parseDailyLogDate`, never a filename test of this feature's.
 * The old day view drew the line on any note whose name was exactly
 * `YYYY-MM-DD`, anywhere in the vault
 * (`~/Devbox/schema-render/src/renderer.ts:197-200`); a note of that name outside
 * the daily-log folder no longer gets one, a day's log under a pattern such as
 * `YYYY/MM/YYYY-MM-DD` now does, and with the folder or the filename unanswered
 * no note is today's log at all. That is named difference 7 of spec #618.
 *
 * Nothing here holds a timer. The feature registers the minute's interval on
 * itself, so it stops when the feature is switched off, and calls
 * {@link placeNowLine} from it.
 */

import { parseDailyLogDate } from "../../core/vaultLayout";
import type { VaultLayout } from "../../core/settings";

/**
 * Whether `path` is the log the core's layout names for the local day `now`
 * falls on. False for every note while the layout's daily-log folder or
 * filename is unanswered, because `parseDailyLogDate` then answers `null`.
 */
export function isTodaysLog(path: string, layout: VaultLayout, now: Date): boolean {
	const day = parseDailyLogDate(path, layout);
	return (
		day !== null &&
		day.getFullYear() === now.getFullYear() &&
		day.getMonth() === now.getMonth() &&
		day.getDate() === now.getDate()
	);
}

/** Minutes since local midnight. */
export function minuteOfDay(now: Date): number {
	return now.getHours() * 60 + now.getMinutes();
}

/**
 * The class that hides the now-line. A fixed inline style
 * (`element.style.display`) is one of the fixed inline styles Obsidian's
 * community-plugin-list rules forbid
 * (`docs/research/obsidian-publishing-requirements.md:48`), so the show/hide
 * toggle is a class, with its rule in `styles.css`, rather than a style
 * written directly onto the element.
 */
export const NOW_LINE_HIDDEN_CLASS = "effortless-day-view-now-line--hidden";

/**
 * Moves `line` to `now`'s height on a grid covering `span` at `pxPerMinute`,
 * and shows it; hides it while `now` is outside the span.
 *
 * Hidden rather than removed, as the old view did it
 * (`~/Devbox/schema-render/src/main.ts:69-105`): the line is created once on
 * today's grid, so the minute's tick only ever moves or shows what is there.
 */
export function placeNowLine(
	line: HTMLElement,
	span: { readonly startMin: number; readonly endMin: number },
	pxPerMinute: number,
	now: Date,
): void {
	const minute = minuteOfDay(now);
	if (minute < span.startMin || minute > span.endMin) {
		line.toggleClass(NOW_LINE_HIDDEN_CLASS, true);
		return;
	}
	line.toggleClass(NOW_LINE_HIDDEN_CLASS, false);
	line.style.top = `${(minute - span.startMin) * pxPerMinute}px`;
}
