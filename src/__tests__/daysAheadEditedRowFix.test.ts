import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeMeetings, type ExistingRow } from "../features/daysAhead/mergeMeetings";
import type { DesiredRow } from "../features/daysAhead/desiredRows";
import type { RowMemory } from "../features/daysAhead/rowMemory";

const DATE = "2026-08-20";

// Nothing under test reads the clock, but every date test pins it.
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2026, 7, 20, 8, 0));
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

describe("mergeMeetings — fixes to the edited-row match", () => {
	it("gives two meetings with identical titles a row each when the first's row was edited", () => {
		// Both meetings are titled `Standup` and both remember `Standup`. If the
		// first meeting's own-key match took the second's untouched row by text
		// alone, the second would then title-match the first's edited row: the
		// rows would swap, `from: 1` first and `from: 0` second.
		const existing: ExistingRow[] = [
			{ time: "09:00–09:30", meetingCell: "[[Standup]]" },
			{ time: "13:00–13:30", meetingCell: "Standup" },
		];
		const remembered: RowMemory = {
			"uid-a": { [DATE]: { "540": { time: "09:00–09:30", event: "Standup", title: "Standup" } } },
			"uid-b": { [DATE]: { "780": { time: "13:00–13:30", event: "Standup", title: "Standup" } } },
		};
		const first = want({ uid: "uid-a", time: "09:00–09:30", startMin: 540, endMin: 570 });
		const second = want({ uid: "uid-b", time: "13:00–13:30", startMin: 780, endMin: 810 });
		const { rows } = mergeMeetings(existing, [first, second], remembered, DATE);
		expect(rows).toEqual([
			{ from: 0, time: "09:00–09:30", event: "[[Standup]]" },
			{ from: 1, time: "13:00–13:30", event: "Standup" },
		]);
	});

	it("adopts a same-titled row for a meeting with no memory when a stale entry of another uid names that text", () => {
		// `uid-old` left the calendar but its entry for the day still names
		// `Lunch`. `uid-new` has no entry at all, so it title-matches as it did
		// before #1037. If the stale entry's name blocked that match, a second
		// `Lunch` row (`from: null`) would be inserted.
		const existing: ExistingRow[] = [{ time: "10:00–11:00", meetingCell: "Lunch" }];
		const remembered: RowMemory = {
			"uid-old": { [DATE]: { "600": { time: "10:00–11:00", event: "Lunch", title: "Lunch" } } },
		};
		const { rows } = mergeMeetings(
			existing,
			[want({ uid: "uid-new", title: "Lunch", meetingCell: "Lunch" })],
			remembered,
			DATE,
		);
		expect(rows).toEqual([{ from: 0, time: "10:00–11:00", event: "Lunch" }]);
	});

	it("adopts the row for a meeting whose uid has memory only for other days", () => {
		// `uid-new` has no entry for this date; `uid-old` names `Standup` here.
		// The same blocked match would add a second row.
		const existing: ExistingRow[] = [{ time: "10:00–11:00", meetingCell: "Standup" }];
		const remembered: RowMemory = {
			"uid-old": { [DATE]: { "600": { time: "10:00–11:00", event: "Standup", title: "Standup" } } },
			"uid-new": { "2026-08-19": { "600": { time: "10:00–11:00", event: "Standup", title: "Standup" } } },
		};
		const { rows } = mergeMeetings(existing, [want({ uid: "uid-new" })], remembered, DATE);
		expect(rows).toEqual([{ from: 0, time: "10:00–11:00", event: "Standup" }]);
	});
});
