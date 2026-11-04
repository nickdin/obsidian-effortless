import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desiredRowsFor } from "../features/daysAhead/desiredRows";
import { readTimeCell } from "../core/timeCell";
import type { Meeting } from "../core/icsReader";

// Nothing under test here reads the clock — desiredRowsFor takes its day as
// an argument — but issue #696's own criterion says every date and time test
// pins it, so a later change that does read the clock cannot slip through
// unnoticed.
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2026, 7, 20, 12, 0));
});
afterEach(() => vi.useRealTimers());

function localDate(year: number, month: number, day: number): Date {
	return new Date(year, month - 1, day);
}

function localDateTime(year: number, month: number, day: number, hour: number, minute: number): Date {
	return new Date(year, month - 1, day, hour, minute);
}

const DAY = localDate(2026, 8, 20);

function meeting(partial: Partial<Meeting>): Meeting {
	return {
		uid: "uid-1",
		summary: "Standup",
		location: null,
		description: null,
		organizer: null,
		attendees: [],
		occurrenceKey: null,
		allDay: false,
		start: localDateTime(2026, 8, 20, 10, 0),
		end: localDateTime(2026, 8, 20, 11, 0),
		...partial,
	};
}

describe("desiredRowsFor — which meetings get a row", () => {
	it("gives a row to a meeting on the day's own list", () => {
		const rows = desiredRowsFor([meeting({})], [], DAY);
		expect(rows).toHaveLength(1);
		expect(rows[0].uid).toBe("uid-1");
	});

	it("gives no row to a meeting that appears only in the notes list", () => {
		const notesOnly = meeting({ uid: "uid-notes" });
		expect(desiredRowsFor([], [notesOnly], DAY)).toEqual([]);
	});

	it("decides makesNote by uid membership in the notes list, and nothing else", () => {
		const a = meeting({ uid: "uid-a" });
		const b = meeting({
			uid: "uid-b",
			start: localDateTime(2026, 8, 20, 13, 0),
			end: localDateTime(2026, 8, 20, 14, 0),
		});
		const rows = desiredRowsFor([a, b], [a], DAY);
		expect(rows.find((row) => row.uid === "uid-a")?.makesNote).toBe(true);
		expect(rows.find((row) => row.uid === "uid-b")?.makesNote).toBe(false);
	});
});

describe("desiredRowsFor — the clamp on a multi-day meeting", () => {
	// Three calendar days: 20th 22:00 through 22nd 06:00.
	const spanning = meeting({
		start: localDateTime(2026, 8, 20, 22, 0),
		end: localDateTime(2026, 8, 22, 6, 0),
	});

	it("keeps its own start time on its first day, clamped to the day's end", () => {
		const [row] = desiredRowsFor([spanning], [], localDate(2026, 8, 20));
		expect(row.time).toBe("22:00–23:59");
		expect(row.startMin).toBe(22 * 60);
		expect(row.endMin).toBe(23 * 60 + 59);
	});

	it("reads 00:00–23:59 on a middle day", () => {
		const [row] = desiredRowsFor([spanning], [], localDate(2026, 8, 21));
		expect(row.time).toBe("00:00–23:59");
		expect(row.startMin).toBe(0);
		expect(row.endMin).toBe(23 * 60 + 59);
	});

	it("starts at 00:00 on its last day, keeping its own end time", () => {
		const [row] = desiredRowsFor([spanning], [], localDate(2026, 8, 22));
		expect(row.time).toBe("00:00–06:00");
		expect(row.startMin).toBe(0);
		expect(row.endMin).toBe(6 * 60);
	});

	it("round-trips every clamped day's cell through readTimeCell with ok: true", () => {
		for (const day of [localDate(2026, 8, 20), localDate(2026, 8, 21), localDate(2026, 8, 22)]) {
			const [row] = desiredRowsFor([spanning], [], day);
			expect(readTimeCell(row.time).ok).toBe(true);
		}
	});

	it("round-trips a meeting running to midnight, without writing 24:00", () => {
		// Ends at the very start of the 21st: on the 20th this is its last day,
		// clamped to 23:59 rather than the 1440 minutes its own clock would give
		// (comment 5746254606 on issue #696).
		const toMidnight = meeting({
			start: localDateTime(2026, 8, 20, 22, 0),
			end: localDateTime(2026, 8, 21, 0, 0),
		});
		const [row] = desiredRowsFor([toMidnight], [], localDate(2026, 8, 20));
		expect(row.time).toBe("22:00–23:59");
		expect(readTimeCell(row.time)).toEqual({
			ok: true,
			startMin: 22 * 60,
			endMin: 23 * 60 + 59,
			allDay: false,
		});
	});
});

