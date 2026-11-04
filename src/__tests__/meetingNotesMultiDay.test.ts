/**
 * Ticket #1013: a
 * meeting that lasts several days keeps one note, dated its first day, and
 * every day's row links to it; an occurrence that moved to another day is
 * still renamed to its new date. Every fixture is invented.
 */

import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import type { Meeting } from "../core/icsReader";
import { UNTITLED_MEETING_TITLE } from "../core/meetingName";
import { defaultData } from "../core/settings";
import { desiredRowsFor } from "../features/daysAhead/desiredRows";
import type { NotesMemory } from "../features/meetingNotes/notesMemory";
import { runMeetingNotes } from "../features/meetingNotes/run";
import { meetingNotePath } from "../features/meetingNotes/notePath";
import { DEFAULT_TEMPLATE } from "../features/meetingNotes/types";

const FOLDER = "Meetings";
const SELF = "self@invented.test";
const layout = { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };

/** Three days: 2026-09-29 to 2026-10-01, timed, so it is not over on its second day. */
function threeDayMeeting(over: Partial<Meeting> = {}): Meeting {
	return {
		uid: "series-harbour",
		summary: "Harbour planning round",
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

/** A vault as a Map, with the writer's three calls acting on it. */
function world() {
	const files = new Map<string, string>();
	const renamed: Array<{ from: string; to: string }> = [];
	const asked: string[] = [];
	const state: { memory: NotesMemory } = { memory: {} };
	return {
		files,
		renamed,
		asked,
		state,
		async runOn(day: Date, meeting: Meeting) {
			await runMeetingNotes({
				calendar: { refresh: async () => undefined, meetingsOn: () => [meeting], presenceBetween: () => ({ whole: false, meetings: [] }) },
				vault: {
					exists: (path) => files.has(path),
					read: async (path) => files.get(path) ?? null,
					fileAt: (path) => (files.has(path) ? ({ path } as unknown as TFile) : null),
					placeholderNotes: (folder, date) => {
						asked.push(date);
						return [...files.keys()].filter((path) => path === `${folder}/${date} ${UNTITLED_MEETING_TITLE}.md`);
					},
				},
				notes: {
					trashIf: async () => { throw new Error("no note is deleted in this test"); },
					create: async (path, text) => {
						files.set(path, text);
						return { path } as unknown as TFile;
					},
					rename: async (file, newPath) => {
						const from = (file as unknown as { path: string }).path;
						files.set(newPath, files.get(from) ?? "");
						files.delete(from);
						renamed.push({ from, to: newPath });
					},
					edit: async (file, edit) => {
						const path = (file as unknown as { path: string }).path;
						const next = edit(files.get(path) ?? "");
						files.set(path, next);
						return next;
					},
				},
				problems: { report: () => undefined, clear: () => undefined, list: () => [] },
				layout,
				folder: FOLDER,
				template: DEFAULT_TEMPLATE,
				selfEmail: SELF,
				today: day,
				memory: state.memory,
				commitMemory: async (next) => {
					state.memory = next;
				},
			});
		},
	};
}

const FIRST = meetingNotePath(FOLDER, "2026-09-29", "Harbour planning round");

describe("meeting notes — a meeting lasting several days", () => {
	it("keeps one note, dated the first day, across all three days", async () => {
		const w = world();
		for (const day of [new Date(2026, 8, 29), new Date(2026, 8, 30), new Date(2026, 9, 1)]) {
			await w.runOn(day, threeDayMeeting());
		}
		expect([...w.files.keys()]).toEqual([FIRST]);
		expect(w.renamed).toEqual([]);
	});

	it("makes the note under the first day's date on a first run that falls on a later day", async () => {
		const w = world();
		await w.runOn(new Date(2026, 8, 30), threeDayMeeting());
		expect([...w.files.keys()]).toEqual([FIRST]);
	});

	it("leaves a note already dated the first day where it is on a later day", async () => {
		const w = world();
		await w.runOn(new Date(2026, 8, 29), threeDayMeeting());
		const before = w.files.get(FIRST);
		await w.runOn(new Date(2026, 8, 30), threeDayMeeting());
		expect([...w.files.keys()]).toEqual([FIRST]);
		expect(w.files.get(FIRST)).toBe(before);
	});

	it("brings an older build's per-day note back to the first day's date", async () => {
		// The rule: a note is dated the span's first day; one remembered under
		// any other date is a moved (or older-build) note and is renamed to it.
		const w = world();
		const older = meetingNotePath(FOLDER, "2026-09-30", "Harbour planning round");
		w.files.set(older, "# Harbour planning round\n");
		w.state.memory = { "series-harbour": { "2026-09-30": { path: older, accounted: ["alva.almgren@invented.test"] } } };
		await w.runOn(new Date(2026, 8, 30), threeDayMeeting());
		expect([...w.files.keys()]).toEqual([FIRST]);
	});

	it("still renames an occurrence that moved to another day to its new date", async () => {
		const w = world();
		const oldPath = meetingNotePath(FOLDER, "2026-09-29", "Quay survey");
		w.files.set(oldPath, "# Quay survey\n");
		w.state.memory = {
			"series-quay::k1": { "2026-09-29": { path: oldPath, accounted: ["alva.almgren@invented.test"] } },
		};
		const moved = threeDayMeeting({
			uid: "series-quay",
			summary: "Quay survey",
			occurrenceKey: "k1",
			start: new Date(2026, 8, 30, 13, 0),
			end: new Date(2026, 8, 30, 14, 0),
		});
		await w.runOn(new Date(2026, 8, 30), moved);
		expect([...w.files.keys()]).toEqual([meetingNotePath(FOLDER, "2026-09-30", "Quay survey")]);
		expect(w.renamed).toHaveLength(1);
	});

	it("looks for a placeholder note under the first day's date, not the run's", async () => {
		const w = world();
		const placeholder = meetingNotePath(FOLDER, "2026-09-29", "");
		w.files.set(placeholder, "my own words");
		await w.runOn(new Date(2026, 8, 30), threeDayMeeting());
		expect(w.asked).toContain("2026-09-29");
		expect([...w.files.keys()]).toEqual([FIRST]);
		expect(w.files.get(FIRST)).toBe("my own words");
	});
});

describe("days ahead — the row of a several-day meeting", () => {
	it("links each of the three days' rows to the one note", () => {
		const meeting = threeDayMeeting();
		const cells = [new Date(2026, 8, 29), new Date(2026, 8, 30), new Date(2026, 9, 1)].map(
			(day) => desiredRowsFor([meeting], [meeting], day)[0].meetingCell,
		);
		expect(cells).toEqual(Array(3).fill("[[2026-09-29 Harbour planning round]]"));
	});

	it("links a one-day meeting's row to its own day, as before", () => {
		const meeting = threeDayMeeting({ start: new Date(2026, 8, 30, 13, 0), end: new Date(2026, 8, 30, 14, 0) });
		expect(desiredRowsFor([meeting], [meeting], new Date(2026, 8, 30))[0].meetingCell).toBe(
			"[[2026-09-30 Harbour planning round]]",
		);
	});
});
