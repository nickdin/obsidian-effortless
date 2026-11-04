/**
 * Findings against ticket #1013
 * (a meeting lasting several days keeps one note, dated its first day), found by
 * wave 2's reviews of the 2026-09-30 board run: a hand-typed row on a later day, placeholder
 * rivals counted per note date, and the first-day
 * rule held once for both features. Every fixture is
 * invented.
 */

import { describe, expect, it } from "vitest";
import type { Meeting } from "../core/icsReader";
import { desiredRowsFor } from "../features/daysAhead/desiredRows";
import { mergeMeetings } from "../features/daysAhead/mergeMeetings";
import type { TFile } from "obsidian";
import { UNTITLED_MEETING_TITLE, meetingNoteDate } from "../core/meetingName";
import { runMeetingNotes } from "../features/meetingNotes/run";
import { defaultData } from "../core/settings";
import { ensureNotes } from "../features/meetingNotes/ensureNote";
import type { NoteLookup } from "../features/meetingNotes/ensureNote";
import { DEFAULT_TEMPLATE } from "../features/meetingNotes/types";

/** Three days: 2026-09-29 to 2026-10-01, timed, with an invited person so it makes a note. */
function threeDayMeeting(over: Partial<Meeting> = {}): Meeting {
	return {
		uid: "series-harbour",
		summary: "Harbour",
		location: null,
		description: null,
		organizer: null,
		attendees: [{ name: "Alva Almgren", email: "alva.almgren@invented.test" }],
		occurrenceKey: null,
		allDay: false,
		start: new Date(2026, 8, 29, 9, 0),
		end: new Date(2026, 9, 1, 17, 0),
		...over,
	};
}

describe("days ahead — a hand-typed row on a later day of a several-day meeting", () => {
	it("is matched and rewritten in place on day two, leaving one row", () => {
		const meeting = threeDayMeeting();
		const desired = desiredRowsFor([meeting], [meeting], new Date(2026, 8, 30));
		const merged = mergeMeetings([{ time: "00:00–23:59", meetingCell: "Harbour" }], desired, {}, "2026-09-30");
		expect(merged.rows.map((row) => row.event)).toEqual(["[[2026-09-29 Harbour]]"]);
	});

	it("is matched on day three as well, and an older build's own-day link is matched on day two", () => {
		const meeting = threeDayMeeting();
		const dayThree = desiredRowsFor([meeting], [meeting], new Date(2026, 9, 1));
		const onThree = mergeMeetings([{ time: "00:00–17:00", meetingCell: "Harbour" }], dayThree, {}, "2026-10-01");
		expect(onThree.rows).toHaveLength(1);

		const dayTwo = desiredRowsFor([meeting], [meeting], new Date(2026, 8, 30));
		const older = mergeMeetings([{ time: "00:00–23:59", meetingCell: "[[2026-09-30 Harbour]]" }], dayTwo, {}, "2026-09-30");
		expect(older.rows.map((row) => row.event)).toEqual(["[[2026-09-29 Harbour]]"]);
	});

	it("still adds a row beside a hand-typed row of another meeting's title", () => {
		const meeting = threeDayMeeting();
		const desired = desiredRowsFor([meeting], [meeting], new Date(2026, 8, 30));
		const merged = mergeMeetings([{ time: "10:00–11:00", meetingCell: "Dentist" }], desired, {}, "2026-09-30");
		expect(merged.rows).toHaveLength(2);
	});
});

const FOLDER = "Meetings";
const RUN_DAY = "2026-09-30";
const layout = { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };

/** A vault holding `files`, listing placeholder notes by the date it is asked for. */
function vault(files: readonly string[]): NoteLookup {
	return {
		exists: (path) => files.includes(path),
		read: () => "",
		placeholderNotesOn: (date) => files.filter((path) => path === `${FOLDER}/${date} ${UNTITLED_MEETING_TITLE}.md`),
	};
}

/** A one-day meeting on 2026-09-30, invited person and all. */
function standup(): Meeting {
	return threeDayMeeting({
		uid: "series-standup",
		summary: "Standup",
		start: new Date(2026, 8, 30, 13, 0),
		end: new Date(2026, 8, 30, 14, 0),
	});
}

