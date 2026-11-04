/**
 * `CalendarSources.presenceBetween`: the core's one answer to "can the
 * calendar say a meeting is gone?", shared by building the days ahead and
 * meeting notes so neither re-derives it.
 *
 * `whole` is the gate on every removal. Each case below is one way the
 * calendar can fail to know what is on it — a source that failed its last
 * read, one never read, one whose copy lost entries, no source at all — and
 * each must answer `false`, because a meeting missing from a reading that is
 * not whole may only be missing from the reading.
 */

import { describe, expect, it } from "vitest";
import type { App as ObsidianApp } from "obsidian";
import { App } from "./__mocks__/obsidian";
import { fixture } from "./fixtures";
import { CalendarSources, newCalendarSource } from "../core/calendarSources";
import type { CalendarGateway, CalendarSource } from "../core/calendarSources";
import { DeviceStore } from "../core/settings";

/** A calendar holding `events`, each a list of VEVENT lines, in floating local time. */
function ics(...events: string[][]): string {
	const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Effortless//Test//EN"];
	for (const event of events) lines.push("BEGIN:VEVENT", "DTSTAMP:20260901T120000Z", ...event, "END:VEVENT");
	lines.push("END:VCALENDAR", "");
	return lines.join("\r\n");
}

function event(uid: string, start: string, end: string, summary: string): string[] {
	return [`UID:${uid}`, `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${summary}`];
}

function source(over: Partial<CalendarSource>): CalendarSource {
	return { ...newCalendarSource(), name: "Work", kind: "link", location: "https://cal.test/w.ics", ...over };
}

/** A gateway answering each link from `links`; a link missing from it fails its read. */
function gatewayOf(links: Record<string, string>): CalendarGateway {
	return {
		fetch: async (url) => {
			const body = links[url];
			if (body === undefined) throw new Error(`${url} answered 503`);
			return body;
		},
		readFile: async (path) => {
			throw new Error(`no file at ${path}`);
		},
	};
}

function calendarOver(sources: () => readonly CalendarSource[], links: Record<string, string>): CalendarSources {
	const app = new App();
	return new CalendarSources(sources, new DeviceStore(app as unknown as ObsidianApp), gatewayOf(links));
}

const today = new Date(2026, 9, 2);

const work = ics(event("standup", "20261002T090000", "20261002T091500", "Standup"));
const home = ics(event("moved", "20261005T100000", "20261005T110000", "Moved to Monday"));

describe("presenceBetween", () => {
	it("is whole, with every source's meetings over the span, when every source read cleanly", async () => {
		const sources = [
			source({ location: "https://cal.test/work.ics" }),
			source({ location: "https://cal.test/home.ics" }),
		];
		const calendar = calendarOver(() => sources, { "https://cal.test/work.ics": work, "https://cal.test/home.ics": home });
		await calendar.refresh();

		const presence = calendar.presenceBetween(today, 7, "day");

		expect(presence.whole).toBe(true);
		expect(presence.meetings.map((meeting) => meeting.uid).sort()).toEqual(["moved", "standup"]);
	});

	it("leaves out a meeting that falls after the span", async () => {
		const sources = [source({ location: "https://cal.test/home.ics" })];
		const calendar = calendarOver(() => sources, { "https://cal.test/home.ics": home });
		await calendar.refresh();

		expect(calendar.presenceBetween(today, 3, "day").meetings).toEqual([]);
		expect(calendar.presenceBetween(today, 4, "day").meetings.map((meeting) => meeting.uid)).toEqual(["moved"]);
	});

	it("is not whole when one source's last read failed, even though an earlier copy is still held", async () => {
		const links: Record<string, string> = { "https://cal.test/work.ics": work, "https://cal.test/home.ics": home };
		const sources = [
			source({ location: "https://cal.test/work.ics" }),
			source({ location: "https://cal.test/home.ics" }),
		];
		const calendar = calendarOver(() => sources, links);
		await calendar.refresh();
		delete links["https://cal.test/home.ics"];
		await calendar.refresh();

		const presence = calendar.presenceBetween(today, 7, "day");

		expect(presence.whole).toBe(false);
	});

	it("says per source which read whole and what each holds — a failed source its held copy — so a dead link answers for itself alone", async () => {
		const links: Record<string, string> = { "https://cal.test/work.ics": work, "https://cal.test/home.ics": home };
		const sources = [
			source({ id: "work-id", name: "Work", location: "https://cal.test/work.ics" }),
			source({ id: "home-id", name: "Home", location: "https://cal.test/home.ics" }),
			source({ id: "off-id", name: "Off", location: "https://cal.test/work.ics", showInDay: false }),
		];
		const calendar = calendarOver(() => sources, links);
		await calendar.refresh();
		delete links["https://cal.test/home.ics"];
		await calendar.refresh();

		const presence = calendar.presenceBetween(today, 7, "day");

		expect(presence.whole).toBe(false);
		expect(
			(presence.bySource ?? []).map((one) => ({
				id: one.id,
				name: one.name,
				whole: one.whole,
				uids: one.meetings.map((meeting) => meeting.uid),
			})),
		).toEqual([
			{ id: "work-id", name: "Work", whole: true, uids: ["standup"] },
			{ id: "home-id", name: "Home", whole: false, uids: ["moved"] },
		]);
		// The flattened answer keeps leaving out a source whose last read failed.
		expect(presence.meetings.map((meeting) => meeting.uid)).toEqual(["standup"]);
	});

	it("is not whole when a source has never been read", () => {
		const sources = [source({ location: "https://cal.test/work.ics" })];
		const calendar = calendarOver(() => sources, { "https://cal.test/work.ics": work });

		expect(calendar.presenceBetween(today, 7, "day").whole).toBe(false);
	});

	it("is not whole when a source's copy loses entries", async () => {
		const sources = [source({ location: "https://cal.test/broken.ics" })];
		const calendar = calendarOver(() => sources, { "https://cal.test/broken.ics": fixture("broken-event.ics") });
		await calendar.refresh();

		expect(calendar.presenceBetween(new Date(2026, 8, 8), 1, "day").whole).toBe(false);
	});

	it("is not whole when no source is switched on for the use asked about", async () => {
		const sources = [source({ location: "https://cal.test/work.ics", makeNotes: false })];
		const calendar = calendarOver(() => sources, { "https://cal.test/work.ics": work });
		await calendar.refresh();

		expect(calendar.presenceBetween(today, 7, "notes").whole).toBe(false);
		expect(calendar.presenceBetween(today, 7, "day").whole).toBe(true);
	});

	it("answers a meeting with nobody invited for notes too: it is still on the calendar", async () => {
		const sources = [source({ location: "https://cal.test/work.ics", makeNotes: true })];
		const calendar = calendarOver(() => sources, { "https://cal.test/work.ics": work });
		await calendar.refresh();

		expect(calendar.meetingsOn(today, "notes")).toEqual([]);
		expect(calendar.presenceBetween(today, 1, "notes").meetings.map((meeting) => meeting.uid)).toEqual(["standup"]);
	});
});