describe("desiredRowsFor — a meeting whose end precedes its start", () => {
	it("clamps the end up to the start, giving a zero-length cell rather than one readTimeCell refuses", () => {
		// icsReader.ts's `touches` deliberately accepts a meeting whose DTEND
		// precedes its DTSTART on the same local day (comment 5746254606 on
		// issue #696 settles the bound: 0..1439 with endMin >= startMin).
		const backwards = meeting({
			start: localDateTime(2026, 8, 20, 14, 0),
			end: localDateTime(2026, 8, 20, 10, 0),
		});
		const [row] = desiredRowsFor([backwards], [], DAY);
		expect(row.time).toBe("14:00–14:00");
		expect(row.startMin).toBe(14 * 60);
		expect(row.endMin).toBe(14 * 60);
		expect(readTimeCell(row.time)).toEqual({
			ok: true,
			startMin: 14 * 60,
			endMin: 14 * 60,
			allDay: false,
		});
	});
});

describe("desiredRowsFor — all-day meetings", () => {
	it("reads 00:00–23:59 and sorts at 0, above a timed meeting", () => {
		const allDay = meeting({
			uid: "uid-allday",
			summary: "Holiday",
			allDay: true,
			start: localDate(2026, 8, 20),
			end: localDate(2026, 8, 20),
		});
		const timed = meeting({ uid: "uid-timed", start: localDateTime(2026, 8, 20, 0, 1), end: localDateTime(2026, 8, 20, 1, 0) });
		const rows = desiredRowsFor([timed, allDay], [], DAY);
		expect(rows.map((row) => row.uid)).toEqual(["uid-allday", "uid-timed"]);
		expect(rows[0].time).toBe("00:00–23:59");
		expect(rows[0].startMin).toBe(0);
	});

	it("reads the same 00:00–23:59 cell on every day a spanning all-day meeting is on", () => {
		const spanning = meeting({ allDay: true, start: localDate(2026, 8, 20), end: localDate(2026, 8, 22) });
		for (const day of [localDate(2026, 8, 20), localDate(2026, 8, 21), localDate(2026, 8, 22)]) {
			const [row] = desiredRowsFor([spanning], [], day);
			expect(row.time).toBe("00:00–23:59");
		}
	});
});

describe("desiredRowsFor — the sort order", () => {
	it("orders by start minute, then end minute", () => {
		const later = meeting({ uid: "uid-later", start: localDateTime(2026, 8, 20, 14, 0), end: localDateTime(2026, 8, 20, 15, 0) });
		const earlier = meeting({ uid: "uid-earlier", start: localDateTime(2026, 8, 20, 9, 0), end: localDateTime(2026, 8, 20, 9, 30) });
		const rows = desiredRowsFor([later, earlier], [], DAY);
		expect(rows.map((row) => row.uid)).toEqual(["uid-earlier", "uid-later"]);
	});

	it("breaks a start-minute tie by end minute", () => {
		const short = meeting({ uid: "uid-short", start: localDateTime(2026, 8, 20, 9, 0), end: localDateTime(2026, 8, 20, 9, 15) });
		const long = meeting({ uid: "uid-long", start: localDateTime(2026, 8, 20, 9, 0), end: localDateTime(2026, 8, 20, 10, 0) });
		const rows = desiredRowsFor([long, short], [], DAY);
		expect(rows.map((row) => row.uid)).toEqual(["uid-short", "uid-long"]);
	});

	it("breaks a start/end tie by the event cell's text, compared by code unit rather than by locale", () => {
		// 'F' is U+0046, 'É' is U+00C9: by code unit "Fig meeting" sorts first.
		// A locale-aware compare would put "Éclair meeting" first instead, since
		// É collates beside E in both Swedish and the default locale.
		const fig = meeting({ uid: "uid-fig", summary: "Fig meeting" });
		const eclair = meeting({ uid: "uid-eclair", summary: "Éclair meeting" });
		const rows = desiredRowsFor([eclair, fig], [], DAY);
		expect(rows.map((row) => row.uid)).toEqual(["uid-fig", "uid-eclair"]);
	});

	it("breaks a start/end/text tie by uid, in code-unit order", () => {
		const b = meeting({ uid: "uid-b" });
		const a = meeting({ uid: "uid-a" });
		const rows = desiredRowsFor([b, a], [], DAY);
		expect(rows.map((row) => row.uid)).toEqual(["uid-a", "uid-b"]);
	});
});
