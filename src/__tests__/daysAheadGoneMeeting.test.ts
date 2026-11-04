/**
 * Building the days ahead removing the row of a meeting gone from the
 * calendar, through one whole run over the window against fakes of
 * its three ports.
 *
 * A row goes only when everything holds at once: the reading is whole, the
 * plugin's own record says it wrote exactly this row, no meeting in the
 * day's reading claims it, and the row has not ended. Each test below holds
 * all of that but one, and asserts the row stays — or holds all of it, and
 * asserts the row goes with every other line unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TFile } from "obsidian";
import type { Meeting } from "../core/icsReader";
import { dailyLogPath } from "../core/vaultLayout";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { localDateKey } from "../features/daysAhead/desiredRows";
import { runWindow } from "../features/daysAhead/run";
import type { RunCalendar, RunNotes, RunProblems } from "../features/daysAhead/run";
import type { RowMemory, RowMemoryEntry } from "../features/daysAhead/rowMemory";

const TODAY = new Date(2026, 9, 2);
const TOMORROW = new Date(2026, 9, 3);

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2026, 9, 2, 12, 0));
});
afterEach(() => vi.useRealTimers());

function layout(): VaultLayout {
	return {
		...defaultData().core.layout,
		dailyLogFolder: "Journal",
		dailyLogFilename: "YYYY-MM-DD",
		calendarColumns: { time: "Start", event: "What" },
	};
}

function pathOf(day: Date): string {
	return dailyLogPath(day, layout());
}

/** A day's log holding a calendar table with `rows`, each a whole table line. */
function dayNote(...rows: string[]): string {
	return ["## Calendar", "", "```schema", "| Start | What |", "| --- | --- |", ...rows, "```", "", "## Notes", ""].join("\n");
}

function meeting(partial: Partial<Meeting>): Meeting {
	return {
		uid: "standup",
		summary: "Standup",
		location: null,
		description: null,
		organizer: null,
		attendees: [],
		occurrenceKey: null,
		allDay: false,
		start: new Date(2026, 9, 2, 14, 0),
		end: new Date(2026, 9, 2, 14, 30),
		...partial,
	};
}

/** What the plugin recorded writing: the time cell and the meeting cell, the cell's own provenance record set to it. */
function wrote(time: string, event: string, title = event): RowMemoryEntry {
	return { time, event, title, wrote: event };
}

interface Fakes {
	readonly calendar: RunCalendar;
	readonly notes: RunNotes;
	readonly problems: RunProblems;
	readonly files: Map<string, string>;
	readonly committed: RowMemory[];
}

function fakes(options: {
	readonly onTheDay: ReadonlyMap<string, readonly Meeting[]>;
	readonly whole: boolean;
	readonly files: ReadonlyMap<string, string>;
}): Fakes {
	const files = new Map(options.files);
	const committed: RowMemory[] = [];
	const calendar: RunCalendar = {
		refresh: async () => {},
		meetingsOn: (day, use) => (use === "day" ? (options.onTheDay.get(localDateKey(day)) ?? []) : []),
		presenceBetween: () => ({ whole: options.whole, meetings: [] }),
	};
	const notes: RunNotes = {
		createDailyLog: async (date) => {
			const path = pathOf(date);
			if (!files.has(path)) files.set(path, dayNote());
			return { path } as unknown as TFile;
		},
		read: async (file) => files.get(file.path) ?? "",
		edit: async (file, edit) => {
			const next = edit(files.get(file.path) ?? "");
			files.set(file.path, next);
			return next;
		},
	};
	const problems: RunProblems = { report: () => {}, clear: () => {}, list: () => [] };
	return { calendar, notes, problems, files, committed };
}

async function run(f: Fakes, memory: RowMemory, windowDays = 2): Promise<RowMemory> {
	return runWindow({
		calendar: f.calendar,
		notes: f.notes,
		problems: f.problems,
		layout: layout(),
		windowDays,
		today: new Date(),
		memory,
		commitMemory: async (next) => {
			f.committed.push(next);
		},
	});
}

