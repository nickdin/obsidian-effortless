/**
 * Drawing a day into an element, in jsdom.
 *
 * Carried from the old day view's renderer
 * (`~/Devbox/schema-render/src/renderer.ts:223-267`, `:380-420`, `:468-493`):
 * the rows that could not be read listed above the grid, the band of all-day
 * bars above the grid and left out when there are none, gridlines every half
 * hour with a label on each hour, and the blocks in a track beside the time
 * gutter. What changed is named: the class names carry this plugin's prefix,
 * every sentence names Effortless in the glossary's words (named difference 6),
 * and rows the core's table never reached are listed with what stopped it
 * (named difference 5).
 *
 * Each test hands a block's text in through `readDay` and reads the element
 * that comes out. Every meeting name here is invented.
 */

import { describe, expect, it } from "vitest";
import type { ColumnNames } from "../core/calendarTable";
import { readDay } from "../features/dayView/readDay";
import { drawDay, drawFallbackReason } from "../features/dayView/render";
import type { ReadableDay } from "../features/dayView/render";

const COLUMNS: ColumnNames = { time: "Time", event: "Meeting" };

/** One pixel a minute: the `normal` density, 60 pixels an hour. */
const NORMAL = 1;

/** A moment on an invented day. */
const at = (h: number, min: number): Date => new Date(2031, 3, 9, h, min);

/** Reads `lines` as a block's body; fails the test if it did not read as a day. */
function dayOf(...lines: string[]): ReadableDay {
	const day = readDay(lines, COLUMNS);
	if ("fallback" in day) throw new Error(`expected a day, got the fallback: ${day.fallback}`);
	return day;
}

/** Draws `day` into a fresh element, not today's log, and hands the element back. */
function drawn(day: ReadableDay, pxPerMinute = NORMAL): HTMLElement {
	const container = document.createElement("div");
	drawDay(container, day, { pxPerMinute, today: false, now: at(10, 0) });
	return container;
}

const TABLE = ["| Time | Meeting |", "| --- | --- |"];

const THREE_TIMED_ONE_ALL_DAY = dayOf(
	...TABLE,
	"| 00:00–23:59 | Harbour festival |",
	"| 09:00–10:00 | Planning |",
	"| 09:30–10:30 | Review (Online) |",
	"| 13:00–13:45 | Walk |",
);

