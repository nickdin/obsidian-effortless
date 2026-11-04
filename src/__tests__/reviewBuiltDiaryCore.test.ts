/**
 * A day's log nobody has written in is never stamped with a diary date, however
 * late Review first sees it: the section a log
 * was built with is kept by the core when the log is built, not only by Review the
 * first time it sees the log change.
 *
 * The harness is the real registry, settings store and note writer over the stub
 * vault, the writer told of each build the way `main.ts` tells it
 * ({@link keepBuiltDiaries}). Obsidian reports a note it has indexed through
 * `changed`, which the stub does not do on its own, so the tests fire it. Every
 * folder, note and line here is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plugin as ObsidianPlugin } from "obsidian";
import { Platform, Plugin, resetSettings } from "./__mocks__/obsidian";
import type { App } from "./__mocks__/obsidian";
import { keepBuiltDiaries } from "../core/builtDiaries";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import { localDateKey } from "../core/meetingName";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import type { EffortlessData } from "../core/settings";
import { FEATURE_ID, Review } from "../features/review";

/** Tuesday 13 October 2026, noon: the day the logs are built on. */
const BUILT_ON = new Date(2026, 9, 13, 12, 0, 0);
/** Friday 16 October 2026, noon: the day a log built ahead for it arrives. */
const THE_DAY = new Date(2026, 9, 16, 12, 0, 0);

const TEMPLATE_PATH = "Templates/Day.md";
const TEMPLATE_A = "---\nprocessed:\ndiary:\n---\n# Notes\n# Diary\n- What did I learn today?\n";
const TEMPLATE_B = TEMPLATE_A.replace("What did I learn today?", "What went well?");
const STAMP = `diary: ${localDateKey(THE_DAY)}`;

function dataWith(reviewOn: boolean): EffortlessData {
	const data = defaultData();
	return {
		...data,
		core: {
			...data.core,
			layout: { ...data.core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD", dailyLogTemplate: TEMPLATE_PATH },
			enabled: { [FEATURE_ID]: reviewOn },
		},
		features: { [FEATURE_ID]: {} },
	};
}

interface Device {
	readonly app: App;
	readonly plugin: Plugin;
	readonly settings: SettingsStore;
	readonly writer: NoteWriter;
	readonly registry: FeatureRegistry;
	/** The Review the registry made, once it has made one. */
	readonly review: () => Review | undefined;
}

/**
 * One device: the plugin's parts over the stub vault holding only the template,
 * Review switched on or off. `seed` is what `data.json` holds when it starts.
 */
async function startDevice(reviewOn: boolean, seed: EffortlessData = dataWith(reviewOn)): Promise<Device> {
	const plugin = new Plugin();
	plugin.seedData(seed);
	plugin.load();
	const app = plugin.app as unknown as App;
	app.vault.files = [{ path: TEMPLATE_PATH }];
	app.metadataCache.caches.clear();
	app.vault.allowReads({ [TEMPLATE_PATH]: TEMPLATE_A });
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const writer = new NoteWriter(app.vault as never, { path: () => null, onChange: () => undefined }, undefined, keepBuiltDiaries(settings));
	const calendar: Calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const collections: Collections = { all: () => [], at: () => null };
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems: new Problems(), device: new DeviceStore(plugin.app as never) },
		writer,
		calendar,
	);
	let review: Review | undefined;
	registry.register(FEATURE_ID, (host: FeatureHost) => (review = new Review(host)));
	registry.start();
	return { app, plugin, settings, writer, registry, review: () => review };
}

/** Lets the template read, the record's save and any write the change set going finish (setTimeout is not faked here). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

/**
 * `text` without the mark of its built diary section: a log as built before
 * the mark existed, which is what the #1201 tests here are about. Throws when there
 * is no mark to take out, so a test that meant to drop it cannot silently keep it.
 */
function withoutMark(text: string): string {
	const stripped = text.replace(/^effortless-built-diary: .*\n/m, "");
	if (stripped === text) throw new Error("the built log carries no mark to take out");
	return stripped;
}

/**
 * Days ahead's build of one day's log, three days early. Obsidian is not yet said to
 * have indexed it. `keepMark`: the log keeps the mark the writer puts in it;
 * otherwise it is taken out at once, so the log is one built before the mark existed.
 */
