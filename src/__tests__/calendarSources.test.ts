import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The stub is imported by path rather than as "obsidian": `tsc` checks this
// file against the real API, and only vitest redirects that name.
import type { App as ObsidianApp, Vault as ObsidianVault } from "obsidian";
import { App, requestUrlReplies, requestedUrls, resetRequests } from "./__mocks__/obsidian";
import { fixture } from "./fixtures";
import { shippedSources, withoutComments } from "./sourceGuards";
import {
	CalendarSources,
	REFRESH_EVERY_MS,
	newCalendarSource,
	earnedAt,
	newCalendarSourceId,
	obsidianGateway,
	sourceProblem,
} from "../core/calendarSources";
import type { CalendarGateway, CalendarRead, CalendarSource } from "../core/calendarSources";
import type { Meeting } from "../core/icsReader";
import { meetingTitle } from "../core/meetingName";
import { sourceStateLine } from "../core/calendarSourcesSection";
import { DeviceStore } from "../core/settings";

const day = new Date(2026, 8, 8);

/**
 * The copies a draw must refuse, by their bytes.
 *
 * `meetingsOn` only ever reads a copy that `readOne` already proved parseable,
 * so bad bytes handed to the gateway cannot reach it — the proof rejects them
 * first. The reader is therefore told to fail for one named copy and left to
 * run for real for every other one, which is the only way to drive the draw's
 * own failure path. Cleared before each test.
 */
const { refuse, lose, contractBreakers } = vi.hoisted(() => ({
	refuse: new Set<string>(),
	lose: new Set<string>(),
	contractBreakers: new Set<string>(),
}));

/**
 * `ical-expander` itself, with a way to make it break its own contract for one
 * named calendar.
 *
 * The field `icsOccurrences` reads off a built expander is undocumented, and the
 * dependency is pinned `^3.2.0`, so a 3.x release renaming it is accepted by
 * `npm install` and every calendar in the vault meets the break at once. That is
 * a failure of the library, not of any calendar, and driving it needs the real
 * library replaced for those bytes and left alone for every other test in this
 * file. Cleared before each test.
 */
vi.mock("ical-expander", async (importOriginal) => {
	const actual = await importOriginal<{ default: new (options: { ics: string }) => object }>();
	const Real = actual.default;
	return {
		default: function Expander(options: { ics: string }): object {
			const built = new Real(options);
			if (contractBreakers.has(options.ics)) {
				(built as { events?: unknown }).events = "no longer a list";
			}
			return built;
		},
	};
});

vi.mock("../core/icsReader", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/icsReader")>();
	return {
		...actual,
		readDayFromAll(calendars: readonly string[], on: Date) {
			const meetings: Meeting[] = [];
			const failures: { index: number; reason: string; loss?: "partial" | "total" }[] = [];
			calendars.forEach((ics, index) => {
				if (refuse.has(ics)) {
					failures.push({ index, reason: "This calendar could not be read." });
					return;
				}
				// The third state: bytes that give up some meetings *and* report a
				// loss. Every copy in this file was one of the other two until
				// issue #134, so the state issue #53 added was never constructed
				// here and a draw's loss was never driven through the store.
				meetings.push(...actual.readDay(ics, on));
				if (lose.has(ics)) {
					failures.push({ index, reason: "Some entries could not be read.", loss: "partial" });
				}
			});
			return { meetings, failures };
		},
	};
});

beforeEach(() => {
	resetRequests();
	refuse.clear();
	lose.clear();
	contractBreakers.clear();
});

/**
 * `broken-event.ics` with its two readable events taken out, so no meeting
 * survives the read.
 *
 * **It grades a *total* loss, and did not until issue #222.** Two entries are
 * left: one whose repeat rule throws, and one with no `DTSTART` at all. Only
 * the throw used to be counted, so a calendar that produced no meeting at all
 * still graded *partial*. Both are counted now, because `build` sets
 * `skipInvalidDates: false` and runs the readability test itself before
 * expanding. `nothingReadable` below is a second way to reach a total loss,
 * not the only one.
 */
function noMeetingSurvives(): string {
	return fixture("broken-event.ics").replace(/BEGIN:VEVENT\r\nUID:kept-[\s\S]*?END:VEVENT\r\n/g, "");
}

/** A calendar of `count` entries where every one of them throws on being read. */
function nothingReadable(count: number): string {
	const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Effortless//Test//EN"];
	for (let n = 0; n < count; n += 1) {
		lines.push(
			"BEGIN:VEVENT",
			`UID:bad-${n}@effortless.test`,
			"DTSTAMP:20260901T120000Z",
			"DTSTART:20260908T090000Z",
			"DTEND:20260908T093000Z",
			"RRULE:FREQ=NONSENSE;COUNT=3",
			`SUMMARY:Unreadable ${n}`,
			"END:VEVENT",
		);
	}
	lines.push("END:VCALENDAR", "");
	return lines.join("\r\n");
}

/** A source with everything filled in, so a test only names what it cares about. */
function source(over: Partial<CalendarSource> = {}): CalendarSource {
	return { ...newCalendarSource(), name: "Work", kind: "link", location: "https://cal.test/w.ics", ...over };
}

/** A gateway that answers from two maps, and counts what it was asked for. */
function gateway(links: Record<string, string> = {}, files: Record<string, string> = {}) {
	const asked: string[] = [];
	const failures = new Map<string, string>();
	return {
		asked,
		/** Makes the next and every later read of `where` fail with `reason`. */
		breaks(where: string, reason: string): void {
			failures.set(where, reason);
		},
		mends(where: string): void {
			failures.delete(where);
		},
		gateway: {
			async fetch(url: string): Promise<string> {
				asked.push(`fetch ${url}`);
				const broken = failures.get(url);
				if (broken !== undefined) throw new Error(broken);
				const ics = links[url];
				if (ics === undefined) throw new Error(`Nothing is published at ${url}.`);
				return ics;
			},
			async readFile(path: string): Promise<string> {
				asked.push(`read ${path}`);
				const broken = failures.get(path);
				if (broken !== undefined) throw new Error(broken);
				const ics = files[path];
				if (ics === undefined) throw new Error(`There is no file at ${path}.`);
				return ics;
			},
		} satisfies CalendarGateway,
	};
}

/** A calendar wired to a fresh device store, with the sources it is given. */
function calendarOf(
	sources: CalendarSource[],
	deps: CalendarGateway,
	now: () => number = Date.now,
): { calendar: CalendarSources; device: DeviceStore; app: App } {
	const app = new App();
	const device = new DeviceStore(app as unknown as ObsidianApp);
	const calendar = new CalendarSources(() => sources, device, deps, now);
	return { calendar, device, app };
}

describe("what makes a source usable", () => {
	it("takes an https link", () => {
		expect(sourceProblem(source({ location: "https://calendar.google.com/x/basic.ics" }))).toBeNull();
	});

	it("refuses a link that is not https, because the address is the password", () => {
		expect(sourceProblem(source({ location: "http://cal.test/w.ics" }))).toBe(
			"A calendar link has to start with https://, so the address is not sent in the clear.",
		);
	});

	it("takes a path to an .ics file in the vault, whatever case it is written in", () => {
		expect(sourceProblem(source({ kind: "file", location: "Calendars/Work.ICS" }))).toBeNull();
	});

	it("refuses a vault path that is not an .ics file", () => {
		expect(sourceProblem(source({ kind: "file", location: "Calendars/work.json" }))).toBe(
			"A calendar file has to be an .ics file inside the vault.",
		);
	});

	it("refuses a path that climbs out of the vault", () => {
		const out = "The path has to stay inside the vault, so it cannot step up out of it.";
		expect(sourceProblem(source({ kind: "file", location: "../secrets/work.ics" }))).toBe(out);
		expect(sourceProblem(source({ kind: "file", location: "Calendars/../../work.ics" }))).toBe(out);
	});

	it("refuses a path that names a disk rather than the vault", () => {
		expect(sourceProblem(source({ kind: "file", location: "C:/Users/x/work.ics" }))).toBe(
			"The path has to stay inside the vault, so it cannot name a drive or another program.",
		);
		expect(sourceProblem(source({ kind: "file", location: "file:///etc/work.ics" }))).toBe(
			"The path has to stay inside the vault, so it cannot name a drive or another program.",
		);
	});

	it("refuses a published link pasted into the file route, collapsed or not", () => {
		// The file route stores its box through `normalizePath`,
		// which collapses `https://` to `https:/`. A guard that only knew `://`
		// let the collapsed form through, and the row then quoted an address
		// nobody had typed. The scheme test knows one slash and two.
		const drive =
			"The path has to stay inside the vault, so it cannot name a drive or another program.";
		expect(sourceProblem(source({ kind: "file", location: "https://cal.example/basic.ics" }))).toBe(
			drive,
		);
		expect(sourceProblem(source({ kind: "file", location: "https:/cal.example/basic.ics" }))).toBe(
			drive,
		);
		expect(sourceProblem(source({ kind: "file", location: "webcal:/cal.example/basic.ics" }))).toBe(
			drive,
		);
	});

	it("goes on taking an ordinary vault path, which the widened scheme test must not catch", () => {
		for (const path of ["Calendars/work.ics", "work.ics", "a/b/c/work.ics"]) {
			expect(sourceProblem(source({ kind: "file", location: path }))).toBeNull();
		}
	});

	it("says a source is unfinished rather than broken while it is still empty", () => {
		expect(sourceProblem(source({ location: "  " }))).toBe(
			"This calendar has no link or file yet.",
		);
	});

	it("takes an https link that does not end .ics, which is deliberate and not an oversight", () => {
		// The vault-file route below requires .ics and this one does not, on
		// purpose: a published address does not reliably end that way, and
		// refusing a working address is worse than accepting a wrong one. A
		// wrong one is caught when it is fetched.
		expect(sourceProblem(source({ location: "https://outlook.office365.com/owa/calendar/x" }))).toBeNull();
	});

	it("takes an .ics link with a query string after it", () => {
		expect(
			sourceProblem(source({ location: "https://cal.test/w.ics?token=abc" })),
		).toBeNull();
	});

	it("ships a new source with both switches on", () => {
		const fresh = newCalendarSource();
		expect(fresh.showInDay).toBe(true);
		expect(fresh.makeNotes).toBe(true);
	});

	it("gives each new source its own id, so two rows never share their state", () => {
		const ids = new Set([0, 1, 2, 3, 4].map(() => newCalendarSource().id));
		expect(ids.size).toBe(5);
	});
});

