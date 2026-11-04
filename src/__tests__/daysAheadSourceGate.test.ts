/**
 * Building the days ahead removing a row on its own calendar's word,
 * through one whole run over the window against fakes of its three ports.
 *
 * Before #1211 one calendar that would not read stopped every removal on
 * every day. Now a row remembers the source its meeting came from, and only
 * that source's own whole reading may remove it; a row remembered without
 * one keeps the old rule, every source whole. And a meeting the same whole
 * reading shows moved to another day loses its old row even once that row's
 * end time has passed — the one exception to "an ended row stays as
 * written".
 *
 * Each test holds a row whose removal turns on exactly one of those
 * conditions, beside a row whose keeping does, so a gate that removed
 * everything or nothing fails it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TFile } from "obsidian";
import type { SourcePresence } from "../core/calendarSources";
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
const TODAY_KEY = "2026-10-02";

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

/** What the plugin recorded writing for a meeting of `source`, the cell's own provenance record set to it. */
function wrote(time: string, event: string, source?: string): RowMemoryEntry {
	return { time, event, title: event, wrote: event, ...(source === undefined ? {} : { source }) };
}

function part(id: string, whole: boolean, meetings: readonly Meeting[] = []): SourcePresence {
	return { id, name: id === "work" ? "Work" : "Home", whole, meetings };
}

interface World {
	readonly files: Map<string, string>;
	memory: RowMemory;
	run(): Promise<void>;
}

/**
 * A run over today and tomorrow. `bySource` is the core's per-source answer;
 * a day's meetings are every source's meetings on it, as `meetingsOn` joins
 * them, so a failed source's part holds nothing.
 */