describe("drawing a day", () => {
	it("draws the band above the grid, holding one bar per all-day meeting", () => {
		const el = drawn(THREE_TIMED_ONE_ALL_DAY);

		const children = Array.from(el.children).map((child) => child.className);
		expect(children).toEqual(["effortless-day-view-band", "effortless-day-view-grid"]);
		const bars = el.querySelectorAll(".effortless-day-view-band > .effortless-day-view-bar");
		expect(bars).toHaveLength(1);
		expect(bars[0].textContent).toBe("Harbour festival");
		// A bar carries a block's own class, so the two look alike by construction.
		expect(bars[0].classList.contains("effortless-day-view-block")).toBe(true);
	});

	it("stacks bars one per line in table order", () => {
		const el = drawn(
			dayOf(...TABLE, "| heldag | Second |", "| 09:00–10:00 | Timed |", "| 00:00-23:59 | Third |", "| HELDAG | First? |"),
		);
		const bars = Array.from(el.querySelectorAll(".effortless-day-view-bar")).map((bar) => bar.textContent);
		expect(bars).toEqual(["Second", "Third", "First?"]);
	});

	it("leaves the band out on a day with no all-day meeting", () => {
		const el = drawn(dayOf(...TABLE, "| 09:00–10:00 | Planning |"));
		expect(el.querySelector(".effortless-day-view-band")).toBeNull();
		expect(el.querySelector(".effortless-day-view-grid")).not.toBeNull();
	});

	it("draws one block per timed meeting in the track, with its height and its column", () => {
		const el = drawn(THREE_TIMED_ONE_ALL_DAY);

		const blocks = Array.from(
			el.querySelectorAll<HTMLElement>(
				".effortless-day-view-grid > .effortless-day-view-track > .effortless-day-view-block",
			),
		);
		expect(blocks).toHaveLength(3);
		expect(blocks.map((block) => block.textContent)).toEqual(["Planning", "Review (Online)", "Walk"]);
		// 08:00 is the top of the grid, at one pixel a minute.
		expect(blocks.map((block) => block.style.top)).toEqual(["60px", "90px", "300px"]);
		expect(blocks.map((block) => block.style.height)).toEqual(["60px", "60px", "45px"]);
		// The two that overlap sit side by side; the third has the track to itself.
		expect(blocks.map((block) => block.style.left)).toEqual(["0%", "50%", "0%"]);
		expect(blocks.map((block) => block.style.width)).toEqual([
			"calc(50% - 2px)",
			"calc(50% - 2px)",
			"calc(100% - 2px)",
		]);
	});

	it("keeps no bar in the track and no block in the band", () => {
		const el = drawn(THREE_TIMED_ONE_ALL_DAY);
		expect(el.querySelectorAll(".effortless-day-view-track .effortless-day-view-bar")).toHaveLength(0);
		expect(el.querySelectorAll(".effortless-day-view-band .effortless-day-view-block:not(.effortless-day-view-bar)")).toHaveLength(0);
	});

	it("sizes the grid to its span at the density handed in", () => {
		const day = dayOf(...TABLE, "| 09:00–10:00 | Planning |");
		// 08:00–16:30 is 510 minutes.
		expect(drawn(day, 1).querySelector<HTMLElement>(".effortless-day-view-grid")?.style.height).toBe("510px");
		expect(drawn(day, 0.75).querySelector<HTMLElement>(".effortless-day-view-grid")?.style.height).toBe("382.5px");
		expect(drawn(day, 1.5).querySelector<HTMLElement>(".effortless-day-view-block")?.style.height).toBe("90px");
	});

	it("draws a gridline every 30 minutes and a label on each hour", () => {
		const el = drawn(dayOf(...TABLE, "| 09:00–10:00 | Planning |"));

		// 08:00 to 16:30 inclusive, every half hour: 18 lines, 9 of them on the hour.
		expect(el.querySelectorAll(".effortless-day-view-gridline")).toHaveLength(18);
		expect(el.querySelectorAll(".effortless-day-view-gridline.effortless-day-view-gridline-hour")).toHaveLength(9);
		const labels = Array.from(el.querySelectorAll<HTMLElement>(".effortless-day-view-time-label"));
		expect(labels.map((label) => label.textContent)).toEqual([
			"08:00",
			"09:00",
			"10:00",
			"11:00",
			"12:00",
			"13:00",
			"14:00",
			"15:00",
			"16:00",
		]);
		expect(labels[1].style.top).toBe("60px");
	});

	it("widens the grid for a meeting outside 08:00–16:30", () => {
		const el = drawn(dayOf(...TABLE, "| 07:10–07:40 | Early |", "| 17:00–18:05 | Late |"));
		const labels = Array.from(el.querySelectorAll(".effortless-day-view-time-label")).map((label) => label.textContent);
		expect(labels[0]).toBe("07:00");
		expect(labels[labels.length - 1]).toBe("18:00");
	});

	it("draws an empty 08:00–16:30 grid on a day of nothing but all-day meetings", () => {
		const el = drawn(dayOf(...TABLE, "| heldag | Holiday |"));
		expect(el.querySelectorAll(".effortless-day-view-bar")).toHaveLength(1);
		expect(el.querySelector<HTMLElement>(".effortless-day-view-grid")?.style.height).toBe("510px");
		expect(el.querySelectorAll(".effortless-day-view-track > *")).toHaveLength(0);
	});

	it("keeps a very short meeting's block at least 2 pixels tall and clips its text rather than growing", () => {
		const el = drawn(dayOf(...TABLE, "| 09:00–09:00 | A name far longer than the block has room for |"), 0.75);
		const block = el.querySelector<HTMLElement>(".effortless-day-view-block");
		expect(block?.style.height).toBe("2px");
		expect(block?.querySelector(".effortless-day-view-block-text")?.textContent).toBe(
			"A name far longer than the block has room for",
		);
	});

	it("puts no aria-label on a block or a bar", () => {
		const el = drawn(THREE_TIMED_ONE_ALL_DAY);
		expect(el.querySelectorAll("[aria-label]")).toHaveLength(0);
	});

	it("empties the element before drawing, so a redraw does not stack a second day", () => {
		const container = document.createElement("div");
		drawDay(container, THREE_TIMED_ONE_ALL_DAY, { pxPerMinute: NORMAL, today: false, now: at(10, 0) });
		drawDay(container, THREE_TIMED_ONE_ALL_DAY, { pxPerMinute: NORMAL, today: false, now: at(10, 0) });
		expect(container.querySelectorAll(".effortless-day-view-grid")).toHaveLength(1);
		expect(container.querySelectorAll(".effortless-day-view-band")).toHaveLength(1);
	});
});