describe("the two routes", () => {
	it("produce the same shape from the same calendar", async () => {
		const ics = fixture("one-day.ics");
		const linked = source({ kind: "link", location: "https://cal.test/w.ics" });
		const filed = source({ kind: "file", location: "Calendars/work.ics" });
		const deps = gateway({ "https://cal.test/w.ics": ics }, { "Calendars/work.ics": ics });

		const byLink = calendarOf([linked], deps.gateway);
		const byFile = calendarOf([filed], deps.gateway);
		await byLink.calendar.refresh();
		await byFile.calendar.refresh();

		const fromLink = byLink.calendar.meetingsOn(day, "day");
		const fromFile = byFile.calendar.meetingsOn(day, "day");
		expect(fromLink.length).toBe(2);
		expect(fromFile).toEqual(fromLink);
	});

	it("fetches a link through Obsidian's own helper rather than the page's", async () => {
		const vault = {
			getFileByPath: () => null,
			cachedRead: async () => "",
		} as unknown as ObsidianVault;
		requestUrlReplies.set("https://cal.test/w.ics", { status: 200, text: "BEGIN:VCALENDAR" });

		const text = await obsidianGateway(vault).fetch("https://cal.test/w.ics");

		expect(text).toBe("BEGIN:VCALENDAR");
		expect(requestedUrls).toEqual(["https://cal.test/w.ics"]);
	});

	it("says what a link answered when it answered an error", async () => {
		const vault = { getFileByPath: () => null, cachedRead: async () => "" } as unknown as ObsidianVault;
		requestUrlReplies.set("https://cal.test/gone.ics", { status: 404, text: "no" });

		await expect(obsidianGateway(vault).fetch("https://cal.test/gone.ics")).rejects.toThrow(
			"The calendar link answered 404.",
		);
	});

	it("reads a vault file through the vault, and says so when there is none", async () => {
		const read: string[] = [];
		const vault = {
			getFileByPath: (path: string) => (path === "Calendars/work.ics" ? { path } : null),
			cachedRead: async (file: { path: string }) => {
				read.push(file.path);
				return "BEGIN:VCALENDAR";
			},
		} as unknown as ObsidianVault;

		expect(await obsidianGateway(vault).readFile("Calendars//work.ics")).toBe("BEGIN:VCALENDAR");
		expect(read).toEqual(["Calendars/work.ics"]);
		await expect(obsidianGateway(vault).readFile("Calendars/gone.ics")).rejects.toThrow(
			"There is no file at Calendars/gone.ics in this vault.",
		);
	});
});

describe("the address the check judges and the address the read uses", () => {
	/*
	 * They were two different strings: the check trimmed and the read did not,
	 * so a stored address carrying whitespace passed the check and then failed
	 * the read, and the row named a path that looked exactly right.
	 * The loader now cleans a stored address, and these assert the other half —
	 * that whatever a source carries, one string is judged and used.
	 */
	it("hands the link route the same address the check judged", async () => {
		const untidy = source({ kind: "link", location: " https://cal.test/w.ics " });
		const deps = gateway({ "https://cal.test/w.ics": fixture("one-day.ics") });
		const { calendar } = calendarOf([untidy], deps.gateway);

		expect(sourceProblem(untidy)).toBeNull();
		await calendar.refresh();

		expect(deps.asked).toEqual(["fetch https://cal.test/w.ics"]);
	});

	it("hands the vault-file route the same address the check judged", async () => {
		const untidy = source({ kind: "file", location: "\tCalendars/work.ics\n" });
		const deps = gateway({}, { "Calendars/work.ics": fixture("one-day.ics") });
		const { calendar, device } = calendarOf([untidy], deps.gateway);

		expect(sourceProblem(untidy)).toBeNull();
		await calendar.refresh();

		expect(deps.asked).toEqual(["read Calendars/work.ics"]);
		expect(device.read().calendarReads[untidy.id].failure).toBeNull();
	});
});

describe("whether a stored read belongs to the source as it stands now", () => {
	/*
	 * **Issue #238.** This rule used to be written out twice, identically — once
	 * in `readOne` and once in `sourceStateLine` — and the two copies had already
	 * begun to disagree about what an unearned read should suppress.
	 * One predicate now answers it for both, so the day anyone revisits what an
	 * address is, or what an absent one means, there is one place to change.
	 */
	const read = (over: Partial<CalendarRead> = {}): CalendarRead => ({
		readAt: 1_000,
		failure: null,
		...over,
	});

	it("takes a read earned at the address the source names now", () => {
		const work = source({ kind: "link", location: "https://cal.test/w.ics" });

		expect(earnedAt(read({ readFrom: "link:https://cal.test/w.ics" }), work)).toBe(true);
	});

	it("refuses a read earned at an address the source no longer names", () => {
		const work = source({ kind: "link", location: "https://cal.test/w.ics" });

		expect(earnedAt(read({ readFrom: "link:https://cal.test/old.ics" }), work)).toBe(false);
	});

	it("counts a read with no address at all as this calendar's", () => {
		// Written before issue #105 recorded one. There is no evidence it was
		// earned somewhere else, so it is taken to belong wherever the source
		// points now — and that is not the same case as a read naming another
		// address, which says nothing about this calendar at all.
		const work = source({ kind: "link", location: "https://cal.test/w.ics" });

		expect(earnedAt(read(), work)).toBe(true);
	});

	it("counts no read at all as nothing to disown", () => {
		expect(earnedAt(undefined, source())).toBe(true);
	});

	it("refuses a read earned before the route was switched", () => {
		// The route is part of the address because switching it empties the box,
		// and an empty address under one route is not the empty one under the other.
		const asFile = source({ kind: "file", location: "" });

		expect(earnedAt(read({ readFrom: "link:" }), asFile)).toBe(false);
	});

	it("takes a file read earned before the loader began tidying paths", () => {
		// A stored address is written by whichever version earned it, and what
		// counts as tidy has changed since: issue #248 began putting a file
		// source's stored location through the vault-path rule as the settings
		// load. Tidying only the source's side made a read state written before
		// that stop matching, and the row lost its age. Both sides
		// are tidied, so a path that differs only by that survives the upgrade.
		const work = source({ kind: "file", location: "Calendars/work.ics" });

		expect(earnedAt(read({ readFrom: "file:/Calendars/work.ics" }), work)).toBe(true);
		expect(earnedAt(read({ readFrom: "file:Calendars//work.ics" }), work)).toBe(true);
	});

	it("still refuses a file read earned at a genuinely different path", () => {
		// Tidying both sides is not matching loosely. Issue #105's rule stands.
		const work = source({ kind: "file", location: "Calendars/work.ics" });

		expect(earnedAt(read({ readFrom: "file:Calendars/old.ics" }), work)).toBe(false);
	});

	it("only trims a link's stored address, on both sides", () => {
		// `normalizePath` collapses the double slash in `https://`, so the
		// vault-path rule may not touch a link. A stored address that has
		// already lost the slash is a different address and stays one.
		const work = source({ kind: "link", location: "https://cal.test/w.ics" });

		expect(earnedAt(read({ readFrom: "link:  https://cal.test/w.ics  " }), work)).toBe(true);
		expect(earnedAt(read({ readFrom: "link:https:/cal.test/w.ics" }), work)).toBe(false);
	});

	it("reads a stored address with no route in it as it stands", () => {
		// Nothing writes one — `addressOf` always puts the route first — but a
		// hand-edited `data.json` can hold anything, and the answer has to be a
		// mismatch rather than a crash or an accidental match.
		const work = source({ kind: "file", location: "Calendars/work.ics" });

		expect(earnedAt(read({ readFrom: "Calendars/work.ics" }), work)).toBe(false);
	});

	it("never earns a route this plugin does not write, however closely the rest of the address matches", () => {
		// `tidiedAddress` (private to calendarSources.ts, :364) hands a stored
		// address with an unrecognised prefix back untouched rather than
		// running it through the file or link tidying rule — there is nothing
		// to read an unknown route back as. That branch is unreachable from
		// today's settings reader: `readCalendarSources` (settings.ts:649)
		// folds anything that is not literally "file" into "link", so a stored
		// source can never carry a third kind. It stays worth pinning because
		// nothing else proves the branch does not silently fold an unknown
		// prefix into whichever real route its remainder happens to resemble.
		const asLink = source({ kind: "link", location: "https://cal.test/w.ics" });
		const asFile = source({ kind: "file", location: "https://cal.test/w.ics" });

		expect(earnedAt(read({ readFrom: "webcal:https://cal.test/w.ics" }), asLink)).toBe(false);
		expect(earnedAt(read({ readFrom: "webcal:https://cal.test/w.ics" }), asFile)).toBe(false);
	});
});

describe("the two switches", () => {
	const work = source({ name: "Work", location: "https://cal.test/w.ics", makeNotes: false });
	const birthdays = source({
		name: "Birthdays",
		location: "https://cal.test/b.ics",
		showInDay: true,
		makeNotes: false,
	});

	it("keeps a birthdays calendar out of the meeting notes and in the day", async () => {
		const deps = gateway({
			"https://cal.test/w.ics": fixture("one-day.ics"),
			"https://cal.test/b.ics": fixture("all-day.ics"),
		});
		const { calendar } = calendarOf([work, birthdays], deps.gateway);
		await calendar.refresh();

		expect(calendar.meetingsOn(day, "day").length).toBeGreaterThan(
			calendar.meetingsOn(day, "notes").length,
		);
		expect(calendar.meetingsOn(day, "notes")).toEqual([]);
	});

	it("leaves out a source switched off for the use being asked about", async () => {
		const shown = source({ location: "https://cal.test/w.ics", showInDay: false, makeNotes: true });
		// Both events carry an attendee, so the switch is what this test is
		// about rather than issue #909's invited-people rule — `one-day.ics`'s
		// two events have none and would leave "notes" empty either way.
		const deps = gateway({ "https://cal.test/w.ics": twoInvitedMeetings() });
		const { calendar } = calendarOf([shown], deps.gateway);
		await calendar.refresh();

		expect(calendar.meetingsOn(day, "day")).toEqual([]);
		expect(calendar.meetingsOn(day, "notes").length).toBe(2);
	});
});

