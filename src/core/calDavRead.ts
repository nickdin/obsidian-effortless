/**
 * Reading one calendar of a calendar account.
 *
 * One `REPORT` per calendar per refresh, signed in with HTTP Basic, asking
 * for every meeting that touches a fixed span. The server answers with each
 * meeting's `.ics` text wrapped in XML; this file unwraps it into one calendar
 * and hands back the text, so the reader the links use reads it unchanged and
 * nothing downstream learns where it came from (decision 12).
 *
 * Discovery, the sign-in and the address rules are `calDav.ts`'s.
 */

import { CALDAV, DAV, SIGN_IN_REFUSED, basic } from "./calDav";
import type { DavRequest } from "./calDav";

/**
 * The days an account's calendar is read over, counted from today: seven days
 * back to four hundred days ahead, both days included. Fixed by the plugin
 * and not a setting: a meeting outside it is not
 * seen. Four hundred reaches past the 366 days meeting notes looks ahead
 * before taking a missing meeting for a cancelled one (`PRESENCE_REACH_DAYS`
 * in `meetingNotes/run.ts`) and past the longest days-ahead window, sixty
 * days: shorter, and an account's calendar would never be whole there, so
 * nothing would ever be removed on its word.
 */
export const ACCOUNT_SPAN = { daysBack: 7, daysAhead: 400 } as const;

/**
 * Said when a calendar's own address answers 404: the account no longer holds
 * it. Nothing in any day is removed on its word; the
 * person removes the row.
 */
export const CALENDAR_GONE =
	"This calendar is no longer on the account. Remove this row, or press Fetch calendars to see the calendars the account holds now.";

/** A span of time: `from` included, `to` not. */
export interface Span {
	readonly from: Date;
	readonly to: Date;
}

/** Who a read signs in as. */
export interface SignIn {
	readonly user: string;
	readonly password: string;
}

/**
 * {@link ACCOUNT_SPAN} around `now`'s own day: local midnight seven days back,
 * to local midnight after the four-hundredth day ahead. Counted in calendar
 * days with `setDate`, so a clock change inside the span does not shift either
 * end.
 */
export function accountSpan(now: Date): Span {
	const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ACCOUNT_SPAN.daysBack);
	const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ACCOUNT_SPAN.daysAhead + 1);
	return { from, to };
}

/**
 * The meetings on `calendar` that touch `span`, as one calendar's `.ics` text.
 *
 * Throws a sentence the source's row can show when the read fails: the
 * app-specific password when the server refuses the sign-in, the calendar
 * gone when its address answers 404, the status for any other refusal. A
 * request that could not be sent at all throws its own reason, as a link's
 * does, so an unreachable server reads as an unreachable link.
 */
export async function readAccountCalendar(
	request: DavRequest,
	calendar: string,
	signIn: SignIn,
	span: Span,
): Promise<string> {
	const answer = await request({
		url: calendar,
		method: "REPORT",
		contentType: "application/xml; charset=utf-8",
		headers: { Authorization: basic(signIn.user, signIn.password), Depth: "1" },
		body: calendarQuery(span),
		throw: false,
	});
	if (answer.status === 401 || answer.status === 403) throw new Error(SIGN_IN_REFUSED);
	if (answer.status === 404) throw new Error(CALENDAR_GONE);
	if (answer.status < 200 || answer.status >= 300) throw new Error(`The calendar's server answered ${answer.status}.`);
	const document = new DOMParser().parseFromString(answer.text, "application/xml");
	// A page in place of the answer — a hotel's Wi-Fi sign-in, say — would
	// otherwise hold no calendar-data and read as a calendar with nothing on it.
	if (document.getElementsByTagName("parsererror").length > 0 || document.getElementsByTagNameNS(DAV, "multistatus").length === 0) {
		throw new Error("The calendar's server answered with something that could not be read as a calendar.");
	}
	// A response carrying a status of its own, rather than one per property,
	// answers for the whole request: a 507 there says the server cut the
	// answer short (RFC 4918, 11.5), and the meetings past the cut would read
	// as cancelled.
	for (const response of Array.from(document.getElementsByTagNameNS(DAV, "response"))) {
		const own = Array.from(response.children).find((child) => child.namespaceURI === DAV && child.localName === "status");
		const line = own?.textContent?.trim();
		if (line !== undefined && !/^HTTP\/\S+ 2\d\d\b/.test(line)) {
			throw new Error(`The calendar's server did not send all of this calendar: it answered "${line}".`);
		}
	}
	// Trimmed, because a server may indent the text inside its XML, and a line
	// starting with a space is a folded line to the reader.
	const wrapped = Array.from(document.getElementsByTagNameNS(CALDAV, "calendar-data"), (data) => (data.textContent ?? "").trim());
	if (wrapped.some((ics) => !/^BEGIN:VCALENDAR\s*$/i.test(ics.split(/\r?\n/, 1)[0]))) {
		throw new Error("The calendar's server answered one of this calendar's meetings with something that is not a calendar.");
	}
	return oneCalendar(wrapped);
}

/**
 * The calendars a server answered, one per meeting, joined into one: the
 * first one's own properties, and every component of each. A server keeps
 * each meeting, its repeat rule and its moved occurrences together in one
 * such calendar, and the `VTIMEZONE` it needs beside it, so nothing is
 * separated by the join. None at all is an empty calendar, not a failure:
 * nothing touches the span.
 */
function oneCalendar(calendars: readonly string[]): string {
	const head: string[] = [];
	const body: string[] = [];
	calendars.forEach((ics, index) => {
		// Depth 1 is inside the calendar and outside its components. A folded
		// line (one starting with a space or a tab) belongs to the line above it.
		let depth = 0;
		let keep = false;
		for (const line of ics.split(/\r?\n/)) {
			if (line === "") continue;
			if (line.startsWith(" ") || line.startsWith("\t")) {
				if (keep) (depth === 1 ? head : body).push(line);
				continue;
			}
			const upper = line.toUpperCase();
			if (upper.startsWith("BEGIN:")) depth++;
			if (upper.startsWith("END:")) depth--;
			const ofCalendar = upper === "BEGIN:VCALENDAR" || upper === "END:VCALENDAR";
			if (ofCalendar) {
				keep = false;
			} else if (depth === 1 && !upper.startsWith("END:")) {
				keep = index === 0;
				if (keep) head.push(line);
			} else {
				keep = true;
				body.push(line);
			}
		}
	});
	if (head.length === 0) head.push("VERSION:2.0", "PRODID:-//Effortless//Calendar account//EN");
	return ["BEGIN:VCALENDAR", ...head, ...body, "END:VCALENDAR", ""].join("\r\n");
}

/**
 * The `calendar-query` body: every event touching `span`, each returned whole.
 * Not `<c:expand>`: a repeating meeting comes back as its rule, like a link's
 * does, and the reader expands it.
 */
function calendarQuery(span: Span): string {
	return (
		`<?xml version="1.0" encoding="utf-8"?>` +
		`<c:calendar-query xmlns:d="${DAV}" xmlns:c="${CALDAV}">` +
		`<d:prop><c:calendar-data/></d:prop>` +
		`<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
		`<c:time-range start="${utc(span.from)}" end="${utc(span.to)}"/>` +
		`</c:comp-filter></c:comp-filter></c:filter>` +
		`</c:calendar-query>`
	);
}

/** `date` as CalDAV writes a time: UTC, `YYYYMMDDTHHMMSSZ`. */
function utc(date: Date): string {
	return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
