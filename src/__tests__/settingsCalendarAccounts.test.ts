import { beforeEach, describe, expect, it } from "vitest";
// The stub is imported by path rather than as "obsidian": `tsc` checks this
// file against the real API, and only vitest redirects that name.
import type { App as ObsidianApp, Plugin as ObsidianPlugin } from "obsidian";
import { App, Notice, Plugin } from "./__mocks__/obsidian";
import { DeviceStore, SettingsStore, passwordSecretId } from "../core/settings";
import { newCalendarSourceId } from "../core/calendarSources";

/*
 * Issue #1213: a calendar account's server address and user name live in
 * `data.json` and travel with the vault; its app-specific password lives only
 * in the per-device store.
 */

type Stored = Record<string, any>;

async function storeOver(file: Stored | null): Promise<{ plugin: Plugin; settings: SettingsStore }> {
	const plugin = new Plugin(new App());
	if (file !== null) plugin.seedData(file);
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	return { plugin, settings };
}

function settleMicrotasks(): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const usable = { id: "acc-1", address: "https://caldav.example.test", user: "someone@example.test" };

describe("a calendar account read from data.json", () => {
	beforeEach(() => {
		Notice.messages = [];
	});

	it("keeps a usable account as stored, and says nothing", async () => {
		const { settings } = await storeOver({ core: { calendarAccounts: [usable] } });
		expect(settings.core().calendarAccounts).toEqual([usable]);
		expect(Notice.messages).toEqual([]);
	});

	it("starts with no accounts on a fresh install", async () => {
		const { settings } = await storeOver(null);
		expect(settings.core().calendarAccounts).toEqual([]);
	});

	it("refuses a missing or non-text address or user name with a notice, never putting another address in its place", async () => {
		const { settings } = await storeOver({
			core: {
				calendarAccounts: [
					{ id: "acc-1", address: 5, user: "someone@example.test" },
					{ id: "acc-2", user: "family@example.test" },
					{ id: "acc-3", address: "https://caldav.example.test", user: ["x"] },
				],
			},
		});
		const accounts = settings.core().calendarAccounts;
		// Blank, which asks nothing of any server, rather than the iCloud
		// address a new account is prefilled with.
		expect(accounts.map((account) => [account.id, account.address, account.user])).toEqual([
			["acc-1", "", "someone@example.test"],
			["acc-2", "", "family@example.test"],
			["acc-3", "https://caldav.example.test", ""],
		]);
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain('"someone@example.test"');
		expect(Notice.messages[0]).toContain('"family@example.test"');
		expect(Notice.messages[0]).toContain("server address");
		expect(Notice.messages[0]).toContain("user name");
	});

	it("names an account whose id is missing or already taken, since its rows and password no longer reach it", async () => {
		const { settings } = await storeOver({
			core: {
				calendarAccounts: [
					{ address: "https://caldav.example.test", user: "someone@example.test" },
					usable,
					{ ...usable, user: "family@example.test" },
				],
			},
		});
		const ids = settings.core().calendarAccounts.map((account) => account.id);
		expect(new Set(ids).size).toBe(3);
		expect(ids[1]).toBe("acc-1");
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain('The calendar account "someone@example.test"\'s id');
		expect(Notice.messages[0]).toContain('The calendar account "family@example.test"\'s id');
	});

	it("names an account whose id cannot name a password in the keychain, keeping the id its rows hang on", async () => {
		const { settings } = await storeOver({ core: { calendarAccounts: [{ ...usable, id: "Acc_1" }] } });
		expect(settings.core().calendarAccounts.map((account) => account.id)).toEqual(["Acc_1"]);
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain('The calendar account "someone@example.test"\'s id');
	});

	it("names a calendar row whose account is not text, keeping the row", async () => {
		const { settings } = await storeOver({
			core: {
				calendarAccounts: [usable],
				calendarSources: [
					{ id: "row-1", name: "Family", kind: "account", account: 5, location: "https://caldav.example.test/f/" },
				],
			},
		});
		expect(settings.core().calendarSources.map((source) => [source.id, source.kind, source.account])).toEqual([
			["row-1", "account", ""],
		]);
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain('The calendar "Family"\'s account');
	});

	it("refuses a list that is not a list with a notice", async () => {
		const { settings } = await storeOver({ core: { calendarAccounts: { id: "acc-1" } } });
		expect(settings.core().calendarAccounts).toEqual([]);
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0]).toContain("Calendar accounts");
	});

	it("keeps this device's answer when a reload brings an address it cannot use", async () => {
		const { plugin, settings } = await storeOver({ core: { calendarAccounts: [usable] } });
		await settleMicrotasks();
		const file = (await plugin.loadData()) as Stored;
		file.core.calendarAccounts = [{ ...usable, address: 7 }];
		plugin.seedData(file);
		await settings.reloadExternal();
		expect(settings.core().calendarAccounts).toEqual([usable]);
		expect(Notice.messages.some((message) => message.includes("server address"))).toBe(true);
	});

	it("takes another device's new account on a reload", async () => {
		const { plugin, settings } = await storeOver({ core: { calendarAccounts: [] } });
		await settleMicrotasks();
		const file = (await plugin.loadData()) as Stored;
		file.core.calendarAccounts = [usable];
		plugin.seedData(file);
		await settings.reloadExternal();
		expect(settings.core().calendarAccounts).toEqual([usable]);
	});
});