/** Two same-day meetings, each with one invented attendee. */
function twoInvitedMeetings(): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Effortless//Test//EN",
		"BEGIN:VEVENT",
		"UID:invited-one@effortless.test",
		"DTSTAMP:20260901T120000Z",
		"DTSTART:20260908T090000Z",
		"DTEND:20260908T100000Z",
		"SUMMARY:Morning review",
		"ORGANIZER;CN=Fixture Organiser:mailto:organiser@invented.test",
		"ATTENDEE;CN=Fixture Guest:mailto:guest@invented.test",
		"END:VEVENT",
		"BEGIN:VEVENT",
		"UID:invited-two@effortless.test",
		"DTSTAMP:20260901T120000Z",
		"DTSTART:20260908T130000Z",
		"DTEND:20260908T133000Z",
		"SUMMARY:Afternoon call",
		"ATTENDEE;CN=Second Guest:mailto:second@invented.test",
		"END:VEVENT",
		"END:VCALENDAR",
		"",
	].join("\r\n");
}

describe("a moved occurrence with no title of its own", () => {
	/**
	 * A weekly series with a title, and the override that moves its 8
	 * September occurrence to 10 September carrying only `UID`,
	 * `RECURRENCE-ID`, `DTSTART` and `DTEND` — Outlook's own shape for a move,
	 * and the shape this vault receives.
	 */
	function seriesWithAMovedOccurrence(): string {
		const lines = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Effortless//Test//EN",
			"BEGIN:VEVENT",
			"UID:weekly-detailed@effortless.test",
			"DTSTAMP:20260901T120000Z",
			"DTSTART:20260901T090000Z",
			"DTEND:20260901T093000Z",
			"RRULE:FREQ=WEEKLY;COUNT=4",
			"SUMMARY:Fixture planning",
			"END:VEVENT",
			"BEGIN:VEVENT",
			"UID:weekly-detailed@effortless.test",
			"DTSTAMP:20260901T120000Z",
			"RECURRENCE-ID:20260908T090000Z",
			"DTSTART:20260910T100000Z",
			"DTEND:20260910T103000Z",
			"END:VEVENT",
			"END:VCALENDAR",
			"",
		];
		return lines.join("\r\n");
	}

	it("names the moved occurrence with the series' title in the day's table row, not the untitled placeholder", async () => {
		const movedTo = new Date(2026, 8, 10);
		const deps = gateway({ "https://cal.test/w.ics": seriesWithAMovedOccurrence() });
		const { calendar } = calendarOf([source()], deps.gateway);
		await calendar.refresh();

		const meetings = calendar.meetingsOn(movedTo, "day");

		expect(meetings).toHaveLength(1);
		// `meetingTitle` is what the day's table row actually shows for a
		// meeting's summary (`src/core/meetingName.ts`), so this is read
		// through it rather than compared to `summary` directly — before the
		// fix, `summary` was `""` and this line would have read `UNTITLED_MEETING_TITLE`.
		expect(meetingTitle(meetings[0].summary)).toBe("Fixture planning");
	});
});

describe("only a meeting with invited people gets a note and a link", () => {
	/**
	 * Four events on the same day, reused from `icsReader.test.ts`'s own
	 * "who was invited" suite: an attendee with no name, an attendee with no
	 * named organizer, an organizer with no attendee, and an organizer named
	 * as an odd non-`mailto:` address with no attendee either.
	 */
	it("keeps every one of them in the day's table, whoever is invited", async () => {
		const deps = gateway({ "https://cal.test/w.ics": fixture("invited-edge-cases.ics") });
		const { calendar } = calendarOf([source()], deps.gateway);
		await calendar.refresh();

		expect(calendar.meetingsOn(day, "day").map((meeting) => meeting.summary)).toEqual([
			"No name given",
			"No organiser named",
			"Nobody invited",
			"Organiser given as an odd address",
		]);
	});

	it("answers \"notes\" with only the two that have at least one attendee — the organizer alone does not count", async () => {
		const deps = gateway({ "https://cal.test/w.ics": fixture("invited-edge-cases.ics") });
		const { calendar } = calendarOf([source()], deps.gateway);
		await calendar.refresh();

		// Before this fix, #701 had already dropped the old plugin's attendee
		// check when it moved the calendar half onto `makeNotes`, so all four
		// would have answered here — this could have failed.
		expect(calendar.meetingsOn(day, "notes").map((meeting) => meeting.summary)).toEqual([
			"No name given",
			"No organiser named",
		]);
	});

	it("keeps a moved occurrence in the notes answer when it inherits its series' attendees, and still drops a plain reminder on the same day", async () => {
		const movedTo = new Date(2026, 8, 10);
		const deps = gateway({ "https://cal.test/w.ics": seriesWithAnInvitedMovedOccurrence() });
		const { calendar } = calendarOf([source()], deps.gateway);
		await calendar.refresh();

		// The moved-to day carries two events: the series' occurrence, whose
		// own override has no ATTENDEE line and must inherit the series'
		// attendees to qualify here, and a standalone reminder with none
		// at all. Before this fix both would have answered — the reminder
		// because "notes" did not filter by attendee at all, the occurrence
		// because #908 was already landed — so this could have failed.
		const meetings = calendar.meetingsOn(movedTo, "notes");
		expect(meetings).toHaveLength(1);
		expect(meetings[0].summary).toBe("Fixture planning, invited");
	});
});

/**
 * A weekly series with a title and two attendees, and an override that moves
 * its 8 September occurrence to 10 September carrying only `UID`,
 * `RECURRENCE-ID`, `DTSTART` and `DTEND` — the same Outlook shape
 * `seriesWithAMovedOccurrence` above uses for issue #908, with attendees
 * added so this file's own #909 suite can compose the two tickets. A third,
 * unrelated event with no attendees lands on the same moved-to day, so the
 * two rules — inheriting attendees, and requiring at least one — are both
 * exercised at once rather than by a day with nothing else on it.
 */
function seriesWithAnInvitedMovedOccurrence(): string {
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Effortless//Test//EN",
		"BEGIN:VEVENT",
		"UID:weekly-invited@effortless.test",
		"DTSTAMP:20260901T120000Z",
		"DTSTART:20260901T090000Z",
		"DTEND:20260901T093000Z",
		"RRULE:FREQ=WEEKLY;COUNT=4",
		"SUMMARY:Fixture planning, invited",
		"ORGANIZER;CN=Fixture Organiser:mailto:organiser@invented.test",
		"ATTENDEE;CN=Fixture Guest:mailto:guest@invented.test",
		"END:VEVENT",
		"BEGIN:VEVENT",
		"UID:weekly-invited@effortless.test",
		"DTSTAMP:20260901T120000Z",
		"RECURRENCE-ID:20260908T090000Z",
		"DTSTART:20260910T100000Z",
		"DTEND:20260910T103000Z",
		"END:VEVENT",
		"BEGIN:VEVENT",
		"UID:fixture-reminder@effortless.test",
		"DTSTAMP:20260901T120000Z",
		"DTSTART:20260910T130000Z",
		"DTEND:20260910T133000Z",
		"SUMMARY:Fixture reminder",
		"ORGANIZER;CN=Fixture Organiser:mailto:organiser@invented.test",
		"END:VEVENT",
		"END:VCALENDAR",
		"",
	];
	return lines.join("\r\n");
}

