/**
 * The whole calendar path with the **real** reader in it, driven by the one
 * reproduction line issue #53 was filed for: a calendar whose bytes parse but
 * whose every event fails to read.
 *
 * It is its own file because `calendarSources.test.ts` replaces the reader with
 * a double for its whole length, which is what let that reproduction go on
 * reproducing after #53's first fix — the double had no state for "these bytes
 * gave up some meetings and lost the rest", so the loss was never carried
 * through `CalendarSources` at all. Nothing here is mocked but the vault and the
 * network, so a break anywhere along fetch → store → draw → row shows up here.
 *
 * Every assertion is about what the settings row ends up saying, because that is
 * the whole point of the distinction: an empty day and a calendar nobody can
 * read look the same to the person until the row tells them apart. One block is
 * about the developer console instead, and it is here for the same
 * reason: how often that line is written can only be seen from the draw that
 * repeats, not from a single read.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp } from "obsidian";
import { App } from "./__mocks__/obsidian";
import { fixture } from "./fixtures";
import { CalendarSources, newCalendarSource } from "../core/calendarSources";
import type { CalendarGateway, CalendarSource } from "../core/calendarSources";
import { sourceStateLine } from "../core/calendarSourcesSection";
import { DeviceStore } from "../core/settings";
import { forgetLossesSaid } from "../core/icsOccurrences";

const day = new Date(2026, 8, 8);
const address = "https://cal.test/w.ics";

/**
 * `broken-event.ics` with its two readable events taken out, so no meeting
 * survives the read.
 *
 * **It grades a *total* loss, and did not until issue #222.** Two entries are
 * left: one whose repeat rule throws, and one with no `DTSTART` at all. Only
 * the throw used to be counted, so a calendar that produced no meeting at all
 * still said "Every other entry in it was read." Both are counted now, because
 * the readability test is asked of each entry before it is expanded and never
 * consults the window.
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

/** A calendar wired to a fresh device store, reading one link that serves `ics`. */
function calendarServing(ics: string): {
	calendar: CalendarSources;
	device: DeviceStore;
	source: CalendarSource;
	serve: (next: string) => void;
} {
	let served = ics;
	const source: CalendarSource = {
		...newCalendarSource(),
		name: "Work",
		kind: "link",
		location: address,
	};
	const gateway: CalendarGateway = {
		async fetch(url: string): Promise<string> {
			if (url !== address) throw new Error(`Nothing is published at ${url}.`);
			return served;
		},
		async readFile(path: string): Promise<string> {
			throw new Error(`There is no file at ${path}.`);
		},
	};
	const app = new App();
	const device = new DeviceStore(app as unknown as ObsidianApp);
	return {
		calendar: new CalendarSources(() => [source], device, gateway, () => 1_000),
		device,
		source,
		serve: (next) => {
			served = next;
		},
	};
}

/** What the settings screen would put under this calendar right now. */
function row(device: DeviceStore, source: CalendarSource): string {
	return sourceStateLine(source, device.read().calendarReads[source.id], 1_000);
}

/**
 * The reader remembers which calendars it has already said a loss about, and
 * that memory outlives a test. Every test here reads through the
 * real reader, so without this the block below asserting the reader's line
 * appears exactly once would see an empty list as soon as any earlier test in
 * the file parsed byte-identical bytes — and nothing on the failing assertion
 * would say why.
 */
beforeEach(() => forgetLossesSaid());

describe("a calendar whose every event fails to read", () => {
	// `salvage` writes a line to the developer console for whoever is looking at
	// the code. It is not the report, and Obsidian's console is closed in normal
	// use — which is exactly why the row below has to say it instead.
	beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
	afterEach(() => vi.restoreAllMocks());

	it("never reads as a clean empty day, at any point on the path", async () => {
		const { calendar, device, source } = calendarServing(noMeetingSurvives());

		await calendar.refresh();
		expect(row(device, source)).not.toBe("Last read just now.");
		expect(row(device, source)).toMatch(/^Failed: /);

		calendar.meetingsOn(day, "day");
		expect(row(device, source)).toMatch(/^Failed: /);

		// The fifteen-minute refresh used to replace the whole read state and
		// write `failure: null` over what the draw had recorded.
		await calendar.refresh();
		expect(row(device, source)).not.toBe("Last read just now.");
		expect(row(device, source)).toMatch(/^Failed: /);
	});

	// This is also the other side of issue #138: nothing of this calendar reached
	// the day, so `Failed:` is exactly what the row should say. The opening added
	// by that issue is for a calendar whose meetings are showing.
	it("says on the row how much of the calendar was lost", async () => {
		const { calendar, device, source } = calendarServing(nothingReadable(2));

		await calendar.refresh();

		expect(row(device, source)).toBe(
			"Failed: None of the 2 entries in this calendar could be read — a repeating meeting " +
				"counts as one entry. Last read just now.",
		);
	});

	it("still says a loss when the last survivor was discarded rather than thrown out", async () => {
		// `noMeetingSurvives` grades total — see its comment. The row must still
		// refuse to read as a quiet day, which is the whole of issue #53.
		const { calendar, device, source } = calendarServing(noMeetingSurvives());

		await calendar.refresh();

		expect(calendar.meetingsOn(day, "day")).toEqual([]);
		expect(row(device, source)).toBe(
			"Failed: None of the 2 entries in this calendar could be read — a repeating " +
				"meeting counts as one entry. Last read just now.",
		);
	});
});

