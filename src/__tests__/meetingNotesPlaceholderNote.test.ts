/**
 * Ticket #1011: a note
 * an older build wrote under the placeholder title, that this feature has no
 * memory of, is renamed to the meeting's real title — when exactly one such
 * note exists for the day. Every fixture is invented.
 */

import { describe, expect, it } from "vitest";
import type { Meeting } from "../core/icsReader";
import { UNTITLED_MEETING_TITLE } from "../core/meetingName";
import { defaultData } from "../core/settings";
import type { TFile } from "obsidian";
import type { NotesMemory } from "../features/meetingNotes/notesMemory";
import { runMeetingNotes } from "../features/meetingNotes/run";
import { ensureNote, ensureNotes } from "../features/meetingNotes/ensureNote";
import type { NoteLookup } from "../features/meetingNotes/ensureNote";
import { meetingNotePath } from "../features/meetingNotes/notePath";
import { DEFAULT_TEMPLATE } from "../features/meetingNotes/types";

const DATE = "2026-09-30";
const FOLDER = "Meetings";
const SELF = "self@invented.test";
const PLACEHOLDER = `${FOLDER}/${DATE} ${UNTITLED_MEETING_TITLE}.md`;

const layout = { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };

function meeting(): Meeting {
	return {
		uid: "series-1",
		summary: "Planning round",
		location: null,
		description: null,
		organizer: null,
		attendees: [{ name: "Alva Almgren", email: "alva.almgren@invented.test" }],
		occurrenceKey: null,
		allDay: false,
		start: new Date(2026, 8, 30, 13, 0),
		end: new Date(2026, 8, 30, 14, 0),
	};
}

/** A vault as a record, answering which placeholder notes a day holds. */
function vault(files: Record<string, string>): NoteLookup {
	return {
		exists: (path) => path in files,
		read: (path) => files[path] ?? null,
		placeholderNotesOn: (date) =>
			Object.keys(files).filter((path) => path.startsWith(`${FOLDER}/${date} ${UNTITLED_MEETING_TITLE}`)),
	};
}

describe("ensureNote — a placeholder note with no memory", () => {
	it("renames the one placeholder note to the real title and records it", () => {
		const result = ensureNote(
			meeting(),
			DATE,
			layout,
			FOLDER,
			vault({ [PLACEHOLDER]: "# Untitled meeting\nmy own words" }),
			{},
			DEFAULT_TEMPLATE,
			SELF,
		);
		const target = meetingNotePath(FOLDER, DATE, "Planning round");
		expect(result.outcome).toBe("renamed");
		expect(result.previousPath).toBe(PLACEHOLDER);
		expect(result.path).toBe(target);
		expect(result.remember?.path).toBe(target);
		expect(result.text).toBeUndefined();
	});

	it("renames nothing and names both notes when two placeholder notes match", () => {
		const second = `${FOLDER}/${DATE} ${UNTITLED_MEETING_TITLE} 1.md`;
		const result = ensureNote(
			meeting(),
			DATE,
			layout,
			FOLDER,
			vault({ [PLACEHOLDER]: "a", [second]: "b" }),
			{},
			DEFAULT_TEMPLATE,
			SELF,
		);
		expect(result.outcome).not.toBe("renamed");
		expect(result.previousPath).toBeUndefined();
		expect(result.refused.join(" ")).toContain(PLACEHOLDER);
		expect(result.refused.join(" ")).toContain(second);
	});

	it("does not adopt a placeholder note for a meeting that is itself untitled", () => {
		const untitled = { ...meeting(), summary: "" };
		const result = ensureNote(untitled, DATE, layout, FOLDER, vault({ [PLACEHOLDER]: "x" }), {}, DEFAULT_TEMPLATE, SELF);
		expect(result.outcome).toBe("adopted");
		expect(result.previousPath).toBeUndefined();
	});
});

describe("ensureNotes — two meetings competing for one placeholder note", () => {
	it("renames nothing when two titled meetings with no memory could each be that note's", () => {
		const other = { ...meeting(), uid: "series-2", summary: "Budget check" };
		const results = ensureNotes(
			[meeting(), other],
			DATE,
			layout,
			FOLDER,
			vault({ [PLACEHOLDER]: "mine" }),
			{},
			DEFAULT_TEMPLATE,
			SELF,
		);
		expect(results.map((result) => result.outcome)).toEqual(["created", "created"]);
		expect(results[0].refused.join(" ")).toContain(PLACEHOLDER);
	});
});

describe("runMeetingNotes — the rename is carried out and remembered", () => {
	it("renames the placeholder note through the writer, keeps its text, and commits the memory", async () => {
		const files = new Map<string, string>([[PLACEHOLDER, "# Untitled meeting\nmy own words"]]);
		const renamed: Array<{ from: string; to: string }> = [];
		const commits: NotesMemory[] = [];
		const target = meetingNotePath(FOLDER, DATE, "Planning round");

		await runMeetingNotes({
			calendar: { refresh: async () => undefined, meetingsOn: () => [meeting()], presenceBetween: () => ({ whole: false, meetings: [] }) },
			vault: {
				exists: (path) => files.has(path),
				read: async (path) => files.get(path) ?? null,
				fileAt: (path) => (files.has(path) ? ({ path } as unknown as TFile) : null),
				placeholderNotes: (folder, date) =>
					[...files.keys()].filter((path) => path === `${folder}/${date} ${UNTITLED_MEETING_TITLE}.md`),
			},
			notes: {
				trashIf: async () => { throw new Error("no note is deleted in this test"); },
				create: async () => {
					throw new Error("a second note must not be made");
				},
				rename: async (file, newPath) => {
					const from = (file as unknown as { path: string }).path;
					files.set(newPath, files.get(from) ?? "");
					files.delete(from);
					renamed.push({ from, to: newPath });
				},
				edit: async () => {
					throw new Error("the renamed note keeps its text");
				},
			},
			problems: { report: () => undefined, clear: () => undefined, list: () => [] },
			layout,
			folder: FOLDER,
			template: DEFAULT_TEMPLATE,
			selfEmail: SELF,
			today: new Date(2026, 8, 30),
			memory: {},
			commitMemory: async (memory) => {
				commits.push(memory);
			},
		});

		expect(renamed).toEqual([{ from: PLACEHOLDER, to: target }]);
		expect(files.get(target)).toBe("# Untitled meeting\nmy own words");
		expect(commits[commits.length - 1]?.["series-1"]?.[DATE]?.path).toBe(target);
	});
});
