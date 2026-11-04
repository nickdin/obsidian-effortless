import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desiredRowsFor } from "../features/daysAhead/desiredRows";
import { mergeMeetings, type ExistingRow } from "../features/daysAhead/mergeMeetings";
import { startKeyFor, type RowMemory } from "../features/daysAhead/rowMemory";
import type { Meeting } from "../core/icsReader";

/**
 * The parity corpus: every case of
 * `~/Devbox/calendar-scaffold/tests/schema-table.test.ts` that exercises
 * `mergeRows`, with its third `Ansträngning` cell dropped, run through
 * {@link desiredRowsFor} and {@link mergeMeetings} and asserted to give the
 * same two cells the old test expected — except where a case is cited as a
 * named difference.
 *
 * **Two of the old file's cases are not here.** `"stays below the rows when
 * rows are added"` (`:305-312`) and `"does not make a plain-text title
 * unreadable on the next run"` (`:314-319`) are both about the table's own
 * serialization — trailing blank lines, and escaping a cell's text — which
 * this feature no longer owns: that is `writeCalendarRows`'s job, tested
 * against `#693`'s own suite, and escaping twice over is the defect `#703`
 * was filed for (issue #696's own wave-2 amendment).
 */

const DATE = "2026-08-20";

function localDate(year: number, month: number, day: number): Date {
	return new Date(year, month - 1, day);
}

function localDateTime(year: number, month: number, day: number, hour: number, minute: number): Date {
	return new Date(year, month - 1, day, hour, minute);
}

const DAY = localDate(2026, 8, 20);

// Nothing under test here reads the clock — desiredRowsFor and mergeMeetings
// take their day/date as an argument — but issue #696's own criterion says
// every date and time test pins it, so a later change that does read the
// clock cannot slip through unnoticed.
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2026, 7, 20, 12, 0));
});
afterEach(() => vi.useRealTimers());

