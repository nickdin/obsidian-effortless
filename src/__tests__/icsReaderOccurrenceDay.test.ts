/**
 * `originalDayOf`: the day an occurrence of a repeating meeting was
 * on before anyone moved it, read back from the key the core itself writes
 * (`Meeting.occurrenceKey`). Building the days ahead asks it to tell a
 * moved occurrence's old row from a cancelled one's, and asks the core
 * rather than reading the key's shape itself, since that shape is the
 * core's to change (`keyOf` in `icsOccurrences.ts`).
 *
 * Read from real calendar text, so the keys are the ones the reader writes;
 * this file runs in both pinned zones (`vitest.config.mts`), where a key
 * read as midnight UTC would land on the wrong day in one of them.
 */

import { describe, expect, it } from "vitest";
import { originalDayOf, readSpanLosing } from "../core/icsReader";
import type { Meeting } from "../core/icsReader";

function ics(...events: string[][]): string {
	const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Effortless//Test//EN"];
	for (const event of events) lines.push("BEGIN:VEVENT", "DTSTAMP:20261001T120000Z", ...event, "END:VEVENT");
	lines.push("END:VCALENDAR", "");
	return lines.join("\r\n");
}

function days(meetings: readonly Meeting[]): Array<[string, string | null]> {
	return meetings
		.map((meeting): [string, string | null] => [meeting.summary, originalDayOf(meeting)])
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

describe("originalDayOf", () => {
	it("answers a timed occurrence moved to another day with the day it was moved from", () => {
		const text = ics(
			["UID:daily", "DTSTART:20261020T090000", "DTEND:20261020T093000", "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Daily"],
			["UID:daily", "RECURRENCE-ID:20261021T090000", "DTSTART:20261023T130000", "DTEND:20261023T133000", "SUMMARY:Daily, moved"],
		);
		const read = readSpanLosing(text, new Date(2026, 9, 20), 5);

		expect(days(read.meetings)).toEqual([
			["Daily", "2026-10-20"],
			["Daily", "2026-10-22"],
			["Daily, moved", "2026-10-21"],
		]);
	});

	it("answers an all-day occurrence moved to another day with the day it was moved from", () => {
		const text = ics(
			["UID:leave", "DTSTART;VALUE=DATE:20261020", "DTEND;VALUE=DATE:20261021", "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Leave"],
			["UID:leave", "RECURRENCE-ID;VALUE=DATE:20261021", "DTSTART;VALUE=DATE:20261023", "DTEND;VALUE=DATE:20261024", "SUMMARY:Leave, moved"],
		);
		const read = readSpanLosing(text, new Date(2026, 9, 20), 5);

		expect(days(read.meetings)).toEqual([
			["Leave", "2026-10-20"],
			["Leave", "2026-10-22"],
			["Leave, moved", "2026-10-21"],
		]);
	});

	it("answers null for a meeting that does not repeat", () => {
		const text = ics(["UID:once", "DTSTART:20261020T090000", "DTEND:20261020T093000", "SUMMARY:Once"]);
		expect(days(readSpanLosing(text, new Date(2026, 9, 20), 1).meetings)).toEqual([["Once", null]]);
	});
});
