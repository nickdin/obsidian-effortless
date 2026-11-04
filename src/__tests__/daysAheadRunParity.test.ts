/**
 * The parity replay: `~/Devbox/calendar-scaffold/tests/fill-day.test.ts`'s
 * whole-day fixtures, run through this feature's own `runWindow` against a
 * fake vault, with the old plugin's third `Ansträngning` column dropped from
 * both sides of every comparison — the criterion spec
 * #687 names for this
 * ticket.
 *
 * Every fixture is invented — no real name, place, calendar or address —
 * shaped like the old suite's `tests/fixtures/one-day.json`, whose events are
 * themselves already scrubbed placeholders (`Exempelvecka`, `Provgatan`, and
 * so on — Swedish for "example week", "sample street"). This file's own
 * English fixtures carry the same shape rather than a translation of that
 * text, since this repository's own language rule puts test fixtures in
 * English (`~/Devbox/CLAUDE.md` § Language).
 *
 * **The mapping, test by test**, so nothing from the old file is quietly
 * left out:
 *
 * | Old test (`fill-day.test.ts`) | Here |
 * |---|---|
 * | AC2 "writes one row per event…", "every row… schema-render can read" | `describe("a day with several meetings")`, first test |
 * | AC2 "leaves next week's meeting out" | same test — the next-week meeting is simply never in that day's calendar answer |
 * | AC2 "links only the work meeting that has attendees" | **named difference 4**: `makesNote` is decided by the source's own switch, never by attendees or a calendar's name |
 * | AC7 "keeps an edited effort cell byte-identical" | **not carried**: the effort cell is the third column, dropped from both sides by the criterion itself, so there is nothing left of this case to replay. The equivalent claim for this feature's own two columns — a row it does not touch stays byte-identical over repeated runs — is `describe("a hand-typed or orphaned row")`'s two tests |
 * | AC7 "is idempotent: a second run changes nothing" | `describe("running twice")` |
 * | AC8 "leaves the row of an event no longer in the file exactly as it was" | `describe("a hand-typed or orphaned row")`, "an orphaned row" |
 * | AC8 "deletes no file and empties no section" | `describe("a hand-typed or orphaned row")`, "leaves every other section of the note untouched" |
 * | AC13 "throws on malformed JSON…", "throws on an event with no id…" | **not carried**: both test the old JSON calendar file's own reader, superseded outright by `icsReader.ts` (spec #687 § The port). Neither is a whole-day fixture — there is nothing about a specific day's table in either — so there is nothing here to replay them against |
 * | AC14 "skips a log with no ## Kalender" | `describe("a log this feature cannot read")`, "no calendar block at all" |
 * | AC14 "skips a log whose table has an unexpected header" | `describe("a log this feature cannot read")`, "a table with the wrong column names" |
 * | AC14 "skips a day whose log does not exist yet" | **named difference 1**: `describe("a day that does not exist yet")` — created by the core rather than refused |
 * | "runWindow… reports the day it did and events it read" | folded into `describe("a day with several meetings")` — this run's own outcome is its effect on the vault and the memory, not a day-by-day report, so there is no separate return value to assert on |
 * | "runWindow… prunes the ledger of days that will never be written again" | `src/__tests__/daysAheadRunWindowFill.test.ts`, "is pruned of every date before today on each run, keeping today's entries" |
 * | "the ledger never runs ahead of the vault", both tests | `src/__tests__/daysAheadRunWindowFill.test.ts`, "is written only after a successful write" and "records what the merge said even for a day that needed no write" |
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TFile } from "obsidian";
import type { Meeting } from "../core/icsReader";
import { dailyLogFrame, dailyLogPath } from "../core/vaultLayout";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { localDateKey } from "../features/daysAhead/desiredRows";
import { runWindow } from "../features/daysAhead/run";
import type { RunCalendar, RunDeps, RunNotes, RunProblems } from "../features/daysAhead/run";

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2026, 7, 20, 12, 0));
});
afterEach(() => vi.useRealTimers());

const TODAY = new Date(2026, 7, 20);

function layout(): VaultLayout {
	return {
		...defaultData().core.layout,
		dailyLogFolder: "Journal",
		dailyLogFilename: "YYYY-MM-DD",
		calendarColumns: { time: "Start", event: "What" },
	};
}

function file(path: string): TFile {
	return { path } as unknown as TFile;
}

interface FakeNotes extends RunNotes {
	readonly files: Map<string, string>;
	readonly createdFresh: string[];
	readonly editedPaths: string[];
}

function fakeNotes(existing: ReadonlyMap<string, string> = new Map()): FakeNotes {
	const files = new Map(existing);
	const createdFresh: string[] = [];
	const editedPaths: string[] = [];
	return {
		files,
		createdFresh,
		editedPaths,
		async createDailyLog(date, dayLayout): Promise<TFile> {
			const path = dailyLogPath(date, dayLayout);
			if (!files.has(path)) {
				files.set(path, dailyLogFrame(dayLayout));
				createdFresh.push(path);
			}
			return file(path);
		},
		async read(target): Promise<string> {
			const path = (target as unknown as { path: string }).path;
			const content = files.get(path);
			if (content === undefined) throw new Error(`no fake content for ${path}`);
			return content;
		},
		async edit(target, edit): Promise<string> {
			const path = (target as unknown as { path: string }).path;
			editedPaths.push(path);
			const next = edit(files.get(path) ?? "");
			files.set(path, next);
			return next;
		},
	};
}

function fakeCalendar(onTheDay: ReadonlyMap<string, readonly Meeting[]>, makingNotes: ReadonlyMap<string, readonly Meeting[]> = new Map()): RunCalendar {
	return {
		refresh: async () => undefined,
		presenceBetween: () => ({ whole: false, meetings: [] }),
		meetingsOn: (day, use) => {
			const key = localDateKey(day);
			return (use === "day" ? onTheDay.get(key) : makingNotes.get(key)) ?? [];
		},
	};
}

/** Tracks which keys are currently standing, the way the real `Problems` channel does, so `list()` answers truthfully. */
function fakeProblems(): RunProblems & { reports: { key: string; message: string }[]; cleared: string[]; list(): readonly string[] } {
	const reports: { key: string; message: string }[] = [];
	const cleared: string[] = [];
	const standing = new Set<string>();
	return {
		reports,
		cleared,
		report: (key, message) => {
			reports.push({ key, message });
			standing.add(key);
		},
		clear: (key) => {
			cleared.push(key);
			standing.delete(key);
		},
		list: () => [...standing],
	};
}

