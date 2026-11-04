import { describe, expect, it } from "vitest";
// The stub is imported by path rather than as "obsidian": `tsc` checks this
// file against the real API, and only vitest redirects that name.
import type { App as ObsidianApp } from "obsidian";
import { App } from "./__mocks__/obsidian";
import { CalendarSources, sourceProblem } from "../core/calendarSources";
import type { CalendarGateway, CalendarSource } from "../core/calendarSources";
import { NO_PASSWORD_HERE, accountReader } from "../core/calendarAccounts";
import { ACCOUNT_SPAN } from "../core/calDavRead";
import { MAX_WINDOW_DAYS } from "../features/daysAhead/settingsPanel";
import { PRESENCE_REACH_DAYS } from "../features/meetingNotes/run";
import type { CalendarAccount } from "../core/calendarAccounts";
import type { DavRequest } from "../core/calDav";
import { DeviceStore } from "../core/settings";

/*
 * An account row read through the real calendar and the real account reader,
 * with only the server played (#1214, spec #1212 decisions 4, 5, 10 and 12).
 * Before #1214 the row was a source that had not been read yet.
 */

/** 10:30 on 21 October 2026, local time; the suite runs in America/New_York. */
const NOW = new Date(2026, 9, 21, 10, 30);
const TOMORROW = new Date(2026, 9, 22);
const FAKE_PASSWORD = "fake-abcd-efgh";

const account: CalendarAccount = { id: "acc-1", address: "https://caldav.example.test", user: "someone@example.test" };

const work: CalendarSource = {
	id: "row-work",
	name: "Work",
	kind: "account",
	account: "acc-1",
	location: "https://p42-caldav.example.test/123/calendars/work/",
	showInDay: true,
	makeNotes: true,
};

/** A gateway for links and files, which an account row never asks. */
const noLinks: CalendarGateway = {
	fetch: (url) => Promise.reject(new Error(`no link expected: ${url}`)),
	readFile: (path) => Promise.reject(new Error(`no file expected: ${path}`)),
};

/** A meeting with one person invited, on `day` (a `YYYYMMDD`), as one calendar object resource. */
function meeting(uid: string, day: string, summary: string): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Server//EN",
		"BEGIN:VEVENT",
		`UID:${uid}`,
		"DTSTAMP:20261001T120000Z",
		`DTSTART:${day}T130000`,
		`DTEND:${day}T140000`,
		`SUMMARY:${summary}`,
		"ATTENDEE;CN=Alva Almgren:mailto:alva.almgren@invented.test",
		"END:VEVENT",
		"END:VCALENDAR",
		"",
	].join("\r\n");
}

/**
 * A server holding the calendar at `work.location`, answering every REPORT
 * with whatever `holds` says at the time, or with `status` when that is set.
 * It does not filter by the span it is asked for: a server answers a
 * repeating meeting whole, so the plugin may not lean on the server's filter.
 */
class Server {
	holds: string[] = [meeting("planering@test", "20261022", "Planering")];
	status = 207;
	readonly sent: Array<{ method?: string; headers?: Record<string, string>; body?: string }> = [];
	readonly request: DavRequest = async (asked) => {
		this.sent.push({ method: asked.method, headers: asked.headers, body: asked.body as string });
		if (this.status !== 207) return { status: this.status, text: "" };
		if (asked.url !== work.location) return { status: 404, text: "" };
		const responses = this.holds
			.map(
				(ics, index) =>
					`<d:response><d:href>/work/${index}.ics</d:href><d:propstat><d:prop><c:calendar-data>${ics.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
			)
			.join("");
		return {
			status: 207,
			text: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${responses}</d:multistatus>`,
		};
	};
}

function calendarOver(server: Server, options: { withPassword?: boolean; accounts?: CalendarAccount[] } = {}) {
	const device = new DeviceStore(new App() as unknown as ObsidianApp);
	if (options.withPassword === true) device.keepPassword("acc-1", FAKE_PASSWORD);
	const accounts = options.accounts ?? [account];
	/** What time the calendar is told it is; a test moves it on between reads. */
	const clock = { now: NOW.getTime() };
	const calendar = new CalendarSources(
		() => [work],
		device,
		noLinks,
		() => clock.now,
		undefined,
		accountReader(() => accounts, server.request),
	);
	return { calendar, device, clock };
}

