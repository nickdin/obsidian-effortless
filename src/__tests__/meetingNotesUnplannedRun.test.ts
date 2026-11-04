/**
 * The unplanned meeting's note and link against the two runs that write the
 * same day:
 * meeting notes' calendar run never adopts, renames or corrects the note, even
 * when the calendar later shows a meeting at the same time, and building the
 * days ahead leaves the link in today's log where it was.
 *
 * Both run over the real `startUnplannedMeeting`, `runMeetingNotes` and
 * `runWindow`, with fakes only for the vault and the calendar. No real name,
 * place or calendar.
 */

import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import type { Meeting } from "../core/icsReader";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { dailyLogFrame, dailyLogPath } from "../core/vaultLayout";
import { runWindow } from "../features/daysAhead/run";
import type { RunDeps as DaysAheadRunDeps, RunNotes as DaysAheadRunNotes } from "../features/daysAhead/run";
import type { RowMemory } from "../features/daysAhead/rowMemory";
import { identityInText } from "../features/meetingNotes/noteIdentity";
import { meetingNotePath } from "../features/meetingNotes/notePath";
import type { NotesMemory } from "../features/meetingNotes/notesMemory";
import { placeholderNotePaths } from "../features/meetingNotes/placeholderNotes";
import { runMeetingNotes } from "../features/meetingNotes/run";
import type { RunCalendar, RunNotes, RunVault } from "../features/meetingNotes/run";
import { DEFAULT_TEMPLATE } from "../features/meetingNotes/types";
import { startUnplannedMeeting } from "../features/meetingNotes/unplannedMeeting";

const FOLDER = "Meetings";
const TODAY = new Date(2026, 10, 4);
const PRESSED = new Date(2026, 10, 4, 14, 5, 12);
const UNPLANNED_PATH = "Meetings/2026-11-04 Unplanned meeting 1405.md";