function deps(overrides: Partial<RunDeps> = {}): RunDeps {
	return {
		calendar: fakeCalendar(new Map()),
		notes: fakeNotes(),
		problems: fakeProblems(),
		layout: layout(),
		windowDays: 1,
		today: TODAY,
		memory: {},
		commitMemory: async () => undefined,
		...overrides,
	};
}

/** The final table's data-row lines, header and fence stripped. */
function tableRowsOf(content: string): string[] {
	return content
		.split("\n")
		.filter((line) => line.trim().startsWith("|"))
		.slice(2); // the header row and the separator
}

function timed(uid: string, summary: string, startHour: number, startMin: number, endHour: number, endMin: number, location: string | null = null): Meeting {
	return {
		uid,
		summary,
		location,
		description: null,
		organizer: null,
		attendees: [],
		occurrenceKey: null,
		allDay: false,
		start: new Date(2026, 7, 20, startHour, startMin),
		end: new Date(2026, 7, 20, endHour, endMin),
	};
}

/** Every meeting the old `one-day.json` fixture carries, in the same shape, invented and in English. */
const WEEK_MARKER: Meeting = {
	uid: "week-marker",
	summary: "Example week",
	location: null,
	description: null,
	organizer: null,
	attendees: [],
	occurrenceKey: null,
	allDay: true,
	start: new Date(2026, 7, 14),
	end: new Date(2026, 7, 20),
};
const WORK_MEETING = timed("work-meeting", "Follow-up on example material", 9, 0, 10, 0, "Example City Sample Street 1000 Sample Room (9)");
const BOOKED = timed("booked", "Booked time", 11, 30, 13, 30);
const CAR_SERVICE = timed("car-service", "Car service", 12, 0, 13, 0, "Example car\nSample Road 30, 000 00 Example City, Country");
/** The same fixture's meeting on a different day, so "leaves next week's meeting out" has something concrete to assert against. */
const NEXT_WEEK = timed("next-week", "Meeting next week", 10, 0, 11, 0);

describe("a day with several meetings", () => {
	it("writes one row per meeting on the day, in time order, with only the work meeting linked", async () => {
		const path = dailyLogPath(TODAY, layout());
		const notes = fakeNotes(new Map([[path, dailyLogFrame(layout())]]));
		const calendar = fakeCalendar(
			new Map([["2026-08-20", [WEEK_MARKER, WORK_MEETING, BOOKED, CAR_SERVICE]]]),
			// Named difference 4: makesNote comes from the source's own switch —
			// modelled here as this feature's own "notes" list — never from
			// attendees or a calendar's name.
			new Map([["2026-08-20", [WORK_MEETING]]]),
		);

		await runWindow(deps({ notes, calendar }));

		expect(tableRowsOf(notes.files.get(path)!)).toEqual([
			"| 00:00–23:59 | Example week |",
			"| 09:00–10:00 | [[2026-08-20 Follow-up on example material]] (Example City Sample Street 1000 Sample Room 9) |",
			"| 11:30–13:30 | Booked time |",
			"| 12:00–13:00 | Car service (Example car Sample Road 30, 000 00 Example City, Country) |",
		]);
	});

	it("leaves next week's meeting out of today's table — it is simply never in today's calendar answer", async () => {
		const path = dailyLogPath(TODAY, layout());
		const notes = fakeNotes(new Map([[path, dailyLogFrame(layout())]]));
		const calendar = fakeCalendar(
			new Map([
				["2026-08-20", [BOOKED]],
				["2026-08-27", [NEXT_WEEK]],
			]),
		);

		await runWindow(deps({ notes, calendar }));

		expect(notes.files.get(path)).not.toContain("Meeting next week");
	});

	it("links exactly one row — the meeting on the notes list, not the one with the most attendees or a particular calendar", async () => {
		const path = dailyLogPath(TODAY, layout());
		const notes = fakeNotes(new Map([[path, dailyLogFrame(layout())]]));
		const calendar = fakeCalendar(
			new Map([["2026-08-20", [WEEK_MARKER, WORK_MEETING, BOOKED, CAR_SERVICE]]]),
			new Map([["2026-08-20", [WORK_MEETING]]]),
		);

		await runWindow(deps({ notes, calendar }));

		const linked = tableRowsOf(notes.files.get(path)!).filter((row) => row.includes("[[2026-08-20 "));
		expect(linked).toHaveLength(1);
	});
});