async function buildAhead(device: Device, keepMark = false): Promise<string> {
	vi.setSystemTime(BUILT_ON);
	const file = await device.writer.createDailyLog(THE_DAY, dataWith(true).core.layout);
	if (!keepMark) setText(device.app, file.path, withoutMark(await device.app.vault.read(file)));
	device.app.metadataCache.caches.set(file.path, { frontmatter: { processed: null, diary: null } });
	await settle();
	return file.path;
}

/** What a note holds from now on, as if the person had saved it, or Sync had brought it. */
function setText(app: App, path: string, text: string): void {
	(app.vault as unknown as { contents: Map<string, string> }).contents.set(path, text);
}

/** The person's template is reworded, and the day the log was built for arrives. */
function rewordTemplateAndArrive(app: App): void {
	setText(app, TEMPLATE_PATH, TEMPLATE_B);
	vi.setSystemTime(THE_DAY);
}

/** What the cache reports when the log changes, which is any change to the note at all. */
async function changed(app: App, path: string): Promise<void> {
	const text = await app.vault.read({ path });
	app.metadataCache.fire("changed", { path }, text, app.metadataCache.caches.get(path));
	await settle();
}

beforeEach(() => {
	resetSettings();
	Platform.isMobile = false;
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
	vi.setSystemTime(BUILT_ON);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a log built while Review is off, Review switched on after the template is reworded", () => {
	it("is not stamped when its first change arrives untouched", async () => {
		const device = await startDevice(false);
		const path = await buildAhead(device);
		const built = await device.app.vault.read({ path });
		expect(built).toContain("What did I learn today?");

		rewordTemplateAndArrive(device.app);
		await device.registry.setEnabled(FEATURE_ID, true);
		await settle();
		// If wrong: nothing kept the section at build time, Review compares the log
		// with template B, and the log reads `diary: 2026-10-16`.
		await changed(device.app, path);

		// Read back: the log's text as the vault holds it after the change.
		expect(await device.app.vault.read({ path })).toBe(built);
	});

	it("is stamped when the person wrote under the diary heading", async () => {
		const device = await startDevice(false);
		const path = await buildAhead(device);
		const built = await device.app.vault.read({ path });

		rewordTemplateAndArrive(device.app);
		await device.registry.setEnabled(FEATURE_ID, true);
		await settle();
		setText(device.app, path, `${built}My own line.\n`);
		await changed(device.app, path);

		expect(await device.app.vault.read({ path })).toContain(STAMP);
	});
});

describe("a log built while Review is on, first indexed after the template is reworded", () => {
	it("is not stamped when its first change arrives untouched", async () => {
		const device = await startDevice(true);
		const path = await buildAhead(device);
		const built = await device.app.vault.read({ path });

		rewordTemplateAndArrive(device.app);
		// If wrong: Review's own first-seen record finds B's section, not the log's
		// A, records nothing, and the log is stamped.
		await changed(device.app, path);

		expect(await device.app.vault.read({ path })).toBe(built);
	});
});

describe("a log built on one device and first seen by Review on another", () => {
	it("is not stamped there, once that device has taken the building device's settings file", async () => {
		const builder = await startDevice(false);
		const path = await buildAhead(builder);
		const built = await builder.app.vault.read({ path });
		const carried = (await builder.plugin.loadData()) as EffortlessData;
		// If wrong (the record never reached the file): the building device's file holds no day.
		expect(Object.keys(carried.core.builtDiaries)).toEqual([localDateKey(THE_DAY)]);

		// The reviewing device started before the file arrived, and has never had the log.
		const reviewer = await startDevice(true);
		// Sync brings the log and the settings file; Obsidian says the file changed outside.
		reviewer.app.vault.files = [...reviewer.app.vault.files, { path }];
		reviewer.app.vault.allowReads({ [TEMPLATE_PATH]: TEMPLATE_A, [path]: built });
		reviewer.app.metadataCache.caches.set(path, { frontmatter: { processed: null, diary: null } });
		reviewer.plugin.seedData({ ...carried, core: { ...carried.core, enabled: { [FEATURE_ID]: true } } });
		await reviewer.settings.reloadExternal();

		rewordTemplateAndArrive(reviewer.app);
		await changed(reviewer.app, path);

		// Read back: the log on the reviewing device after its first change there.
		expect(await reviewer.app.vault.read({ path })).toBe(built);
	});

	// The remainder #1201's second box allowed, closed by #1207: the section a log
	// was built with also travels inside the log, so a log Obsidian indexes before the
	// settings file arrives is judged by its own record, not the reworded template.
	it("is not stamped when the log is indexed before the settings file arrives", async () => {
		const builder = await startDevice(false);
		const path = await buildAhead(builder, true);
		const built = await builder.app.vault.read({ path });
		const carried = (await builder.plugin.loadData()) as EffortlessData;

		const reviewer = await startDevice(true);
		rewordTemplateAndArrive(reviewer.app);
		// Sync brings the log first, and Obsidian indexes it.
		reviewer.app.vault.files = [...reviewer.app.vault.files, { path }];
		reviewer.app.vault.allowReads({ [TEMPLATE_PATH]: TEMPLATE_B, [path]: built });
		reviewer.app.metadataCache.caches.set(path, { frontmatter: { processed: null, diary: null } });
		await changed(reviewer.app, path);
		// Then the settings file, with the building device's record of the day.
		reviewer.plugin.seedData({ ...carried, core: { ...carried.core, enabled: { [FEATURE_ID]: true } } });
		await reviewer.settings.reloadExternal();

		// If wrong: the log carries no record of its own, is compared with template B
		// on its first change, and reads `diary: 2026-10-16`.
		// Read back: the log on the reviewing device after the change and the file.
		expect(await reviewer.app.vault.read({ path })).toBe(built);
	});
});

