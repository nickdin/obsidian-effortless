/**
 * Review's one stored setting, `windowDays`, and the judgements made of it:
 * what a stored value is worth, and what a typed one is worth.
 *
 * **What `data.json` holds is judged here, on read, the way the box judges
 * what is typed into it.** The file is hand-editable, so a value the box could
 * never produce can still be stored. The feature refuses such a value with a
 * notice and uses the shipped default until it is changed, and the row shows
 * the stored value as it is, with the refusal beside it — never quietly the
 * fallback (this repository's `CLAUDE.md`, from
 * #606 and
 * #607).
 */

/** The feature's slice of `data.json`. */
export interface ReviewSettings {
	/** How many days Review looks at: today and the days before it. A whole number of at least 1. */
	windowDays: number;
}

/** A fresh install looks at a week: today and the six days before it. */
export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = { windowDays: 7 };

const MIN_WINDOW_DAYS = 1;

/**
 * The stored `windowDays` when it is a whole number of at least 1, or `null`
 * for anything else `data.json` may hold — text, a fraction, zero, a negative
 * number, nothing at all. There is no upper limit: a wide window is how a
 * backlog is cleared once.
 */
export function usableWindowDays(stored: unknown): number | null {
	if (typeof stored !== "number" || !Number.isSafeInteger(stored)) return null;
	if (stored < MIN_WINDOW_DAYS) return null;
	return stored;
}

/** A stored value as the person would recognise it in `data.json`: quoted when it is text. */
export function storedAsWritten(stored: unknown): string {
	const written = JSON.stringify(stored);
	return written === undefined ? String(stored) : written;
}

/**
 * The sentence the card shows in place of its usual line for a stored
 * `windowDays` Review cannot use, or `null` for one it can. Also what the load
 * notice names.
 */
export function windowDaysRefusal(stored: unknown): string | null {
	if (usableWindowDays(stored) !== null) return null;
	return `Review cannot use the value ${storedAsWritten(stored)} stored for the days it looks at, and uses ${DEFAULT_REVIEW_SETTINGS.windowDays} until this is changed.`;
}

/** What was typed into the box, as a whole number, or `null` for anything else — blank included. */
function parsedWindowDays(typed: string): number | null {
	const trimmed = typed.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const parsed = Number(trimmed);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * The sentence to show for what was just typed into the box, or `null` when it
 * may be stored as it stands. A fraction, text and a blank are refused the same
 * as zero, so none of them leaves the stored value changed.
 */
export function windowDaysEntryRefusal(typed: string): string | null {
	const parsed = parsedWindowDays(typed);
	if (parsed === null) return `Days to look at must be a whole number of at least ${MIN_WINDOW_DAYS}.`;
	if (parsed < MIN_WINDOW_DAYS) return `Days to look at must be at least ${MIN_WINDOW_DAYS}, not ${parsed}.`;
	return null;
}
