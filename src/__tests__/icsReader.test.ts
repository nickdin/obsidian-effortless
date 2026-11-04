/**
 * The calendar reader, driven the way a feature will drive it: bytes in, a
 * day's meetings out.
 *
 * Every case is a real `.ics` file under `__fixtures__/`, because the whole
 * point of this piece is that it survives what calendar servers actually emit.
 * The fixtures are CRLF, as RFC 5545 requires, except `second-calendar.ics`,
 * which is LF on purpose — a file dropped into the vault by hand often is.
 *
 * Assertions about timed meetings compare absolute instants, and assertions
 * about all-day meetings compare local year/month/day. Both hold whatever
 * timezone the machine running the tests is in.
 */

import { describe, expect, it, vi } from "vitest";
import { fixture } from "./fixtures";
import { endsAtOf, IcsReadError, readDay, readDayFromAll } from "../core/icsReader";
import type { DayReading, Meeting } from "../core/icsReader";

/** A local calendar day, which is what `readDay` asks for. */
function day(year: number, month: number, date: number): Date {
	return new Date(year, month - 1, date);
}

function summaries(meetings: readonly Meeting[]): string[] {
	return meetings.map((meeting) => meeting.summary);
}

/** `broken-event.ics` with its two readable events taken out, so nothing survives. */
function everyEventBroken(): string {
	return fixture("broken-event.ics").replace(/BEGIN:VEVENT\r\nUID:kept-[\s\S]*?END:VEVENT\r\n/g, "");
}

/**
 * A calendar of `count` events that every one of them refuses to read, built
 * here rather than kept as a fixture because the count is what is under test.
 */
function nothingReadable(count: number): string {
	const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Effortless//Test//EN"];
	for (let n = 0; n < count; n += 1) {
		lines.push(
			"BEGIN:VEVENT",
			`UID:bad-${n}@effortless.test`,
			"DTSTAMP:20260901T120000Z",
			"DTSTART:20260908T090000Z",
			"DTEND:20260908T093000Z",
			"RRULE:FREQ=NONSENSE;COUNT=3",
			`SUMMARY:Unreadable ${n}`,
			"END:VEVENT",
		);
	}
	lines.push("END:VCALENDAR", "");
	return lines.join("\r\n");
}

/**
 * A calendar holding one weekly repeat that reads and one entry that does not.
 *
 * Built here rather than kept as a fixture because what is under test is the
 * *unit* the loss sentence counts in: two entries, one of which stands for
 * however many mornings the repeat lands on.
 */
function oneRepeatAndOneBroken(): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Effortless//Test//EN",
		"BEGIN:VEVENT",
		"UID:weekly@effortless.test",
		"DTSTAMP:20260901T120000Z",
		"DTSTART:20260901T090000Z",
		"DTEND:20260901T093000Z",
		"RRULE:FREQ=WEEKLY;COUNT=10",
		"SUMMARY:Stand-up",
		"END:VEVENT",
		"BEGIN:VEVENT",
		"UID:bad-rule@effortless.test",
		"DTSTAMP:20260901T120000Z",
		"DTSTART:20260908T110000Z",
		"DTEND:20260908T113000Z",
		"RRULE:FREQ=NONSENSE;COUNT=3",
		"SUMMARY:Repeats by a rule nobody can read",
		"END:VEVENT",
		"END:VCALENDAR",
		"",
	].join("\r\n");
}

/** The local calendar day a `Date` falls on, as `YYYY-MM-DD`. */
function localDate(at: Date): string {
	const month = String(at.getMonth() + 1).padStart(2, "0");
	const date = String(at.getDate()).padStart(2, "0");
	return `${at.getFullYear()}-${month}-${date}`;
}