function meeting(partial: Partial<Meeting>): Meeting {
	return {
		uid: "uid-1",
		summary: "Test meeting",
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

/**
 * `desiredRowsFor` then `mergeMeetings`, mirroring the old suite's own
 * `merge()` helper (`schema-table.test.ts:51-54`). `notes` defaults to
 * `onDay`, matching the old fixture's own default: `event({})` carried
 * `calendar: "Provkalender"` and one attendee, so `isMeeting` was true unless
 * a case said otherwise.
 */
function merge(
	existingRows: readonly ExistingRow[],
	onDay: readonly Meeting[],
	notes: readonly Meeting[] = onDay,
	remembered: RowMemory = {},
) {
	const desired = desiredRowsFor(onDay, notes, DAY);
	return mergeMeetings(existingRows, desired, remembered, DATE);
}

describe("parity — row 1, schema-table.test.ts:165-169, named difference 5", () => {
	it("the realistic case — a freshly created table has no placeholder row to begin with", () => {
		// #692 already seeds a new day's table with zero rows, so the case that
		// actually occurs is an empty table, and its outcome matches the old
		// plugin's exactly: one row, the meeting's own.
		const { rows } = merge([], [meeting({})]);
		expect(rows).toEqual([{ from: null, time: "10:00–11:00", event: "[[2026-08-20 Test meeting]]" }]);
	});

	it("named difference — a hand-made blank row is not detected as scaffolding and stays, unlike the old plugin's replace", () => {
		const blank: ExistingRow = { time: "", meetingCell: "" };
		const { rows } = merge([blank], [meeting({})]);
		// Old: the blank row is replaced outright (`added` 1, one line). New: the
		// blank row is never recognised as scaffolding, so it is never removed —
		// the new row is simply inserted beside it.
		expect(rows).toEqual([
			{ from: 0, time: "", event: "" },
			{ from: null, time: "10:00–11:00", event: "[[2026-08-20 Test meeting]]" },
		]);
	});
});

describe("parity — row 2, schema-table.test.ts:171-175", () => {
	it("leaves a blank row alone on a day with no meetings", () => {
		const blank: ExistingRow = { time: "", meetingCell: "" };
		const { rows } = merge([blank], []);
		expect(rows).toEqual([{ from: 0, time: "", event: "" }]);
	});
});

describe("parity — row 3, schema-table.test.ts:177-188", () => {
	it("inserts a new row in time order without moving the others", () => {
		const existing: ExistingRow[] = [
			{ time: "08:00–09:00", meetingCell: "Breakfast" },
			{ time: "14:00–15:00", meetingCell: "Afternoon" },
		];
		const { rows } = merge(existing, [meeting({})]);
		expect(rows).toEqual([
			{ from: 0, time: "08:00–09:00", event: "Breakfast" },
			{ from: null, time: "10:00–11:00", event: "[[2026-08-20 Test meeting]]" },
			{ from: 1, time: "14:00–15:00", event: "Afternoon" },
		]);
	});
});

describe("parity — row 4, schema-table.test.ts:190-201", () => {
	it("puts an all-day meeting above the timed ones", () => {
		const timed = meeting({});
		const allDay = meeting({
			uid: "uid-2",
			summary: "Full week",
			allDay: true,
			start: localDate(2026, 8, 14),
			end: localDate(2026, 8, 20),
		});
		const { rows } = merge([], [timed, allDay], [timed]);
		expect(rows[0]).toEqual({ from: null, time: "00:00–23:59", event: "Full week" });
		expect(rows[1].time).toBe("10:00–11:00");
	});
});

describe("parity — row 5, schema-table.test.ts:204-211", () => {
	it("rewrites a matched row's two cells (the third cell it used to protect is gone)", () => {
		const existing: ExistingRow[] = [{ time: "09:30–10:30", meetingCell: "Test meeting" }];
		const { rows } = merge(existing, [meeting({})]);
		expect(rows).toEqual([{ from: 0, time: "10:00–11:00", event: "[[2026-08-20 Test meeting]]" }]);
	});
});

describe("parity — row 6, schema-table.test.ts:213-217", () => {
	it("rewrites a matched row's two cells the same way, whatever the third cell used to hold — now moot, since it is gone", () => {
		// With the third column dropped this coincides with row 5's case; kept
		// so every original case still has its own citation.
		const existing: ExistingRow[] = [{ time: "09:30–10:30", meetingCell: "Test meeting" }];
		const { rows } = merge(existing, [meeting({})]);
		expect(rows).toEqual([{ from: 0, time: "10:00–11:00", event: "[[2026-08-20 Test meeting]]" }]);
	});
});

describe("parity — row 7, schema-table.test.ts:220-225", () => {
	it("leaves a row whose meeting has vanished exactly where it is", () => {
		const orphan: ExistingRow = { time: "13:00–14:00", meetingCell: "[[2026-08-20 Meeting that vanished]]" };
		const { rows } = merge([orphan], [meeting({})]);
		expect(rows).toContainEqual({ from: 0, time: orphan.time, event: orphan.meetingCell });
	});
});

describe("parity — row 8, schema-table.test.ts:227-240", () => {
	it("finds a renamed meeting's row through the memory", () => {
		const existing: ExistingRow[] = [{ time: "10:00–11:00", meetingCell: "[[2026-08-20 Test meeting]]" }];
		const remembered: RowMemory = {
			"uid-1": { [DATE]: { "600": { time: "10:00–11:00", event: "[[2026-08-20 Test meeting]]", title: "Test meeting" } } },
		};
		const renamed = meeting({ summary: "Test meeting about data" });
		const { rows } = merge(existing, [renamed], [renamed], remembered);
		expect(rows).toEqual([{ from: 0, time: "10:00–11:00", event: "[[2026-08-20 Test meeting about data]]" }]);
	});
});

describe("parity — row 9, schema-table.test.ts:244-251", () => {
	it("adds a second row rather than losing one when the memory is gone", () => {
		const existing: ExistingRow[] = [{ time: "10:00–11:00", meetingCell: "[[2026-08-20 Test meeting]]" }];
		const renamed = meeting({ summary: "Test meeting about data" });
		const { rows } = merge(existing, [renamed]);
		expect(rows).toHaveLength(2);
		expect(rows).toContainEqual({ from: 0, time: "10:00–11:00", event: "[[2026-08-20 Test meeting]]" });
	});
});

describe("parity — row 10, schema-table.test.ts:253-261", () => {
	it("adopts a row typed by hand, rather than adding a second", () => {
		const existing: ExistingRow[] = [{ time: "10:00–11:00", meetingCell: "Test meeting" }];
		const { rows } = merge(existing, [meeting({})]);
		expect(rows).toEqual([{ from: 0, time: "10:00–11:00", event: "[[2026-08-20 Test meeting]]" }]);
	});
});

describe("parity — row 11, schema-table.test.ts:263-276", () => {
	it("gives two meetings of the same name one row each", () => {
		const first = meeting({ uid: "uid-a" });
		const second = meeting({
			uid: "uid-b",
			start: localDateTime(2026, 8, 20, 13, 0),
			end: localDateTime(2026, 8, 20, 14, 0),
		});
		const existing: ExistingRow[] = [{ time: "10:00–11:00", meetingCell: "Test meeting" }];
		const { rows } = merge(existing, [first, second]);
		expect(rows).toHaveLength(2);
	});
});

describe("parity — row 12, schema-table.test.ts:278-292", () => {
	it("reports what to remember rather than writing it itself", () => {
		const remembered: RowMemory = {};
		const { remember } = merge([], [meeting({})], [meeting({})], remembered);
		expect(remembered).toEqual({});
		expect(remember).toEqual([
			{ uid: "uid-1", startMin: 600, time: "10:00–11:00", meetingCell: "[[2026-08-20 Test meeting]]", title: "Test meeting", wrote: "[[2026-08-20 Test meeting]]" },
		]);
	});
});

describe("parity — row 15, schema-table.test.ts:329-333", () => {
	it("a link the person made in a row for a meeting making no note survives, while the row's time still updates", () => {
		const family = meeting({ uid: "fam", summary: "Personal errand" });
		const existing: ExistingRow[] = [{ time: "09:00–10:00", meetingCell: "[[Personal errand]] (Garage)" }];
		const { rows } = merge(existing, [family], []);
		expect(rows).toEqual([{ from: 0, time: "10:00–11:00", event: "[[Personal errand]] (Garage)" }]);
	});
});

describe("parity — row 16, schema-table.test.ts:335-344", () => {
	it("survives every later run too", () => {
		const family = meeting({ uid: "fam", summary: "Personal errand" });
		let existing: ExistingRow[] = [{ time: "10:00–11:00", meetingCell: "[[Personal errand]] (Garage)" }];
		let remembered: RowMemory = {};
		for (let pass = 0; pass < 3; pass++) {
			const result = merge(existing, [family], [], remembered);
			remembered = {
				...remembered,
				...Object.fromEntries(
					result.remember.map((update) => [
						update.uid,
						{
							...remembered[update.uid],
							[DATE]: {
								[startKeyFor(update.startMin)]: { time: update.time, event: update.meetingCell, title: update.title },
							},
						},
					]),
				),
			};
			existing = result.rows.map((row) => ({ time: row.time, meetingCell: row.event }));
		}
		expect(existing).toEqual([{ time: "10:00–11:00", meetingCell: "[[Personal errand]] (Garage)" }]);
	});
});

describe("parity — row 17, schema-table.test.ts:346-350", () => {
	it("is remembered as what the row actually says, so it is still found next run", () => {
		const family = meeting({ uid: "fam", summary: "Personal errand" });
		const existing: ExistingRow[] = [{ time: "09:00–10:00", meetingCell: "[[Personal errand]] (Garage)" }];
		const { remember } = merge(existing, [family], []);
		expect(remember[0].meetingCell).toBe("[[Personal errand]] (Garage)");
	});
});

describe("parity — row 18, schema-table.test.ts:352-361", () => {
	// The old suite's case moved and renamed a meeting in the same run: 09:30
	// "Old title" became 10:00 "Test meeting". Since #715 the memory key
	// includes the start minute, so the entry a real prior run would have
	// left is keyed "570" (09:30), not "600" — `startKeyFor(570)`. The write
	// path (`remember.push` in `mergeMeetings.ts`) is the only place that key
	// is produced; nothing upstream can hand it a start minute that does not
	// match the row's own time. This fixture keys it "570" for exactly that
	// reason. `findRow` no longer requires the exact key to hit: once its own
	// start key misses, it tries every other entry remembered for this uid
	// and date, and "570"'s own recorded text ("Old title") still equals the
	// existing row's text, so the row is found and rewritten — issue #734,
	// issue #737.
	it("a moved-and-renamed meeting is still found through memory, and its row rewritten rather than duplicated — issue #734, issue #737", () => {
		const existing: ExistingRow[] = [{ time: "09:30–10:30", meetingCell: "[[2026-08-20 Old title]]" }];
		const remembered: RowMemory = {
			"uid-1": { [DATE]: { [startKeyFor(570)]: { time: "09:30–10:30", event: "[[2026-08-20 Old title]]", title: "Old title" } } },
		};
		const renamed = meeting({ summary: "Test meeting" });
		const { rows } = merge(existing, [renamed], [renamed], remembered);
		expect(rows).toEqual([{ from: 0, time: "10:00–11:00", event: "[[2026-08-20 Test meeting]]" }]);
	});

	// The case this replaces (`a moved meeting whose title did not change is
	// also found through memory, not only by the title match that would
	// otherwise still work`) used a row whose text equalled the desired cell,
	// so `matchKey` alone would still have found it — the memory fallback
	// being deleted could not have failed this test. Here the
	// row holds the person's own link instead: `matchKey` reads it as
	// "my own notes", never "test meeting", so only the memory path — trying
	// "570"'s recorded text against the unclaimed row — finds it. Without the
	// fallback this reports two rows, the memory-found one missing and a bare
	// "Test meeting" inserted instead.
	it("a moved meeting whose title did not change is found through memory even when its row holds the person's own link, which the title match alone could never reach", () => {
		const existing: ExistingRow[] = [{ time: "09:30–10:30", meetingCell: "[[My own notes]]" }];
		const remembered: RowMemory = {
			"uid-1": { [DATE]: { [startKeyFor(570)]: { time: "09:30–10:30", event: "[[My own notes]]", title: "Test meeting" } } },
		};
		const { rows } = merge(existing, [meeting({})], [], remembered);
		expect(rows).toEqual([{ from: 0, time: "10:00–11:00", event: "[[My own notes]]" }]);
	});
});