describe("an account's app-specific password", () => {
	beforeEach(() => {
		Notice.messages = [];
	});

	it("is kept in the per-device store and read back from it", async () => {
		const app = new App();
		const device = new DeviceStore(app as unknown as ObsidianApp);
		device.save({ accountPasswords: { "acc-1": "fake-abcd-efgh-ijkl" } });
		expect(new DeviceStore(app as unknown as ObsidianApp).read().accountPasswords).toEqual({
			"acc-1": "fake-abcd-efgh-ijkl",
		});
	});

	it("reads only text from the per-device store", () => {
		const app = new App();
		app.saveLocalStorage("effortless:device", { accountPasswords: { "acc-1": 5, "acc-2": "fake-pw" } });
		expect(new DeviceStore(app as unknown as ObsidianApp).read().accountPasswords).toEqual({ "acc-2": "fake-pw" });
	});
});

/*
 * Issue #1216: the password lives in Obsidian's keychain, `app.secretStorage`,
 * under `effortless-calendar-<account id>`, and no longer in the per-device
 * store. The per-device field is read once more, by the move.
 */
describe("an account's app-specific password in the keychain", () => {
	beforeEach(() => {
		Notice.messages = [];
	});

	function deviceOn(app: App): DeviceStore {
		return new DeviceStore(app as unknown as ObsidianApp);
	}

	it("is kept under the plugin's own id for the account, and not in the per-device store", () => {
		const app = new App();
		deviceOn(app).keepPassword("acc-1", "fake-abcd-efgh-ijkl");
		expect(app.secretStorage.getSecret("effortless-calendar-acc-1")).toBe("fake-abcd-efgh-ijkl");
		expect(app.secretStorage.listSecrets()).toEqual(["effortless-calendar-acc-1"]);
		expect(deviceOn(app).read().accountPasswords).toEqual({});
		expect(deviceOn(app).password("acc-1")).toBe("fake-abcd-efgh-ijkl");
	});

	it("is forgotten by keeping a blank, which every reader takes for no password", () => {
		const app = new App();
		deviceOn(app).keepPassword("acc-1", "fake-abcd-efgh-ijkl");
		deviceOn(app).keepPassword("acc-1", "");
		expect(app.secretStorage.getSecret("effortless-calendar-acc-1")).toBe("");
		expect(deviceOn(app).password("acc-1")).toBeUndefined();
	});

	it("reads as no password when the keychain holds nothing for the account", () => {
		expect(deviceOn(new App()).password("acc-1")).toBeUndefined();
	});

	it("names a secret Obsidian accepts for every account id the plugin makes", () => {
		for (let made = 0; made < 50; made++) {
			const id = passwordSecretId(newCalendarSourceId());
			expect(id).toMatch(/^effortless-calendar-[a-z0-9-]+$/);
			expect((id ?? "").length).toBeLessThanOrEqual(64);
		}
	});

	it("names no secret for an account id the keychain would refuse, and keeping one there says why", () => {
		const app = new App();
		for (const id of ["", "Acc-1", "acc_1", "acc.1", "a".repeat(45)]) {
			expect(passwordSecretId(id)).toBeNull();
			expect(deviceOn(app).password(id)).toBeUndefined();
			expect(() => deviceOn(app).keepPassword(id, "fake-pw")).toThrow(/cannot hold a password/);
		}
		expect(app.secretStorage.listSecrets()).toEqual([]);
	});
});

