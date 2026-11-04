import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeMeetings, type ExistingRow } from "../features/daysAhead/mergeMeetings";
import { matchKey } from "../features/daysAhead/matchKey";
import type { DesiredRow } from "../features/daysAhead/desiredRows";
import type { RowMemory } from "../features/daysAhead/rowMemory";

const DATE = "2026-08-20";

// Nothing under test here reads the clock — mergeMeetings and matchKey take
// their date as an argument — but issue #696's own criterion says every
// date and time test pins it, so a later change that does read the clock
// cannot slip through unnoticed.
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2026, 7, 20, 12, 0));
});
afterEach(() => vi.useRealTimers());

function want(partial: Partial<DesiredRow>): DesiredRow {
	return {
		uid: "uid-1",
		title: "Standup",
		time: "10:00–11:00",
		meetingCell: "Standup",
		makesNote: false,
		startMin: 600,
		endMin: 660,
		...partial,
	};
}

describe("matchKey", () => {
	it("sees a hand-typed row and a plugin-written link as the same thing", () => {
		expect(matchKey("[[2026-08-20 Weekly sync]] (Skype)", DATE)).toBe(matchKey("Weekly sync", DATE));
	});

	it("keeps parentheses that are part of the title", () => {
		expect(matchKey("[[2026-08-20 Budget review (draft)]]", DATE)).toBe("budget review (draft)");
	});

	it("answers an empty key for empty text, and an empty key matches nothing", () => {
		expect(matchKey("", DATE)).toBe("");
		const { rows } = mergeMeetings([{ time: "09:00–10:00", meetingCell: "" }], [want({ meetingCell: "" })], {}, DATE);
		// Both keys are empty, but an empty key is defined to match nothing, so
		// the existing blank row is left alone and a new row is inserted.
		expect(rows).toContainEqual({ from: 0, time: "09:00–10:00", event: "" });
		expect(rows).toHaveLength(2);
	});
});

