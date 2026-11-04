/**
 * One run over the window, against a fake {@link RunCalendar} and a fake
 * {@link RunNotes} — the Obsidian half holds no decisions, so nothing here
 * touches the app.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TFile } from "obsidian";
import type { CalendarTableAbsence } from "../core/calendarTable";
import type { Meeting } from "../core/icsReader";
import { dailyLogFrame, dailyLogPath } from "../core/vaultLayout";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { localDateKey } from "../features/daysAhead/desiredRows";
import { runWindow } from "../features/daysAhead/run";
import type { RunCalendar, RunDeps, RunNotes, RunProblems } from "../features/daysAhead/run";
import type { RowMemory } from "../features/daysAhead/rowMemory";

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

function meeting(partial: Partial<Meeting>): Meeting {
	return {
		uid: "uid-1",
		summary: "Standup",
		location: null,
		description: null,
		organizer: null,
		attendees: [],
		occurrenceKey: null,
		allDay: false,
		start: new Date(2026, 7, 20, 9, 0),
		end: new Date(2026, 7, 20, 9, 30),
		...partial,
	};
}

/** Records every call in one shared log, so ordering across the three ports can be asserted. */
class RunLog {
	readonly calls: string[] = [];
}

interface FakeCalendarOptions {
	readonly onTheDay?: ReadonlyMap<string, readonly Meeting[]>;
	readonly makingNotes?: ReadonlyMap<string, readonly Meeting[]>;
}

function fakeCalendar(log: RunLog, options: FakeCalendarOptions = {}): RunCalendar {
	return {
		async refresh(): Promise<void> {
			log.calls.push("refresh");
		},
		presenceBetween: () => ({ whole: false, meetings: [] }),
		meetingsOn(day, use): readonly Meeting[] {
			const key = localDateKey(day);
			const table = use === "day" ? options.onTheDay : options.makingNotes;
			return table?.get(key) ?? [];
		},
	};
}

interface FakeNotesOptions {
	/** Content a day's log already holds, keyed by date. Missing dates are created fresh. */
	readonly existing?: ReadonlyMap<string, string>;
	/** A date whose `createDailyLog` rejects. */
	readonly createThrows?: ReadonlySet<string>;
	/** A date whose `edit` rejects. */
	readonly editThrows?: ReadonlySet<string>;
}

interface FakeNotes extends RunNotes {
	readonly files: Map<string, string>;
	readonly createdFresh: string[];
	readonly editedPaths: string[];
}

function fakeNotes(log: RunLog, options: FakeNotesOptions = {}): FakeNotes {
	const files = new Map(options.existing ?? []);
	const createdFresh: string[] = [];
	const editedPaths: string[] = [];

	return {
		files,
		createdFresh,
		editedPaths,
		async createDailyLog(date, dayLayout): Promise<TFile> {
			const path = dailyLogPath(date, dayLayout);
			const key = localDateKey(date);
			log.calls.push(`create:${key}`);
			if (options.createThrows?.has(key)) throw new Error(`could not create ${path}`);
			if (!files.has(path)) {
				files.set(path, dailyLogFrame(dayLayout));
				createdFresh.push(path);
			}
			return file(path);
		},
		async read(target): Promise<string> {
			const path = (target as unknown as { path: string }).path;
			log.calls.push(`read:${path}`);
			const content = files.get(path);
			if (content === undefined) throw new Error(`no fake content for ${path}`);
			return content;
		},
		async edit(target, edit): Promise<string> {
			const path = (target as unknown as { path: string }).path;
			const key = path.slice("Journal/".length, path.length - ".md".length);
			editedPaths.push(path);
			log.calls.push(`edit:${path}`);
			if (options.editThrows?.has(key)) throw new Error(`could not write ${path}`);
			const current = files.get(path) ?? "";
			const next = edit(current);
			files.set(path, next);
			return next;
		},
	};
}

interface FakeProblems extends RunProblems {
	readonly reports: { key: string; message: string }[];
	readonly cleared: string[];
	list(): readonly string[];
}

