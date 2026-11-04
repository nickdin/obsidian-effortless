/**
 * Composing building the days ahead and meeting notes over one real calendar
 * reading.
 *
 * Issue #909's rule — only a meeting with invited people gets a note and a
 * link — is decided once, in `CalendarSources.meetingsOn`
 * (`src/core/calendarSources.ts`), and both features ask it rather than
 * deciding for themselves (`CLAUDE.md`, the rule about a vault rule the core
 * already holds: `desiredRowsFor`'s `makesNote` and `meetingNotes/run.ts`'s
 * own `meetings` are both `meetingsOn(day, "notes")`). This is the one test
 * that runs both features' own pure decisions over the identical answer for
 * the identical day, and checks they still agree on which meeting is linked
 * and noted, rather than trusting that agreement by construction.
 *
 * No real name, place or calendar.
 */

import { describe, expect, it } from "vitest";
import type { App as ObsidianApp, TFile } from "obsidian";
import { App } from "./__mocks__/obsidian";
import { CalendarSources, newCalendarSource } from "../core/calendarSources";
import type { CalendarGateway, CalendarSource } from "../core/calendarSources";
import { dailyLogFrame, dailyLogPath } from "../core/vaultLayout";
import { DeviceStore, defaultData } from "../core/settings";
import type { VaultLayout } from "../core/settings";
import { desiredRowsFor } from "../features/daysAhead/desiredRows";
import { runWindow } from "../features/daysAhead/run";
import type {
	RunDeps as DaysAheadRunDeps,
	RunNotes as DaysAheadRunNotes,
	RunProblems as DaysAheadRunProblems,
} from "../features/daysAhead/run";
import type { RowMemory } from "../features/daysAhead/rowMemory";
import { ensureNotes } from "../features/meetingNotes/ensureNote";
import type { NoteLookup } from "../features/meetingNotes/ensureNote";
import { meetingNotePath } from "../features/meetingNotes/notePath";
import type { NotesMemory } from "../features/meetingNotes/notesMemory";
import { runMeetingNotes } from "../features/meetingNotes/run";
import type {
	RunDeps as MeetingNotesRunDeps,
	RunNotes as MeetingNotesRunNotes,
	RunProblems as MeetingNotesRunProblems,
	RunVault as MeetingNotesRunVault,
} from "../features/meetingNotes/run";
import { DEFAULT_TEMPLATE } from "../features/meetingNotes/types";

const day = new Date(2026, 8, 8);
const DATE = "2026-09-08";
const FOLDER = "Meetings";
const SELF = "self@invented.test";
const INVITED_UID = "agreement-invited@effortless.test";
const REMINDER_UID = "agreement-reminder@effortless.test";

function layout(): VaultLayout {
	return {
		...defaultData().core.layout,
		dailyLogFolder: "Journal",
		dailyLogFilename: "YYYY-MM-DD",
	};
}

function source(): CalendarSource {
	return { ...newCalendarSource(), location: "https://cal.test/agreement.ics" };
}

/**
 * Two same-day events: one with an attendee, and a whole-day reminder — the
 * shape the ticket names — carrying an organizer and nobody else.
 */
function twoEventsOneInvited(): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Effortless//Test//EN",
		"BEGIN:VEVENT",
		`UID:${INVITED_UID}`,
		"DTSTAMP:20260901T120000Z",
		"DTSTART:20260908T090000Z",
		"DTEND:20260908T100000Z",
		"SUMMARY:Fixture standup",
		"ORGANIZER;CN=Fixture Organiser:mailto:organiser@invented.test",
		"ATTENDEE;CN=Fixture Guest:mailto:guest@invented.test",
		"END:VEVENT",
		"BEGIN:VEVENT",
		`UID:${REMINDER_UID}`,
		"DTSTAMP:20260901T120000Z",
		"DTSTART:20260908T130000Z",
		"DTEND:20260908T133000Z",
		"SUMMARY:Fixture reminder",
		"ORGANIZER;CN=Fixture Organiser:mailto:organiser@invented.test",
		"END:VEVENT",
		"END:VCALENDAR",
		"",
	].join("\r\n");
}