describe("mergeMeetings — matching a row to a meeting", () => {
	it("finds a renamed meeting's row through memory, across a title change", () => {
		const existing: ExistingRow[] = [{ time: "10:00–11:00", meetingCell: "[[2026-08-20 Old name]]" }];
		const remembered: RowMemory = {
			"uid-1": { [DATE]: { "600": { time: "10:00–11:00", event: "[[2026-08-20 Old name]]", title: "Old name" } } },
		};
		const renamed = want({ title: "New name", meetingCell: "[[2026-08-20 New name]]", makesNote: true });
		const { rows } = mergeMeetings(existing, [renamed], remembered, DATE);
		expect(rows).toEqual([{ from: 0, time: "10:00–11:00", event: "[[2026-08-20 New name]]" }]);
	});

	it("finds each of two meetings of one uid on the same day through its own start minute, not the other's memory", () => {
		const existing: ExistingRow[] = [
			{ time: "09:00–09:30", meetingCell: "[[2026-08-20 Old morning]]" },
			{ time: "13:00–13:30", meetingCell: "[[2026-08-20 Old afternoon]]" },
		];
		const remembered: RowMemory = {
			"uid-1": {
				[DATE]: {
					"540": { time: "09:00–09:30", event: "[[2026-08-20 Old morning]]", title: "Old morning" },
					"780": { time: "13:00–13:30", event: "[[2026-08-20 Old afternoon]]", title: "Old afternoon" },
				},
			},
		};
		const morning = want({
			title: "New morning",
			meetingCell: "[[2026-08-20 New morning]]",
			time: "09:00–09:30",
			startMin: 540,
			endMin: 570,
			makesNote: true,
		});
		const afternoon = want({
			title: "Old afternoon",
			meetingCell: "[[2026-08-20 Old afternoon]]",
			time: "13:00–13:30",
			startMin: 780,
			endMin: 810,
			makesNote: true,
		});
		// If the memory lookup ignores the start minute, both desired rows share
		// one remembered entry — whichever was written last — and at most one
		// of these two rows is found in place; the other is duplicated.
		const { rows } = mergeMeetings(existing, [morning, afternoon], remembered, DATE);
		expect(rows).toEqual([
			{ from: 0, time: "09:00–09:30", event: "[[2026-08-20 New morning]]" },
			{ from: 1, time: "13:00–13:30", event: "[[2026-08-20 Old afternoon]]" },
		]);
	});

	it("does not let one occurrence's fallback claim the row memory holds for a sibling that has only moved earlier", () => {
		// Afternoon is processed first and its own key (510) has no entry, so
		// it falls to the fallback before Morning's own key (540) is ever
		// tried. If the fallback does not exclude Morning's own current key,
		// Afternoon claims Morning's row (index 0) and Morning then claims
		// Afternoon's old row (index 1) through the same fallback — the two
		// rows swap identity. This reports that swap unless the exclusion
		// holds.
		const existing: ExistingRow[] = [
			{ time: "09:00–09:30", meetingCell: "[[2026-08-20 Morning]]" },
			{ time: "13:00–13:30", meetingCell: "[[2026-08-20 Afternoon]]" },
		];
		const remembered: RowMemory = {
			"uid-1": {
				[DATE]: {
					"540": { time: "09:00–09:30", event: "[[2026-08-20 Morning]]", title: "Morning" },
					"780": { time: "13:00–13:30", event: "[[2026-08-20 Afternoon]]", title: "Afternoon" },
				},
			},
		};
		const afternoon = want({
			title: "Afternoon",
			meetingCell: "[[2026-08-20 Afternoon]]",
			time: "08:30–09:00",
			startMin: 510,
			endMin: 540,
			makesNote: true,
		});
		const morning = want({
			title: "Morning",
			meetingCell: "[[2026-08-20 Morning]]",
			time: "09:00–09:30",
			startMin: 540,
			endMin: 570,
			makesNote: true,
		});
		const { rows } = mergeMeetings(existing, [afternoon, morning], remembered, DATE);
		// The result keeps the existing rows' own positions (index 0, the old
		// "Morning" slot, before index 1, the old "Afternoon" slot) — it is
		// `from` that says which meeting now claims each one.
		expect(rows).toEqual([
			{ from: 0, time: "09:00–09:30", event: "[[2026-08-20 Morning]]" },
			{ from: 1, time: "08:30–09:00", event: "[[2026-08-20 Afternoon]]" },
		]);
	});

	it("does not try another occurrence's memory when its own key holds an entry whose text now matches nothing", () => {
		// If the fallback runs whenever the own entry's text fails to match
		// rather than only when the own key is missing, the morning's
		// hand-edited row lets it claim the afternoon's row instead of
		// inserting fresh: this reports the afternoon's own row losing its
		// `from: 1` unless the gate holds.
		const existing: ExistingRow[] = [
			{ time: "09:00–09:30", meetingCell: "[[2026-08-20 Old morning, hand-edited]]" },
			{ time: "13:00–13:30", meetingCell: "[[2026-08-20 Old afternoon]]" },
		];
		const remembered: RowMemory = {
			"uid-1": {
				[DATE]: {
					"540": { time: "09:00–09:30", event: "[[2026-08-20 Old morning]]", title: "Old morning" },
					"780": { time: "13:00–13:30", event: "[[2026-08-20 Old afternoon]]", title: "Old afternoon" },
				},
			},
		};
		const morning = want({
			title: "New morning",
			meetingCell: "[[2026-08-20 New morning]]",
			time: "09:00–09:30",
			startMin: 540,
			endMin: 570,
			makesNote: true,
		});
		const afternoon = want({
			title: "Old afternoon",
			meetingCell: "[[2026-08-20 Old afternoon]]",
			time: "13:00–13:30",
			startMin: 780,
			endMin: 810,
			makesNote: true,
		});
		const { rows } = mergeMeetings(existing, [morning, afternoon], remembered, DATE);
		expect(rows).toContainEqual({ from: 1, time: "13:00–13:30", event: "[[2026-08-20 Old afternoon]]" });
	});

	it("adopts a hand-typed row by title when there is no memory for it", () => {
		const existing: ExistingRow[] = [{ time: "10:00–11:00", meetingCell: "Weekly sync" }];
		const desired = [want({ title: "Weekly sync", meetingCell: "[[2026-08-20 Weekly sync]]", makesNote: true })];
		const { rows } = mergeMeetings(existing, desired, {}, DATE);
		expect(rows).toEqual([{ from: 0, time: "10:00–11:00", event: "[[2026-08-20 Weekly sync]]" }]);
	});

	it("adds a second row rather than losing one when a renamed meeting has no memory", () => {
		const existing: ExistingRow[] = [{ time: "10:00–11:00", meetingCell: "[[2026-08-20 Old name]]" }];
		const renamed = want({ title: "New name", meetingCell: "[[2026-08-20 New name]]" });
		const { rows } = mergeMeetings(existing, [renamed], {}, DATE);
		expect(rows).toHaveLength(2);
		expect(rows).toContainEqual({ from: 0, time: "10:00–11:00", event: "[[2026-08-20 Old name]]" });
	});

	it("gives two meetings sharing a title one row each, in sort order, and the same two rows on a second run", () => {
		const first = want({ uid: "uid-first", meetingCell: "Standup", time: "09:00–09:30", startMin: 540, endMin: 570 });
		const second = want({ uid: "uid-second", meetingCell: "Standup", time: "13:00–13:30", startMin: 780, endMin: 810 });

		const pass1 = mergeMeetings([{ time: "09:00–09:30", meetingCell: "Standup" }], [first, second], {}, DATE);
		expect(pass1.rows).toHaveLength(2);

		const remembered: RowMemory = Object.fromEntries(
			pass1.remember.map((update) => [
				update.uid,
				{
					[DATE]: {
						[String(update.startMin)]: { time: update.time, event: update.meetingCell, title: update.title },
					},
				},
			]),
		);
		const existingRows2 = pass1.rows.map((row) => ({ time: row.time, meetingCell: row.event }));
		const pass2 = mergeMeetings(existingRows2, [first, second], remembered, DATE);

		expect(pass2.rows.map((row) => ({ time: row.time, event: row.event }))).toEqual(
			pass1.rows.map((row) => ({ time: row.time, event: row.event })),
		);
	});

	it("leaves an unmatched row exactly where it is, holding its own text, with a from naming itself", () => {
		const orphan: ExistingRow = { time: "13:00–14:00", meetingCell: "[[2026-08-20 Meeting that vanished]]" };
		const { rows } = mergeMeetings([orphan], [want({})], {}, DATE);
		expect(rows).toContainEqual({ from: 0, time: orphan.time, event: orphan.meetingCell });
	});
});

