/**
 * The shapes the day view's other tickets fill and draw, and the density
 * constant its settings card and its renderer both read.
 *
 * Declared once here so that a later ticket adds a field to one of these but
 * never renames one — `readDay` (built by #626, decision 8 of spec #618)
 * fills {@link Day}, `layoutDay` in `./layout.ts` turns its `timed` array
 * into blocks, and the renderer draws what both answer. The renderer is not
 * built yet; this file is only the shapes it and the others share.
 *
 * Starting point: `~/Devbox/schema-render/src/types.ts`. Its `Post` carried a
 * third table column, `effortCell`, that this plugin's day view does not draw
 * (spec #618, decision 8, citing #20 § 2), so {@link TimedMeeting} and
 * {@link AllDayMeeting} keep only the meeting cell's text.
 */

/** One meeting with a start and an end, read from a timed row of the table. */
export type TimedMeeting = {
	/** Start time in minutes from midnight. */
	readonly startMin: number;
	/** End time in minutes from midnight. */
	readonly endMin: number;
	/** The meeting cell's text, as the reader gives it. */
	readonly text: string;
	/** Position among the table's data rows, as `calendarTable.ts` counts them. */
	readonly rowIndex: number;
};

/** One meeting spanning the whole day, read from a `heldag`-style row. */
export type AllDayMeeting = {
	/** The meeting cell's text, as the reader gives it. */
	readonly text: string;
	/** Position among the table's data rows, as `calendarTable.ts` counts them. */
	readonly rowIndex: number;
};

/** A data row the reader could not use: why, and the row exactly as written. */
export type RowError = {
	/** Why the row could not be read, in one sentence. */
	readonly reason: string;
	/** The row exactly as written, so the reader can find it in the source. */
	readonly rawLine: string;
};

/** A line below the table's end that opens with a pipe but was never read as a row: its text, and which of the two things ended the table. */
export type UnreadRow = {
	/** The line exactly as written. */
	readonly line: string;
	/** `"wide-row"` when the table ended at a row wider than its header; `"blank-line"` for every other stop, including a blank line and a line of prose (`src/core/calendarTable.ts`). */
	readonly stoppedBy: "blank-line" | "wide-row";
};

/**
 * What one block's worth of a day comes to: the bars and the timed meetings
 * `readDay` read, the rows it could not, and the lines that sat outside the
 * table altogether — or, when there was no table to read, a fallback reason.
 */
export type Day =
	| {
			/** All-day meetings, in source order. */
			readonly bars: readonly AllDayMeeting[];
			/** Timed meetings, in source order — `layoutDay`'s own input. */
			readonly timed: readonly TimedMeeting[];
			/** Rows the reader read but could not use. */
			readonly rowErrors: readonly RowError[];
			/** Lines outside the table that were never read as rows. */
			readonly unread: readonly UnreadRow[];
	  }
	| {
			/** Why no day could be read at all. */
			readonly fallback: string;
	  };

/** The three vertical densities the settings card offers. */
export type Density = "compact" | "normal" | "spacious";

/**
 * Pixels drawn per hour, at each density: 45, 60 and 90 — the settings card
 * and the renderer both read this rather than each carrying its own numbers.
 */
export const PIXELS_PER_HOUR: Record<Density, number> = {
	compact: 45,
	normal: 60,
	spacious: 90,
};
