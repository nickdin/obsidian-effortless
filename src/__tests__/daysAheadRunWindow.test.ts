import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { windowDates } from "../features/daysAhead/window";

// Nothing under test here reads the clock — windowDates takes `today` as an
// argument — but every date and time test in this feature pins it, so a
// later change that does read the clock cannot slip through unnoticed.
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2026, 7, 20, 12, 0));
});
afterEach(() => vi.useRealTimers());

function localDate(year: number, month: number, day: number): Date {
	return new Date(year, month - 1, day);
}

function keysOf(dates: readonly Date[]): string[] {
	return dates.map((date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`);
}

describe("windowDates", () => {
	it("answers one date, today, for a one-day window", () => {
		const dates = windowDates(localDate(2026, 8, 20), 1);
		expect(keysOf(dates)).toEqual(["2026-08-20"]);
	});

	it("answers seven dates from today, oldest first", () => {
		const dates = windowDates(localDate(2026, 8, 20), 7);
		expect(keysOf(dates)).toEqual([
			"2026-08-20",
			"2026-08-21",
			"2026-08-22",
			"2026-08-23",
			"2026-08-24",
			"2026-08-25",
			"2026-08-26",
		]);
	});

	it("answers sixty dates from today, the widest window the settings field allows", () => {
		const dates = windowDates(localDate(2026, 1, 1), 60);
		expect(dates).toHaveLength(60);
		expect(keysOf(dates)[0]).toBe("2026-01-01");
		expect(keysOf(dates)[59]).toBe("2026-03-01");
	});

	it("never answers a date before today", () => {
		const dates = windowDates(localDate(2026, 8, 20), 7);
		for (const date of dates) expect(date.getTime()).toBeGreaterThanOrEqual(localDate(2026, 8, 20).getTime());
	});

	it("carries a window across a month end", () => {
		const dates = windowDates(localDate(2026, 8, 29), 5);
		expect(keysOf(dates)).toEqual(["2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"]);
	});

	it("carries a window across the end of a leap February", () => {
		const dates = windowDates(localDate(2028, 2, 27), 4);
		expect(keysOf(dates)).toEqual(["2028-02-27", "2028-02-28", "2028-02-29", "2028-03-01"]);
	});

	it("carries a window across a daylight-saving change without losing or repeating a day", () => {
		// Europe/Stockholm moves its clocks forward on the last Sunday of
		// March — 2026-03-29 — so this window crosses the one day of the year
		// with only 23 local hours in it.
		const dates = windowDates(localDate(2026, 3, 27), 5);
		expect(keysOf(dates)).toEqual(["2026-03-27", "2026-03-28", "2026-03-29", "2026-03-30", "2026-03-31"]);
	});
});