function layout(): VaultLayout {
	return { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
}

const LOG_PATH = dailyLogPath(TODAY, layout());

/** A calendar meeting with someone invited, starting the minute the unplanned one did. */
function sameTimeMeeting(): Meeting {
	return {
		uid: "same-time@effortless.test",
		summary: "Fixture review",
		location: null,
		description: null,
		organizer: null,
		attendees: [{ name: "Fixture Guest", email: "guest@invented.test" }],
		occurrenceKey: null,
		allDay: false,
		start: new Date(2026, 10, 4, 14, 5),
		end: new Date(2026, 10, 4, 15, 0),
	};
}

function fakeFile(path: string): TFile {
	return { path } as unknown as TFile;
}

/** The calendar both runs read: the one meeting on `TODAY`, for either use, and nothing on any other day. */
function calendar(meetings: readonly Meeting[]): RunCalendar {
	return {
		presenceBetween: () => ({ whole: false, meetings: [] }),
		refresh: async () => undefined,
		meetingsOn: (day) => (day.getTime() === TODAY.getTime() ? meetings : []),
	};
}

/** Presses the command over `files`, the way the feature wires it, with today's log built by the core's frame. */
async function pressUnplanned(files: Map<string, string>, notices: string[] = []): Promise<void> {
	await startUnplannedMeeting({
		now: PRESSED,
		folder: FOLDER,
		template: DEFAULT_TEMPLATE,
		layout: layout(),
		title: "Unplanned meeting",
		fileAt: (path) => (files.has(path) ? fakeFile(path) : null),
		create: async (path, text) => {
			if (files.has(path)) throw new Error(`already exists: ${path}`);
			files.set(path, text);
			return fakeFile(path);
		},
		open: async () => undefined,
		todaysLog: async (date, dayLayout) => {
			const path = dailyLogPath(date, dayLayout);
			if (!files.has(path)) files.set(path, dailyLogFrame(dayLayout));
			return fakeFile(path);
		},
		edit: async (target, edit) => {
			const next = edit(files.get(target.path) ?? "");
			files.set(target.path, next);
			return next;
		},
		notice: (message) => notices.push(message),
	});
}

/**
 * Meeting notes' vault and writer over `files`, answering every way the run
 * finds a note — by path, by the identity in a note's text, by the placeholder
 * name — and recording every write it makes.
 */
function meetingNotesPorts(files: Map<string, string>): { vault: RunVault; notes: RunNotes; touched: string[] } {
	const touched: string[] = [];
	const vault: RunVault = {
		exists: (path) => files.has(path),
		read: async (path) => files.get(path) ?? null,
		fileAt: (path) => (files.has(path) ? fakeFile(path) : null),
		notesNamingIdentity: (identity) => [...files].filter(([, text]) => identityInText(text) === identity).map(([path]) => path),
		placeholderNotes: (folder, date) => placeholderNotePaths([...files.keys()], folder, date),
	};
	const notes: RunNotes = {
		create: async (path, text) => {
			if (files.has(path)) throw new Error(`already exists: ${path}`);
			files.set(path, text);
			touched.push(`create ${path}`);
			return fakeFile(path);
		},
		rename: async (target, newPath) => {
			touched.push(`rename ${target.path}`);
			files.set(newPath, files.get(target.path) ?? "");
			files.delete(target.path);
		},
		edit: async (target, edit) => {
			touched.push(`edit ${target.path}`);
			const next = edit(files.get(target.path) ?? "");
			files.set(target.path, next);
			return next;
		},
		trashIf: async (target) => {
			touched.push(`trash ${target.path}`);
			return false;
		},
	};
	return { vault, notes, touched };
}

/** The command's ports over `files`, pressed at `now`; `create` lands only once `landing` resolves, when one is given. */
function portsAt(now: Date, files: Map<string, string>, log: string[], landing?: Promise<void>) {
	return {
		now,
		folder: FOLDER,
		template: DEFAULT_TEMPLATE,
		layout: layout(),
		title: "Unplanned meeting",
		fileAt: (path: string) => (files.has(path) ? fakeFile(path) : null),
		create: async (path: string, text: string) => {
			await landing;
			// `NoteWriter.create`'s own refusal, asked again once the write's turn comes.
			if (files.has(path)) throw new Error(`A note already exists at "${path}".`);
			files.set(path, text);
			log.push(`create ${path}`);
			return fakeFile(path);
		},
		open: async (target: TFile) => {
			log.push(`open ${target.path}`);
		},
		todaysLog: async (date: Date, dayLayout: VaultLayout) => {
			const path = dailyLogPath(date, dayLayout);
			if (!files.has(path)) files.set(path, dailyLogFrame(dayLayout));
			return fakeFile(path);
		},
		edit: async (target: TFile, edit: (content: string) => string) => {
			log.push(`link from ${target.path}`);
			const next = edit(files.get(target.path) ?? "");
			files.set(target.path, next);
			return next;
		},
		notice: (message: string) => log.push(`notice ${message}`),
	};
}

describe("pressing the command more than once", () => {
	it("makes two notes at two paths, each opened and linked, for two presses a minute apart", async () => {
		const files = new Map<string, string>();
		const log: string[] = [];

		await startUnplannedMeeting(portsAt(PRESSED, files, log));
		await startUnplannedMeeting(portsAt(new Date(2026, 10, 4, 14, 6, 3), files, log));

		const second = "Meetings/2026-11-04 Unplanned meeting 1406.md";
		expect(log).toEqual([
			`create ${UNPLANNED_PATH}`,
			`open ${UNPLANNED_PATH}`,
			`link from ${LOG_PATH}`,
			`create ${second}`,
			`open ${second}`,
			`link from ${LOG_PATH}`,
		]);
		const day = files.get(LOG_PATH) ?? "";
		expect(day).toContain("[[2026-11-04 Unplanned meeting 1405]]");
		expect(day).toContain("[[2026-11-04 Unplanned meeting 1406]]");
	});

	it("opens the note the first press made, and links nothing again, for a second press in the same minute", async () => {
		const files = new Map<string, string>();
		await startUnplannedMeeting(portsAt(PRESSED, files, []));
		const before = new Map(files);
		const log: string[] = [];

		await startUnplannedMeeting(portsAt(new Date(2026, 10, 4, 14, 5, 50), files, log));

		expect(log).toEqual([`open ${UNPLANNED_PATH}`]);
		expect(files).toEqual(before);
	});

	it("opens the note the first press is still writing, saying nothing went wrong, for a second press before it lands", async () => {
		const files = new Map<string, string>();
		const log: string[] = [];
		let land: () => void = () => undefined;
		const landing = new Promise<void>((resolve) => {
			land = resolve;
		});

		const first = startUnplannedMeeting(portsAt(PRESSED, files, log, landing));
		const second = startUnplannedMeeting(portsAt(PRESSED, files, log, landing));
		land();
		await Promise.all([first, second]);

		expect(log.filter((line) => line.startsWith("notice "))).toEqual([]);
		expect(log.filter((line) => line === `create ${UNPLANNED_PATH}`)).toHaveLength(1);
		expect(log.filter((line) => line === `open ${UNPLANNED_PATH}`)).toHaveLength(2);
		expect((files.get(LOG_PATH) ?? "").split("\n").filter((line) => line === "[[2026-11-04 Unplanned meeting 1405]]")).toHaveLength(1);
	});
});

describe("an unplanned meeting's note that will not open", () => {
	it("says so, and still links the note it made from today's log", async () => {
		const files = new Map<string, string>();
		const notices: string[] = [];
		await startUnplannedMeeting({
			now: PRESSED,
			folder: FOLDER,
			template: DEFAULT_TEMPLATE,
			layout: layout(),
			title: "Unplanned meeting",
			fileAt: () => null,
			create: async (path, text) => {
				files.set(path, text);
				return fakeFile(path);
			},
			open: async () => {
				throw new Error("the pane is gone");
			},
			todaysLog: async (date, dayLayout) => {
				const path = dailyLogPath(date, dayLayout);
				if (!files.has(path)) files.set(path, dailyLogFrame(dayLayout));
				return fakeFile(path);
			},
			edit: async (target, edit) => {
				const next = edit(files.get(target.path) ?? "");
				files.set(target.path, next);
				return next;
			},
			notice: (message) => notices.push(message),
		});

		expect(notices).toEqual([
			`Effortless: the unplanned meeting's note "${UNPLANNED_PATH}" was made but could not be opened. the pane is gone`,
		]);
		expect(files.get(LOG_PATH)).toContain("[[2026-11-04 Unplanned meeting 1405]]");
	});
});

describe("the calendar run and an unplanned meeting's note", () => {
	it("leaves the note's bytes as they were and makes the calendar meeting at the same time a note of its own", async () => {
		const files = new Map<string, string>();
		await pressUnplanned(files);
		const unplanned = files.get(UNPLANNED_PATH);
		expect(unplanned).toBeDefined();

		let memory: NotesMemory = {};
		const { vault, notes, touched } = meetingNotesPorts(files);
		await runMeetingNotes({
			calendar: calendar([sameTimeMeeting()]),
			vault,
			notes,
			problems: { report: () => undefined, clear: () => undefined, list: () => [] },
			layout: layout(),
			folder: FOLDER,
			template: DEFAULT_TEMPLATE,
			selfEmail: "",
			today: TODAY,
			memory,
			commitMemory: async (next) => {
				memory = next;
			},
		});

		const calendarNote = meetingNotePath(FOLDER, "2026-11-04", "Fixture review");
		expect(files.get(UNPLANNED_PATH)).toBe(unplanned);
		expect(touched).toEqual([`create ${calendarNote}`]);
		// Adopting the note would have recorded it as this meeting's.
		expect(JSON.stringify(memory)).not.toContain(UNPLANNED_PATH);
		expect(JSON.stringify(memory)).toContain(calendarNote);
	});
});

describe("building the days ahead and the unplanned meeting's link", () => {
	it("keeps the one link line in today's log when it writes the day's calendar table", async () => {
		const files = new Map<string, string>();
		await pressUnplanned(files);
		const linkLine = "[[2026-11-04 Unplanned meeting 1405]]";
		expect(files.get(LOG_PATH)?.split("\n").filter((line) => line === linkLine)).toHaveLength(1);

		let rowMemory: RowMemory = {};
		const notes: DaysAheadRunNotes = {
			createDailyLog: async (date, dayLayout) => {
				const path = dailyLogPath(date, dayLayout);
				if (!files.has(path)) files.set(path, dailyLogFrame(dayLayout));
				return fakeFile(path);
			},
			read: async (target) => files.get(target.path) ?? "",
			edit: async (target, edit) => {
				const next = edit(files.get(target.path) ?? "");
				files.set(target.path, next);
				return next;
			},
		};
		const deps: DaysAheadRunDeps = {
			calendar: calendar([sameTimeMeeting()]),
			notes,
			problems: { report: () => undefined, clear: () => undefined, list: () => [] },
			layout: layout(),
			windowDays: 1,
			today: TODAY,
			memory: rowMemory,
			commitMemory: async (next) => {
				rowMemory = next;
			},
		};
		await runWindow(deps);

		const day = files.get(LOG_PATH) ?? "";
		// The run did write the day: the meeting's row is in its table.
		expect(day).toContain("[[2026-11-04 Fixture review]]");
		expect(day.split("\n").filter((line) => line === linkLine)).toHaveLength(1);
		// And the link is still under the notes heading, above the table.
		expect(day.indexOf(linkLine)).toBeGreaterThan(day.indexOf("# Notes"));
		expect(day.indexOf(linkLine)).toBeLessThan(day.indexOf("## Calendar"));
	});
});