describe("building the days ahead removes a gone meeting's row", () => {
	it("removes a not-yet-ended row the plugin wrote for a meeting the calendar no longer has, and leaves every other line as it was", async () => {
		const before = dayNote(
			"| 09:00–10:00 | Områdesmöte LAUA |",
			"| 13:00–14:00 | Team arkitektur |",
			"| 14:00–14:30 | Standup |",
			"| 15:00 | Fika |",
		);
		const f = fakes({
			onTheDay: new Map([["2026-10-02", [meeting({})]]]),
			whole: true,
			files: new Map([[pathOf(TODAY), before]]),
		});
		const memory: RowMemory = {
			"laua": { "2026-10-02": { "540": wrote("09:00–10:00", "Områdesmöte LAUA") } },
			"arkitektur": { "2026-10-02": { "780": wrote("13:00–14:00", "Team arkitektur") } },
			"standup": { "2026-10-02": { "840": wrote("14:00–14:30", "Standup") } },
		};

		const after = await run(f, memory, 1);

		// Box 1: the gone, not-ended, plugin-written row is gone. Box 3: the
		// ended row (09:00–10:00, before noon) and the hand-typed row stay.
		expect(f.files.get(pathOf(TODAY))).toBe(
			dayNote("| 09:00–10:00 | Områdesmöte LAUA |", "| 14:00–14:30 | Standup |", "| 15:00 | Fika |"),
		);
		// The removed row's memory goes with it, so its text no longer keeps a
		// hand-typed row of the same text from being matched by title.
		expect(after["arkitektur"]).toBeUndefined();
		expect(after["laua"]).toEqual(memory["laua"]);
	});

	it("removes the gone meeting's row on a later day of the window too", async () => {
		const f = fakes({
			onTheDay: new Map(),
			whole: true,
			files: new Map([
				[pathOf(TODAY), dayNote()],
				[pathOf(TOMORROW), dayNote("| 13:00–14:00 | Team arkitektur |")],
			]),
		});
		const memory: RowMemory = { "arkitektur": { "2026-10-03": { "780": wrote("13:00–14:00", "Team arkitektur") } } };

		await run(f, memory, 2);

		expect(f.files.get(pathOf(TOMORROW))).toBe(dayNote());
	});

	it("removes nothing, on any day, when the reading is not whole", async () => {
		const today = dayNote("| 13:00–14:00 | Team arkitektur |");
		const tomorrow = dayNote("| 13:00–14:00 | Team arkitektur |");
		const f = fakes({
			onTheDay: new Map(),
			whole: false,
			files: new Map([
				[pathOf(TODAY), today],
				[pathOf(TOMORROW), tomorrow],
			]),
		});
		const memory: RowMemory = {
			"arkitektur": {
				"2026-10-02": { "780": wrote("13:00–14:00", "Team arkitektur") },
				"2026-10-03": { "780": wrote("13:00–14:00", "Team arkitektur") },
			},
		};

		await run(f, memory, 2);

		// Box 4.
		expect(f.files.get(pathOf(TODAY))).toBe(today);
		expect(f.files.get(pathOf(TOMORROW))).toBe(tomorrow);
	});

	it("keeps a row the person edited after the plugin wrote it", async () => {
		const before = dayNote("| 13:00–14:00 | Team arkitektur – moved to Teams |");
		const f = fakes({ onTheDay: new Map(), whole: true, files: new Map([[pathOf(TODAY), before]]) });
		const memory: RowMemory = { "arkitektur": { "2026-10-02": { "780": wrote("13:00–14:00", "Team arkitektur") } } };

		await run(f, memory, 1);

		expect(f.files.get(pathOf(TODAY))).toBe(before);
	});

	it("keeps a row whose time cell the person changed after the plugin wrote it", async () => {
		const before = dayNote("| 13:30–14:00 | Team arkitektur |");
		const f = fakes({ onTheDay: new Map(), whole: true, files: new Map([[pathOf(TODAY), before]]) });
		const memory: RowMemory = { "arkitektur": { "2026-10-02": { "780": wrote("13:00–14:00", "Team arkitektur") } } };

		await run(f, memory, 1);

		expect(f.files.get(pathOf(TODAY))).toBe(before);
	});

	it("keeps a link the plugin kept as the person's own", async () => {
		const before = dayNote("| 13:00–14:00 | [[My own note]] |");
		const f = fakes({ onTheDay: new Map(), whole: true, files: new Map([[pathOf(TODAY), before]]) });
		const memory: RowMemory = {
			"arkitektur": {
				"2026-10-02": { "780": { time: "13:00–14:00", event: "[[My own note]]", title: "Team arkitektur", wrote: null } },
			},
		};

		await run(f, memory, 1);

		expect(f.files.get(pathOf(TODAY))).toBe(before);
	});

	it("keeps a row whose memory entry predates the record of who wrote it", async () => {
		const before = dayNote("| 13:00–14:00 | Team arkitektur |");
		const f = fakes({ onTheDay: new Map(), whole: true, files: new Map([[pathOf(TODAY), before]]) });
		const memory: RowMemory = {
			"arkitektur": { "2026-10-02": { "780": { time: "13:00–14:00", event: "Team arkitektur", title: "Team arkitektur" } } },
		};

		await run(f, memory, 1);

		expect(f.files.get(pathOf(TODAY))).toBe(before);
	});

	it("keeps a meeting's row when the meeting moved to another time on the same day", async () => {
		const f = fakes({
			onTheDay: new Map([
				["2026-10-02", [meeting({ uid: "arkitektur", summary: "Team arkitektur", start: new Date(2026, 9, 2, 15, 0), end: new Date(2026, 9, 2, 16, 0) })]],
			]),
			whole: true,
			files: new Map([[pathOf(TODAY), dayNote("| 13:00–14:00 | Team arkitektur |")]]),
		});
		const memory: RowMemory = { "arkitektur": { "2026-10-02": { "780": wrote("13:00–14:00", "Team arkitektur") } } };

		await run(f, memory, 1);

		expect(f.files.get(pathOf(TODAY))).toBe(dayNote("| 15:00–16:00 | Team arkitektur |"));
	});

	it("keeps a second copy of a row whose meeting is still on the day, though it reads exactly as the plugin wrote it", async () => {
		// The meeting claims one copy; the other matches the meeting's own
		// record. The meeting is not gone, so neither copy may go.
		const before = dayNote("| 14:00–14:30 | Standup |", "| 14:00–14:30 | Standup |");
		const f = fakes({
			onTheDay: new Map([["2026-10-02", [meeting({})]]]),
			whole: true,
			files: new Map([[pathOf(TODAY), before]]),
		});
		const memory: RowMemory = { "standup": { "2026-10-02": { "840": wrote("14:00–14:30", "Standup") } } };

		await run(f, memory, 1);

		expect(f.files.get(pathOf(TODAY))).toBe(before);
	});

	it("moves a meeting that moved to another day: its row leaves the old day and appears on the new one", async () => {
		const f = fakes({
			onTheDay: new Map([
				[
					"2026-10-03",
					[meeting({ uid: "arkitektur", summary: "Team arkitektur", start: new Date(2026, 9, 3, 13, 0), end: new Date(2026, 9, 3, 14, 0) })],
				],
			]),
			whole: true,
			files: new Map([
				[pathOf(TODAY), dayNote("| 13:00–14:00 | Team arkitektur |")],
				[pathOf(TOMORROW), dayNote()],
			]),
		});
		const memory: RowMemory = { "arkitektur": { "2026-10-02": { "780": wrote("13:00–14:00", "Team arkitektur") } } };

		await run(f, memory, 2);

		expect(f.files.get(pathOf(TODAY))).toBe(dayNote());
		expect(f.files.get(pathOf(TOMORROW))).toBe(dayNote("| 13:00–14:00 | Team arkitektur |"));
	});
});
