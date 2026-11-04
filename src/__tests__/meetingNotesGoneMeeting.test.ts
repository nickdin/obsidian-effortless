/**
 * Meeting notes deleting the note of a meeting gone from the calendar, through whole runs one after another, the way a day goes.
 *
 * A note goes only when everything holds at once: meeting notes remembers
 * writing it, under today or later; its meeting has not ended; the calendar's
 * reading is whole and holds the meeting nowhere ahead; and the note's text
 * still equals what meeting notes last wrote into it. Each test holds all of
 * that but one and asserts the note stays — or holds all of it and asserts
 * the note goes.
 */

import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import type { Meeting } from "../core/icsReader";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { meetingNotePath } from "../features/meetingNotes/notePath";
import type { NotesMemory } from "../features/meetingNotes/notesMemory";
import { runMeetingNotes } from "../features/meetingNotes/run";
import type { RunNotes, RunProblems, RunVault } from "../features/meetingNotes/run";
import { DEFAULT_TEMPLATE } from "../features/meetingNotes/types";

const FOLDER = "Meetings";
const NOON = new Date(2026, 9, 2, 12, 0);

function layout(): VaultLayout {
	return { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
}

function meeting(partial: Partial<Meeting> = {}): Meeting {
	return {
		uid: "arkitektur",
		summary: "Team arkitektur",
		location: null,
		description: null,
		organizer: null,
		attendees: [{ name: "Alva Almgren", email: "alva.almgren@invented.test" }],
		occurrenceKey: null,
		allDay: false,
		start: new Date(2026, 9, 2, 13, 0),
		end: new Date(2026, 9, 2, 14, 0),
		...partial,
	};
}

const PATH = meetingNotePath(FOLDER, "2026-10-02", "Team arkitektur");

/** One vault, one memory and one problem list carried from run to run. */
class Day {
	readonly files = new Map<string, string>();
	readonly trashed: string[] = [];
	readonly reports: Array<{ key: string; message: string }> = [];
	memory: NotesMemory = {};
	presenceAsked = 0;
	/** Set, the vault refuses every trash with this error. */
	trashRefusal: Error | null = null;
	private readonly standing = new Set<string>();

	async run(options: {
		readonly today?: readonly Meeting[];
		readonly ahead?: readonly Meeting[];
		readonly whole?: boolean;
		readonly now?: Date;
	}): Promise<void> {
		const today = options.today ?? [];
		const files = this.files;
		const vault: RunVault = {
			exists: (path) => files.has(path),
			read: async (path) => files.get(path) ?? null,
			fileAt: (path) => (files.has(path) ? ({ path } as unknown as TFile) : null),
		};
		const notes: RunNotes = {
			create: async (path, text) => {
				files.set(path, text);
				return { path } as unknown as TFile;
			},
			rename: async (target, newPath) => {
				const mutable = target as unknown as { path: string };
				files.set(newPath, files.get(mutable.path) ?? "");
				files.delete(mutable.path);
				mutable.path = newPath;
			},
			edit: async (target, edit) => {
				const next = edit(files.get(target.path) ?? "");
				files.set(target.path, next);
				return next;
			},
			trashIf: async (target, shouldTrash) => {
				const text = files.get(target.path);
				if (text === undefined) throw new Error(`no note at ${target.path}`);
				if (this.trashRefusal !== null) throw this.trashRefusal;
				if (!shouldTrash(text)) return false;
				files.delete(target.path);
				this.trashed.push(target.path);
				return true;
			},
		};
		const problems: RunProblems = {
			report: (key, message) => {
				this.reports.push({ key, message });
				this.standing.add(key);
			},
			clear: (key) => this.standing.delete(key),
			list: () => [...this.standing],
		};
		await runMeetingNotes({
			calendar: {
				refresh: async () => undefined,
				meetingsOn: () => today,
				presenceBetween: () => {
					this.presenceAsked += 1;
					return { whole: options.whole ?? true, meetings: [...today, ...(options.ahead ?? [])] };
				},
			},
			vault,
			notes,
			problems,
			layout: layout(),
			folder: FOLDER,
			template: DEFAULT_TEMPLATE,
			selfEmail: "self@invented.test",
			today: options.now ?? NOON,
			memory: this.memory,
			commitMemory: async (next) => {
				this.memory = next;
			},
		});
	}
}

describe("meeting notes deletes a gone meeting's untouched note", () => {
	it("trashes the note it made, untouched, once the meeting is gone and has not ended, and forgets it", async () => {
		const day = new Day();
		await day.run({ today: [meeting()] });
		expect(day.files.has(PATH)).toBe(true);

		await day.run({});

		expect(day.trashed).toEqual([PATH]);
		expect(day.files.has(PATH)).toBe(false);
		expect(day.memory).toEqual({});
	});

	it("keeps a note the person added a line to, says so once naming it, and never asks about it again", async () => {
		const day = new Day();
		await day.run({ today: [meeting()] });
		day.files.set(PATH, `${day.files.get(PATH)}\n- Ask about the budget`);
		const edited = day.files.get(PATH);

		await day.run({});
		await day.run({});

		expect(day.trashed).toEqual([]);
		expect(day.files.get(PATH)).toBe(edited);
		const kept = day.reports.filter((report) => report.message.includes("kept"));
		expect(kept).toHaveLength(1);
		expect(kept[0].key).toBe(PATH);
		expect(kept[0].message).toContain(PATH);
	});

	it("says once, not on every run, that a note it could not trash is kept", async () => {
		// The run clears every path-keyed problem whose path is not one of
		// today's meetings before it starts, so a refusal reported again each
		// run would raise a fresh Notice every fifteen minutes (#786's shape).
		const day = new Day();
		await day.run({ today: [meeting()] });
		const untouched = day.files.get(PATH);
		day.trashRefusal = new Error("the disk is read-only");

		await day.run({});
		await day.run({});

		expect(day.files.get(PATH)).toBe(untouched);
		const refused = day.reports.filter((report) => report.message.includes("could not remove"));
		expect(refused).toHaveLength(1);
		expect(refused[0].key).toBe(PATH);
		expect(refused[0].message).toContain("the disk is read-only");
	});

	it("keeps a note made before this record existed, silently", async () => {
		const day = new Day();
		day.files.set(PATH, "# Team arkitektur\n");
		day.memory = { arkitektur: { "2026-10-02": { path: PATH, accounted: ["Alva Almgren"] } } };

		await day.run({});

		expect(day.files.has(PATH)).toBe(true);
		expect(day.reports).toEqual([]);
	});

	it("keeps the note of a meeting that moved to another day ahead", async () => {
		const day = new Day();
		await day.run({ today: [meeting()] });

		await day.run({
			ahead: [meeting({ start: new Date(2026, 9, 5, 13, 0), end: new Date(2026, 9, 5, 14, 0) })],
		});

		expect(day.trashed).toEqual([]);
		expect(day.files.has(PATH)).toBe(true);
	});

	it("keeps the note of a meeting that had already ended when it left the calendar", async () => {
		const day = new Day();
		await day.run({ today: [meeting()] });

		await day.run({ now: new Date(2026, 9, 2, 14, 0) });

		expect(day.trashed).toEqual([]);
	});

	it("keeps every note when the calendar's reading is not whole", async () => {
		const day = new Day();
		await day.run({ today: [meeting()] });

		await day.run({ whole: false });

		expect(day.trashed).toEqual([]);
		expect(day.files.has(PATH)).toBe(true);
	});

	it("keeps the note of one cancelled occurrence's sibling, and trashes the cancelled one's", async () => {
		const first = meeting({ uid: "weekly", summary: "Weekly", occurrenceKey: "20261002T090000" });
		const day = new Day();
		await day.run({ today: [first] });
		const path = meetingNotePath(FOLDER, "2026-10-02", "Weekly");

		await day.run({
			ahead: [meeting({ uid: "weekly", summary: "Weekly", occurrenceKey: "20261009T090000", start: new Date(2026, 9, 9, 13, 0), end: new Date(2026, 9, 9, 14, 0) })],
		});

		expect(day.trashed).toEqual([path]);
	});

	it("counts a participant it added itself as its own writing, not the person's", async () => {
		const day = new Day();
		await day.run({ today: [meeting()] });
		await day.run({
			today: [meeting({ attendees: [...meeting().attendees, { name: "Bo Berg", email: "bo.berg@invented.test" }] })],
		});
		expect(day.files.get(PATH)).toContain("Bo Berg");

		await day.run({});

		expect(day.trashed).toEqual([PATH]);
	});

	it("still keeps a note the person edited before the plugin added a participant to it", async () => {
		const day = new Day();
		await day.run({ today: [meeting()] });
		day.files.set(PATH, `${day.files.get(PATH)}\n- Ask about the budget`);
		await day.run({
			today: [meeting({ attendees: [...meeting().attendees, { name: "Bo Berg", email: "bo.berg@invented.test" }] })],
		});
		expect(day.files.get(PATH)).toContain("Bo Berg");

		await day.run({});

		expect(day.trashed).toEqual([]);
		expect(day.files.get(PATH)).toContain("Ask about the budget");
	});

	it("counts a rename's correction as its own writing", async () => {
		const day = new Day();
		await day.run({ today: [meeting()] });
		await day.run({ today: [meeting({ summary: "Team arkitektur och design" })] });
		const renamed = meetingNotePath(FOLDER, "2026-10-02", "Team arkitektur och design");
		expect(day.files.get(renamed)).toContain("# Team arkitektur och design");

		await day.run({});

		expect(day.trashed).toEqual([renamed]);
	});

	it("does not ask the calendar anything when no remembered note could go", async () => {
		const day = new Day();
		await day.run({ today: [meeting()] });

		expect(day.presenceAsked).toBe(0);
	});
});