/** Tracks which keys are currently standing, the way the real `Problems` channel does, so `list()` answers truthfully. */
function fakeProblems(): FakeProblems {
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

/** A `RunDeps` with every field defaulted, so one test overrides only what it cares about. */
function deps(overrides: Partial<RunDeps> & { log?: RunLog } = {}): RunDeps {
	const log = overrides.log ?? new RunLog();
	const commits: RowMemory[] = [];
	return {
		calendar: fakeCalendar(log),
		notes: fakeNotes(log),
		problems: fakeProblems(),
		layout: layout(),
		windowDays: 1,
		today: TODAY,
		memory: {},
		commitMemory: async (memory) => {
			commits.push(memory);
		},
		...overrides,
	};
}

describe("runWindow — refresh", () => {
	it("awaits refresh exactly once per run, before any day is touched", async () => {
		const log = new RunLog();
		await runWindow(deps({ log, windowDays: 3 }));

		expect(log.calls.filter((call) => call === "refresh")).toHaveLength(1);
		expect(log.calls[0]).toBe("refresh");
	});
});

describe("runWindow — creating a day", () => {
	it("does not recreate a day that already exists, and writes nothing to it by the create step alone", async () => {
		const path = dailyLogPath(TODAY, layout());
		const notes = fakeNotes(new RunLog(), { existing: new Map([[path, dailyLogFrame(layout())]]) });
		await runWindow(deps({ notes, windowDays: 1 }));

		expect(notes.createdFresh).toEqual([]);
	});

	it("creates a day that does not exist yet, and fills it in the same run", async () => {
		const day = meeting({ uid: "m1", summary: "Standup" });
		const calendar = fakeCalendar(new RunLog(), {
			onTheDay: new Map([["2026-08-20", [day]]]),
		});
		const notes = fakeNotes(new RunLog());
		await runWindow(deps({ calendar, notes, windowDays: 1 }));

		const path = dailyLogPath(TODAY, layout());
		expect(notes.createdFresh).toEqual([path]);
		expect(notes.files.get(path)).toContain("Standup");
	});
});

describe("runWindow — a day whose table cannot be located or read", () => {
	const columns = { time: "Start", event: "What" };

	const CASES: { readonly name: CalendarTableAbsence; readonly content: string }[] = [
		{ name: "no-schema-block", content: "# Notes\n\nNothing here.\n" },
		{ name: "no-table-in-block", content: "```schema\nnot a table\n```\n" },
		{
			name: "column-name-blank",
			content: `\`\`\`schema\n| ${columns.time} | ${columns.event} |\n| --- | --- |\n\`\`\`\n`,
		},
	];

	for (const { name, content } of CASES) {
		it(`reports "${name}" once, keyed by the date, and leaves the log byte-identical`, async () => {
			const path = dailyLogPath(TODAY, layout());
			const notes = fakeNotes(new RunLog(), { existing: new Map([[path, content]]) });
			const problems = fakeProblems();

			// column-name-blank needs a layout whose own column name is blank —
			// the note's own table cannot cause it, since a blank column name
			// stops the search before the note is even looked at.
			const runLayout = name === "column-name-blank" ? { ...layout(), calendarColumns: { time: "", event: "What" } } : layout();

			await runWindow(deps({ notes, problems, layout: runLayout, windowDays: 1 }));

			expect(notes.files.get(path)).toBe(content);
			expect(problems.reports).toHaveLength(1);
			expect(problems.reports[0].key).toBe("2026-08-20");
			expect(problems.cleared).toEqual([]);
		});
	}

	it('reports "column-names-alike" when the two configured names fold to the same text', async () => {
		const path = dailyLogPath(TODAY, layout());
		const runLayout = { ...layout(), calendarColumns: { time: "Start", event: "start" } };
		const notes = fakeNotes(new RunLog(), { existing: new Map([[path, dailyLogFrame(layout())]]) });
		const problems = fakeProblems();

		await runWindow(deps({ notes, problems, layout: runLayout, windowDays: 1 }));

		expect(notes.files.get(path)).toBe(dailyLogFrame(layout()));
		expect(problems.reports).toHaveLength(1);
	});

	it('reports "column-named-twice" when the table names one configured column twice', async () => {
		const path = dailyLogPath(TODAY, layout());
		const content = "```schema\n| Start | Start |\n| --- | --- |\n```\n";
		const notes = fakeNotes(new RunLog(), { existing: new Map([[path, content]]) });
		const problems = fakeProblems();

		await runWindow(deps({ notes, problems, windowDays: 1 }));

		expect(notes.files.get(path)).toBe(content);
		expect(problems.reports).toHaveLength(1);
	});

	it("names the broken day in the message itself, not only in the report's key", async () => {
		const path = dailyLogPath(TODAY, layout());
		const broken = "# Notes\n\nNo calendar block at all.\n";
		const notes = fakeNotes(new RunLog(), { existing: new Map([[path, broken]]) });
		const problems = fakeProblems();

		await runWindow(deps({ notes, problems, windowDays: 1 }));

		// The settings screen draws only `featureName` and `message` — never
		// `key` (Finding #724, Finding #725) — so a person reading it can tell
		// this row apart from another day's only if the date is in the words.
		expect(problems.reports).toHaveLength(1);
		expect(problems.reports[0].key).toBe("2026-08-20");
		expect(problems.reports[0].message).toContain("2026-08-20");
	});

	it("clears the report once the day fills cleanly again", async () => {
		const path = dailyLogPath(TODAY, layout());
		const broken = "# Notes\n\nNo calendar block at all.\n";
		const problems = fakeProblems();

		let notes = fakeNotes(new RunLog(), { existing: new Map([[path, broken]]) });
		await runWindow(deps({ notes, problems, windowDays: 1 }));
		expect(problems.reports).toHaveLength(1);
		expect(problems.cleared).toEqual([]);

		notes = fakeNotes(new RunLog(), { existing: new Map([[path, dailyLogFrame(layout())]]) });
		await runWindow(deps({ notes, problems, windowDays: 1 }));
		expect(problems.cleared).toEqual(["2026-08-20"]);
	});

	it("clears a standing report once midnight moves the run past the date it named", async () => {
		const path = dailyLogPath(TODAY, layout());
		const broken = "# Notes\n\nNo calendar block at all.\n";
		const problems = fakeProblems();

		const firstNotes = fakeNotes(new RunLog(), { existing: new Map([[path, broken]]) });
		await runWindow(deps({ notes: firstNotes, problems, today: TODAY, windowDays: 1 }));
		expect(problems.reports).toHaveLength(1);
		expect(problems.reports[0].key).toBe("2026-08-20");

		// Midnight passes: the run's own window no longer reaches the 20th at
		// all, so nothing will ever visit it again to clear the report.
		const nextDay = new Date(2026, 7, 21);
		const nextPath = dailyLogPath(nextDay, layout());
		const secondNotes = fakeNotes(new RunLog(), { existing: new Map([[nextPath, dailyLogFrame(layout())]]) });
		await runWindow(deps({ notes: secondNotes, problems, today: nextDay, windowDays: 1 }));

		expect(problems.cleared).toContain("2026-08-20");
	});

	it("clears a standing report for a date Days ahead no longer reaches", async () => {
		const path1 = dailyLogPath(TODAY, layout());
		const path2 = dailyLogPath(new Date(2026, 7, 21), layout());
		const broken = "# Notes\n\nNo calendar block at all.\n";
		const problems = fakeProblems();

		const firstNotes = fakeNotes(new RunLog(), {
			existing: new Map([
				[path1, dailyLogFrame(layout())],
				[path2, broken],
			]),
		});
		await runWindow(deps({ notes: firstNotes, problems, today: TODAY, windowDays: 2 }));
		expect(problems.reports.map((report) => report.key)).toContain("2026-08-21");

		// Days ahead shrinks to 1: the run no longer reaches the 21st, so
		// nothing will ever visit it again to clear the report.
		const secondNotes = fakeNotes(new RunLog(), { existing: new Map([[path1, dailyLogFrame(layout())]]) });
		await runWindow(deps({ notes: secondNotes, problems, today: TODAY, windowDays: 1 }));

		expect(problems.cleared).toContain("2026-08-21");
	});
});

describe("runWindow — a day that throws", () => {
	it("does not stop the window: every later day in the same run is still filled", async () => {
		const brokenPath = dailyLogPath(TODAY, layout());
		const notes = fakeNotes(new RunLog(), {
			existing: new Map([[brokenPath, dailyLogFrame(layout())]]),
			createThrows: new Set(["2026-08-20"]),
		});
		const calendar = fakeCalendar(new RunLog(), {
			onTheDay: new Map([["2026-08-21", [meeting({ uid: "m2", summary: "Retro" })]]]),
		});
		const problems = fakeProblems();

		await runWindow(deps({ notes, calendar, problems, windowDays: 2 }));

		expect(problems.reports).toHaveLength(1);
		expect(problems.reports[0].key).toBe("2026-08-20");
		// There was never a table to fail at — the day's log itself could not
		// be created, and the report must say that rather than blaming a table.
		expect(problems.reports[0].message).toContain("could not create this day's log");
		expect(problems.reports[0].message).not.toContain("calendar table");
		const secondPath = dailyLogPath(new Date(2026, 7, 21), layout());
		expect(notes.files.get(secondPath)).toContain("Retro");
	});

	it("reports a write that rejects the same way, and the window carries on", async () => {
		const path = dailyLogPath(TODAY, layout());
		const calendar = fakeCalendar(new RunLog(), {
			onTheDay: new Map([
				["2026-08-20", [meeting({ uid: "m1", summary: "Standup" })]],
				["2026-08-21", [meeting({ uid: "m2", summary: "Retro" })]],
			]),
		});
		const notes = fakeNotes(new RunLog(), { editThrows: new Set(["2026-08-20"]) });
		const problems = fakeProblems();

		await runWindow(deps({ notes, calendar, problems, windowDays: 2 }));

		expect(problems.reports).toHaveLength(1);
		expect(problems.reports[0].key).toBe("2026-08-20");
		expect(notes.files.get(path)).toBe(dailyLogFrame(layout()));
		const secondPath = dailyLogPath(new Date(2026, 7, 21), layout());
		expect(notes.files.get(secondPath)).toContain("Retro");
	});
});

describe("runWindow — a day that already reads exactly as it would be written", () => {
	it("causes no edit call at all", async () => {
		const path = dailyLogPath(TODAY, layout());
		const before = dailyLogFrame(layout());
		const notes = fakeNotes(new RunLog(), { existing: new Map([[path, before]]) });

		await runWindow(deps({ notes, windowDays: 1 }));

		expect(notes.editedPaths).toEqual([]);
		expect(notes.files.get(path)).toBe(before);
	});

	it("still calls edit once when a row genuinely changes", async () => {
		const path = dailyLogPath(TODAY, layout());
		const before = dailyLogFrame(layout());
		const notes = fakeNotes(new RunLog(), { existing: new Map([[path, before]]) });
		const calendar = fakeCalendar(new RunLog(), {
			onTheDay: new Map([["2026-08-20", [meeting({ uid: "m1", summary: "Standup" })]]]),
		});

		await runWindow(deps({ notes, calendar, windowDays: 1 }));

		expect(notes.editedPaths).toEqual([path]);
	});
});

describe("runWindow — the memory", () => {
	it("is written only after a successful write", async () => {
		const calendar = fakeCalendar(new RunLog(), {
			onTheDay: new Map([["2026-08-20", [meeting({ uid: "m1", summary: "Standup" })]]]),
		});
		const commits: RowMemory[] = [];
		await runWindow(
			deps({
				calendar,
				windowDays: 1,
				commitMemory: async (memory) => {
					commits.push(memory);
				},
			}),
		);

		expect(commits).toHaveLength(1);
		expect(commits[0]).toEqual({ "m1": { "2026-08-20": { "540": { time: "09:00–09:30", event: "Standup", title: "Standup", wrote: "Standup" } } } });
	});

	it("is not written at all after a write that rejects", async () => {
		const calendar = fakeCalendar(new RunLog(), {
			onTheDay: new Map([["2026-08-20", [meeting({ uid: "m1", summary: "Standup" })]]]),
		});
		const notes = fakeNotes(new RunLog(), { editThrows: new Set(["2026-08-20"]) });
		const commits: RowMemory[] = [];
		const outcome = await runWindow(
			deps({
				calendar,
				notes,
				windowDays: 1,
				commitMemory: async (memory) => {
					commits.push(memory);
				},
			}),
		);

		expect(commits).toEqual([]);
		expect(outcome).toEqual({});
	});

	it("says the table was filled but could not be remembered, when commitMemory rejects", async () => {
		const calendar = fakeCalendar(new RunLog(), {
			onTheDay: new Map([["2026-08-20", [meeting({ uid: "m1", summary: "Standup" })]]]),
		});
		const problems = fakeProblems();

		await runWindow(
			deps({
				calendar,
				problems,
				windowDays: 1,
				commitMemory: async () => {
					throw new Error("disk full");
				},
			}),
		);

		// The table itself landed — only the memory of it failed to store, and
		// the report must say that rather than blaming the table.
		expect(problems.reports).toHaveLength(1);
		expect(problems.reports[0].message).toContain("could not remember it");
		expect(problems.reports[0].message).toContain("disk full");
		expect(problems.reports[0].message).not.toContain("could not fill");
	});

	it("records what the merge said even for a day that needed no write", async () => {
		const path = dailyLogPath(TODAY, layout());
		const before = "```schema\n| Start | What |\n| --- | --- |\n| 09:00–09:30 | Standup |\n```\n";
		const notes = fakeNotes(new RunLog(), { existing: new Map([[path, before]]) });
		const calendar = fakeCalendar(new RunLog(), {
			onTheDay: new Map([["2026-08-20", [meeting({ uid: "m1", summary: "Standup" })]]]),
		});
		const commits: RowMemory[] = [];

		await runWindow(
			deps({
				notes,
				calendar,
				windowDays: 1,
				commitMemory: async (memory) => {
					commits.push(memory);
				},
			}),
		);

		expect(notes.editedPaths).toEqual([]);
		expect(commits).toHaveLength(1);
		expect(commits[0]["m1"]?.["2026-08-20"]?.["540"]).toEqual({ time: "09:00–09:30", event: "Standup", title: "Standup", wrote: "Standup" });
	});

	it("is pruned of every date before today on each run, keeping today's entries", async () => {
		const memory: RowMemory = {
			old: { "2026-08-19": { "540": { time: "09:00–09:30", event: "Gone", title: "Gone" } } },
			today: { "2026-08-20": { "540": { time: "09:00–09:30", event: "Still here", title: "Still here" } } },
		};
		const commits: RowMemory[] = [];
		const outcome = await runWindow(
			deps({
				memory,
				windowDays: 1,
				commitMemory: async (m) => {
					commits.push(m);
				},
			}),
		);

		expect(outcome["old"]).toBeUndefined();
		expect(outcome["today"]).toEqual({ "2026-08-20": { "540": { time: "09:00–09:30", event: "Still here", title: "Still here" } } });
		// The return value is not what production reads — the
		// commit `commits` records is.
		expect(commits.some((committed) => committed["old"] === undefined)).toBe(true);
	});

	it("drops a uid's old start key once the calendar moves it to a new start minute, rather than leaving it behind", async () => {
		const memory: RowMemory = {
			m1: { "2026-08-20": { "540": { time: "09:00–09:30", event: "Standup", title: "Standup" } } },
		};
		const moved = meeting({ uid: "m1", summary: "Standup", start: new Date(2026, 7, 20, 11, 0), end: new Date(2026, 7, 20, 11, 30) });
		const calendar = fakeCalendar(new RunLog(), {
			onTheDay: new Map([["2026-08-20", [moved]]]),
		});
		const commits: RowMemory[] = [];

		await runWindow(
			deps({
				calendar,
				memory,
				windowDays: 1,
				commitMemory: async (m) => {
					commits.push(m);
				},
			}),
		);

		// If the old start key is merely kept alongside the new one, this run's
		// memory holds both "540" and "660" for m1/2026-08-20 instead of just
		// "660" — the stale key would then survive until the whole date is
		// pruned as past, and could claim another occurrence's row.
		expect(commits).toHaveLength(1);
		expect(commits[0]).toEqual({
			m1: {
				"2026-08-20": {
					"660": { time: "11:00–11:30", event: "Standup", title: "Standup", wrote: "Standup" },
				},
			},
		});
	});

	it("leaves a uid's memory exactly as it was when this run's updates never name it", async () => {
		const memory: RowMemory = {
			m1: { "2026-08-20": { "540": { time: "09:00–09:30", event: "Standup", title: "Standup" } } },
			m2: { "2026-08-20": { "600": { time: "10:00–10:30", event: "Retro", title: "Retro" } } },
		};
		const moved = meeting({ uid: "m1", summary: "Standup", start: new Date(2026, 7, 20, 11, 0), end: new Date(2026, 7, 20, 11, 30) });
		const calendar = fakeCalendar(new RunLog(), {
			onTheDay: new Map([["2026-08-20", [moved]]]),
		});
		const commits: RowMemory[] = [];

		await runWindow(
			deps({
				calendar,
				memory,
				windowDays: 1,
				commitMemory: async (m) => {
					commits.push(m);
				},
			}),
		);

		// m2 never appears in this run's calendar, so withRemembered never
		// receives an update naming it. If the fix rebuilt the whole memory
		// from just this run's updates instead of only the uids they name,
		// m2's entry would be dropped here instead of surviving byte-identical.
		expect(commits).toHaveLength(1);
		expect(commits[0]["m2"]).toEqual({ "2026-08-20": { "600": { time: "10:00–10:30", event: "Retro", title: "Retro" } } });
		expect(commits[0]["m1"]).toEqual({ "2026-08-20": { "660": { time: "11:00–11:30", event: "Standup", title: "Standup", wrote: "Standup" } } });
	});

	it("reaches data.json even when the window's only day cannot be read", async () => {
		const path = dailyLogPath(TODAY, layout());
		const broken = "# Notes\n\nNo calendar block at all.\n";
		const memory: RowMemory = {
			old: { "2026-08-19": { "540": { time: "09:00–09:30", event: "Gone", title: "Gone" } } },
		};
		const notes = fakeNotes(new RunLog(), { existing: new Map([[path, broken]]) });
		const problems = fakeProblems();
		const commits: RowMemory[] = [];

		await runWindow(
			deps({
				notes,
				problems,
				memory,
				windowDays: 1,
				commitMemory: async (m) => {
					commits.push(m);
				},
			}),
		);

		// The day's own table cannot be read, so runDay never reaches its own
		// commit — the prune still has to reach data.json, or a stored date
		// this feature will never touch again stays there for ever.
		expect(problems.reports).toHaveLength(1);
		expect(commits).toHaveLength(1);
		expect(commits[0]).toEqual({});
	});
});

describe("runWindow — two meetings of one repeating uid on the same day", () => {
	it("keeps them as two independent memory entries — neither is dropped nor overwritten", async () => {
		const morning = meeting({ uid: "m1", summary: "Morning sync", start: new Date(2026, 7, 20, 9, 0), end: new Date(2026, 7, 20, 9, 30) });
		const afternoon = meeting({ uid: "m1", summary: "Afternoon sync", start: new Date(2026, 7, 20, 13, 0), end: new Date(2026, 7, 20, 13, 30) });
		const calendar = fakeCalendar(new RunLog(), {
			onTheDay: new Map([["2026-08-20", [morning, afternoon]]]),
		});
		const commits: RowMemory[] = [];
		await runWindow(
			deps({
				calendar,
				windowDays: 1,
				commitMemory: async (m) => {
					commits.push(m);
				},
			}),
		);

		// If the key still stops at the date, the second write clobbers the
		// first and this reports one entry — the afternoon meeting's — instead
		// of two.
		expect(commits).toHaveLength(1);
		expect(commits[0]).toEqual({
			m1: {
				"2026-08-20": {
					"540": { time: "09:00–09:30", event: "Morning sync", title: "Morning sync", wrote: "Morning sync" },
					"780": { time: "13:00–13:30", event: "Afternoon sync", title: "Afternoon sync", wrote: "Afternoon sync" },
				},
			},
		});
	});

	it("finds the renamed one through memory on the next run, without duplicating its row", async () => {
		const day1 = [
			meeting({ uid: "m1", summary: "Old A", start: new Date(2026, 7, 20, 9, 0), end: new Date(2026, 7, 20, 9, 30) }),
			meeting({ uid: "m1", summary: "Old B", start: new Date(2026, 7, 20, 13, 0), end: new Date(2026, 7, 20, 13, 30) }),
		];
		const calendar1 = fakeCalendar(new RunLog(), { onTheDay: new Map([["2026-08-20", day1]]) });
		const notes = fakeNotes(new RunLog());
		const memoryAfterFirstRun = await runWindow(deps({ calendar: calendar1, notes, windowDays: 1 }));

		// Only the 9:00 meeting's title changes; the 13:00 one is untouched.
		const day2 = [
			meeting({ uid: "m1", summary: "New A", start: new Date(2026, 7, 20, 9, 0), end: new Date(2026, 7, 20, 9, 30) }),
			meeting({ uid: "m1", summary: "Old B", start: new Date(2026, 7, 20, 13, 0), end: new Date(2026, 7, 20, 13, 30) }),
		];
		const calendar2 = fakeCalendar(new RunLog(), { onTheDay: new Map([["2026-08-20", day2]]) });
		await runWindow(deps({ calendar: calendar2, notes, memory: memoryAfterFirstRun, windowDays: 1 }));

		const path = dailyLogPath(TODAY, layout());
		const content = notes.files.get(path) ?? "";
		const count = (needle: string) => content.split(needle).length - 1;

		// If the key still stops at the date, only the 13:00 meeting's memory
		// survives the first run; the second run cannot find the 9:00 meeting's
		// row by memory or by its now-stale title, so it adds a second row
		// beside it rather than renaming it in place — "Old A" would still be
		// there, once, alongside the new row.
		expect(count("Old A")).toBe(0);
		expect(count("New A")).toBe(1);
		expect(count("Old B")).toBe(1);
	});
});

describe("runWindow — skipping an unchanged write", () => {
	it("makes no write to data.json on a second run over an unchanged calendar", async () => {
		const calendar = fakeCalendar(new RunLog(), {
			onTheDay: new Map([["2026-08-20", [meeting({ uid: "m1", summary: "Standup" })]]]),
		});
		const notes = fakeNotes(new RunLog());

		let memory: RowMemory = {};
		let commits: RowMemory[] = [];
		memory = await runWindow(
			deps({
				calendar,
				notes,
				windowDays: 1,
				memory,
				commitMemory: async (m) => {
					commits.push(m);
				},
			}),
		);
		// The first run remembers a meeting it had never seen before — that is
		// a real change, and one write for it is correct.
		expect(commits).toHaveLength(1);

		commits = [];
		await runWindow(
			deps({
				calendar,
				notes,
				windowDays: 1,
				memory,
				commitMemory: async (m) => {
					commits.push(m);
				},
			}),
		);

		// Nothing about the day changed between the two runs — the note
		// already reads as it would be written, and the memory already holds
		// what the merge says. A second run over the same ground must not
		// join the write queue at all.
		expect(commits).toEqual([]);
	});

	it("commits once when only one of several days changed, not once per day", async () => {
		const day1 = meeting({ uid: "m1", summary: "Standup", start: new Date(2026, 7, 20, 9, 0), end: new Date(2026, 7, 20, 9, 30) });
		const day2 = meeting({ uid: "m2", summary: "Retro", start: new Date(2026, 7, 21, 10, 0), end: new Date(2026, 7, 21, 10, 30) });
		const calendarBefore = fakeCalendar(new RunLog(), {
			onTheDay: new Map([
				["2026-08-20", [day1]],
				["2026-08-21", [day2]],
			]),
		});
		const notes = fakeNotes(new RunLog());
		const memory = await runWindow(deps({ calendar: calendarBefore, notes, windowDays: 2 }));

		const day2Moved = meeting({ uid: "m2", summary: "Retro", start: new Date(2026, 7, 21, 11, 0), end: new Date(2026, 7, 21, 11, 30) });
		const calendarAfter = fakeCalendar(new RunLog(), {
			onTheDay: new Map([
				["2026-08-20", [day1]],
				["2026-08-21", [day2Moved]],
			]),
		});
		const commits: RowMemory[] = [];

		await runWindow(
			deps({
				calendar: calendarAfter,
				notes,
				memory,
				windowDays: 2,
				commitMemory: async (m) => {
					commits.push(m);
				},
			}),
		);

		// Day one's calendar and note are exactly as the first run left them;
		// day two's meeting moved. Only day two's change may reach data.json.
		expect(commits).toHaveLength(1);
		expect(commits[0]["m2"]?.["2026-08-21"]?.["660"]?.time).toBe("11:00–11:30");
	});
});
