/**
 * The case #1211 was reported from, on the real `CalendarSources` and the
 * real gateway: a work calendar that reads, and a published family calendar
 * whose link answers 404. A meeting on the work calendar moves from day 1 to
 * day 3 of the window. Before #1211 the 404 kept the old row on day 1 for
 * good; now the work calendar's own whole reading moves it, and the run says
 * which calendar would not read.
 *
 * The composition is the core's per-source answer (`presenceBetween`'s
 * `bySource`), building the days ahead's reading of it (`removalReading.ts`),
 * the row memory's source, and the merge — each tested alone elsewhere.
 */

import { describe, expect, it } from "vitest";
import type { App as ObsidianApp, TFile } from "obsidian";
import { App } from "./__mocks__/obsidian";
import { CalendarSources, newCalendarSource, obsidianGateway } from "../core/calendarSources";
import { Problems } from "../core/problems";
import { dailyLogFrame, dailyLogPath } from "../core/vaultLayout";
import { DeviceStore, defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { CALENDAR_READING_KEY, runWindow } from "../features/daysAhead/run";
import type { RunProblems } from "../features/daysAhead/run";
import type { RowMemory } from "../features/daysAhead/rowMemory";

const DAY_1 = new Date(2026, 9, 20, 8, 0);
const DAY_1_LOG = "Journal/2026-10-20.md";
const DAY_3_LOG = "Journal/2026-10-22.md";

function layout(): VaultLayout {
	return { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
}

/** The work calendar with "Avstämning arkstyrning" from 15:00 to 16:00 on `day`, a `YYYYMMDD`. */
function workCalendar(day: string): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Effortless//Test//EN",
		"BEGIN:VEVENT",
		"UID:arkstyrning@effortless.test",
		"DTSTAMP:20261001T120000Z",
		`DTSTART:${day}T150000`,
		`DTEND:${day}T160000`,
		"SUMMARY:Avstämning arkstyrning",
		"END:VEVENT",
		"END:VCALENDAR",
		"",
	].join("\r\n");
}

class World {
	readonly files = new Map<string, string>();
	served = workCalendar("20261020");
	workAnswers = 200;
	familyAnswers = 200;
	rows: RowMemory = {};
	readonly problems = new Problems();
	private readonly calendar: CalendarSources;
	private readonly port: RunProblems;

	constructor() {
		const vault = {
			getFileByPath: () => null,
			cachedRead: async () => "",
		};
		const request = async ({ url }: { url: string }): Promise<{ status: number; text: string }> =>
			url.endsWith("work.ics")
				? { status: this.workAnswers, text: this.workAnswers === 200 ? this.served : "Service Unavailable" }
				: { status: this.familyAnswers, text: this.familyAnswers === 200 ? workCalendarEmpty() : "Not Found" };
		const sources = [
			{ ...newCalendarSource(), name: "Work", location: "https://cal.test/work.ics" },
			{ ...newCalendarSource(), name: "Family", location: "https://cal.test/family.ics" },
		];
		this.calendar = new CalendarSources(
			() => sources,
			new DeviceStore(new App() as unknown as ObsidianApp),
			obsidianGateway(vault as never, request),
		);
		const feature = this.problems.forFeature("daysAhead", "Building the days ahead");
		const standing = new Set<string>();
		this.port = {
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

	async run(): Promise<void> {
		const files = this.files;
		this.rows = await runWindow({
			calendar: this.calendar,
			notes: {
				createDailyLog: async (date, dayLayout) => {
					const path = dailyLogPath(date, dayLayout);
					if (!files.has(path)) files.set(path, dailyLogFrame(dayLayout));
					return { path } as unknown as TFile;
				},
				read: async (file) => files.get(file.path) ?? "",
				edit: async (file, edit) => {
					const next = edit(files.get(file.path) ?? "");
					files.set(file.path, next);
					return next;
				},
			},
			problems: this.port,
			layout: layout(),
			windowDays: 4,
			today: DAY_1,
			memory: this.rows,
			commitMemory: async () => {},
		});
	}
}

function workCalendarEmpty(): string {
	return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Effortless//Test//EN", "END:VCALENDAR", ""].join("\r\n");
}

describe("one dead calendar link no longer keeps a moved meeting's old row", () => {
	it("moves the work meeting's row from day 1 to day 3 while the family calendar answers 404, and says the family calendar failed", async () => {
		const world = new World();
		await world.run();
		expect(world.files.get(DAY_1_LOG)).toContain("Avstämning arkstyrning");

		world.familyAnswers = 404;
		world.served = workCalendar("20261022");
		await world.run();

		expect(world.files.get(DAY_1_LOG)).toBe(dailyLogFrame(layout()));
		expect(world.files.get(DAY_3_LOG)).toContain("| 15:00–16:00 | Avstämning arkstyrning |");
		expect(world.problems.all().filter((problem) => problem.key === CALENDAR_READING_KEY).map((problem) => problem.message)).toEqual([
			'Effortless could not read the calendar source "Family", so no row from it is removed from the days ahead until it reads again.',
		]);
	});

	it("keeps the row's own source through a run on which that source failed, so the row still moves once it reads again", async () => {
		const world = new World();
		world.familyAnswers = 404;
		await world.run();
		const written = world.rows["arkstyrning@effortless.test"]["2026-10-20"]["900"];
		expect(written.source).toBeDefined();

		// The work calendar fails one read; its held copy still shows the meeting on day 1.
		world.workAnswers = 503;
		await world.run();
		expect(world.files.get(DAY_1_LOG)).toContain("| 15:00–16:00 | Avstämning arkstyrning |");
		expect(world.rows["arkstyrning@effortless.test"]["2026-10-20"]["900"].source).toBe(written.source);

		// It reads again, the meeting moved; the family calendar is still dead.
		world.workAnswers = 200;
		world.served = workCalendar("20261022");
		await world.run();
		expect(world.files.get(DAY_1_LOG)).toBe(dailyLogFrame(layout()));
		expect(world.files.get(DAY_3_LOG)).toContain("| 15:00–16:00 | Avstämning arkstyrning |");
	});
});
