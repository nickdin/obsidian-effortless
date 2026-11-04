/**
 * Tickets #1015 and
 * #1021 (a placeholder
 * note that memory holds is never another meeting's to rename) and
 * #1018 (an ended
 * meeting's placeholder note is left alone), both against
 * #1011, and
 * #1044 (an all-day
 * meeting is not over until its last day is). Every fixture is invented.
 */

import { describe, expect, it } from "vitest";
import type { Meeting } from "../core/icsReader";
import { UNTITLED_MEETING_TITLE } from "../core/meetingName";
import { defaultData } from "../core/settings";
import { ensureNote, ensureNotes } from "../features/meetingNotes/ensureNote";
import type { NoteLookup } from "../features/meetingNotes/ensureNote";
import type { NotesMemory } from "../features/meetingNotes/notesMemory";
import { meetingNotePath } from "../features/meetingNotes/notePath";
import { DEFAULT_TEMPLATE } from "../features/meetingNotes/types";

const DATE = "2026-09-30";
const FOLDER = "Meetings";
const SELF = "self@invented.test";
const PLACEHOLDER = `${FOLDER}/${DATE} ${UNTITLED_MEETING_TITLE}.md`;

const layout = { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };

function meeting(uid: string, summary: string, startHour = 13): Meeting {
	return {
		uid,
		summary,
		location: null,
		description: null,
		organizer: null,
		attendees: [],
		occurrenceKey: null,
		allDay: false,
		start: new Date(2026, 8, 30, startHour, 0),
		end: new Date(2026, 8, 30, startHour + 1, 0),
	};
}

function vault(files: Record<string, string>): NoteLookup {
	return {
		exists: (path) => path in files,
		read: (path) => files[path] ?? null,
		placeholderNotesOn: (date) =>
			Object.keys(files).filter((path) => path.startsWith(`${FOLDER}/${date} ${UNTITLED_MEETING_TITLE}`)),
	};
}

/** Memory holding `path` for `uid` on the day. */
function remembering(uid: string, path: string): NotesMemory {
	return { [uid]: { [DATE]: { path, accounted: [] } } };
}

const run = (meetings: Meeting[], files: Record<string, string>, memory: NotesMemory) =>
	ensureNotes(meetings, DATE, layout, FOLDER, vault(files), memory, DEFAULT_TEMPLATE, SELF);

describe("ensureNotes — a placeholder note memory holds is not another meeting's", () => {
	it("gives a new titled meeting a fresh note and leaves a still-untitled meeting's note where it is", () => {
		const untitled = meeting("series-a", "");
		const budget = meeting("series-b", "Budget");
		const results = run([untitled, budget], { [PLACEHOLDER]: "mine" }, remembering("series-a", PLACEHOLDER));
		expect(results.map((result) => result.outcome)).toEqual(["nothing-to-do", "created"]);
		expect(results[1].previousPath).toBeUndefined();
		expect(results[1].path).toBe(meetingNotePath(FOLDER, DATE, "Budget"));
	});

	it("renames the remembered note for its own meeting once titled, and makes a fresh one for the newcomer", () => {
		const harbour = meeting("series-a", "Harbour");
		const budget = meeting("series-b", "Budget");
		const results = run([harbour, budget], { [PLACEHOLDER]: "mine" }, remembering("series-a", PLACEHOLDER));
		expect(results.map((result) => result.outcome)).toEqual(["renamed", "created"]);
		expect(results[0].previousPath).toBe(PLACEHOLDER);
		expect(results[1].previousPath).toBeUndefined();
	});

	it("does not let a remembered meeting whose note is gone and a new meeting both claim the one placeholder note", () => {
		const gone = remembering("series-a", `${FOLDER}/${DATE} Harbour.md`);
		const results = run([meeting("series-a", "Harbour"), meeting("series-b", "Budget")], { [PLACEHOLDER]: "x" }, gone);
		const renames = results.filter((result) => result.outcome === "renamed");
		expect(renames.length).toBeLessThanOrEqual(1);
		expect(results.map((result) => result.refused.join(" ")).join(" ")).toContain(PLACEHOLDER);
	});
});

describe("ensureNote — an ended meeting's placeholder note is left alone", () => {
	const ended = meeting("series-a", "Planning round", 6);
	const notes = { [PLACEHOLDER]: "mine" };

	it("renames nothing once the meeting's end has passed", () => {
		const result = ensureNote(ended, DATE, layout, FOLDER, vault(notes), {}, DEFAULT_TEMPLATE, SELF, 0, new Date(2026, 8, 30, 10, 27));
		expect(result.outcome).not.toBe("renamed");
		expect(result.previousPath).toBeUndefined();
	});

	it("still renames while the meeting is under way", () => {
		const result = ensureNote(ended, DATE, layout, FOLDER, vault(notes), {}, DEFAULT_TEMPLATE, SELF, 0, new Date(2026, 8, 30, 6, 30));
		expect(result.outcome).toBe("renamed");
	});
});

describe("ensureNote — an all-day meeting is under way all through its last day", () => {
	// As `readDay` hands it over: `end` is midnight at the start of its last day.
	const offsite: Meeting = { ...meeting("series-a", "Offsite"), allDay: true, start: new Date(2026, 8, 30), end: new Date(2026, 8, 30) };
	const notes = { [PLACEHOLDER]: "mine" };

	it("renames its placeholder note at 10:00 on its own day", () => {
		const result = ensureNote(offsite, DATE, layout, FOLDER, vault(notes), {}, DEFAULT_TEMPLATE, SELF, 0, new Date(2026, 8, 30, 10, 0));
		expect(result.outcome).toBe("renamed");
		expect(result.previousPath).toBe(PLACEHOLDER);
		expect(result.path).toBe(meetingNotePath(FOLDER, DATE, "Offsite"));
	});

	it("renames nothing at midnight after its day, once it is over", () => {
		const result = ensureNote(offsite, DATE, layout, FOLDER, vault(notes), {}, DEFAULT_TEMPLATE, SELF, 0, new Date(2026, 9, 1, 0, 0));
		expect(result.outcome).not.toBe("renamed");
		expect(result.previousPath).toBeUndefined();
	});

	it("counts as a rival on its day, so a timed meeting the same day does not take the one placeholder note", () => {
		const budget = meeting("series-b", "Budget", 13);
		const results = ensureNotes([offsite, budget], DATE, layout, FOLDER, vault(notes), {}, DEFAULT_TEMPLATE, SELF, new Date(2026, 8, 30, 10, 0));
		expect(results.map((result) => result.outcome)).toEqual(["created", "created"]);
		expect(results.map((result) => result.previousPath)).toEqual([undefined, undefined]);
		for (const result of results) expect(result.refused.join(" ")).toContain(PLACEHOLDER);
	});
});
