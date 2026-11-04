/**
 * What two event cells are compared by, when a row is matched to a meeting
 * by title rather than by memory.
 *
 * Carried unchanged from
 * `~/Devbox/calendar-scaffold/src/schema-table.ts:413-426`.
 */

/**
 * A note name's leading `YYYY-MM-DD `. Any date, not only the row's own: a
 * later day of a several-day meeting links to the note dated the meeting's
 * first day, so the row's own date is not the one its link carries.
 */
const DATE_PREFIX = /^\d{4}-\d{2}-\d{2} /;

/**
 * The thing an event cell's text is *about*, with the link syntax, the
 * date prefix, the trailing location and the case removed — so
 * `[[2026-08-20 Weekly]] (Online)` and a hand-typed `Weekly` are recognised
 * as the same row. An empty key matches nothing.
 *
 * `_date` is the day of the row being matched. It no longer decides what is
 * stripped — any leading date is (see {@link DATE_PREFIX}) — and stays so the
 * callers, which all have it, keep one signature.
 */
export function matchKey(cellText: string, _date: string): string {
	let text = cellText.trim();

	const withParen = text.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
	if (withParen) text = withParen[1].trim();

	const asLink = text.match(/^\[\[([^\]|]+?)(?:\\?\|[^\]]*)?\]\]$/);
	if (asLink) {
		text = asLink[1].trim();
		text = text.replace(DATE_PREFIX, "");
	}

	return text.replace(/\s+/g, " ").trim().toLowerCase();
}
