/**
 * Ticket #1011: a row an
 * older build wrote as "Untitled meeting" is corrected to the meeting's real
 * title until the meeting has ended, and a row whose meeting has ended is left
 * as written. Every fixture is invented.
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

describe("mergeMeetings — a row written as the placeholder title", () => {
	it("corrects a placeholder row with no memory in place, and adds no second row", () => {
		const existing: ExistingRow[] = [{ time: "13:00–14:00", meetingCell: UNTITLED_MEETING_TITLE }];
		const { rows } = mergeMeetings(existing, [want({})], {}, DATE, at(9));
		expect(rows).toEqual([{ from: 0, time: "13:00–14:00", event: "Planning round" }]);
	});

	it("corrects a placeholder link to the placeholder note, keeping the location out of the match", () => {
		const existing: ExistingRow[] = [
			{ time: "13:00–14:00", meetingCell: `[[${DATE} ${UNTITLED_MEETING_TITLE}]] (Room 4)` },
		];
		const desired = want({ meetingCell: `[[${DATE} Planning round]] (Room 4)`, makesNote: true });
		const { rows } = mergeMeetings(existing, [desired], {}, DATE, at(9));
		expect(rows).toEqual([{ from: 0, time: "13:00–14:00", event: `[[${DATE} Planning round]] (Room 4)` }]);
	});

	it("leaves a placeholder row alone when its start time is another meeting's", () => {
		const existing: ExistingRow[] = [{ time: "09:00–09:30", meetingCell: UNTITLED_MEETING_TITLE }];
		const { rows } = mergeMeetings(existing, [want({})], {}, DATE, at(8));
		expect(rows).toEqual([
			{ from: 0, time: "09:00–09:30", event: UNTITLED_MEETING_TITLE },
			{ from: null, time: "13:00–14:00", event: "Planning round" },
		]);
	});

	it("leaves a row as written once its meeting has ended, even when the calendar's title changed", () => {
		const existing: ExistingRow[] = [{ time: "13:00–14:00", meetingCell: "Old title" }];
		const remembered = {
			"series-1": { [DATE]: { "780": { time: "13:00–14:00", event: "Old title", title: "Old title" } } },
		};
		const { rows } = mergeMeetings(existing, [want({ title: "New title", meetingCell: "New title" })], remembered, DATE, at(14, 1));
		expect(rows).toEqual([{ from: 0, time: "13:00–14:00", event: "Old title" }]);
	});

	it("leaves a placeholder row as written once its meeting has ended", () => {
		const existing: ExistingRow[] = [{ time: "13:00–14:00", meetingCell: UNTITLED_MEETING_TITLE }];
		const { rows } = mergeMeetings(existing, [want({})], {}, DATE, at(15));
		expect(rows).toEqual([{ from: 0, time: "13:00–14:00", event: UNTITLED_MEETING_TITLE }]);
	});

	it("still corrects a row whose meeting is under way", () => {
		const existing: ExistingRow[] = [{ time: "13:00–14:00", meetingCell: "Old title" }];
		const remembered = {
			"series-1": { [DATE]: { "780": { time: "13:00–14:00", event: "Old title", title: "Old title" } } },
		};
		const { rows } = mergeMeetings(existing, [want({ title: "New title", meetingCell: "New title" })], remembered, DATE, at(13, 30));
		expect(rows).toEqual([{ from: 0, time: "13:00–14:00", event: "New title" }]);
	});

	it("leaves every row of an earlier day as written", () => {
		const existing: ExistingRow[] = [{ time: "13:00–14:00", meetingCell: UNTITLED_MEETING_TITLE }];
		const { rows } = mergeMeetings(existing, [want({})], {}, "2026-09-29", at(9));
		expect(rows).toEqual([{ from: 0, time: "13:00–14:00", event: UNTITLED_MEETING_TITLE }]);
	});

	it("does not call an all-day meeting ended before its last minute of the day", () => {
		const existing: ExistingRow[] = [{ time: "00:00–23:59", meetingCell: UNTITLED_MEETING_TITLE }];
		const allDay = want({ time: "00:00–23:59", startMin: 0, endMin: 23 * 60 + 59 });
		const { rows } = mergeMeetings(existing, [allDay], {}, DATE, at(22));
		expect(rows).toEqual([{ from: 0, time: "00:00–23:59", event: "Planning round" }]);
	});
});
