import { beforeEach, describe, expect, it } from "vitest";
// The stub is imported by path rather than as "obsidian": `tsc` checks this
// file against the real API, and only vitest redirects that name.
import type { App as ObsidianApp, Plugin as ObsidianPlugin } from "obsidian";
import {
	App,
	Notice,
	Plugin,
	controlsUnder,
	resetSettings,
	type ButtonComponent,
	type TextComponent,
	type ToggleComponent,
} from "./__mocks__/obsidian";
import { renderCalendarSources } from "../core/calendarSourcesSection";
import { createSaveFailureAnnouncer } from "../core/saveFailureAnnouncer";
import { NO_PASSWORD_HERE } from "../core/calendarAccounts";
import type { DavRequest } from "../core/calDav";
import { DeviceStore, SAVE_AFTER_TYPING_MS, SettingsStore } from "../core/settings";

/*
 * Issue #1213, through the settings screen as a person uses it: *Add account*,
 * the three boxes, *Fetch calendars*, and one switch per calendar the server
 * lists. The server is played by a fake request answering the three discovery
 * steps; every request it is asked is counted.
 */

const FAKE_APP_PW = "fake-abcd-efgh-ijkl";

/** A CalDAV server at `https://caldav.example.test` holding `calendars`, and the count of what it was asked. */
function server(calendars: Array<[string, string]>, refuse = false): { request: DavRequest; asked: string[]; calendars: Array<[string, string]> } {
	const asked: string[] = [];
	const held = { request: (async () => ({ status: 0, text: "" })) as DavRequest, asked, calendars };
	held.request = async ({ url, headers }) => {
		asked.push(url);
		if (refuse) return { status: 401, text: "" };
		const signedIn = headers?.Authorization === `Basic ${btoa(`someone@example.test:${FAKE_APP_PW}`)}`;
		if (!signedIn) return { status: 401, text: "" };
		if (url === "https://caldav.example.test/") {
			return multistatus(`<d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/p/</d:href></d:current-user-principal></d:prop></d:propstat></d:response>`);
		}
		if (url === "https://caldav.example.test/p/") {
			return multistatus(`<d:response><d:href>/p/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/home/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response>`);
		}
		if (url === "https://caldav.example.test/home/") {
			return multistatus(
				held.calendars
					.map(
						([path, name]) =>
							`<d:response><d:href>/home/${path}/</d:href><d:propstat><d:prop><d:displayname>${name}</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response>`,
					)
					.join(""),
			);
		}
		return { status: 404, text: "" };
	};
	return held;
}

