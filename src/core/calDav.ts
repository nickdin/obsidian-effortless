/**
 * Signing in to a CalDAV server and finding the calendars an account holds.
 *
 * Discovery is three `PROPFIND` requests, each signed in with HTTP Basic: the
 * address the person typed answers who they are (`current-user-principal`),
 * that principal answers where their calendars live (`calendar-home-set`), and
 * the home, asked one level deep, lists them. iCloud puts the home on another
 * host than the address typed, so every address a server answers with is
 * resolved against the address that answered it.
 *
 * Reading a calendar's meetings is `calDavRead.ts`.
 *
 * **Obsidian's `requestUrl` carries every request**, as it does a link's: it
 * takes any method, headers and a body (`node_modules/obsidian/obsidian.d.ts`,
 * `RequestUrlParam`), and it has no CORS to fall foul of.
 */

import { requestUrl } from "obsidian";
import type { RequestUrlParam } from "obsidian";
import { reasonOf } from "./reason";

/** Only the shape of `requestUrl` this file uses, so a test can play the server. */
export type DavRequest = (
	request: RequestUrlParam & { throw: false },
) => Promise<{ status: number; text: string }>;

/** The two answers of an account this file needs: where to sign in, and as whom. */
export interface DavAccount {
	readonly address: string;
	readonly user: string;
}

/** One calendar an account holds, as the server names it. */
export interface FoundCalendar {
	readonly name: string;
	/** The calendar's own address, absolute, as a source row stores it. */
	readonly address: string;
}

/**
 * What discovery came to: the calendars, or one sentence saying why there are
 * none to show. An account holding no calendar is the first, with an empty list.
 */
export type Discovery = { readonly calendars: readonly FoundCalendar[] } | { readonly refusal: string };

/** The two XML namespaces a CalDAV answer is written in; `calDavRead.ts` reads them too. */
export const DAV = "DAV:";
export const CALDAV = "urn:ietf:params:xml:ns:caldav";

/**
 * Said when the server answers 401 or 403. It names the app-specific password
 * and not the address: the address was reached, and sending the person to
 * check it would be sending them to the wrong box.
 */
export const SIGN_IN_REFUSED =
	"The server refused this user name and app-specific password. Check both, or make a new app-specific password at your provider.";

/**
 * Whether an address may carry an app-specific password: `https://`, or
 * `http://` to this machine's own loopback. Traffic to loopback never leaves
 * the machine, so nothing is sent in the clear across any network; it is also
 * how a calendar server run on the same computer, the test vault's included,
 * is reached without a certificate.
 */