describe("mergeMeetings — a link the person made in a row for a meeting that makes no note", () => {
	it("keeps the row's meeting cell, and still updates its time", () => {
		const existing: ExistingRow[] = [{ time: "09:00–10:00", meetingCell: "[[Personal errand]] (Garage)" }];
		const desired = [want({ meetingCell: "Personal errand", title: "Personal errand", makesNote: false })];
		const { rows } = mergeMeetings(existing, desired, {}, DATE);
		expect(rows).toEqual([{ from: 0, time: "10:00–11:00", event: "[[Personal errand]] (Garage)" }]);
	});

	it("is remembered as what the row actually says, not what was wanted", () => {
		const existing: ExistingRow[] = [{ time: "09:00–10:00", meetingCell: "[[Personal errand]] (Garage)" }];
		const desired = [want({ meetingCell: "Personal errand", title: "Personal errand", makesNote: false })];
		const { remember } = mergeMeetings(existing, desired, {}, DATE);
		expect(remember).toEqual([
			{ uid: "uid-1", startMin: 600, time: "10:00–11:00", meetingCell: "[[Personal errand]] (Garage)", title: "Personal errand", wrote: null },
		]);
	});
});

describe("mergeMeetings — a row for a meeting that does make a note", () => {
	it("is rewritten even when it already holds a link", () => {
		const existing: ExistingRow[] = [{ time: "09:30–10:30", meetingCell: "[[2026-08-20 Old title]]" }];
		const remembered: RowMemory = {
			"uid-1": { [DATE]: { "600": { time: "09:30–10:30", event: "[[2026-08-20 Old title]]", title: "Old title" } } },
		};
		const desired = [want({ makesNote: true, meetingCell: "[[2026-08-20 Renamed title]]", title: "Renamed title" })];
		const { rows } = mergeMeetings(existing, desired, remembered, DATE);
		expect(rows).toEqual([{ from: 0, time: "10:00–11:00", event: "[[2026-08-20 Renamed title]]" }]);
	});
});

describe("mergeMeetings — inserting a new row", () => {
	it("lands before the first existing row that starts later", () => {
		const existing: ExistingRow[] = [
			{ time: "08:00–09:00", meetingCell: "Breakfast" },
			{ time: "14:00–15:00", meetingCell: "Afternoon" },
		];
		const { rows } = mergeMeetings(existing, [want({})], {}, DATE);
		expect(rows).toEqual([
			{ from: 0, time: "08:00–09:00", event: "Breakfast" },
			{ from: null, time: "10:00–11:00", event: "Standup" },
			{ from: 1, time: "14:00–15:00", event: "Afternoon" },
		]);
	});

	it("lands at the end when nothing starts later", () => {
		const existing: ExistingRow[] = [{ time: "08:00–09:00", meetingCell: "Breakfast" }];
		const { rows } = mergeMeetings(existing, [want({})], {}, DATE);
		expect(rows).toEqual([
			{ from: 0, time: "08:00–09:00", event: "Breakfast" },
			{ from: null, time: "10:00–11:00", event: "Standup" },
		]);
	});

	it("steps over an existing row whose time cell readTimeCell refuses, anchoring nothing", () => {
		const existing: ExistingRow[] = [{ time: "not a time", meetingCell: "Hand-written note" }];
		const { rows } = mergeMeetings(existing, [want({})], {}, DATE);
		expect(rows).toEqual([
			{ from: 0, time: "not a time", event: "Hand-written note" },
			{ from: null, time: "10:00–11:00", event: "Standup" },
		]);
	});
});

describe("mergeMeetings — what it reports", () => {
	it("returns what to remember rather than writing into the memory handed in", () => {
		const remembered: RowMemory = {};
		const { remember } = mergeMeetings([], [want({})], remembered, DATE);
		expect(remembered).toEqual({});
		expect(remember).toEqual([{ uid: "uid-1", startMin: 600, time: "10:00–11:00", meetingCell: "Standup", title: "Standup", wrote: "Standup" }]);
	});

	it("leaves an empty table empty when there is nothing to write", () => {
		expect(mergeMeetings([], [], {}, DATE)).toEqual({ rows: [], remember: [], remove: [], forget: [] });
	});
});