describe("days ahead and meeting notes agree on which meeting is linked and noted", () => {
	it("links only the invited meeting's row, and creates a note only for it", async () => {
		const gateway: CalendarGateway = {
			fetch: async () => twoEventsOneInvited(),
			readFile: async () => {
				throw new Error("not used by this test");
			},
		};
		const app = new App();
		const device = new DeviceStore(app as unknown as ObsidianApp);
		// `source()` is called once and captured: `CalendarSources` keys its
		// stored copy by the source's own id, freshly generated on every
		// `newCalendarSource()` call, so a `sources` closure calling `source()`
		// again on every ask would mint a new id each time and never find the
		// copy `refresh()` stored.
		const src = source();
		const calendar = new CalendarSources(() => [src], device, gateway);
		await calendar.refresh();

		// The one core answer both features ask.
		const onTheDay = calendar.meetingsOn(day, "day");
		const makingNotes = calendar.meetingsOn(day, "notes");
		expect(makingNotes.map((meeting) => meeting.uid)).toEqual([INVITED_UID]);

		// Days ahead's own half: `desiredRowsFor`, unmodified by this ticket.
		const rows = desiredRowsFor(onTheDay, makingNotes, day);
		const linkedRow = rows.find((row) => row.uid === INVITED_UID);
		const plainRow = rows.find((row) => row.uid === REMINDER_UID);
		expect(linkedRow?.makesNote).toBe(true);
		expect(plainRow?.makesNote).toBe(false);
		expect(plainRow?.meetingCell).not.toContain("[[");

		// Meeting notes' own half: `ensureNotes`, over the identical "notes"
		// answer meeting notes' own run reads at `run.ts:186`.
		const lookup: NoteLookup = { exists: () => false, read: () => null };
		const results = ensureNotes(makingNotes, DATE, layout(), FOLDER, lookup, {}, DEFAULT_TEMPLATE, SELF);

		expect(results).toHaveLength(1);
		expect(results[0].outcome).toBe("created");
		expect(results[0].path).toBe(meetingNotePath(FOLDER, DATE, "Fixture standup"));

		// Agreement: the row's link target is exactly the note's own basename
		// — no folder, no `.md` — so the two features never disagree about
		// which file a click on the row would open.
		const basename = results[0].path.slice(FOLDER.length + 1, -".md".length);
		expect(linkedRow?.meetingCell).toBe(`[[${basename}]]`);

		// The reminder — an organizer with nobody else invited — never reached
		// meeting notes at all: it was never in `makingNotes`, so `ensureNotes`
		// was never even asked about it, the same reason its row stays plain
		// text. One meeting, one reason, checked on both sides.
		expect(results.some((result) => result.path.includes("Fixture reminder"))).toBe(false);
	});
});

/**
 * Issue #924, against #909's own criterion "a note already made for an event
 * that no longer qualifies is left alone — nothing deleted or renamed". Unlike
 * the test above, this one never hands either feature a filtered answer: it
 * drives the real `runMeetingNotes` and `runWindow` (not the bare
 * `ensureNotes`/`desiredRowsFor` calls) over one real `CalendarSources`, whose
 * gateway answers a second, attendee-less `.ics` on the second refresh — the
 * same core function, `meetingsOn(day, "notes")`, doing the excluding by
 * itself.
 */
const LAPSE_UID = "lapses-invited@effortless.test";
const LAPSE_DAY = new Date(2026, 8, 10);
const LAPSE_DATE = "2026-09-10";