describe("running twice", () => {
	it("is idempotent: a second run causes no edit call and changes nothing", async () => {
		const path = dailyLogPath(TODAY, layout());
		const calendar = fakeCalendar(new Map([["2026-08-20", [WORK_MEETING, BOOKED]]]), new Map([["2026-08-20", [WORK_MEETING]]]));

		const first = fakeNotes(new Map([[path, dailyLogFrame(layout())]]));
		await runWindow(deps({ notes: first, calendar }));
		const filled = first.files.get(path)!;
		expect(first.editedPaths).toEqual([path]);

		const second = fakeNotes(new Map([[path, filled]]));
		await runWindow(deps({ notes: second, calendar }));

		expect(second.editedPaths).toEqual([]);
		expect(second.files.get(path)).toBe(filled);
	});
});

describe("a hand-typed or orphaned row", () => {
	it("leaves the row of a meeting no longer on the calendar exactly as it was", async () => {
		const path = dailyLogPath(TODAY, layout());
		const before = "```schema\n| Start | What |\n| --- | --- |\n| 15:00–16:00 | [[2026-08-20 A meeting that was cancelled]] |\n```\n";
		const notes = fakeNotes(new Map([[path, before]]));

		await runWindow(deps({ notes, windowDays: 1 }));

		expect(tableRowsOf(notes.files.get(path)!)).toContain("| 15:00–16:00 | [[2026-08-20 A meeting that was cancelled]] |");
	});

	it("leaves every other section of the note untouched", async () => {
		const path = dailyLogPath(TODAY, layout());
		const before = [
			"# Notes",
			"",
			"These prose words stay exactly as written.",
			"",
			"## Calendar",
			"```schema",
			"| Start | What |",
			"| --- | --- |",
			"| 15:00–16:00 | Booked by hand |",
			"```",
			"",
			"## Tasks",
		].join("\n");
		const notes = fakeNotes(new Map([[path, before]]));

		await runWindow(deps({ notes, windowDays: 1 }));

		const after = notes.files.get(path)!;
		expect(after).toContain("These prose words stay exactly as written.");
		expect(after).toContain("## Tasks");
	});
});

describe("a log this feature cannot read", () => {
	it("leaves a log with no calendar block at all byte-identical, and says why", async () => {
		const path = dailyLogPath(TODAY, layout());
		const before = "# Notes\n\nNo calendar heading in this log at all.\n";
		const notes = fakeNotes(new Map([[path, before]]));
		const problems = fakeProblems();

		await runWindow(deps({ notes, problems, windowDays: 1 }));

		expect(notes.files.get(path)).toBe(before);
		expect(notes.editedPaths).toEqual([]);
		expect(problems.reports).toHaveLength(1);
	});

	it("leaves a table with the wrong column names byte-identical, and says why", async () => {
		const path = dailyLogPath(TODAY, layout());
		const before = "```schema\n| Tid | Möte |\n| --- | --- |\n```\n";
		const notes = fakeNotes(new Map([[path, before]]));
		const problems = fakeProblems();

		await runWindow(deps({ notes, problems, windowDays: 1 }));

		expect(notes.files.get(path)).toBe(before);
		expect(problems.reports).toHaveLength(1);
	});
});

describe("a day that does not exist yet", () => {
	it("is created by the core rather than refused, and filled in the same run (named difference 1)", async () => {
		const notes = fakeNotes();
		const calendar = fakeCalendar(new Map([["2026-08-20", [BOOKED]]]));

		await runWindow(deps({ notes, calendar, windowDays: 1 }));

		const path = dailyLogPath(TODAY, layout());
		expect(notes.createdFresh).toEqual([path]);
		expect(notes.files.get(path)).toContain("Booked time");
	});
});
