/**
 * Draws a day that `readDay` read into one block's element: the rows it left
 * out, the band of all-day bars, and the grid of timed blocks.
 *
 * Carried from the old day view's renderer
 * (`~/Devbox/schema-render/src/renderer.ts:223-267`, `:380-420`, `:468-493`),
 * with its geometry unchanged. What differs is named in spec #618:
 *
 * - Class names carry this plugin's `effortless-day-view-` prefix, and each
 *   has a rule in `styles.css` (decision 15).
 * - Every sentence names Effortless rather than the old plugin, in the
 *   glossary's words (named difference 6).
 * - Rows the core's table never reached are listed with what stopped it
 *   (named difference 5).
 * - A block carries only the meeting cell's text: a third column is not drawn
 *   (named difference 2).
 *
 * **Opening a note, writing its link and showing the bubble are not decided
 * here**: each block and bar is handed, as it is drawn, to the `MeetingReach`
 * the feature passes in, which wires them
 * (#628, `openMeeting.ts`).
 * Drawn without one, a day opens nothing. **No `aria-label` is put on a block
 * or a bar**: Obsidian draws one as a tooltip of its own, which would sit on
 * top of the bubble (old issue #32).
 *
 * Only the DOM is touched, through Obsidian's element helpers; the feature
 * decides what to draw and when, and hands in the density and whether this is
 * today's log.
 */

import { layoutDay } from "./layout";
import type { Block, Span } from "./layout";
import { placeNowLine } from "./nowLine";
import type { MeetingReach } from "./openMeeting";
import type { AllDayMeeting, Day, RowError, UnreadRow } from "./types";

/** A day `readDay` could read — every answer but the fallback. */
export type ReadableDay = Exclude<Day, { readonly fallback: string }>;

/** What drawing a day hands back: where the now-line is, if one was drawn, and the grid it sits on. */
export interface DrawnDay {
	/** The now-line on today's grid, or `null` on any other note. */
	readonly nowLine: HTMLElement | null;
	readonly span: Span;
	readonly pxPerMinute: number;
}

/**
 * How to draw: the density's height per minute, whether this is today's log,
 * now, and what opens the drawn meetings — left out, they open nothing.
 */
export interface DrawOptions {
	readonly pxPerMinute: number;
	readonly today: boolean;
	readonly now: Date;
	readonly reach?: MeetingReach;
}

/**
 * Draws `day` into `container`, emptying it first so a redraw never stacks a
 * second day on the first.
 *
 * Structure, top to bottom:
 *
 *     .effortless-day-view-problems   rows that could not be read (when any)
 *     .effortless-day-view-unread     rows the table never reached (when any)
 *     .effortless-day-view-band       one bar per all-day meeting (when any)
 *     .effortless-day-view-grid       the grid, positioned, as tall as its span
 *       .effortless-day-view-gridline (-hour on the hour), every 30 minutes
 *       .effortless-day-view-time-label, on each hour
 *       .effortless-day-view-track    beside the time gutter
 *         .effortless-day-view-block, one per timed meeting
 *       .effortless-day-view-now-line (today's log only)
 *
 * The lists go above the grid, not below: the grid is 510 pixels tall even on
 * an empty day, and a list under it would sit off the screen on exactly the
 * days it has something to say.
 */
export function drawDay(container: HTMLElement, day: ReadableDay, options: DrawOptions): DrawnDay {
	container.empty();
	options.reach?.redrawing();

	drawRowErrors(container, day.rowErrors);
	drawUnread(container, day.unread);

	// Left out altogether on a day with no all-day meeting rather than drawn
	// empty: an empty band would still carry its margin.
	if (day.bars.length > 0) {
		const band = container.createDiv({ cls: "effortless-day-view-band" });
		for (const bar of day.bars) drawBar(band, bar, options.reach);
	}

	const { span, blocks } = layoutDay(day.timed, options.pxPerMinute);
	const grid = container.createDiv({ cls: "effortless-day-view-grid" });
	grid.style.height = `${span.totalHeightPx}px`;

	for (let minute = span.startMin; minute <= span.endMin; minute += 30) {
		const top = `${(minute - span.startMin) * options.pxPerMinute}px`;
		if (minute % 60 === 0) {
			grid.createDiv({ cls: "effortless-day-view-gridline effortless-day-view-gridline-hour" }).style.top = top;
			const label = grid.createDiv({ cls: "effortless-day-view-time-label", text: clock(minute) });
			label.style.top = top;
		} else {
			grid.createDiv({ cls: "effortless-day-view-gridline" }).style.top = top;
		}
	}

	// A track of its own, starting at the time gutter's right edge, so a block
	// can never share horizontal space with a label.
	const track = grid.createDiv({ cls: "effortless-day-view-track" });
	for (const block of blocks) drawBlock(track, block, options.reach);

	let nowLine: HTMLElement | null = null;
	if (options.today) {
		// Created even while now is outside the span, so the minute's tick can
		// show it without a redraw.
		nowLine = grid.createDiv({ cls: "effortless-day-view-now-line" });
		placeNowLine(nowLine, span, options.pxPerMinute, options.now);
	}

	return { nowLine, span, pxPerMinute: options.pxPerMinute };
}

