import { describe, expect, it } from "vitest";
import { accountSpan, readAccountCalendar } from "../core/calDavRead";
import type { DavRequest } from "../core/calDav";
import { readSpanLosing } from "../core/icsReader";

/*
 * Reading one calendar of a calendar account (#1214, spec #1212 decisions 4
 * and 12): one REPORT over a fixed span, signed in with Basic, and the `.ics`
 * inside each `calendar-data` unwrapped into one calendar the links' reader
 * reads unchanged.
 */

type Sent = { url: string; method?: string; headers?: Record<string, string>; body?: string };

const CALENDAR = "https://p42-caldav.example.test/123/calendars/work/";
/** 10:30 on 21 October 2026, local time; the suite runs in America/New_York. */
const NOW = new Date(2026, 9, 21, 10, 30);
const SIGN_IN = { user: "someone@example.test", password: "abcd-efgh" };

/** One event as a calendar object resource holds it, its own `VCALENDAR` around it. */
function resource(uid: string, day: string, summary: string): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		`PRODID:-//Server//${uid}//EN`,
		"BEGIN:VEVENT",
		`UID:${uid}`,
		"DTSTAMP:20261001T120000Z",
		`DTSTART:${day}T130000`,
		`DTEND:${day}T140000`,
		`SUMMARY:${summary}`,
		"END:VEVENT",
		"END:VCALENDAR",
		"",
	].join("\r\n");
}

/** A REPORT answer holding each of `resources` as one `calendar-data`, escaped the way an XML server writes it. */
function multistatus(resources: readonly string[]): string {
	const escaped = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\r/g, "&#13;");
	const responses = resources
		.map(
			(ics, index) => `<d:response><d:href>/123/calendars/work/${index}.ics</d:href><d:propstat><d:prop>
				<c:calendar-data>${escaped(ics)}</c:calendar-data>
				</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
		)
		.join("");
	return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${responses}</d:multistatus>`;
}

/** A server answering every request with `answer`, or never reached when `answer` says what the request throws. */
function server(answer: { status: number; text: string } | { throws: string }): { request: DavRequest; sent: Sent[] } {
	const sent: Sent[] = [];
	const request: DavRequest = async (asked) => {
		sent.push({ url: asked.url, method: asked.method, headers: asked.headers, body: asked.body as string });
		if ("throws" in answer) throw new Error(answer.throws);
		return answer;
	};
	return { request, sent };
}