describe("a calendar that loses some of its entries", () => {
	beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
	afterEach(() => vi.restoreAllMocks());

	it("keeps serving the entries it read and still says what is missing", async () => {
		const { calendar, device, source } = calendarServing(fixture("broken-event.ics"));

		await calendar.refresh();

		expect(calendar.meetingsOn(day, "day").map((meeting) => meeting.summary)).toEqual([
			"Kept, before the bad ones",
			"Kept, after the bad ones",
		]);
		// **The opening is `Read, with entries left out:` and not `Failed:`**. The two lines above are the reason: this calendar's
		// meetings are in the day, so a row calling it failed contradicts the
		// day beside it. The failure sentence and the age are unchanged.
		expect(row(device, source)).toBe(
			"Read, with entries left out: 2 of 4 entries in this calendar could not be read — " +
				"a repeating meeting counts as one entry. Every other entry in it was read. " +
				"Last read just now.",
		);
	});

	// **Issue #207, and it is what held #53 and #134 open.** A calendar the
	// download stopped inside is a calendar that lost an entry, and it used to be
	// stored with `failure: null`: the row said `Last read just now.` with a
	// meeting missing from the day. This is the fetch-and-store half of the case
	// `icsReader.test.ts` pins at the reader, and it is driven twice because the
	// failure a first read records must survive the next one when the bytes have
	// not changed.
	it("stores the loss of a calendar the download stopped inside, and keeps it", async () => {
		const { calendar, device, source } = calendarServing(fixture("truncated-after-one.ics"));
		const expected =
			"Read, with entries left out: 1 of 2 entries in this calendar could not be read — " +
			"a repeating meeting counts as one entry. Every other entry in it was read. " +
			"Last read just now.";

		await calendar.refresh();

		expect(calendar.meetingsOn(day, "day").map((meeting) => meeting.summary)).toEqual([
			"Read before the cut",
		]);
		expect(row(device, source)).toBe(expected);

		await calendar.refresh();

		expect(row(device, source)).toBe(expected);
	});
});

describe("a calendar with one entry that never says when it happens", () => {
	/**
	 * One `VEVENT` with no `DTSTART` at all, which is the ordinary issue #222
	 * case and one that is not going to fix itself.
	 */
	function oneDatelessEntry(): string {
		return [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Effortless//Test//EN",
			"BEGIN:VEVENT",
			"UID:dateless@effortless.test",
			"DTSTAMP:20260901T120000Z",
			"SUMMARY:Never says when it happens",
			"END:VEVENT",
			"END:VCALENDAR",
			"",
		].join("\r\n");
	}

	it("says its loss on the console once, not on every draw", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { calendar, device, source } = calendarServing(oneDatelessEntry());

			await calendar.refresh();
			for (let n = 0; n < 5; n += 1) calendar.meetingsOn(day, "day");

			// `CalendarSources` writes its own line naming the source, and has
			// been guarded against repeating since it was written. The reader's
			// line is the one that was not, and it is told apart by its opening.
			const fromTheReader = warn.mock.calls
				.map((call) => String(call[0]))
				.filter((line) => !line.startsWith('Effortless: the calendar "'));

			expect(fromTheReader).toEqual([
				"Effortless: The only entry in this calendar could not be read — a repeating " +
					"meeting counts as one entry.",
			]);
			// What the person sees is unchanged by the console going quiet.
			expect(row(device, source)).toBe(
				"Failed: The only entry in this calendar could not be read — a repeating " +
					"meeting counts as one entry. Last read just now.",
			);
		} finally {
			warn.mockRestore();
		}
	});

	// **The same bytes as the test above, on purpose**. The reader
	// keys its memory on a print of the bytes, so before that memory was cleared
	// between tests one of this pair would have run second and seen no line at
	// all. Both pass, and that is the whole of what this test is for.
	it("says it once for a second calendar built from byte-identical bytes", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { calendar } = calendarServing(oneDatelessEntry());

			await calendar.refresh();
			calendar.meetingsOn(day, "day");

			const fromTheReader = warn.mock.calls
				.map((call) => String(call[0]))
				.filter((line) => !line.startsWith('Effortless: the calendar "'));

			expect(fromTheReader).toEqual([
				"Effortless: The only entry in this calendar could not be read — a repeating " +
					"meeting counts as one entry.",
			]);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("a calendar that reads cleanly", () => {
	it("says nothing is wrong when the day it is asked about is simply empty", async () => {
		const { calendar, device, source } = calendarServing(fixture("one-day.ics"));

		await calendar.refresh();
		expect(calendar.meetingsOn(new Date(2026, 8, 9), "day")).toEqual([]);

		expect(row(device, source)).toBe("Last read just now.");
	});

	it("clears a loss the moment the calendar is whole again", async () => {
		const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { calendar, device, source, serve } = calendarServing(noMeetingSurvives());
			await calendar.refresh();
			expect(row(device, source)).toMatch(/^Failed: /);

			serve(fixture("one-day.ics"));
			await calendar.refresh();

			expect(row(device, source)).toBe("Last read just now.");
		} finally {
			quiet.mockRestore();
		}
	});
});
