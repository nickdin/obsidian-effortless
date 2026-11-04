/**
 * Both features over one meeting that leaves the calendar, on the
 * real `CalendarSources` and one shared vault: the composition the repo's
 * rule asks a test of, since each feature's own tests pass with the other
 * faked away.
 *
 * Building the days ahead removes the row; meeting notes deletes the note.
 * Neither reaches into the other — both ask the core whether the
 * calendar's reading is whole, and what is on it — so the test that matters
 * is that the two answers agree: a cancelled meeting loses both, and a
 * meeting moved to another day loses its old row but keeps its note.
 */

import { describe, expect, it } from "vitest";
import type { App as ObsidianApp, TFile } from "obsidian";
import { App } from "./__mocks__/obsidian";
import { CalendarSources, newCalendarSource } from "../core/calendarSources";
import type { CalendarGateway } from "../core/calendarSources";
import { dailyLogFrame, dailyLogPath } from "../core/vaultLayout";
import { DeviceStore, defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { runWindow } from "../features/daysAhead/run";
import type { RowMemory } from "../features/daysAhead/rowMemory";
import { meetingNotePath } from "../features/meetingNotes/notePath";
import type { NotesMemory } from "../features/meetingNotes/notesMemory";
import { runMeetingNotes } from "../features/meetingNotes/run";
import { DEFAULT_TEMPLATE } from "../features/meetingNotes/types";

const NOON = new Date(2026, 9, 2, 12, 0);
const TODAY_LOG = "Journal/2026-10-02.md";
const TOMORROW_LOG = "Journal/2026-10-03.md";
const NOTE = meetingNotePath("Meetings", "2026-10-02", "Team arkitektur");

function layout(): VaultLayout {
	return { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
}

/** The work calendar with "Team arkitektur" on `day` (a `YYYYMMDD`), or with nothing on it when `day` is null. */
function calendarText(day: string | null): string {
	const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Effortless//Test//EN"];
	if (day !== null) {
		lines.push(
			"BEGIN:VEVENT",
			"UID:arkitektur@effortless.test",
			"DTSTAMP:20260901T120000Z",
			`DTSTART:${day}T130000`,
			`DTEND:${day}T140000`,
			"SUMMARY:Team arkitektur",
			"ATTENDEE;CN=Alva Almgren:mailto:alva.almgren@invented.test",
			"END:VEVENT",
		);
	}
	lines.push("END:VCALENDAR", "");
	return lines.join("\r\n");
}

/** One vault, one calendar and both features' memories, carried from run to run. */
class World {
	readonly files = new Map<string, string>();
	served = calendarText("20261002");
	/** A second calendar, empty; `false` makes its next read fail. */
	homeReads = true;
	rows: RowMemory = {};
	notes: NotesMemory = {};
	readonly calendar: CalendarSources;

	constructor() {
		const gateway: CalendarGateway = {
			fetch: async (url) => {
				if (url.endsWith("work.ics")) return this.served;
				if (!this.homeReads) throw new Error(`${url} answered 503`);
				return calendarText(null);
			},
			readFile: async (path) => {
				throw new Error(`no file at ${path}`);
			},
		};
		const sources = [
			{ ...newCalendarSource(), name: "Work", location: "https://cal.test/work.ics" },
			{ ...newCalendarSource(), name: "Home", location: "https://cal.test/home.ics" },
		];
		this.calendar = new CalendarSources(() => sources, new DeviceStore(new App() as unknown as ObsidianApp), gateway);
	}

	async runBoth(): Promise<void> {
		const files = this.files;
		const asFile = (path: string): TFile => ({ path }) as unknown as TFile;
		this.rows = await runWindow({
			calendar: this.calendar,
			notes: {
				createDailyLog: async (date, dayLayout) => {
					const path = dailyLogPath(date, dayLayout);
					if (!files.has(path)) files.set(path, dailyLogFrame(dayLayout));
					return asFile(path);
				},
				read: async (file) => files.get(file.path) ?? "",
				edit: async (file, edit) => {
					const next = edit(files.get(file.path) ?? "");
					files.set(file.path, next);
					return next;
				},
			},
			problems: { report: () => {}, clear: () => {}, list: () => [] },
			layout: layout(),
			windowDays: 2,
			today: NOON,
			memory: this.rows,
			commitMemory: async () => {},
		});
		await runMeetingNotes({
			calendar: this.calendar,
			vault: {
				exists: (path) => files.has(path),
				read: async (path) => files.get(path) ?? null,
				fileAt: (path) => (files.has(path) ? asFile(path) : null),
			},
			notes: {
				create: async (path, text) => {
					files.set(path, text);
					return asFile(path);
				},
				rename: async () => {
					throw new Error("nothing is renamed in this test");
				},
				edit: async (file, edit) => {
					const next = edit(files.get(file.path) ?? "");
					files.set(file.path, next);
					return next;
				},
				trashIf: async (file, shouldTrash) => {
					if (!shouldTrash(files.get(file.path) ?? "")) return false;
					files.delete(file.path);
					return true;
				},
			},
			problems: { report: () => {}, clear: () => {}, list: () => [] },
			layout: layout(),
			folder: "Meetings",
			template: DEFAULT_TEMPLATE,
			selfEmail: "self@invented.test",
			today: NOON,
			memory: this.notes,
			commitMemory: async (next) => {
				this.notes = next;
			},
		});
	}
}

describe("both features over a meeting that leaves the calendar", () => {
	it("removes the cancelled meeting's row and deletes its untouched note", async () => {
		const world = new World();
		await world.runBoth();
		expect(world.files.get(TODAY_LOG)).toContain("Team arkitektur");
		expect(world.files.has(NOTE)).toBe(true);

		world.served = calendarText(null);
		await world.runBoth();

		expect(world.files.get(TODAY_LOG)).toBe(dailyLogFrame(layout()));
		expect(world.files.has(NOTE)).toBe(false);
	});

	it("moves the row of a meeting moved to tomorrow, and keeps its note", async () => {
		const world = new World();
		await world.runBoth();

		world.served = calendarText("20261003");
		await world.runBoth();

		expect(world.files.get(TODAY_LOG)).toBe(dailyLogFrame(layout()));
		expect(world.files.get(TOMORROW_LOG)).toContain("Team arkitektur");
		expect(world.files.has(NOTE)).toBe(true);
	});

	it("removes the row on its own calendar's word but deletes no note while another calendar will not read", async () => {
		const world = new World();
		await world.runBoth();
		const note = world.files.get(NOTE);

		world.served = calendarText(null);
		world.homeReads = false;
		await world.runBoth();

		// Building the days ahead asks only the row's own source since #1211
		// decision 2; meeting notes still asks every source, so the note stays.
		expect(world.files.get(TODAY_LOG)).toBe(dailyLogFrame(layout()));
		expect(world.files.get(NOTE)).toBe(note);
	});
});