describe("the first-day rule lives in the core, once", () => {
	it("dates a meeting's note its first day for any day inside its span, and the day itself outside it", () => {
		const meeting = threeDayMeeting();
		expect(["2026-09-29", "2026-09-30", "2026-10-01"].map((day) => meetingNoteDate(meeting, day))).toEqual(
			Array(3).fill("2026-09-29"),
		);
		expect(meetingNoteDate(meeting, "2026-10-02")).toBe("2026-10-02");
		expect(meetingNoteDate(meeting, "2026-09-28")).toBe("2026-09-28");
	});

	it("gives the note made by meeting notes the very path each day's row links to", async () => {
		const files = new Map<string, string>();
		for (const dayNumber of [29, 30, 1]) {
			const month = dayNumber === 1 ? 9 : 8;
			const day = new Date(2026, month, dayNumber);
			const meeting = threeDayMeeting();
			await runMeetingNotes({
				calendar: { refresh: async () => undefined, meetingsOn: () => [meeting], presenceBetween: () => ({ whole: false, meetings: [] }) },
				vault: {
					exists: (path) => files.has(path),
					read: async (path) => files.get(path) ?? null,
					fileAt: (path) => (files.has(path) ? ({ path } as unknown as TFile) : null),
					placeholderNotes: () => [],
				},
				notes: {
					trashIf: async () => { throw new Error("no note is deleted in this test"); },
					create: async (path, text) => {
						files.set(path, text);
						return { path } as unknown as TFile;
					},
					rename: async () => undefined,
					edit: async (_file, edit) => edit(""),
				},
				problems: { report: () => undefined, clear: () => undefined, list: () => [] },
				layout,
				folder: FOLDER,
				template: DEFAULT_TEMPLATE,
				selfEmail: "self@invented.test",
				today: day,
				memory: {},
				commitMemory: async () => undefined,
			});
			const link = desiredRowsFor([meeting], [meeting], day)[0].meetingCell;
			expect(`${FOLDER}/${link.replace(/^\[\[|\]\]$/g, "")}.md`).toBe([...files.keys()][0]);
		}
		expect(files.size).toBe(1);
	});
});

describe("meeting notes — placeholder rivals are counted per note date", () => {
	it("adopts today's placeholder for a one-day meeting although a several-day meeting started yesterday", () => {
		const placeholder = `${FOLDER}/${RUN_DAY} ${UNTITLED_MEETING_TITLE}.md`;
		const results = ensureNotes([threeDayMeeting(), standup()], RUN_DAY, layout, FOLDER, vault([placeholder]), {}, DEFAULT_TEMPLATE, "self@invented.test");
		expect(results.map((result) => result.outcome)).toEqual(["created", "renamed"]);
		expect(results[1].previousPath).toBe(placeholder);
		expect(results.flatMap((result) => result.refused)).toEqual([]);
	});

	it("adopts the first day's placeholder for the several-day meeting although a one-day meeting is today", () => {
		const placeholder = `${FOLDER}/2026-09-29 ${UNTITLED_MEETING_TITLE}.md`;
		const results = ensureNotes([standup(), threeDayMeeting()], RUN_DAY, layout, FOLDER, vault([placeholder]), {}, DEFAULT_TEMPLATE, "self@invented.test");
		expect(results.map((result) => result.outcome)).toEqual(["created", "renamed"]);
		expect(results[1].previousPath).toBe(placeholder);
		expect(results.flatMap((result) => result.refused)).toEqual([]);
	});

	it("still refuses when two meetings share the one note date and one placeholder", () => {
		const placeholder = `${FOLDER}/${RUN_DAY} ${UNTITLED_MEETING_TITLE}.md`;
		const other = threeDayMeeting({ ...standup(), uid: "series-review", summary: "Review" });
		const results = ensureNotes([standup(), other], RUN_DAY, layout, FOLDER, vault([placeholder]), {}, DEFAULT_TEMPLATE, "self@invented.test");
		expect(results.map((result) => result.outcome)).toEqual(["created", "created"]);
		expect(results.flatMap((result) => result.refused)).toHaveLength(2);
	});
});
