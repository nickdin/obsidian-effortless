/**
 * Findings against #1011's
 * days-ahead half: an ended meeting adds no row, a row is judged over
 * by its own end time, and another meeting's placeholder row is never
 * handed on. Every fixture is invented.
 */

import { describe, expect, it } from "vitest";
import { UNTITLED_MEETING_TITLE } from "../core/meetingName";
import type { DesiredRow } from "../features/daysAhead/desiredRows";
import { mergeMeetings } from "../features/daysAhead/mergeMeetings";
import type { ExistingRow } from "../features/daysAhead/mergeMeetings";

const DATE = "2026-09-30";

function want(partial: Partial<DesiredRow>): DesiredRow {
	return {
		uid: "series-1",
		title: "Planning round",
		time: "13:00–14:00",
		meetingCell: "Planning round",
		makesNote: false,
		startMin: 13 * 60,
		endMin: 14 * 60,
		...partial,
	};
}

/** Local time on `DATE`. */
function at(hour: number, minute = 0): Date {
	return new Date(2026, 8, 30, hour, minute);
}

describe("mergeMeetings — another meeting's placeholder row is not handed on", () => {
	const remembered = {
		"series-a": {
			[DATE]: { "600": { time: "10:00–10:30", event: UNTITLED_MEETING_TITLE, title: UNTITLED_MEETING_TITLE } },
		},
	};
	const untitled = want({
		uid: "series-a",
		title: UNTITLED_MEETING_TITLE,
		meetingCell: UNTITLED_MEETING_TITLE,
		time: "10:00–10:30",
		startMin: 600,
		endMin: 630,
	});
	const budget = want({ uid: "series-b", title: "Budget", meetingCell: "Budget", time: "10:00–11:00", startMin: 600, endMin: 660 });
	const existing: ExistingRow[] = [{ time: "10:00–10:30", meetingCell: UNTITLED_MEETING_TITLE }];

	it("leaves an ended meeting's remembered placeholder row alone when a new meeting starts at the same time and sorts first", () => {
		const { rows } = mergeMeetings(existing, [budget, untitled], remembered, DATE, at(10, 45));
		expect(rows).toEqual([
			{ from: 0, time: "10:00–10:30", event: UNTITLED_MEETING_TITLE },
			{ from: null, time: "10:00–11:00", event: "Budget" },
		]);
	});

	it("still corrects a placeholder row no memory names", () => {
		const { rows } = mergeMeetings(existing, [budget], {}, DATE, at(9));
		expect(rows).toEqual([{ from: 0, time: "10:00–11:00", event: "Budget" }]);
	});
});

describe("mergeMeetings — a row is over when its own end time has passed", () => {
	const remembered = {
		"series-1": { [DATE]: { "900": { time: "15:00–16:00", event: "Review", title: "Review" } } },
	};

	it("corrects a row whose meeting the calendar moved earlier, while the row's own end is still ahead", () => {
		const existing: ExistingRow[] = [{ time: "15:00–16:00", meetingCell: "Review" }];
		const moved = want({ title: "Review", meetingCell: "Review", time: "08:00–09:00", startMin: 8 * 60, endMin: 9 * 60 });
		const { rows } = mergeMeetings(existing, [moved], remembered, DATE, at(11));
		expect(rows).toEqual([{ from: 0, time: "08:00–09:00", event: "Review" }]);
	});

	it("leaves a row whose own end has passed, though the calendar moved the meeting later", () => {
		const existing: ExistingRow[] = [{ time: "08:00–09:00", meetingCell: "Review" }];
		const laterMemory = {
			"series-1": { [DATE]: { "480": { time: "08:00–09:00", event: "Review", title: "Review" } } },
		};
		const moved = want({ title: "Review renamed", meetingCell: "Review renamed", time: "13:00–14:00" });
		const { rows } = mergeMeetings(existing, [moved], laterMemory, DATE, at(10));
		expect(rows).toEqual([{ from: 0, time: "08:00–09:00", event: "Review" }]);
	});

	it("falls back to the calendar's end where the row's time cell cannot be read", () => {
		const existing: ExistingRow[] = [{ time: "", meetingCell: "Old title" }];
		const memory = { "series-1": { [DATE]: { "780": { time: "", event: "Old title", title: "Old title" } } } };
		const desired = want({ title: "New title", meetingCell: "New title" });
		expect(mergeMeetings(existing, [desired], memory, DATE, at(14, 1)).rows).toEqual([
			{ from: 0, time: "", event: "Old title" },
		]);
		expect(mergeMeetings(existing, [desired], memory, DATE, at(13, 30)).rows).toEqual([
			{ from: 0, time: "13:00–14:00", event: "New title" },
		]);
	});
});

describe("mergeMeetings — an ended meeting adds no row", () => {
	it("leaves the day's rows as they are for an ended, renamed meeting whose old row memory lacks", () => {
		const existing: ExistingRow[] = [{ time: "13:00–14:00", meetingCell: "Old title" }];
		const { rows } = mergeMeetings(existing, [want({ title: "New title", meetingCell: "New title" })], {}, DATE, at(14, 1));
		expect(rows).toEqual([{ from: 0, time: "13:00–14:00", event: "Old title" }]);
	});

	it("still adds a row for a meeting that has not ended", () => {
		const { rows } = mergeMeetings([], [want({})], {}, DATE, at(9));
		expect(rows).toEqual([{ from: null, time: "13:00–14:00", event: "Planning round" }]);
	});
});