describe("a read that fails", () => {
	it("keeps the last good copy rather than emptying the day", async () => {
		const one = source({ location: "https://cal.test/w.ics" });
		const deps = gateway({ "https://cal.test/w.ics": fixture("one-day.ics") });
		const { calendar, device } = calendarOf([one], deps.gateway);
		await calendar.refresh();

		deps.breaks("https://cal.test/w.ics", "The network is down.");
		await calendar.refresh();

		expect(calendar.meetingsOn(day, "day").length).toBe(2);
		expect(device.read().calendarReads[one.id].failure).toBe("The network is down.");
	});

	it("keeps the time of the last good read, not the time of the failure", async () => {
		const one = source({ location: "https://cal.test/w.ics" });
		const deps = gateway({ "https://cal.test/w.ics": fixture("one-day.ics") });
		let clock = 1_000;
		const { calendar, device } = calendarOf([one], deps.gateway, () => clock);
		await calendar.refresh();

		clock = 9_000;
		deps.breaks("https://cal.test/w.ics", "The network is down.");
		await calendar.refresh();

		expect(device.read().calendarReads[one.id].readAt).toBe(1_000);
	});

	it("clears the failure once the source reads again", async () => {
		const one = source({ location: "https://cal.test/w.ics" });
		const deps = gateway({ "https://cal.test/w.ics": fixture("one-day.ics") });
		const { calendar, device } = calendarOf([one], deps.gateway);
		await calendar.refresh();
		deps.breaks("https://cal.test/w.ics", "The network is down.");
		await calendar.refresh();

		deps.mends("https://cal.test/w.ics");
		await calendar.refresh();

		expect(device.read().calendarReads[one.id].failure).toBeNull();
	});

	it("does not let one broken source empty another", async () => {
		const good = source({ location: "https://cal.test/w.ics" });
		const bad = source({ location: "https://cal.test/b.ics" });
		const deps = gateway({ "https://cal.test/w.ics": fixture("one-day.ics") });
		const { calendar, device } = calendarOf([good, bad], deps.gateway);

		await calendar.refresh();

		expect(calendar.meetingsOn(day, "day").length).toBe(2);
		expect(device.read().calendarReads[good.id].failure).toBeNull();
		expect(device.read().calendarReads[bad.id].failure).toBe(
			"Nothing is published at https://cal.test/b.ics.",
		);
	});

	it("refuses bytes that are not a calendar rather than storing them as one", async () => {
		const one = source({ location: "https://cal.test/w.ics" });
		const links: Record<string, string> = { "https://cal.test/w.ics": fixture("one-day.ics") };
		const deps = gateway(links);
		const { calendar, device } = calendarOf([one], deps.gateway);
		await calendar.refresh();

		// What an expired secret link actually answers: a sign-in page, with a
		// perfectly good status code on it.
		links["https://cal.test/w.ics"] = "<html>Sign in</html>";
		await calendar.refresh();

		expect(calendar.meetingsOn(day, "day").length).toBe(2);
		expect(device.read().calendarReads[one.id].failure).not.toBeNull();
	});

	it("says the address is the wrong kind when a link answers something that is not a calendar", async () => {
		const one = source({ location: "https://cal.test/w.ics" });
		// What pasting the calendar's sharing page instead of its published
		// address gets you: a perfectly good page that is not a calendar.
		const deps = gateway({ "https://cal.test/w.ics": "<html>My calendar</html>" });
		const { calendar, device } = calendarOf([one], deps.gateway);

		await calendar.refresh();

		expect(device.read().calendarReads[one.id].failure).toBe(
			"That address does not look like a calendar address. These bytes are not a calendar: " +
				"there is no BEGIN:VCALENDAR line.",
		);
	});

	// **Issue #157.** `readFailure` used to key on the error *type*, and one type
	// covers three different situations. The third — a real calendar that stops
	// partway through — was told its address was wrong, which sends someone to
	// change an address that is right. All three throws are driven here over both
	// source kinds, so the rule cannot drift back to the type.
	describe("which failures blame the address", () => {
		const noCalendarLine = "<html>My calendar</html>";
		const truncated = () => fixture("truncated.ics");

		it("blames the address when a link answers bytes with no BEGIN:VCALENDAR line", async () => {
			const one = source({ location: "https://cal.test/w.ics" });
			const deps = gateway({ "https://cal.test/w.ics": noCalendarLine });
			const { calendar, device } = calendarOf([one], deps.gateway);

			await calendar.refresh();

			expect(device.read().calendarReads[one.id].failure).toBe(
				"That address does not look like a calendar address. These bytes are not a calendar: " +
					"there is no BEGIN:VCALENDAR line.",
			);
		});

		it("blames the address when a link answers no bytes at all", async () => {
			// A published calendar address always answers with a BEGIN:VCALENDAR
			// line, so nothing at all points at the wrong address — usually the
			// sharing page rather than the published one.
			const one = source({ location: "https://cal.test/w.ics" });
			const deps = gateway({ "https://cal.test/w.ics": "" });
			const { calendar, device } = calendarOf([one], deps.gateway);

			await calendar.refresh();

			expect(device.read().calendarReads[one.id].failure).toBe(
				"That address does not look like a calendar address. The calendar is empty.",
			);
		});

		it("does not blame the address when a link serves a calendar that stops partway", async () => {
			const one = source({ location: "https://cal.test/w.ics" });
			const deps = gateway({ "https://cal.test/w.ics": truncated() });
			const { calendar, device } = calendarOf([one], deps.gateway);

			await calendar.refresh();

			const failure = device.read().calendarReads[one.id].failure;
			expect(failure).not.toMatch(/address/);
			expect(failure).toMatch(/^This calendar could not be read: /);
		});

		it.each([
			["bytes with no BEGIN:VCALENDAR line", () => noCalendarLine],
			["no bytes at all", () => ""],
			["a calendar that stops partway", truncated],
		])("never blames the address for a vault file holding %s", async (_what, bytes) => {
			const one = source({ kind: "file", location: "Calendars/work.ics" });
			const deps = gateway({}, { "Calendars/work.ics": bytes() });
			const { calendar, device } = calendarOf([one], deps.gateway);

			await calendar.refresh();

			expect(device.read().calendarReads[one.id].failure).not.toMatch(/address/);
		});
	});

	it("leaves a link's network or status failure saying exactly what it said", async () => {
		const one = source({ location: "https://cal.test/w.ics" });
		const deps = gateway({ "https://cal.test/w.ics": fixture("one-day.ics") });
		deps.breaks("https://cal.test/w.ics", "The calendar link answered 404.");
		const { calendar, device } = calendarOf([one], deps.gateway);

		await calendar.refresh();

		expect(device.read().calendarReads[one.id].failure).toBe("The calendar link answered 404.");
	});

	it("leaves a vault file's own failure alone, because its address was never in doubt", async () => {
		const one = source({ kind: "file", location: "Calendars/work.ics" });
		const deps = gateway({}, { "Calendars/work.ics": "<html>Not a calendar</html>" });
		const { calendar, device } = calendarOf([one], deps.gateway);

		await calendar.refresh();

		expect(device.read().calendarReads[one.id].failure).toBe(
			"These bytes are not a calendar: there is no BEGIN:VCALENDAR line.",
		);
	});

	it("never reads a source whose link or path is wrong in the first place", async () => {
		const wrong = source({ location: "http://cal.test/w.ics" });
		const deps = gateway({ "http://cal.test/w.ics": fixture("one-day.ics") });
		const { calendar, device } = calendarOf([wrong], deps.gateway);

		await calendar.refresh();

		expect(deps.asked).toEqual([]);
		expect(device.read().calendarReads[wrong.id].failure).toBe(
			"A calendar link has to start with https://, so the address is not sent in the clear.",
		);
	});

	it("forgets a source that has been removed", async () => {
		const one = source({ location: "https://cal.test/w.ics" });
		const sources = [one];
		const deps = gateway({ "https://cal.test/w.ics": fixture("one-day.ics") });
		const app = new App();
		const device = new DeviceStore(app as unknown as ObsidianApp);
		const calendar = new CalendarSources(() => sources, device, deps.gateway);
		await calendar.refresh();

		sources.splice(0, 1);
		await calendar.refresh();

		expect(device.read().calendarReads).toEqual({});
		expect(calendar.meetingsOn(day, "day")).toEqual([]);
	});
});

