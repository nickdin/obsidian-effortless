import { describe, expect, it } from "vitest";
import { readTimeCell, writeTimeCell } from "../core/timeCell";

describe("readTimeCell — ranges", () => {
	it("reads a range with the en dash", () => {
		expect(readTimeCell("09:00–10:30")).toEqual({
			ok: true,
			startMin: 540,
			endMin: 630,
			allDay: false,
		});
	});

	it("reads a range with the hyphen", () => {
		expect(readTimeCell("09:00-10:30")).toEqual({
			ok: true,
			startMin: 540,
			endMin: 630,
			allDay: false,
		});
	});

	it("tolerates spaces around either dash", () => {
		expect(readTimeCell("09:00 – 10:30")).toEqual({
			ok: true,
			startMin: 540,
			endMin: 630,
			allDay: false,
		});
		expect(readTimeCell("09:00 - 10:30")).toEqual({
			ok: true,
			startMin: 540,
			endMin: 630,
			allDay: false,
		});
	});

	it("reads a single-digit hour", () => {
		expect(readTimeCell("9:00–10:00")).toEqual({
			ok: true,
			startMin: 540,
			endMin: 600,
			allDay: false,
		});
	});
});

describe("readTimeCell — hour and minute bounds", () => {
	it("refuses an hour of 24 as not-a-time", () => {
		expect(readTimeCell("09:00–24:00")).toEqual({ ok: false, reason: "not-a-time" });
	});

	it("refuses a minute of 60 as not-a-time", () => {
		expect(readTimeCell("09:60–10:00")).toEqual({ ok: false, reason: "not-a-time" });
	});
});

describe("readTimeCell — order", () => {
	it("refuses an end before its start as backwards", () => {
		expect(readTimeCell("10:00–09:00")).toEqual({ ok: false, reason: "backwards" });
	});

	it("accepts an end equal to its start as a real, very short meeting", () => {
		expect(readTimeCell("09:00–09:00")).toEqual({
			ok: true,
			startMin: 540,
			endMin: 540,
			allDay: false,
		});
	});
});

describe("readTimeCell — all day", () => {
	it("reads 00:00–23:59 with the en dash as all day", () => {
		expect(readTimeCell("00:00–23:59")).toEqual({
			ok: true,
			startMin: 0,
			endMin: 1439,
			allDay: true,
		});
	});

	it("reads 00:00-23:59 with the hyphen as all day", () => {
		expect(readTimeCell("00:00-23:59")).toEqual({
			ok: true,
			startMin: 0,
			endMin: 1439,
			allDay: true,
		});
	});

	it.each(["heldag", "Heldag", "HELDAG"])("reads %j as all day", (cell) => {
		expect(readTimeCell(cell)).toEqual({
			ok: true,
			startMin: 0,
			endMin: 1439,
			allDay: true,
		});
	});
});

describe("readTimeCell — not a time", () => {
	it("refuses a blank cell", () => {
		expect(readTimeCell("")).toEqual({ ok: false, reason: "not-a-time" });
	});

	it("refuses a lone time", () => {
		expect(readTimeCell("09:00")).toEqual({ ok: false, reason: "not-a-time" });
	});

	it("refuses a word", () => {
		expect(readTimeCell("planering")).toEqual({ ok: false, reason: "not-a-time" });
	});
});

describe("writeTimeCell — all day", () => {
	it("writes 00:00–23:59 with the en dash", () => {
		expect(writeTimeCell(0, 23 * 60 + 59, true)).toBe("00:00–23:59");
	});

	it("writes 00:00–23:59 whatever minutes it is handed", () => {
		expect(writeTimeCell(540, 630, true)).toBe("00:00–23:59");
	});
});

describe("writeTimeCell — timed", () => {
	it("zero-pads a single-digit hour and a single-digit minute", () => {
		expect(writeTimeCell(8 * 60 + 9, 9 * 60, false)).toBe("08:09–09:00");
	});

	it("writes both times when the end equals the start", () => {
		expect(writeTimeCell(540, 540, false)).toBe("09:00–09:00");
	});
});

describe("writeTimeCell and readTimeCell — round trip", () => {
	it.each([
		{ startMin: 0, endMin: 23 * 60 + 59, allDay: true },
		{ startMin: 540, endMin: 630, allDay: false },
		{ startMin: 8 * 60 + 9, endMin: 8 * 60 + 45, allDay: false },
		{ startMin: 0, endMin: 0, allDay: false },
		{ startMin: 23 * 60 + 59, endMin: 23 * 60 + 59, allDay: false },
	])("reads back %j", ({ startMin, endMin, allDay }) => {
		const written = writeTimeCell(startMin, endMin, allDay);
		expect(readTimeCell(written)).toEqual({ ok: true, startMin, endMin, allDay });
	});
});