function multistatus(responses: string): { status: number; text: string } {
	return {
		status: 207,
		text: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${responses}</d:multistatus>`,
	};
}

async function drawSection(request: DavRequest): Promise<{
	settings: SettingsStore;
	device: DeviceStore;
	body: HTMLElement;
	plugin: Plugin;
}> {
	const plugin = new Plugin(new App());
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const device = new DeviceStore(plugin.app as unknown as ObsidianApp);
	const body = document.createElement("div");
	resetSettings();
	renderCalendarSources(body, settings, device, createSaveFailureAnnouncer(), request);
	return { settings, device, body, plugin };
}

function control<T>(root: HTMLElement, row: string, index = 0): T {
	const found = controlsUnder(root).get(row);
	if (!found) throw new Error(`No row called "${row}" was drawn.`);
	return found[index] as T;
}

function settle(): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Presses *Add account* and fills the three boxes the way a person types them. */
async function addAccount(body: HTMLElement, user = "someone@example.test", password: string | null = FAKE_APP_PW): Promise<void> {
	await control<ButtonComponent>(body, "Add account").click();
	control<TextComponent>(body, "Server address").change("https://caldav.example.test");
	control<TextComponent>(body, "User name").change(user);
	if (password !== null) control<TextComponent>(body, "App-specific password").change(password);
}

async function fetchCalendars(body: HTMLElement): Promise<void> {
	await control<ButtonComponent>(body, "Calendars on this account").click();
	await settle();
}

function fetchLine(body: HTMLElement): string {
	return body.querySelector(".effortless-calendar-account-fetch")?.textContent ?? "";
}

function stateLines(body: HTMLElement): string[] {
	return Array.from(body.querySelectorAll(".effortless-calendar-state")).map((line) => line.textContent ?? "");
}

describe("adding a calendar account on the settings screen", () => {
	beforeEach(() => {
		resetSettings();
		Notice.messages = [];
	});

	it("prefills iCloud's server address on a new account", async () => {
		const { body, settings } = await drawSection(server([]).request);
		await control<ButtonComponent>(body, "Add account").click();
		expect(control<TextComponent>(body, "Server address").getValue()).toBe("https://caldav.icloud.com");
		expect(settings.core().calendarAccounts.map((account) => account.address)).toEqual(["https://caldav.icloud.com"]);
	});

	it("masks the app-specific password box like a link", async () => {
		const { body } = await drawSection(server([]).request);
		await addAccount(body);
		expect(control<TextComponent>(body, "App-specific password").inputEl.type).toBe("password");
	});

	it("lists every calendar the server holds, named as the server names it, with nothing ticked and no row made", async () => {
		const { body, settings } = await drawSection(server([["work", "Work"], ["family", "Family"]]).request);
		await addAccount(body);
		await fetchCalendars(body);
		expect(control<ToggleComponent>(body, "Work").getValue()).toBe(false);
		expect(control<ToggleComponent>(body, "Family").getValue()).toBe(false);
		expect(settings.core().calendarSources).toEqual([]);
	});

	it("makes a ticked calendar a source of kind account, carrying the account's id and the calendar's address, both switches on", async () => {
		const { body, settings } = await drawSection(server([["work", "Work"], ["family", "Family"]]).request);
		await addAccount(body);
		await fetchCalendars(body);
		await control<ToggleComponent>(body, "Family").change(true);
		await settle();
		const account = settings.core().calendarAccounts[0];
		expect(settings.core().calendarSources).toEqual([
			{
				id: expect.any(String),
				name: "Family",
				kind: "account",
				account: account.id,
				location: "https://caldav.example.test/home/family/",
				showInDay: true,
				makeNotes: true,
			},
		]);
		expect(control<ToggleComponent>(body, "Family").getValue()).toBe(true);
	});

	it("removes exactly that row and its read state when a calendar is unticked", async () => {
		const { body, settings, device } = await drawSection(server([["work", "Work"], ["family", "Family"]]).request);
		await addAccount(body);
		await fetchCalendars(body);
		await control<ToggleComponent>(body, "Work").change(true);
		await settle();
		await control<ToggleComponent>(body, "Family").change(true);
		await settle();
		const [work, family] = settings.core().calendarSources;
		device.save({
			calendarReads: {
				[work.id]: { readAt: 1000, failure: null },
				[family.id]: { readAt: 2000, failure: null },
			},
		});
		await control<ToggleComponent>(body, "Work").change(false);
		await settle();
		expect(settings.core().calendarSources).toEqual([family]);
		expect(device.read().calendarReads).toEqual({ [family.id]: { readAt: 2000, failure: null } });
	});

	it("names the account on its calendar's row as the store holds it, following a user name typed below", async () => {
		const { body } = await drawSection(server([["work", "Work"]]).request);
		await addAccount(body);
		await fetchCalendars(body);
		await control<ToggleComponent>(body, "Work").change(true);
		await settle();
		const origin = (): string =>
			Array.from(body.querySelectorAll(".effortless-calendar-source .setting-item"))
				.find((row) => row.querySelector(".setting-item-name")?.textContent === "Where it comes from")
				?.querySelector(".setting-item-description")?.textContent ?? "";
		expect(origin()).toBe('A calendar on the calendar account "someone@example.test" at https://caldav.example.test.');
		control<TextComponent>(body, "User name").change("family@example.test");
		expect(origin()).toBe('A calendar on the calendar account "family@example.test" at https://caldav.example.test.');
	});

	it("keeps the row's read state when unticking it could not be saved", async () => {
		const { body, settings, device, plugin } = await drawSection(server([["work", "Work"]]).request);
		await addAccount(body);
		await fetchCalendars(body);
		await control<ToggleComponent>(body, "Work").change(true);
		await settle();
		const [work] = settings.core().calendarSources;
		device.save({ calendarReads: { [work.id]: { readAt: 1000, failure: null } } });
		// The boxes typed into above left a delayed write waiting; with it
		// waiting, a failed write is carried by it rather than rolled back.
		await settings.flush();
		plugin.saveData = () => Promise.reject(new Error("The disk is full."));
		await control<ToggleComponent>(body, "Work").change(false);
		await settle();
		expect(settings.core().calendarSources).toEqual([work]);
		expect(device.read().calendarReads).toEqual({ [work.id]: { readAt: 1000, failure: null } });
	});

	it("lists a calendar added since on a second fetch, leaving the existing rows as they were", async () => {
		const held = server([["work", "Work"]]);
		const { body, settings } = await drawSection(held.request);
		await addAccount(body);
		await fetchCalendars(body);
		await control<ToggleComponent>(body, "Work").change(true);
		await settle();
		// Renamed by the person, which a second fetch must not undo.
		const [row] = settings.core().calendarSources;
		await settings.saveCore({ ...settings.core(), calendarSources: [{ ...row, name: "Jobb", showInDay: false }] });
		held.calendars.push(["kids", "Kids"]);
		await fetchCalendars(body);
		expect(control<ToggleComponent>(body, "Kids").getValue()).toBe(false);
		expect(control<ToggleComponent>(body, "Work").getValue()).toBe(true);
		expect(settings.core().calendarSources).toEqual([{ ...row, name: "Jobb", showInDay: false }]);
	});

	it("says a refused sign-in under the button, naming the app-specific password, and makes no row", async () => {
		const { body, settings } = await drawSection(server([["work", "Work"]], true).request);
		await addAccount(body);
		await fetchCalendars(body);
		expect(fetchLine(body)).toMatch(/app-specific password/);
		expect(controlsUnder(body).has("Work")).toBe(false);
		expect(settings.core().calendarSources).toEqual([]);
	});

	it("says an unreachable server under the button, naming the address, and makes no row", async () => {
		const unreachable: DavRequest = () => Promise.reject(new Error("net::ERR_NAME_NOT_RESOLVED"));
		const { body, settings } = await drawSection(unreachable);
		await addAccount(body);
		await fetchCalendars(body);
		expect(fetchLine(body)).toContain("https://caldav.example.test");
		expect(settings.core().calendarSources).toEqual([]);
	});

	it("stores the server address and user name in data.json, and the app-specific password only in this device's keychain", async () => {
		const { body, settings, plugin } = await drawSection(server([]).request);
		await addAccount(body);
		await new Promise<void>((resolve) => setTimeout(resolve, SAVE_AFTER_TYPING_MS + 50));
		await settings.flush();
		const account = settings.core().calendarAccounts[0];
		expect(account).toEqual({ id: account.id, address: "https://caldav.example.test", user: "someone@example.test" });
		expect(plugin.app.secretStorage.getSecret(`effortless-calendar-${account.id}`)).toBe(FAKE_APP_PW);
		expect(JSON.stringify(plugin.app.loadLocalStorage("effortless:device"))).not.toContain(FAKE_APP_PW);
		const written = plugin.saved[plugin.saved.length - 1];
		expect(written).toContain("someone@example.test");
		expect(written).not.toContain(FAKE_APP_PW);
	});
});

describe("a device with no password for an account", () => {
	beforeEach(() => {
		resetSettings();
		Notice.messages = [];
	});

	it("says so beside the password box and on each of the account's rows, and asks the server nothing", async () => {
		const held = server([["work", "Work"]]);
		const { body, settings, device } = await drawSection(held.request);
		await addAccount(body);
		await fetchCalendars(body);
		await control<ToggleComponent>(body, "Work").change(true);
		await settle();
		// The password typed on the other device: this one never held it.
		device.keepPassword(settings.core().calendarAccounts[0].id, "");
		resetSettings();
		body.replaceChildren();
		held.asked.length = 0;
		renderCalendarSources(body, settings, device, createSaveFailureAnnouncer(), held.request);

		const passwordRow = Array.from(body.querySelectorAll(".setting-item")).find(
			(row) => row.querySelector(".setting-item-name")?.textContent === "App-specific password",
		);
		expect(passwordRow?.querySelector(".setting-item-description")?.textContent).toBe(NO_PASSWORD_HERE);
		expect(stateLines(body)).toEqual([NO_PASSWORD_HERE]);
		await fetchCalendars(body);
		expect(fetchLine(body)).toBe(NO_PASSWORD_HERE);
		expect(held.asked).toHaveLength(0);
	});

	it("stores a password typed there on this device, and the rows stop saying it is missing", async () => {
		const held = server([["work", "Work"]]);
		const { body, settings, device } = await drawSection(held.request);
		await addAccount(body);
		await fetchCalendars(body);
		await control<ToggleComponent>(body, "Work").change(true);
		await settle();
		// What a refresh on this device stored while it held no password.
		const [row] = settings.core().calendarSources;
		device.keepPassword(settings.core().calendarAccounts[0].id, "");
		device.save({ calendarReads: { [row.id]: { readAt: null, failure: NO_PASSWORD_HERE } } });
		resetSettings();
		body.replaceChildren();
		renderCalendarSources(body, settings, device, createSaveFailureAnnouncer(), held.request);
		expect(stateLines(body)).toEqual([NO_PASSWORD_HERE]);

		control<TextComponent>(body, "App-specific password").change(FAKE_APP_PW);
		const account = settings.core().calendarAccounts[0];
		expect(device.password(account.id)).toBe(FAKE_APP_PW);
		expect(stateLines(body)).toEqual(["Not read yet."]);
	});
});

/*
 * Issue #1216: the keychain publishes no way to delete a secret, so blanking
 * the box and removing the account each leave an empty one, which every
 * reader takes for no password on this device.
 */
describe("forgetting an account's password", () => {
	beforeEach(() => {
		resetSettings();
		Notice.messages = [];
	});

	it("leaves an empty secret when the box is blanked, and the rows say this device has none", async () => {
		const held = server([["work", "Work"]]);
		const { body, settings, plugin } = await drawSection(held.request);
		await addAccount(body);
		await fetchCalendars(body);
		await control<ToggleComponent>(body, "Work").change(true);
		await settle();
		const secret = `effortless-calendar-${settings.core().calendarAccounts[0].id}`;
		expect(plugin.app.secretStorage.getSecret(secret)).toBe(FAKE_APP_PW);
		expect(stateLines(body)).not.toContain(NO_PASSWORD_HERE);

		control<TextComponent>(body, "App-specific password").change("");
		expect(plugin.app.secretStorage.getSecret(secret)).toBe("");
		expect(stateLines(body)).toEqual([NO_PASSWORD_HERE]);
	});

	it("leaves an empty secret when the account is removed", async () => {
		const { body, settings, plugin } = await drawSection(server([]).request);
		await addAccount(body);
		const secret = `effortless-calendar-${settings.core().calendarAccounts[0].id}`;
		expect(plugin.app.secretStorage.getSecret(secret)).toBe(FAKE_APP_PW);

		await control<ButtonComponent>(body, "Remove this account").click();
		await settle();
		expect(settings.core().calendarAccounts).toEqual([]);
		expect(plugin.app.secretStorage.getSecret(secret)).toBe("");
	});

	it("says in a notice when the keychain refuses the password, and keeps nothing", async () => {
		const { body, plugin } = await drawSection(server([]).request);
		plugin.app.secretStorage.setSecret = () => {
			throw new Error("Secure storage is not available.");
		};
		await addAccount(body);
		expect(Notice.messages).toContain(
			"Effortless: the app-specific password was not kept. Secure storage is not available.",
		);
		expect(plugin.app.secretStorage.listSecrets()).toEqual([]);
	});
});
