/**
 * Reading the day's-log calendar table's time cell.
 *
 * Two features read this shape and neither may decide it alone: building the
 * days ahead writes a `Tid` cell and the day view draws a bar from one, and
 * what they must agree on belongs in the core beside the table itself. In the plugins this plugin absorbs, that agreement spanned
 * two separate repositories and nothing held the two readings to the same
 * rule; one module now is the whole of the fix.
 *
 * The write side has arrived: {@link writeTimeCell} sits beside
 * {@link readTimeCell} here. Its caller is the feature that builds the days
 * ahead — `src/features/daysAhead/desiredRows.ts` — and this module's shape
 * stays the one both sides read and write against.
 */

/** Why a cell could not be read as a time. */
export type TimeCellRefusal =
	/** The cell names no time at all: blank, a single time, or words. */
	| "not-a-time"
	/** The cell names a range whose end comes before its start. */
	| "backwards";

/**
 * What {@link readTimeCell} gives back: the cell's minutes and whether it
 * covers the whole day, or the reason it could not be read.
 *
 * `ok` is the discriminator, so a caller cannot reach `startMin` without
 * having checked it first.
 */
export type TimeCellOutcome =
	| {
			readonly ok: true;
			readonly startMin: number;
			readonly endMin: number;
			readonly allDay: boolean;
	  }
	| { readonly ok: false; readonly reason: TimeCellRefusal };

/**
 * Read a `Tid` cell.
 *
 * A range is `H:MM` or `HH:MM`, a dash, `H:MM` or `HH:MM`, with spaces around the dash
 * allowed. The dash is the en dash `–` or the hyphen `-`; neither is
 * rewritten, because nothing here writes. An hour above 23 or a minute above
 * 59 is not a time, refused as `"not-a-time"`. An end before its start is
 * refused as `"backwards"`; an end equal to its start is a real, very short
 * meeting and is accepted.
 *
 * All day is `00:00–23:59`, with either dash, or the word `heldag` in any
 * capitalisation. `heldag` is Swedish data — the older hand-typed form a
 * handful of days still carry — read here but never written, and never
 * translated (`~/Devbox/CLAUDE.md` § Language).
 */
export function readTimeCell(text: string): TimeCellOutcome {
	const trimmed = text.trim();

	if (trimmed.toLowerCase() === "heldag") {
		return { ok: true, startMin: 0, endMin: 23 * 60 + 59, allDay: true };
	}

	const match = trimmed.match(/^(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})$/);
	if (!match) return { ok: false, reason: "not-a-time" };

	const startH = parseInt(match[1], 10);
	const startM = parseInt(match[2], 10);
	const endH = parseInt(match[3], 10);
	const endM = parseInt(match[4], 10);
	if (startH > 23 || startM > 59 || endH > 23 || endM > 59) {
		return { ok: false, reason: "not-a-time" };
	}

	const startMin = startH * 60 + startM;
	const endMin = endH * 60 + endM;
	if (endMin < startMin) return { ok: false, reason: "backwards" };

	return { ok: true, startMin, endMin, allDay: startMin === 0 && endMin === 23 * 60 + 59 };
}

/**
 * Write a `Tid` cell.
 *
 * The feature that builds the days ahead is the caller. All day is always
 * `00:00–23:59`, with the en dash, whatever minutes it is handed — never
 * `heldag`, the older hand-typed form, which stays read-only
 * (`docs/research/absorbed-plugins-collision-map.md:322`). A timed cell is
 * `HH:MM–HH:MM`, both parts zero-padded to two digits, matching what
 * {@link readTimeCell} reads and what the absorbed plugin wrote
 * (`docs/research/absorbed-plugins-collision-map.md:196`).
 *
 * Clamping a multi-day meeting to the day being written is not this
 * function's job: the signature carries no meeting and no day, so it cannot
 * clamp. That belongs to the feature computing `startMin`/`endMin` before it
 * calls this.
 */
export function writeTimeCell(startMin: number, endMin: number, allDay: boolean): string {
	if (allDay) return "00:00–23:59";

	const pad = (n: number) => String(n).padStart(2, "0");
	const startH = Math.floor(startMin / 60);
	const startM = startMin % 60;
	const endH = Math.floor(endMin / 60);
	const endM = endMin % 60;
	return `${pad(startH)}:${pad(startM)}–${pad(endH)}:${pad(endM)}`;
}
