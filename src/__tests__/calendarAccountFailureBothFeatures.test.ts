/**
 * Both features over a calendar account's calendar that stops reading, on the real `CalendarSources`, the
 * real account reader and one shared vault, with only the server played: the
 * composition `goneMeetingBothFeatures.test.ts` checks for a link.
 *
 * A refused password and a calendar gone from the account are failures of
 * the source, not news that its meetings were cancelled: the day's row and
 * the meeting's note stay exactly as they were.
 */

import { describe, expect, it } from "vitest";
import type { App as ObsidianApp, TFile } from "obsidian";
import { App } from "./__mocks__/obsidian";
import { CalendarSources } from "../core/calendarSources";
import type { CalendarSource } from "../core/calendarSources";
import { accountReader } from "../core/calendarAccounts";
import type { DavRequest } from "../core/calDav";
import { dailyLogFrame, dailyLogPath } from "../core/vaultLayout";
import { DeviceStore, defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { runWindow } from "../features/daysAhead/run";
import type { RowMemory } from "../features/daysAhead/rowMemory";
import { meetingNotePath } from "../features/meetingNotes/notePath";
import type { NotesMemory } from "../features/meetingNotes/notesMemory";
import { runMeetingNotes } from "../features/meetingNotes/run";
import { DEFAULT_TEMPLATE } from "../features/meetingNotes/types";

const NOON = new Date(2026, 9, 21, 12, 0);
const TODAY_LOG = "Journal/2026-10-21.md";
const NOTE = meetingNotePath("Meetings", "2026-10-21", "Team arkitektur");
const FAKE_PASSWORD = "fake-abcd-efgh";

function layout(): VaultLayout {
	return { ...defaultData().core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };
}

const work: CalendarSource = {
	id: "row-work",
	name: "Work",
	kind: "account",
	account: "acc-1",
	location: "https://p42-caldav.example.test/123/calendars/work/",
	showInDay: true,
	makeNotes: true,
};

/** "Team arkitektur" this afternoon (meeting notes makes notes for today's meetings), with one person invited, as the server's REPORT answer wraps it. */
const ANSWER = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/work/a.ics</d:href><d:propstat><d:prop><c:calendar-data>${[
	"BEGIN:VCALENDAR",
	"VERSION:2.0",
	"PRODID:-//Server//EN",
	"BEGIN:VEVENT",
	"UID:arkitektur@effortless.test",
	"DTSTAMP:20260901T120000Z",
	"DTSTART:20261021T130000",
	"DTEND:20261021T140000",
	"SUMMARY:Team arkitektur",
	"ATTENDEE;CN=Alva Almgren:mailto:alva.almgren@invented.test",
	"END:VEVENT",
	"END:VCALENDAR",
	"",
].join("\r\n")}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

/** One vault, one account calendar and both features' memories, carried from run to run. */
class World {
	readonly files = new Map<string, string>();
	/** What the server answers every REPORT with. */
	status = 207;
	rows: RowMemory = {};
	notes: NotesMemory = {};
	/** What building the days ahead says to the person, by key, as it stands after the last run. */
	readonly daysAheadSays = new Map<string, string>();
	readonly device = new DeviceStore(new App() as unknown as ObsidianApp);
	readonly calendar: CalendarSources;

	constructor() {
		const request: DavRequest = async () => ({ status: this.status, text: this.status === 207 ? ANSWER : "" });
		this.device.keepPassword("acc-1", FAKE_PASSWORD);
		this.calendar = new CalendarSources(
			() => [work],
			this.device,
			{
				fetch: (url) => Promise.reject(new Error(`no link expected: ${url}`)),
				readFile: (path) => Promise.reject(new Error(`no file expected: ${path}`)),
			},
			() => NOON.getTime(),
			undefined,
			accountReader(() => [{ id: "acc-1", address: "https://caldav.example.test", user: "someone@example.test" }], request),
		);
	}

	failure(): string | null | undefined {
		return this.device.read().calendarReads[work.id]?.failure;
	}

	async refreshAndRunBoth(): Promise<void> {
		await this.calendar.refresh();
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
			problems: {
				report: (key, message) => this.daysAheadSays.set(key, message),
				clear: (key) => this.daysAheadSays.delete(key),
				list: () => [...this.daysAheadSays.keys()],
			},
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

describe("both features over a calendar account's calendar that stops reading", () => {
	it("writes the meeting into today's table and makes its note, then leaves both alone when the password is refused", async () => {
		const world = new World();
		await world.refreshAndRunBoth();
		const day = world.files.get(TODAY_LOG);
		const note = world.files.get(NOTE);
		expect(day).toContain("Team arkitektur");
		expect(note).toBeDefined();

		expect([...world.daysAheadSays.values()]).toEqual([]);

		world.status = 401;
		await world.refreshAndRunBoth();

		expect(world.failure()).toMatch(/app-specific password/);
		// Announced the way building the days ahead announces any source that is not whole (#1211; spec #1212, decision 5).
		expect([...world.daysAheadSays.values()]).toEqual([
			'Effortless could not read the calendar source "Work", so no row from it is removed from the days ahead until it reads again.',
		]);
		expect(world.calendar.presenceBetween(NOON, 2, "day").whole).toBe(false);
		expect(world.files.get(TODAY_LOG)).toBe(day);
		expect(world.files.get(NOTE)).toBe(note);
	});

	it("leaves the day's row and the note alone when the calendar is no longer on the account", async () => {
		const world = new World();
		await world.refreshAndRunBoth();
		const day = world.files.get(TODAY_LOG);
		const note = world.files.get(NOTE);
		expect(day).toContain("Team arkitektur");
		expect(note).toBeDefined();

		world.status = 404;
		await world.refreshAndRunBoth();

		expect(world.failure()).toMatch(/no longer on the account/);
		expect(world.calendar.presenceBetween(NOON, 2, "day").whole).toBe(false);
		expect(world.files.get(TODAY_LOG)).toBe(day);
		expect(world.files.get(NOTE)).toBe(note);
	});
});
