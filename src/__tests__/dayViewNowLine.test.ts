/**
 * The now-line's two pure halves: which note is today's log, and where the line
 * sits on a grid at a given minute.
 *
 * **Today's log is the note the core's layout names for today**, never a note
 * whose name merely looks like a date: the old plugin drew the line on any note
 * named `YYYY-MM-DD` anywhere in the vault, and that is named difference 7.
 * With the daily-log folder or filename unanswered, no note is today's log.
 *
 * Every date is built from local parts and read back the same way, never
 * through `toISOString`: the server runs on Europe/Stockholm, and a local
 * midnight formatted as UTC reads as the day before. The folder and the dates
 * are invented.
 */

import { describe, expect, it } from "vitest";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { NOW_LINE_HIDDEN_CLASS, isTodaysLog, placeNowLine } from "../features/dayView/nowLine";

/** A local moment, from local parts. */
const at = (y: number, m: number, d: number, h = 0, min = 0): Date => new Date(y, m - 1, d, h, min);

/** The shipped layout with the two daily-log answers given. */
function layoutWith(folder: string, filename: string): VaultLayout {
	return { ...defaultData().core.layout, dailyLogFolder: folder, dailyLogFilename: filename };
}

const ANSWERED = layoutWith("Logbook", "YYYY-MM-DD");
const NOW = at(2031, 4, 9, 10, 15);

describe("isTodaysLog", () => {
	it("answers yes for today's log under the configured folder and filename", () => {
		expect(isTodaysLog("Logbook/2031-04-09.md", ANSWERED, NOW)).toBe(true);
	});

	it("answers no for yesterday's log", () => {
		expect(isTodaysLog("Logbook/2031-04-08.md", ANSWERED, NOW)).toBe(false);
	});

	it("answers no for a note named like today outside the configured folder (named difference 7)", () => {
		expect(isTodaysLog("Elsewhere/2031-04-09.md", ANSWERED, NOW)).toBe(false);
		expect(isTodaysLog("2031-04-09.md", ANSWERED, NOW)).toBe(false);
	});

	it("answers yes for today's log under a filename pattern whose name is not exactly YYYY-MM-DD (named difference 7)", () => {
		const nested = layoutWith("Logbook", "YYYY/MM/YYYY-MM-DD");
		expect(isTodaysLog("Logbook/2031/04/2031-04-09.md", nested, NOW)).toBe(true);
	});

	it("answers no for every note while the layout is unanswered", () => {
		expect(isTodaysLog("Logbook/2031-04-09.md", layoutWith("", ""), NOW)).toBe(false);
		expect(isTodaysLog("2031-04-09.md", layoutWith("", ""), NOW)).toBe(false);
		expect(isTodaysLog("Logbook/2031-04-09.md", layoutWith("Logbook", ""), NOW)).toBe(false);
		expect(isTodaysLog("2031-04-09.md", layoutWith("", "YYYY-MM-DD"), NOW)).toBe(false);
	});

	it("reads today as the local day, just after midnight and just before the next one", () => {
		expect(isTodaysLog("Logbook/2031-04-09.md", ANSWERED, at(2031, 4, 9, 0, 1))).toBe(true);
		expect(isTodaysLog("Logbook/2031-04-09.md", ANSWERED, at(2031, 4, 9, 23, 59))).toBe(true);
	});
});

describe("placeNowLine", () => {
	/** A grid 08:00–17:00 at one pixel a minute. */
	const span = { startMin: 8 * 60, endMin: 17 * 60 };

	it("puts the line at the minute's height inside the span, and shows it by removing the hidden class (not a fixed inline style — #652)", () => {
		const line = document.createElement("div");
		line.classList.add(NOW_LINE_HIDDEN_CLASS);

		placeNowLine(line, span, 1, at(2031, 4, 9, 10, 15));

		expect(line.classList.contains(NOW_LINE_HIDDEN_CLASS)).toBe(false);
		expect(line.style.top).toBe(`${10 * 60 + 15 - 8 * 60}px`);
	});

	it("scales the height by the density's pixels per minute", () => {
		const line = document.createElement("div");
		placeNowLine(line, span, 1.5, at(2031, 4, 9, 9, 0));
		expect(line.style.top).toBe("90px");
	});

	it("hides the line, by its class rather than a fixed inline style, while now is before the span, and after it", () => {
		const early = document.createElement("div");
		placeNowLine(early, span, 1, at(2031, 4, 9, 6, 30));
		expect(early.classList.contains(NOW_LINE_HIDDEN_CLASS)).toBe(true);
		expect(early.style.display).not.toBe("none");

		const late = document.createElement("div");
		placeNowLine(late, span, 1, at(2031, 4, 9, 21, 0));
		expect(late.classList.contains(NOW_LINE_HIDDEN_CLASS)).toBe(true);
		expect(late.style.display).not.toBe("none");
	});

	it("shows the line on the span's two edges", () => {
		const first = document.createElement("div");
		placeNowLine(first, span, 1, at(2031, 4, 9, 8, 0));
		expect(first.classList.contains(NOW_LINE_HIDDEN_CLASS)).toBe(false);
		expect(first.style.top).toBe("0px");

		const last = document.createElement("div");
		placeNowLine(last, span, 1, at(2031, 4, 9, 17, 0));
		expect(last.classList.contains(NOW_LINE_HIDDEN_CLASS)).toBe(false);
		expect(last.style.top).toBe(`${9 * 60}px`);
	});
});
