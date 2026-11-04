/**
 * A calendar account: a sign-in to a CalDAV server, and the calendars on it
 * that became calendar sources.
 *
 * **Where each part lives is the decision this file keeps.** The server's
 * address and the user name are in `data.json` and travel with the vault. The
 * app-specific password is in Obsidian's keychain on this device only, by the
 * account's id (`DeviceStore.password` in `settings.ts`, #1216): a password written into
 * `data.json` would travel through Obsidian Sync to every device, so each
 * device that should read the account is given it once.
 *
 * An account is not a source. Each calendar on it that the person ticks
 * becomes its own source row, of kind `account`, carrying the account's id and
 * the calendar's own address; the two switches, the read state and #1211's
 * per-source gate stay per calendar (decision 2). The plugin never adds a row
 * the person did not tick (decision 9).
 */

import { newCalendarSourceId } from "./calendarSources";
import type { AccountReader, CalendarSource } from "./calendarSources";
import { obsidianDavRequest, serverAddressProblem } from "./calDav";
import type { DavRequest, FoundCalendar } from "./calDav";
import { readAccountCalendar } from "./calDavRead";

/** One calendar account, as `data.json` holds it. Never its password. */
export interface CalendarAccount {
	/** Stable for the life of the account; its rows and its password hang on it. */
	readonly id: string;
	/** Where to sign in. */
	address: string;
	/** Who signs in. */
	user: string;
}

/**
 * Said for an account, and on each of its rows, on a device that holds no
 * app-specific password for it; stored as such a row's failure by
 * {@link accountReader}, and nothing is asked of the server there.
 */
export const NO_PASSWORD_HERE = "This device has no password for this account.";

/** What a new account's server address is prefilled with: iCloud's, the first provider asked for. */
export const ICLOUD_CALDAV = "https://caldav.icloud.com";

/** An account with the iCloud address prefilled and nothing else filled in. */
export function newCalendarAccount(): CalendarAccount {
	return { id: newCalendarSourceId(), address: ICLOUD_CALDAV, user: "" };
}

/**
 * The source row a ticked calendar becomes: named as the server names it,
 * shown in the day and making notes, like every new source.
 */
export function accountSource(account: CalendarAccount, calendar: FoundCalendar): CalendarSource {
	return {
		id: newCalendarSourceId(),
		name: calendar.name,
		kind: "account",
		account: account.id,
		location: calendar.address,
		showInDay: true,
		makeNotes: true,
	};
}

/** The row in `sources` that `calendar` on `account` became, if it was ticked. */
export function rowFor(
	sources: readonly CalendarSource[],
	account: CalendarAccount,
	calendar: FoundCalendar,
): CalendarSource | undefined {
	return sources.find(
		(source) => source.kind === "account" && source.account === account.id && source.location === calendar.address,
	);
}

/**
 * The source list with `calendar` on `account` ticked or unticked. Ticking a
 * calendar that already has its row, or unticking one that has none, hands the
 * list back unchanged; every other row is left exactly as it was.
 */
export function withCalendarTicked(
	sources: readonly CalendarSource[],
	account: CalendarAccount,
	calendar: FoundCalendar,
	ticked: boolean,
): CalendarSource[] {
	const row = rowFor(sources, account, calendar);
	if (ticked) return row === undefined ? [...sources, accountSource(account, calendar)] : [...sources];
	return sources.filter((source) => source !== row);
}

/**
 * Why `account` cannot be signed in to from this device, or null when it can
 * be tried. `password` is this device's, undefined when it holds none.
 */
export function accountProblem(account: CalendarAccount | undefined, password: string | undefined): string | null {
	if (account === undefined) return "The calendar account this calendar belongs to is no longer in the settings.";
	const address = serverAddressProblem(account.address);
	if (address !== null) return address;
	if (account.user.trim() === "") return "This account has no user name yet.";
	if (password === undefined || password === "") return NO_PASSWORD_HERE;
	return null;
}

/**
 * How the calendar reads an account row: it finds the row's account in
 * `accounts`, as the store holds them at the time of the read, and asks
 * {@link accountProblem} first. A row that cannot be signed in for from this
 * device — no password here, its account gone, an address or user name that
 * cannot be used — fails with that sentence **before anything is sent**, so
 * the row says the same as the settings screen does about its account.
 * Otherwise the calendar is read over `span` at its address.
 */
export function accountReader(
	accounts: () => readonly CalendarAccount[],
	request: DavRequest = obsidianDavRequest,
): AccountReader {
	return (id, calendar, password, span) => {
		const account = accounts().find((one) => one.id === id);
		const problem = accountProblem(account, password);
		if (problem !== null) return Promise.reject(new Error(problem));
		// `accountProblem` answers a sentence whenever either is missing; this
		// only tells the type checker so.
		if (account === undefined || password === undefined) return Promise.reject(new Error(NO_PASSWORD_HERE));
		return readAccountCalendar(request, calendar, { user: account.user, password }, span);
	};
}
