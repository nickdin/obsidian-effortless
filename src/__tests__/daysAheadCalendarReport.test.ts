/**
 * Building the days ahead saying that a calendar will not read.
 *
 * A dead calendar link was said only on its own row in settings, so the
 * person learnt of it from a moved meeting's old row that stayed. Now each
 * run reports, under one fixed key, the day sources that did not read whole,
 * and clears the key on the first run where every one did. The channel is
 * the real `Problems`, so "said once" is the channel's own one-event rule,
 * asserted where it lives, and the run's clearing of dates it no longer
 * visits is run with the calendar key standing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TFile } from "obsidian";
import { Notice } from "./__mocks__/obsidian";
import type { SourcePresence } from "../core/calendarSources";
import { Problems } from "../core/problems";
import { dailyLogFrame, dailyLogPath } from "../core/vaultLayout";
import { defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { CALENDAR_READING_KEY, runWindow } from "../features/daysAhead/run";
import type { RunCalendar, RunNotes, RunProblems } from "../features/daysAhead/run";

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2026, 9, 2, 12, 0));
	Notice.messages = [];
});
afterEach(() => vi.useRealTimers());

function layout(): VaultLayout {
	return { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
}

function part(name: string, whole: boolean): SourcePresence {
	return { id: `${name}-id`, name, whole, meetings: [] };
}

/** The real channel, with the list `daysAhead.ts`'s own port keeps beside it. */
function channel(problems: Problems): RunProblems {
	const feature = problems.forFeature("daysAhead", "Building the days ahead");
	const standing = new Set<string>();
	return {
		report: (key, message) => {
			standing.add(key);
			feature.report(key, message);
		},
		clear: (key) => {
			standing.delete(key);
			feature.clear(key);
		},
		list: () => [...standing],
	};
}

async function runWith(problems: RunProblems, bySource: readonly SourcePresence[], today = new Date()): Promise<void> {
	const files = new Map<string, string>();
	const calendar: RunCalendar = {
		refresh: async () => {},
		meetingsOn: () => [],
		presenceBetween: () => ({
			whole: bySource.length > 0 && bySource.every((one) => one.whole),
			meetings: [],
			bySource,
		}),
	};
	const notes: RunNotes = {
		createDailyLog: async (date) => {
			const path = dailyLogPath(date, layout());
			if (!files.has(path)) files.set(path, dailyLogFrame(layout()));
			return { path } as unknown as TFile;
		},
		read: async (file) => files.get(file.path) ?? "",
		edit: async (file, edit) => {
			const next = edit(files.get(file.path) ?? "");
			files.set(file.path, next);
			return next;
		},
	};
	await runWindow({
		calendar,
		notes,
		problems,
		layout: layout(),
		windowDays: 2,
		today,
		memory: {},
		commitMemory: async () => {},
	});
}

function calendarLine(problems: Problems): string | undefined {
	const line = problems.all().find((problem) => problem.key === CALENDAR_READING_KEY);
	return line === undefined ? undefined : line.message;
}

describe("building the days ahead says a calendar will not read", () => {
	it("reports the failing calendar by name, once, and clears it on the first run where every calendar reads whole", async () => {
		const problems = new Problems();
		const port = channel(problems);

		await runWith(port, [part("Work", true), part("Personal", false)]);
		expect(calendarLine(problems)).toBe(
			'Effortless could not read the calendar source "Personal", so no row from it is removed from the days ahead until it reads again.',
		);
		expect(Notice.messages.filter((message) => message.includes('"Personal"'))).toHaveLength(1);

		await runWith(port, [part("Work", true), part("Personal", false)]);
		expect(calendarLine(problems)).toBeDefined();
		expect(Notice.messages.filter((message) => message.includes('"Personal"'))).toHaveLength(1);

		await runWith(port, [part("Work", true), part("Personal", true)]);
		expect(calendarLine(problems)).toBeUndefined();
	});

	it("names every failing calendar in one line", async () => {
		const problems = new Problems();
		await runWith(channel(problems), [part("Work", true), part("Personal", false), part("Kids", false), part("Family", false)]);
		expect(calendarLine(problems)).toBe(
			'Effortless could not read the calendar sources "Personal", "Kids" and "Family", so no row from them is removed from the days ahead until they read again.',
		);
	});

	it("says nothing when no calendar is switched on for the day: nothing failed", async () => {
		const problems = new Problems();
		await runWith(channel(problems), []);
		expect(calendarLine(problems)).toBeUndefined();
	});

	it("leaves the calendar key standing while clearing the dates the window no longer reaches, so a dead link raises no second popup", async () => {
		const problems = new Problems();
		const port = channel(problems);
		await runWith(port, [part("Personal", false)]);
		port.report("2026-10-03", "tomorrow's problem");
		expect(problems.all().map((problem) => problem.key)).toEqual([CALENDAR_READING_KEY, "2026-10-03"]);

		// A week later: the window holds neither key as a date.
		await runWith(port, [part("Personal", false)], new Date(2026, 9, 9, 12, 0));

		expect(problems.all().map((problem) => problem.key)).toEqual([CALENDAR_READING_KEY]);
		expect(Notice.messages.filter((message) => message.includes('"Personal"'))).toHaveLength(1);
	});
});