describe("rows the day leaves out, listed above the grid", () => {
	it("lists a row error with its reason and the row as written", () => {
		const el = drawn(dayOf(...TABLE, "| 09:00–10:00 | Planning |", "| 11:00–10:00 | Backwards |"));

		const box = el.querySelector(".effortless-day-view-problems");
		expect(el.firstElementChild).toBe(box);
		expect(box?.querySelector(".effortless-day-view-problem-heading")?.textContent).toBe(
			"Effortless could not read 1 row of this table, so it is left out of the day below:",
		);
		expect(box?.querySelector(".effortless-day-view-problem-reason")?.textContent).toBe(
			'Invalid time "11:00–10:00" — the end time is before the start time.',
		);
		expect(box?.querySelector(".effortless-day-view-problem-source")?.textContent).toBe(
			"| 11:00–10:00 | Backwards |",
		);
	});

	it("counts several row errors in its heading", () => {
		const el = drawn(dayOf(...TABLE, "| 09:00–10:00 | Planning |", "| soon | One |", "| later | Two |"));
		expect(el.querySelector(".effortless-day-view-problem-heading")?.textContent).toBe(
			"Effortless could not read 2 rows of this table, so they are left out of the day below:",
		);
		expect(el.querySelectorAll(".effortless-day-view-problem-row")).toHaveLength(2);
	});

	it("lists a row below a blank line as not read, in words true of a blank line", () => {
		const el = drawn(dayOf(...TABLE, "| 09:00–10:00 | Planning |", "", "| 11:00–12:00 | Stranded |"));

		const box = el.querySelector(".effortless-day-view-unread");
		expect(box?.querySelector(".effortless-day-view-problem-heading")?.textContent).toBe(
			"Effortless did not read 1 row below a line that is not a table row, so it is left out of the day below:",
		);
		expect(box?.querySelector(".effortless-day-view-problem-source")?.textContent).toBe("| 11:00–12:00 | Stranded |");
	});

	it("uses the same words, still true, for a row below a line of prose", () => {
		const el = drawn(
			dayOf(...TABLE, "| 09:00–10:00 | Planning |", "Notes about the day", "| 11:00–12:00 | Stranded |"),
		);
		expect(el.querySelector(".effortless-day-view-unread .effortless-day-view-problem-heading")?.textContent).toBe(
			"Effortless did not read 1 row below a line that is not a table row, so it is left out of the day below:",
		);
	});

	it("names a row wider than the header as what stopped the table, and lists that row too", () => {
		const el = drawn(
			dayOf(...TABLE, "| 09:00–10:00 | Planning |", "| 10:00–11:00 | Wide | extra |", "| 11:00–12:00 | Stranded |"),
		);
		const box = el.querySelector(".effortless-day-view-unread");
		expect(box?.querySelector(".effortless-day-view-problem-heading")?.textContent).toBe(
			"Effortless did not read 2 rows, starting at a row with more cells than the table's header, so they are left out of the day below:",
		);
		expect(Array.from(box?.querySelectorAll(".effortless-day-view-problem-source") ?? []).map((row) => row.textContent)).toEqual([
			"| 10:00–11:00 | Wide | extra |",
			"| 11:00–12:00 | Stranded |",
		]);
	});

	it("puts the row errors first, the rows not read next, and both above the band and the grid", () => {
		const el = drawn(
			dayOf(...TABLE, "| heldag | Holiday |", "| 09:00–10:00 | Planning |", "| soon | Bad |", "", "| 11:00–12:00 | Stranded |"),
		);
		expect(Array.from(el.children).map((child) => child.className)).toEqual([
			"effortless-day-view-problems",
			"effortless-day-view-unread",
			"effortless-day-view-band",
			"effortless-day-view-grid",
		]);
	});

	it("draws neither list on a day with nothing left out", () => {
		const el = drawn(THREE_TIMED_ONE_ALL_DAY);
		expect(el.querySelector(".effortless-day-view-problems")).toBeNull();
		expect(el.querySelector(".effortless-day-view-unread")).toBeNull();
	});
});

describe("the fallback sentence", () => {
	it("gives the core's reason in one sentence, and hands back where the text as written goes, beneath it", () => {
		const day = readDay(["Just a line of text", "and another"], COLUMNS);
		if (!("fallback" in day)) throw new Error("expected the fallback");
		const container = document.createElement("div");

		const below = drawFallbackReason(container, day.fallback);

		const sentence = container.querySelector(".effortless-day-view-fallback");
		expect(sentence?.textContent).toBe(
			"Effortless could not read a day here, so it is shown as written. No table names both columns.",
		);
		expect(below.className).toBe("effortless-day-view-fallback-source");
		expect(Array.from(container.children)).toEqual([sentence, below]);
	});
});

describe("the now-line", () => {
	it("is drawn on today's grid at now's height", () => {
		const container = document.createElement("div");
		const result = drawDay(container, THREE_TIMED_ONE_ALL_DAY, { pxPerMinute: NORMAL, today: true, now: at(10, 15) });

		const line = container.querySelector<HTMLElement>(".effortless-day-view-grid > .effortless-day-view-now-line");
		expect(line).not.toBeNull();
		expect(result.nowLine).toBe(line);
		expect(line?.style.top).toBe("135px");
		expect(line?.style.display).toBe("");
	});

	it("is created on today's grid but hidden while now is outside the span", () => {
		const container = document.createElement("div");
		drawDay(container, THREE_TIMED_ONE_ALL_DAY, { pxPerMinute: NORMAL, today: true, now: at(22, 0) });

		const line = container.querySelector<HTMLElement>(".effortless-day-view-now-line");
		expect(line).not.toBeNull();
		expect(line?.classList.contains("effortless-day-view-now-line--hidden")).toBe(true);
	});

	it("is not drawn on any other note's grid", () => {
		const container = document.createElement("div");
		const result = drawDay(container, THREE_TIMED_ONE_ALL_DAY, { pxPerMinute: NORMAL, today: false, now: at(10, 15) });
		expect(container.querySelector(".effortless-day-view-now-line")).toBeNull();
		expect(result.nowLine).toBeNull();
	});
});