function lapseEvent(withAttendee: boolean): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Effortless//Test//EN",
		"BEGIN:VEVENT",
		`UID:${LAPSE_UID}`,
		"DTSTAMP:20260901T120000Z",
		"DTSTART:20260910T090000Z",
		"DTEND:20260910T093000Z",
		"SUMMARY:Fixture catch-up",
		"ORGANIZER;CN=Fixture Organiser:mailto:organiser@invented.test",
		...(withAttendee ? ["ATTENDEE;CN=Fixture Guest:mailto:guest@invented.test"] : []),
		"END:VEVENT",
		"END:VCALENDAR",
		"",
	].join("\r\n");
}

function fixtureFile(path: string): TFile {
	return { path } as unknown as TFile;
}

/** A vault and writer over one shared file map, the meeting-notes shape (`meetingNotesRun.test.ts`'s own `fakeVaultAndNotes`). */
function meetingNotesVaultAndNotes(
	files: Map<string, string>,
): { vault: MeetingNotesRunVault; notes: MeetingNotesRunNotes & { createdPaths: string[]; renamedPaths: string[]; editedPaths: string[] } } {
	const createdPaths: string[] = [];
	const renamedPaths: string[] = [];
	const editedPaths: string[] = [];
	const vault: MeetingNotesRunVault = {
		exists: (path) => files.has(path),
		read: async (path) => files.get(path) ?? null,
		fileAt: (path) => (files.has(path) ? fixtureFile(path) : null),
	};
	const notes: MeetingNotesRunNotes & { createdPaths: string[]; renamedPaths: string[]; editedPaths: string[] } = {
		trashIf: async () => { throw new Error("no note is deleted in this test"); },
		createdPaths,
		renamedPaths,
		editedPaths,
		async create(path, text) {
			files.set(path, text);
			createdPaths.push(path);
			return fixtureFile(path);
		},
		async rename(target, newPath) {
			const mutable = target as unknown as { path: string };
			files.set(newPath, files.get(mutable.path) ?? "");
			files.delete(mutable.path);
			renamedPaths.push(newPath);
			mutable.path = newPath;
		},
		async edit(target, edit) {
			const path = (target as unknown as { path: string }).path;
			editedPaths.push(path);
			const next = edit(files.get(path) ?? "");
			files.set(path, next);
			return next;
		},
	};
	return { vault, notes };
}

function meetingNotesProblems(): MeetingNotesRunProblems {
	const standing = new Set<string>();
	return { report: (key) => standing.add(key), clear: (key) => standing.delete(key), list: () => [...standing] };
}

/** A `RunNotes` over one shared log-file map, the days-ahead shape (`daysAheadRunWindowFill.test.ts`'s own `fakeNotes`). */
function daysAheadNotes(files: Map<string, string>): DaysAheadRunNotes & { createdFresh: string[]; editedPaths: string[] } {
	const createdFresh: string[] = [];
	const editedPaths: string[] = [];
	return {
		createdFresh,
		editedPaths,
		async createDailyLog(date, dayLayout) {
			const path = dailyLogPath(date, dayLayout);
			if (!files.has(path)) {
				files.set(path, dailyLogFrame(dayLayout));
				createdFresh.push(path);
			}
			return fixtureFile(path);
		},
		async read(target) {
			const path = (target as unknown as { path: string }).path;
			const content = files.get(path);
			if (content === undefined) throw new Error(`no fake content for ${path}`);
			return content;
		},
		async edit(target, edit) {
			const path = (target as unknown as { path: string }).path;
			editedPaths.push(path);
			const next = edit(files.get(path) ?? "");
			files.set(path, next);
			return next;
		},
	};
}

function daysAheadProblems(): DaysAheadRunProblems {
	const standing = new Set<string>();
	return { report: (key) => standing.add(key), clear: (key) => standing.delete(key), list: () => [...standing] };
}

