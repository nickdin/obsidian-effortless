/**
 * Review's live line: what its closed row on the settings screen says while it
 * runs (ticket #1057, spec
 * #1048 user story 31).
 *
 * The line comes from the same recompute as the status-bar count
 * (`Review.refresh`, #1054),
 * so these tests read it through the feature's own `liveLine` and
 * `onLiveLineChange`, the two members the settings screen uses, against the
 * real feature registry and the real settings store. The settings screen's own
 * half is `settingsTab.test.ts`'s. The clock is pinned to a fixed local day, and
 * every folder, note name and date is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, Vault as ObsidianVault } from "obsidian";
import { Notice, Platform, Plugin, Vault, resetSettings } from "./__mocks__/obsidian";
import type { App } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import { localDateKey } from "../core/meetingName";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SettingsStore, defaultData } from "../core/settings";
import type { EffortlessData, VaultLayout } from "../core/settings";
import { FEATURE_ID, Review } from "../features/review";
import { fakeQuietPeriod, quietPassed } from "./reviewQuietPeriod";

/** The pinned local day: a fixed noon, so a fixture day is `TODAY` plus or minus whole days. */
const TODAY = new Date(2026, 2, 18, 12, 0, 0);

/** The local day `offset` days from {@link TODAY}, as `YYYY-MM-DD`. */
function key(offset: number): string {
	return localDateKey(new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + offset));
}

/** A layout with the daily-log folder and filename answered; the two field names are the shipped `processed` and `day`. */
const ANSWERED: Partial<VaultLayout> = { dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" };

function dataWith(layout: Partial<VaultLayout> = ANSWERED): EffortlessData {
	const data = defaultData();
	return {
		...data,
		core: { ...data.core, layout: { ...data.core.layout, ...layout } },
		features: { [FEATURE_ID]: {} },
	};
}

/** One note the vault holds: its path and the frontmatter Obsidian's cache has for it. */
interface Seeded {
	readonly path: string;
	readonly frontmatter: Record<string, unknown> | null;
}

/** A day's log for `offset` days from today with its processed field `processed` (blank by default). */
function log(offset: number, processed: unknown = null): Seeded {
	return { path: `Journal/${key(offset)}.md`, frontmatter: { processed } };
}

function seed(app: App, notes: readonly Seeded[]): void {
	app.vault.files = notes.map((note) => ({ path: note.path }));
	app.metadataCache.caches.clear();
	for (const note of notes) app.metadataCache.caches.set(note.path, note.frontmatter === null ? {} : { frontmatter: note.frontmatter });
}

/** What the person does when they type a value into a note's processed field, and what Obsidian then reports. */
function fillProcessed(app: App, offset: number, processed: unknown): void {
	const path = `Journal/${key(offset)}.md`;
	app.metadataCache.caches.set(path, { frontmatter: { processed } });
	app.metadataCache.fire("changed", { path }, "", app.metadataCache.caches.get(path));
}

interface Started {
	readonly plugin: Plugin;
	readonly app: App;
	readonly registry: FeatureRegistry;
	readonly feature: Review;
}

/** The plugin loaded over `data`, the vault seeded with `notes`, and the registry started with Review registered, as `main.ts` starts it. */
async function startReview(data: EffortlessData = dataWith(), notes: readonly Seeded[] = []): Promise<Started> {
	const plugin = new Plugin();
	plugin.seedData(data);
	plugin.load();
	const app = plugin.app as unknown as App;
	seed(app, notes);
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const writer = new NoteWriter(new Vault() as unknown as ObsidianVault, { path: () => null, onChange: () => undefined });
	const calendar: Calendar = { meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} };
	const collections: Collections = { all: () => [], at: () => null };
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{ settings, collections, problems: new Problems(), device: new DeviceStore(plugin.app as unknown as ObsidianApp) },
		writer,
		calendar,
	);
	let feature: Review | undefined;
	registry.register(FEATURE_ID, (host: FeatureHost) => (feature = new Review(host)));
	registry.start();
	return { plugin, app, registry, feature: feature! };
}