describe("readDay", () => {
	it("reads a day's meetings out of .ics bytes, earliest first", () => {
		const meetings = readDay(fixture("one-day.ics"), day(2026, 9, 8));

		expect(summaries(meetings)).toEqual(["Morning review", "Afternoon call"]);
		expect(meetings[0].start.toISOString()).toBe("2026-09-08T09:00:00.000Z");
		expect(meetings[0].end.toISOString()).toBe("2026-09-08T10:00:00.000Z");
		expect(meetings[0].uid).toBe("one@effortless.test");
		expect(meetings[0].location).toBe("Room 2");
		expect(meetings[0].description).toBe("The weekly look at the board.");
		expect(meetings[0].allDay).toBe(false);
	});

	it("leaves out a day the calendar has nothing on", () => {
		expect(readDay(fixture("one-day.ics"), day(2026, 9, 9))).toEqual([]);
	});

	it("carries no location or description when the event gives none", () => {
		const [, call] = readDay(fixture("one-day.ics"), day(2026, 9, 8));

		expect(call.location).toBeNull();
		expect(call.description).toBeNull();
	});

	it("expands a repeating meeting into its occurrences", () => {
		const ics = fixture("repeating.ics");

		expect(summaries(readDay(ics, day(2026, 9, 7)))).toEqual(["Standup"]);
		expect(summaries(readDay(ics, day(2026, 9, 28)))).toEqual(["Standup"]);
	});

	it("stops expanding where the repeat stops", () => {
		expect(readDay(fixture("repeating.ics"), day(2026, 10, 5))).toEqual([]);
	});

	it("leaves out an occurrence the calendar cancelled with EXDATE", () => {
		expect(readDay(fixture("repeating.ics"), day(2026, 9, 14))).toEqual([]);
	});

	it("leaves out an occurrence cancelled by an override that says so", () => {
		const ics = fixture("cancelled.ics");

		expect(summaries(readDay(ics, day(2026, 9, 7)))).toEqual(["Daily check"]);
		expect(readDay(ics, day(2026, 9, 8))).toEqual([]);
		expect(summaries(readDay(ics, day(2026, 9, 9)))).toEqual(["Daily check"]);
	});

	it("leaves out a whole meeting the calendar marked cancelled", () => {
		expect(summaries(readDay(fixture("cancelled.ics"), day(2026, 9, 7)))).not.toContain(
			"Workshop that was called off",
		);
	});

	it("lets a one-off changed occurrence override the pattern", () => {
		const [moved] = readDay(fixture("repeating.ics"), day(2026, 9, 21));

		expect(moved.summary).toBe("Standup, moved to eleven");
		expect(moved.start.toISOString()).toBe("2026-09-21T09:00:00.000Z");
	});

	it("resolves a meeting's timezone, so the time is the time it happens", () => {
		// 09:00 in Europe/Stockholm, which is two hours ahead of UTC in September.
		const [standup] = readDay(fixture("repeating.ics"), day(2026, 9, 7));

		expect(standup.start.toISOString()).toBe("2026-09-07T07:00:00.000Z");
		expect(standup.end.toISOString()).toBe("2026-09-07T07:30:00.000Z");
	});

	it("ends an all-day meeting on the day it is on, not the morning after", () => {
		const ics = fixture("all-day.ics");
		const [holiday] = readDay(ics, day(2026, 9, 8));

		expect(holiday.summary).toBe("Public holiday");
		expect(holiday.allDay).toBe(true);
		expect(localDate(holiday.start)).toBe("2026-09-08");
		expect(localDate(holiday.end)).toBe("2026-09-08");
		expect(readDay(ics, day(2026, 9, 9))).toEqual([]);
	});

	it("keeps an all-day meeting on every day it covers", () => {
		const ics = fixture("all-day.ics");

		expect(summaries(readDay(ics, day(2026, 9, 10)))).toEqual(["Away three days"]);
		expect(summaries(readDay(ics, day(2026, 9, 11)))).toEqual(["Away three days"]);
		expect(summaries(readDay(ics, day(2026, 9, 12)))).toEqual(["Away three days"]);
		expect(readDay(ics, day(2026, 9, 13))).toEqual([]);
	});

	it("treats an all-day meeting with no end as one day long", () => {
		const ics = fixture("all-day.ics");
		const [oneDay] = readDay(ics, day(2026, 9, 15));

		expect(oneDay.summary).toBe("One day, no end given");
		expect(localDate(oneDay.end)).toBe("2026-09-15");
		expect(readDay(ics, day(2026, 9, 16))).toEqual([]);
	});

	it("puts an all-day meeting above the timed ones", () => {
		const ics = fixture("one-day.ics").replace(
			"END:VCALENDAR",
			[
				"BEGIN:VEVENT",
				"UID:whole-day@effortless.test",
				"DTSTART;VALUE=DATE:20260908",
				"DTEND;VALUE=DATE:20260909",
				"SUMMARY:All day",
				"END:VEVENT",
				"END:VCALENDAR",
			].join("\r\n"),
		);

		expect(summaries(readDay(ics, day(2026, 9, 8)))).toEqual([
			"All day",
			"Morning review",
			"Afternoon call",
		]);
	});

	it("reads the other events when one of them is malformed", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const meetings = readDay(fixture("broken-event.ics"), day(2026, 9, 8));

			expect(summaries(meetings)).toEqual([
				"Kept, before the bad ones",
				"Kept, after the bad ones",
			]);
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("fails with a reason when the file is not a calendar at all", () => {
		expect(() => readDay(fixture("not-a-calendar.ics"), day(2026, 9, 8))).toThrow(IcsReadError);
	});

	it("fails with a reason when the file is iCalendar but holds no calendar", () => {
		expect(() => readDay(fixture("vcard.ics"), day(2026, 9, 8))).toThrow(/BEGIN:VCALENDAR/);
	});

	it("fails with a reason when the calendar stops partway through", () => {
		// Half a download. There is no whole event to fall back on, so an empty
		// day would be a lie about what the calendar says.
		expect(() => readDay(fixture("truncated.ics"), day(2026, 9, 8))).toThrow(IcsReadError);
	});

	// **Rewritten deliberately for issue #53.** This test used to assert that a
	// calendar whose every event failed to read came back as a clean empty day,
	// with the loss said only to the developer console. That made a calendar
	// nobody can read look exactly like a day with nothing on it, and the
	// console is closed in normal use, so nobody ever saw the difference.
	// `readDay` still answers with the events it could read — none, here — and
	// the loss is reported by `readDayFromAll`, which is the call that has
	// somewhere to put it.
	it("reports the loss rather than a clean empty day when no event survives", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const ics = everyEventBroken();

			expect(readDay(ics, day(2026, 9, 8))).toEqual([]);

			const reading = readDayFromAll([ics], day(2026, 9, 8));
			expect(reading.meetings).toEqual([]);
			expect(reading.failures).toHaveLength(1);
			expect(reading.failures[0].index).toBe(0);
			expect(reading.failures[0].reason).toBe(
				"None of the 2 entries in this calendar could be read — a repeating meeting " +
					"counts as one entry.",
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("fails with a reason when there are no bytes at all", () => {
		expect(() => readDay("", day(2026, 9, 8))).toThrow(IcsReadError);
		expect(() => readDay("   \r\n  ", day(2026, 9, 8))).toThrow(IcsReadError);
	});

	it("reads a calendar written with plain line endings", () => {
		expect(summaries(readDay(fixture("second-calendar.ics"), day(2026, 9, 8)))).toEqual([
			"Dentist",
		]);
	});
});

describe("who was invited", () => {
	it("reads an organiser and three attendees back with their names and addresses", () => {
		const [meeting] = readDay(fixture("invited.ics"), day(2026, 9, 8));

		expect(meeting.organizer).toEqual({ name: "Ada Invented", email: "ada@invented.test" });
		expect(meeting.attendees).toEqual([
			{ name: "Bea Invented", email: "bea@invented.test" },
			{ name: "Cleo Invented", email: "cleo@invented.test" },
			{ name: "Dax Invented", email: "dax@invented.test" },
		]);
	});

	it("gives an attendee with no CN an empty name and its address", () => {
		const [meeting] = readDay(fixture("invited-edge-cases.ics"), day(2026, 9, 8));

		expect(meeting.summary).toBe("No name given");
		expect(meeting.attendees).toEqual([{ name: "", email: "nameless@invented.test" }]);
	});

	it("answers organizer null when the event names no ORGANIZER", () => {
		const [, meeting] = readDay(fixture("invited-edge-cases.ics"), day(2026, 9, 8));

		expect(meeting.summary).toBe("No organiser named");
		expect(meeting.organizer).toBeNull();
	});

	it("answers an empty attendees list when the event carries no ATTENDEE line", () => {
		const [, , meeting] = readDay(fixture("invited-edge-cases.ics"), day(2026, 9, 8));

		expect(meeting.summary).toBe("Nobody invited");
		expect(meeting.attendees).toEqual([]);
	});

	it("carries a non-mailto: organizer value as the text as-is", () => {
		const [, , , meeting] = readDay(fixture("invited-edge-cases.ics"), day(2026, 9, 8));

		expect(meeting.summary).toBe("Organiser given as an odd address");
		expect(meeting.organizer).toEqual({
			name: "Odd Invented",
			email: "urn:uuid:not-a-mailto-address",
		});
	});

	it("replaces the series' attendees with the override's for the one occurrence it replaces, and no other", () => {
		const ics = fixture("invited-recurrence.ics");
		const seriesGuest = [{ name: "Series Guest", email: "guest@invented.test" }];
		const overrideGuest = [{ name: "Override Guest", email: "override-guest@invented.test" }];

		expect(readDay(ics, day(2026, 9, 7))[0].attendees).toEqual(seriesGuest);
		expect(readDay(ics, day(2026, 9, 8))[0].attendees).toEqual(overrideGuest);
		expect(readDay(ics, day(2026, 9, 9))[0].attendees).toEqual(seriesGuest);
	});
});

describe("an occurrence's own identity", () => {
	it("reads back a non-repeating meeting with a null occurrence key", () => {
		const [meeting] = readDay(fixture("one-day.ics"), day(2026, 9, 8));

		expect(meeting.occurrenceKey).toBeNull();
	});

	it("gives three weeks of a weekly meeting three different keys, each its own original start", () => {
		const ics = fixture("weekly-keys.ics");

		const [first] = readDay(ics, day(2026, 9, 7));
		const [second] = readDay(ics, day(2026, 9, 14));
		const [third] = readDay(ics, day(2026, 9, 21));

		expect(first.occurrenceKey).toBe("2026-09-07T09:00:00.000Z");
		expect(second.occurrenceKey).toBe("2026-09-14T09:00:00.000Z");
		expect(third.occurrenceKey).toBe("2026-09-21T09:00:00.000Z");
		expect(new Set([first.occurrenceKey, second.occurrenceKey, third.occurrenceKey]).size).toBe(3);
	});

	it("keeps a moved occurrence's original key on its new day, and clears its old one", () => {
		const ics = fixture("moved-occurrence-key.ics");

		expect(readDay(ics, day(2026, 9, 14))).toEqual([]);

		const [moved] = readDay(ics, day(2026, 9, 16));
		expect(moved.summary).toBe("Weekly key check, moved to Wednesday");
		expect(moved.occurrenceKey).toBe("2026-09-14T09:00:00.000Z");

		const [unmovedFirst] = readDay(ics, day(2026, 9, 7));
		const [unmovedLast] = readDay(ics, day(2026, 9, 21));
		expect(unmovedFirst.occurrenceKey).toBe("2026-09-07T09:00:00.000Z");
		expect(unmovedLast.occurrenceKey).toBe("2026-09-21T09:00:00.000Z");
	});

	it("does not leak a cancelled override's key onto the occurrences either side of it", () => {
		// `cancelled.ics` is a daily repeat at 08:00Z on 7, 8 and 9 September,
		// with the 8th cancelled by a RECURRENCE-ID override carrying
		// STATUS:CANCELLED. If cancelling it ever leaked its own key — 8
		// September's — onto a neighbour instead of dropping the occurrence
		// whole, one of these two would report it instead of its own day.
		const ics = fixture("cancelled.ics");

		const [before] = readDay(ics, day(2026, 9, 7));
		const [after] = readDay(ics, day(2026, 9, 9));

		expect(before.occurrenceKey).toBe("2026-09-07T08:00:00.000Z");
		expect(after.occurrenceKey).toBe("2026-09-09T08:00:00.000Z");
	});
});

describe("readDayFromAll", () => {
	it("merges several calendars into one view of the day", () => {
		const reading = readDayFromAll(
			[fixture("one-day.ics"), fixture("second-calendar.ics"), fixture("all-day.ics")],
			day(2026, 9, 8),
		);

		expect(summaries(reading.meetings)).toEqual([
			"Public holiday",
			"Morning review",
			"Dentist",
			"Afternoon call",
		]);
		expect(reading.failures).toEqual([]);
	});

	it("keeps the calendars that read when one of them does not", () => {
		const reading = readDayFromAll(
			[fixture("not-a-calendar.ics"), fixture("one-day.ics")],
			day(2026, 9, 8),
		);

		expect(summaries(reading.meetings)).toEqual(["Morning review", "Afternoon call"]);
		expect(reading.failures).toHaveLength(1);
		expect(reading.failures[0].index).toBe(0);
		expect(reading.failures[0].reason).not.toBe("");
	});

	it("reads nothing and reports nothing when given no calendars", () => {
		expect(readDayFromAll([], day(2026, 9, 8))).toEqual({ meetings: [], failures: [] });
	});

	it("reports the events a calendar lost while still giving the ones it read", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const reading = readDayFromAll([fixture("broken-event.ics")], day(2026, 9, 8));

			expect(summaries(reading.meetings)).toEqual([
				"Kept, before the bad ones",
				"Kept, after the bad ones",
			]);
			expect(reading.failures).toHaveLength(1);
			expect(reading.failures[0].index).toBe(0);
			expect(reading.failures[0].reason).toMatch(/could not be read/);
		} finally {
			warn.mockRestore();
		}
	});

	it("reports no failure for a calendar that read cleanly and had nothing that day", () => {
		const reading = readDayFromAll([fixture("one-day.ics")], day(2026, 9, 9));

		expect(reading.meetings).toEqual([]);
		expect(reading.failures).toEqual([]);
	});

	// **Issue #143.** The number in this sentence counts UID groups, and a
	// repeating series is one group however many mornings it lands on. Calling
	// them "events" told someone with a weekly stand-up and one broken entry
	// that "1 of 2 events" was missing while their week held sixty meetings.
	// Counting occurrences is not available: a dropped group is dropped because
	// it will not parse, so how many it would have expanded to does not exist.
	it("counts entries rather than events, and says a repeat counts once", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const reading = readDayFromAll([oneRepeatAndOneBroken()], day(2026, 9, 8));

			expect(summaries(reading.meetings)).toEqual(["Stand-up"]);
			expect(reading.failures).toHaveLength(1);
			expect(reading.failures[0].reason).toBe(
				"1 of 2 entries in this calendar could not be read — a repeating meeting counts " +
					"as one entry. Every other entry in it was read.",
			);
			expect(reading.failures[0].reason).not.toMatch(/\bevents?\b/);
		} finally {
			warn.mockRestore();
		}
	});

	it("says how many events were lost when every one of them was", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const reading = readDayFromAll([nothingReadable(3), nothingReadable(1)], day(2026, 9, 8));

			expect(reading.meetings).toEqual([]);
			expect(reading.failures.map((failure) => failure.reason)).toEqual([
				"None of the 3 entries in this calendar could be read — a repeating meeting " +
					"counts as one entry.",
				"The only entry in this calendar could not be read — a repeating meeting counts " +
					"as one entry.",
			]);
		} finally {
			warn.mockRestore();
		}
	});

	// **Issue #134.** The sentence alone cannot tell a calendar that lost one
	// entry from one that lost all of them, and the settings row and the
	// draw-failure console line both have to. The grade travels beside it.
	it("says whether the loss was partial or total, beside the sentence", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const reading = readDayFromAll(
				[fixture("broken-event.ics"), nothingReadable(3), fixture("one-day.ics")],
				day(2026, 9, 8),
			);

			expect(reading.failures.map((failure) => [failure.index, failure.loss])).toEqual([
				[0, "partial"],
				[1, "total"],
			]);
		} finally {
			warn.mockRestore();
		}
	});

	it("leaves the loss grade off a calendar that would not read at all", () => {
		const reading = readDayFromAll([fixture("not-a-calendar.ics")], day(2026, 9, 8));

		expect(reading.failures).toHaveLength(1);
		expect(reading.failures[0].loss).toBeUndefined();
	});

	// **Issues #53 and #207.** A half-downloaded calendar is the case that held
	// #53 open: the file stops inside its second entry, so that entry is there in
	// the bytes and nowhere in the read. It used to arrive here as the one
	// meeting it read and no failure at all — a calendar that lost an event
	// reporting a clean read, which is the single thing this function exists to
	// prevent. `splitByUid` counts the unfinished block now rather than
	// discarding it, and this pins the whole way out to a caller.
	it("reports the loss when a calendar stops in the middle of an entry", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const reading = readDayFromAll(
				[fixture("one-day.ics"), fixture("truncated-after-one.ics")],
				day(2026, 9, 8),
			);

			expect(summaries(reading.meetings)).toContain("Read before the cut");
			expect(reading.failures).toHaveLength(1);
			expect(reading.failures[0].index).toBe(1);
			expect(reading.failures[0].loss).toBe("partial");
			expect(reading.failures[0].reason).toBe(
				"1 of 2 entries in this calendar could not be read — a repeating meeting counts " +
					"as one entry. Every other entry in it was read.",
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("names a calendar that lost events by its place in the list handed in", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const reading = readDayFromAll(
				[fixture("one-day.ics"), everyEventBroken(), fixture("second-calendar.ics")],
				day(2026, 9, 8),
			);

			expect(summaries(reading.meetings)).toEqual([
				"Morning review",
				"Dentist",
				"Afternoon call",
			]);
			expect(reading.failures.map((failure) => failure.index)).toEqual([1]);
		} finally {
			warn.mockRestore();
		}
	});
});