function world(options: {
	readonly bySource: readonly SourcePresence[];
	readonly files: ReadonlyMap<string, string>;
	readonly memory: RowMemory;
}): World {
	const files = new Map(options.files);
	const all = options.bySource.reduce<Meeting[]>((list, one) => list.concat(one.meetings), []);
	const calendar: RunCalendar = {
		refresh: async () => {},
		meetingsOn: (day, use) =>
			use === "day" ? all.filter((one) => localDateKey(one.start) === localDateKey(day)) : [],
		presenceBetween: () => ({
			whole: options.bySource.length > 0 && options.bySource.every((one) => one.whole),
			meetings: all,
			bySource: options.bySource,
		}),
	};
	const notes: RunNotes = {
		createDailyLog: async (date) => {
			const path = dailyLogPath(date, layout());
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
	const state: World = {
		files,
		memory: options.memory,
		run: async () => {
			state.memory = await runWindow({
				calendar,
				notes,
				problems,
				layout: layout(),
				windowDays: 2,
				today: new Date(),
				memory: state.memory,
				commitMemory: async () => {},
			});
		},
	};
	return state;
}

const todayPath = dailyLogPath(TODAY, layout());
const tomorrowPath = dailyLogPath(TOMORROW, layout());

describe("a row is removed on its own calendar's word", () => {
	it("removes a row of the calendar that read whole and keeps one of the calendar that failed", async () => {
		const w = world({
			bySource: [part("work", true), part("home", false)],
			files: new Map([[todayPath, dayNote("| 14:00–14:30 | Standup |", "| 15:00–16:00 | Football |")]]),
			memory: {
				standup: { [TODAY_KEY]: { "840": wrote("14:00–14:30", "Standup", "work") } },
				football: { [TODAY_KEY]: { "900": wrote("15:00–16:00", "Football", "home") } },
			},
		});

		await w.run();

		expect(w.files.get(todayPath)).toBe(dayNote("| 15:00–16:00 | Football |"));
		expect(w.memory.standup).toBeUndefined();
		expect(w.memory.football[TODAY_KEY]["900"].source).toBe("home");
	});

	it("keeps a row remembered with no source while any calendar failed, and removes it once every calendar reads whole", async () => {
		const files = new Map([[todayPath, dayNote("| 14:00–14:30 | Standup |")]]);
		const memory: RowMemory = { standup: { [TODAY_KEY]: { "840": wrote("14:00–14:30", "Standup") } } };

		const failing = world({ bySource: [part("work", true), part("home", false)], files, memory });
		await failing.run();
		expect(failing.files.get(todayPath)).toBe(dayNote("| 14:00–14:30 | Standup |"));

		const whole = world({ bySource: [part("work", true), part("home", true)], files, memory });
		await whole.run();
		expect(whole.files.get(todayPath)).toBe(dayNote());
	});
});

describe("a meeting moved to another day loses its old row even after the row's end time", () => {
	const ended = "| 09:00–10:00 | Standup |";
	const movedToTomorrow = meeting({ start: new Date(2026, 9, 3, 13, 0), end: new Date(2026, 9, 3, 14, 0) });
	const workMemory: RowMemory = { standup: { [TODAY_KEY]: { "540": wrote("09:00–10:00", "Standup", "work") } } };

	it("removes the ended row when its calendar's whole reading shows the meeting tomorrow, and keeps it when the meeting is simply gone", async () => {
		const movedWorld = world({
			bySource: [part("work", true, [movedToTomorrow]), part("home", false)],
			files: new Map([[todayPath, dayNote(ended)]]),
			memory: workMemory,
		});
		await movedWorld.run();
		expect(movedWorld.files.get(todayPath)).toBe(dayNote());
		expect(movedWorld.files.get(tomorrowPath)).toBe(dayNote("| 13:00–14:00 | Standup |"));
		expect(movedWorld.memory.standup[TODAY_KEY]).toBeUndefined();

		const goneWorld = world({
			bySource: [part("work", true), part("home", false)],
			files: new Map([[todayPath, dayNote(ended)]]),
			memory: workMemory,
		});
		await goneWorld.run();
		expect(goneWorld.files.get(todayPath)).toBe(dayNote(ended));
	});

	it("keeps the ended row of a moved meeting when its own calendar did not read whole", async () => {
		const w = world({
			bySource: [part("work", false, [movedToTomorrow]), part("home", true)],
			files: new Map([[todayPath, dayNote(ended)]]),
			memory: workMemory,
		});
		await w.run();
		expect(w.files.get(todayPath)).toBe(dayNote(ended));
	});

	it("keeps the ended row of a moved meeting when the person edited it, or when it was remembered with no source while a calendar failed", async () => {
		const edited = "| 09:00–10:00 | Standup – bring the slides |";
		const editedWorld = world({
			bySource: [part("work", true, [movedToTomorrow]), part("home", true)],
			files: new Map([[todayPath, dayNote(edited)]]),
			memory: workMemory,
		});
		await editedWorld.run();
		expect(editedWorld.files.get(todayPath)).toBe(dayNote(edited));

		const sourceless = world({
			bySource: [part("work", true, [movedToTomorrow]), part("home", false)],
			files: new Map([[todayPath, dayNote(ended)]]),
			memory: { standup: { [TODAY_KEY]: { "540": wrote("09:00–10:00", "Standup") } } },
		});
		await sourceless.run();
		expect(sourceless.files.get(todayPath)).toBe(dayNote(ended));
	});

	it("tells a moved occurrence of a repeating meeting from a cancelled one by the occurrence's original day", async () => {
		// Today's occurrence moved to tomorrow: it keeps today's original start as its key.
		const movedOccurrence = meeting({
			occurrenceKey: new Date(2026, 9, 2, 9, 0).toISOString(),
			start: new Date(2026, 9, 3, 13, 0),
			end: new Date(2026, 9, 3, 14, 0),
		});
		const movedWorld = world({
			bySource: [part("work", true, [movedOccurrence])],
			files: new Map([[todayPath, dayNote(ended)]]),
			memory: workMemory,
		});
		await movedWorld.run();
		expect(movedWorld.files.get(todayPath)).toBe(dayNote());

		// Today's occurrence cancelled: tomorrow's is tomorrow's own, keyed by tomorrow.
		const nextOccurrence = meeting({
			occurrenceKey: new Date(2026, 9, 3, 9, 0).toISOString(),
			start: new Date(2026, 9, 3, 9, 0),
			end: new Date(2026, 9, 3, 10, 0),
		});
		const cancelledWorld = world({
			bySource: [part("work", true, [nextOccurrence])],
			files: new Map([[todayPath, dayNote(ended)]]),
			memory: workMemory,
		});
		await cancelledWorld.run();
		expect(cancelledWorld.files.get(todayPath)).toBe(dayNote(ended));
	});

	it("reads an all-day occurrence's bare-date key as that date in every zone", async () => {
		vi.setSystemTime(new Date(2026, 9, 2, 23, 59, 30));
		const allDay = "| 00:00–23:59 | Leave |";
		const memory: RowMemory = { leave: { [TODAY_KEY]: { "0": wrote("00:00–23:59", "Leave", "work") } } };
		const occurrence = (key: string): Meeting =>
			meeting({
				uid: "leave",
				summary: "Leave",
				allDay: true,
				occurrenceKey: key,
				start: new Date(2026, 9, 3),
				end: new Date(2026, 9, 3),
			});

		const movedWorld = world({
			bySource: [part("work", true, [occurrence("2026-10-02")])],
			files: new Map([[todayPath, dayNote(allDay)]]),
			memory,
		});
		await movedWorld.run();
		expect(movedWorld.files.get(todayPath)).toBe(dayNote());

		const cancelledWorld = world({
			bySource: [part("work", true, [occurrence("2026-10-03")])],
			files: new Map([[todayPath, dayNote(allDay)]]),
			memory,
		});
		await cancelledWorld.run();
		expect(cancelledWorld.files.get(todayPath)).toBe(dayNote(allDay));
	});
});

describe("a row remembers the one calendar its meeting came from", () => {
	it("names the source holding the meeting, and none for a meeting two calendars both hold", async () => {
		const shared = meeting({ uid: "shared", summary: "Shared", start: new Date(2026, 9, 2, 15, 0), end: new Date(2026, 9, 2, 16, 0) });
		const w = world({
			bySource: [part("work", true, [meeting({}), shared]), part("home", true, [shared])],
			files: new Map(),
			memory: {},
		});
		await w.run();

		expect(w.memory.standup[TODAY_KEY]["840"].source).toBe("work");
		expect("source" in w.memory.shared[TODAY_KEY]["900"]).toBe(false);
	});

	it("records the source a row is now known by, when that is the memory's only change", async () => {
		const w = world({
			bySource: [part("work", true, [meeting({})])],
			files: new Map([[todayPath, dayNote("| 14:00–14:30 | Standup |")]]),
			memory: { standup: { [TODAY_KEY]: { "840": wrote("14:00–14:30", "Standup") } } },
		});
		await w.run();
		expect(w.memory.standup[TODAY_KEY]["840"]).toEqual(wrote("14:00–14:30", "Standup", "work"));
	});
});
