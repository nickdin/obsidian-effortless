import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeMeetings, type ExistingRow } from "../features/daysAhead/mergeMeetings";
import type { DesiredRow } from "../features/daysAhead/desiredRows";
import type { RowMemory } from "../features/daysAhead/rowMemory";

const DATE = "2026-08-20";

// Nothing under test reads the clock, but every date test pins it.
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

describe("mergeMeetings — a row the plugin wrote and the person then edited", () => {
	it("finds the edited row again by title, and adds no second row", () => {
		// If the own-key branch still returned its memory lookup's `null`, the
		// edited row would go unmatched and a second `Standup` row would be
		// inserted beside it: two rows, not one.
		const existing: ExistingRow[] = [{ time: "10:00–11:00", meetingCell: "[[Standup]]" }];
		const remembered: RowMemory = {
			"uid-1": { [DATE]: { "600": { time: "10:00–11:00", event: "Standup", title: "Standup" } } },
		};
		const { rows } = mergeMeetings(existing, [want({})], remembered, DATE);
		expect(rows).toEqual([{ from: 0, time: "10:00–11:00", event: "[[Standup]]" }]);
	});

	it("gives two same-titled meetings on one day a row each when the first's row was edited", () => {
		// Both rows title-match both meetings. If the first meeting's fall-through
		// found nothing, a third row would appear; if it could take any unclaimed
		// row, the second meeting would lose `from: 1`.
		const existing: ExistingRow[] = [
			{ time: "09:00–09:30", meetingCell: "[[Sync]]" },
			{ time: "13:00–13:30", meetingCell: "Sync (Room 2)" },
		];
		const remembered: RowMemory = {
			"uid-a": { [DATE]: { "540": { time: "09:00–09:30", event: "Sync", title: "Sync" } } },
			"uid-b": { [DATE]: { "780": { time: "13:00–13:30", event: "Sync (Room 2)", title: "Sync" } } },
		};
		const first = want({ uid: "uid-a", title: "Sync", meetingCell: "Sync", time: "09:00–09:30", startMin: 540, endMin: 570 });
		const second = want({
			uid: "uid-b",
			title: "Sync",
			meetingCell: "Sync (Room 2)",
			time: "13:00–13:30",
			startMin: 780,
			endMin: 810,
		});
		const { rows } = mergeMeetings(existing, [first, second], remembered, DATE);
		expect(rows).toEqual([
			{ from: 0, time: "09:00–09:30", event: "[[Sync]]" },
			{ from: 1, time: "13:00–13:30", event: "Sync (Room 2)" },
		]);
	});

	it("never hands a row another meeting's memory names to the title match", () => {
		// The edited row is the later one and its meeting is processed first.
		// Without the exclusion its title match takes row 0, which the other
		// meeting's memory names, and that meeting is left without its row.
		const existing: ExistingRow[] = [
			{ time: "09:00–09:30", meetingCell: "Sync" },
			{ time: "13:00–13:30", meetingCell: "[[Sync]]" },
		];
		const remembered: RowMemory = {
			"uid-a": { [DATE]: { "540": { time: "09:00–09:30", event: "Sync", title: "Sync" } } },
			"uid-b": { [DATE]: { "780": { time: "13:00–13:30", event: "Sync (Room 2)", title: "Sync" } } },
		};
		const early = want({ uid: "uid-a", title: "Sync", meetingCell: "Sync", time: "09:00–09:30", startMin: 540, endMin: 570 });
		const late = want({
			uid: "uid-b",
			title: "Sync",
			meetingCell: "Sync (Room 2)",
			time: "13:00–13:30",
			startMin: 780,
			endMin: 810,
		});
		const { rows } = mergeMeetings(existing, [late, early], remembered, DATE);
		expect(rows).toEqual([
			{ from: 0, time: "09:00–09:30", event: "Sync" },
			{ from: 1, time: "13:00–13:30", event: "[[Sync]]" },
		]);
	});
});