describe("the calendar library breaking its own contract", () => {
	/**
	 * Every case below drives `readDayFromAll` directly, bypassing
	 * `CalendarSources` — the only machine that feeds it bytes in the plugin.
	 *
	 * The three cases that stand `ExpanderWithNoEvents` in for the real library
	 * go further: `CalendarSources` only ever hands `readDayFromAll` a copy
	 * stored *after* a calendar has already been read without throwing, so a
	 * broken library never leaves one behind for it to meet here. Those three
	 * exercise a branch no shipped caller can currently produce; it is kept as
	 * the correct answer for a caller fed bytes some other way.
	 */

	/**
	 * A stand-in for `ical-expander` that never sets the `events` field.
	 *
	 * That field is undocumented and `ical-expander` is pinned `^3.2.0`, so a 3.x
	 * release renaming it is accepted by `npm install`. Every calendar in the
	 * vault then meets the same break at once, which is what these cases are
	 * about: it is the library that is broken, not any calendar.
	 */
	class ExpanderWithNoEvents {}

	/** `readDayFromAll` with that stand-in in place, and every console line it wrote. */
	async function readWithBrokenExpander(
		calendars: readonly string[],
	): Promise<{ reading: DayReading; lines: string[] }> {
		vi.resetModules();
		vi.doMock("ical-expander", () => ({ default: ExpanderWithNoEvents }));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const module = await import("../core/icsReader");
			const reading = module.readDayFromAll(calendars, day(2026, 9, 8));
			return { reading, lines: warn.mock.calls.map((call) => String(call[0])) };
		} finally {
			warn.mockRestore();
			vi.doUnmock("ical-expander");
			vi.resetModules();
		}
	}

	it("marks no calendar failed, because the bytes are perfectly good", async () => {
		const { reading } = await readWithBrokenExpander([
			fixture("one-day.ics"),
			fixture("second-calendar.ics"),
		]);

		expect(reading.failures).toEqual([]);
	});

	it("says it on the console once for the read, not once per calendar", async () => {
		const { lines } = await readWithBrokenExpander([
			fixture("one-day.ics"),
			fixture("second-calendar.ics"),
			fixture("broken-event.ics"),
		]);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/ical-expander.*`events`/);
	});

	// **The trade-off, and it is deliberate.** A broken dependency shows an empty
	// day with nothing said on screen, which brushes against issue #53. Issue
	// #289 settled that this failure's audience is whoever has the console open:
	// the person has nothing to fix, and a per-calendar sentence would libel
	// every good calendar in the vault. Pinned here so that undoing it breaks a
	// test rather than passing quietly.
	it("answers with an empty day rather than a wrong sentence about the calendar", async () => {
		const { reading } = await readWithBrokenExpander([fixture("one-day.ics")]);

		expect(reading.meetings).toEqual([]);
		expect(reading.failures).toEqual([]);
	});

	it("still reports an ordinary unreadable calendar while the library is sound", () => {
		const reading = readDayFromAll([fixture("not-a-calendar.ics")], day(2026, 9, 8));

		expect(reading.failures).toHaveLength(1);
	});
});