describe("a log carrying the mark of the diary section it was built with, on a device with no other record of it", () => {
	/**
	 * A log built on another device, brought by Sync to a device where Review is on,
	 * `core.builtDiaries` holds nothing and Review has kept nothing, with `text` as
	 * the log's text and `template` as the template there. Obsidian has indexed it.
	 */
	async function arrived(text: (built: string) => string, template: string): Promise<{ reviewer: Device; path: string; built: string }> {
		const builder = await startDevice(false);
		const path = await buildAhead(builder, true);
		const built = await builder.app.vault.read({ path });
		const reviewer = await startDevice(true);
		vi.setSystemTime(THE_DAY);
		reviewer.app.vault.files = [...reviewer.app.vault.files, { path }];
		reviewer.app.vault.allowReads({ [TEMPLATE_PATH]: template, [path]: text(built) });
		reviewer.app.metadataCache.caches.set(path, { frontmatter: { processed: null, diary: null } });
		// If wrong (a record reached this device some other way), the tests below prove nothing about the mark.
		expect((await reviewer.plugin.loadData()) as EffortlessData).toMatchObject({ core: { builtDiaries: {} } });
		return { reviewer, path, built };
	}

	it("is not stamped on its first change after the template is reworded, and its diary reads empty", async () => {
		const { reviewer, path, built } = await arrived((text) => text, TEMPLATE_B);
		expect(built).toContain('effortless-built-diary: "');

		// If wrong: the log is compared with template B, reads `diary: 2026-10-16`,
		// and the diary-empty sign is off.
		await changed(reviewer.app, path);

		// Read back: the log's text after the change, and the sign Review draws for today.
		expect(await reviewer.app.vault.read({ path })).toBe(built);
		expect((await reviewer.review()?.waiting())?.todayDiaryEmpty).toBe(true);
	});

	it("is stamped once the person writes under the diary heading", async () => {
		const { reviewer, path } = await arrived((text) => `${text}My own line.\n`, TEMPLATE_B);

		await changed(reviewer.app, path);

		expect(await reviewer.app.vault.read({ path })).toContain(STAMP);
	});

	it("is judged as a log built before the mark existed when the value is not a fingerprint", async () => {
		// The template is not reworded, so the fallback finds the log untouched; a value
		// trusted as a fingerprint would not match the section, and the log would be stamped.
		const unusable = (text: string): string => text.replace(/effortless-built-diary: "[^"]*"/, 'effortless-built-diary: "written by me"');
		const { reviewer, path } = await arrived(unusable, TEMPLATE_A);

		await changed(reviewer.app, path);

		expect(await reviewer.app.vault.read({ path })).not.toContain(STAMP);
	});

	it("is stamped beside the reworded template when the value is not a fingerprint, as a log built before the mark was", async () => {
		// The other half of the test above: Review handled the change at all, and the
		// fallback, not the unusable value, decided it.
		const unusable = (text: string): string => text.replace(/effortless-built-diary: "[^"]*"/, 'effortless-built-diary: "written by me"');
		const { reviewer, path } = await arrived(unusable, TEMPLATE_B);

		await changed(reviewer.app, path);

		expect(await reviewer.app.vault.read({ path })).toContain(STAMP);
	});
});
