/**
 * The calendar accounts on the settings screen: per account its server
 * address, user name and app-specific password, *Fetch calendars*, and one
 * switch per calendar the server lists.
 *
 * Its own file beside `calendarSourcesSection.ts`, which calls it: an account
 * is not a source, and signing in, listing and ticking are a job of their
 * own. A ticked calendar becomes a source row, drawn there with the others.
 *
 * **The password box writes to Obsidian's keychain and nowhere else.** The
 * address and user name go through the core's settings store like every
 * other answer on the screen; the password never does
 * (`DeviceStore.keepPassword` in `settings.ts`,
 * #1216). The box is the
 * plugin's own masked text box, not Obsidian's `SecretComponent` picker.
 */

import { Notice, Setting } from "obsidian";
import { discoverCalendars } from "./calDav";
import type { DavRequest, Discovery } from "./calDav";
import {
	ICLOUD_CALDAV,
	NO_PASSWORD_HERE,
	accountProblem,
	newCalendarAccount,
	rowFor,
	withCalendarTicked,
} from "./calendarAccounts";
import type { CalendarAccount } from "./calendarAccounts";
import type { CalendarSource } from "./calendarSources";
import { reasonOf } from "./reason";
import type { SaveFailureAnnouncer } from "./saveFailureAnnouncer";
import type { CoreSettings, DeviceStore, SettingsStore } from "./settings";

/**
 * What one account's *Fetch calendars* came to on this screen, by account id:
 * signing in, or the server's answer. Held by the caller across redraws of
 * the section, and never stored: the list is the server's, asked on demand.
 */
export type FetchedCalendars = Map<string, Discovery | "signing in">;

/** What the accounts part needs from the section that draws it. */
export interface AccountsContext {
	readonly settings: SettingsStore;
	readonly device: DeviceStore;
	readonly request: DavRequest;
	readonly announceDeferredSaveFailure: SaveFailureAnnouncer;
	readonly fetched: FetchedCalendars;
	/**
	 * Writes a change to the core settings, announcing a failed write, and
	 * answers whether it landed: what is kept only on this device — a row's
	 * read state, an account's password — is forgotten only once the rows it
	 * belongs to are gone from the store.
	 */
	saveCore(change: Partial<CoreSettings>): Promise<boolean>;
	/** Draws the whole section again from the store. */
	redraw(): void;
	/** Brings every account row's state line up to date, without drawing anything again. */
	refreshRows(): void;
}

/**
 * The fixed names of the rows the accounts part draws, for the settings search. The calendars an
 * account lists after *Fetch calendars* are named by the server, so they are
 * data and not here.
 */
export const CALENDAR_ACCOUNTS_SETTING_NAMES: readonly string[] = [
	"Calendar accounts",
	"Server address",
	"User name",
	"App-specific password",
	"Calendars on this account",
	"Remove this account",
	"Add account",
];

/** Draws the accounts part, and the *Add account* button under it, into `section`. */
export function drawCalendarAccounts(section: HTMLElement, context: AccountsContext): void {
	new Setting(section)
		.setName("Calendar accounts")
		.setDesc(
			"A sign-in to a calendar server, such as iCloud, with an app-specific password you make at your provider. " +
				"The server address and user name are stored in your vault. The app-specific password stays in Obsidian's keychain on this device, " +
				"and is typed again on each device that should read the account.",
		)
		.setHeading();

	for (const account of context.settings.core().calendarAccounts) drawAccount(section, account, context);

	new Setting(section)
		.setName("Add account")
		.setDesc("A new account starts with iCloud's server address filled in.")
		.addButton((button) =>
			button
				.setButtonText("Add account")
				.setCta()
				.onClick(async () => {
					await context.saveCore({ calendarAccounts: [...context.settings.core().calendarAccounts, newCalendarAccount()] });
					context.redraw();
				}),
		);
}