describe("a meeting that loses its invited people between runs, over the real calendar", () => {
	it("leaves the note exactly as it was once the attendee is gone, and the log's row reads the plain title", async () => {
		let ics = lapseEvent(true);
		const gateway: CalendarGateway = {
			fetch: async () => ics,
			readFile: async () => {
				throw new Error("not used by this test");
			},
		};
		const app = new App();
		const device = new DeviceStore(app as unknown as ObsidianApp);
		const src = source();
		const calendar = new CalendarSources(() => [src], device, gateway);

		const noteFiles = new Map<string, string>();
		const logFiles = new Map<string, string>();
		let notesMemory: NotesMemory = {};
		let rowMemory: RowMemory = {};

		async function runMeetingNotesOnce(): Promise<MeetingNotesRunNotes & { createdPaths: string[]; renamedPaths: string[]; editedPaths: string[] }> {
			const { vault, notes } = meetingNotesVaultAndNotes(noteFiles);
			const deps: MeetingNotesRunDeps = {
				calendar,
				vault,
				notes,
				problems: meetingNotesProblems(),
				layout: layout(),
				folder: FOLDER,
				template: DEFAULT_TEMPLATE,
				selfEmail: SELF,
				today: LAPSE_DAY,
				memory: notesMemory,
				commitMemory: async (next) => {
					notesMemory = next;
				},
			};
			await runMeetingNotes(deps);
			return notes;
		}

		async function runDaysAheadOnce(): Promise<DaysAheadRunNotes & { createdFresh: string[]; editedPaths: string[] }> {
			const notes = daysAheadNotes(logFiles);
			const deps: DaysAheadRunDeps = {
				calendar,
				notes,
				problems: daysAheadProblems(),
				layout: layout(),
				windowDays: 1,
				today: LAPSE_DAY,
				memory: rowMemory,
				commitMemory: async (next) => {
					rowMemory = next;
				},
			};
			await runWindow(deps);
			return notes;
		}

		// First run: the attendee is still there, so #909's own rule counts
		// this meeting — a note is created and the day's table links it.
		const firstNotesRun = await runMeetingNotesOnce();
		const firstDaysRun = await runDaysAheadOnce();

		const notePath = meetingNotePath(FOLDER, LAPSE_DATE, "Fixture catch-up");
		expect(firstNotesRun.createdPaths).toEqual([notePath]);
		const noteAfterFirst = noteFiles.get(notePath);
		expect(noteAfterFirst).toBeDefined();

		const logPath = dailyLogPath(LAPSE_DAY, layout());
		const basename = notePath.slice(FOLDER.length + 1, -".md".length);
		const logAfterFirst = logFiles.get(logPath) ?? "";
		expect(logAfterFirst).toContain(`[[${basename}]]`);
		expect(firstDaysRun.createdFresh).toEqual([logPath]);
		expect(firstDaysRun.editedPaths).toEqual([logPath]);

		// The attendee is removed from the calendar itself — not from either
		// run's own answer. The next `calendar.refresh()` (inside each run
		// below) reads this text and `meetingsOn(day, "notes")` excludes the
		// meeting through `hasInvitedPeople`, the same core function both
		// features ask.
		ics = lapseEvent(false);

		const secondNotesRun = await runMeetingNotesOnce();
		const secondDaysRun = await runDaysAheadOnce();

		// Meeting notes: the loop in `runOverToday` only ever visits
		// `meetings` (`run.ts:228`'s own `deps.calendar.meetingsOn(...)`), and
		// this meeting is no longer in it — so nothing in this run's own plan
		// ever names its path.
		expect(secondNotesRun.createdPaths).toEqual([]);
		expect(secondNotesRun.renamedPaths).toEqual([]);
		expect(secondNotesRun.editedPaths).toEqual([]);
		expect(noteFiles.get(notePath)).toBe(noteAfterFirst);

		// Days ahead: the link is the one the plugin wrote on the first run,
		// so `mergeMeetings.ts`'s `keepMeetingCell` does not keep it as the
		// person's once `want.makesNote` is false — the row is corrected to
		// the plain title, and nothing else in the log changes.
		expect(secondDaysRun.editedPaths).toEqual([logPath]);
		expect(logFiles.get(logPath)).toBe(logAfterFirst.replace(`[[${basename}]]`, "Fixture catch-up"));
	});
});
