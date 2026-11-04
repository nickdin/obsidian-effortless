import { describe, expect, it } from "vitest";
import { discoverCalendars } from "../core/calDav";
import type { DavRequest } from "../core/calDav";

type Sent = { url: string; method?: string; headers?: Record<string, string>; body?: string };

/**
 * A CalDAV server shaped like iCloud's, answering the three discovery steps: the principal at the address typed, the calendar home on another
 * host, and the calendars under it. Every request is kept, so a test can say
 * what was sent and how many times.
 */
function icloudLike(options: { status?: number; calendars?: Array<[string, string]> } = {}): {
	request: DavRequest;
	sent: Sent[];
} {
	const sent: Sent[] = [];
	const calendars = options.calendars ?? [
		["work/", "Work"],
		["family/", "Family"],
	];
	const request: DavRequest = async (asked) => {
		sent.push({ url: asked.url, method: asked.method, headers: asked.headers, body: asked.body as string });
		if (options.status !== undefined) return { status: options.status, text: "" };
		if (asked.url === "https://caldav.example.test/") {
			return multistatus(`<d:response><d:href>/</d:href><d:propstat><d:prop>
				<d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal>
				</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
		}
		if (asked.url === "https://caldav.example.test/123/principal/") {
			return multistatus(`<d:response><d:href>/123/principal/</d:href><d:propstat><d:prop>
				<c:calendar-home-set><d:href>https://p42-caldav.example.test:443/123/calendars/</d:href></c:calendar-home-set>
				</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
		}
		if (asked.url === "https://p42-caldav.example.test/123/calendars/") {
			const listed = calendars
				.map(
					([path, name]) => `<d:response><d:href>/123/calendars/${path}</d:href><d:propstat><d:prop>
						<d:displayname>${name}</d:displayname>
						<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
						<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>
						</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
				)
				.join("");
			return multistatus(`<d:response><d:href>/123/calendars/</d:href><d:propstat><d:prop>
					<d:displayname>Home</d:displayname><d:resourcetype><d:collection/></d:resourcetype>
					</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
				${listed}
				<d:response><d:href>/123/calendars/inbox/</d:href><d:propstat><d:prop>
					<d:displayname>Inbox</d:displayname><d:resourcetype><d:collection/><c:schedule-inbox/></d:resourcetype>
					</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
				<d:response><d:href>/123/calendars/tasks/</d:href><d:propstat><d:prop>
					<d:displayname>Reminders</d:displayname>
					<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
					<c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>
					</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
		}
		return { status: 404, text: "" };
	};
	return { request, sent };
}

function multistatus(responses: string): { status: number; text: string } {
	return {
		status: 207,
		text: `<?xml version="1.0" encoding="UTF-8"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${responses}</d:multistatus>`,
	};
}

const account = { address: "https://caldav.example.test", user: "someone@example.test" };
const FAKE_APP_PW = "fake-abcd-efgh-ijkl";

describe("finding an account's calendars", () => {
	it("follows the principal to the calendar home and lists each calendar by the server's name and its address", async () => {
		const { request } = icloudLike();
		const found = await discoverCalendars(request, account, FAKE_APP_PW);
		expect(found).toEqual({
			calendars: [
				{ name: "Work", address: "https://p42-caldav.example.test/123/calendars/work/" },
				{ name: "Family", address: "https://p42-caldav.example.test/123/calendars/family/" },
			],
		});
	});

	it("asks the three steps in order, each a PROPFIND signed in with the user name and app-specific password", async () => {
		const { request, sent } = icloudLike();
		await discoverCalendars(request, account, FAKE_APP_PW);
		expect(sent.map((one) => [one.method, one.url, one.headers?.Depth])).toEqual([
			["PROPFIND", "https://caldav.example.test/", "0"],
			["PROPFIND", "https://caldav.example.test/123/principal/", "0"],
			["PROPFIND", "https://p42-caldav.example.test/123/calendars/", "1"],
		]);
		// Worked outside the code: base64 of "someone@example.test:fake-abcd-efgh-ijkl".
		const signedIn = "Basic c29tZW9uZUBleGFtcGxlLnRlc3Q6ZmFrZS1hYmNkLWVmZ2gtaWprbA==";
		expect(sent.every((one) => one.headers?.Authorization === signedIn)).toBe(true);
		expect(sent[0].body).toContain("current-user-principal");
		expect(sent[1].body).toContain("calendar-home-set");
	});

	it("names the app-specific password when the server refuses the sign-in", async () => {
		const { request } = icloudLike({ status: 401 });
		const found = await discoverCalendars(request, account, FAKE_APP_PW);
		expect("refusal" in found && found.refusal).toMatch(/app-specific password/);
		expect("refusal" in found && found.refusal).not.toContain("caldav.example.test");
	});

	it("names the address when the server cannot be reached, and the two refusals read differently", async () => {
		const unreachable: DavRequest = () => Promise.reject(new Error("net::ERR_NAME_NOT_RESOLVED"));
		const found = await discoverCalendars(unreachable, account, FAKE_APP_PW);
		const refused = await discoverCalendars(icloudLike({ status: 401 }).request, account, FAKE_APP_PW);
		expect("refusal" in found && found.refusal).toContain("https://caldav.example.test");
		expect("refusal" in found && found.refusal).not.toMatch(/app-specific password/);
		expect(found).not.toEqual(refused);
	});

	it("names the address when it answers but is not a calendar server", async () => {
		const found = await discoverCalendars(icloudLike({ status: 404 }).request, account, FAKE_APP_PW);
		expect("refusal" in found && found.refusal).toContain("https://caldav.example.test");
	});

	it("sends nothing to an address that would carry the app-specific password in the clear", async () => {
		const { request, sent } = icloudLike();
		const found = await discoverCalendars(request, { ...account, address: "http://caldav.example.test" }, FAKE_APP_PW);
		expect("refusal" in found && found.refusal).toMatch(/https:\/\//);
		expect(sent).toHaveLength(0);
	});

	it("lets a server on this machine's own loopback be reached over http, since nothing leaves the machine", async () => {
		const sent: string[] = [];
		const local: DavRequest = async (asked) => {
			sent.push(asked.url);
			return { status: 401, text: "" };
		};
		await discoverCalendars(local, { ...account, address: "http://127.0.0.1:5232" }, FAKE_APP_PW);
		await discoverCalendars(local, { ...account, address: "http://localhost:5232/" }, FAKE_APP_PW);
		expect(sent).toEqual(["http://127.0.0.1:5232/", "http://localhost:5232/"]);
	});

	it("names a calendar the server gave no name by its address, even when that address is not valid percent-encoding", async () => {
		const request: DavRequest = async ({ url }) => {
			if (url === "https://caldav.example.test/") {
				return multistatus(`<d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/p/</d:href></d:current-user-principal></d:prop></d:propstat></d:response>`);
			}
			if (url === "https://caldav.example.test/p/") {
				return multistatus(`<d:response><d:href>/p/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/home/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response>`);
			}
			return multistatus(`<d:response><d:href>/home/100%/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response>`);
		};
		const found = await discoverCalendars(request, account, FAKE_APP_PW);
		expect(found).toEqual({ calendars: [{ name: "100%", address: "https://caldav.example.test/home/100%/" }] });
	});

	it("answers an address it cannot follow with a refusal naming the address, never by rejecting", async () => {
		const request: DavRequest = async () =>
			multistatus(`<d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>http://[not-an-address/</d:href></d:current-user-principal></d:prop></d:propstat></d:response>`);
		const found = await discoverCalendars(request, account, FAKE_APP_PW);
		expect("refusal" in found && found.refusal).toContain("https://caldav.example.test");
	});

	it("finds no calendar on an account that holds none, rather than refusing", async () => {
		const found = await discoverCalendars(icloudLike({ calendars: [] }).request, account, FAKE_APP_PW);
		expect(found).toEqual({ calendars: [] });
	});
});
