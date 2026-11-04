/**
 * Review's card: the one row that sets the days it looks at, what it shows for
 * a stored value Review cannot use, and that a change saves into the feature's
 * slice and redraws the count in the status bar.
 *
 * The feature is started through the real registry and settings store, as
 * `reviewFeature.test.ts` does, and the card is drawn the way the settings
 * screen draws it. Every folder, note name and date here is invented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App as ObsidianApp, Plugin as ObsidianPlugin, Vault as ObsidianVault } from "obsidian";
import { Notice, Plugin, Vault, controlsUnder, resetSettings } from "./__mocks__/obsidian";
import type { App, TextComponent } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import { localDateKey } from "../core/meetingName";
import { NoteWriter } from "../core/noteWriter";
import { Problems } from "../core/problems";
import { FeatureRegistry } from "../core/registry";
import { DeviceStore, SAVE_AFTER_TYPING_MS, SettingsStore, defaultData } from "../core/settings";
import type { EffortlessData } from "../core/settings";
import { FEATURE_ID, Review } from "../features/review";

const TODAY = new Date(2026, 2, 18, 12, 0, 0);

function key(offset: number): string {
	return localDateKey(new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + offset));
}

function dataWith(features: Record<string, unknown> = {}): EffortlessData {
	const data = defaultData();
	return {
		...data,
		core: { ...data.core, layout: { ...data.core.layout, dailyLogFolder: "Journal", dailyLogFilename: "YYYY-MM-DD" } },
		features: { [FEATURE_ID]: features },
	};
}

/**
 * The plugin started over `data` with a blank day's log for each of `offsets`
 * days from today in the vault: yesterday and the day six back are inside the
 * default window, the day seven back is outside it and inside a window of 14.
 */
async function start(features: Record<string, unknown> = {}, offsets: readonly number[] = [-1, -6, -7]): Promise<{
	plugin: Plugin;
	app: App;
	feature: Review;
}> {
	const plugin = new Plugin();
	plugin.seedData(dataWith(features));
	plugin.load();
	const app = plugin.app as unknown as App;
	app.vault.files = offsets.map((offset) => ({ path: `Journal/${key(offset)}.md` }));
	for (const file of app.vault.files) app.metadataCache.caches.set(file.path, { frontmatter: { processed: null } });
	const settings = new SettingsStore(plugin as unknown as ObsidianPlugin);
	await settings.load();
	const registry = new FeatureRegistry(
		plugin as unknown as ObsidianPlugin,
		{
			settings,
			collections: { all: () => [], at: () => null } as Collections,
			problems: new Problems(),
			device: new DeviceStore(plugin.app as unknown as ObsidianApp),
		},
		new NoteWriter(new Vault() as unknown as ObsidianVault, { path: () => null, onChange: () => undefined }),
		{ meetingsOn: () => [], presenceBetween: () => ({ whole: false, meetings: [] }), refresh: async () => {} } as Calendar,
	);
	let feature: Review | undefined;
	registry.register(FEATURE_ID, (host: FeatureHost) => (feature = new Review(host)));
	registry.start();
	return { plugin, app, feature: feature! };
}

/** The card's body, drawn as the settings screen draws it, and its one row. */
function card(feature: Review): { body: HTMLElement; text: TextComponent; desc: () => string } {
	const body = document.createElement("div");
	feature.displaySettings(body, () => undefined);
	const text = controlsUnder(body).get("Days to look at")?.[0] as TextComponent | undefined;
	if (text === undefined) throw new Error("the card has no Days to look at row");
	return { body, text, desc: () => body.querySelector(".setting-item-description")?.textContent ?? "" };
}

/** The status bar's text, or `null` when nothing is shown. */
function barText(plugin: Plugin): string | null {
	const [item] = plugin.statusBarItems;
	return item === undefined || item.hidden ? null : item.textContent;
}

/** The slice Review last saved into the settings file. */
function savedSlice(plugin: Plugin): unknown {
	return JSON.parse(plugin.saved[plugin.saved.length - 1]).features[FEATURE_ID];
}