function drawAccount(section: HTMLElement, account: CalendarAccount, context: AccountsContext): void {
	const { settings, device } = context;
	const block = section.createDiv({ cls: "effortless-calendar-account" });

	new Setting(block)
		.setName("Server address")
		.setDesc("Where the account signs in. iCloud's is filled in; another calendar server's address goes here instead.")
		.addText((text) =>
			text
				.setPlaceholder(ICLOUD_CALDAV)
				.setValue(account.address)
				.onChange((value) => typed(context, account.id, { address: value.trim() })),
		);

	new Setting(block)
		.setName("User name")
		.setDesc("The name you sign in to your provider with. For iCloud, your Apple Account's email address.")
		.addText((text) =>
			text
				.setPlaceholder("name@example.com")
				.setValue(account.user)
				.onChange((value) => typed(context, account.id, { user: value.trim() })),
		);

	const password = new Setting(block).setName("App-specific password");
	/** The sentence beside the box, said again as the box is typed in. */
	const describePassword = (): void => {
		password.setDesc(
			device.password(account.id) === undefined
				? NO_PASSWORD_HERE
				: "Kept in Obsidian's keychain on this device only. Revoke it at your provider if it leaks.",
		);
	};
	password.addText((text) => {
		text.setValue(device.password(account.id) ?? "").onChange((value) => {
			keepTypedPassword(device, account.id, value, rowsOf(settings.core().calendarSources, account.id));
			describePassword();
			context.refreshRows();
		});
		// A password, masked as one, like a published link's box.
		text.inputEl.type = "password";
	});
	describePassword();

	const fetched = context.fetched.get(account.id);
	new Setting(block)
		.setName("Calendars on this account")
		.setDesc(
			"Lists the calendars the account holds. Each one you tick becomes a calendar source above, and unticking removes it. " +
				"A calendar made at your provider later appears when you fetch again.",
		)
		.addButton((button) =>
			button
				.setButtonText("Fetch calendars")
				.setDisabled(fetched === "signing in")
				.onClick(() => fetchCalendars(context, account.id)),
		);
	block.createDiv({ cls: "effortless-calendar-account-fetch", text: fetchLine(fetched) });

	if (fetched !== undefined && fetched !== "signing in" && "calendars" in fetched) {
		const list = block.createDiv({ cls: "effortless-calendar-account-calendars" });
		for (const calendar of fetched.calendars) {
			new Setting(list).setName(calendar.name).addToggle((toggle) =>
				toggle
					.setValue(rowFor(settings.core().calendarSources, account, calendar) !== undefined)
					.onChange(async (ticked) => {
						// Read as the list stands now, not as it was drawn: a name
						// typed into a row since is kept.
						const sources = settings.core().calendarSources;
						const row = rowFor(sources, account, calendar);
						const saved = await context.saveCore({ calendarSources: withCalendarTicked(sources, account, calendar, ticked) });
						if (saved && !ticked && row !== undefined) forgetReads(device, [row.id]);
						context.redraw();
					}),
			);
		}
	}

	new Setting(block)
		.setName("Remove this account")
		.setDesc("Removes the account, every calendar source on it, and its app-specific password on this device.")
		.addButton((button) =>
			button
				.setButtonText("Remove")
				.setDestructive()
				.onClick(async () => {
					const core = settings.core();
					const rows = rowsOf(core.calendarSources, account.id);
					const removed = await context.saveCore({
						calendarAccounts: core.calendarAccounts.filter((other) => other.id !== account.id),
						calendarSources: core.calendarSources.filter((source) => !rows.includes(source)),
					});
					if (removed) {
						forgetReads(device, rows.map((row) => row.id));
						keepTypedPassword(device, account.id, "", []);
						context.fetched.delete(account.id);
					}
					context.redraw();
				}),
		);
}

/** The line under *Fetch calendars*. */
function fetchLine(fetched: Discovery | "signing in" | undefined): string {
	if (fetched === undefined) return "";
	if (fetched === "signing in") return "Signing in…";
	if ("refusal" in fetched) return fetched.refusal;
	return fetched.calendars.length === 0
		? "This account holds no calendar with meetings in it."
		: "Tick each calendar Effortless should read.";
}

/**
 * Signs in and lists the account's calendars, as the account stands in the
 * store now. Nothing is sent when the account cannot be tried from this
 * device — no password here, no user name, an address that would carry the
 * password in the clear — and the reason is said under the button instead.
 */
async function fetchCalendars(context: AccountsContext, id: string): Promise<void> {
	const account = context.settings.core().calendarAccounts.find((one) => one.id === id);
	if (account === undefined) return;
	const password = context.device.password(id);
	const problem = accountProblem(account, password);
	if (problem !== null || password === undefined) {
		context.fetched.set(id, { refusal: problem ?? NO_PASSWORD_HERE });
		context.redraw();
		return;
	}
	context.fetched.set(id, "signing in");
	context.redraw();
	context.fetched.set(id, await discoverCalendars(context.request, account, password));
	context.redraw();
}

/** One account's typed address or user name, on the debounced route every typed box on the screen takes. */
function typed(context: AccountsContext, id: string, change: Partial<CalendarAccount>): void {
	const core = context.settings.core();
	const write = context.settings.saveCoreSoon({
		...core,
		calendarAccounts: core.calendarAccounts.map((account) => (account.id === id ? { ...account, ...change } : account)),
	});
	void write.catch((error: unknown) => context.announceDeferredSaveFailure(write, error));
	context.refreshRows();
}

/** The source rows that are calendars on the account `id`. */
function rowsOf(sources: readonly CalendarSource[], id: string): CalendarSource[] {
	return sources.filter((source) => source.kind === "account" && source.account === id);
}

/**
 * Keeps `value` as the account's app-specific password on this device, or
 * forgets it when blank. A keychain that refuses it is said in a notice, and
 * nothing else changes. A stored read failure saying this device has no
 * password is cleared from the account's `rows` once one is kept: it is no
 * longer true, and the row would say so until the next read otherwise.
 */
function keepTypedPassword(device: DeviceStore, id: string, value: string, rows: readonly CalendarSource[]): void {
	try {
		device.keepPassword(id, value);
	} catch (error) {
		new Notice(`Effortless: the app-specific password was not kept. ${reasonOf(error)}`);
		return;
	}
	if (value === "") return;
	const reads = { ...device.read().calendarReads };
	for (const row of rows) {
		const read = reads[row.id];
		if (read?.failure === NO_PASSWORD_HERE) reads[row.id] = { ...read, failure: null };
	}
	device.save({ calendarReads: reads });
}

/** Forgets the read state of each row in `ids` on this device. */
function forgetReads(device: DeviceStore, ids: readonly string[]): void {
	const reads = { ...device.read().calendarReads };
	for (const id of ids) delete reads[id];
	device.save({ calendarReads: reads });
}