describe("reading one calendar of a calendar account", () => {
	it("sends one REPORT to the calendar, signed in with Basic, over the span's two bounds", async () => {
		const { request, sent } = server({ status: 207, text: multistatus([]) });
		await readAccountCalendar(request, CALENDAR, SIGN_IN, accountSpan(NOW));
		expect(sent).toHaveLength(1);
		expect(sent[0].url).toBe(CALENDAR);
		expect(sent[0].method).toBe("REPORT");
		expect(sent[0].headers?.Depth).toBe("1");
		// base64 of "someone@example.test:abcd-efgh", worked out outside the code.
		expect(sent[0].headers?.Authorization).toBe("Basic c29tZW9uZUBleGFtcGxlLnRlc3Q6YWJjZC1lZmdo");
		// Local midnight seven days back (14 October, EDT) and local midnight
		// after the four-hundredth day ahead (26 November 2027, EST): worked out
		// by hand, across the clock change.
		expect(sent[0].body).toContain('<c:time-range start="20261014T040000Z" end="20271126T050000Z"/>');
		expect(sent[0].body).toContain('<c:comp-filter name="VEVENT">');
	});

	it("unwraps every calendar-data into one calendar the links' reader reads every meeting from", async () => {
		const { request } = server({
			status: 207,
			text: multistatus([resource("a@test", "20261022", "Planering"), resource("b@test", "20261023", "Retro")]),
		});
		const ics = await readAccountCalendar(request, CALENDAR, SIGN_IN, accountSpan(NOW));
		const read = readSpanLosing(ics, new Date(2026, 9, 22), 2);
		expect(read.loss).toBeNull();
		expect(read.meetings.map((meeting) => meeting.summary)).toEqual(["Planering", "Retro"]);
		expect(ics.match(/^BEGIN:VCALENDAR/gm)).toHaveLength(1);
	});

	it("answers an empty calendar, not a failure, when nothing touches the span", async () => {
		const { request } = server({ status: 207, text: multistatus([]) });
		const ics = await readAccountCalendar(request, CALENDAR, SIGN_IN, accountSpan(NOW));
		expect(readSpanLosing(ics, NOW, 1)).toEqual({ meetings: [], loss: null });
	});

	it("names the app-specific password when the server refuses the sign-in", async () => {
		const { request } = server({ status: 401, text: "" });
		await expect(readAccountCalendar(request, CALENDAR, SIGN_IN, accountSpan(NOW))).rejects.toThrow(
			/app-specific password/,
		);
	});

	it("says the calendar is no longer on the account when its address answers 404", async () => {
		const { request } = server({ status: 404, text: "" });
		const read = readAccountCalendar(request, CALENDAR, SIGN_IN, accountSpan(NOW));
		await expect(read).rejects.toThrow(/no longer on the account/);
		await expect(read).rejects.not.toThrow(/password/);
	});

	it("says any other refusal by its status, as a link does", async () => {
		const { request } = server({ status: 503, text: "" });
		await expect(readAccountCalendar(request, CALENDAR, SIGN_IN, accountSpan(NOW))).rejects.toThrow(/answered 503/);
	});

	it("keeps an unreachable server's own reason, as a link does", async () => {
		const { request } = server({ throws: "net::ERR_NAME_NOT_RESOLVED" });
		await expect(readAccountCalendar(request, CALENDAR, SIGN_IN, accountSpan(NOW))).rejects.toThrow(
			"net::ERR_NAME_NOT_RESOLVED",
		);
	});

	it("reads every calendar-data the server indented inside its XML", async () => {
		const indented = multistatus([
			resource("a@test", "20261022", "Planering"),
			resource("b@test", "20261023", "Retro"),
		]).replace(/<c:calendar-data>/g, "<c:calendar-data>\n        ");
		const { request } = server({ status: 207, text: indented });
		const ics = await readAccountCalendar(request, CALENDAR, SIGN_IN, accountSpan(NOW));
		const read = readSpanLosing(ics, new Date(2026, 9, 22), 2);
		expect(read.loss).toBeNull();
		expect(read.meetings.map((meeting) => meeting.summary)).toEqual(["Planering", "Retro"]);
	});

	it("refuses a calendar-data that is not a calendar rather than dropping it", async () => {
		const { request } = server({
			status: 207,
			text: multistatus([resource("a@test", "20261022", "Planering"), "<html>Not found</html>"]),
		});
		await expect(readAccountCalendar(request, CALENDAR, SIGN_IN, accountSpan(NOW))).rejects.toThrow(/not a calendar/);
	});

	it("refuses an answer the server cut short (a 507 inside the multistatus), rather than reading it as the whole calendar", async () => {
		const cut = multistatus([resource("a@test", "20261022", "Planering")]).replace(
			"</d:multistatus>",
			"<d:response><d:href>/123/calendars/work/</d:href><d:status>HTTP/1.1 507 Insufficient Storage</d:status></d:response></d:multistatus>",
		);
		const { request } = server({ status: 207, text: cut });
		await expect(readAccountCalendar(request, CALENDAR, SIGN_IN, accountSpan(NOW))).rejects.toThrow(/507/);
	});

	it("moves both bounds with today, and with nothing else", async () => {
		const { request, sent } = server({ status: 207, text: multistatus([]) });
		await readAccountCalendar(request, CALENDAR, SIGN_IN, accountSpan(new Date(2026, 9, 22, 8, 0)));
		// One day on from the first test's bounds, worked out by hand.
		expect(sent[0].body).toContain('<c:time-range start="20261015T040000Z" end="20271127T050000Z"/>');
	});

	it("refuses an answer that is not XML rather than reading it as an empty calendar", async () => {
		const { request } = server({ status: 207, text: "<html><body>Sign in to the Wi-Fi" });
		await expect(readAccountCalendar(request, CALENDAR, SIGN_IN, accountSpan(NOW))).rejects.toThrow(/could not be read/);
	});
});