beforeEach(() => {
	Notice.messages = [];
	resetSettings();
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
	vi.setSystemTime(TODAY);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("the Days to look at row", () => {
	it("shows 7 on a fresh install and says what it means at the default", async () => {
		const { feature } = await start();
		const { text, desc } = card(feature);

		expect(text.getValue()).toBe("7");
		expect(desc()).toBe(
			"How many days Review looks at, today included. At the default, today and the six days before it.",
		);
	});

	it("saves a typed number into the slice and redraws the count from it", async () => {
		const { plugin, feature } = await start();
		expect(barText(plugin)).toBe("Review: 2 waiting");

		card(feature).text.change("14");
		// The slice changes straight away and so does the bar; only the write waits.
		expect(barText(plugin)).toBe("Review: 3 waiting");
		await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);

		expect(savedSlice(plugin)).toEqual({ windowDays: 14 });
		expect(feature.windowDays()).toBe(14);
	});

	it("narrows the count again when the number is lowered", async () => {
		const { plugin, feature } = await start({ windowDays: 14 });
		expect(barText(plugin)).toBe("Review: 3 waiting");

		card(feature).text.change("2");
		await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);

		expect(barText(plugin)).toBe("Review: 1 waiting");
		expect(savedSlice(plugin)).toEqual({ windowDays: 2 });
	});

	it("puts the count back when the write is refused and the store puts memory back", async () => {
		const { plugin, feature } = await start();
		plugin.saveData = () => Promise.reject(new Error("the vault is read-only"));

		card(feature).text.change("14");
		expect(barText(plugin)).toBe("Review: 3 waiting");
		await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);
		await vi.advanceTimersByTimeAsync(0);

		expect(feature.windowDays()).toBe(7);
		expect(barText(plugin)).toBe("Review: 2 waiting");
	});

	it.each([
		["zero", "0", "Days to look at must be at least 1, not 0."],
		["a fraction", "2.5", "Days to look at must be a whole number of at least 1."],
		["a word", "seven", "Days to look at must be a whole number of at least 1."],
		["nothing", "", "Days to look at must be a whole number of at least 1."],
		["a negative number", "-3", "Days to look at must be a whole number of at least 1."],
	])("refuses %s in the row's own description, stores nothing and leaves the count alone", async (_what, typed, refusal) => {
		const { plugin, feature } = await start({ windowDays: 3 });
		const { text, desc } = card(feature);
		const before = barText(plugin);

		text.change(typed);
		await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);

		expect(desc()).toBe(refusal);
		expect(Notice.messages).toEqual([]);
		expect(plugin.saved).toEqual([]);
		expect(feature.windowDays()).toBe(3);
		expect(barText(plugin)).toBe(before);
	});

	it("takes the refusal away once a usable number is typed after it", async () => {
		const { feature } = await start();
		const { text, desc } = card(feature);

		text.change("0");
		text.change("10");
		await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);

		expect(desc()).toBe(
			"How many days Review looks at, today included. At the default, today and the six days before it.",
		);
		expect(feature.windowDays()).toBe(10);
	});
});

describe("a stored number Review cannot use", () => {
	it("is shown as stored with its refusal beside it, not as the fallback", async () => {
		const { feature } = await start({ windowDays: "seven" });
		const { text, desc } = card(feature);

		expect(text.getValue()).toBe('"seven"');
		expect(desc()).toBe(
			'Review cannot use the value "seven" stored for the days it looks at, and uses 7 until this is changed.',
		);
	});

	it("is replaced once a usable number is entered, and not before", async () => {
		const { plugin, feature } = await start({ windowDays: 0 });
		expect(plugin.saved).toEqual([]);

		card(feature).text.change("5");
		await vi.advanceTimersByTimeAsync(SAVE_AFTER_TYPING_MS);

		expect(savedSlice(plugin)).toEqual({ windowDays: 5 });
		expect(feature.windowDays()).toBe(5);
	});
});