/**
 * Draws the one sentence a block with no readable day stands under, and hands
 * back the element its text as written goes into, beneath the sentence.
 *
 * The feature draws that text as Markdown, through Obsidian, so the person
 * never loses what they wrote and always learns why (spec #618 decision 7,
 * the old plugin's issue #10).
 */
export function drawFallbackReason(container: HTMLElement, reason: string): HTMLElement {
	container.empty();
	container.createDiv({ cls: "effortless-day-view-fallback", text: fallbackSentence(reason) });
	return container.createDiv({ cls: "effortless-day-view-fallback-source" });
}

/** The sentence above a block's text as written, carrying the reason `readDay` gave. */
function fallbackSentence(reason: string): string {
	return `Effortless could not read a day here, so it is shown as written. ${reason}`;
}

/** One all-day bar: a block's own class and look, laid out one per line in the band. */
function drawBar(band: HTMLElement, bar: AllDayMeeting, reach: MeetingReach | undefined): void {
	const el = band.createDiv({ cls: "effortless-day-view-block effortless-day-view-bar" });
	const text = el.createDiv({ cls: "effortless-day-view-block-text", text: bar.text });
	reach?.wire(el, text, { rowIndex: bar.rowIndex, time: null, text: bar.text });
}

/**
 * One timed block, placed by its time and its column. Its height is the
 * meeting's length and nothing else: text that does not fit is clipped by the
 * stylesheet rather than the block being made taller than the meeting.
 */
function drawBlock(track: HTMLElement, block: Block, reach: MeetingReach | undefined): void {
	const el = track.createDiv({ cls: "effortless-day-view-block" });
	el.style.top = `${block.topPx}px`;
	el.style.height = `${block.heightPx}px`;
	el.style.left = `${(block.columnIndex / block.totalColumns) * 100}%`;
	el.style.width = `calc(${100 / block.totalColumns}% - 2px)`;
	const text = el.createDiv({ cls: "effortless-day-view-block-text", text: block.text });
	reach?.wire(el, text, {
		rowIndex: block.rowIndex,
		time: { startMin: block.startMin, endMin: block.endMin },
		text: block.text,
	});
}

/**
 * The rows the reader read and could not use, each with its reason and the row
 * exactly as written, so the person can find it in their table without
 * counting lines. A list rather than blocks on the grid: the grid's height is
 * time, and a row whose time could not be read has no honest place on it.
 */
function drawRowErrors(container: HTMLElement, rowErrors: readonly RowError[]): void {
	if (rowErrors.length === 0) return;
	const box = container.createDiv({ cls: "effortless-day-view-problems" });
	box.createDiv({ cls: "effortless-day-view-problem-heading", text: rowErrorsHeading(rowErrors.length) });
	for (const rowError of rowErrors) {
		const row = box.createDiv({ cls: "effortless-day-view-problem-row" });
		row.createDiv({ cls: "effortless-day-view-problem-reason", text: rowError.reason });
		row.createDiv({ cls: "effortless-day-view-problem-source", text: rowError.rawLine });
	}
}

/** The heading over the rows that could not be read. */
function rowErrorsHeading(count: number): string {
	return `Effortless could not read ${rows(count)} of this table, so ${leftOut(count)}:`;
}

/**
 * The rows below the table's end that were never read as rows, each as
 * written, under one heading saying what ended the table.
 */
function drawUnread(container: HTMLElement, unread: readonly UnreadRow[]): void {
	if (unread.length === 0) return;
	const box = container.createDiv({ cls: "effortless-day-view-unread" });
	box.createDiv({ cls: "effortless-day-view-problem-heading", text: unreadHeading(unread.length, unread[0].stoppedBy) });
	for (const row of unread) {
		box.createDiv({ cls: "effortless-day-view-problem-row" }).createDiv({
			cls: "effortless-day-view-problem-source",
			text: row.line,
		});
	}
}

/**
 * The heading over the rows the table never reached.
 *
 * **Its words have to be true of every line `"blank-line"` covers**, which is
 * a blank line and a line of prose alike: so it names "a
 * line that is not a table row" rather than a blank one. A wide row is itself
 * listed — it opens with a pipe — so the list starts at it rather than below
 * it.
 */
function unreadHeading(count: number, stoppedBy: UnreadRow["stoppedBy"]): string {
	if (stoppedBy === "wide-row") {
		return `Effortless did not read ${rows(count)}, starting at a row with more cells than the table's header, so ${leftOut(count)}:`;
	}
	return `Effortless did not read ${rows(count)} below a line that is not a table row, so ${leftOut(count)}:`;
}

/** "1 row" or "3 rows". */
function rows(count: number): string {
	return count === 1 ? "1 row" : `${count} rows`;
}

/** The end of both headings, in the number the count asks for. */
function leftOut(count: number): string {
	return count === 1 ? "it is left out of the day below" : "they are left out of the day below";
}

/** `HH:MM` for a minute of the day. */
function clock(minute: number): string {
	const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
	return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
}