describe("a password the per-device store held before the keychain", () => {
	beforeEach(() => {
		Notice.messages = [];
	});

	it("moves to the keychain and leaves the per-device store, which answers nothing left behind", () => {
		const app = new App();
		app.saveLocalStorage("effortless:device", {
			buildsTheDays: true,
			accountPasswords: { "acc-1": "fake-one", "acc-2": "fake-two" },
		});
		const device = new DeviceStore(app as unknown as ObsidianApp);
		expect(device.movePasswordsToKeychain()).toEqual([]);
		expect(app.secretStorage.getSecret("effortless-calendar-acc-1")).toBe("fake-one");
		expect(app.secretStorage.getSecret("effortless-calendar-acc-2")).toBe("fake-two");
		expect(device.read().accountPasswords).toEqual({});
		// The move touches nothing else the device keeps.
		expect(device.read().buildsTheDays).toBe(true);
		expect(device.password("acc-2")).toBe("fake-two");
	});

	it("stays where it was when the keychain does not read it back, and is answered", () => {
		const app = new App();
		app.saveLocalStorage("effortless:device", { accountPasswords: { "acc-1": "fake-one", "acc-2": "fake-two" } });
		const getSecret = app.secretStorage.getSecret.bind(app.secretStorage);
		app.secretStorage.getSecret = (id: string) => (id === "effortless-calendar-acc-2" ? "something else" : getSecret(id));
		const device = new DeviceStore(app as unknown as ObsidianApp);
		expect(device.movePasswordsToKeychain()).toEqual([
			{ accountId: "acc-2", reason: "The keychain did not read back what was written." },
		]);
		expect(device.read().accountPasswords).toEqual({ "acc-2": "fake-two" });
	});

	it("stays where it was when the keychain refuses it outright, and is answered", () => {
		const app = new App();
		app.saveLocalStorage("effortless:device", { accountPasswords: { "acc_1": "fake-one", "acc-2": "fake-two" } });
		app.secretStorage.setSecret = (id: string) => {
			if (id === "effortless-calendar-acc-2") throw new Error("Secure storage is not available.");
		};
		const device = new DeviceStore(app as unknown as ObsidianApp);
		const stayed = device.movePasswordsToKeychain();
		expect(stayed.map((one) => one.accountId).sort()).toEqual(["acc-2", "acc_1"]);
		expect(stayed.find((one) => one.accountId === "acc-2")?.reason).toBe("Secure storage is not available.");
		expect(stayed.find((one) => one.accountId === "acc_1")?.reason).toMatch(/cannot hold a password/);
		expect(device.read().accountPasswords).toEqual({ "acc_1": "fake-one", "acc-2": "fake-two" });
	});

	it("is given up for good once the person keeps or forgets a password for that account, so it can never come back over it", () => {
		const app = new App();
		app.saveLocalStorage("effortless:device", { accountPasswords: { "acc-1": "fake-old", "acc-2": "fake-two" } });
		const setSecret = app.secretStorage.setSecret.bind(app.secretStorage);
		let refuse = true;
		app.secretStorage.setSecret = (id: string, secret: string) => {
			if (refuse) throw new Error("Secure storage is not available.");
			setSecret(id, secret);
		};
		const device = new DeviceStore(app as unknown as ObsidianApp);
		expect(device.movePasswordsToKeychain()).toHaveLength(2);

		refuse = false;
		device.keepPassword("acc-1", "fake-new");
		device.keepPassword("acc-2", "");
		expect(device.read().accountPasswords).toEqual({});
		expect(device.movePasswordsToKeychain()).toEqual([]);
		expect(device.password("acc-1")).toBe("fake-new");
		expect(device.password("acc-2")).toBeUndefined();
	});

	it("leaves a store with nothing to move unwritten", () => {
		const app = new App();
		let writes = 0;
		app.saveLocalStorage = () => {
			writes += 1;
		};
		expect(new DeviceStore(app as unknown as ObsidianApp).movePasswordsToKeychain()).toEqual([]);
		expect(writes).toBe(0);
	});
});