describe("endsAtOf — when a meeting is over", () => {
	/** A meeting as `readDay` hands it over, with only its time fields varying. */
	function meetingAt(allDay: boolean, start: Date, end: Date): Meeting {
		return {
			uid: "invented",
			summary: "Invented",
			location: null,
			description: null,
			organizer: null,
			attendees: [],
			occurrenceKey: null,
			allDay,
			start,
			end,
		};
	}

	it("ends an all-day meeting read from a calendar file at the midnight after its last day", () => {
		const ics = fixture("all-day.ics");
		const [holiday] = readDay(ics, day(2026, 9, 8));
		const [away] = readDay(ics, day(2026, 9, 11));

		expect(holiday.summary).toBe("Public holiday");
		expect(endsAtOf(holiday)).toBe(new Date(2026, 8, 9, 0, 0).getTime());
		expect(away.summary).toBe("Away three days");
		expect(endsAtOf(away)).toBe(new Date(2026, 8, 13, 0, 0).getTime());
	});

	it("ends a one-day all-day meeting at the midnight after its day, not at the midnight it starts", () => {
		const meeting = meetingAt(true, day(2026, 9, 30), day(2026, 9, 30));
		expect(endsAtOf(meeting)).toBe(new Date(2026, 9, 1, 0, 0).getTime());
	});

	it("ends a three-day all-day meeting at the midnight after its third day", () => {
		const meeting = meetingAt(true, day(2026, 9, 28), day(2026, 9, 30));
		expect(endsAtOf(meeting)).toBe(new Date(2026, 9, 1, 0, 0).getTime());
	});

	it("ends a timed meeting at its end", () => {
		const meeting = meetingAt(false, new Date(2026, 8, 30, 13, 0), new Date(2026, 8, 30, 14, 30));
		expect(endsAtOf(meeting)).toBe(new Date(2026, 8, 30, 14, 30).getTime());
	});

	it("ends a timed meeting whose calendar gives an end before its start at its start", () => {
		const meeting = meetingAt(false, new Date(2026, 8, 30, 13, 0), new Date(2026, 8, 30, 12, 0));
		expect(endsAtOf(meeting)).toBe(new Date(2026, 8, 30, 13, 0).getTime());
	});
});