describe("reading a calendar account's row", () => {
	it("reads the calendar with this device's password and answers its meeting in the day and ahead", async () => {
		const server = new Server();
		const { calendar, device } = calendarOver(server, { withPassword: true });
		await calendar.refresh();

		expect(server.sent).toHaveLength(1);
		expect(server.sent[0].method).toBe("REPORT");
		// base64 of "someone@example.test:fake-abcd-efgh", worked out outside the code.
		expect(server.sent[0].headers?.Authorization).toBe("Basic c29tZW9uZUBleGFtcGxlLnRlc3Q6ZmFrZS1hYmNkLWVmZ2g=");
		// 14 October 2026 and 26 November 2027 at local midnight, worked out by hand from NOW.
		expect(server.sent[0].body).toContain('start="20261014T040000Z" end="20271126T050000Z"');
		expect(device.read().calendarReads["row-work"]).toMatchObject({ readAt: NOW.getTime(), failure: null });
		expect(calendar.meetingsOn(TOMORROW, "day").map((one) => one.summary)).toEqual(["Planering"]);
		expect(calendar.meetingsOn(TOMORROW, "notes").map((one) => one.summary)).toEqual(["Planering"]);
		const ahead = calendar.presenceBetween(NOW, 7, "day");
		expect(ahead.whole).toBe(true);
		expect(ahead.meetings.map((one) => one.summary)).toEqual(["Planering"]);
		expect(calendar.presenceBetween(NOW, PRESENCE_REACH_DAYS, "notes").whole).toBe(true);
	});

	// #1216: the move and the reader together, as a device updated from 0.0.1 meets them.
	it("reads the calendar with a password the per-device store held before the keychain, once it has moved", async () => {
		const server = new Server();
		const { calendar, device } = calendarOver(server);
		device.save({ accountPasswords: { "acc-1": FAKE_PASSWORD } });
		expect(device.movePasswordsToKeychain()).toEqual([]);
		await calendar.refresh();

		expect(server.sent).toHaveLength(1);
		// base64 of "someone@example.test:fake-abcd-efgh", worked out outside the code.
		expect(server.sent[0].headers?.Authorization).toBe("Basic c29tZW9uZUBleGFtcGxlLnRlc3Q6ZmFrZS1hYmNkLWVmZ2g=");
		expect(device.read().calendarReads["row-work"]).toMatchObject({ readAt: NOW.getTime(), failure: null });
		expect(calendar.meetingsOn(TOMORROW, "day").map((one) => one.summary)).toEqual(["Planering"]);
	});

	it("reaches past how far meeting notes and the days ahead ever ask, so an account's calendar can be whole for both", () => {
		// Shorter, and the calendar would never be whole there, so nothing would
		// ever be removed on its word (GLOSSARY.md, Calendar account).
		expect(ACCOUNT_SPAN.daysAhead).toBeGreaterThanOrEqual(PRESENCE_REACH_DAYS);
		expect(ACCOUNT_SPAN.daysAhead).toBeGreaterThanOrEqual(MAX_WINDOW_DAYS);
	});

	it("says this device has no password for the account, and requests nothing", async () => {
		const server = new Server();
		const { calendar, device } = calendarOver(server);
		await calendar.refresh();
		expect(device.read().calendarReads["row-work"]?.failure).toBe(NO_PASSWORD_HERE);
		expect(server.sent).toHaveLength(0);
	});

	it("says the account is gone from the settings, and requests nothing", async () => {
		const server = new Server();
		const { calendar, device } = calendarOver(server, { withPassword: true, accounts: [] });
		await calendar.refresh();
		expect(device.read().calendarReads["row-work"]?.failure).toMatch(/no longer in the settings/);
		expect(server.sent).toHaveLength(0);
	});

	it("is not whole in what the calendar answers before a read, so nothing is removed on its word", async () => {
		const server = new Server();
		const { calendar } = calendarOver(server);
		await calendar.refresh();
		expect(calendar.presenceBetween(NOW, 7, "day").whole).toBe(false);
	});

	it("answers no meeting one day outside either end of the span, whatever the server sent", async () => {
		const server = new Server();
		server.holds = [
			meeting("before@test", "20261013", "Day before the span"),
			meeting("first@test", "20261014", "First day"),
			meeting("last@test", "20271125", "Last day"),
			meeting("after@test", "20271126", "Day after the span"),
		];
		const { calendar } = calendarOver(server, { withPassword: true });
		await calendar.refresh();

		expect(calendar.meetingsOn(new Date(2026, 9, 13), "day")).toEqual([]);
		expect(calendar.meetingsOn(new Date(2026, 9, 14), "day").map((one) => one.summary)).toEqual(["First day"]);
		expect(calendar.meetingsOn(new Date(2027, 10, 25), "day").map((one) => one.summary)).toEqual(["Last day"]);
		expect(calendar.meetingsOn(new Date(2027, 10, 26), "day")).toEqual([]);
		// Days reaching past the span are not known, so not whole: nothing may
		// be removed from a day the calendar was not asked about.
		const across = calendar.presenceBetween(new Date(2027, 10, 25), 2, "day");
		expect(across.meetings.map((one) => one.summary)).toEqual(["Last day"]);
		expect(across.whole).toBe(false);
		expect(calendar.presenceBetween(new Date(2026, 9, 13), 1, "day").meetings).toEqual([]);
	});

	it("names the password when the server refuses it, keeps the last meetings, and is not whole", async () => {
		const server = new Server();
		const { calendar, device, clock } = calendarOver(server, { withPassword: true });
		await calendar.refresh();

		server.status = 401;
		clock.now = NOW.getTime() + 15 * 60 * 1000;
		await calendar.refresh();

		// Still the time of the good read, not the refused one.
		expect(device.read().calendarReads["row-work"]).toMatchObject({ readAt: NOW.getTime() });
		expect(device.read().calendarReads["row-work"]?.failure).toMatch(/app-specific password/);
		expect(calendar.meetingsOn(TOMORROW, "day").map((one) => one.summary)).toEqual(["Planering"]);
		expect(calendar.presenceBetween(NOW, 7, "day").whole).toBe(false);
	});

	it("says the calendar is no longer on the account when it answers 404, keeps the last meetings, and is not whole", async () => {
		const server = new Server();
		const { calendar, device } = calendarOver(server, { withPassword: true });
		await calendar.refresh();

		server.status = 404;
		await calendar.refresh();

		expect(device.read().calendarReads["row-work"]?.failure).toMatch(/no longer on the account/);
		expect(calendar.meetingsOn(TOMORROW, "day").map((one) => one.summary)).toEqual(["Planering"]);
		expect(calendar.presenceBetween(NOW, 7, "day").whole).toBe(false);
	});

	it("refuses an account row whose calendar address would carry the password in the clear", () => {
		expect(sourceProblem({ ...work, location: "http://caldav.example.test/work/" })).toMatch(/https:\/\//);
		expect(sourceProblem(work)).toBeNull();
	});
});