describe("a copy that will not read while a day is drawn", () => {
	const good = source({ name: "Work", location: "https://cal.test/w.ics" });
	const bad = source({ name: "Birthdays", location: "https://cal.test/b.ics" });

	function twoSources() {
		return gateway({
			"https://cal.test/w.ics": fixture("one-day.ics"),
			"https://cal.test/b.ics": fixture("all-day.ics"),
		});
	}

	it("says which source would not read rather than drawing a short day in silence", async () => {
		const deps = twoSources();
		const { calendar, device } = calendarOf([good, bad], deps.gateway);
		await calendar.refresh();

		refuse.add(fixture("all-day.ics"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const meetings = calendar.meetingsOn(day, "day");

		expect(meetings.length).toBe(2);
		expect(device.read().calendarReads[bad.id].failure).toBe("This calendar could not be read.");
		expect(device.read().calendarReads[good.id].failure).toBeNull();
		expect(warn.mock.calls[0][0]).toContain("Birthdays");
		warn.mockRestore();
	});

	it("keeps the time of the last good read, not the time of the draw", async () => {
		const deps = twoSources();
		let clock = 1_000;
		const { calendar, device } = calendarOf([good, bad], deps.gateway, () => clock);
		await calendar.refresh();

		clock = 9_000;
		refuse.add(fixture("all-day.ics"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		calendar.meetingsOn(day, "day");
		warn.mockRestore();

		expect(device.read().calendarReads[bad.id].readAt).toBe(1_000);
	});

	it("writes nothing while every copy reads, so a draw stays free to call", async () => {
		const deps = twoSources();
		const { calendar, app } = calendarOf([good, bad], deps.gateway);
		await calendar.refresh();

		const wrote = vi.spyOn(app, "saveLocalStorage");
		calendar.meetingsOn(day, "day");
		calendar.meetingsOn(day, "notes");

		expect(wrote).not.toHaveBeenCalled();
		wrote.mockRestore();
	});

	it("writes once for a failure that has not changed, however often the day is drawn", async () => {
		const deps = twoSources();
		const { calendar, app } = calendarOf([good, bad], deps.gateway);
		await calendar.refresh();

		refuse.add(fixture("all-day.ics"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const wrote = vi.spyOn(app, "saveLocalStorage");
		calendar.meetingsOn(day, "day");
		calendar.meetingsOn(day, "day");
		calendar.meetingsOn(day, "day");

		expect(wrote).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledTimes(1);
		wrote.mockRestore();
		warn.mockRestore();
	});
});

describe("a copy that loses only some of its entries while a day is drawn", () => {
	// The whole of issues #138 and #145: #53 widened a failure to mean "lost
	// entries, some or all of them", and neither the settings row nor the
	// console line was told. Both are driven here through the third mock state
	// issue #134 added — bytes that give up their meetings *and* report a loss —
	// so nothing below hand-builds a `CalendarRead`.
	const one = source({ name: "Work", location: "https://cal.test/w.ics" });

	async function draw(
		spoil: (bytes: string) => void,
	): Promise<{ warned: string[]; line: string; meetings: number }> {
		const bytes = fixture("one-day.ics");
		const deps = gateway({ "https://cal.test/w.ics": bytes });
		const { calendar, device } = calendarOf([one], deps.gateway, () => 1_000);
		await calendar.refresh();

		spoil(bytes);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const meetings = calendar.meetingsOn(day, "day");
		const warned = warn.mock.calls.map((call) => String(call[0]));
		warn.mockRestore();

		return {
			warned,
			line: sourceStateLine(one, device.read().calendarReads[one.id], 1_000),
			meetings: meetings.length,
		};
	}

	it("draws a row that does not call the calendar failed", async () => {
		const { line, meetings } = await draw((bytes) => lose.add(bytes));

		// The meetings really are in the day, which is why the row may not say
		// the calendar failed. It still says what was left out and when it read.
		expect(meetings).toBe(2);
		expect(line).toBe(
			"Read, with entries left out: Some entries could not be read. Last read just now.",
		);
	});

	it("still draws Failed for a copy that would not read at all", async () => {
		const { line, meetings } = await draw((bytes) => refuse.add(bytes));

		expect(meetings).toBe(0);
		expect(line).toBe("Failed: This calendar could not be read. Last read just now.");
	});

	it("tells the console the calendar was read, not that it was not", async () => {
		const { warned } = await draw((bytes) => lose.add(bytes));

		expect(warned).toHaveLength(1);
		expect(warned[0]).toBe(
			'Effortless: the calendar "Work" was read while a day was being drawn, but some ' +
				"of its entries were left out of it. Some entries could not be read.",
		);
		expect(warned[0]).not.toContain("could not be read while a day");
		expect(warned[0]).not.toContain("its meetings are missing");
	});

	it("still tells the console the meetings are missing for a total failure", async () => {
		const { warned } = await draw((bytes) => refuse.add(bytes));

		expect(warned).toHaveLength(1);
		expect(warned[0]).toBe(
			'Effortless: the calendar "Work" could not be read while a day was being drawn, ' +
				"so its meetings are missing from it. This calendar could not be read.",
		);
	});

	// `docs/acceptance-queue.md` tells a tester to look for this opening in the
	// developer console, so both lines keep it whatever else they say.
	it("opens both lines the way the acceptance queue tells a tester to look for", async () => {
		const partial = await draw((bytes) => lose.add(bytes));
		const total = await draw((bytes) => refuse.add(bytes));

		for (const line of [partial.warned[0], total.warned[0]]) {
			expect(line.startsWith('Effortless: the calendar "Work"')).toBe(true);
		}
		expect(partial.warned[0].endsWith("Some entries could not be read.")).toBe(true);
		expect(total.warned[0].endsWith("This calendar could not be read.")).toBe(true);
	});
});

describe("a per-device record that arrived corrupt", () => {
	/*
	 * The refresh loop indexes straight into the stored read state by source id.
	 * While that store cast local storage over its defaults instead of checking
	 * it, a stored value that was not a record made every fifteen-minute cycle
	 * throw a TypeError. The store now reads it field by field;
	 * this drives the real call site to prove the loop survives it.
	 */
	for (const rubbish of [null, "reads", 7, ["c1"], { c1: "not a read" }]) {
		it(`refreshes without throwing when the read state is ${JSON.stringify(rubbish)}`, async () => {
			const one = source({ location: "https://cal.test/w.ics" });
			const deps = gateway({ "https://cal.test/w.ics": fixture("one-day.ics") });
			const { calendar, device, app } = calendarOf([one], deps.gateway);
			app.saveLocalStorage("effortless:device", { calendarReads: rubbish });

			await expect(calendar.refresh()).resolves.toBeUndefined();

			expect(device.read().calendarReads[one.id].failure).toBeNull();
		});
	}
});

/*
 * **Issue #134.** The fetch path threw the loss away. `readOne` used `readDay`
 * purely as a "are these bytes a calendar" probe and dropped what it returned,
 * so a calendar that lost entries — all of them, or some — was stored as if it
 * had read cleanly, and the next fifteen-minute refresh replaced the whole read
 * state, erasing the failure a draw had recorded. Measured before the fix:
 *
 *     AFTER FETCH:       {"readAt":1000,"failure":null}
 *     AFTER DRAW:        {"readAt":1000,"failure":"1 of 4 entries ..."}
 *     AFTER 2ND REFRESH: {"readAt":1000,"failure":null}   ROW: Last read just now.
 */
describe("a fetched calendar that loses entries", () => {
	const warn = () => vi.spyOn(console, "warn").mockImplementation(() => {});

	it("is stored with a failure when every one of its entries fails to read", async () => {
		const quiet = warn();
		try {
			const one = source({ location: "https://cal.test/w.ics" });
			const deps = gateway({ "https://cal.test/w.ics": noMeetingSurvives() });
			const { calendar, device } = calendarOf([one], deps.gateway, () => 1_000);

			await calendar.refresh();

			const read = device.read().calendarReads[one.id];
			expect(read.failure).toBe(
				"None of the 2 entries in this calendar could be read — a repeating meeting " +
					"counts as one entry.",
			);
			expect(read.failure).not.toBeNull();
			expect(read.readAt).toBe(1_000);
		} finally {
			quiet.mockRestore();
		}
	});

	it("names the loss and still serves the entries it did read", async () => {
		const quiet = warn();
		try {
			const one = source({ location: "https://cal.test/w.ics" });
			const deps = gateway({ "https://cal.test/w.ics": fixture("broken-event.ics") });
			const { calendar, device } = calendarOf([one], deps.gateway);

			await calendar.refresh();

			expect(device.read().calendarReads[one.id].failure).toBe(
				"2 of 4 entries in this calendar could not be read — a repeating meeting counts " +
					"as one entry. Every other entry in it was read.",
			);
			expect(calendar.meetingsOn(day, "day").map((meeting) => meeting.summary)).toEqual([
				"Kept, before the bad ones",
				"Kept, after the bad ones",
			]);
		} finally {
			quiet.mockRestore();
		}
	});

	it("does not erase the failure when a refresh finds the calendar still lossy", async () => {
		const quiet = warn();
		try {
			const one = source({ location: "https://cal.test/w.ics" });
			const deps = gateway({ "https://cal.test/w.ics": fixture("broken-event.ics") });
			const { calendar, device } = calendarOf([one], deps.gateway, () => 1_000);

			await calendar.refresh();
			const afterFetch = device.read().calendarReads[one.id].failure;
			calendar.meetingsOn(day, "day");
			await calendar.refresh();

			expect(afterFetch).not.toBeNull();
			expect(device.read().calendarReads[one.id].failure).toBe(afterFetch);
		} finally {
			quiet.mockRestore();
		}
	});

	it("writes no failure once a refresh reads the calendar cleanly", async () => {
		const quiet = warn();
		try {
			const one = source({ location: "https://cal.test/w.ics" });
			const links: Record<string, string> = {
				"https://cal.test/w.ics": fixture("broken-event.ics"),
			};
			const deps = gateway(links);
			const { calendar, device } = calendarOf([one], deps.gateway);

			await calendar.refresh();
			expect(device.read().calendarReads[one.id].failure).not.toBeNull();

			links["https://cal.test/w.ics"] = fixture("one-day.ics");
			await calendar.refresh();

			expect(device.read().calendarReads[one.id].failure).toBeNull();
		} finally {
			quiet.mockRestore();
		}
	});

	it("keeps a draw's loss on the row until a refresh has something else to say", async () => {
		const quiet = warn();
		try {
			const bytes = fixture("broken-event.ics");
			lose.add(bytes);
			const one = source({ location: "https://cal.test/w.ics" });
			const deps = gateway({ "https://cal.test/w.ics": bytes });
			const { calendar, device } = calendarOf([one], deps.gateway, () => 1_000);

			await calendar.refresh();
			const fetched = device.read().calendarReads[one.id].failure;

			expect(calendar.meetingsOn(day, "day")).toHaveLength(2);
			expect(device.read().calendarReads[one.id].failure).toBe("Some entries could not be read.");

			await calendar.refresh();

			// The refresh reads the same lossy bytes, so it has its own loss to
			// write. What it must never do is write null over the draw's.
			expect(device.read().calendarReads[one.id].failure).toBe(fetched);
			expect(device.read().calendarReads[one.id].failure).not.toBeNull();
		} finally {
			quiet.mockRestore();
		}
	});

	// **Issue #229.** A draw failure used to be built by spreading the previous
	// read state in and then deleting the grade again, which is the one site that
	// expressed "carried or left off" by removing a field. Built one field at a
	// time, the grade is simply never added — and this is what says so: the grade
	// a lossy fetch stored must not survive into a draw failure that lost nothing,
	// or the row would call a calendar that would not read at all a partial loss.
	it("does not carry a stored grade into a draw failure that is not a loss", async () => {
		const quiet = warn();
		try {
			const bytes = fixture("broken-event.ics");
			const one = source({ location: "https://cal.test/w.ics" });
			const deps = gateway({ "https://cal.test/w.ics": bytes });
			const { calendar, device } = calendarOf([one], deps.gateway, () => 1_000);

			await calendar.refresh();
			expect(device.read().calendarReads[one.id].loss).toBe("partial");

			refuse.add(bytes);
			calendar.meetingsOn(day, "day");

			const read = device.read().calendarReads[one.id];
			expect(read.failure).toBe("This calendar could not be read.");
			expect(read.loss).toBeUndefined();
			// Left off rather than written as an explicit undefined, which is the
			// rule `readCalendarReads` states and a third state the calendar does
			// not have.
			expect(Object.prototype.hasOwnProperty.call(read, "loss")).toBe(false);
			// The other optional field is decided the other way, and the same
			// rebuild must not cost it: the address is still carried.
			expect(read.readFrom).toBe("link:https://cal.test/w.ics");
		} finally {
			quiet.mockRestore();
		}
	});

	it("reads back an entry stored before the loss grade existed, without throwing", () => {
		const one = source({ location: "https://cal.test/w.ics" });
		const { device, app } = calendarOf([one], gateway().gateway);
		app.saveLocalStorage("effortless:device", {
			calendarReads: { [one.id]: { readAt: 1_000, failure: "The network is down." } },
		});

		const read = device.read().calendarReads[one.id];

		expect(read).toEqual({ readAt: 1_000, failure: "The network is down." });
		expect(read.loss).toBeUndefined();
	});

	// The grade has to survive `readCalendarReads`, which returns only the field
	// names it knows — so this drives the round trip through the store rather
	// than reading what `readOne` returned.
	it("carries whether the loss was partial or total on the stored read", async () => {
		const quiet = warn();
		try {
			const some = source({ location: "https://cal.test/some.ics" });
			const none = source({ location: "https://cal.test/none.ics" });
			const deps = gateway({
				"https://cal.test/some.ics": fixture("broken-event.ics"),
				"https://cal.test/none.ics": nothingReadable(3),
			});
			const { calendar, device } = calendarOf([some, none], deps.gateway);

			await calendar.refresh();

			expect(device.read().calendarReads[some.id].loss).toBe("partial");
			expect(device.read().calendarReads[none.id].loss).toBe("total");
		} finally {
			quiet.mockRestore();
		}
	});

	// The distinction the test above used to get wrong, pinned so it cannot be
	// got wrong again. `noMeetingSurvives` holds two entries: one whose repeat
	// rule throws, and one with no DTSTART at all. Both are lost, so the grade
	// is *total* — it was *partial* until issue #222, because only an entry
	// that threw was counted and the discarded one was invisible.
	it("grades total when the last survivor was discarded rather than thrown out", async () => {
		const quiet = warn();
		try {
			const one = source({ location: "https://cal.test/w.ics" });
			const deps = gateway({ "https://cal.test/w.ics": noMeetingSurvives() });
			const { calendar, device } = calendarOf([one], deps.gateway);

			await calendar.refresh();

			expect(calendar.meetingsOn(day, "day")).toEqual([]);
			expect(device.read().calendarReads[one.id].loss).toBe("total");
		} finally {
			quiet.mockRestore();
		}
	});
});

describe("the fifteen-minute cycle", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("is fifteen minutes", () => {
		expect(REFRESH_EVERY_MS).toBe(15 * 60 * 1000);
	});

	it("reads every source once as soon as it starts", async () => {
		const deps = gateway({ "https://cal.test/w.ics": fixture("one-day.ics") });
		const { calendar } = calendarOf([source()], deps.gateway);

		calendar.load();
		await vi.advanceTimersByTimeAsync(0);

		expect(deps.asked).toEqual(["fetch https://cal.test/w.ics"]);
	});

	it("reads them again on every cycle after that", async () => {
		const deps = gateway({ "https://cal.test/w.ics": fixture("one-day.ics") });
		const { calendar } = calendarOf([source()], deps.gateway);

		calendar.load();
		await vi.advanceTimersByTimeAsync(REFRESH_EVERY_MS * 2);

		expect(deps.asked.length).toBe(3);
	});

	it("stops reading the moment the calendar is unloaded", async () => {
		const deps = gateway({ "https://cal.test/w.ics": fixture("one-day.ics") });
		const { calendar } = calendarOf([source()], deps.gateway);

		calendar.load();
		await vi.advanceTimersByTimeAsync(0);
		calendar.unload();
		await vi.advanceTimersByTimeAsync(REFRESH_EVERY_MS * 3);

		expect(deps.asked.length).toBe(1);
	});
});

describe("waiting for the layout to be ready", () => {
	it("holds the first read until the layout is ready, and records no failure while it waits", async () => {
		let ready: (() => void) | undefined;
		const whenReady = (callback: () => void): void => {
			ready = callback;
		};
		const deps = gateway({}, { "Calendars/work.ics": fixture("one-day.ics") });
		const app = new App();
		const device = new DeviceStore(app as unknown as ObsidianApp);
		const one = source({ kind: "file", location: "Calendars/work.ics" });
		const calendar = new CalendarSources(() => [one], device, deps.gateway, Date.now, whenReady);

		calendar.load();

		// The layout has not signalled ready yet: nothing was read, and a file
		// that in fact exists is not reported missing while the plugin waits.
		expect(deps.asked).toEqual([]);
		expect(calendar.meetingsOn(day, "day")).toEqual([]);
		expect(device.read().calendarReads[one.id]).toBeUndefined();

		ready?.();
		await calendar.refresh();

		expect(deps.asked).toEqual(["read Calendars/work.ics"]);
		expect(device.read().calendarReads[one.id]?.failure).toBeNull();
		expect(calendar.meetingsOn(day, "day").length).toBeGreaterThan(0);
	});

	it("runs the first read at once when no readiness function is given, so existing construction sites see no change", () => {
		const deps = gateway({ "https://cal.test/w.ics": fixture("one-day.ics") });
		const { calendar } = calendarOf([source()], deps.gateway);

		calendar.load();

		expect(deps.asked).toEqual(["fetch https://cal.test/w.ics"]);
	});
});

describe("the layout-ready callback after unload", () => {
	it("reads and saves nothing when the layout signals ready after the calendar was unloaded", () => {
		let ready: (() => void) | undefined;
		const whenReady = (callback: () => void): void => {
			ready = callback;
		};
		const deps = gateway({}, { "Calendars/work.ics": fixture("one-day.ics") });
		const app = new App();
		const device = new DeviceStore(app as unknown as ObsidianApp);
		const one = source({ kind: "file", location: "Calendars/work.ics" });
		const calendar = new CalendarSources(() => [one], device, deps.gateway, Date.now, whenReady);

		calendar.load();
		calendar.unload();
		ready?.();

		expect(deps.asked).toEqual([]);
		expect(device.read().calendarReads[one.id]).toBeUndefined();
	});
});

describe("what the read state is kept in", () => {
	it("stays on this device, because a failure here is not a failure there", async () => {
		const one = source({ location: "https://cal.test/w.ics" });
		const deps = gateway({ "https://cal.test/w.ics": fixture("one-day.ics") });
		const { calendar, app } = calendarOf([one], deps.gateway);

		await calendar.refresh();

		expect(JSON.stringify([...app.localStorage.values()])).toContain("readAt");
	});
});

describe("a calendar that is repointed at something else", () => {
	/**
	 * The copy is kept under the source's id and the id survives an edit, so
	 * these tests all take the same shape: read one address, change the address
	 * underneath, and ask what the day is built from afterwards.
	 */
	function pointedAt(location: string, kind: "link" | "file" = "link") {
		const one = source({ location, kind });
		const sources = [one];
		const deps = gateway(
			{ "https://cal.test/w.ics": fixture("one-day.ics") },
			{ "Calendars/work.ics": fixture("one-day.ics") },
		);
		const { calendar, device } = calendarOf(sources, deps.gateway);
		return { one, sources, deps, calendar, device };
	}

	it("stops serving the old address once the address is emptied", async () => {
		const { one, sources, calendar } = pointedAt("https://cal.test/w.ics");
		await calendar.refresh();
		expect(calendar.meetingsOn(day, "day").length).toBe(2);

		sources[0] = { ...one, location: "" };
		await calendar.refresh();

		// Both uses ask the same store, so both go quiet together.
		expect(calendar.meetingsOn(day, "day")).toEqual([]);
		expect(calendar.meetingsOn(day, "notes")).toEqual([]);
	});

	it("stops serving the link's meetings once the calendar is switched to a file", async () => {
		const { one, sources, calendar } = pointedAt("https://cal.test/w.ics");
		await calendar.refresh();

		// What the settings screen writes when the dropdown is switched.
		sources[0] = { ...one, kind: "file", location: "" };
		await calendar.refresh();

		expect(calendar.meetingsOn(day, "day")).toEqual([]);
	});

	it("stops serving the old address once a new one is given that will not read", async () => {
		const { one, sources, calendar, device } = pointedAt("https://cal.test/w.ics");
		await calendar.refresh();

		sources[0] = { ...one, location: "https://cal.test/gone.ics" };
		await calendar.refresh();

		expect(calendar.meetingsOn(day, "day")).toEqual([]);
		expect(device.read().calendarReads[one.id].failure).toBe(
			"Nothing is published at https://cal.test/gone.ics.",
		);
	});

	it("stops claiming a last-read time that the previous address earned", async () => {
		const { one, sources, calendar, device } = pointedAt("https://cal.test/w.ics");
		await calendar.refresh();
		expect(device.read().calendarReads[one.id].readAt).not.toBeNull();

		sources[0] = { ...one, location: "" };
		await calendar.refresh();

		expect(device.read().calendarReads[one.id].readAt).toBeNull();
	});

	it("stops claiming the previous address's last-read time even after a failed draw", async () => {
		const { one, sources, calendar, device } = pointedAt("https://cal.test/w.ics");
		await calendar.refresh();

		// A draw writes the read state too, and it must not lose the address the
		// last good read was earned at on its way through.
		refuse.add(fixture("one-day.ics"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		calendar.meetingsOn(day, "day");
		warn.mockRestore();

		sources[0] = { ...one, location: "" };
		await calendar.refresh();

		expect(device.read().calendarReads[one.id].readAt).toBeNull();
	});

	it("draws no meetings while it points at an address it has never read", async () => {
		const { one, sources, calendar } = pointedAt("https://cal.test/w.ics");
		await calendar.refresh();

		// Repointed with no read in between, so the only bytes in the store were
		// read from somewhere else. `copyOf` compares the two and answers
		// nothing, which is what keeps the previous address's meetings off the
		// day whether or not anything has pruned the copy yet.
		sources[0] = { ...one, location: "https://cal.test/other.ics" };

		expect(calendar.meetingsOn(day, "day")).toEqual([]);
	});

	it("serves the copy again when it is repointed away and back with no read between", async () => {
		const { one, sources, calendar } = pointedAt("https://cal.test/w.ics");
		await calendar.refresh();
		expect(calendar.meetingsOn(day, "day").length).toBe(2);

		sources[0] = { ...one, location: "https://cal.test/other.ics" };
		expect(calendar.meetingsOn(day, "day")).toEqual([]);
		sources[0] = { ...one, location: "https://cal.test/w.ics" };

		// The asking in the middle did not forget the copy: `copyOf` is a
		// question and only a read prunes. The bytes are old, and they really
		// were read from the address the calendar names again, which is the
		// bargain issue #105 already strikes for a failed read.
		expect(calendar.meetingsOn(day, "day").length).toBe(2);
	});

	it("keeps the copy when the address is unchanged and only the name is edited", async () => {
		const { one, sources, calendar } = pointedAt("https://cal.test/w.ics");
		await calendar.refresh();

		sources[0] = { ...one, name: "Work again" };
		await calendar.refresh();

		expect(calendar.meetingsOn(day, "day").length).toBe(2);
	});
});

describe("what awaiting refresh() guarantees", () => {
	/**
	 * A gateway that answers nothing until the test lets it, so that a read can
	 * be held open while the source list changes underneath it — which is the
	 * only way to drive the window issue #112 is about.
	 */
	function heldGateway(links: Record<string, string>) {
		const asked: string[] = [];
		const waiting: (() => void)[] = [];
		let letThrough = false;
		return {
			asked,
			/** Answers every fetch asked for so far, and every later one at once. */
			answerEverything(): void {
				letThrough = true;
				for (const wake of waiting.splice(0)) wake();
			},
			gateway: {
				async fetch(url: string): Promise<string> {
					asked.push(url);
					if (!letThrough) await new Promise<void>((resolve) => waiting.push(resolve));
					const ics = links[url];
					if (ics === undefined) throw new Error(`Nothing is published at ${url}.`);
					return ics;
				},
				async readFile(path: string): Promise<string> {
					throw new Error(`There is no file at ${path}.`);
				},
			} satisfies CalendarGateway,
		};
	}

	/** One calendar read, with a second one waiting to be added mid-read. */
	function oneReading() {
		const one = source({ location: "https://cal.test/w.ics" });
		const two = source({ location: "https://cal.test/b.ics" });
		const sources = [one];
		const deps = heldGateway({
			"https://cal.test/w.ics": fixture("one-day.ics"),
			"https://cal.test/b.ics": fixture("all-day.ics"),
		});
		return { one, two, sources, deps, ...calendarOf(sources, deps.gateway) };
	}

	it("reads each source once when two callers ask in the same tick", async () => {
		const deps = gateway({ "https://cal.test/w.ics": fixture("one-day.ics") });
		const { calendar } = calendarOf([source()], deps.gateway);

		await Promise.all([calendar.refresh(), calendar.refresh()]);

		expect(deps.asked).toEqual(["fetch https://cal.test/w.ics"]);
	});

	it("waits for a read that saw the calendar added while another read was in flight", async () => {
		const { two, sources, deps, calendar, device } = oneReading();

		const first = calendar.refresh();
		await Promise.resolve();
		sources.push(two);
		const second = calendar.refresh();
		deps.answerEverything();
		await Promise.all([first, second]);

		expect(deps.asked).toContain("https://cal.test/b.ics");
		// Undefined rather than null when the follow-up never happened, and
		// `toBeNull` tells the two apart.
		expect(device.read().calendarReads[two.id]?.failure).toBeNull();
	});

	it("gives every caller that arrived during one read the same single follow-up", async () => {
		const { two, sources, deps, calendar } = oneReading();

		const first = calendar.refresh();
		await Promise.resolve();
		sources.push(two);
		const rest = [calendar.refresh(), calendar.refresh(), calendar.refresh()];
		deps.answerEverything();
		await Promise.all([first, ...rest]);

		// One read of the one calendar there was, then one follow-up read of
		// both — three fetches for four callers, not seven.
		expect(deps.asked.length).toBe(3);
	});

	/*
	 * **Issue #164.** Issue #112's criterion said a caller "resolves only after a
	 * read that saw the source list as it was when that call was made". That is
	 * not what the code does and it is not what the code should do. The follow-up
	 * calls `refresh()` at resolution time, so it reads the list as it stands
	 * *then*. Where the list goes A → B → A inside one read, the caller who asked
	 * at B is answered by a read of A.
	 *
	 * Carrying the queuing caller's list would not fix it: one `queued` promise is
	 * shared by every caller whose list differs from the read in flight, so a
	 * follow-up carrying the first queuer's list answers the second about a list
	 * it never asked about — the same defect, moved. Holding #112's wording needs
	 * one read per distinct list, and the settings screen writes on every
	 * keystroke, so that is a read per character typed.
	 *
	 * The guarantee that is real, and the one a caller actually wants: it is
	 * answered by a read that saw the list as it stood **no earlier than** when
	 * that call was made. Never a stale one; not necessarily its own.
	 */
	it("answers a queued caller with a read no earlier than its call, not with its own list", async () => {
		const { two, sources, deps, calendar, device } = oneReading();

		const first = calendar.refresh();
		await Promise.resolve();
		// B: the second calendar is added, and a caller asks about that list.
		sources.push(two);
		const second = calendar.refresh();
		// Back to A before the read in flight finishes, so the list the follow-up
		// sees is not the list the queued caller asked about.
		sources.pop();
		deps.answerEverything();
		await Promise.all([first, second]);

		// The B caller was answered, and the answer is a read of A. The second
		// calendar was never fetched, because by the time the follow-up ran it
		// was not in the list any more.
		expect(deps.asked).toEqual(["https://cal.test/w.ics", "https://cal.test/w.ics"]);
		expect(device.read().calendarReads[two.id]).toBeUndefined();
	});

	it("starts the follow-up even when the read in flight fell over altogether", async () => {
		const { two, sources, deps, calendar, device } = oneReading();
		// Not a calendar that will not read — that is kept per calendar and never
		// reaches the caller. This is the bookkeeping itself failing, which is
		// what rejects a whole read.
		const save = vi.spyOn(device, "save").mockImplementationOnce(() => {
			throw new Error("The device store would not write.");
		});

		const first = calendar.refresh();
		await Promise.resolve();
		sources.push(two);
		const second = calendar.refresh();
		deps.answerEverything();

		await expect(first).rejects.toThrow("The device store would not write.");
		await second;
		expect(deps.asked.length).toBe(3);
		save.mockRestore();
	});
});

describe("where a calendar source's id is made", () => {
	/**
	 * One conversion to base 36. A calendar source's id is two of them joined by
	 * a hyphen — a timestamp and a random string — and the shape asserted below,
	 * `^[0-9a-z]+-[0-9a-z]{8}$`, is what that produces.
	 *
	 * **What the guard checks is a count: two written-out `.toString(36)` call
	 * expressions in one comment-stripped file, whatever they convert.** It
	 * counts rather than matching two exact call expressions, because those
	 * reserved a spelling and not a format: a file holding its timestamp in a
	 * variable first — `` const stamp = Date.now(); … `${stamp.toString(36)}-…` ``
	 * — wrote the same id and went unnamed. A count is all
	 * it is, and the two edges of that are written out here rather than left for
	 * the next reader to meet.
	 *
	 * **The wall stands at two, however unrelated the two are.** One conversion
	 * is free; a second in the same file is named, even where no id is written
	 * anywhere in it — a file needing both a short random token and a number
	 * written compactly is named by a test about calendars. That is accepted
	 * deliberately, and `it("names two unrelated conversions …")` below pins it.
	 * Reserving the bare conversion was worse: it failed every such file, and
	 * the checkbox-cycling feature reshaped its own id generator to draw a
	 * character at a time rather than trip a calendar test. Issue #119
	 * asked for one place that decides the id *format*, not one file allowed to
	 * do arithmetic.
	 *
	 * **The hole is a helper.** Only written-out conversions are counted, so a
	 * file that converts inside a one-line helper and calls it twice —
	 * `` const b36 = (n: number) => n.toString(36); `` then
	 * `` `${b36(Date.now())}-${b36(Math.random())}` `` — holds one match and
	 * goes unnamed, id and all. Closing it needs a multi-line or syntax-tree
	 * read, which this repository refused on the sibling code-point guard and
	 * wrote down instead.
	 * `it("does not name an id built through a one-line helper …")` below pins
	 * that this is the guard's answer today, not an accident.
	 */
	const BASE_36 = /\.toString\(\s*36\s*\)/g;

	/**
	 * Every one of `files` that writes a calendar source's id format for itself.
	 *
	 * **Comments go first.** The guard is about what the code does, and a
	 * sentence explaining where the format lives is not a second copy of it.
	 * Reading raw text left a worker three bad options — weaken the guard, not
	 * write the comment, or shape the code around it — and a feature took the
	 * third, recording the reason in shipped source. The stripper
	 * is `sourceGuards.ts`'s, which five other sweeps here already call; a
	 * second copy of that rule is its own finding class in this repository.
	 *
	 * A plain function of what it is handed, so that a test can drive it over
	 * fabricated files and watch it answer. A guard that can only be run against
	 * the real tree cannot be shown to catch anything — the reasoning is written
	 * out on `requiredFloor` in `sourceGuards.ts`.
	 */
	function idWriters(files: ReadonlyArray<{ path: string; source: string }>): string[] {
		return files
			.filter(({ source }) => (withoutComments(source).match(BASE_36) ?? []).length >= 2)
			.map(({ path }) => path);
	}

	/*
	 * The expression was written twice, byte for byte: once here with the
	 * docstring saying why it is not a UUID, and once inline in the settings
	 * loader carrying nothing. An id is what a calendar is found by and what its
	 * per-device read state is keyed on, so an id format that ever has to change
	 * must have one place to change it in.
	 */
	it("is one file, and one file only", () => {
		// `shippedSources()` from `./sourceGuards`, not a walk of this file's
		// own. This was a copy of that walk under a different name, so the guard
		// against a shared helper being defined twice could not see it, and a
		// fix to the shared walk left this one behind.
		expect(idWriters(shippedSources())).toEqual(["src/core/calendarSources.ts"]);
	});

	it("is not tripped by a comment that only names the format", () => {
		const naming = [
			"// The id is Date.now().toString(36) joined to Math.random().toString(36).",
			"/* Date.now().toString(36) and Math.random().toString(36) belong elsewhere. */",
			"/** Written out as Date.now().toString(36) in the calendar module, not here. */",
		];

		for (const comment of naming) {
			const file = { path: "src/features/thing.ts", source: `${comment}\nexport const n = 1;\n` };
			expect(idWriters([file])).toEqual([]);
		}
	});

	it("still names a file that writes the format in code", () => {
		const second = {
			path: "src/features/thing.ts",
			source:
				"// The calendar module owns this format.\n" +
				"const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;\n",
		};

		expect(idWriters([second])).toEqual(["src/features/thing.ts"]);
	});

	it("names it when the timestamp is held in a variable first", () => {
		// The near-miss the old guard let through. It reserved two exact call
		// expressions, and only one of them is written here; the id that comes
		// out is the same one.
		const nearMiss = {
			path: "src/features/thing.ts",
			source:
				"const stamp = Date.now();\n" +
				"const id = `${stamp.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;\n",
		};

		expect(idWriters([nearMiss])).toEqual(["src/features/thing.ts"]);
	});

	it("leaves an ordinary base-36 conversion elsewhere alone", () => {
		// What a file that needs a short token, or a compact number, writes. The
		// guard used to fail all of these, and a feature reshaped its own id
		// generator rather than trip a test named for calendars.
		const elsewhere = [
			{ path: "src/features/a.ts", source: "const token = Math.random().toString(36).slice(2, 14);" },
			{ path: "src/features/b.ts", source: "const label = count.toString(36);" },
			{ path: "src/features/c.ts", source: "const stamp = Date.now().toString(36);" },
			{ path: "src/features/d.ts", source: "const now = Date.now();\nconst label = now.toString(36);" },
		];

		expect(idWriters(elsewhere)).toEqual([]);
	});

	it("names two unrelated conversions with no id between them", () => {
		// The accepted edge. This file writes no id at all — a short random
		// token and a number written compactly — and is named anyway, because
		// the guard counts conversions and does not read what they are for.
		// Accepted rather than fixed: telling an id-shaped conversion from an
		// ordinary one needs a syntax-tree read, and the alternative tried
		// before was reserving the bare conversion, which failed every file
		// like this one. A file that needs both writes one of them
		// through a helper, or the guard is revisited then.
		const unrelated = {
			path: "src/features/thing.ts",
			source:
				"const token = Math.random().toString(36).slice(2, 14);\n" +
				"const label = count.toString(36);\n",
		};

		expect(idWriters([unrelated])).toEqual(["src/features/thing.ts"]);
	});

	it("does not name an id built through a one-line helper", () => {
		// The hole. The guard counts written-out `.toString(36)` call
		// expressions, so a conversion written once and called twice counts
		// once — and this file writes the id format in full.
		const throughHelper = {
			path: "src/features/thing.ts",
			source:
				"const b36 = (n: number) => n.toString(36);\n" +
				"const id = `${b36(Date.now())}-${b36(Math.random())}`;\n",
		};

		expect(idWriters([throughHelper])).toEqual([]);
	});

	it("gives an added calendar and a stored one the same shape of id", () => {
		const shape = /^[0-9a-z]+-[0-9a-z]{8}$/;
		expect(newCalendarSourceId()).toMatch(shape);
		expect(newCalendarSource().id).toMatch(shape);
	});

	it("makes no two ids the same, however fast they are asked for", () => {
		const made = new Set<string>();
		for (let n = 0; n < 500; n++) made.add(newCalendarSourceId());
		expect(made.size).toBe(500);
	});
});


describe("where a calendar source's location is tidied", () => {
	/**
	 * The dispatch that says which route is cleaned and which is only trimmed:
	 * a test against the `"file"` kind, or its `"link"` counterpart, sitting
	 * beside a call to `asVaultPath`. There are only two routes, so a copy
	 * spelt against either one is the same dispatch.
	 *
	 * **The vault-path rule is not what drifts.** `asVaultPath` was imported
	 * rather than copied in all three places that held this dispatch, and the
	 * comparison still came apart, because what was written out three times was
	 * the *choice* of route. A stored
	 * location tidied under one copy and a stored `readFrom` tidied under
	 * another stopped matching, and the calendar row silently lost its last-read
	 * age.
	 *
	 * The two halves are matched in either order and across a window rather than
	 * as one expression, so the statement form catches as well as the ternary,
	 * and a `switch` reaches its route test through `case` the same as an `if`
	 * reaches it through `===`. A file that calls `asVaultPath` with no route
	 * test is an ordinary caller of the vault-path rule and goes free; so does
	 * a file that sorts a kind without tidying anything, which is what `asKind`
	 * does.
	 */
	const TIDY_DISPATCH =
		/(?:===|!==|case)\s*"(?:file|link)"[\s\S]{0,120}?asVaultPath\s*\(|asVaultPath\s*\([\s\S]{0,120}?(?:===|!==|case)\s*"(?:file|link)"/;

	/**
	 * Every one of `files` that decides for itself which route is tidied.
	 *
	 * Comments go first, for the reason written out on `idWriters` above: a
	 * sentence naming where the rule lives is not a second copy of it. A plain
	 * function of what it is handed, so a test can drive it over fabricated
	 * files and watch it answer, rather than only over the real tree.
	 */
	function locationTidiers(files: ReadonlyArray<{ path: string; source: string }>): string[] {
		return files
			.filter(({ source }) => TIDY_DISPATCH.test(withoutComments(source)))
			.map(({ path }) => path);
	}

	it("is one file, and one file only", () => {
		expect(locationTidiers(shippedSources())).toEqual(["src/core/calendarSources.ts"]);
	});

	it("names a second copy however it is spelt", () => {
		const copies = [
			{
				path: "src/features/a.ts",
				source: 'const at = kind === "file" ? asVaultPath(location) : location.trim();',
			},
			{
				path: "src/features/b.ts",
				source: 'const at = kind !== "file" ? value.trim() : asVaultPath(value);',
			},
			{
				path: "src/features/c.ts",
				source: 'if (source.kind === "file") return asVaultPath(where);\nreturn where.trim();',
			},
			{
				path: "src/features/g.ts",
				source: 'const at = kind === "link" ? location.trim() : asVaultPath(location);',
			},
			{
				path: "src/features/h.ts",
				source:
					'switch (kind) { case "link": return v.trim(); default: return asVaultPath(v); }',
			},
		];

		expect(locationTidiers(copies)).toEqual([
			"src/features/a.ts",
			"src/features/b.ts",
			"src/features/c.ts",
			"src/features/g.ts",
			"src/features/h.ts",
		]);
	});

	it("leaves an ordinary caller of the vault-path rule alone", () => {
		const elsewhere = [
			{ path: "src/features/d.ts", source: "const folder = asVaultPath(typed);" },
			{ path: "src/features/e.ts", source: 'return value === "file" ? "file" : "link";' },
			{
				path: "src/features/f.ts",
				source: '// One kind === "file" test would pick asVaultPath, and it lives elsewhere.\nexport const n = 1;',
			},
		];

		expect(locationTidiers(elsewhere)).toEqual([]);
	});
});


describe("the calendar library breaking its own contract", () => {
	const workIcs = fixture("one-day.ics");
	const homeIcs = fixture("second-calendar.ics");
	const links = { "https://cal.test/w.ics": workIcs, "https://cal.test/h.ics": homeIcs };

	/** Two sources on a store, and the console lines a read of them wrote. */
	async function readBothWithBrokenLibrary(clock: () => number): Promise<{
		device: DeviceStore;
		sources: CalendarSource[];
		lines: string[];
	}> {
		const work = source({ location: "https://cal.test/w.ics" });
		const home = source({ location: "https://cal.test/h.ics" });
		const { calendar, device } = calendarOf([work, home], gateway(links).gateway, clock);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await calendar.refresh();
			return {
				device,
				sources: [work, home],
				lines: warn.mock.calls.map((call) => String(call[0])),
			};
		} finally {
			warn.mockRestore();
		}
	}

	it("records no failure against a calendar whose bytes are perfectly good", async () => {
		contractBreakers.add(workIcs);
		contractBreakers.add(homeIcs);

		const { device, sources } = await readBothWithBrokenLibrary(() => 1_000);
		const reads = device.read().calendarReads;

		expect(reads[sources[0].id].failure).toBeNull();
		expect(reads[sources[1].id].failure).toBeNull();
	});

	it("leaves the last-read time a good read already earned exactly where it was", async () => {
		const work = source({ location: "https://cal.test/w.ics" });
		let clock = 1_000;
		const { calendar, device } = calendarOf([work], gateway(links).gateway, () => clock);
		await calendar.refresh();
		expect(device.read().calendarReads[work.id].readAt).toBe(1_000);

		contractBreakers.add(workIcs);
		clock = 9_000;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await calendar.refresh();
		} finally {
			warn.mockRestore();
		}

		const after = device.read().calendarReads[work.id];
		expect(after.readAt).toBe(1_000);
		expect(after.failure).toBeNull();
		// `addressOf`, which is how a read state records where it was earned.
		expect(after.readFrom).toBe("link:https://cal.test/w.ics");
	});

	it("says it on the console once for the read, not once per source", async () => {
		contractBreakers.add(workIcs);
		contractBreakers.add(homeIcs);

		const { lines } = await readBothWithBrokenLibrary(() => 1_000);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/ical-expander.*`events`/);
	});

	// **The trade-off, and it is deliberate.** A broken dependency leaves the day
	// empty with nothing new on the settings row, which brushes against issue
	// #53. Issue #289 settled that this failure's audience is whoever has the
	// console open: the person has nothing to fix, and a per-calendar sentence
	// would libel every good calendar in the vault. Pinned here so that undoing
	// it breaks a test rather than passing quietly.
	it("adds no sentence to the settings row of a calendar it could not parse", async () => {
		contractBreakers.add(workIcs);
		contractBreakers.add(homeIcs);

		const { device, sources } = await readBothWithBrokenLibrary(() => 1_000);
		const line = sourceStateLine(sources[0], device.read().calendarReads[sources[0].id], 1_000);

		expect(line).not.toMatch(/ical-expander/);
		expect(line).not.toMatch(/^Failed:/);
	});

	it("still records an ordinary failure while the library is sound", async () => {
		const work = source({ location: "https://cal.test/w.ics" });
		const deps = gateway(links);
		deps.breaks("https://cal.test/w.ics", "The network is down.");
		const { calendar, device } = calendarOf([work], deps.gateway, () => 1_000);

		await calendar.refresh();

		expect(device.read().calendarReads[work.id].failure).toMatch(/network is down/);
	});
});