/** The count the status bar shows, or `null` while its item is hidden. */
function barText(plugin: Plugin): string | null {
	const items = plugin.statusBarItems;
	if (items.length === 0) return null;
	return items[0].hidden ? null : items[0].textContent;
}

beforeEach(() => {
	Notice.messages = [];
	resetSettings();
	Platform.isMobile = false;
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
	vi.setSystemTime(TODAY);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("what the line says", () => {
	it("says 1 note waiting for one, with today's log, tomorrow's and a note eight days old left out", async () => {
		const { feature } = await startReview(dataWith(), [log(0), log(-1), log(1), log(-8)]);
		expect(feature.liveLine()).toBe("1 note waiting");
	});

	it("says 3 notes waiting for three", async () => {
		const { feature } = await startReview(dataWith(), [log(-1), log(-2), log(-3)]);
		expect(feature.liveLine()).toBe("3 notes waiting");
	});

	it("says Nothing waiting at zero", async () => {
		const { feature } = await startReview(dataWith(), [log(-1, "done"), log(-2, true)]);
		expect(feature.liveLine()).toBe("Nothing waiting");
	});

	it("does not count today's log, though the list shows it", async () => {
		// Today's log is waiting and is the only note that is: the list has one
		// row and the count is zero, so a line taken from the list's length
		// would read 1 note waiting.
		const { feature, app } = await startReview(dataWith(), [log(0)]);
		app.vault.allowReads({ [log(0).path]: "" });
		expect(feature.liveLine()).toBe("Nothing waiting");
		expect((await feature.waiting()).list).toHaveLength(1);
	});

	it("counts the oldest day of the window and not the day before it", async () => {
		const { feature } = await startReview(dataWith(), [log(-1), log(-6), log(-7)]);
		expect(feature.liveLine()).toBe("2 notes waiting");
	});

	it("gives no line while the feature is not configured", async () => {
		const { feature, registry } = await startReview(dataWith({ dailyLogFolder: "", dailyLogFilename: "" }), [log(-1)]);
		expect(registry.statuses()[0].state).toBe("unconfigured");
		expect(feature.liveLine()).toBeNull();
	});

	it("gives no line once the feature is switched off, and a fresh one when it is switched on again", async () => {
		const { feature, registry } = await startReview(dataWith(), [log(-1), log(-2)]);
		expect(feature.liveLine()).toBe("2 notes waiting");
		await registry.setEnabled(FEATURE_ID, false);
		expect(feature.liveLine()).toBeNull();
		await registry.setEnabled(FEATURE_ID, true);
		expect(feature.liveLine()).toBe("2 notes waiting");
	});
});

describe("on a phone, which has no status bar", () => {
	it("still says the count, and adds no status-bar item", async () => {
		Platform.isMobile = true;
		const { feature, plugin } = await startReview(dataWith(), [log(-1), log(-2), log(-3)]);
		expect(plugin.statusBarItems).toEqual([]);
		expect(feature.liveLine()).toBe("3 notes waiting");
	});

	it("says Nothing waiting at zero", async () => {
		Platform.isMobile = true;
		const { feature } = await startReview(dataWith(), [log(-1, "done")]);
		expect(feature.liveLine()).toBe("Nothing waiting");
	});

	it("names no status bar in either sentence", async () => {
		Platform.isMobile = true;
		const waiting = await startReview(dataWith(), [log(-1)]);
		const none = await startReview(dataWith(), []);
		for (const line of [waiting.feature.liveLine(), none.feature.liveLine()]) {
			expect(line).not.toMatch(/status|bar/i);
		}
	});

	it("reads no note's text to say it", async () => {
		fakeQuietPeriod(TODAY);
		Platform.isMobile = true;
		const { feature, app } = await startReview(dataWith(), [log(-1), log(-2)]);
		const read = vi.spyOn(app.vault, "cachedRead");
		const readAgain = vi.spyOn(app.vault, "read");
		fillProcessed(app, -1, "done");
		await quietPassed();
		expect(feature.liveLine()).toBe("1 note waiting");
		expect(read).not.toHaveBeenCalled();
		expect(readAgain).not.toHaveBeenCalled();
	});
});

describe("following the vault", () => {
	it("changes after a metadata change, from what the vault holds then", async () => {
		fakeQuietPeriod(TODAY);
		const { feature, app } = await startReview(dataWith(), [log(-1), log(-2)]);
		expect(feature.liveLine()).toBe("2 notes waiting");

		fillProcessed(app, -1, "2026-03-18");
		await quietPassed();
		expect(feature.liveLine()).toBe("1 note waiting");

		fillProcessed(app, -2, true);
		await quietPassed();
		expect(feature.liveLine()).toBe("Nothing waiting");
	});

	it("comes from the same recompute as the status-bar count: both change with one metadata change", async () => {
		fakeQuietPeriod(TODAY);
		const { feature, app, plugin } = await startReview(dataWith(), [log(-1), log(-2)]);
		expect(barText(plugin)).toBe("Review: 2 waiting");
		expect(feature.liveLine()).toBe("2 notes waiting");

		fillProcessed(app, -1, "done");
		await quietPassed();
		expect(barText(plugin)).toBe("Review: 1 waiting");
		expect(feature.liveLine()).toBe("1 note waiting");
	});

	it("follows the window when it is changed", async () => {
		const { feature } = await startReview(dataWith(), [log(-1), log(-5)]);
		expect(feature.liveLine()).toBe("2 notes waiting");
		await feature.saveWindowDaysSoon(3);
		expect(feature.liveLine()).toBe("1 note waiting");
	});

	it("follows a note arriving that no event names, since nothing is kept from the first read", async () => {
		const { feature, app } = await startReview(dataWith(), [log(-1)]);
		expect(feature.liveLine()).toBe("1 note waiting");
		seed(app, [log(-1), log(-2)]);
		feature.refresh();
		expect(feature.liveLine()).toBe("2 notes waiting");
	});
});

describe("telling the screen", () => {
	it("tells each listener once for a change, and the line it is then asked for is the new one", async () => {
		fakeQuietPeriod(TODAY);
		const { feature, app } = await startReview(dataWith(), [log(-1), log(-2)]);
		const heard: Array<string | null> = [];
		feature.onLiveLineChange(() => heard.push(feature.liveLine()));

		fillProcessed(app, -1, "done");
		await quietPassed();
		expect(heard).toEqual(["1 note waiting"]);
		fillProcessed(app, -2, "done");
		await quietPassed();
		expect(heard).toEqual(["1 note waiting", "Nothing waiting"]);
	});

	it("says nothing for a recompute that reads the same line", async () => {
		fakeQuietPeriod(TODAY);
		const { feature, app } = await startReview(dataWith(), [log(-1), log(0)]);
		const listener = vi.fn();
		feature.onLiveLineChange(listener);

		// Today's log is filled: the list changes, the count does not.
		fillProcessed(app, 0, "done");
		await quietPassed();
		feature.refresh();
		expect(listener).not.toHaveBeenCalled();
	});

	it("stops telling a listener that has stopped", async () => {
		fakeQuietPeriod(TODAY);
		const { feature, app } = await startReview(dataWith(), [log(-1), log(-2)]);
		const listener = vi.fn();
		const stop = feature.onLiveLineChange(listener);

		fillProcessed(app, -1, "done");
		await quietPassed();
		expect(listener).toHaveBeenCalledTimes(1);
		stop();
		fillProcessed(app, -2, "done");
		await quietPassed();
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("keeps telling a listener across a switch-off and a switch-on", async () => {
		fakeQuietPeriod(TODAY);
		const { feature, app, registry } = await startReview(dataWith(), [log(-1), log(-2)]);
		const heard: Array<string | null> = [];
		feature.onLiveLineChange(() => heard.push(feature.liveLine()));

		await registry.setEnabled(FEATURE_ID, false);
		await registry.setEnabled(FEATURE_ID, true);
		heard.length = 0;
		fillProcessed(app, -1, "done");
		await quietPassed();
		expect(heard).toEqual(["1 note waiting"]);
	});
});