export function sendsSafely(address: string): boolean {
	let url: URL;
	try {
		url = new URL(address.trim());
	} catch {
		return false;
	}
	if (url.protocol === "https:") return true;
	return url.protocol === "http:" && LOOPBACK.has(url.hostname);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Why discovery may not even be tried at `address`, or null when it may.
 * Checked before anything is sent, so the app-specific password never leaves
 * for an address that would carry it in the clear.
 */
export function serverAddressProblem(address: string): string | null {
	const typed = address.trim();
	if (typed === "") return "This account has no server address yet.";
	if (!isUrl(typed)) return `"${typed}" is not a web address. Check the server address.`;
	return sendsSafely(typed)
		? null
		: "A calendar account's server address has to start with https://, so the app-specific password is not sent in the clear. Only a server on this computer may use http://.";
}

/**
 * Signs in to `account` with `password` and lists the calendars it holds that
 * carry meetings. A calendar that says it holds only reminders or to-dos is
 * left out, and so are the server's own inbox and outbox, which are
 * collections but not calendars.
 *
 * Never rejects: every failure is answered as a refusal, and a refusal names
 * the app-specific password when the server refused the sign-in and the
 * address when it could not be reached or is not a calendar server.
 */
export async function discoverCalendars(
	request: DavRequest,
	account: DavAccount,
	password: string,
): Promise<Discovery> {
	const problem = serverAddressProblem(account.address);
	if (problem !== null) return { refusal: problem };
	const address = account.address.trim();
	const ask = (url: string, depth: "0" | "1", prop: string): Promise<Element[]> =>
		propfind(request, { address, url, depth, prop, signedIn: basic(account.user, password) });

	try {
		const start = new URL(address).href;
		const principal = hrefUnder(await ask(start, "0", "<d:current-user-principal/>"), DAV, "current-user-principal", start);
		if (principal === null) throw new Refused(notCalDav(address));
		const home = hrefUnder(await ask(principal, "0", "<c:calendar-home-set/>"), CALDAV, "calendar-home-set", principal);
		if (home === null) throw new Refused(notCalDav(address));
		const listed = await ask(home, "1", "<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/>");
		return { calendars: calendarsIn(listed, home) };
	} catch (error) {
		if (error instanceof Refused) return { refusal: error.message };
		// Anything else is an answer this file could not follow — an address
		// the server handed back that is not one. Said rather than thrown:
		// the screen waiting on this would otherwise say "Signing in…" for
		// ever, with the failure only in the developer console.
		return { refusal: `${address} answered with something this plugin could not read: ${reasonOf(error)} Check the server address.` };
	}
}

/** A failure discovery says rather than throws, carried out of the steps to the one `catch`. */
class Refused extends Error {}

/** Said when an address answers but is not a calendar server. */
function notCalDav(address: string, status?: number): string {
	const answered = status === undefined ? "" : ` answered ${status} and`;
	return `${address}${answered} does not look like a calendar server. Check the server address.`;
}

/**
 * One `PROPFIND`, answered as the `<response>` elements of its multistatus.
 * Turns every way it can fail into a {@link Refused} carrying the sentence.
 */
async function propfind(
	request: DavRequest,
	asked: { address: string; url: string; depth: "0" | "1"; prop: string; signedIn: string },
): Promise<Element[]> {
	let answer: { status: number; text: string };
	try {
		answer = await request({
			url: asked.url,
			method: "PROPFIND",
			contentType: "application/xml; charset=utf-8",
			headers: { Authorization: asked.signedIn, Depth: asked.depth },
			body: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="${DAV}" xmlns:c="${CALDAV}"><d:prop>${asked.prop}</d:prop></d:propfind>`,
			throw: false,
		});
	} catch (error) {
		throw new Refused(`Could not reach ${asked.address}: ${reasonOf(error)} Check the server address.`);
	}
	if (answer.status === 401 || answer.status === 403) throw new Refused(SIGN_IN_REFUSED);
	if (answer.status < 200 || answer.status >= 300) throw new Refused(notCalDav(asked.address, answer.status));
	const document = new DOMParser().parseFromString(answer.text, "application/xml");
	if (document.getElementsByTagName("parsererror").length > 0) throw new Refused(notCalDav(asked.address));
	return Array.from(document.getElementsByTagNameNS(DAV, "response"));
}

/** The address held in the first `<href>` inside the first `<ns:name>` among `responses`, resolved against `base`. */
function hrefUnder(responses: readonly Element[], ns: string, name: string, base: string): string | null {
	for (const response of responses) {
		const holder = response.getElementsByTagNameNS(ns, name)[0];
		const href = holder?.getElementsByTagNameNS(DAV, "href")[0]?.textContent?.trim();
		if (href) return resolved(href, base);
	}
	return null;
}

/** Each response under the home that is a calendar holding meetings, in the server's order. */
function calendarsIn(responses: readonly Element[], home: string): FoundCalendar[] {
	const found: FoundCalendar[] = [];
	for (const response of responses) {
		const own = Array.from(response.children).find(
			(child) => child.namespaceURI === DAV && child.localName === "href",
		);
		const href = own?.textContent?.trim();
		if (!href) continue;
		const type = response.getElementsByTagNameNS(DAV, "resourcetype")[0];
		if (type === undefined || type.getElementsByTagNameNS(CALDAV, "calendar").length === 0) continue;
		if (!holdsMeetings(response)) continue;
		const address = resolved(href, home);
		const name = response.getElementsByTagNameNS(DAV, "displayname")[0]?.textContent?.trim();
		found.push({ name: name || lastSegment(address), address });
	}
	return found;
}

/**
 * Whether a calendar says it can hold meetings. One that names the kinds it
 * holds must name `VEVENT`; one that names none is taken to hold anything,
 * which is what the CalDAV standard says an absent list means.
 */
function holdsMeetings(response: Element): boolean {
	const set = response.getElementsByTagNameNS(CALDAV, "supported-calendar-component-set")[0];
	if (set === undefined) return true;
	const kinds = Array.from(set.getElementsByTagNameNS(CALDAV, "comp")).map((comp) => comp.getAttribute("name"));
	return kinds.length === 0 || kinds.includes("VEVENT");
}

function resolved(href: string, base: string): string {
	return new URL(href, base).href;
}

/**
 * A calendar the server gave no name, called by the last part of its address,
 * decoded where it is valid percent-encoding and shown as written where not.
 */
function lastSegment(address: string): string {
	const parts = new URL(address).pathname.split("/").filter((part) => part !== "");
	const last = parts[parts.length - 1] ?? address;
	try {
		return decodeURIComponent(last);
	} catch {
		return last;
	}
}

function isUrl(text: string): boolean {
	try {
		new URL(text);
		return true;
	} catch {
		return false;
	}
}

/** The HTTP Basic sign-in, the user name and password joined by a colon and base64-encoded as UTF-8. */
export function basic(user: string, password: string): string {
	const bytes = new TextEncoder().encode(`${user}:${password}`);
	let binary = "";
	for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]);
	return `Basic ${btoa(binary)}`;
}

/** The real request helper, for callers that are not tests. */
export const obsidianDavRequest: DavRequest = (request) => requestUrl(request);
